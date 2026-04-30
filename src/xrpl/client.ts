/**
 * XRPL WebSocket client with auto-reconnect
 */

import { Client, LedgerStream } from 'xrpl';
import { info, error, warn, debug } from '../utils/logger';

export class XRPLClient {
  private client: Client | null = null;
  private wsUrl: string;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 5000; // 5 seconds
  private isConnected = false;
  private rawTxCount = 0;   // all raw txs from WS
  private filteredTxCount = 0; // txs that passed isRelevant filter
  private ledgerHandler?: (ledger: any) => void;
  private txHandler?: (tx: any) => void;

  constructor(wsUrl: string) {
    this.wsUrl = wsUrl;
  }

  /**
   * Connect to XRPL WebSocket
   */
  async connect(): Promise<Client> {
    try {
      info(`Connecting to XRPL: ${this.wsUrl}`);
      this.client = new Client(this.wsUrl);
      await this.client.connect();
      this.isConnected = true;
      this.reconnectAttempts = 0;
      info('Connected to XRPL successfully');

      // Get server info
      const serverInfo = await this.client.request({ command: 'server_info' });
      const completeLedgers = serverInfo.result.info.complete_ledgers;
      info(`XRPL Server: ${typeof completeLedgers === 'string' ? completeLedgers : JSON.stringify(completeLedgers)} ledgers`);

      return this.client;
    } catch (err) {
      error(`Failed to connect to XRPL: ${err}`);
      throw err;
    }
  }

  /**
   * Subscribe to ledger stream for new ledger events
   */
  async subscribeLedger(handler: (ledger: any) => void): Promise<void> {
    if (!this.client || !this.isConnected) {
      throw new Error('XRPL client not connected');
    }

    this.ledgerHandler = handler;

    try {
      await this.client.request({
        command: 'subscribe',
        streams: ['ledger'],
      });
      info('Subscribed to ledger stream');

      this.client.on('ledgerClosed', (ledger) => {
        if (this.ledgerHandler) {
          this.ledgerHandler(ledger);
        }
      });
    } catch (err) {
      error(`Failed to subscribe to ledger stream: ${err}`);
      throw err;
    }
  }

  // Transaction types relevant to meme token activity - filter at intake
  private static readonly RELEVANT_TX_TYPES = new Set([
    'TrustSet',
    'AMMCreate',
    'AMMDeposit',
    'AMMWithdraw',
    'OfferCreate',
    'Payment',
  ]);

  /**
   * Returns true if this transaction is worth processing.
   * Drops XRP-only payments, NFT activity, AccountSet, and all other spam
   * at the WebSocket event level — before the handler or queue is touched.
   */
  private static isRelevant(tx: any): boolean {
    const transaction = tx.transaction ?? tx.tx;
    if (!transaction) return false;

    const txType: string = transaction.TransactionType;
    if (!XRPLClient.RELEVANT_TX_TYPES.has(txType)) return false;

    // Payment: only pass issued-token payments (Amount is an object, currency != 'XRP')
    if (txType === 'Payment') {
      const amount = transaction.Amount;
      if (typeof amount === 'string') return false;       // XRP drops — skip
      if (!amount || amount.currency === 'XRP') return false;
      return true;
    }

    // TrustSet, AMMCreate, AMMDeposit, AMMWithdraw, OfferCreate — always relevant
    return true;
  }

  /**
   * Subscribe to transactions stream.
   * Filter runs at intake (WebSocket event handler) — handler is only called
   * for relevant tx types, keeping the queue lean.
   */
  async subscribeTransactions(handler: (tx: any) => void): Promise<void> {
    if (!this.client || !this.isConnected) {
      throw new Error('XRPL client not connected');
    }

    this.txHandler = handler;

    try {
      await this.client.request({
        command: 'subscribe',
        streams: ['transactions'],
      });
      info('Subscribed to transactions stream (filtered: TrustSet, AMM*, OfferCreate, token Payments)');

      this.client.on('transaction', (tx) => {
        this.rawTxCount++; // count every raw tx before filtering
        // Drop irrelevant transactions before they reach the queue
        if (this.txHandler && XRPLClient.isRelevant(tx)) {
          this.filteredTxCount++;
          this.txHandler(tx);
        }
      });
    } catch (err) {
      error(`Failed to subscribe to transactions: ${err}`);
      throw err;
    }
  }

  /**
   * Get account info
   */
  async getAccountInfo(account: string): Promise<any> {
    if (!this.client || !this.isConnected) {
      throw new Error('XRPL client not connected');
    }

    try {
      const response = await this.client.request({
        command: 'account_info',
        account,
        ledger_index: 'validated',
      });
      return response.result;
    } catch (err) {
      debug(`Account info failed for ${account}: ${err}`);
      return null;
    }
  }

