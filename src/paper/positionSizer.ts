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
  private readonly MAX_POSITION_PERCENT = 5; // Max 5% of bankroll per trade
  private readonly MIN_POSITION_XRP = 1; // Minimum 1 XRP
  private readonly KELLY_DIVISOR = 2; // Use half-Kelly for safety

  /**
   * Calculate optimal position size using Kelly Criterion
   */
  calculatePositionSize(
    bankrollXRP: number,
    winRate: number,      // 0-1 (e.g., 0.6 = 60%)
    avgWinXRP: number,    // Average winning trade PnL
    avgLossXRP: number,   // Average losing trade PnL (positive number)
    volatility: number,   // Price volatility (0-1)
    score: number         // Token score (0-100)
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

    // Adjust based on token score (high score = larger position)
    const scoreAdjustment = score / 100;

    // Final position size
    let positionPercent = safeKelly * volAdjustment * scoreAdjustment * 100;

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
      reasoning: `Kelly=${(kellyFraction * 100).toFixed(1)}%, Vol adj=${volAdjustment.toFixed(2)}, Score adj=${scoreAdjustment.toFixed(2)}`,
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
