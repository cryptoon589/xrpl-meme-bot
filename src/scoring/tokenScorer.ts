/**
 * Token Scoring Module
 * Scores tokens from 0-100 based on multiple factors
 */

import { TrackedToken, AMMPool, MarketSnapshot, RiskFlags, TokenScore } from '../types';
import { BotConfig } from '../config';
import { debug } from '../utils/logger';
import { WhaleTracker } from './whaleTracker';
import { SocialDetector } from './socialDetector';

export class TokenScorer {
  private config: BotConfig;
  private whaleTracker: WhaleTracker | null = null;
  private socialDetector: SocialDetector | null = null;

  constructor(config: BotConfig) {
    this.config = config;
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
    const tokenAgeScore     = this.scoreTokenAge(token);

    // Clamp external scores to 0-100 range
    const clampedWhale  = Math.max(0, Math.min(100, whaleScore));
    const clampedSocial = Math.max(0, Math.min(100, socialScore));

    // Adaptive weighting: if buy pressure has live data, weight it heavily.
    // If no live data yet (window empty), shift weight to momentum + liquidity
    // so tokens aren't permanently zeroed waiting for tracker data.
    const hasBuyData = buyPressureScore > 0;
    const hasNewWalletData = (snapshot as any)?.uniqueBuyers5m > 0;

    let totalScore: number;
    if (hasBuyData || hasNewWalletData) {
      // Full live-data mode — weights reduced slightly to accommodate whale + social
      totalScore =
        buyPressureScore  * 0.28 +
        newWalletScore    * 0.19 +
        momentumScore     * 0.19 +
        liquidityScore    * 0.11 +
        devSafetyScore    * 0.10 +
        tokenAgeScore     * 0.05 +
        clampedWhale      * 0.05 +
        clampedSocial     * 0.08 * (clampedSocial / 100); // social weighted by own confidence
    } else {
      // No live pressure data yet — weight on momentum + liquidity + age
      totalScore =
        momentumScore     * 0.33 +
        liquidityScore    * 0.28 +
        devSafetyScore    * 0.14 +
        tokenAgeScore     * 0.10 +
        newWalletScore    * 0.10 +
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
  private scoreTokenAge(token: TrackedToken): number {
    const ageMs = Date.now() - (token.firstSeen || Date.now());
    const ageHours = ageMs / (1000 * 60 * 60);
    // Peak bonus for tokens under 6 hours old, decays over 48h
    if (ageHours < 1)  return 100;
    if (ageHours < 3)  return 85;
    if (ageHours < 6)  return 70;
    if (ageHours < 12) return 55;
    if (ageHours < 24) return 40;
    if (ageHours < 48) return 25;
    return 10;
  }

  /**
   * Score liquidity depth (0-100)
   * Higher liquidity = higher score
   */
  private scoreLiquidity(snapshot: MarketSnapshot | null): number {
    if (!snapshot || snapshot.liquidityXRP === null) return 0;

    const liquidity = snapshot.liquidityXRP;

    // Scale: 0 at min threshold, 100 at 50000 XRP
    const minLiq = this.config.minLiquidityXRP;
    const maxLiq = 50000;

    if (liquidity <= minLiq) return 0;
    if (liquidity >= maxLiq) return 100;

    return ((liquidity - minLiq) / (maxLiq - minLiq)) * 100;
  }

  // (merged into scoreNewWallets)

  /**
   * Score buy pressure (0-100)
   * Combines buy/sell ratio + volume dominance
   */
  private scoreBuyPressure(snapshot: MarketSnapshot | null): number {
    if (!snapshot) return 0;

    const totalTx = (snapshot.buyCount5m || 0) + (snapshot.sellCount5m || 0);
    if (totalTx === 0) return 0;

    // Buy count ratio (60%)
    const buyRatio = (snapshot.buyCount5m || 0) / totalTx;
    const ratioScore = buyRatio * 100;

    // Buy volume dominance (40%)
    const totalVol = (snapshot.buyVolume5m || 0) + (snapshot.sellVolume5m || 0);
    const volRatio = totalVol > 0 ? (snapshot.buyVolume5m || 0) / totalVol : 0.5;
    const volScore = volRatio * 100;

    // Bonus: if many unique buyers (signals breadth, not wash)
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
