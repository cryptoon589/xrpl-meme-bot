/**
 * Live Trading Validator
 *
 * Compares intended paper trade price vs what actually fills in dry-run mode.
 * Tracks slippage statistics to determine when the bot is ready for live trading.
 *
 * Workflow:
 *   1. When paper trade opens and TRADING_WALLET_SEED is set:
 *      → liveValidator.recordIntended(currency, issuer, price, size)
 *   2. When the trade executor reports an actual fill:
 *      → liveValidator.recordActualFill(currency, issuer, actualPrice)
 *   3. Call getSlippageStats() to check if live trading is safe.
 */

import { Database } from '../db/database';
import { info, debug } from '../utils/logger';

export interface SlippageStats {
  avgSlippagePct: number;
  maxSlippagePct: number;
  samplesCount: number;
  recommendation: 'ready_for_live' | 'too_much_slippage' | 'insufficient_data';
}

interface PendingRecord {
  intendedPrice: number;
  sizeXrp: number;
  timestamp: number;
}

// Thresholds for live-trading recommendation
const MIN_SAMPLES        = 10;      // need at least 10 fills before recommending live
const MAX_AVG_SLIPPAGE   = 2.0;     // avg slippage must be < 2% to go live
const MAX_MAX_SLIPPAGE   = 5.0;     // no single fill can exceed 5% slippage

export class LiveValidator {
  private db: Database;
  // In-memory pending records: "currency:issuer" -> latest intended price
  private pending: Map<string, PendingRecord> = new Map();

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * Record an intended trade price before execution.
   * Call this when a paper trade is opened (or an actual trade is about to execute).
   */
  recordIntended(
    currency: string,
    issuer: string,
    intendedPriceXRP: number,
    sizeXRP: number
  ): void {
    const key = `${currency}:${issuer}`;
    this.pending.set(key, {
      intendedPrice: intendedPriceXRP,
      sizeXrp: sizeXRP,
      timestamp: Date.now(),
    });

    // Persist to DB immediately (actual_price left NULL until fill)
    this.db.saveIntendedPrice(currency, issuer, intendedPriceXRP, sizeXRP);
    debug(`[LiveValidator] Intended price recorded: ${currency}:${issuer} @ ${intendedPriceXRP.toFixed(8)} XRP (${sizeXRP} XRP)`);
  }

  /**
   * Record the actual fill price after execution.
   * Matches against the most recent pending record for this token.
   */
  recordActualFill(
    currency: string,
    issuer: string,
    actualPriceXRP: number
  ): void {
    const key = `${currency}:${issuer}`;
    const pending = this.pending.get(key);

    if (pending) {
      const slippagePct = Math.abs((actualPriceXRP - pending.intendedPrice) / pending.intendedPrice) * 100;
      info(`[LiveValidator] Fill recorded: ${currency}:${issuer} intended=${pending.intendedPrice.toFixed(8)} actual=${actualPriceXRP.toFixed(8)} slippage=${slippagePct.toFixed(3)}%`);
      this.pending.delete(key);
    }

    // Update DB
    this.db.updateActualFill(currency, issuer, actualPriceXRP);
  }

  /**
   * Calculate aggregate slippage statistics from all recorded fills.
   * Returns a recommendation for whether live trading is advisable.
   */
  getSlippageStats(): SlippageStats {
    const records = this.db.getExecutionValidationRecords();

    // Only consider filled records (both intended and actual price set)
    const filled = records.filter(r => r.actualPrice !== null && r.slippagePct !== null);

    if (filled.length < MIN_SAMPLES) {
      return {
        avgSlippagePct: 0,
        maxSlippagePct: 0,
        samplesCount: filled.length,
        recommendation: 'insufficient_data',
      };
    }

    const slippages = filled.map(r => r.slippagePct as number);
    const avgSlippagePct = slippages.reduce((s, v) => s + v, 0) / slippages.length;
    const maxSlippagePct = Math.max(...slippages);

    let recommendation: SlippageStats['recommendation'];
    if (avgSlippagePct <= MAX_AVG_SLIPPAGE && maxSlippagePct <= MAX_MAX_SLIPPAGE) {
      recommendation = 'ready_for_live';
    } else {
      recommendation = 'too_much_slippage';
    }

    return {
      avgSlippagePct,
      maxSlippagePct,
      samplesCount: filled.length,
      recommendation,
    };
  }

  /**
   * Persist in-memory pending records to DB (call on shutdown).
   * Pending records without fills will remain as NULL actual_price.
   */
  save(_db: Database): void {
    // All intended prices are already persisted to DB on recordIntended().
    // This method is kept for API symmetry with WhaleTracker.
    debug(`[LiveValidator] Save called — ${this.pending.size} pending records awaiting fill`);
  }

  getPendingCount(): number {
    return this.pending.size;
  }
}
