/**
 * Backtesting Engine
 *
 * Replays historical market_snapshots + scores from the SQLite DB
 * and simulates what would have happened if the bot had traded.
 *
 * Usage:
 *   const engine = new BacktestEngine(db);
 *   const result = await engine.run(config);
 */

import { Database } from '../db/database';
import { TokenScore, MarketSnapshot } from '../types';
import { info, warn } from '../utils/logger';

// ─── Configuration ────────────────────────────────────────────────────────────

export interface BacktestConfig {
  startDate: Date;
  endDate: Date;
  minScore: number;
  stopLossPercent: number;   // e.g. 15 = -15%
  takeProfitPercent: number; // e.g. 50 = +50%
  tradeSize: number;         // XRP per trade
  maxOpenTrades: number;
}

// ─── Trade Simulation Types ───────────────────────────────────────────────────

export interface SimulatedTrade {
  tokenCurrency: string;
  tokenIssuer: string;
  entryTimestamp: number;
  exitTimestamp: number;
  entryPriceXRP: number;
  exitPriceXRP: number;
  pnlXRP: number;
  pnlPercent: number;
  exitReason: 'take_profit' | 'stop_loss' | 'timeout';
  entryScore: number;
}

// ─── Result Types ─────────────────────────────────────────────────────────────

export interface ScoreBucketResult {
  bucket: string;
  tradeCount: number;
  winRate: number;
  avgPnLPercent: number;
  totalPnLXRP: number;
}

export interface BacktestResult {
  totalTrades: number;
  winRate: number;             // 0-1
  totalPnLXRP: number;
  avgPnLPercent: number;
  maxDrawdown: number;         // worst peak-to-trough in XRP
  bestTrade: SimulatedTrade | null;
  worstTrade: SimulatedTrade | null;
  scoreAccuracy: number;       // fraction of trades that were winners
  byScoreBucket: ScoreBucketResult[];
  trades: SimulatedTrade[];    // full trade log
}

// ─── Backtesting Engine ───────────────────────────────────────────────────────

