/**
 * Paper Trading Module
 * Simulates trades with tracked PnL, no real execution
 */

import { TrackedToken, MarketSnapshot, PaperTrade, DailySummary } from '../types';
import { BotConfig } from '../config';
import { Database } from '../db/database';
import { PositionSizer } from './positionSizer';
import { info, warn, debug } from '../utils/logger';

interface OpenPosition {
  trade: PaperTrade;
  entryPriceXRP: number;
  tokensHeld: number;
  remainingPercent: number; // 100 = full position
  highestPriceSinceEntry: number;
  // FIX #24: Track risk state for emergency exit decisions
  entryRiskFlags: string[];
  lastRiskCheck: number;
  // Improved exit: track volatility for dynamic stops
  priceHistory: number[]; // Last 10 prices for volatility calculation
}

export class PaperTrader {
  private config: BotConfig;
  private db: Database;
  private positionSizer: PositionSizer;
  private bankrollXRP: number;
  private openPositions: Map<string, OpenPosition> = new Map();
  private lastCloseTime: Map<string, number> = new Map();
  private dailyPnL: number = 0;
  private tradesToday: number = 0;
  private lastResetDate: string = '';

  // Trading stats for Kelly Criterion
  private totalTrades: number = 0;
  private winningTrades: number = 0;
  private totalWinAmount: number = 0;
  private totalLossAmount: number = 0;

  constructor(config: BotConfig, db: Database) {
    this.config = config;
    this.db = db;
    this.positionSizer = new PositionSizer();
    this.bankrollXRP = config.startingBankrollXRP;
    this.lastResetDate = this.getCurrentDate();

    // Load existing state from DB
    this.loadState();
  }

  /**
   * Try to open a new paper trade
   */
  tryOpenTrade(
    token: TrackedToken,
    snapshot: MarketSnapshot | null,
    score: number,
    entryReason: string
  ): PaperTrade | null {
    // Check mode
    if (this.config.mode !== 'PAPER') {
      debug('Paper trading disabled (mode is not PAPER)');
      return null;
    }

    // Check score threshold
    if (score < this.config.minScorePaperTrade) {
      debug(`Score ${score} below threshold ${this.config.minScorePaperTrade}`);
      return null;
    }

    // Check max open trades
    if (this.openPositions.size >= this.config.maxOpenTrades) {
      warn(`Max open trades (${this.config.maxOpenTrades}) reached`);
      return null;
    }

    // Check daily loss limit
    this.checkDailyReset();
    if (this.dailyPnL <= -this.config.maxDailyLossXRP) {
      warn(`Daily loss limit reached: ${this.dailyPnL.toFixed(2)} XRP`);
      return null;
    }

    // Check we have bankroll
    if (this.bankrollXRP < this.config.maxTradeXRP) {
      warn(`Insufficient bankroll: ${this.bankrollXRP.toFixed(2)} XRP`);
      return null;
    }

    // Need valid price
    if (!snapshot || !snapshot.priceXRP || snapshot.priceXRP <= 0) {
      warn('No valid price for trade entry');
      return null;
    }

    const key = `${token.currency}:${token.issuer}`;

    // Don't double-enter same token — check both in-memory map AND DB
    // The DB check guards against race conditions and post-restart duplicates
    if (this.openPositions.has(key)) {
      debug(`Already have open position for ${key} (in-memory)`);
      return null;
    }
    if (this.db.hasOpenTradeForToken(token.currency, token.issuer)) {
      warn(`Blocked duplicate trade for ${key} — already open in DB`);
      // Sync in-memory state from DB to avoid future misses
      this.loadOpenPositionFromDB(token.currency, token.issuer);
      return null;
    }

    // Cooldown: don't re-enter a token within 30 minutes of last close
    const lastClose = this.lastCloseTime?.get(key) || 0;
    if (Date.now() - lastClose < 30 * 60 * 1000) {
      debug(`Cooldown active for ${key}, skipping re-entry`);
      return null;
    }

    // Calculate dynamic position size
    const winRate = this.totalTrades > 0 ? this.winningTrades / this.totalTrades : 0.5;
    const avgWin = this.winningTrades > 0 ? this.totalWinAmount / this.winningTrades : 5;
    const avgLoss = this.totalLossAmount > 0 ? Math.abs(this.totalLossAmount) / (this.totalTrades - this.winningTrades) : 5;
    const volatility = this.estimateVolatility(snapshot);

    const sizeRecommendation = this.positionSizer.calculatePositionSize(
      this.bankrollXRP,
      winRate,
      avgWin,
      avgLoss,
      volatility,
      score
    );

    const tradeSizeXRP = Math.min(sizeRecommendation.sizeXRP, this.config.maxTradeXRP);
    const entryPrice = snapshot.priceXRP;
    const slippage = this.estimateSlippage(tradeSizeXRP, snapshot);
    const effectivePrice = entryPrice * (1 + slippage);
    const tokensBought = tradeSizeXRP / effectivePrice;
    const fees = tradeSizeXRP * 0.003; // 0.3% estimated fees

    const trade: PaperTrade = {
      tokenCurrency: token.currency,
      tokenIssuer: token.issuer,
      entryPriceXRP: entryPrice,
      entryAmountXRP: tradeSizeXRP,
      entryTimestamp: Date.now(),
      entryScore: score,
      entryReason,
      exitPriceXRP: null,
      exitTimestamp: null,
      exitScore: null,
      exitReason: null,
      status: 'open',
      pnlXRP: null,
      pnlPercent: null,
      slippageEstimate: slippage,
      feesPaid: fees,
      tp1Hit: false,
      tp2Hit: false,
      trailingStopActive: false,
      remainingPosition: 100,
    };

    // Deduct from bankroll
    this.bankrollXRP -= tradeSizeXRP + fees;

    debug(`Position sizing: ${sizeRecommendation.method} | Size: ${tradeSizeXRP.toFixed(2)} XRP | ${sizeRecommendation.reasoning}`);

    // Track position
    this.openPositions.set(key, {
      trade,
      entryPriceXRP: entryPrice,
      tokensHeld: tokensBought,
      remainingPercent: 100,
      highestPriceSinceEntry: entryPrice,
      // FIX #24: Store initial risk state
      entryRiskFlags: [],
      lastRiskCheck: Date.now(),
      // Improved exit: initialize price history
      priceHistory: [entryPrice],
    });

    // Save to DB
    this.db.savePaperTrade(trade);

    info(`📈 Paper trade OPENED: ${token.currency} @ ${entryPrice.toFixed(6)} XRP, size: ${tradeSizeXRP.toFixed(2)} XRP, score: ${score}`);

    return trade;
  }

