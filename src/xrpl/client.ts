/**
 * XRPL WebSocket client with auto-reconnect
 */

import { Client } from 'xrpl';
import { info, error, warn, debug } from '../utils/logger';
import { diagnostics } from '../diagnostics/diagnostics';

export class XRPLClient {
  private client: Client | null = null;
  private wsUrl: string;
  private reconnectAttempts = 0;
  private reconnectDelay = 5000; // 5 seconds base, doubles up to 60s
  private isConnected = false;
  private isReconnecting = false; // single-entry guard
  private reconnectTimer: NodeJS.Timeout | null = null;
  private rawTxCount = 0;
  private filteredTxCount = 0;
  private lastLedgerAt = 0;
  private ledgerHandler?: (ledger: any) => void;
  private txHandler?: (tx: any) => void;

  constructor(wsUrl: string) {
    this.wsUrl = wsUrl;
  }

  /**
   * Destroy the current client instance completely — removes all listeners
   * so stale 'disconnected' events can't fire after we've moved on.
   */
  private destroyClient(): void {
    if (this.client) {
      try { this.client.removeAllListeners(); } catch { /* ignore */ }
      try { this.client.disconnect().catch(() => {}); } catch { /* ignore */ }
      this.client = null;
    }
    this.isConnected = false;
  }

  /**
   * Connect to XRPL WebSocket and register disconnect handler.
   * Does NOT subscribe to streams — caller does that after connect().
   */
  async connect(): Promise<Client> {
    // Destroy any stale client before creating a new one
    this.destroyClient();

    info(`Connecting to XRPL: ${this.wsUrl}`);
    this.client = new Client(this.wsUrl, {
      timeout: 20000,
      connectionTimeout: 10000,
    });

    await this.client.connect();
    this.isConnected = true;
    this.reconnectAttempts = 0;
    info('Connected to XRPL successfully');

    // Register disconnect handler on this specific client instance.
    // Wrapped in a closure that checks we're still the active client —
    // prevents stale instances from triggering reconnects after destroy.
    const thisClient = this.client;
    thisClient.on('disconnected', (code: number) => {
      if (this.client !== thisClient) {
        debug(`Stale client disconnected (code ${code}) — ignoring`);
        return;
      }
      warn(`XRPL WebSocket disconnected (code ${code})`);
      this.isConnected = false;
      this.scheduleReconnect();
    });

    // Server info — informational only
    try {
      const serverInfo = await this.client.request({ command: 'server_info' });
      const completeLedgers = serverInfo.result.info.complete_ledgers;
      info(`XRPL Server: ${typeof completeLedgers === 'string' ? completeLedgers : JSON.stringify(completeLedgers)} ledgers`);
    } catch (siErr) {
      warn(`server_info failed (non-fatal): ${siErr}`);
    }

    return this.client;
  }

  /**
   * Schedule a single reconnect attempt with exponential backoff.
   * Uses a timer ref so duplicate calls are no-ops.
   */
  private scheduleReconnect(): void {
    if (this.isReconnecting) {
      debug('Reconnect already scheduled — ignoring duplicate');
      return;
    }
    this.isReconnecting = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);

    this.reconnectAttempts++;
    const backoff = Math.min(this.reconnectDelay * Math.pow(2, Math.min(this.reconnectAttempts - 1, 10)), 60000);
    const jitter  = backoff * 0.2 * (Math.random() - 0.5) * 2;
    const delay   = Math.max(1000, backoff + jitter); // minimum 1s

    warn(`XRPL reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempts})`);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      this.isReconnecting = false; // clear before attempt so failures can reschedule

