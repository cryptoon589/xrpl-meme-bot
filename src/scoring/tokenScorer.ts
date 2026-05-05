/**
 * Token Scorer — Profit-First Redesign
 *
 * Single objective: is this token moving RIGHT NOW in a way we can profit from?
 *
 * Old approach scored token quality (age, liquidity size, dev safety).
 * That predicted "good token" not "profitable trade".
 *
 * New approach scores the MOMENT:
 *   - Is price accelerating (not just moving)?
 *   - Are fresh wallets piling in (organic demand)?
 *   - Is buy pressure intense and building?
 *   - Is volume surging vs recent baseline?
 *   - Can we exit cleanly (min liquidity gate, not a score bonus)?
 *
 * Token age, holder count, liquidity size = NOT scoring factors.
 * They are GATES (min liquidity to enter, risk flags to block).
 * If a token passes the gate and the moment is right — score it high.
 *
 * Weights (self-learning overrides these after 20+ trades):
 *   Momentum / price acceleration   35%
 *   Buy pressure (intensity)        30%
 *   New wallet inflow               20%
 *   Volume surge                    15%
 */

import * as fs from 'fs';
import * as path from 'path';
import { TrackedToken, AMMPool, MarketSnapshot, RiskFlags, TokenScore } from '../types';
import { BotConfig } from '../config';
import { debug, info } from '../utils/logger';
import { WhaleTracker } from './whaleTracker';
import { SocialDetector } from './socialDetector';
import { ScoreWeights } from '../analysis/tradeAnalyzer';

const RECOMMENDATIONS_PATH = path.join(process.cwd(), 'state', 'recommendations.json');

const DEFAULT_WEIGHTS: ScoreWeights = {
  buyPressureScore:  30,
  holderGrowthScore: 20,   // new wallet inflow
  volumeAccelScore:  35,   // momentum / price acceleration
  liquidityScore:    15,   // volume surge (repurposed)
  devSafetyScore:     0,   // hard gate only, not a score component
  spreadScore:        0,   // unused
};

export class TokenScorer {
  private config: BotConfig;
  private whaleTracker: WhaleTracker | null = null;
  private socialDetector: SocialDetector | null = null;
  private learnedWeights: ScoreWeights = { ...DEFAULT_WEIGHTS };
  private weightsLoadedAt = 0;
  private readonly WEIGHTS_RELOAD_MS = 15 * 60 * 1000;

  constructor(config: BotConfig) {
    this.config = config;
    this.loadLearnedWeights();
  }

  loadLearnedWeights(): void {
    try {
      if (!fs.existsSync(RECOMMENDATIONS_PATH)) return;
      const raw = fs.readFileSync(RECOMMENDATIONS_PATH, 'utf8');
      const recs = JSON.parse(raw);
      if (!recs?.scoreWeights) return;
      const w: ScoreWeights = recs.scoreWeights;
      const vals = Object.values(w) as number[];
      if (vals.length < 4 || vals.some(v => typeof v !== 'number' || v < 0 || v > 100)) return;
      this.learnedWeights = w;
      this.weightsLoadedAt = Date.now();
      info(`[TokenScorer] Learned weights loaded (${recs.tradesAnalyzed} trades, ${recs.overallWinRate}% WR)`);
      info(`[TokenScorer] momentum=${w.volumeAccelScore} buyPressure=${w.buyPressureScore} newWallets=${w.holderGrowthScore} volSurge=${w.liquidityScore}`);
    } catch (err) {
      debug(`[TokenScorer] Could not load learned weights: ${err}`);
    }
  }

  setWhaleTracker(tracker: WhaleTracker): void { this.whaleTracker = tracker; }
  setSocialDetector(detector: SocialDetector): void { this.socialDetector = detector; }