  /**
   * Check the open position for a specific token for exit conditions.
   * Only evaluates the token matching the snapshot — avoids duplicate
   * close events when multiple tokens are scanned in the same cycle.
   */
  checkExits(snapshot: MarketSnapshot | null): PaperTrade[] {
    const closedTrades: PaperTrade[] = [];
    const keysToClose: string[] = [];

    if (!snapshot || !snapshot.priceXRP || snapshot.priceXRP <= 0) {
      return closedTrades;
    }

    const currentPrice = snapshot.priceXRP;

    // Only evaluate the position matching this snapshot's token
    const snapshotKey = `${snapshot.tokenCurrency}:${snapshot.tokenIssuer}`;

    // First pass: evaluate matching position only
    for (const [key, position] of this.openPositions.entries()) {
      const trade = position.trade;

      // Skip positions that don't match this snapshot's token
      if (key !== snapshotKey) continue;

      // Skip already-closing positions
      if (keysToClose.includes(key)) continue;

      // Update highest price and price history
      if (currentPrice > position.highestPriceSinceEntry) {
        position.highestPriceSinceEntry = currentPrice;
      }
      position.priceHistory.push(currentPrice);
      if (position.priceHistory.length > 10) {
        position.priceHistory.shift(); // Keep last 10 prices
      }

      const pnlPercent = ((currentPrice - trade.entryPriceXRP) / trade.entryPriceXRP) * 100;

      // Calculate dynamic stop loss based on volatility
      const volatility = this.calculateVolatility(position.priceHistory);
      const dynamicStopLoss = this.getDynamicStopLoss(volatility, pnlPercent);

      // Check stop loss (dynamic based on volatility)
      if (pnlPercent <= dynamicStopLoss && trade.remainingPosition > 0) {
        keysToClose.push(key);
        closedTrades.push(trade);
        continue;
      }

      // Check Take Profit 1 (+35%, sell 40% of original position)
      if (!trade.tp1Hit && pnlPercent >= 35 && trade.remainingPosition > 0) {
        this.partialClose(key, currentPrice, 40, 'take_profit_1', snapshot);
        trade.tp1Hit = true;
        this.db.updatePaperTrade(trade);
      }

      // Check Take Profit 2 (+75%, sell 30% of original position)
      // After TP1 (40% sold), remaining is 60%. Sell 30/60 = 50% of remaining.
      if (!trade.tp2Hit && pnlPercent >= 75 && trade.remainingPosition > 0) {
        const percentOfRemaining = (30 / trade.remainingPosition) * 100;
        this.partialClose(key, currentPrice, Math.min(percentOfRemaining, 100), 'take_profit_2', snapshot);
        trade.tp2Hit = true;
        this.db.updatePaperTrade(trade);
      }

      // Activate trailing stop based on volatility and gains
      const trailVolatility = this.calculateVolatility(position.priceHistory);
      const trailingActivationThreshold = this.getTrailingActivationThreshold(trailVolatility, pnlPercent);

      if (!trade.trailingStopActive && pnlPercent >= trailingActivationThreshold) {
        trade.trailingStopActive = true;
        this.db.updatePaperTrade(trade);
      }

      // Check trailing stop (dynamic based on volatility)
      if (trade.trailingStopActive && trade.remainingPosition > 0) {
        const trailingDistance = this.getTrailingDistance(trailVolatility);
        const trailThreshold = position.highestPriceSinceEntry * (1 - trailingDistance);
        if (currentPrice <= trailThreshold) {
          keysToClose.push(key);
          closedTrades.push(trade);
        }
      }
    }

    // Second pass: properly close positions (sets exit price, PnL, fees) then remove
    // Must happen after the iteration loop to avoid mutating the Map mid-loop
    const finalClosed: PaperTrade[] = [];
    for (const key of keysToClose) {
      this.closePosition(key, currentPrice, 'stop_loss_or_trailing', snapshot);
      // closePosition already deleted from openPositions and updated the trade object
      // retrieve the updated trade from the original closedTrades reference
      const ref = closedTrades.find(t => `${t.tokenCurrency}:${t.tokenIssuer}` === key);
      if (ref) finalClosed.push(ref);
    }

    return finalClosed;
  }

