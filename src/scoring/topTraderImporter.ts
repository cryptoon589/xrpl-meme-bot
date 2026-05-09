/**
 * Top Trader Importer
 *
 * Imports validated "smart money" wallet addresses from external sources
 * (e.g. FirstLedger radar) into the WhaleTracker registry.
 *
 * Unlike recordWinner() which learns from the bot's own trades, this module
 * seeds the whale registry with externally-validated traders so their
 * presence in a token's buyer set immediately boosts scores.
 */

import { WhaleTracker } from './whaleTracker';
import { Database } from '../db/database';
import { info, warn } from '../utils/logger';

export interface TopTraderRecord {
  address: string;
  winRatePct: number;    // 0-100
  volumeXrp: number;      // total XRP volume traded
  positionsOpen?: number; // optional: currently open positions
}

export class TopTraderImporter {
  private whaleTracker: WhaleTracker;
  private db: Database;

  // Minimum win rate to be considered a "smart money" whale
  private static readonly MIN_WIN_RATE = 60;
  // Minimum volume in XRP to avoid low-confidence traders
  private static readonly MIN_VOLUME_XRP = 1000;
  // Wallet address regex (r-address on XRPL)
  private static readonly XRPL_ADDRESS_REGEX = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;

  constructor(whaleTracker: WhaleTracker, db: Database) {
    this.whaleTracker = whaleTracker;
    this.db = db;
  }

  /**
   * Validate and import a batch of top trader records.
   * Invalid records are logged and skipped; valid ones are inserted into
   * the WhaleTracker registry and persisted to the DB.
   *
   * @param traders Array of TopTraderRecord from FirstLedger
   * @returns { imported: number, skipped: number }
   */
  importBatch(traders: TopTraderRecord[]): { imported: number; skipped: number } {
    let imported = 0;
    let skipped = 0;

    for (const trader of traders) {
      const reason = this.validateRecord(trader);
      if (reason !== null) {
        warn(`[TopTraderImporter] Skipping ${trader.address}: ${reason}`);
        skipped++;
        continue;
      }

      try {
        this.whaleTracker.importTopTrader(
          trader.address,
          trader.winRatePct,
          trader.volumeXrp,
          trader.positionsOpen ?? 0
        );
        imported++;
      } catch (err) {
        warn(`[TopTraderImporter] Failed to import ${trader.address}: ${err}`);
        skipped++;
      }
    }

    info(`[TopTraderImporter] Imported ${imported}/${traders.length} traders (${skipped} skipped)`);
    return { imported, skipped };
  }

  /**
   * Persist all currently registered whales to the DB.
   * Called after importBatch() to ensure DB is in sync with in-memory registry.
   */
  persistToDb(): void {
    this.whaleTracker.save(this.db);
  }

  /**
   * Validate a single trader record.
   * Returns null if valid, or a string reason if invalid.
   */
  private validateRecord(trader: TopTraderRecord): string | null {
    if (!trader.address || typeof trader.address !== 'string') {
      return 'missing address';
    }

    if (!TopTraderImporter.XRPL_ADDRESS_REGEX.test(trader.address)) {
      return `invalid XRPL address: ${trader.address}`;
    }

    if (
      typeof trader.winRatePct !== 'number' ||
      trader.winRatePct < 0 ||
      trader.winRatePct > 100
    ) {
      return `invalid winRatePct: ${trader.winRatePct} (expected 0-100)`;
    }

    if (
      typeof trader.volumeXrp !== 'number' ||
      trader.volumeXrp < 0
    ) {
      return `invalid volumeXrp: ${trader.volumeXrp}`;
    }

    if (trader.winRatePct < TopTraderImporter.MIN_WIN_RATE) {
      return `winRatePct ${trader.winRatePct} below minimum ${TopTraderImporter.MIN_WIN_RATE}`;
    }

    if (trader.volumeXrp < TopTraderImporter.MIN_VOLUME_XRP) {
      return `volumeXrp ${trader.volumeXrp} below minimum ${TopTraderImporter.MIN_VOLUME_XRP}`;
    }

    return null;
  }
}