  /**
   * Score this token's current trading opportunity (0–100).
   * Higher = better entry right now for a clean profit trade.
   */
  score(
    token: TrackedToken,
    snapshot: MarketSnapshot | null,
    pool: AMMPool | null,
    riskFlags: RiskFlags,
    whaleScore = 0,
    socialScore = 0
  ): TokenScore {

    // Hot-reload learned weights every 15 min
    if (Date.now() - this.weightsLoadedAt > this.WEIGHTS_RELOAD_MS) {
      this.loadLearnedWeights();
    }

    // ── Core signal scores ───────────────────────────────────────────
    const momentumScore    = this.scoreMomentum(snapshot);
    const buyPressureScore = this.scoreBuyPressure(snapshot);
    const newWalletScore   = this.scoreNewWalletInflow(snapshot);
    const volSurgeScore    = this.scoreVolumeSurge(snapshot);

    // ── Normalise learned weights ────────────────────────────────────
    const w = this.learnedWeights;
    const wTotal = w.volumeAccelScore + w.buyPressureScore + w.holderGrowthScore + w.liquidityScore;
    const norm = (v: number) => wTotal > 0 ? v / wTotal : 0.25;

    const wMom  = norm(w.volumeAccelScore);
    const wBuy  = norm(w.buyPressureScore);
    const wNew  = norm(w.holderGrowthScore);
    const wVol  = norm(w.liquidityScore);

    // ── Base score: pure price movement opportunity ──────────────────
    const hasLiveData = buyPressureScore !== 50 || snapshot?.buyCount5m;

    let baseScore: number;
    if (hasLiveData) {
      baseScore =
        momentumScore    * wMom +
        buyPressureScore * wBuy +
        newWalletScore   * wNew +
        volSurgeScore    * wVol;
    } else {
      // No live stream data yet — momentum only, conservative
      baseScore = momentumScore * 0.7 + volSurgeScore * 0.3;
    }

    // ── Boosts (additive, small) ─────────────────────────────────────
    // Whale presence: smart money entering = mild confidence boost
    const whaleBoost = Math.min(8, Math.max(0, whaleScore) * 0.08);

    // Liquidity exit safety: penalise if pool is too shallow to exit cleanly
    // NOT a reward for big pools — just a penalty for tiny ones
    const exitSafety = this.scoreExitSafety(snapshot);

    const totalScore = baseScore + whaleBoost + exitSafety;
    const clamped = Math.max(0, Math.min(100, totalScore));

    debug(`[Score] ${token.currency}: momentum=${momentumScore.toFixed(0)} buyPressure=${buyPressureScore.toFixed(0)} newWallets=${newWalletScore.toFixed(0)} volSurge=${volSurgeScore.toFixed(0)} whale=${whaleBoost.toFixed(1)} exit=${exitSafety.toFixed(1)} → ${clamped.toFixed(0)}`);

    return {
      tokenCurrency:    token.currency,
      tokenIssuer:      token.issuer,
      timestamp:        Date.now(),
      totalScore:       Math.round(clamped),
      liquidityScore:   Math.round(volSurgeScore),
      holderGrowthScore:Math.round(newWalletScore),
      buyPressureScore: Math.round(buyPressureScore),
      volumeAccelScore: Math.round(momentumScore),
      devSafetyScore:   100, // not scored — hard gate handled by riskFilter
      whitelistBoost:   0,
      spreadScore:      0,
    };
  }

  // ──────────────────────────────────────────────────────────────────
  // MOMENTUM: price acceleration across timeframes
  //
  // Key insight: we want ACCELERATION, not just positive price.
  // A token up 2% in 5m that was up 0% in 15m is accelerating.
  // A token up 2% in 5m that was up 30% in 1h is decelerating (late).
  // ──────────────────────────────────────────────────────────────────
  private scoreMomentum(snapshot: MarketSnapshot | null): number {
    if (!snapshot) return 0;

    const c5  = snapshot.priceChange5m;
    const c15 = snapshot.priceChange15m;
    const c1h = snapshot.priceChange1h;

    if (c5 === null && c15 === null && c1h === null) return 0;

    let score = 50;

    // 5m move: primary signal (most recent)
    if (c5 !== null) {
      if      (c5 > 100) score += 50;  // parabolic — very strong
      else if (c5 > 50)  score += 40;
      else if (c5 > 20)  score += 30;
      else if (c5 > 10)  score += 20;
      else if (c5 > 5)   score += 12;
      else if (c5 > 2)   score += 6;
      else if (c5 > 0)   score += 2;
      else if (c5 > -3)  score -= 5;
      else if (c5 > -10) score -= 15;
      else               score -= 30;
    }

    // Acceleration check: is the move speeding up?
    // 5m > 15m/3 means the recent rate is faster than the older rate
    if (c5 !== null && c15 !== null && c15 !== 0) {
      const recentRate = c5;
      const olderRate  = c15 / 3; // normalise to per-5m equivalent
      if (recentRate > olderRate * 1.5 && c5 > 0) score += 15; // accelerating
      if (recentRate < olderRate * 0.3 && c15 > 10) score -= 10; // decelerating (late)
    }

    // 1h context: are we early or late in the move?
    if (c1h !== null && c5 !== null) {
      if (c1h > 100 && c5 > 5)  score -= 8;  // already ran hard, c5 still going — risky
      if (c1h < 5   && c5 > 10) score += 10; // fresh breakout from flat base — ideal
      if (c1h < 0   && c5 > 5)  score += 8;  // reversal bounce
    }

    return Math.max(0, Math.min(100, score));
  }