  /**
   * Close entire position
   * FIX #25: Calculate slippage based on token quantity vs pool depth
   */
  private closePosition(
    key: string,
    exitPrice: number,
    reason: string,
    snapshot: MarketSnapshot | null
  ): void {
    const position = this.openPositions.get(key);
    if (!position) return;

    const trade = position.trade;
    const tokensToSell = position.tokensHeld * (trade.remainingPosition / 100);

    // FIX #25: Estimate slippage based on trade value relative to liquidity
    const tradeValueXRP = tokensToSell * exitPrice;
    const slippage = this.estimateSlippage(tradeValueXRP, snapshot);

    const effectiveExitPrice = exitPrice * (1 - slippage);
    const proceeds = tokensToSell * effectiveExitPrice;
    const fees = proceeds * 0.003;
    const netProceeds = proceeds - fees;

    // PnL is net proceeds minus the portion of entry cost for this position
    const entryCostForPosition = trade.entryAmountXRP * (trade.remainingPosition / 100);
    const pnlXRP = netProceeds - entryCostForPosition;
    const pnlPercent = entryCostForPosition > 0 ? (pnlXRP / entryCostForPosition) * 100 : 0;

    // Update trade
    trade.exitPriceXRP = exitPrice;
    trade.exitTimestamp = Date.now();
    trade.exitScore = snapshot ? this.getScoreFromSnapshot(snapshot) : null;
    trade.exitReason = reason;
    trade.status = 'closed';
    trade.pnlXRP = parseFloat(pnlXRP.toFixed(6));
    trade.pnlPercent = parseFloat(pnlPercent.toFixed(2));
    trade.feesPaid += fees;
    trade.remainingPosition = 0;

    // Return proceeds to bankroll
    this.bankrollXRP += netProceeds;
    this.dailyPnL += pnlXRP;
    this.tradesToday++;

    // Remove from open positions
    this.openPositions.delete(key);
    this.lastCloseTime.set(key, Date.now());

    // Save to DB
    this.db.updatePaperTrade(trade);

    // Update trading stats for Kelly Criterion
    this.totalTrades++;
    if (pnlXRP > 0) {
      this.winningTrades++;
      this.totalWinAmount += pnlXRP;
    } else {
      this.totalLossAmount += Math.abs(pnlXRP);
    }

    const action = pnlXRP >= 0 ? '✅' : '❌';
    info(`${action} Paper trade CLOSED: ${trade.tokenCurrency} | PnL: ${pnlXRP.toFixed(4)} XRP (${pnlPercent.toFixed(2)}%) | Reason: ${reason}`);
  }

