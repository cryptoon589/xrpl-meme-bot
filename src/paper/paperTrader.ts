/**
 * Paper Trading Module
 * Simulates trades with tracked PnL, no real execution
 */

import { TrackedToken, MarketSnapshot, PaperTrade, DailySummary } from '../types';
import { BotConfig } from '../config';
import { Database } from '../db/database';
import { PositionSizer } from './positionSizer';
import { info, warn, debug } from '../utils/logger';
import { BuyPressureTracker } from '../market/buyPressureTracker';
import { TradeProfileName, PROFILES } from '../execution/tradeProfiles';

interface OpenPosition {
  trade: PaperTrade;
  entryPriceXRP: number;
  tokensHeld: number;
  remainingPercent: number; // 100 = full position
  highestPriceSinceEntry: number;
  entryRiskFlags: string[];
  lastRiskCheck: number;
  priceHistory: number[]; // Last 10 prices for volatility calculation
  openedAt: number;       // Timestamp of entry — used to enforce minimum hold time
  tradeProfile: 'scored' | 'burst'; // exit rules differ
  profileName: TradeProfileName;    // full profile used for sizing + kill switches
  stopLossPercent?: number; // override for dynamic stop (e.g. tightened on concentrated supply)
  tp1Pct?: number;          // learned TP1 target (overrides hardcoded default)
  tp2Pct?: number;          // learned TP2 target
  /** Kill switch tracking */
  lastBuySeenAt: number;            // last timestamp a new buy was recorded
  liquidityAtEntry: number;         // poolXrpReserve at entry
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
  private buyPressureTracker: BuyPressureTracker | null = null;

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

  setBuyPressureTracker(tracker: BuyPressureTracker): void {
    this.buyPressureTracker = tracker;
  }

  /**
   * Open a burst/pump trade — no score required, uses aggressive pump exit profile.
   * Entry: immediately on buy_burst signal
   * Exit: TP1 at +15%, 5-min hard stop, trailing stop activates at +10%
   */
  tryOpenBurstTrade(
    token: TrackedToken,
    snapshot: MarketSnapshot | null,
    entryReason: string,
    tpTargets?: { tp1: number; tp2: number }
  ): PaperTrade | null {
    if (this.config.mode !== 'PAPER') return null;

    // Require minimum liquidity for burst trades — consistent with global LP min (500 XRP)
    const liquidity = snapshot?.liquidityXRP ?? 0;
    if (liquidity < 500) {
      debug(`Burst trade skipped: pool too shallow (${liquidity.toFixed(0)} XRP < 500 XRP)`);
      return null;
    }

    if (this.openPositions.size >= this.config.maxOpenTrades) {
      warn(`Max open trades reached, skipping burst entry`);
      return null;
    }

    this.checkDailyReset();
    if (this.dailyPnL <= -this.config.maxDailyLossXRP) {
      warn(`Daily loss limit reached, skipping burst entry`);
      return null;
    }

    if (!snapshot || !snapshot.priceXRP || snapshot.priceXRP <= 0) {
      warn('No valid price for burst entry');
      return null;
    }

    const key = `${token.currency}:${token.issuer}`;
    if (this.openPositions.has(key)) {
      debug(`Already have open position for ${key}`);
      return null;
    }
    if (this.db.hasOpenTradeForToken(token.currency, token.issuer)) {
      warn(`Blocked duplicate burst trade for ${key}`);
      return null;
    }

    // Cooldown: don't re-enter same token within 10 min of last burst close
    const lastClose = this.lastCloseTime?.get(key) || 0;
    if (Date.now() - lastClose < 10 * 60 * 1000) {
      debug(`Burst cooldown active for ${key}`);
      return null;
    }

    // Dynamic burst sizing: scale by buy velocity (unique wallets) and pool depth
    // Base = minTradeXRP. Multiplier: more wallets + deeper pool = bigger position.
    // Cap at 25 XRP — bursts are unscored, keep risk bounded.
    const uniqueWallets = (snapshot as any).uniqueBuyers5m ?? 0;
    const tvl = snapshot.liquidityXRP ?? 0;
    const velocityMultiplier = uniqueWallets >= 8 ? 3.0
      : uniqueWallets >= 5 ? 2.0
      : uniqueWallets >= 3 ? 1.5
      : 1.0;
    const liquidityMultiplier = tvl >= 100_000 ? 1.5
      : tvl >= 50_000 ? 1.25
      : tvl >= 10_000 ? 1.0
      : 0.75; // shallow pool = smaller size
    const tradeSizeXRP = Math.min(
      this.config.minTradeXRP * velocityMultiplier * liquidityMultiplier,
      25 // hard cap
    );
    if (this.bankrollXRP < tradeSizeXRP) {
      warn(`Insufficient bankroll for burst trade`);
      return null;
    }

    const entryPrice = snapshot.priceXRP;
    const slippage = this.estimateSlippage(tradeSizeXRP, snapshot);
    const effectivePrice = entryPrice * (1 + slippage);
    const tokensBought = tradeSizeXRP / effectivePrice;
    const fees = tradeSizeXRP * 0.003;

    const trade: PaperTrade = {
      tokenCurrency: token.currency,
      tokenIssuer: token.issuer,
      entryPriceXRP: entryPrice,
      entryAmountXRP: tradeSizeXRP,
      entryTimestamp: Date.now(),
      entryScore: 0,
      entryReason: `[BURST] ${entryReason}`,
      exitPriceXRP: null,
      exitTimestamp: null,
      exitScore: null,
      exitReason: null,
      status: 'open',
      pnlXRP: null,
      pnlPercent: null,
      slippageEstimate: slippage,
      feesPaid: fees,
      xrpReturned: 0,
      tp1Hit: false,
      tp2Hit: false,
      trailingStopActive: false,
      remainingPosition: 100,
    };

    this.bankrollXRP -= tradeSizeXRP + fees;

    this.openPositions.set(key, {
      trade,
      entryPriceXRP: entryPrice,
      tokensHeld: tokensBought,
      remainingPercent: 100,
      highestPriceSinceEntry: entryPrice,
      entryRiskFlags: [],
      lastRiskCheck: Date.now(),
      priceHistory: [entryPrice],
      openedAt: Date.now(),
      tradeProfile: 'burst',
      profileName: tvl < 500 ? 'LOW_LIQ_PROBE' : 'BURST_SCALP',
      lastBuySeenAt: Date.now(),
      liquidityAtEntry: snapshot?.poolXrpReserve ?? tvl / 2,
      tp1Pct: tpTargets?.tp1,
      tp2Pct: tpTargets?.tp2,
    });

    this.db.savePaperTrade(trade);
    const displayName = token.currency.length === 40
      ? Buffer.from(token.currency.replace(/00+$/, ''), 'hex').toString('ascii').replace(/\x00/g, '').trim() || token.currency
      : token.currency;
    info(`🚀 BURST paper trade OPENED: ${displayName} (profile: ${(this.openPositions.get(key) as any)?.profileName ?? '?'}) @ ${entryPrice.toFixed(8)} XRP, size: ${tradeSizeXRP.toFixed(2)} XRP, pool: ${liquidity.toFixed(0)} XRP`);
    return trade;
  }

