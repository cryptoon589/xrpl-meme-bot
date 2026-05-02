/**
 * Token Scoring Module
 * Scores tokens from 0-100 based on multiple factors
 */

import { TrackedToken, AMMPool, MarketSnapshot, RiskFlags, TokenScore } from '../types';
import { BotConfig } from '../config';
import { debug } from '../utils/logger';

export class TokenScorer {
  private config: BotConfig;

  constructor(config: BotConfig) {
    this.config = config;
  }

  /**
   * Score a token for meme trading profit potential.
   *
   * Weights are tuned for catching pumps early:
   *   - Buy pressure (35%): ratio of buys to sells in last 5 min
   *   - New wallet inflow (25%): fresh wallets buying = strongest pump signal
   *   - Momentum (20%): price direction across timeframes
   *   - Liquidity (10%): enough depth to enter/exit without massive slippage
   *   - Dev safety (10%): no rug flags
   */
  score(
    token: TrackedToken,
    snapshot: MarketSnapshot | null,
    pool: AMMPool | null,
    riskFlags: RiskFlags
  ): TokenScore {
    const buyPressureScore  = this.scoreBuyPressure(snapshot);   // 35%
    const newWalletScore    = this.scoreNewWallets(snapshot);     // 25%
    const momentumScore     = this.scoreMomentum(snapshot);       // 20%
    const liquidityScore    = this.scoreLiquidity(snapshot);      // 10%
    const devSafetyScore    = this.scoreDevSafety(riskFlags);     // 10%

    const totalScore =
      buyPressureScore  * 0.35 +
      newWalletScore    * 0.25 +
      momentumScore     * 0.20 +
      liquidityScore    * 0.10 +
      devSafetyScore    * 0.10;

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
    if (!snapshot) return 0;

    const newWalletBuys = (snapshot as any).newWalletBuys || 0;
    const newWalletPct  = (snapshot as any).newWalletPercent || 0;
    const uniqueBuyers  = snapshot.uniqueBuyers5m || 0;

    if (uniqueBuyers === 0) return 0;

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

    if (count === 0) return 50;
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