  /**
   * Partially close position
   * FIX #3: Track cost basis per token unit for accurate PnL on partial closes
   */
  private partialClose(
    key: string,
    exitPrice: number,
    percentToClose: number,
    reason: string,
    snapshot: MarketSnapshot | null
  ): void {
    const position = this.openPositions.get(key);
    if (!position) return;

    const trade = position.trade;

    // percentToClose is percentage of REMAINING position to close
    const tokensToSell = position.tokensHeld * (percentToClose / 100);

    // FIX #25: Slippage based on trade value vs liquidity
    const tradeValueXRP = tokensToSell * exitPrice;
    const slippage = this.estimateSlippage(tradeValueXRP, snapshot);

    const effectiveExitPrice = exitPrice * (1 - slippage);
    const proceeds = tokensToSell * effectiveExitPrice;
    const fees = proceeds * 0.003;
    const netProceeds = proceeds - fees;

    // FIX #3: Cost basis is proportional to tokens sold vs total tokens held
    const fractionSold = percentToClose / 100;
    const costBasisSold = trade.entryAmountXRP * fractionSold;
    const pnlXRP = netProceeds - costBasisSold;
    const pnlPercent = costBasisSold > 0 ? (pnlXRP / costBasisSold) * 100 : 0;

    // Update trade
    trade.feesPaid += fees;
    trade.remainingPosition -= percentToClose;

    // If fully closed, mark as closed
    if (trade.remainingPosition <= 0) {
      trade.exitPriceXRP = exitPrice;
      trade.exitTimestamp = Date.now();
      trade.exitScore = snapshot ? this.getScoreFromSnapshot(snapshot) : null;
      trade.exitReason = reason;
      trade.status = 'closed';
      trade.pnlXRP = parseFloat(pnlXRP.toFixed(6));
      trade.pnlPercent = parseFloat(pnlPercent.toFixed(2));
      this.openPositions.delete(key);
    } else {
      trade.status = 'partial';
    }

    // Return proceeds to bankroll
    this.bankrollXRP += netProceeds;
    this.dailyPnL += pnlXRP;
    this.tradesToday++;

    // Save to DB
    this.db.updatePaperTrade(trade);

    info(`📊 Partial close: ${trade.tokenCurrency} | Sold ${percentToClose}% | PnL: ${pnlXRP.toFixed(4)} XRP`);
  }

  /**
   * FIX #24: Update risk state for an open position and check for emergency exit
   * Returns trade if emergency exit was triggered, null otherwise
   */
  updateRiskState(
    tokenCurrency: string,
    tokenIssuer: string,
    currentRiskFlags: string[],
    snapshot: MarketSnapshot | null
  ): PaperTrade | null {
    const key = `${tokenCurrency}:${tokenIssuer}`;
    const position = this.openPositions.get(key);

    if (!position) return null;

    const trade = position.trade;

    // Skip if already closing/closed
    if (trade.status === 'closed') return null;

    // Update risk tracking
    position.entryRiskFlags = currentRiskFlags;
    position.lastRiskCheck = Date.now();

    // Check for critical new risk flags that warrant emergency exit
    const criticalFlags = ['liquidity_removed', 'dev_dumping', 'concentrated_supply'];
    const newCriticalFlags = currentRiskFlags.filter(f =>
      criticalFlags.includes(f) && !trade.entryReason.includes(f)
    );

    if (newCriticalFlags.length > 0) {
      warn(`🚨 Emergency exit triggered for ${key}: ${newCriticalFlags.join(', ')}`);

      const exitPrice = snapshot?.priceXRP || trade.entryPriceXRP * 0.9;
      this.closePosition(key, exitPrice, `emergency_${newCriticalFlags.join(',')}`, snapshot);
      return trade;
    }

    return null;
  }

  /**
   * Emergency exit all positions (e.g., system-wide risk event)
   */
  emergencyExitAll(reason: string, snapshots: Map<string, MarketSnapshot>): PaperTrade[] {
    const closedTrades: PaperTrade[] = [];
    const keysToClose: string[] = [];

    for (const [key, position] of this.openPositions.entries()) {
      const snapshot = snapshots.get(key);
      const exitPrice = snapshot?.priceXRP || position.entryPriceXRP * 0.9; // Default to -10% if no price

      this.closePosition(key, exitPrice, `emergency_${reason}`, snapshot || null);
      closedTrades.push(position.trade);
      keysToClose.push(key);
    }

    // Clean up after iteration
    for (const key of keysToClose) {
      this.openPositions.delete(key);
    }

    return closedTrades;
  }

