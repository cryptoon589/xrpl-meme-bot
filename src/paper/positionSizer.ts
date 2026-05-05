/**
 * Dynamic Position Sizer
 * Uses Kelly Criterion and volatility-based sizing for optimal risk-adjusted returns
 */

import { PaperTrade } from '../types';

export interface PositionSizeRecommendation {
  sizeXRP: number;
  method: 'kelly' | 'volatility' | 'fixed';
  kellyFraction: number;
  riskPercent: number;
  reasoning: string;
}

export class PositionSizer {
  private readonly MAX_POSITION_PERCENT = 10; // Max 10% of bankroll per trade (was 5%)
  private readonly MIN_POSITION_XRP = 1;
  private readonly KELLY_DIVISOR = 2; // Half-Kelly for safety

  /**
   * Conviction multiplier: scales position size based on how strong the
   * entry signal is RIGHT NOW. High score + many unique buyers = big size.
   * Low score scraping the threshold + 2 buyers = small size.
   *
   * Returns a multiplier 0.5–2.0 applied on top of Kelly.
   */
  getConvictionMultiplier(score: number, uniqueBuyers: number, buyRatio: number): number {
    // Score band: 80–90+ maps to 0.7–1.3
    const scoreMult = score >= 90 ? 1.3
      : score >= 85 ? 1.1
      : score >= 80 ? 0.9
      : 0.7; // borderline entry

    // Unique buyers: more distinct wallets = more organic, more confident
    const buyerMult = uniqueBuyers >= 10 ? 1.5
      : uniqueBuyers >= 6  ? 1.2
      : uniqueBuyers >= 3  ? 1.0
      : 0.7; // 1-2 buyers = low conviction

    // Buy ratio (0–1): 80%+ buys = strong demand
    const ratioBand = buyRatio >= 0.8 ? 1.1
      : buyRatio >= 0.65 ? 1.0
      : buyRatio >= 0.5  ? 0.85
      : 0.6; // sell-dominated = skip or tiny size

    const raw = scoreMult * buyerMult * ratioBand;
    // Clamp to 0.5–2.0 so we never go nuts in either direction
    return Math.max(0.5, Math.min(2.0, raw));
  }

  /**
   * Calculate optimal position size using Kelly Criterion
   */
  calculatePositionSize(
    bankrollXRP: number,
    winRate: number,      // 0-1
    avgWinXRP: number,
    avgLossXRP: number,
    volatility: number,
    score: number,
    uniqueBuyers: number = 0,  // live unique buyer count
    buyRatio: number     = 0.5 // live buy/(buy+sell) ratio
  ): PositionSizeRecommendation {
    // Guard against invalid inputs
    if (winRate <= 0 || winRate >= 1) {
      return this.fallbackSize(bankrollXRP, score, 'Invalid win rate');
    }
    if (avgLossXRP <= 0) {
      return this.fallbackSize(bankrollXRP, score, 'Invalid avg loss');
    }

    // Kelly Criterion: f* = (bp - q) / b
    // b = odds (avgWin / avgLoss)
    // p = win probability
    // q = 1 - p (loss probability)
    const b = avgWinXRP / avgLossXRP;
    const p = winRate;
    const q = 1 - p;

    const kellyFraction = (b * p - q) / b;

    // Use half-Kelly for safety
    const safeKelly = Math.max(0, kellyFraction / this.KELLY_DIVISOR);

    // Adjust based on volatility (high vol = smaller position)
    const volAdjustment = this.getVolatilityAdjustment(volatility);

    // Conviction multiplier: combines score + live buyer data + buy ratio
    const conviction = this.getConvictionMultiplier(score, uniqueBuyers, buyRatio);

    // Final position size
    let positionPercent = safeKelly * volAdjustment * conviction * 100;

    // Cap at maximum
    positionPercent = Math.min(positionPercent, this.MAX_POSITION_PERCENT);

    const sizeXRP = Math.max(
      this.MIN_POSITION_XRP,
      bankrollXRP * (positionPercent / 100)
    );

    return {
      sizeXRP: parseFloat(sizeXRP.toFixed(2)),
      method: 'kelly',
      kellyFraction: parseFloat(kellyFraction.toFixed(4)),
      riskPercent: parseFloat(positionPercent.toFixed(2)),
      reasoning: `Kelly=${(kellyFraction * 100).toFixed(1)}%, Vol=${volAdjustment.toFixed(2)}, Conviction=${conviction.toFixed(2)} (score=${score}, buyers=${uniqueBuyers}, buyRatio=${buyRatio.toFixed(2)})`,
    };
  }

  /**
   * Calculate position size based on volatility alone (fallback)
   */
  calculateVolatilityBasedSize(
    bankrollXRP: number,
    volatility: number,
    score: number
  ): PositionSizeRecommendation {
    const basePercent = 3; // Base 3% of bankroll
    const volAdjustment = this.getVolatilityAdjustment(volatility);
    const scoreAdjustment = score / 100;

    let positionPercent = basePercent * volAdjustment * scoreAdjustment;
    positionPercent = Math.min(positionPercent, this.MAX_POSITION_PERCENT);

    const sizeXRP = Math.max(
      this.MIN_POSITION_XRP,
      bankrollXRP * (positionPercent / 100)
    );

    return {
      sizeXRP: parseFloat(sizeXRP.toFixed(2)),
      method: 'volatility',
      kellyFraction: 0,
      riskPercent: parseFloat(positionPercent.toFixed(2)),
      reasoning: `Base 3%, Vol adj=${volAdjustment.toFixed(2)}, Score adj=${scoreAdjustment.toFixed(2)}`,
    };
  }

  /**
   * Get volatility adjustment factor
   * High volatility = smaller positions
   */
  private getVolatilityAdjustment(volatility: number): number {
    if (volatility > 0.3) return 0.5;  // Very high vol: 50% of base
    if (volatility > 0.2) return 0.7;  // High vol: 70%
    if (volatility > 0.1) return 0.85; // Moderate vol: 85%
    if (volatility > 0.05) return 1.0; // Low vol: 100%
    return 1.2;                         // Very stable: 120% (but capped by MAX)
  }

  /**
   * Fallback position size when data is insufficient
   */
  private fallbackSize(bankrollXRP: number, score: number, reason: string): PositionSizeRecommendation {
    // Conservative default: 2% of bankroll
    const basePercent = 2;
    const scoreAdjustment = score / 100;
    let positionPercent = basePercent * scoreAdjustment;
    positionPercent = Math.min(positionPercent, this.MAX_POSITION_PERCENT);

    const sizeXRP = Math.max(
      this.MIN_POSITION_XRP,
      bankrollXRP * (positionPercent / 100)
    );

    return {
      sizeXRP: parseFloat(sizeXRP.toFixed(2)),
      method: 'fixed',
      kellyFraction: 0,
      riskPercent: parseFloat(positionPercent.toFixed(2)),
      reasoning: `Fallback (${reason}): ${basePercent}% base * score adj`,
    };
  }
}
