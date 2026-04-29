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
   * Calculate comprehensive score for a token
   */
  score(
    token: TrackedToken,
    snapshot: MarketSnapshot | null,
    pool: AMMPool | null,
    riskFlags: RiskFlags
  ): TokenScore {
    const w = this.config.weights;

    // Calculate individual component scores (each 0-100)
    const liquidityScore = this.scoreLiquidity(snapshot);
    const holderGrowthScore = this.scoreHolderGrowth(snapshot);
    const buyPressureScore = this.scoreBuyPressure(snapshot);
    const volumeAccelScore = this.scoreVolumeAcceleration(snapshot);
    const devSafetyScore = this.scoreDevSafety(riskFlags);
    const whitelistBoost = this.getWhitelistBoost(token); // Manual boost, default 0
    const spreadScore = this.scoreSpread(snapshot);

    // Weighted total
    const totalScore =
      (liquidityScore * w.liquidity +
        holderGrowthScore * w.holderGrowth +
        buyPressureScore * w.buyPressure +
        volumeAccelScore * w.volumeAccel +
        devSafetyScore * w.devSafety +
        whitelistBoost * w.whitelistBoost +
        spreadScore * w.spread) /
      100;

    // Clamp to 0-100
    const clampedScore = Math.max(0, Math.min(100, totalScore));

    return {
      tokenCurrency: token.currency,
      tokenIssuer: token.issuer,
      timestamp: Date.now(),
      totalScore: Math.round(clampedScore),
      liquidityScore: Math.round(liquidityScore),
      holderGrowthScore: Math.round(holderGrowthScore),
      buyPressureScore: Math.round(buyPressureScore),
      volumeAccelScore: Math.round(volumeAccelScore),
      devSafetyScore: Math.round(devSafetyScore),
      whitelistBoost: Math.round(whitelistBoost),
      spreadScore: Math.round(spreadScore),
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

  /**
   * Score holder growth (0-100)
   * TODO: Real implementation would track holder count over time
   */
  private scoreHolderGrowth(snapshot: MarketSnapshot | null): number {
    if (!snapshot || snapshot.holderEstimate === null) {
      return 30; // Neutral score when unknown
    }

    const holders = snapshot.holderEstimate;

    // Scale: 0 at 0 holders, 100 at 1000+ holders
    if (holders <= 0) return 0;
    if (holders >= 1000) return 100;

    // Logarithmic scale for early growth
    return Math.min(100, Math.log2(holders + 1) * 10);
  }

  /**
   * Score buy pressure (0-100)
   * Based on buy/sell ratio, volume, and unique participants
   */
  private scoreBuyPressure(snapshot: MarketSnapshot | null): number {
    if (!snapshot) return 0;

    const totalTransactions = snapshot.buyCount5m + snapshot.sellCount5m;
    if (totalTransactions === 0) return 0;

    // Buy ratio component (40% of score)
    const buyRatio = snapshot.buyCount5m / totalTransactions;
    const ratioScore = buyRatio * 100;

    // Volume component (30% of score)
    const totalVolume = snapshot.buyVolume5m + snapshot.sellVolume5m;
    const volumeScore = Math.min(100, (totalVolume / 100) * 100);

    // Unique buyers component (30% of score) - more unique buyers = healthier
    const totalUnique = (snapshot.uniqueBuyers5m || 0) + (snapshot.uniqueSellers5m || 0);
    const uniqueBuyerRatio = totalUnique > 0 ? (snapshot.uniqueBuyers5m || 0) / totalUnique : 0.5;
    const uniqueScore = uniqueBuyerRatio * 100;

    return (ratioScore * 0.4 + volumeScore * 0.3 + uniqueScore * 0.3);
  }

  /**
   * Score volume acceleration (0-100)
   * TODO: Real implementation would compare current vs historical volume
   */
  private scoreVolumeAcceleration(snapshot: MarketSnapshot | null): number {
    if (!snapshot) return 0;

    // For MVP, use price change as proxy for momentum
    const change1h = snapshot.priceChange1h;
    if (change1h === null) return 50; // Neutral

    // Positive price change suggests increasing demand
    if (change1h > 50) return 100;
    if (change1h > 20) return 80;
    if (change1h > 10) return 60;
    if (change1h > 0) return 40;
    if (change1h > -10) return 20;
    return 0;
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

  /**
   * Get manual whitelist boost (0-100)
   * TODO: Implement whitelist system for verified projects
   */
  private getWhitelistBoost(token: TrackedToken): number {
    // For MVP, no whitelist boost
    return 0;
  }

  /**
   * Score spread quality (0-100)
   * Tighter spread = higher score
   */
  private scoreSpread(snapshot: MarketSnapshot | null): number {
    if (!snapshot || snapshot.spreadPercent === null) return 0;

    const spread = snapshot.spreadPercent;

    // 0% spread = 100 score, 10%+ spread = 0 score
    if (spread <= 0) return 100;
    if (spread >= 10) return 0;

    return ((10 - spread) / 10) * 100;
  }
}
