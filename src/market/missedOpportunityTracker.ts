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

/** Decode a hex XRPL currency code to its ASCII ticker, or return as-is */
function decodeCurrency(currency: string): string {
  if (currency.length !== 40) return currency;
  try {
    const stripped = currency.replace(/00+$/, '');
    const decoded = Buffer.from(stripped, 'hex').toString('ascii').replace(/\x00/g, '').trim();
    return /^[\x20-\x7E]+$/.test(decoded) && decoded.length > 0 ? decoded : currency;
  } catch { return currency; }
}

export class MissedOpportunityTracker {
  private db: Database;
  private priceFetcher: AMMPriceFetcher;
  /** In-memory queue awaiting price follow-up */
  private pending: MissedSignal[] = [];
  private timer: NodeJS.Timeout | null = null;
  /**
   * Cooldown map: key = "currency:issuer:skipReason", value = timestamp of last record.
   * Prevents the same rejection reason from spamming the table on every scan cycle.
   */
  private cooldowns: Map<string, number> = new Map();
  private readonly COOLDOWN_MS = 5 * 60 * 1000; // 5 min per token+reason combo

  constructor(db: Database, priceFetcher: AMMPriceFetcher) {
    this.db = db;
    this.priceFetcher = priceFetcher;
    this.db.ensureMissedOpportunitiesTable();
    this.startFollowUpTimer();
  }

  /** Record a skipped signal — persists immediately so the table is never empty */
  record(signal: Omit<MissedSignal, 'id'>): void {
    // Cooldown: don't log the same token+reason more than once per 5 minutes
    const cooldownKey = `${signal.currency}:${signal.issuer}:${signal.skipReason}`;
    const lastSeen = this.cooldowns.get(cooldownKey) ?? 0;
    if (Date.now() - lastSeen < this.COOLDOWN_MS) {
      debug(`[MissedOpp] Cooldown active for ${decodeCurrency(signal.currency)} (${signal.skipReason})`);
      return;
    }
    this.cooldowns.set(cooldownKey, Date.now());

    // Decode hex currency for readability
    const sig: MissedSignal = {
      ...signal,
      currency: decodeCurrency(signal.currency),
      rawCurrency: signal.rawCurrency ?? (signal.currency.length === 40 ? signal.currency : undefined),
    };
    this.pending.push(sig);
    // Write immediately with null gain fields; follow-up will fill them via upsert
    this.db.upsertMissedOpportunity(sig);
    debug(`[MissedOpp] Skipped ${sig.currency}: ${sig.skipReason} @ ${sig.priceAtSkip}`);
  }

  /** Check all pending signals for price follow-up every 5 minutes */
  private startFollowUpTimer(): void {
    this.timer = setInterval(() => this.runFollowUp(), 5 * 60 * 1000);
  }

  /** Prune expired cooldown entries to keep memory bounded */
  private pruneCooldowns(): void {
    const cutoff = Date.now() - this.COOLDOWN_MS;
    for (const [key, ts] of this.cooldowns.entries()) {
      if (ts < cutoff) this.cooldowns.delete(key);
    }
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

          // 60m data complete — upsert with final price data and remove from pending
          this.db.upsertMissedOpportunity(sig);
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

    // Prune stale cooldown entries
    this.pruneCooldowns();
  }
}
