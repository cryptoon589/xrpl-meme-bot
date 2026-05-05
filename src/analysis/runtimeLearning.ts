/**
 * RuntimeLearning — live bridge between TradeAnalyzer output and the scan loop.
 *
 * Reads recommendations.json every 15 min and exposes:
 *   1. isGoodTradingHour() — time-of-day gate
 *   2. getPullbackThreshold() — entry timing gate
 *   3. getTpTargets() — learned TP levels per profile
 *
 * Defaults are conservative (trade any hour, no pullback wait, standard TPs)
 * so the bot works from day 1 without trade history.
 */

import * as fs from 'fs';
import * as path from 'path';
import { debug, info } from '../utils/logger';
import { TradeRecommendations } from './tradeAnalyzer';

const RECOMMENDATIONS_PATH = path.join(process.cwd(), 'state', 'recommendations.json');
const RELOAD_MS = 15 * 60 * 1000;

export class RuntimeLearning {
  private recs: TradeRecommendations | null = null;
  private loadedAt = 0;

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      if (!fs.existsSync(RECOMMENDATIONS_PATH)) return;
      const raw = fs.readFileSync(RECOMMENDATIONS_PATH, 'utf8');
      this.recs = JSON.parse(raw) as TradeRecommendations;
      this.loadedAt = Date.now();
      info(`[RuntimeLearning] Loaded recs: ${this.recs.tradesAnalyzed} trades, ` +
           `winRate=${this.recs.overallWinRate}%, ` +
           `pullback=${this.recs.entryPullbackPct}%, ` +
           `pauseEnabled=${this.recs.tradingPauseEnabled}`);
    } catch (err) {
      debug(`[RuntimeLearning] Could not load recommendations: ${err}`);
    }
  }

  private maybeReload(): void {
    if (Date.now() - this.loadedAt > RELOAD_MS) this.load();
  }

  /**
   * #3 Time-of-day gate.
   * Returns false during UTC hours identified as consistently losing.
   * Only active once tradingPauseEnabled = true (requires 40+ trades).
   */
  isGoodTradingHour(): boolean {
    this.maybeReload();
    if (!this.recs?.tradingPauseEnabled) return true; // not enough data yet
    const hour = new Date().getUTCHours();
    const isWorstHour = this.recs.worstHours.includes(hour);
    if (isWorstHour) {
      debug(`[RuntimeLearning] Hour ${hour}:00 UTC is a losing hour — skipping entry`);
    }
    return !isWorstHour;
  }

  /**
   * #1 Entry timing: pullback threshold.
   * Returns the % dip to wait for after burst signal (0 = enter immediately).
   */
  getPullbackThreshold(): number {
    this.maybeReload();
    return this.recs?.entryPullbackPct ?? 0;
  }

  /**
   * #1 Entry timing: confirmation bars.
   * Number of scan cycles to wait after pullback before entering.
   */
  getConfirmBars(): number {
    this.maybeReload();
    return this.recs?.entryConfirmBars ?? 0;
  }

  /**
   * #2 Exit sizing: TP targets learned from actual run lengths.
   * Returns { tp1, tp2 } for the given trade profile.
   * Falls back to hardcoded defaults if no data yet.
   */
  getTpTargets(profile: 'burst' | 'scored'): { tp1: number; tp2: number } {
    this.maybeReload();
    if (!this.recs) {
      return profile === 'burst' ? { tp1: 15, tp2: 30 } : { tp1: 35, tp2: 75 };
    }
    if (profile === 'burst') {
      return {
        tp1: this.recs.burstTp1Percent  || 15,
        tp2: this.recs.burstTp2Percent  || 30,
      };
    }
    return {
      tp1: this.recs.scoredTp1Percent || 35,
      tp2: this.recs.scoredTp2Percent || 75,
    };
  }

  /** Force reload (called after TradeAnalyzer writes new recommendations). */
  reload(): void {
    this.load();
  }

  getRecommendations(): TradeRecommendations | null {
    this.maybeReload();
    return this.recs;
  }
}