      try {
        await this.connect();
        info('Reconnected to XRPL successfully');
        this.reconnectAttempts = 0;

        // Small settle delay before subscribing to avoid NotConnectedError race
        await new Promise(r => setTimeout(r, 500));

        if (this.ledgerHandler) await this.subscribeLedger(this.ledgerHandler).catch(e => warn(`Re-subscribe ledger failed: ${e}`));
        if (this.txHandler)     await this.subscribeTransactions(this.txHandler).catch(e => warn(`Re-subscribe tx failed: ${e}`));
      } catch (err) {
        error(`Reconnect attempt ${this.reconnectAttempts} failed: ${err}`);
        this.scheduleReconnect();
      }
    }, delay);
  }

  /**
   * Subscribe to ledger stream
   */
  async subscribeLedger(handler: (ledger: any) => void): Promise<void> {
    if (!this.client || !this.isConnected) throw new Error('XRPL client not connected');
    this.ledgerHandler = handler;
    await this.client.request({ command: 'subscribe', streams: ['ledger'] });
    info('Subscribed to ledger stream');
    this.client.on('ledgerClosed', (ledger) => { if (this.ledgerHandler) this.ledgerHandler(ledger); });
  }

  // Transaction types relevant to meme token activity
  private static readonly RELEVANT_TX_TYPES = new Set([
    'TrustSet', 'AMMCreate', 'AMMBid', 'AMMDeposit', 'AMMWithdraw', 'OfferCreate', 'Payment',
  ]);

  private static isRelevant(tx: any): boolean {
    const transaction = tx.tx_json ?? tx.transaction ?? tx.tx;
    if (!transaction) return false;
    const txType: string = transaction.TransactionType;
    if (!XRPLClient.RELEVANT_TX_TYPES.has(txType)) return false;
    if (txType === 'Payment') {
      const amount = transaction.Amount;
      if (typeof amount === 'string') return false;
      if (!amount || amount.currency === 'XRP') return false;
    }
    return true;
  }

  /**
   * Subscribe to transactions stream
   */
  async subscribeTransactions(handler: (tx: any) => void): Promise<void> {
    if (!this.client || !this.isConnected) throw new Error('XRPL client not connected');
    this.txHandler = handler;
    await this.client.request({ command: 'subscribe', streams: ['transactions'] });
    info('Subscribed to transactions stream (filtered: TrustSet, AMM*, OfferCreate, token Payments)');
    this.client.on('transaction', (tx) => {
      this.rawTxCount++;
      diagnostics.recordRawTx();
      if (this.txHandler && XRPLClient.isRelevant(tx)) {
        this.filteredTxCount++;
        diagnostics.recordTx(tx);
        this.txHandler(tx);
      }
    });
  }

  async getAccountInfo(account: string): Promise<any> {
    if (!this.client || !this.isConnected) return null;
    try {
      const response = await this.client.request({ command: 'account_info', account, ledger_index: 'validated' });
      return response.result;
    } catch (err) { debug(`Account info failed for ${account}: ${err}`); return null; }
  }

  async getAccountLines(account: string): Promise<any[]> {
    if (!this.client || !this.isConnected) return [];
    try {
      const response = await this.client.request({ command: 'account_lines', account, ledger_index: 'validated' });
      return response.result.lines || [];
    } catch (err) { debug(`Account lines failed for ${account}: ${err}`); return []; }
  }

  async getAccountLinesWithMarker(account: string, marker?: string): Promise<any> {
    if (!this.client || !this.isConnected) return { lines: [], marker: undefined };
    try {
      const request: any = { command: 'account_lines', account, ledger_index: 'validated', limit: 400 };
      if (marker) request.marker = marker;
      const response: any = await this.client.request(request);
      const result = response.result || {};
      return { lines: result.lines || [], marker: result.marker };
    } catch (err) { debug(`Account lines with marker failed for ${account}: ${err}`); return { lines: [], marker: undefined }; }
  }

  async getAMMInfo(asset1: any, asset2: any): Promise<any> {
    if (!this.client || !this.isConnected) return null;
    try {
      const response = await this.client.request({ command: 'amm_info', asset: asset1, asset2: asset2, ledger_index: 'validated' });
      return response.result.amm || null;
    } catch (err) { debug(`AMM info failed: ${err}`); return null; }
  }

  async getBookOffers(takerGets: any, takerPays: any, limit: number = 20): Promise<any> {
    if (!this.client || !this.isConnected) return null;
    try {
      const response = await this.client.request({ command: 'book_offers', taker_gets: takerGets, taker_pays: takerPays, ledger_index: 'validated', limit });
      return response.result;
    } catch (err) { debug(`Book offers failed: ${err}`); return null; }
  }

  async getTransaction(hash: string): Promise<any> {
    if (!this.client || !this.isConnected) return null;
    try {
      const response = await this.client.request({ command: 'tx', transaction: hash });
      return response.result;
    } catch (err) { debug(`Transaction lookup failed for ${hash}: ${err}`); return null; }
  }

  recordLedger(): void { this.lastLedgerAt = Date.now(); }

  getStatus(): { connected: boolean; url: string; lastLedgerAgeMs: number } {
    return {
      connected: this.isConnected,
      url: this.wsUrl,
      lastLedgerAgeMs: this.lastLedgerAt > 0 ? Date.now() - this.lastLedgerAt : -1,
    };
  }

  getTxStats(): { raw: number; filtered: number } {
    return { raw: this.rawTxCount, filtered: this.filteredTxCount };
  }

  async disconnect(): Promise<void> {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.isReconnecting = false;
    this.destroyClient();
    info('Disconnected from XRPL');
  }

  /**
   * Force a full reconnect — used by health-check stale-stream detection.
   */
  async forceReconnect(): Promise<void> {
    warn('forceReconnect() called');
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.isReconnecting = false; // reset so scheduleReconnect can run
    this.destroyClient();
    this.scheduleReconnect();
  }

  getClient(): Client | null { return this.client; }
}