  /**
   * Try to open a new paper trade
   */
  tryOpenTrade(
    token: TrackedToken,
    snapshot: MarketSnapshot | null,
    score: number,
    entryReason: string,
    tpTargets?: { tp1: number; tp2: number }
  ): PaperTrade | null {
    // Check mode
    if (this.config.mode !== 'PAPER') {
      debug('Paper trading disabled (mode is not PAPER)');
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

    // Cooldown: 15min if buys still dominating (continuation move), 2h default
    const lastClose = this.lastCloseTime?.get(key) || 0;
    const liveBuyRatioReentry = (snapshot as any)?.buySellRatio ?? 0.5;
    const reEntryCooldown = liveBuyRatioReentry >= 0.70
      ? 15 * 60 * 1000        // 15 min — buys still dominating, ride continuation
      : 2 * 60 * 60 * 1000;  // 2h default
    if (Date.now() - lastClose < reEntryCooldown) {
      debug(`Cooldown active for ${key} (${reEntryCooldown / 60000}min), skipping re-entry`);
      return null;
    }

    // Calculate dynamic position size
    const winRate = this.totalTrades > 0 ? this.winningTrades / this.totalTrades : 0.5;
    const avgWin = this.winningTrades > 0 ? this.totalWinAmount / this.winningTrades : 5;
    const avgLoss = this.totalLossAmount > 0 ? Math.abs(this.totalLossAmount) / (this.totalTrades - this.winningTrades) : 5;
    const volatility = this.estimateVolatility(snapshot);

    // Live conviction signals from snapshot
    const uniqueBuyers = (snapshot as any)?.uniqueBuyers5m ?? 0;
    const totalTx      = (snapshot.buyCount5m || 0) + (snapshot.sellCount5m || 0);
    const buyRatio     = totalTx > 0 ? (snapshot.buyCount5m || 0) / totalTx : 0.5;

    const sizeRecommendation = this.positionSizer.calculatePositionSize(
      this.bankrollXRP,
      winRate,
      avgWin,
      avgLoss,
      volatility,
      score,
      uniqueBuyers,
      buyRatio
    );

    // Cap scored trades at 10 XRP until win rate improves (burst stays at 25 XRP max)
    const liveBuyRatio   = (snapshot as any)?.buySellRatio  ?? 0.5;
    const liveNewWallets = (snapshot as any)?.newWalletBuys ?? 0;
    const priceChange5m  = snapshot.priceChange5m ?? 0;
    const convictionMultiplier =
      (liveBuyRatio >= 0.75 && liveNewWallets >= 2 && priceChange5m >= 10) ? 2.0 :
      (liveBuyRatio >= 0.65 && liveNewWallets >= 1 && priceChange5m >= 5)  ? 1.5 :
      (liveBuyRatio >= 0.60)                                                ? 1.0 :
                                                                              0.5;
    const MAX_SCORED_TRADE_XRP = 10;
    const tradeSizeXRP = Math.min(
      Math.max(sizeRecommendation.sizeXRP * convictionMultiplier, this.config.minTradeXRP),
      Math.min(this.config.maxTradeXRP, MAX_SCORED_TRADE_XRP * convictionMultiplier)
    );
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
      xrpReturned: 0,
      tp1Hit: false,
      tp2Hit: false,
      trailingStopActive: false,
      remainingPosition: 100,
    };

    // Deduct from bankroll
    this.bankrollXRP -= tradeSizeXRP + fees;

    const kellySize = sizeRecommendation.sizeXRP;
    const clampNote = kellySize < this.config.minTradeXRP
      ? ` (Kelly suggested ${kellySize.toFixed(2)} XRP, raised to min ${this.config.minTradeXRP} XRP)`
      : '';
    debug(`Position sizing: ${sizeRecommendation.method} | Size: ${tradeSizeXRP.toFixed(2)} XRP${clampNote} | ${sizeRecommendation.reasoning}`);

    // Track position
    this.openPositions.set(key, {
      trade,
      entryPriceXRP: entryPrice,
      tokensHeld: tokensBought,
      remainingPercent: 100,
      highestPriceSinceEntry: entryPrice,
      entryRiskFlags: [],
      lastRiskCheck: Date.now(),
      priceHistory: [entryPrice],
      // Timestamp used to enforce minimum hold time before exits are checked
      openedAt: Date.now(),
      tradeProfile: 'scored',
      profileName: (snapshot?.poolXrpReserve ?? snapshot?.liquidityXRP ?? 0) / 2 >= 2000
        ? 'MOMENTUM_RUNNER' : 'BURST_SCALP',
      lastBuySeenAt: Date.now(),
      liquidityAtEntry: snapshot?.poolXrpReserve ?? (snapshot?.liquidityXRP ?? 0) / 2,
      tp1Pct: tpTargets?.tp1,
      tp2Pct: tpTargets?.tp2,
    });

    // Save to DB
    this.db.savePaperTrade(trade);

    const displayName2 = token.currency.length === 40
      ? Buffer.from(token.currency.replace(/00+$/, ''), 'hex').toString('ascii').replace(/\x00/g, '').trim() || token.currency
      : token.currency;
    info(`📈 Paper trade OPENED: ${displayName2} (profile: ${(this.openPositions.get(key) as any)?.profileName ?? '?'}) @ ${entryPrice.toFixed(6)} XRP, size: ${tradeSizeXRP.toFixed(2)} XRP, score: ${score}`);

    return trade;
  }

