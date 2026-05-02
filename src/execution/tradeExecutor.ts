/**
 * Trade Executor
 *
 * Submits real XRPL transactions for AMM swaps.
 * Handles entry (buy), exit (sell), position tracking,
 * stop loss, take profit, and Telegram exit alerts.
 *
 * Safety features:
 * - Max trade size cap
 * - Max open positions cap
 * - Daily loss limit
 * - Slippage check before entry (rejects if > MAX_SLIPPAGE)
 * - Dry-run mode (simulates without submitting)
 */

import * as xrpl from 'xrpl';
import { BotConfig } from '../config';
import { TelegramAlerter } from '../telegram/alerts';
import { info, warn, error, debug } from '../utils/logger';

export interface LivePosition {
  id: string;
  currency: string;
  issuer: string;
  entryPriceXRP: number;
  tokensHeld: number;
  entryXRP: number;          // XRP spent (including fees)
  stopLossPrice: number;     // -15% of entry
  tp1Price: number;          // +35% — sell 40%
  tp2Price: number;          // +75% — sell 30%
  trailingStop: number;      // moves up after TP1 hit
  tp1Hit: boolean;
  tp2Hit: boolean;
  highestPrice: number;      // for trailing stop
  openedAt: number;
  txHash: string;
}

export interface ExecutionResult {
  success: boolean;
  txHash?: string;
  actualPrice?: number;
  actualTokens?: number;
  actualXRP?: number;
  slippage?: number;
  error?: string;
}

const MAX_SLIPPAGE_PCT = 3.0;   // reject trade if estimated slippage > 3%
const POSITION_CHECK_MS = 30_000; // check open positions every 30s

export class TradeExecutor {
  private wallet: xrpl.Wallet;
  private config: BotConfig;
  private alerter: TelegramAlerter;
  private wsUrl: string;
  private positions: Map<string, LivePosition> = new Map();
  private dailyPnL = 0;
  private totalTradesOpened = 0;
  private totalTradesClosed = 0;
  private monitorTimer: NodeJS.Timeout | null = null;
  private dryRun: boolean;

  constructor(config: BotConfig, alerter: TelegramAlerter, dryRun = false) {
    this.config = config;
    this.alerter = alerter;
    this.wsUrl = config.xrplWsUrl;
    this.dryRun = dryRun;

    const seed = process.env.TRADING_WALLET_SEED;
    if (!seed) throw new Error('TRADING_WALLET_SEED not set in .env');
    this.wallet = xrpl.Wallet.fromSeed(seed);
    info(`Trading wallet: ${this.wallet.address} (${dryRun ? 'DRY-RUN' : 'LIVE'})`);
  }

  getWalletAddress(): string {
    return this.wallet.address;
  }

  getOpenPositions(): LivePosition[] {
    return Array.from(this.positions.values());
  }

  getPositionCount(): number {
    return this.positions.size;
  }

  getDailyPnL(): number {
    return this.dailyPnL;
  }

  /**
   * Start the position monitor — checks every 30s for stop/TP hits
   */
  startMonitor(fetchPrice: (currency: string, issuer: string) => Promise<number | null>): void {
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    this.monitorTimer = setInterval(async () => {
      await this.checkAllPositions(fetchPrice);
    }, POSITION_CHECK_MS);
    info('Position monitor started (30s interval)');
  }