  /**
   * Get account lines (trustlines)
   */
  async getAccountLines(account: string): Promise<any[]> {
    if (!this.client || !this.isConnected) {
      throw new Error('XRPL client not connected');
    }

    try {
      const response = await this.client.request({
        command: 'account_lines',
        account,
        ledger_index: 'validated',
      });
      return response.result.lines || [];
    } catch (err) {
      debug(`Account lines failed for ${account}: ${err}`);
      return [];
    }
  }

  /**
   * Get account lines with pagination marker
   */
  async getAccountLinesWithMarker(account: string, marker?: string): Promise<any> {
    if (!this.client || !this.isConnected) {
      throw new Error('XRPL client not connected');
    }

    try {
      const request: any = {
        command: 'account_lines',
        account,
        ledger_index: 'validated',
        limit: 400,
      };

      if (marker) {
        request.marker = marker;
      }

      const response: any = await this.client.request(request);
      const result = response.result || {};
      return {
        lines: result.lines || [],
        marker: result.marker,
      };
    } catch (err) {
      debug(`Account lines with marker failed for ${account}: ${err}`);
      return { lines: [], marker: undefined };
    }
  }

  /**
   * Get AMM info for a token pair
   */
  async getAMMInfo(asset1: any, asset2: any): Promise<any> {
    if (!this.client || !this.isConnected) {
      throw new Error('XRPL client not connected');
    }

    try {
      const response = await this.client.request({
        command: 'amm_info',
        asset: asset1,
        asset2: asset2,
        ledger_index: 'validated',
      });
      return response.result.amm || null;
    } catch (err) {
      debug(`AMM info failed: ${err}`);
      return null;
    }
  }

  /**
   * Get book offers (order book depth)
   */
  async getBookOffers(takerGets: any, takerPays: any, limit: number = 20): Promise<any> {
    if (!this.client || !this.isConnected) {
      throw new Error('XRPL client not connected');
    }

    try {
      const response = await this.client.request({
        command: 'book_offers',
        taker_gets: takerGets,
        taker_pays: takerPays,
        ledger_index: 'validated',
        limit,
      });
      return response.result;
    } catch (err) {
      debug(`Book offers failed: ${err}`);
      return null;
    }
  }

  /**
   * Get transaction by hash
   */
  async getTransaction(hash: string): Promise<any> {
    if (!this.client || !this.isConnected) {
      throw new Error('XRPL client not connected');
    }

    try {
      const response = await this.client.request({
        command: 'tx',
        transaction: hash,
      });
      return response.result;
    } catch (err) {
      debug(`Transaction lookup failed for ${hash}: ${err}`);
      return null;
    }
  }

  /**
   * Check connection status
   */
  getStatus(): { connected: boolean; url: string } {
    return {
      connected: this.isConnected,
      url: this.wsUrl,
    };
  }

  /**
   * Get tx processing stats
   */
  getTxStats(): { raw: number; filtered: number } {
    return { raw: this.rawTxCount, filtered: this.filteredTxCount };
  }

  /**
   * Disconnect gracefully
   */
  async disconnect(): Promise<void> {
    if (this.client && this.isConnected) {
      try {
        await this.client.disconnect();
        this.isConnected = false;
        info('Disconnected from XRPL');
      } catch (err) {
        error(`Error during disconnect: ${err}`);
      }
    }
  }

  /**
   * Handle reconnection
   * FIX #10: Added exponential backoff with jitter and max delay cap
   */
  private async handleDisconnect(): Promise<void> {
    this.isConnected = false;
    warn('XRPL connection lost');

    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;

      // Exponential backoff: 5s, 10s, 20s, 40s, capped at 60s
      const baseDelay = Math.min(this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1), 60000);
      // Add jitter (±20%) to prevent thundering herd
      const jitter = baseDelay * 0.2 * (Math.random() - 0.5) * 2;
      const delay = baseDelay + jitter;

      warn(`Reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

      setTimeout(async () => {
        try {
          await this.connect();
          info('Reconnected successfully');
          this.reconnectAttempts = 0; // Reset on success

          // Re-subscribe if handlers exist
          if (this.ledgerHandler) {
            await this.subscribeLedger(this.ledgerHandler);
          }
          if (this.txHandler) {
            await this.subscribeTransactions(this.txHandler);
          }
        } catch (err) {
          error(`Reconnection failed: ${err}`);
          this.handleDisconnect();
        }
      }, delay);
    } else {
      error('Max reconnection attempts reached. Bot will stop.');
      process.exit(1);
    }
  }

  /**
   * Get the underlying client (for advanced usage)
   */
  getClient(): Client | null {
    return this.client;
  }
}