  /**
   * Estimate slippage based on trade size vs liquidity
   */
  private estimateSlippage(tradeSizeXRP: number, snapshot: MarketSnapshot | null): number {
    if (!snapshot || !snapshot.liquidityXRP || snapshot.liquidityXRP <= 0) {
      return 0.02; // Default 2% slippage if unknown
    }

    // Slippage increases with trade size relative to liquidity
    const ratio = tradeSizeXRP / snapshot.liquidityXRP;
    return Math.min(0.05, ratio * 0.1); // Max 5% slippage
  }

  /**
   * Get score from snapshot (helper)
   */
  private getScoreFromSnapshot(snapshot: MarketSnapshot | null): number | null {
    // This would need the scorer - for now return null
    return null;
  }

  /**
   * Check and reset daily counters
   */
  private checkDailyReset(): void {
    const today = this.getCurrentDate();
    if (today !== this.lastResetDate) {
      info(`Daily reset: PnL was ${this.dailyPnL.toFixed(2)} XRP over ${this.tradesToday} trades`);

      // FIX #1: Save summary for the COMPLETED day (yesterday), not today
      this.saveDailySummary(this.lastResetDate);

      this.dailyPnL = 0;
      this.tradesToday = 0;
      this.lastResetDate = today;
    }
  }

  /**
   * Save daily summary to DB
   * FIX #1: Accept date parameter to save correct day's summary
   */
  private saveDailySummary(dateStr: string): void {

    const trades = this.db.getTradesForDate(dateStr);
    const closedTrades = trades.filter(t => t.status === 'closed');

    if (closedTrades.length === 0) return;

    const totalPnL = closedTrades.reduce((sum, t) => sum + (t.pnlXRP || 0), 0);
    const winningTrades = closedTrades.filter(t => (t.pnlXRP || 0) > 0);
    const winRate = closedTrades.length > 0 ? (winningTrades.length / closedTrades.length) * 100 : 0;

    const pnls = closedTrades.map(t => t.pnlXRP || 0);
    const maxDrawdown = Math.min(0, ...pnls);
    const bestTrade = Math.max(0, ...pnls);
    const worstTrade = Math.min(0, ...pnls);

    const summary: DailySummary = {
      date: dateStr,
      tradesOpened: trades.length,
      tradesClosed: closedTrades.length,
      totalPnLXRP: parseFloat(totalPnL.toFixed(4)),
      winRate: parseFloat(winRate.toFixed(2)),
      maxDrawdown: parseFloat(maxDrawdown.toFixed(4)),
      bestTrade: parseFloat(bestTrade.toFixed(4)),
      worstTrade: parseFloat(worstTrade.toFixed(4)),
    };

    this.db.saveDailySummary(summary);
  }

  /**
   * Sync a single open position from DB into the in-memory map.
   * Called when we detect a DB open trade that isn't in memory (e.g. after restart race).
   */
  private loadOpenPositionFromDB(currency: string, issuer: string): void {
    const key = `${currency}:${issuer}`;
    if (this.openPositions.has(key)) return; // already loaded
    const openTrades = this.db.getOpenTrades();
    const trade = openTrades.find(t => t.tokenCurrency === currency && t.tokenIssuer === issuer);
    if (!trade) return;
    const tokensHeld = trade.entryAmountXRP / trade.entryPriceXRP;
    this.openPositions.set(key, {
      trade,
      entryPriceXRP: trade.entryPriceXRP,
      tokensHeld,
      remainingPercent: trade.remainingPosition,
      highestPriceSinceEntry: trade.entryPriceXRP,
      entryRiskFlags: [],
      lastRiskCheck: Date.now(),
      priceHistory: [trade.entryPriceXRP],
    });
  }

  /**
   * Load state from DB
   * FIX #2: Only use the most recent summary to avoid double-counting historical PnL
   */
  private loadState(): void {
    // Load bankroll from the MOST RECENT daily summary only
    const summaries = this.db.getRecentSummaries(1);
    if (summaries.length > 0) {
      // Bankroll = starting + all historical PnL up to yesterday
      const latestSummary = summaries[0];
      this.bankrollXRP = this.config.startingBankrollXRP + latestSummary.totalPnLXRP;
    }

    // Load open positions
    const openTrades = this.db.getOpenTrades();
    for (const trade of openTrades) {
      const key = `${trade.tokenCurrency}:${trade.tokenIssuer}`;
      const tokensHeld = trade.entryAmountXRP / trade.entryPriceXRP;
      this.openPositions.set(key, {
        trade,
        entryPriceXRP: trade.entryPriceXRP,
        tokensHeld,
        remainingPercent: trade.remainingPosition,
        highestPriceSinceEntry: trade.entryPriceXRP,
        // FIX #24: Initialize risk tracking for loaded positions
        entryRiskFlags: [],
        lastRiskCheck: Date.now(),
        // Improved exit: initialize price history
        priceHistory: [trade.entryPriceXRP],
      });
    }

    info(`Loaded ${this.openPositions.size} open positions, bankroll: ${this.bankrollXRP.toFixed(2)} XRP`);
  }

