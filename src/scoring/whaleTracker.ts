/**
 * Whale Wallet Tracker
 *
 * Tracks wallets that bought tokens early before a >50% gain.
 * When those wallets buy a new token, boost its score.
 *
 * "Smart money" following — if a wallet has a history of early
 * buys on winning tokens, their presence in a new token's early
 * buyer set is a strong signal.
 */

import { Database } from '../db/database';
import { info, debug } from '../utils/logger';

interface WhaleRecord {
  wins: number;
  totalXrpProfit: number;
  firstSeen: number;
  lastSeen: number;
}

export class WhaleTracker {
  // In-memory registry: address -> record
  private registry: Map<string, WhaleRecord> = new Map();
  private loaded = false;

  /**
   * Called when a paper trade closes with PnL > 50%.
   * Records the early buyers of that token as "whale" wallets.
   *
   * @param tokenCurrency  Currency code of the winning token
   * @param tokenIssuer    Issuer address of the winning token
   * @param earlyBuyers    List of wallet addresses that bought early
   * @param pnlXRP         Profit realized in XRP (used for profit tracking)
   */
  recordWinner(
    tokenCurrency: string,
    tokenIssuer: string,
    earlyBuyers: string[],
    pnlXRP = 0
  ): void {
    const now = Date.now();
    const profitPerWallet = earlyBuyers.length > 0 ? pnlXRP / earlyBuyers.length : 0;

    for (const address of earlyBuyers) {
      const existing = this.registry.get(address);
      if (existing) {
        existing.wins++;
        existing.totalXrpProfit += profitPerWallet;
        existing.lastSeen = now;
      } else {
        this.registry.set(address, {
          wins: 1,
          totalXrpProfit: profitPerWallet,
          firstSeen: now,
          lastSeen: now,
        });
      }
    }

    info(`[WhaleTracker] Recorded ${earlyBuyers.length} early buyers for ${tokenCurrency}:${tokenIssuer} (pnl: +${pnlXRP.toFixed(2)} XRP)`);
  }

  /**
   * Get a score boost (0-30) based on how many known whale wallets
   * appear in this token's current buyer list.
   *
   * Scoring:
   *   - Each matching whale wallet contributes based on their win count
   *   - More wins = stronger signal
   *   - Cap at 30 total boost
   *
   * @param currency     Token currency code
   * @param issuer       Token issuer address
   * @param buyerWallets Current buyer wallets (from BuyPressureTracker)
   */
  getWhaleScore(
    currency: string,
    issuer: string,
    buyerWallets: string[]
  ): number {
    if (buyerWallets.length === 0 || this.registry.size === 0) return 0;

    let score = 0;

    for (const wallet of buyerWallets) {
      const record = this.registry.get(wallet);
      if (!record) continue;

      // +5 for first win, +2 for each additional win, up to +10 per whale
      const walletContribution = Math.min(10, 5 + (record.wins - 1) * 2);
      score += walletContribution;

      debug(`[WhaleTracker] Whale detected: ${wallet} (wins=${record.wins}) in ${currency}:${issuer} → +${walletContribution}`);
    }

    return Math.min(30, score);
  }

  /**
   * Persist whale registry to DB.
   */
  save(db: Database): void {
    const now = Date.now();
    for (const [address, record] of this.registry.entries()) {
      db.upsertWhaleWallet(
        address,
        record.wins,
        record.totalXrpProfit,
        record.firstSeen,
        record.lastSeen
      );
    }
    debug(`[WhaleTracker] Saved ${this.registry.size} whale wallet records`);
  }

  /**
   * Load whale registry from DB.
   */
  load(db: Database): void {
    if (this.loaded) return;
    const rows = db.getWhaleWallets();
    for (const row of rows) {
      this.registry.set(row.address, {
        wins: row.wins,
        totalXrpProfit: row.totalXrpProfit,
        firstSeen: row.firstSeen,
        lastSeen: row.lastSeen,
      });
    }
    this.loaded = true;
    info(`[WhaleTracker] Loaded ${this.registry.size} whale wallets from DB`);
  }

  getWhaleCount(): number {
    return this.registry.size;
  }

  isWhale(address: string): boolean {
    return this.registry.has(address);
  }
}
