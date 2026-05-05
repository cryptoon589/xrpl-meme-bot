/**
 * Token Scoring Module
 * Scores tokens from 0-100 based on multiple factors
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

// Default hardcoded weights — overridden by learned weights once enough trades exist
const DEFAULT_WEIGHTS: ScoreWeights = {
  buyPressureScore:  28,
  holderGrowthScore: 19,
  volumeAccelScore:  19,
  liquidityScore:    11,
  devSafetyScore:    10,
  spreadScore:        5,  // maps to tokenAge in scorer
};

export class TokenScorer {
  private config: BotConfig;
  private whaleTracker: WhaleTracker | null = null;
  private socialDetector: SocialDetector | null = null;
  private learnedWeights: ScoreWeights = { ...DEFAULT_WEIGHTS };
  private weightsLoadedAt = 0;
  private readonly WEIGHTS_RELOAD_MS = 15 * 60 * 1000; // re-check file every 15 min

  constructor(config: BotConfig) {
    this.config = config;
    this.loadLearnedWeights();
  }

  /**
   * Load learned score weights from the TradeAnalyzer recommendations file.
   * Falls back to hardcoded defaults if file doesn’t exist or isn’t ready.
   */
  loadLearnedWeights(): void {
    try {
      if (!fs.existsSync(RECOMMENDATIONS_PATH)) return;
      const raw = fs.readFileSync(RECOMMENDATIONS_PATH, 'utf8');
      const recs = JSON.parse(raw);
      if (!recs?.scoreWeights) return;
      const w: ScoreWeights = recs.scoreWeights;
      // Only apply if all fields are present and plausible
      const vals = Object.values(w) as number[];
      if (vals.length < 5 || vals.some(v => typeof v !== 'number' || v < 0 || v > 100)) return;
      this.learnedWeights = w;
      this.weightsLoadedAt = Date.now();
      info(`[TokenScorer] Loaded learned weights from ${recs.tradesAnalyzed} trades (win rate: ${recs.overallWinRate}%)`);
      info(`[TokenScorer] Weights: buyPressure=${w.buyPressureScore} holderGrowth=${w.holderGrowthScore} momentum=${w.volumeAccelScore} liquidity=${w.liquidityScore} devSafety=${w.devSafetyScore}`);
    } catch (err) {
      debug(`[TokenScorer] Could not load learned weights: ${err}`);
    }
  }

  /**
   * Attach optional whale tracker for score boosts from whale wallet activity.
   */
  setWhaleTracker(tracker: WhaleTracker): void {
    this.whaleTracker = tracker;
  }

  /**
   * Attach optional social detector for on-chain social signal scoring.
   */
  setSocialDetector(detector: SocialDetector): void {
    this.socialDetector = detector;
  }

  /**
   * Score a token for meme trading profit potential.
   *
   * Weights are tuned for catching pumps early:
   *   - Buy pressure (28%): ratio of buys to sells in last 5 min
   *   - New wallet inflow (19%): fresh wallets buying = strongest pump signal
   *   - Momentum (19%): price direction across timeframes
   *   - Liquidity (10%): enough depth to enter/exit without massive slippage
   *   - Dev safety (9%): no rug flags
   *   - Whale boost (5%): smart-money wallets present
   *   - Social signals (8%): on-chain domain/email/age/market-makers
   */
  score(
    token: TrackedToken,
    snapshot: MarketSnapshot | null,
    pool: AMMPool | null,
    riskFlags: RiskFlags,
    whaleScore = 0,
    socialScore = 0
  ): TokenScore {
    const buyPressureScore  = this.scoreBuyPressure(snapshot);
    const newWalletScore    = this.scoreNewWallets(snapshot);
    const momentumScore     = this.scoreMomentum(snapshot);
    const liquidityScore    = this.scoreLiquidity(snapshot);
    const devSafetyScore    = this.scoreDevSafety(riskFlags);
    const tokenAgeScore     = this.scoreTokenAge(token, snapshot);

    // Clamp external scores to 0-100 range
    const clampedWhale  = Math.max(0, Math.min(100, whaleScore));
    const clampedSocial = Math.max(0, Math.min(100, socialScore));

    // Hot-reload learned weights every 15 min so the scorer picks up
    // new TradeAnalyzer recommendations without a restart.
    if (Date.now() - this.weightsLoadedAt > this.WEIGHTS_RELOAD_MS) {
      this.loadLearnedWeights();
    }

    // Normalise learned weights to fractions that sum to ~1.0
    // The analyzer outputs raw importance values (e.g. 28, 19, 11...).
    // We reserve 0.10 for whale + social, leaving 0.90 for the core 6 components.
    const w = this.learnedWeights;
    const wTotal = w.buyPressureScore + w.holderGrowthScore + w.volumeAccelScore +
                   w.liquidityScore + w.devSafetyScore + w.spreadScore;
    const norm = (v: number) => wTotal > 0 ? (v / wTotal) * 0.90 : 0.15;

    const wBuy  = norm(w.buyPressureScore);
    const wNew  = norm(w.holderGrowthScore);
    const wMom  = norm(w.volumeAccelScore);
    const wLiq  = norm(w.liquidityScore);
    const wDev  = norm(w.devSafetyScore);
    const wAge  = norm(w.spreadScore); // spreadScore slot reused for tokenAge

    // Adaptive weighting: if buy pressure has live data, weight it heavily.
    // If no live data yet (window empty), shift weight to momentum + liquidity
    // so tokens aren't permanently zeroed waiting for tracker data.
    const hasBuyData = buyPressureScore > 0;
    const hasNewWalletData = (snapshot as any)?.uniqueBuyers5m > 0;

    let totalScore: number;
    if (hasBuyData || hasNewWalletData) {
      // Full live-data mode — use learned weights
      totalScore =
        buyPressureScore  * wBuy +
        newWalletScore    * wNew +
        momentumScore     * wMom +
        liquidityScore    * wLiq +
        devSafetyScore    * wDev +
        tokenAgeScore     * wAge +
        clampedWhale      * 0.05 +
        clampedSocial     * 0.05 * (clampedSocial / 100);
    } else {
      // No live pressure data yet — shift weight to momentum + liquidity + age
      totalScore =
        momentumScore     * (wMom  + wBuy * 0.5) +
        liquidityScore    * (wLiq  + wNew * 0.5) +
        devSafetyScore    * wDev +
        tokenAgeScore     * (wAge  + 0.05) +
        clampedSocial     * 0.05;
    }

    const clampedScore = Math.max(0, Math.min(100, totalScore));

    return {
      tokenCurrency: token.currency,
      tokenIssuer: token.issuer,
      timestamp: Date.now(),
      totalScore: Math.round(clampedScore),
      liquidityScore: Math.round(liquidityScore),
      holderGrowthScore: Math.round(newWalletScore),
      buyPressureScore: Math.round(buyPressureScore),
      volumeAccelScore: Math.round(momentumScore),
      devSafetyScore: Math.round(devSafetyScore),
      whitelistBoost: 0,
      spreadScore: 0,
    };
  }

  /**
   * Score token age (0-100) — newer tokens get a bonus.
   * A 1-hour-old token with buy activity is much more significant.
   */
  private scoreTokenAge(token: TrackedToken, snapshot?: MarketSnapshot | null): number {
    const ageMs = Date.now() - (token.firstSeen || Date.now());
    const ageHours = ageMs / (1000 * 60 * 60);

    // Base age score — peak for new tokens, decays over time
    let base: number;
    if (ageHours < 1)  base = 100;
    else if (ageHours < 3)  base = 85;
    else if (ageHours < 6)  base = 70;
    else if (ageHours < 12) base = 55;
    else if (ageHours < 24) base = 40;
    else if (ageHours < 48) base = 25;
    else base = 10;

    // Momentum rescue: if a token is older but has real price movement,
    // don't let age drag it below 30. A 7-day-old token genuinely pumping
    // shouldn't score 10 on age and lose 28% of its total score.
    const c5m  = snapshot?.priceChange5m  ?? 0;
    const c1h  = snapshot?.priceChange1h  ?? 0;
    const isMoving = Math.abs(c5m) > 5 || Math.abs(c1h) > 10;
    if (isMoving && base < 30) return 30;

    return base;
  }

  /**
   * Score liquidity depth (0-100)
   * Higher liquidity = higher score
   */
  private scoreLiquidity(snapshot: MarketSnapshot | null): number {
    if (!snapshot || snapshot.liquidityXRP === null) return 0;

    const liquidity = snapshot.liquidityXRP;
    const minLiq = this.config.minLiquidityXRP;
    if (liquidity <= minLiq) return 0;

    // Tiered log scale: differentiates across the full 2k–10M+ XRP range
    // log(2k)=7.6  log(10k)=9.2  log(100k)=11.5  log(1M)=13.8  log(10M)=16.1
    const logMin = Math.log(minLiq);
    const logMax = Math.log(10_000_000); // 10M XRP = score 100
    const score  = (Math.log(liquidity) - logMin) / (logMax - logMin) * 100;
    return Math.max(0, Math.min(100, score));
  }

  // (merged into scoreNewWallets)

  /**
   * Score buy pressure (0-100)
   * Combines buy/sell ratio + volume dominance.
   * Returns 50 (neutral) when no live data yet — tokens should not be
   * permanently zeroed just because no trades happened since bot start.
   */
  private scoreBuyPressure(snapshot: MarketSnapshot | null): number {
    if (!snapshot) return 50; // no snapshot = neutral

    const totalTx = (snapshot.buyCount5m || 0) + (snapshot.sellCount5m || 0);
    if (totalTx === 0) return 50; // no live data yet = neutral, not zero

    // Buy count ratio (60%)
    const buyRatio = (snapshot.buyCount5m || 0) / totalTx;
    const ratioScore = buyRatio * 100;

    // Buy volume dominance (40%)
    const totalVol = (snapshot.buyVolume5m || 0) + (snapshot.sellVolume5m || 0);
    const volRatio = totalVol > 0 ? (snapshot.buyVolume5m || 0) / totalVol : 0.5;
    const volScore = volRatio * 100;

    // Bonus: breadth of unique buyers (signals organic activity, not wash)
    const uniqueBuyers = snapshot.uniqueBuyers5m || 0;
    const uniqueBonus = Math.min(20, uniqueBuyers * 2); // +2 pts per unique buyer, max +20

    return Math.min(100, ratioScore * 0.6 + volScore * 0.4 + uniqueBonus);
  }

  /**
   * Score new wallet inflow (0-100) — strongest pump predictor
   * Fresh wallets buying = new capital entering, not just churning
   */
  private scoreNewWallets(snapshot: MarketSnapshot | null): number {
    if (!snapshot) return 50; // no data = neutral, not penalty

    const newWalletBuys = (snapshot as any).newWalletBuys || 0;
    const newWalletPct  = (snapshot as any).newWalletPercent || 0;
    const uniqueBuyers  = snapshot.uniqueBuyers5m || 0;

    if (uniqueBuyers === 0) return 50; // no live data yet = neutral

    // Base: new wallet percentage (0-100)
    const pctScore = newWalletPct; // already 0-100

    // Multiplier: more new wallets = stronger signal
    const countBonus = Math.min(30, newWalletBuys * 5); // +5 per new wallet, max 30

    return Math.min(100, pctScore * 0.7 + countBonus);
  }

  /**
   * Score momentum across timeframes (0-100)
   * Rewards consistent upward movement across 5m, 15m, 1h
   */
  private scoreMomentum(snapshot: MarketSnapshot | null): number {
    if (!snapshot) return 0;

    const c5  = snapshot.priceChange5m;
    const c15 = snapshot.priceChange15m;
    const c1h = snapshot.priceChange1h;

    let score = 50; // neutral baseline
    let count = 0;

    const addChange = (change: number | null, weight: number) => {
      if (change === null) return;
      count++;
      if (change > 50)  score += 30 * weight;
      else if (change > 20) score += 20 * weight;
      else if (change > 10) score += 15 * weight;
      else if (change > 5)  score += 10 * weight;
      else if (change > 0)  score += 5 * weight;
      else if (change > -5) score -= 5 * weight;
      else if (change > -15)score -= 15 * weight;
      else score -= 25 * weight;
    };

    addChange(c5,  1.0);  // 5m most important
    addChange(c15, 0.6);  // 15m secondary
    addChange(c1h, 0.4);  // 1h context

    if (count === 0) return 0; // no price history = unknown, not neutral
    return Math.max(0, Math.min(100, score));
  }

  /**
   * Score dev/issuer safety (0-100)
   * Lower risk flags = higher score
   */
  private scoreDevSafety(riskFlags: RiskFlags): number {
    let score = 100;

    // Deduct for each risk flag
    if (riskFlags.devDumping) score -= 50;
    if (riskFlags.concentratedSupply) score -= 30;
    if (riskFlags.liquidityRemoved) score -= 40;
    if (riskFlags.singleWalletPrice) score -= 25;

    return Math.max(0, score);
  }


}