  /**
   * Get current state
   */
  getState(): {
    bankrollXRP: number;
    openPositions: number;
    dailyPnL: number;
    tradesToday: number;
  } {
    this.checkDailyReset();
    return {
      bankrollXRP: parseFloat(this.bankrollXRP.toFixed(4)),
      openPositions: this.openPositions.size,
      dailyPnL: parseFloat(this.dailyPnL.toFixed(4)),
      tradesToday: this.tradesToday,
    };
  }

  /**
   * Get all open positions
   */
  getOpenPositions(): PaperTrade[] {
    return Array.from(this.openPositions.values()).map(p => p.trade);
  }

  /**
   * FIX #24: Check if we have an open position for a token
   */
  hasOpenPosition(currency: string, issuer: string): boolean {
    const key = `${currency}:${issuer}`;
    return this.openPositions.has(key);
  }

  /**
   * Helper to get current date string
   */
  private getCurrentDate(): string {
    return new Date().toISOString().split('T')[0];
  }

  /**
   * Calculate price volatility from recent prices
   * Returns coefficient of variation (stddev / mean)
   */
  private calculateVolatility(prices: number[]): number {
    if (prices.length < 2) return 0.1; // Default low volatility

    const mean = prices.reduce((sum, p) => sum + p, 0) / prices.length;
    if (mean <= 0) return 0.1;

    const variance = prices.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / prices.length;
    const stddev = Math.sqrt(variance);

    return stddev / mean; // Coefficient of variation
  }

  /**
   * Get dynamic stop loss based on volatility
   * High volatility = wider stop, low volatility = tighter stop
   */
  private getDynamicStopLoss(volatility: number, pnlPercent: number): number {
    // Base stop loss
    let stopLoss = -10;

    // Adjust based on volatility
    if (volatility > 0.2) stopLoss = -20; // Very volatile: wide stop
    else if (volatility > 0.1) stopLoss = -15; // Moderate volatility
    else if (volatility > 0.05) stopLoss = -12; // Low volatility
    else stopLoss = -8; // Very stable: tight stop

    // If already in profit, tighten stop to protect gains
    if (pnlPercent > 20) stopLoss = Math.max(stopLoss, -5);
    if (pnlPercent > 50) stopLoss = Math.max(stopLoss, -3);

    return stopLoss;
  }

  /**
   * Get trailing stop activation threshold based on volatility
   */
  private getTrailingActivationThreshold(volatility: number, pnlPercent: number): number {
    // High volatility: wait for bigger gains before activating trail
    if (volatility > 0.2) return 30;
    if (volatility > 0.1) return 25;
    if (volatility > 0.05) return 20;
    return 15; // Low volatility: activate early
  }

  /**
   * Get trailing stop distance based on volatility
   */
  private getTrailingDistance(volatility: number): number {
    // High volatility: wider trail to avoid premature exits
    if (volatility > 0.2) return 0.20; // 20% trail
    if (volatility > 0.1) return 0.15; // 15% trail
    if (volatility > 0.05) return 0.12; // 12% trail
    return 0.10; // 10% trail for stable tokens
  }

  /**
   * Estimate volatility from snapshot price changes
   */
  private estimateVolatility(snapshot: MarketSnapshot | null): number {
    if (!snapshot) return 0.1; // Default moderate volatility

    const changes = [
      snapshot.priceChange5m || 0,
      snapshot.priceChange15m || 0,
      snapshot.priceChange1h || 0,
    ].filter(c => c !== null) as number[];

    if (changes.length === 0) return 0.1;

    // Calculate coefficient of variation
    const mean = changes.reduce((sum, c) => sum + c, 0) / changes.length;
    const variance = changes.reduce((sum, c) => sum + Math.pow(c - mean, 2), 0) / changes.length;
    const stddev = Math.sqrt(variance);

    return mean !== 0 ? Math.abs(stddev / mean) : 0.1;
  }
}