export class BacktestEngine {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * Run backtest over the configured date range.
   */
  async run(config: BacktestConfig): Promise<BacktestResult> {
    const startTs = config.startDate.getTime();
    const endTs   = config.endDate.getTime();

    info(`[Backtest] Running from ${config.startDate.toISOString()} to ${config.endDate.toISOString()}`);
    info(`[Backtest] minScore=${config.minScore} SL=${config.stopLossPercent}% TP=${config.takeProfitPercent}% size=${config.tradeSize} XRP`);

    // Load all scores in range, ordered by timestamp
    const scores: TokenScore[] = this.db.getScoresInRange(startTs, endTs);
    info(`[Backtest] Loaded ${scores.length} score records`);

    if (scores.length === 0) {
      warn('[Backtest] No score records found in the specified date range. Has the bot been running long enough?');
      return this.emptyResult();
    }

    const trades: SimulatedTrade[] = [];
    // Track open positions: key = "currency:issuer"
    const openPositions = new Map<string, { entryTs: number; entryPrice: number; score: number }>();

    for (const scoreRecord of scores) {
      if (scoreRecord.totalScore < config.minScore) continue;

      const key = `${scoreRecord.tokenCurrency}:${scoreRecord.tokenIssuer}`;

      // Skip if already in an open position for this token
      if (openPositions.has(key)) continue;

      // Skip if at max open trades
      if (openPositions.size >= config.maxOpenTrades) continue;

      // Find the snapshot closest to this score's timestamp to get entry price
      const entrySnapshot = this.findClosestSnapshot(
        scoreRecord.tokenCurrency,
        scoreRecord.tokenIssuer,
        scoreRecord.timestamp
      );

      if (!entrySnapshot || entrySnapshot.priceXRP === null || entrySnapshot.priceXRP <= 0) {
        continue; // no price data, skip
      }

      const entryPrice = entrySnapshot.priceXRP;
      const entryTs = scoreRecord.timestamp;

      // Mark position open
      openPositions.set(key, { entryTs, entryPrice, score: scoreRecord.totalScore });

      // Look forward to find exit
      const TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24h max hold
      const exitEndTs = Math.min(entryTs + TIMEOUT_MS, endTs);

      const futureSnapshots = this.db.getSnapshotsForToken(
        scoreRecord.tokenCurrency,
        scoreRecord.tokenIssuer,
        entryTs + 1,
        exitEndTs
      );

      let exitPrice = entryPrice;
      let exitTs = exitEndTs;
      let exitReason: 'take_profit' | 'stop_loss' | 'timeout' = 'timeout';

      const slPrice = entryPrice * (1 - config.stopLossPercent / 100);
      const tpPrice = entryPrice * (1 + config.takeProfitPercent / 100);

      for (const snap of futureSnapshots) {
        if (snap.priceXRP === null || snap.priceXRP <= 0) continue;

        const price = snap.priceXRP;

        if (price >= tpPrice) {
          exitPrice  = tpPrice; // assume we exit at exactly TP
          exitTs     = snap.timestamp;
          exitReason = 'take_profit';
          break;
        }

        if (price <= slPrice) {
          exitPrice  = slPrice; // assume we exit at exactly SL
          exitTs     = snap.timestamp;
          exitReason = 'stop_loss';
          break;
        }
      }

      // If timeout, use last known price in range (or entry if none)
      if (exitReason === 'timeout' && futureSnapshots.length > 0) {
        const lastSnap = futureSnapshots[futureSnapshots.length - 1];
        if (lastSnap.priceXRP !== null && lastSnap.priceXRP > 0) {
          exitPrice = lastSnap.priceXRP;
          exitTs    = lastSnap.timestamp;
        }
      }

      const pnlPercent = ((exitPrice - entryPrice) / entryPrice) * 100;
      const pnlXRP     = (config.tradeSize * pnlPercent) / 100;

      trades.push({
        tokenCurrency: scoreRecord.tokenCurrency,
        tokenIssuer:   scoreRecord.tokenIssuer,
        entryTimestamp: entryTs,
        exitTimestamp:  exitTs,
        entryPriceXRP:  entryPrice,
        exitPriceXRP:   exitPrice,
        pnlXRP,
        pnlPercent,
        exitReason,
        entryScore: scoreRecord.totalScore,
      });

      openPositions.delete(key);
    }

    info(`[Backtest] Simulated ${trades.length} trades`);
    return this.buildResult(trades, config);
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────────

  private findClosestSnapshot(
    currency: string,
    issuer: string,
    timestamp: number
  ): MarketSnapshot | null {
    // Look in a ±5 minute window around the score timestamp
    const WINDOW = 5 * 60 * 1000;
    const snaps = this.db.getSnapshotsForToken(currency, issuer, timestamp - WINDOW, timestamp + WINDOW);
    if (snaps.length === 0) return null;

    // Return the one closest in time
    return snaps.reduce((best, s) => {
      return Math.abs(s.timestamp - timestamp) < Math.abs(best.timestamp - timestamp) ? s : best;
    });
  }

  private buildResult(trades: SimulatedTrade[], _config: BacktestConfig): BacktestResult {
    if (trades.length === 0) return this.emptyResult();

    const winners = trades.filter(t => t.pnlPercent > 0);
    const winRate  = winners.length / trades.length;

    const totalPnLXRP  = trades.reduce((s, t) => s + t.pnlXRP, 0);
    const avgPnLPercent = trades.reduce((s, t) => s + t.pnlPercent, 0) / trades.length;

    // Max drawdown: peak-to-trough in cumulative XRP PnL
    let peak = 0;
    let cumPnL = 0;
    let maxDrawdown = 0;
    for (const t of trades) {
      cumPnL += t.pnlXRP;
      if (cumPnL > peak) peak = cumPnL;
      const dd = peak - cumPnL;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }

    const sortedByPnL = [...trades].sort((a, b) => b.pnlPercent - a.pnlPercent);
    const bestTrade  = sortedByPnL[0] ?? null;
    const worstTrade = sortedByPnL[sortedByPnL.length - 1] ?? null;

    // Score buckets: 60-65, 65-70, 70-75, 75-80, 80+
    const buckets = [
      { label: '60-65', min: 60, max: 65 },
      { label: '65-70', min: 65, max: 70 },
      { label: '70-75', min: 70, max: 75 },
      { label: '75-80', min: 75, max: 80 },
      { label: '80+',   min: 80, max: Infinity },
    ];

    const byScoreBucket: ScoreBucketResult[] = buckets.map(b => {
      const bucketTrades = trades.filter(
        t => t.entryScore >= b.min && t.entryScore < b.max
      );
      if (bucketTrades.length === 0) {
        return { bucket: b.label, tradeCount: 0, winRate: 0, avgPnLPercent: 0, totalPnLXRP: 0 };
      }
      const bWinners = bucketTrades.filter(t => t.pnlPercent > 0).length;
      return {
        bucket: b.label,
        tradeCount: bucketTrades.length,
        winRate: bWinners / bucketTrades.length,
        avgPnLPercent: bucketTrades.reduce((s, t) => s + t.pnlPercent, 0) / bucketTrades.length,
        totalPnLXRP: bucketTrades.reduce((s, t) => s + t.pnlXRP, 0),
      };
    });

    return {
      totalTrades: trades.length,
      winRate,
      totalPnLXRP,
      avgPnLPercent,
      maxDrawdown,
      bestTrade,
      worstTrade,
      scoreAccuracy: winRate,
      byScoreBucket,
      trades,
    };
  }

  private emptyResult(): BacktestResult {
    return {
      totalTrades: 0,
      winRate: 0,
      totalPnLXRP: 0,
      avgPnLPercent: 0,
      maxDrawdown: 0,
      bestTrade: null,
      worstTrade: null,
      scoreAccuracy: 0,
      byScoreBucket: [],
      trades: [],
    };
  }
}