  stopMonitor(): void {
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }
  }

  /**
   * Open a new trade — buy tokens via AMM swap.
   *
   * Uses AMMSwap (OfferCreate with tfImmediateOrCancel) to buy
   * exactly the AMM pool's current rate.
   */
  async openTrade(
    currency: string,
    issuer: string,
    xrpAmount: number,
    currentPriceXRP: number,
    signalScore: number
  ): Promise<ExecutionResult> {

    // Safety checks
    if (this.positions.size >= this.config.maxOpenTrades) {
      return { success: false, error: `Max open trades reached (${this.config.maxOpenTrades})` };
    }

    const posKey = `${currency}:${issuer}`;
    if (this.positions.has(posKey)) {
      return { success: false, error: 'Already have open position for this token' };
    }

    if (xrpAmount > this.config.maxTradeXRP) {
      xrpAmount = this.config.maxTradeXRP;
    }

    if (this.dailyPnL < -this.config.maxDailyLossXRP) {
      return { success: false, error: `Daily loss limit hit (${this.dailyPnL.toFixed(2)} XRP)` };
    }

    // Estimate expected tokens from AMM
    const expectedTokens = xrpAmount / currentPriceXRP;

    // Slippage check: allow 3% worse than spot
    const minTokens = expectedTokens * (1 - MAX_SLIPPAGE_PCT / 100);

    info(`${this.dryRun ? '[DRY-RUN] ' : ''}Opening trade: ${xrpAmount} XRP → ${currency} @ ${currentPriceXRP.toFixed(8)} XRP/token`);

    if (this.dryRun) {
      // Simulate without submitting
      return this.simulateOpen(currency, issuer, xrpAmount, currentPriceXRP, expectedTokens);
    }

    // Build and submit real transaction
    const client = new xrpl.Client(this.wsUrl);
    try {
      await client.connect();

      // Use OfferCreate with tfImmediateOrCancel for a market order
      // TakerPays = XRP we give, TakerGets = tokens we want
      const tx: xrpl.OfferCreate = {
        TransactionType: 'OfferCreate',
        Account: this.wallet.address,
        TakerPays: {
          currency,
          issuer,
          value: minTokens.toFixed(8),        // minimum tokens to receive
        },
        TakerGets: xrpl.xrpToDrops(xrpAmount), // XRP we spend
        Flags: xrpl.OfferCreateFlags.tfImmediateOrCancel |
               xrpl.OfferCreateFlags.tfSell,
      };

      const prepared = await client.autofill(tx);
      const signed = this.wallet.sign(prepared);

      info(`Submitting buy tx: ${signed.hash}`);
      const result = await client.submitAndWait(signed.tx_blob);

      if (result.result.meta &&
          typeof result.result.meta === 'object' &&
          (result.result.meta as any).TransactionResult === 'tesSUCCESS') {

        // Parse actual fill from metadata
        const fill = this.parseOfferFill(result.result.meta, currency, issuer);

        if (fill.tokensReceived <= 0) {
          return { success: false, error: 'Order not filled — no liquidity at this price' };
        }

        const actualPrice = fill.xrpSpent / fill.tokensReceived;
        const slippage = Math.abs((actualPrice - currentPriceXRP) / currentPriceXRP) * 100;

        // Record position
        const position = this.createPosition(
          currency, issuer, actualPrice, fill.tokensReceived,
          fill.xrpSpent, signed.hash
        );
        this.positions.set(posKey, position);
        this.totalTradesOpened++;

        await this.sendEntryAlert(position, signalScore, slippage);

        info(`✅ Trade opened: ${fill.tokensReceived.toFixed(4)} ${currency} @ ${actualPrice.toFixed(8)} XRP (slippage: ${slippage.toFixed(2)}%)`);

        return {
          success: true,
          txHash: signed.hash,
          actualPrice,
          actualTokens: fill.tokensReceived,
          actualXRP: fill.xrpSpent,
          slippage,
        };
      } else {
        const errCode = typeof result.result.meta === 'object'
          ? (result.result.meta as any).TransactionResult
          : 'unknown';
        return { success: false, error: `Transaction failed: ${errCode}` };
      }
    } catch (err: any) {
      error(`Trade execution error: ${err.message}`);
      return { success: false, error: err.message };
    } finally {
      await client.disconnect().catch(() => {});
    }
  }

  /**
   * Close a position — sell tokens back to XRP via AMM swap.
   */
  async closePosition(
    posKey: string,
    reason: 'stop_loss' | 'tp1' | 'tp2' | 'trailing_stop' | 'manual',
    sellPercent: number,    // 0-100, percentage of remaining tokens to sell
    currentPriceXRP: number
  ): Promise<ExecutionResult> {
    const position = this.positions.get(posKey);
    if (!position) return { success: false, error: 'Position not found' };

    const tokensToSell = position.tokensHeld * (sellPercent / 100);
    const expectedXRP = tokensToSell * currentPriceXRP;
    const minXRP = expectedXRP * (1 - MAX_SLIPPAGE_PCT / 100);

    info(`${this.dryRun ? '[DRY-RUN] ' : ''}Closing ${sellPercent}% of ${position.currency}: ${tokensToSell.toFixed(4)} tokens @ ${currentPriceXRP.toFixed(8)} | Reason: ${reason}`);

    if (this.dryRun) {
      return this.simulateClose(position, posKey, reason, sellPercent, currentPriceXRP);
    }

    const client = new xrpl.Client(this.wsUrl);
    try {
      await client.connect();

      // Sell tokens for XRP
      const tx: xrpl.OfferCreate = {
        TransactionType: 'OfferCreate',
        Account: this.wallet.address,
        TakerPays: xrpl.xrpToDrops(minXRP),     // minimum XRP to receive
        TakerGets: {
          currency: position.currency,
          issuer: position.issuer,
          value: tokensToSell.toFixed(8),          // tokens we give
        },
        Flags: xrpl.OfferCreateFlags.tfImmediateOrCancel |
               xrpl.OfferCreateFlags.tfSell,
      };

      const prepared = await client.autofill(tx);
      const signed = this.wallet.sign(prepared);

      const result = await client.submitAndWait(signed.tx_blob);

      if (result.result.meta &&
          typeof result.result.meta === 'object' &&
          (result.result.meta as any).TransactionResult === 'tesSUCCESS') {

        const fill = this.parseOfferFill(result.result.meta, 'XRP', '');
        const xrpReceived = fill.xrpSpent; // reversed: we're selling tokens for XRP
        const actualPrice = tokensToSell > 0 ? xrpReceived / tokensToSell : currentPriceXRP;

        // Update position
        const pnlXRP = xrpReceived - (position.entryPriceXRP * tokensToSell);
        this.dailyPnL += pnlXRP;

        if (sellPercent >= 100) {
          this.positions.delete(posKey);
          this.totalTradesClosed++;
        } else {
          position.tokensHeld -= tokensToSell;
          position.entryXRP -= position.entryPriceXRP * tokensToSell;

          // After TP1 hit, move trailing stop to entry price
          if (reason === 'tp1') {
            position.tp1Hit = true;
            position.trailingStop = position.entryPriceXRP;
          }
          if (reason === 'tp2') {
            position.tp2Hit = true;
          }
        }

        await this.sendExitAlert(position, reason, actualPrice, pnlXRP, sellPercent, signed.hash);

        info(`✅ Position ${sellPercent === 100 ? 'CLOSED' : 'partial close'}: PnL ${pnlXRP >= 0 ? '+' : ''}${pnlXRP.toFixed(4)} XRP`);

        return {
          success: true,
          txHash: signed.hash,
          actualPrice,
          actualXRP: xrpReceived,
          slippage: Math.abs((actualPrice - currentPriceXRP) / currentPriceXRP) * 100,
        };
      } else {
        return { success: false, error: 'Sell transaction failed' };
      }
    } catch (err: any) {
      error(`Close position error: ${err.message}`);
      return { success: false, error: err.message };
    } finally {
      await client.disconnect().catch(() => {});
    }
  }

  /**
   * Check all open positions for stop loss / take profit hits
   */
  private async checkAllPositions(
    fetchPrice: (currency: string, issuer: string) => Promise<number | null>
  ): Promise<void> {
    if (this.positions.size === 0) return;

    for (const [key, pos] of Array.from(this.positions.entries())) {
      try {
        const price = await fetchPrice(pos.currency, pos.issuer);
        if (!price) continue;

        // Update highest price for trailing stop
        if (price > pos.highestPrice) {
          pos.highestPrice = price;
          // Ratchet trailing stop up (15% below highest)
          const newTrail = price * 0.85;
          if (newTrail > pos.trailingStop) {
            pos.trailingStop = newTrail;
          }
        }

        const pnlPct = ((price - pos.entryPriceXRP) / pos.entryPriceXRP) * 100;
        debug(`Position ${pos.currency}: price=${price.toFixed(8)} pnl=${pnlPct.toFixed(1)}%`);

        // Stop loss check
        if (price <= pos.stopLossPrice) {
          warn(`🛑 Stop loss hit for ${pos.currency}: ${price.toFixed(8)} <= ${pos.stopLossPrice.toFixed(8)}`);
          await this.closePosition(key, 'stop_loss', 100, price);
          continue;
        }

        // Trailing stop check (only after at least TP1 hit)
        if (pos.tp1Hit && price <= pos.trailingStop) {
          warn(`📉 Trailing stop hit for ${pos.currency}`);
          await this.closePosition(key, 'trailing_stop', 100, price);
          continue;
        }

        // TP1: +35% — sell 40%
        if (!pos.tp1Hit && price >= pos.tp1Price) {
          info(`🎯 TP1 hit for ${pos.currency}: +35%`);
          await this.closePosition(key, 'tp1', 40, price);
          continue;
        }

        // TP2: +75% — sell 30% more (of remaining)
        if (pos.tp1Hit && !pos.tp2Hit && price >= pos.tp2Price) {
          info(`🎯 TP2 hit for ${pos.currency}: +75%`);
          await this.closePosition(key, 'tp2', 50, price); // 50% of remaining = 30% of original
          continue;
        }

      } catch (err) {
        warn(`Error checking position ${key}: ${err}`);
      }
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private createPosition(
    currency: string,
    issuer: string,
    entryPrice: number,
    tokens: number,
    xrpSpent: number,
    txHash: string
  ): LivePosition {
    return {
      id: `${currency}:${Date.now()}`,
      currency,
      issuer,
      entryPriceXRP: entryPrice,
      tokensHeld: tokens,
      entryXRP: xrpSpent,
      stopLossPrice: entryPrice * 0.85,
      tp1Price:      entryPrice * 1.35,
      tp2Price:      entryPrice * 1.75,
      trailingStop:  entryPrice * 0.85,
      tp1Hit: false,
      tp2Hit: false,
      highestPrice: entryPrice,
      openedAt: Date.now(),
      txHash,
    };
  }

  private parseOfferFill(meta: any, currency: string, issuer: string): {
    tokensReceived: number;
    xrpSpent: number;
  } {
    let tokensReceived = 0;
    let xrpSpent = 0;

    const nodes: any[] = meta?.AffectedNodes || [];
    for (const node of nodes) {
      const n = node.ModifiedNode || node.CreatedNode || node.DeletedNode;
      if (!n) continue;

      if (n.LedgerEntryType === 'AccountRoot') {
        const prev = parseInt(n.PreviousFields?.Balance || '0');
        const curr = parseInt(n.FinalFields?.Balance || '0');
        const delta = curr - prev;
        if (delta < 0) xrpSpent = Math.abs(delta) / 1_000_000;
      }

      if (n.LedgerEntryType === 'RippleState') {
        const prevBal = parseFloat(n.PreviousFields?.Balance?.value || '0');
        const currBal = parseFloat(n.FinalFields?.Balance?.value || '0');
        const delta = currBal - prevBal;
        if (delta > 0) tokensReceived = delta;
      }
    }

    return { tokensReceived, xrpSpent };
  }

  private simulateOpen(
    currency: string,
    issuer: string,
    xrpAmount: number,
    price: number,
    tokens: number
  ): ExecutionResult {
    const fakeTxHash = 'DRY' + Date.now().toString(16).toUpperCase();
    const position = this.createPosition(currency, issuer, price, tokens, xrpAmount, fakeTxHash);
    this.positions.set(`${currency}:${issuer}`, position);
    this.totalTradesOpened++;
    info(`[DRY-RUN] Simulated buy: ${tokens.toFixed(4)} ${currency} @ ${price.toFixed(8)}`);
    return { success: true, txHash: fakeTxHash, actualPrice: price, actualTokens: tokens, actualXRP: xrpAmount, slippage: 0 };
  }

  private simulateClose(
    position: LivePosition,
    posKey: string,
    reason: string,
    sellPercent: number,
    price: number
  ): ExecutionResult {
    const tokensToSell = position.tokensHeld * (sellPercent / 100);
    const xrpReceived = tokensToSell * price;
    const pnlXRP = xrpReceived - (position.entryPriceXRP * tokensToSell);
    this.dailyPnL += pnlXRP;

    if (sellPercent >= 100) {
      this.positions.delete(posKey);
      this.totalTradesClosed++;
    } else {
      position.tokensHeld -= tokensToSell;
      if (reason === 'tp1') { position.tp1Hit = true; position.trailingStop = position.entryPriceXRP; }
      if (reason === 'tp2') { position.tp2Hit = true; }
    }

    info(`[DRY-RUN] Simulated sell: ${tokensToSell.toFixed(4)} ${position.currency} @ ${price.toFixed(8)} | PnL: ${pnlXRP >= 0 ? '+' : ''}${pnlXRP.toFixed(4)} XRP`);

    this.sendExitAlert(position, reason as any, price, pnlXRP, sellPercent, 'DRY-RUN').catch(() => {});
    return { success: true, txHash: 'DRY-RUN', actualPrice: price, actualXRP: xrpReceived };
  }

  private async sendEntryAlert(pos: LivePosition, score: number, slippage: number): Promise<void> {
    const msg = [
      `📈 <b>TRADE OPENED${this.dryRun ? ' [DRY-RUN]' : ''}</b>`,
      ``,
      `<b>Token:</b> <code>${pos.currency}</code>`,
      `<b>Entry:</b> ${pos.entryPriceXRP.toFixed(8)} XRP`,
      `<b>Size:</b> ${pos.entryXRP.toFixed(2)} XRP`,
      `<b>Tokens:</b> ${pos.tokensHeld.toFixed(4)}`,
      `<b>Score:</b> ${score}/100`,
      `<b>Slippage:</b> ${slippage.toFixed(2)}%`,
      ``,
      `🛑 Stop: ${pos.stopLossPrice.toFixed(8)} XRP (-15%)`,
      `🎯 TP1:  ${pos.tp1Price.toFixed(8)} XRP (+35%) → sell 40%`,
      `🎯 TP2:  ${pos.tp2Price.toFixed(8)} XRP (+75%) → sell 30%`,
      ``,
      `<a href="https://livenet.xrpl.org/transactions/${pos.txHash}">View TX</a>`,
    ].join('\n');

    await this.alerter.sendRaw(msg);
  }

  private async sendExitAlert(
    pos: LivePosition,
    reason: string,
    price: number,
    pnlXRP: number,
    sellPct: number,
    txHash: string
  ): Promise<void> {
    const pnlPct = ((price - pos.entryPriceXRP) / pos.entryPriceXRP) * 100;
    const emoji = pnlXRP >= 0 ? '✅' : '🔴';
    const reasonLabel: Record<string, string> = {
      stop_loss: '🛑 Stop Loss',
      tp1: '🎯 Take Profit 1 (+35%)',
      tp2: '🎯 Take Profit 2 (+75%)',
      trailing_stop: '📉 Trailing Stop',
      manual: '🤚 Manual Close',
    };

    const msg = [
      `${emoji} <b>TRADE CLOSED${this.dryRun ? ' [DRY-RUN]' : ''}</b>`,
      ``,
      `<b>Token:</b> <code>${pos.currency}</code>`,
      `<b>Reason:</b> ${reasonLabel[reason] || reason}`,
      `<b>Sold:</b> ${sellPct}% of position`,
      `<b>Exit Price:</b> ${price.toFixed(8)} XRP`,
      `<b>Entry Price:</b> ${pos.entryPriceXRP.toFixed(8)} XRP`,
      `${emoji} <b>PnL:</b> ${pnlXRP >= 0 ? '+' : ''}${pnlXRP.toFixed(4)} XRP (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)`,
      `<b>Daily PnL:</b> ${this.dailyPnL >= 0 ? '+' : ''}${this.dailyPnL.toFixed(4)} XRP`,
      ``,
      `<a href="https://livenet.xrpl.org/transactions/${txHash}">View TX</a>`,
    ].join('\n');

    await this.alerter.sendRaw(msg);
  }

  getStats(): object {
    return {
      wallet: this.wallet.address,
      openPositions: this.positions.size,
      totalOpened: this.totalTradesOpened,
      totalClosed: this.totalTradesClosed,
      dailyPnL: this.dailyPnL,
      dryRun: this.dryRun,
    };
  }
}
