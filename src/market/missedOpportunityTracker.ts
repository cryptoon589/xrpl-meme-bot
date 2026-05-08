/**
 * Missed Opportunity Tracker
 *
 * Stores skipped signals with their reason, then tracks the token's
 * max price at 10m / 30m / 60m intervals to quantify what was missed.
 *
 * Findings are logged and persisted in DB (missed_opportunities table).
 * Used by TradeAnalyzer to surface high-value rejects for parameter tuning.
 */

import { Database } from '../db/database';
import { AMMPriceFetcher } from './ammPriceFetcher';
import { info, debug } from '../utils/logger';

export interface MissedSignal {
  id?: number;
  currency: string;
  issuer: string;
  rawCurrency?: string;
  skippedAt: number;
  skipReason: string;
  priceAtSkip: number;
  poolXrpReserve: number;
  /** Populated by the follow-up checker */
  maxPrice10m?: number;
  maxPrice30m?: number;
  maxPrice60m?: number;
  pctGain10m?: number;
  pctGain30m?: number;
  pctGain60m?: number;
}

export class MissedOpportunityTracker {
  private db: Database;
  private priceFetcher: AMMPriceFetcher;
  /** In-memory queue awaiting price follow-up */
  private pending: MissedSignal[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(db: Database, priceFetcher: AMMPriceFetcher) {
    this.db = db;
    this.priceFetcher = priceFetcher;
    this.db.ensureMissedOpportunitiesTable();
    this.startFollowUpTimer();
  }

  /** Record a skipped signal */
  record(signal: Omit<MissedSignal, 'id'>): void {
    this.pending.push({ ...signal });
    debug(`[MissedOpp] Skipped ${signal.currency}: ${signal.skipReason} @ ${signal.priceAtSkip}`);
  }

  /** Check all pending signals for price follow-up every 5 minutes */
  private startFollowUpTimer(): void {
    this.timer = setInterval(() => this.runFollowUp(), 5 * 60 * 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async runFollowUp(): Promise<void> {
    const now = Date.now();
    const done: MissedSignal[] = [];

    for (const sig of this.pending) {
      const age = now - sig.skippedAt;

      // Fetch current price
      const price = await this.priceFetcher.getPrice(sig.currency, sig.issuer, sig.rawCurrency);
      const currentPrice = price?.priceXRP ?? 0;

      if (currentPrice > 0) {
        if (age >= 10 * 60 * 1000 && !sig.maxPrice10m) {
          sig.maxPrice10m = currentPrice;
          sig.pctGain10m = ((currentPrice - sig.priceAtSkip) / sig.priceAtSkip) * 100;
        }
        if (age >= 30 * 60 * 1000 && !sig.maxPrice30m) {
          sig.maxPrice30m = currentPrice;
          sig.pctGain30m = ((currentPrice - sig.priceAtSkip) / sig.priceAtSkip) * 100;
        }
        if (age >= 60 * 60 * 1000 && !sig.maxPrice60m) {
          sig.maxPrice60m = currentPrice;
          sig.pctGain60m = ((currentPrice - sig.priceAtSkip) / sig.priceAtSkip) * 100;

          // 60m data complete — persist and remove from pending
          this.db.saveMissedOpportunity(sig);
          if ((sig.pctGain60m ?? 0) > 20) {
            info(`[MissedOpp] 🔍 ${sig.currency} would have gained ${sig.pctGain60m?.toFixed(1)}% (skipped: ${sig.skipReason})`);
          }
          done.push(sig);
        }
      }
    }

    // Remove completed signals
    this.pending = this.pending.filter(s => !done.includes(s));

    // Prune signals older than 90 min that never got a price
    this.pending = this.pending.filter(s => now - s.skippedAt < 90 * 60 * 1000);
  }
}
