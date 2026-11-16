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
import fs from 'fs';
import path from 'path';

interface WhaleRecord {
  wins: number;
  totalXrpProfit: number;
  winRatePct?: number;    // externally validated win rate (FirstLedger)
  volumeXrp?: number;     // externally validated total volume
  firstSeen: number;
  lastSeen: number;
}

export class WhaleTracker {
  // In-memory registry: address -> record
  private registry: Map<string, WhaleRecord> = new Map();
  // Fresh imported wallet statistics are separate from historic/training records.
  // Inferred "winning buyer" wallets remain stored for audit but do NOT boost
  // entry scores without external current wallet-specific performance evidence.
  private activeExternal: Map<string, { winRatePct: number; volumeXrp: number; importedAt: number }> = new Map();
  private loaded = false;
  private readonly EXTERNAL_FRESHNESS_MS = 7 * 24 * 3600 * 1000;
  private readonly XRPL_ADDRESS = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;

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
   * Import a top trader validated by external sources (e.g. FirstLedger radar).
   * Stores their win rate and volume alongside the bot's own tracking.
   * If the wallet is already tracked, updates winRatePct and volumeXrp with
   * the externally validated figures (they are more reliable than bot-internal).
   *
   * @param address     XRPL wallet address
   * @param winRatePct  Win rate 0-100 from FirstLedger
   * @param volumeXrp   Total volume in XRP
   * @param positionsOpen Currently open positions (informational)
   */
  importTopTrader(
    address: string,
    winRatePct: number,
    volumeXrp: number,
    positionsOpen = 0
  ): void {
    const now = Date.now();
    const existing = this.registry.get(address);
    if (existing) {
      // External data is authoritative — update win rate and volume
      existing.winRatePct = winRatePct;
      existing.volumeXrp = volumeXrp;
      existing.lastSeen = now;
    } else {
      this.registry.set(address, {
        wins: 0,               // unknown — bot hasn't tracked this wallet
        totalXrpProfit: 0,
        winRatePct,
        volumeXrp,
        firstSeen: now,
        lastSeen: now,
      });
    }
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
    if (!buyerWallets?.length) return 0;
    let score = 0;
    const now = Date.now();
    // A duplicated wallet cannot inflate buyer consensus.
    for (const wallet of new Set(buyerWallets)) {
      const rec = this.activeExternal.get(wallet);
      if (!rec || rec.importedAt > now + 60_000 ||
          now - rec.importedAt > this.EXTERNAL_FRESHNESS_MS) continue;
      const wr = rec.winRatePct;
      const contribution = wr >= 90 ? 10 : wr >= 80 ? 7 : wr >= 70 ? 5 : wr >= 60 ? 3 : 0;
      score += contribution;
      debug(`[WhaleTracker] Fresh imported wallet ${wallet} (historical WR=${wr}%) ${currency}:${issuer} +${contribution}`);
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
        record.lastSeen,
        record.winRatePct ?? 0,
        record.volumeXrp ?? 0
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
        winRatePct: row.winRatePct ?? 0,
        volumeXrp: row.volumeXrp ?? 0,
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

  /**
   * Given a list of buyer wallet addresses, return the highest win-rate among
   * any known whale in that list. Returns 0 if no known whales found.
   * Used by burst/stream paths to lower entry threshold when a high-WR whale is buying.
   */
  getBestWhaleWinRate(buyerWallets: string[]): number {
    let best = 0;
    const now = Date.now();
    for (const addr of new Set(buyerWallets)) {
      const rec = this.activeExternal.get(addr);
      if (!rec || rec.importedAt > now + 60_000 ||
          now - rec.importedAt > this.EXTERNAL_FRESHNESS_MS) continue;
      if (rec.winRatePct > best) best = rec.winRatePct;
    }
    return best;
  }

  /**
   * Returns true if any wallet in the list is a known whale with winRate >= threshold.
   */
  hasHighConfidenceWhale(buyerWallets: string[], minWinRate = 70): boolean {
    return this.getBestWhaleWinRate(buyerWallets) >= minWinRate;
  }

  /**
   * Load top trader whitelist from a JSON file written by the TopTraderWebhook.
   * Safe to call repeatedly — re-imports on every bot restart and lets external
   * sources (FirstLedger) update the whale registry without a code deploy.
   */
  loadTopTradersFromFile(): number {
    // All active performance claims expire on every refresh. Historical
    // operator-selected wallet IDs and PAPER observations remain untouched.
    this.activeExternal.clear();
    const stateDir = path.join(process.cwd(), 'state');
    const sources = [
      // Retain historic hand-imported FirstLedger radar wallet records.
      { path: path.join(stateDir, 'top_traders_import.json'), manual: true },
      // Authenticated operator review is a separate file; it never overwrites
      // the historic hand-imported wallet IDs.
      { path: path.join(stateDir, 'top_traders_webhook.json'), manual: false },
    ];
    const now=Date.now();
    let imported=0;
    for (const src of sources) {
      try {
        if (!fs.existsSync(src.path)) continue;
        const st=fs.lstatSync(src.path);
        if (!st.isFile() || st.isSymbolicLink()) continue;
        const data=JSON.parse(fs.readFileSync(src.path,'utf8')) as {
          importedAt: number; observedAt?: number | null;
          source?: string; approvedForSignals?: boolean;
          traders: Array<{ address: string; winRatePct: number;
            volumeXrp: number; positionsOpen?: number }>;
        };
        const sourceAccepted=src.manual
          ? ['firstledger_radar','firstledger_radar_top20'].includes(data.source || '')
          : data.source === 'operator_reviewed_webhook' &&
            data.approvedForSignals === true;
        // Reuploading an old performance snapshot must not refresh its
        // legitimacy. Authenticated operator webhooks require an explicit
        // observedAt; legacy imported historical records use original date.
        const observedAt=src.manual ? data.importedAt : data.observedAt;
        if (!sourceAccepted || !Number.isFinite(observedAt) ||
            observedAt! > now + 60000 ||
            now-observedAt! > this.EXTERNAL_FRESHNESS_MS ||
            !Array.isArray(data.traders)) {
          debug('[WhaleTracker] Source omitted from live boosts: '+path.basename(src.path));
          continue;
        }
        for (const t of data.traders) {
          if (!t || !this.XRPL_ADDRESS.test(t.address || '') ||
              !Number.isFinite(t.winRatePct) || t.winRatePct < 60 || t.winRatePct > 100 ||
              !Number.isFinite(t.volumeXrp) || t.volumeXrp < 1000) continue;
          this.importTopTrader(t.address,t.winRatePct,t.volumeXrp,t.positionsOpen || 0);
          this.activeExternal.set(t.address,{
            winRatePct:t.winRatePct,volumeXrp:t.volumeXrp,importedAt:observedAt!
          });
          imported++;
        }
      } catch (err) {
        debug('[WhaleTracker] External trader stats unavailable: '+path.basename(src.path));
      }
    }
    if (imported>0) info('[WhaleTracker] Recently observed, source-gated wallet statistics: '+imported);
    return imported;
  }
}