  /**
   * Check the open position for a specific token for exit conditions.
   * Only evaluates the token matching the snapshot — avoids duplicate
   * close events when multiple tokens are scanned in the same cycle.
   */
  checkExits(snapshot: MarketSnapshot | null): PaperTrade[] {
    const closedTrades: PaperTrade[] = [];
    const keysToClose: { key: string; reason: string }[] = [];

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
      if (keysToClose.some(k => k.key === key)) continue;

      // Update highest price and price history
      if (currentPrice > position.highestPriceSinceEntry) {
        position.highestPriceSinceEntry = currentPrice;
      }
      position.priceHistory.push(currentPrice);
      if (position.priceHistory.length > 10) {
        position.priceHistory.shift();
      }

      const pnlPercent = ((currentPrice - trade.entryPriceXRP) / trade.entryPriceXRP) * 100;
      const ageMs = Date.now() - (position.openedAt || 0);
      const isBurst = position.tradeProfile === 'burst';

      // ── KILL SWITCHES (all profiles) ────────────────────────────────────────
      const prof = PROFILES[position.profileName] ?? PROFILES.BURST_SCALP;
      const ks = prof.killSwitches;

      // Update lastBuySeenAt if there are recent buys
      const liveSnap = this.buyPressureTracker?.getSnapshot(
        snapshot.tokenCurrency, snapshot.tokenIssuer
      );
      if (liveSnap && liveSnap.buyCount > 0) {
        position.lastBuySeenAt = Date.now();
      }

      // Kill 1: no new buy within N min AND price below entry
      const msSinceLastBuy = Date.now() - (position.lastBuySeenAt ?? position.openedAt);
      if (
        !trade.tp1Hit &&
        msSinceLastBuy > ks.noNewBuyMins * 60 * 1000 &&
        currentPrice < trade.entryPriceXRP
      ) {
        info(`⚡ Kill switch 1 (no follow-through) for ${key}: ${(msSinceLastBuy/60000).toFixed(1)}m no buys`);
        keysToClose.push({ key, reason: 'kill_no_followthrough' });
        closedTrades.push(trade);
        continue;
      }

      // Kill 2: sell volume > buy volume * N before TP1
      if (liveSnap && !trade.tp1Hit) {
        const sellBuyRatio = liveSnap.buyVolumeXRP > 0
          ? liveSnap.sellVolumeXRP / liveSnap.buyVolumeXRP
          : (liveSnap.sellVolumeXRP > 0 ? Infinity : 0);
        if (sellBuyRatio >= ks.sellVolumeMultiple && liveSnap.sellVolumeXRP > 10) {
          info(`⚡ Kill switch 2 (sell flood) for ${key}: sell/buy ratio ${sellBuyRatio.toFixed(1)}x`);
          keysToClose.push({ key, reason: 'kill_sell_flood' });
          closedTrades.push(trade);
          continue;
        }
      }

      // Kill 3: liquidity dropped > N% since entry
      const currentPool = snapshot.poolXrpReserve ?? (snapshot.liquidityXRP ? snapshot.liquidityXRP / 2 : 0);
      if (
        position.liquidityAtEntry > 0 &&
        currentPool > 0 &&
        ((position.liquidityAtEntry - currentPool) / position.liquidityAtEntry) > (ks.liqDropPct / 100)
      ) {
        info(`⚡ Kill switch 3 (liq drop) for ${key}: ${position.liquidityAtEntry.toFixed(0)} → ${currentPool.toFixed(0)} XRP`);
        keysToClose.push({ key, reason: 'kill_liq_drop' });
        closedTrades.push(trade);
        continue;
      }

      // ── BURST EXIT PROFILE ───────────────────────────────────────────────────
      if (isBurst) {
        // Safety time stop: exit after 45 min ONLY if trade is clearly losing or
        // clearly winning. Flat trades near entry get extra time — fees make
        // closing a +0% trade an immediate loss. Let stop-loss handle the exit.
        if (ageMs >= 45 * 60 * 1000) {
          const isClearWin  = pnlPercent >= 5;   // worth closing for profit
          const isClearLoss = pnlPercent <= -4;  // stop bleeding
          if (isClearWin || isClearLoss) {
            info(`⏱️ Burst safety time stop hit for ${key} (${(ageMs/60000).toFixed(1)}m) PnL: ${pnlPercent.toFixed(1)}%`);
            keysToClose.push({ key, reason: pnlPercent >= 0 ? 'time_stop_profit' : 'time_stop_loss' });
            closedTrades.push(trade);
            continue;
          } else if (ageMs >= 90 * 60 * 1000) {
            // Hard cap: close any burst trade still open after 90 min regardless
            info(`⏱️ Burst hard time cap (90m) for ${key} PnL: ${pnlPercent.toFixed(1)}%`);
            keysToClose.push({ key, reason: pnlPercent >= 0 ? 'time_stop_profit' : 'time_stop_loss' });
            closedTrades.push(trade);
            continue;
          }
        }

        // Stop loss: use profile stopLossPct (was hardcoded -8%, now reads from profile)
        const burstStopPct = -(prof.stopLossPct ?? 12);
        if (pnlPercent <= burstStopPct && trade.remainingPosition > 0) {
          keysToClose.push({ key, reason: 'stop_loss' });
          closedTrades.push(trade);
          continue;
        }

        // Momentum reversal exit:
        // Use live pressure tracker for accurate buy/sell counts (catches AMM swaps)
        const livePressure = this.buyPressureTracker?.getSnapshot(
          snapshot.tokenCurrency, snapshot.tokenIssuer
        );
        const sellCount = livePressure ? livePressure.sellCount : ((snapshot as any)?.sellCount5m ?? 0);
        const buyCount  = livePressure ? livePressure.buyCount  : ((snapshot as any)?.buyCount5m  ?? 1);
        const isMomentumDead = (
          sellCount > buyCount * 3 &&
          sellCount >= 3 &&   // lower threshold since data is now accurate
          pnlPercent > 8
        );
        if (isMomentumDead) {
          info(`🚨 Burst momentum reversal for ${key}: ${buyCount} buys / ${sellCount} sells | PnL: ${pnlPercent.toFixed(1)}%`);
          keysToClose.push({ key, reason: 'sell_pressure_exit' });
          closedTrades.push(trade);
          continue;
        }

        // TP1/TP2: use profile-driven sell percentages, learned price targets override defaults
        const burstProf = PROFILES[position.profileName] ?? PROFILES.BURST_SCALP;
        const burstTp1     = position.tp1Pct ?? burstProf.tp1Pct;
        const burstTp2     = position.tp2Pct ?? burstProf.tp2Pct;
        const burstTp1Sell = burstProf.tp1SellPct;  // % of original to sell at TP1
        const burstTp2Sell = burstProf.tp2SellPct;  // % of original to sell at TP2
        const burstRunner  = burstProf.runnerPct;    // % held for trailing stop only
        const trailActivation = burstProf.trailActivationPct;

        // TP1 — partial exit per profile
        if (!trade.tp1Hit && pnlPercent >= burstTp1 && trade.remainingPosition > 0) {
          this.partialClose(key, currentPrice, burstTp1Sell, `tp1_+${burstTp1}pct`, snapshot);
          trade.tp1Hit = true;
          this.db.updatePaperTrade(trade);
        }

        // TP2 — partial exit per profile, leaves runner (if any)
        if (!trade.tp2Hit && pnlPercent >= burstTp2 && trade.remainingPosition > 0) {
          if (burstRunner > 0) {
            // Sell TP2 chunk, leave runner for trailing stop
            this.partialClose(key, currentPrice, burstTp2Sell, `tp2_+${burstTp2}pct`, snapshot);
            trade.tp2Hit = true;
            this.db.updatePaperTrade(trade);
          } else {
            // No runner — close all remaining
            keysToClose.push({ key, reason: 'take_profit_2' });
            closedTrades.push(trade);
            continue;
          }
        }

        // Sell pressure exit for burst: demand collapsed before TP1, cut loss early
        const burstSells = (snapshot as any)?.sellCount5m ?? 0;
        const burstBuys  = (snapshot as any)?.buyCount5m  ?? 1;
        const burstDemandCollapsed = (
          !trade.tp1Hit &&
          ageMs > 3 * 60 * 1000 &&
          burstSells >= 3 &&
          burstBuys <= 1 &&
          pnlPercent < 0
        );
        if (burstDemandCollapsed) {
          info(`🚨 Burst demand collapse exit for ${key}: ${burstBuys} buys / ${burstSells} sells | PnL: ${pnlPercent.toFixed(1)}%`);
          keysToClose.push({ key, reason: 'sell_pressure_exit' });
          closedTrades.push(trade);
          continue;
        }

        // Runner: trailing stop only (no TP3 trigger unless emergency)
        if (!trade.trailingStopActive && pnlPercent >= trailActivation) {
          trade.trailingStopActive = true;
          this.db.updatePaperTrade(trade);
        }
        if (trade.trailingStopActive && trade.remainingPosition > 0) {
          const trailDist = burstProf.trailDistancePct / 100;
          const trailThreshold = position.highestPriceSinceEntry * (1 - trailDist);
          if (currentPrice <= trailThreshold) {
            info(`🚨 Burst trailing stop hit for ${key} | remaining: ${trade.remainingPosition.toFixed(0)}%`);
            keysToClose.push({ key, reason: pnlPercent >= 0 ? 'trailing_stop_profit' : 'trailing_stop_loss' });
            closedTrades.push(trade);
          }
        }
        continue; // skip scored exit logic below
      }

      // ── SCORED EXIT PROFILE ──────────────────────────────────────────────────
      // Minimum hold time: don't exit within 3 minutes of opening
      const MIN_HOLD_MS = 3 * 60 * 1000;
      if (ageMs < MIN_HOLD_MS) {
        debug(`Hold time not met for ${key}, skipping exit check`);
        continue;
      }

      // Calculate dynamic stop loss based on volatility
      const volatility = this.calculateVolatility(position.priceHistory);
      const dynamicStopLoss = this.getDynamicStopLoss(volatility, pnlPercent);
      // Use tightened stop if set (e.g. concentrated supply detected mid-trade)
      const effectiveStopLoss = position.stopLossPercent !== undefined
        ? -Math.abs(position.stopLossPercent)
        : dynamicStopLoss;

      // Check stop loss (dynamic based on volatility)
      if (pnlPercent <= effectiveStopLoss && trade.remainingPosition > 0) {
        keysToClose.push({ key, reason: 'stop_loss' });
        closedTrades.push(trade);
        continue;
      }

      // Time stop for scored trades: exit after 90 min if no meaningful gain
      if (ageMs >= 90 * 60 * 1000 && pnlPercent < 5 && trade.remainingPosition > 0) {
        keysToClose.push({ key, reason: 'time_stop_loss' });
        closedTrades.push(trade);
        continue;
      }

      // Check Take Profit 1/2 — use profile-driven sell percentages, learned price targets override
      const scoredProf   = PROFILES[position.profileName] ?? PROFILES.MOMENTUM_RUNNER;
      const scoredTp1     = position.tp1Pct ?? scoredProf.tp1Pct;
      const scoredTp2     = position.tp2Pct ?? scoredProf.tp2Pct;
      const scoredTp1Sell = scoredProf.tp1SellPct;
      const scoredTp2Sell = scoredProf.tp2SellPct;
      const scoredRunner  = scoredProf.runnerPct;

      // TP1: profile-driven partial exit
      if (!trade.tp1Hit && pnlPercent >= scoredTp1 && trade.remainingPosition > 0) {
        this.partialClose(key, currentPrice, scoredTp1Sell, 'take_profit_1', snapshot);
        trade.tp1Hit = true;
        this.db.updatePaperTrade(trade);
      }

      // TP2: profile-driven partial exit, leave runner for trailing stop
      if (!trade.tp2Hit && pnlPercent >= scoredTp2 && trade.remainingPosition > 0) {
        if (scoredRunner > 0) {
          // Sell TP2 chunk, leave runner for trailing stop
          this.partialClose(key, currentPrice, scoredTp2Sell, 'take_profit_2', snapshot);
          trade.tp2Hit = true;
          this.db.updatePaperTrade(trade);
        } else {
          // No runner — close all remaining
          keysToClose.push({ key, reason: 'take_profit_2' });
          closedTrades.push(trade);
          continue;
        }
      }

      // Momentum reversal for scored trades:
      // If we're in profit and demand has clearly collapsed, exit before
      // the trailing stop catches it (trailing stop is price-reactive;
      // this is demand-reactive — faster signal)
      const liveScore = this.buyPressureTracker?.getSnapshot(
        snapshot.tokenCurrency, snapshot.tokenIssuer
      );
      const scoredSells = liveScore ? liveScore.sellCount : ((snapshot as any)?.sellCount5m ?? 0);
      const scoredBuys  = liveScore ? liveScore.buyCount  : ((snapshot as any)?.buyCount5m  ?? 1);
      const demandCollapsed = (
        pnlPercent > 10 &&
        scoredSells > scoredBuys * 3 &&
        scoredSells >= 3 &&  // lower since data is now accurate
        trade.tp1Hit
      );
      if (demandCollapsed) {
        info(`🚨 Scored demand collapse exit for ${key}: ${scoredBuys} buys / ${scoredSells} sells | PnL: ${pnlPercent.toFixed(1)}%`);
        keysToClose.push({ key, reason: 'sell_pressure_exit' });
        closedTrades.push(trade);
        continue;
      }

      // Dead volume exit: flat price + zero activity for 30+ min = cut dead weight
      // Guard: skip when called from checkAllOpenExits (orphan checker) which
      // passes a fake snapshot with null liquidityXRP and 0 buys/sells.
      // Raised from 10 min → 30 min: XRPL meme tokens naturally go quiet for
      // 15-25 min between legs. 10 min was closing positions in consolidation.
      const snapshotBuys = liveScore ? liveScore.buyCount : (snapshot.buyCount5m ?? 0);
      const snapshotSells = liveScore ? liveScore.sellCount : (snapshot.sellCount5m ?? 0);
      const isOrphanSnapshot = snapshot.liquidityXRP === null || snapshot.liquidityXRP === undefined;
      const deadVolume = (
        !isOrphanSnapshot &&
        ageMs > 30 * 60 * 1000 &&   // 30 min (was 10 min)
        !trade.tp1Hit &&
        pnlPercent > -5 && pnlPercent < 3 &&  // wider loss band: -5% (was -3%)
        snapshotBuys === 0 &&
        snapshotSells === 0
      );
      if (deadVolume) {
        info(`💀 Dead volume exit for ${key}: flat at ${pnlPercent.toFixed(1)}% with zero activity for 30m`);
        keysToClose.push({ key, reason: 'dead_volume_exit' });
        closedTrades.push(trade);
        continue;
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
          keysToClose.push({ key, reason: pnlPercent >= 0 ? 'trailing_stop_profit' : 'trailing_stop_loss' });
          closedTrades.push(trade);
        }
      }
    }

    // Second pass: properly close positions (sets exit price, PnL, fees) then remove
    // Must happen after the iteration loop to avoid mutating the Map mid-loop
    const finalClosed: PaperTrade[] = [];
    for (const { key, reason } of keysToClose) {
      this.closePosition(key, currentPrice, reason, snapshot);
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

    // force_close_no_price: no real trade occurred — return entry cost, zero fees/slippage
    const isGhostClose = reason === 'force_close_no_price';

    // FIX #25: Estimate slippage based on trade value relative to liquidity
    const tradeValueXRP = tokensToSell * exitPrice;
    const slippage = isGhostClose ? 0 : this.estimateSlippage(tradeValueXRP, snapshot);

    const effectiveExitPrice = exitPrice * (1 - slippage);
    const proceeds = tokensToSell * effectiveExitPrice;
    const fees = isGhostClose ? 0 : proceeds * 0.003;
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
    // xrpReturned accumulates ALL proceeds (partial + final)
    trade.xrpReturned = (trade.xrpReturned || 0) + netProceeds;
    // pnlXRP = total returned - total invested (accurate across all legs)
    trade.pnlXRP = parseFloat((trade.xrpReturned - trade.entryAmountXRP).toFixed(6));
    trade.pnlPercent = parseFloat(((trade.pnlXRP / trade.entryAmountXRP) * 100).toFixed(2));
    trade.feesPaid += fees;
    trade.remainingPosition = 0;

    // Return proceeds to bankroll
    this.bankrollXRP += netProceeds;
    // Ghost closes (force_close_no_price) return the full entry cost — don't count
    // them as real losses against the daily limit. The position never actually traded.
    if (!isGhostClose) {
      this.dailyPnL += pnlXRP;
      this.tradesToday++;
    }

    // Remove from open positions
    this.openPositions.delete(key);
    this.lastCloseTime.set(key, Date.now());
    this.recordProfileStat(position, trade);

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
   * Partially close position.
   *
   * percentOfOriginal: what % of the ORIGINAL (entry) position to sell.
   * e.g. TP1 = 40 means sell 40% of what was bought at entry.
   *      TP2 = 30 means sell another 30%, leaving 30% runner.
   *
   * This keeps accounting correct regardless of how many legs we've done.
   */
  private partialClose(
    key: string,
    exitPrice: number,
    percentOfOriginal: number,   // % of ORIGINAL position (not remaining)
    reason: string,
    snapshot: MarketSnapshot | null
  ): void {
    const position = this.openPositions.get(key);
    if (!position) return;

    const trade = position.trade;

    // Clamp to what's actually remaining
    const actualPct = Math.min(percentOfOriginal, trade.remainingPosition);
    if (actualPct <= 0) return;

    // Tokens to sell = original tokens * fraction of original being sold
    const originalTokens = trade.entryAmountXRP / trade.entryPriceXRP;
    const tokensToSell = originalTokens * (actualPct / 100);

    // Slippage on trade value vs pool XRP reserve
    const tradeValueXRP = tokensToSell * exitPrice;
    const slippage = this.estimateSlippage(tradeValueXRP, snapshot);

    const effectiveExitPrice = exitPrice * (1 - slippage);
    const proceeds = tokensToSell * effectiveExitPrice;
    const fees = proceeds * 0.003;
    const netProceeds = proceeds - fees;

    // Cost basis for the portion being sold = proportional to original entry cost
    const costBasisSold = trade.entryAmountXRP * (actualPct / 100);
    const legPnlXRP = netProceeds - costBasisSold;

    // Update in-memory token tracking
    position.tokensHeld -= tokensToSell;

    // Update trade record
    trade.feesPaid += fees;
    trade.xrpReturned = (trade.xrpReturned || 0) + netProceeds;
    trade.remainingPosition = Math.max(0, trade.remainingPosition - actualPct);
    // Cumulative PnL = total returned - total invested
    trade.pnlXRP = parseFloat((trade.xrpReturned - trade.entryAmountXRP).toFixed(6));
    trade.pnlPercent = parseFloat(((trade.pnlXRP / trade.entryAmountXRP) * 100).toFixed(2));

    // If fully closed, mark as closed
    if (trade.remainingPosition <= 0) {
      trade.exitPriceXRP = exitPrice;
      trade.exitTimestamp = Date.now();
      trade.exitScore = snapshot ? this.getScoreFromSnapshot(snapshot) : null;
      trade.exitReason = reason;
      trade.status = 'closed';
      this.openPositions.delete(key);
      this.lastCloseTime.set(key, Date.now());
      this.recordProfileStat(position, trade);
    } else {
      trade.status = 'partial';
    }

    // Return proceeds to bankroll
    this.bankrollXRP += netProceeds;
    this.dailyPnL += legPnlXRP;
    this.tradesToday++;

    // Save to DB
    this.db.updatePaperTrade(trade);

    info(`📊 Partial close: ${trade.tokenCurrency} | Sold ${actualPct}% of original | PnL leg: ${legPnlXRP.toFixed(4)} XRP | Remaining: ${trade.remainingPosition}%`);
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
    // concentrated_supply is intentionally excluded — we manage it with a
    // tighter stop instead of exiting. Whales can pump before they dump.
    const criticalFlags = ['liquidity_removed', 'dev_dumping'];
    const newCriticalFlags = currentRiskFlags.filter(f =>
      criticalFlags.includes(f) && !trade.entryReason.includes(f)
    );

    if (newCriticalFlags.length > 0) {
      warn(`🚨 Emergency exit triggered for ${key}: ${newCriticalFlags.join(', ')}`);
      const exitPrice = snapshot?.priceXRP || trade.entryPriceXRP * 0.9;
      this.closePosition(key, exitPrice, `emergency_${newCriticalFlags.join(',')}`, snapshot);
      return trade;
    }

    // Concentrated supply detected mid-trade: tighten stop to -8% instead of exiting.
    // This lets us ride the pump while cutting losses fast if the whale dumps.
    const hasConcentrated = currentRiskFlags.includes('concentrated_supply');
    if (hasConcentrated && (position.stopLossPercent === undefined || position.stopLossPercent > 8)) {
      warn(`⚠️ Concentrated supply detected for ${key} — tightening stop to -8%`);
      position.stopLossPercent = 8;
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
  /**
   * AMM slippage using constant-product formula, using poolXrpReserve (XRP side only).
   * slippage = tradeSize / (poolXrpReserve + tradeSize)
   *
   * Uses poolXrpReserve, NOT total TVL, because only the XRP side matters
   * for a token-buy price impact. TVL = poolXRP * 2 overstates depth by 2x.
   * Caps at 10%.
   */
  private estimateSlippage(tradeSizeXRP: number, snapshot: MarketSnapshot | null): number {
    // Prefer explicit poolXrpReserve; fall back to half of TVL (liquidityXRP = TVL = 2*poolXRP)
    const poolXrp = snapshot?.poolXrpReserve
      ?? (snapshot?.liquidityXRP ? snapshot.liquidityXRP / 2 : 0);
    if (poolXrp <= 0) return 0.02; // 2% default if unknown
    const slippage = tradeSizeXRP / (poolXrp + tradeSizeXRP);
    return Math.min(0.10, slippage);
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
      openedAt: trade.entryTimestamp || 0,
      tradeProfile: (trade.entryReason?.startsWith('[BURST]') ? 'burst' : 'scored') as 'burst' | 'scored',
      profileName: (trade.entryReason?.startsWith('[BURST]') ? 'BURST_SCALP' : 'MOMENTUM_RUNNER') as TradeProfileName,
      lastBuySeenAt: trade.entryTimestamp || 0,
      liquidityAtEntry: 0,
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
      const computedBankroll = this.config.startingBankrollXRP + latestSummary.totalPnLXRP;
      // Sanity clamp: if DB has corrupted PnL (e.g. drops stored as XRP),
      // cap bankroll at 100× starting to prevent absurd values
      const MAX_SANE_BANKROLL = this.config.startingBankrollXRP * 100;
      if (computedBankroll > MAX_SANE_BANKROLL || computedBankroll < 0) {
        warn(`Bankroll from DB (${computedBankroll.toFixed(2)} XRP) looks corrupted — resetting to starting bankroll`);
        this.bankrollXRP = this.config.startingBankrollXRP;
      } else {
        this.bankrollXRP = computedBankroll;
      }
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
        entryRiskFlags: [],
        lastRiskCheck: Date.now(),
        priceHistory: [trade.entryPriceXRP],
        // Loaded from DB = already past hold time; set openedAt far in the past
        openedAt: trade.entryTimestamp || 0,
        tradeProfile: (trade.entryReason?.startsWith('[BURST]') ? 'burst' : 'scored') as 'burst' | 'scored',
        profileName: (trade.entryReason?.startsWith('[BURST]') ? 'BURST_SCALP' : 'MOMENTUM_RUNNER') as TradeProfileName,
        lastBuySeenAt: trade.entryTimestamp || 0,
        liquidityAtEntry: 0,
      });
    }

    info(`Loaded ${this.openPositions.size} open positions, bankroll: ${this.bankrollXRP.toFixed(2)} XRP`);
  }

  /**
   * Get current state
   */
  /**
   * Check exits for ALL open positions using a live price fetcher.
   * Called every scan cycle to catch orphaned positions (tokens pruned from scan list).
   */
  async checkAllOpenExits(
    getPrice: (currency: string, issuer: string) => Promise<number | null>
  ): Promise<PaperTrade[]> {
    const allClosed: PaperTrade[] = [];
    const now = Date.now();
    const UNPRICEABLE_TIMEOUT_MS = 30 * 60 * 1000; // force-close after 30 min with no price
    const WARMUP_GRACE_MS = 5 * 60 * 1000; // never force-close within 5 min of opening

    for (const [key, position] of this.openPositions.entries()) {
      const { trade } = position;
      const price = await getPrice(trade.tokenCurrency, trade.tokenIssuer);

      // No price — check if position has been open too long without pricing
      if (!price || price <= 0) {
        const ageMs = now - (position.openedAt || trade.entryTimestamp || 0);
        if (ageMs < WARMUP_GRACE_MS) continue; // give AMM cache time to warm
        if (ageMs > UNPRICEABLE_TIMEOUT_MS) {
          warn(`Force-closing unpriceable position: ${trade.tokenCurrency} (no price for ${(ageMs/60000).toFixed(0)}m)`);
          // Close at entry price (0% PnL) — best we can do with no price data
          this.closePosition(key, trade.entryPriceXRP, 'force_close_no_price', null);
          allClosed.push(trade);
        }
        continue;
      }

      const fakeSnapshot = {
        tokenCurrency: trade.tokenCurrency,
        tokenIssuer: trade.tokenIssuer,
        priceXRP: price,
        liquidityXRP: null,
        buyCount5m: 0,
        sellCount5m: 0,
      } as any;
      const closed = this.checkExits(fakeSnapshot);
      allClosed.push(...closed);
    }
    return allClosed;
  }

  /**
   * Force-close a position by currency name — used to clean up blocklisted tokens
   * that were opened before the blocklist was added.
   */
  forceCloseByToken(currency: string, reason: string): PaperTrade | null {
    for (const [key, position] of this.openPositions.entries()) {
      if (position.trade.tokenCurrency === currency) {
        this.closePosition(key, position.trade.entryPriceXRP, reason, null);
        info(`Force-closed ${currency}: ${reason}`);
        return position.trade;
      }
    }
    return null;
  }

  /**
   * Reset daily P&L tracking at midnight UTC.
   * Prevents a bad day from permanently shrinking conviction sizing.
   */
  resetDailyTracking(): void {
    this.dailyPnL = 0;
    info('[PaperTrader] Daily P&L tracking reset (midnight UTC)');
  }

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
   * Enriched open positions for Telegram hourly update.
   * Includes live P&L estimate, burst flag, and hold time.
   */
  getOpenPositionsSummary(): Array<{
    tokenCurrency: string;
    tokenIssuer: string;
    entryPriceXRP: number;
    entryAmountXRP: number;
    entryTimestamp: number;
    remainingPosition: number;
    tp1Hit: boolean;
    tp2Hit: boolean;
    isBurst: boolean;
    livePnlXRP: number | null;
    livePnlPct: number | null;
  }> {
    return Array.from(this.openPositions.values()).map(pos => {
      const trade = pos.trade;
      // Use highest price seen as proxy for live price (conservative — actual live would need snapshot)
      const livePrice   = pos.highestPriceSinceEntry; // best available without a fresh snapshot
      const currentPnl  = livePrice > 0 && trade.entryPriceXRP > 0
        ? ((livePrice - trade.entryPriceXRP) / trade.entryPriceXRP) * 100
        : null;
      const pnlXRP      = currentPnl != null
        ? (currentPnl / 100) * trade.entryAmountXRP * (trade.remainingPosition / 100)
        : null;

      return {
        tokenCurrency:    trade.tokenCurrency,
        tokenIssuer:      trade.tokenIssuer,
        entryPriceXRP:    trade.entryPriceXRP,
        entryAmountXRP:   trade.entryAmountXRP,
        entryTimestamp:   trade.entryTimestamp,
        remainingPosition:trade.remainingPosition ?? 100,
        tp1Hit:           trade.tp1Hit,
        tp2Hit:           trade.tp2Hit,
        isBurst:          pos.tradeProfile === 'burst',
        livePnlXRP:       pnlXRP != null ? parseFloat(pnlXRP.toFixed(4)) : null,
        livePnlPct:       currentPnl != null ? parseFloat(currentPnl.toFixed(2)) : null,
      };
    });
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
   * Persist trade outcome to profile_stats table for per-profile analytics.
   */
  private recordProfileStat(position: OpenPosition, trade: PaperTrade): void {
    try {
      const holdMs = trade.exitTimestamp
        ? trade.exitTimestamp - trade.entryTimestamp
        : Date.now() - trade.entryTimestamp;
      this.db.saveProfileStat({
        profile: position.profileName,
        closedAt: Date.now(),
        tokenCurrency: trade.tokenCurrency,
        tokenIssuer: trade.tokenIssuer,
        entryXRP: trade.entryAmountXRP,
        exitXRP: trade.xrpReturned ?? 0,
        pnlXRP: trade.pnlXRP ?? 0,
        pnlPct: trade.pnlPercent ?? 0,
        holdMs,
        exitReason: trade.exitReason ?? 'unknown',
        won: (trade.pnlXRP ?? 0) > 0,
      });
    } catch { /* non-critical */ }
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

    // Adjust based on volatility — capped at -10% to maintain positive risk:reward vs TP1 (+10%)
    if (volatility > 0.2) stopLoss = -10; // Very volatile: still cap at -10%
    else if (volatility > 0.1) stopLoss = -8;  // Moderate volatility
    else if (volatility > 0.05) stopLoss = -7; // Low volatility
    else stopLoss = -6; // Very stable: tight stop

    // If already in profit, tighten stop to protect gains
    if (pnlPercent > 20) stopLoss = Math.max(stopLoss, -5);
    if (pnlPercent > 50) stopLoss = Math.max(stopLoss, -3);

    return stopLoss;
  }

  /**
   * Get trailing stop activation threshold based on volatility
   */
  private getTrailingActivationThreshold(volatility: number, pnlPercent: number): number {
    // Activate trailing stop closer to new TP targets (+10/+20%)
    if (volatility > 0.2) return 15;
    if (volatility > 0.1) return 12;
    if (volatility > 0.05) return 10;
    return 8; // Low volatility: activate early
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
