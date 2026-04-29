/**
 * Multi-Timeframe Scorer
 * Calculates separate scores for 5m, 15m, and 1h trends
 */

import { MarketSnapshot, TokenScore } from '../types';
import { BotConfig } from '../config';

export interface TimeframeScores {
  score5m: number;   // Short-term momentum
  score15m: number;  // Medium-term trend
  score1h: number;   // Longer-term trend
  consensus: number; // Weighted average
  trend: 'bullish' | 'bearish' | 'neutral';
}

export class MultiTimeframeScorer {
  private config: BotConfig;

  constructor(config: BotConfig) {
    this.config = config;
  }

  /**
   * Calculate multi-timeframe scores from price changes
   */
  calculate(snapshot: MarketSnapshot | null, baseScore: number): TimeframeScores {
    if (!snapshot) {
      return {
        score5m: baseScore,
        score15m: baseScore,
        score1h: baseScore,
        consensus: baseScore,
        trend: 'neutral',
      };
    }

    // Adjust base score based on price momentum at each timeframe
    const score5m = this.adjustForMomentum(baseScore, snapshot.priceChange5m, 0.3);
    const score15m = this.adjustForMomentum(baseScore, snapshot.priceChange15m, 0.2);
    const score1h = this.adjustForMomentum(baseScore, snapshot.priceChange1h, 0.1);

    // Weighted consensus: 50% base, 20% 5m, 15% 15m, 15% 1h
    const consensus = Math.round(
      baseScore * 0.5 +
      score5m * 0.2 +
      score15m * 0.15 +
      score1h * 0.15
    );

    // Determine trend
    const trend = this.determineTrend(snapshot.priceChange5m, snapshot.priceChange15m, snapshot.priceChange1h);

    return {
      score5m: Math.round(score5m),
      score15m: Math.round(score15m),
      score1h: Math.round(score1h),
      consensus: Math.max(0, Math.min(100, consensus)),
      trend,
    };
  }

  /**
   * Adjust score based on price momentum
   * @param baseScore - Original score
   * @param priceChange - Price change percentage
   * @param sensitivity - How much to adjust (0-1)
   */
  private adjustForMomentum(baseScore: number, priceChange: number | null, sensitivity: number): number {
    if (priceChange === null) return baseScore;

    // Positive momentum boosts score, negative reduces it
    let adjustment = 0;

    if (priceChange > 50) adjustment = 20;
    else if (priceChange > 20) adjustment = 15;
    else if (priceChange > 10) adjustment = 10;
    else if (priceChange > 5) adjustment = 5;
    else if (priceChange > 0) adjustment = 2;
    else if (priceChange > -5) adjustment = -2;
    else if (priceChange > -10) adjustment = -5;
    else if (priceChange > -20) adjustment = -10;
    else adjustment = -15;

    // Apply sensitivity
    adjustment *= sensitivity;

    return Math.max(0, Math.min(100, baseScore + adjustment));
  }

  /**
   * Determine overall trend from multiple timeframes
   */
  private determineTrend(
    change5m: number | null,
    change15m: number | null,
    change1h: number | null
  ): 'bullish' | 'bearish' | 'neutral' {
    const changes = [change5m, change15m, change1h].filter(c => c !== null) as number[];
    if (changes.length === 0) return 'neutral';

    const positiveCount = changes.filter(c => c > 0).length;
    const negativeCount = changes.filter(c => c < 0).length;

    if (positiveCount >= 2) return 'bullish';
    if (negativeCount >= 2) return 'bearish';
    return 'neutral';
  }

  /**
   * Check if timeframes agree (all bullish or all bearish)
   */
  hasConsensus(scores: TimeframeScores): boolean {
    if (scores.trend === 'neutral') return false;

    // All timeframes should point in same direction
    const allBullish = scores.score5m > 60 && scores.score15m > 55 && scores.score1h > 50;
    const allBearish = scores.score5m < 40 && scores.score15m < 45 && scores.score1h < 50;

    return allBullish || allBearish;
  }
}