  // ──────────────────────────────────────────────────────────────────
  // BUY PRESSURE: intensity of buying RIGHT NOW
  // ──────────────────────────────────────────────────────────────────
  private scoreBuyPressure(snapshot: MarketSnapshot | null): number {
    if (!snapshot) return 50;

    const buys  = snapshot.buyCount5m  || 0;
    const sells = snapshot.sellCount5m || 0;
    const total = buys + sells;
    if (total === 0) return 50;

    const buyVol  = snapshot.buyVolume5m  || 0;
    const sellVol = snapshot.sellVolume5m || 0;
    const totalVol = buyVol + sellVol;

    // Count ratio (50%)
    const countScore = (buys / total) * 100;

    // Volume ratio (30%)
    const volScore = totalVol > 0 ? (buyVol / totalVol) * 100 : 50;

    // Unique buyer breadth (20%) — organic vs single wallet pumping
    const unique = snapshot.uniqueBuyers5m || 0;
    const breadthScore = Math.min(100, unique * 10); // 10+ unique buyers = max score

    // Intensity bonus: raw buy count matters (more transactions = stronger move)
    const intensityBonus = Math.min(20, buys * 2); // 2pts per buy, max 20

    return Math.min(100, countScore * 0.5 + volScore * 0.3 + breadthScore * 0.2 + intensityBonus);
  }

  // ──────────────────────────────────────────────────────────────────
  // NEW WALLET INFLOW: fresh capital entering (not churning)
  // ──────────────────────────────────────────────────────────────────
  private scoreNewWalletInflow(snapshot: MarketSnapshot | null): number {
    if (!snapshot) return 50;

    const unique = snapshot.uniqueBuyers5m || 0;
    if (unique === 0) return 50;

    const newBuys = (snapshot as any).newWalletBuys    || 0;
    const newPct  = (snapshot as any).newWalletPercent || 0;

    // No new wallet data available yet
    if (newBuys === 0 && newPct === 0) {
      // Fall back to unique buyer count as proxy
      return Math.min(100, 40 + unique * 6); // 10 unique buyers = ~100
    }

    // New wallet % (0–100) + count bonus
    const pctScore   = newPct; // already 0–100
    const countBonus = Math.min(30, newBuys * 8); // 8pts per new wallet, max 30

    return Math.min(100, pctScore * 0.7 + countBonus);
  }

  // ──────────────────────────────────────────────────────────────────
  // VOLUME SURGE: is volume spiking vs what's normal for this token?
  // We don't have historical volume baseline yet, so use buy count
  // as a proxy — high absolute buy count = unusually active
  // ──────────────────────────────────────────────────────────────────
  private scoreVolumeSurge(snapshot: MarketSnapshot | null): number {
    if (!snapshot) return 0;

    const buyVol = snapshot.buyVolume5m || 0;
    const buys   = snapshot.buyCount5m  || 0;

    // Volume in XRP over 5 min — tiered scoring
    let volScore = 0;
    if      (buyVol > 50000) volScore = 100;
    else if (buyVol > 10000) volScore = 85;
    else if (buyVol > 5000)  volScore = 70;
    else if (buyVol > 1000)  volScore = 55;
    else if (buyVol > 500)   volScore = 40;
    else if (buyVol > 100)   volScore = 25;
    else if (buyVol > 0)     volScore = 10;

    // Transaction velocity (buys per 5 min)
    let txScore = 0;
    if      (buys > 50) txScore = 100;
    else if (buys > 20) txScore = 80;
    else if (buys > 10) txScore = 60;
    else if (buys > 5)  txScore = 40;
    else if (buys > 2)  txScore = 20;
    else if (buys > 0)  txScore = 10;

    return Math.min(100, volScore * 0.6 + txScore * 0.4);
  }

  // ──────────────────────────────────────────────────────────────────
  // EXIT SAFETY: can we get out without destroying the price?
  // Returns 0 (no penalty) if liquidity is fine.
  // Returns negative if pool is dangerously shallow.
  // NOT a reward — just a penalty gate for very thin pools.
  // ──────────────────────────────────────────────────────────────────
  private scoreExitSafety(snapshot: MarketSnapshot | null): number {
    if (!snapshot || snapshot.liquidityXRP === null) return 0;
    const liq = snapshot.liquidityXRP;
    const minLiq = this.config.minLiquidityXRP;

    // Below minimum: already filtered by riskFilter, but penalise here too
    if (liq < minLiq)      return -20;
    if (liq < minLiq * 2)  return -10; // borderline: slight penalty
    if (liq < minLiq * 5)  return  -3; // fine but a bit thin
    // Comfortable or deep: no penalty or bonus (we don't reward being FUZZY-size)
    return 0;
  }
}
