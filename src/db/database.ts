/**
 * Database Module using SQLite (better-sqlite3)
 */

import BetterSQLite3 from 'better-sqlite3';
import path from 'path';
import { SCHEMA, INDEXES, VIEWS } from './schema';
import {
  TrackedToken,
  AMMPool,
  MarketSnapshot,
  RiskFlags,
  TokenScore,
  PaperTrade,
  DailySummary,
  AlertPayload,
} from '../types';
import { info, warn, debug } from '../utils/logger';
import { PaperPositionRuntimeState, validPaperPositionRuntime } from '../paper/paperPositionRuntime';
import { normalizeIssuedCurrency } from '../xrpl/currencyCode';

export class Database {
  private db: BetterSQLite3.Database;
  private readonly isCompactRecoveryDb: boolean;
  private readonly MAX_RETRIES = 3;
  private readonly RETRY_DELAY_MS = 100;

  constructor(dbPath?: string) {
    const filePath = dbPath || process.env.BOT_DB_PATH || path.join(process.cwd(), 'data', 'meme_bot.db');
    // A versioned PAPER epoch has the same bounded-retention safeguards as
    // compact recovery. Never classify the 18GB historical meme_bot.db as small.
    const resolved = path.resolve(filePath);
    const expectedData = path.resolve(process.cwd(), 'data');
    const isPaperEpoch = path.dirname(resolved) === expectedData &&
      /^meme_bot[.]paper-epoch-[0-9]{8}(?:-[a-z0-9]+)?[.]db$/.test(path.basename(resolved));
    this.isCompactRecoveryDb = resolved === path.join(expectedData,'meme_bot.recovery.db') ||
      isPaperEpoch;

    // Ensure data directory exists
    const fs = require('fs');
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new BetterSQLite3(filePath);

    // Enable WAL mode for better performance
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    this.initializeSchema();
    info(`Database initialized at ${filePath}`);
  }

  /**
   * FIX #15: Execute SQL with retry logic for database locks
   */
  private execWithRetry(sql: string, retries: number = this.MAX_RETRIES): void {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        this.db.exec(sql);
        return;
      } catch (err: any) {
        // SQLite lock error codes: SQLITE_BUSY (5), SQLITE_LOCKED (6)
        if ((err.code === 'SQLITE_BUSY' || err.code === 'SQLITE_LOCKED' || err.message?.includes('database is locked')) && attempt < retries) {
          const delay = this.RETRY_DELAY_MS * attempt;
          warn(`Database locked, retry ${attempt}/${retries} in ${delay}ms`);
          // Synchronous sleep for simplicity in SQLite context
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
        } else {
          throw err;
        }
      }
    }
  }

  /**
   * FIX #15: Run prepared statement with retry logic
   */
  private runWithRetry(stmt: BetterSQLite3.Statement, params: any[], retries: number = this.MAX_RETRIES): any {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        return stmt.run(...params);
      } catch (err: any) {
        if ((err.code === 'SQLITE_BUSY' || err.code === 'SQLITE_LOCKED' || err.message?.includes('database is locked')) && attempt < retries) {
          const delay = this.RETRY_DELAY_MS * attempt;
          warn(`Database locked on write, retry ${attempt}/${retries} in ${delay}ms`);
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
        } else {
          throw err;
        }
      }
    }
  }

  /**
   * Initialize database schema
   */
  private initializeSchema(): void {
    // Create tables
    for (const [name, sql] of Object.entries(SCHEMA)) {
      try {
        this.execWithRetry(sql);
      } catch (err) {
        warn(`Error creating table ${name}: ${err}`);
      }
    }

    // Create indexes
    for (const indexSql of INDEXES) {
      try {
        this.execWithRetry(indexSql);
      } catch (err) {
        warn(`Error creating index: ${err}`);
      }
    }

    // Timestamp indexes for bounded retention, only on the small recovered DB.
    // Do NOT attempt to index the full 18 GiB original during recovery.
    if (this.isCompactRecoveryDb) {
      for (const sql of [
        'CREATE INDEX IF NOT EXISTS idx_recovery_snapshots_timestamp ON market_snapshots(timestamp)',
        'CREATE INDEX IF NOT EXISTS idx_recovery_scores_timestamp ON scores(timestamp)',
        'CREATE INDEX IF NOT EXISTS idx_recovery_risk_timestamp ON risk_flags(timestamp)',
        'CREATE INDEX IF NOT EXISTS idx_recovery_risk_token ON risk_flags(token_currency, token_issuer, timestamp)'
      ]) this.execWithRetry(sql);
    }

    // Recovery schema may have been copied from a legacy table without its UNIQUE constraint.
    // This must run at startup, not only when optional missed-opportunity setup is invoked.
    try {
      this.execWithRetry(`CREATE UNIQUE INDEX IF NOT EXISTS idx_missed_opp_natural_key
        ON missed_opportunities(currency, issuer, skipped_at)`);
    } catch (err) {
      warn(`Failed to establish missed-opportunity UPSERT key: ${err}`);
      throw err;
    }

    // Migrations: add columns that may be missing from older DB files
    const migrations = [
      `ALTER TABLE market_snapshots ADD COLUMN unique_buyers_5m INTEGER DEFAULT 0`,
      `ALTER TABLE market_snapshots ADD COLUMN unique_sellers_5m INTEGER DEFAULT 0`,
      `ALTER TABLE tokens ADD COLUMN raw_currency TEXT`,
      `ALTER TABLE paper_trades ADD COLUMN xrp_returned REAL DEFAULT 0`,
      `ALTER TABLE paper_trades ADD COLUMN trade_profile TEXT`,
      `ALTER TABLE paper_trades ADD COLUMN trade_source TEXT`,
      `ALTER TABLE paper_trades ADD COLUMN raw_currency TEXT`,
      `ALTER TABLE whale_wallets ADD COLUMN win_rate_pct REAL DEFAULT 0`,
      `ALTER TABLE whale_wallets ADD COLUMN volume_xrp REAL DEFAULT 0`,
      // whale_wallets and execution_validation are created via SCHEMA (CREATE TABLE IF NOT EXISTS)
      // so no ALTER TABLE needed; these are no-op guards for idempotency
    ];

    // Historical PnL is immutable during startup. The old FIX #26 UPDATE
    // overwrote closed trades whenever xrp_returned was zero or missing,
    // potentially turning legitimate historical results into -100% losses.
    // Review suspicious rows separately; never rewrite them on boot.
    for (const sql of migrations) {
      try {
        this.db.exec(sql);
      } catch {
        // Column already exists — ignore
      }
    }

    // Create compatibility views AFTER migrations so all columns exist
    // DROP first so schema changes (e.g. new columns) are picked up on restart
    try { this.db.exec(`DROP VIEW IF EXISTS tracked_tokens`); } catch { /* ignore */ }
    for (const viewSql of VIEWS) {
      try {
        this.execWithRetry(viewSql);
      } catch (err) {
        warn(`Error creating view: ${err}`);
      }
    }
  }

  /**
   * Diagnostic-only durable PAPER timeline. Dedup signals per exact issue and
   * UTC 15-minute bucket; trade boundaries are keyed by trade ID. All writes
   * are best-effort and cannot break an inventory/cash transaction or an exit.
   * The original, potentially 18 GiB, database is never written by this path.
   */
  recordOpportunityEvent(event: {
    tokenCurrency: string; tokenIssuer: string; rawCurrency?: string;
    observedAt: number; eventType: string; source?: string;
    priceXRP?: number | null; tradeId?: number | null; detail?: string | null;
  }): boolean {
    if (!this.isCompactRecoveryDb) return false;
    const kinds = new Set([
      'first_detected','burst_seen','burst_qualified','stream_quoted',
      'stream_qualified','momentum_seen','paper_entry','paper_exit',
      'amm_xrp_inflow','amm_xrp_outflow','amm_pressure_compare'
    ]);
    const raw = event.rawCurrency || event.tokenCurrency;
    const px = event.priceXRP ?? null;
    const tid = event.tradeId ?? null;
    if (!event.tokenCurrency || !event.tokenIssuer || !raw ||
        !kinds.has(event.eventType) ||
        !Number.isSafeInteger(event.observedAt) || event.observedAt <= 0 ||
        (px !== null && (!Number.isFinite(px) || px <= 0)) ||
        (tid !== null && (!Number.isSafeInteger(tid) || tid <= 0))) {
      return false;
    }
    const unit = tid !== null ? 'trade:' + tid
      : event.eventType === 'first_detected' ? 'first'
      : 'bucket:' + Math.floor(event.observedAt / 900000);
    const key = [event.eventType,raw,event.tokenIssuer,unit].join('|');
    try {
      const result = this.runWithRetry(this.db.prepare(`
        INSERT OR IGNORE INTO paper_opportunity_events
        (token_currency,token_issuer,raw_currency,observed_at,
         event_type,source,price_xrp,trade_id,detail,dedup_key)
        VALUES (?,?,?,?,?,?,?,?,?,?)
      `), [
        event.tokenCurrency,event.tokenIssuer,raw,event.observedAt,
        event.eventType,event.source ?? null,px,tid,
        (event.detail ?? '').slice(0,256),key
      ]);
      return result.changes === 1;
    } catch (err) {
      warn('[V2.1] Observation persistence failed (trade unaffected): ' + err);
      return false;
    }
  }

  // ==================== TOKENS ====================

  saveToken(token: TrackedToken): void {
    try {
      const now = Date.now();
      // FIX #33: Always persist raw_currency alongside currency/issuer.
      // getPrice() needs the hex-padded raw currency for AMM API calls — without it
      // it falls back to ASCII name which causes "Issue is malformed" errors.
      // COALESCE: don't overwrite an existing raw_currency with null if caller doesn't have it.
      const updateStmt = this.db.prepare(
        `UPDATE tokens SET last_updated = ?, raw_currency = COALESCE(?, raw_currency) WHERE currency = ? AND issuer = ?`
      );
      const updateResult = this.runWithRetry(updateStmt, [now, token.rawCurrency ?? null, token.currency, token.issuer]);
      if (updateResult.changes === 0) {
        const insertStmt = this.db.prepare(
          `INSERT INTO tokens (currency, issuer, first_seen, last_updated, raw_currency) VALUES (?, ?, ?, ?, ?)`
        );
        this.runWithRetry(insertStmt, [token.currency, token.issuer, token.firstSeen, now, token.rawCurrency ?? null]);
        this.recordOpportunityEvent({tokenCurrency:token.currency,tokenIssuer:token.issuer,
          // This is the time HUNTERIX observed/internally inserted the issue,
          // NOT an external provider's potentially historical dateon or XRPL
          // issuance timestamp carried in token.firstSeen.
          rawCurrency:token.rawCurrency,observedAt:now,
          eventType:'first_detected',source:'bot_tracking'});
      }
    } catch (err) {
      warn(`Error saving token: ${err}`);
    }
  }

  getTrackedTokens(): TrackedToken[] {
    try {
      const rows = this.db.prepare('SELECT * FROM tokens').all() as any[];
      return rows.map(row => ({
        currency: row.currency,
        issuer: row.issuer,
        firstSeen: row.first_seen,
        lastUpdated: row.last_updated,
        rawCurrency: row.raw_currency ?? undefined,
      }));
    } catch (err) {
      warn(`Error getting tracked tokens: ${err}`);
      return [];
    }
  }

  /**
   * Destructive startup token cleanup — intentionally disabled by default.
   * Score history was excluded from compact recovery DBs, so absent scores
   * must not be treated as evidence that tokens are safe to delete.
   */
  pruneStaleTokens(): number {
    if (process.env.BOT_ENABLE_STARTUP_PRUNE !== '1') {
      warn('Refusing destructive token prune without BOT_ENABLE_STARTUP_PRUNE=1');
      return 0;
    }
    try {
      const cutoff = Date.now() - 48 * 60 * 60 * 1000;
      const result = this.db.prepare(`
        DELETE FROM tokens
        WHERE last_updated < ?
          AND NOT EXISTS (
            SELECT 1 FROM scores s
            WHERE s.token_currency = tokens.currency
              AND s.token_issuer = tokens.issuer
              AND s.timestamp > ?
          )
          AND NOT EXISTS (
            SELECT 1 FROM paper_trades p
            WHERE p.token_currency = tokens.currency
              AND p.token_issuer = tokens.issuer
              AND p.status IN ('open', 'partial')
          )
      `).run(cutoff, cutoff) as any;
      return result.changes ?? 0;
    } catch (err) {
      warn(`Error pruning stale tokens: ${err}`);
      return 0;
    }
  }

  getTokenCount(): number {
    try {
      const row = this.db.prepare('SELECT COUNT(*) as count FROM tokens').get() as any;
      return row.count;
    } catch (err) {
      return 0;
    }
  }

  // ==================== AMM POOLS ====================

  saveAMMPool(pool: AMMPool): void {
    try {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO amm_pools
        (pool_id, asset1_currency, asset1_issuer, asset2_currency, asset2_issuer,
         amount1, amount2, lp_balance, trading_fee, created_at, last_updated)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      this.runWithRetry(stmt, [
        pool.poolId,
        pool.asset1.currency,
        pool.asset1.issuer || null,
        pool.asset2.currency,
        pool.asset2.issuer || null,
        pool.amount1,
        pool.amount2,
        pool.lpBalance,
        pool.tradingFee,
        pool.createdAt,
        pool.lastUpdated
      ]);
    } catch (err) {
      warn(`Error saving AMM pool: ${err}`);
    }
  }

  updateAMMPool(pool: AMMPool): void {
    try {
      const stmt = this.db.prepare(`
        UPDATE amm_pools
        SET amount1 = ?, amount2 = ?, lp_balance = ?, last_updated = ?
        WHERE pool_id = ?
      `);
      this.runWithRetry(stmt, [pool.amount1, pool.amount2, pool.lpBalance, pool.lastUpdated, pool.poolId]);
    } catch (err) {
      warn(`Error updating AMM pool: ${err}`);
    }
  }

  getAMMPools(): AMMPool[] {
    try {
      const rows = this.db.prepare('SELECT * FROM amm_pools').all() as any[];
      return rows.map(row => ({
        asset1: { currency: row.asset1_currency, issuer: row.asset1_issuer || undefined },
        asset2: { currency: row.asset2_currency, issuer: row.asset2_issuer || undefined },
        amount1: row.amount1,
        amount2: row.amount2,
        lpBalance: row.lp_balance,
        tradingFee: row.trading_fee,
        poolId: row.pool_id,
        createdAt: row.created_at,
        lastUpdated: row.last_updated,
      }));
    } catch (err) {
      warn(`Error getting AMM pools: ${err}`);
      return [];
    }
  }

  // ==================== MARKET SNAPSHOTS ====================

  saveMarketSnapshot(snapshot: MarketSnapshot): void {
    // Bound historical write amplification: at most one sample per token per minute.
    // Keep the most recent row queryable; only suppress redundant high-frequency inserts.
    const recent = this.db.prepare(`
      SELECT timestamp FROM market_snapshots
      WHERE token_currency = ? AND token_issuer = ?
      ORDER BY timestamp DESC LIMIT 1
    `).get(snapshot.tokenCurrency, snapshot.tokenIssuer) as { timestamp: number } | undefined;
    if (recent && snapshot.timestamp >= recent.timestamp &&
        snapshot.timestamp - recent.timestamp < (this.isCompactRecoveryDb ? 120_000 : 60_000)) return;
    try {
      const stmt = this.db.prepare(`
        INSERT INTO market_snapshots
        (token_currency, token_issuer, timestamp, price_xrp, liquidity_xrp,
         buy_volume_5m, sell_volume_5m, buy_count_5m, sell_count_5m,
         unique_buyers_5m, unique_sellers_5m,
         price_change_5m, price_change_15m, price_change_1h,
         holder_estimate, spread_percent)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      this.runWithRetry(stmt, [
        snapshot.tokenCurrency,
        snapshot.tokenIssuer,
        snapshot.timestamp,
        snapshot.priceXRP,
        snapshot.liquidityXRP,
        snapshot.buyVolume5m,
        snapshot.sellVolume5m,
        snapshot.buyCount5m,
        snapshot.sellCount5m,
        snapshot.uniqueBuyers5m || 0,
        snapshot.uniqueSellers5m || 0,
        snapshot.priceChange5m,
        snapshot.priceChange15m,
        snapshot.priceChange1h,
        snapshot.holderEstimate,
        snapshot.spreadPercent
      ]);
    } catch (err) {
      warn(`Error saving market snapshot: ${err}`);
    }
  }

  getLatestSnapshot(currency: string, issuer: string): MarketSnapshot | null {
    try {
      const row = this.db.prepare(`
        SELECT * FROM market_snapshots
        WHERE token_currency = ? AND token_issuer = ?
        ORDER BY timestamp DESC LIMIT 1
      `).get(currency, issuer) as any;

      if (!row) return null;

      return {
        tokenCurrency: row.token_currency,
        tokenIssuer: row.token_issuer,
        timestamp: row.timestamp,
        priceXRP: row.price_xrp,
        liquidityXRP: row.liquidity_xrp,
        buyVolume5m: row.buy_volume_5m,
        sellVolume5m: row.sell_volume_5m,
        buyCount5m: row.buy_count_5m,
        sellCount5m: row.sell_count_5m,
        uniqueBuyers5m: row.unique_buyers_5m || 0,
        uniqueSellers5m: row.unique_sellers_5m || 0,
        priceChange5m: row.price_change_5m,
        priceChange15m: row.price_change_15m,
        priceChange1h: row.price_change_1h,
        holderEstimate: row.holder_estimate,
        spreadPercent: row.spread_percent,
      };
    } catch (err) {
      return null;
    }
  }

  // ==================== RISK FLAGS ====================

  saveRiskFlags(tokenCurrency: string, tokenIssuer: string, riskFlags: RiskFlags): void {
    try {
      // Risk flags otherwise emit one row per token per scan (millions/day).
      // Cap optional recovery history to one row per token every 5 minutes.
      const now = Date.now();
      if (this.isCompactRecoveryDb) {
        const latest = this.db.prepare(`
          SELECT timestamp FROM risk_flags WHERE token_currency = ? AND token_issuer = ?
          ORDER BY timestamp DESC LIMIT 1
        `).get(tokenCurrency, tokenIssuer) as { timestamp: number } | undefined;
        if (latest && now >= latest.timestamp && now - latest.timestamp < 300_000) return;
      }
      const stmt = this.db.prepare(`
        INSERT INTO risk_flags
        (token_currency, token_issuer, timestamp,
         low_liquidity, wide_spread, concentrated_supply, dev_dumping,
         liquidity_removed, low_holders, no_buy_activity, single_wallet_price,
         flags_text)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      this.runWithRetry(stmt, [
        tokenCurrency,
        tokenIssuer,
        now,
        riskFlags.lowLiquidity ? 1 : 0,
        riskFlags.wideSpread ? 1 : 0,
        riskFlags.concentratedSupply ? 1 : 0,
        riskFlags.devDumping ? 1 : 0,
        riskFlags.liquidityRemoved ? 1 : 0,
        riskFlags.lowHolderCount ? 1 : 0,
        riskFlags.noBuyActivity ? 1 : 0,
        riskFlags.singleWalletPrice ? 1 : 0,
        riskFlags.flags.join(',')
      ]);
    } catch (err) {
      warn(`Error saving risk flags: ${err}`);
    }
  }

  // ==================== SCORES ====================

  saveScore(score: TokenScore): void {
    // Bound historical write amplification: at most one sample per token per minute.
    // Keep the most recent row queryable; only suppress redundant high-frequency inserts.
    const recent = this.db.prepare(`
      SELECT timestamp FROM scores
      WHERE token_currency = ? AND token_issuer = ?
      ORDER BY timestamp DESC LIMIT 1
    `).get(score.tokenCurrency, score.tokenIssuer) as { timestamp: number } | undefined;
    if (recent && score.timestamp >= recent.timestamp &&
        score.timestamp - recent.timestamp < (this.isCompactRecoveryDb ? 120_000 : 60_000)) return;
    try {
      const stmt = this.db.prepare(`
        INSERT INTO scores
        (token_currency, token_issuer, timestamp, total_score,
         liquidity_score, holder_growth_score, buy_pressure_score,
         volume_accel_score, dev_safety_score, whitelist_boost, spread_score)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      this.runWithRetry(stmt, [
        score.tokenCurrency,
        score.tokenIssuer,
        score.timestamp,
        score.totalScore,
        score.liquidityScore,
        score.holderGrowthScore,
        score.buyPressureScore,
        score.volumeAccelScore,
        score.devSafetyScore,
        score.whitelistBoost,
        score.spreadScore
      ]);
    } catch (err) {
      warn(`Error saving score: ${err}`);
    }
  }

  getLatestScore(currency: string, issuer: string): TokenScore | null {
    try {
      const row = this.db.prepare(`
        SELECT * FROM scores
        WHERE token_currency = ? AND token_issuer = ?
        ORDER BY timestamp DESC LIMIT 1
      `).get(currency, issuer) as any;

      if (!row) return null;

      return {
        tokenCurrency: row.token_currency,
        tokenIssuer: row.token_issuer,
        timestamp: row.timestamp,
        totalScore: row.total_score,
        liquidityScore: row.liquidity_score,
        holderGrowthScore: row.holder_growth_score,
        buyPressureScore: row.buy_pressure_score,
        volumeAccelScore: row.volume_accel_score,
        devSafetyScore: row.dev_safety_score,
        whitelistBoost: row.whitelist_boost,
        spreadScore: row.spread_score,
      };
    } catch (err) {
      return null;
    }
  }

  /**
   * Verified only for brand-new PAPER databases with no historical trades.
   * Never infer a baseline from legacy P&L, daily summaries, or ghost closes.
   */
  getPaperCashState(): number | null {
    const row = this.db.prepare('SELECT bankroll_xrp AS cash FROM paper_cash_state WHERE singleton_id = 1').get() as { cash: number } | undefined;
    return row && Number.isFinite(row.cash) && row.cash >= 0 ? row.cash : null;
  }

  ensureFreshPaperCashState(startingBankrollXRP: number): number | null {
    return this.db.transaction(() => {
      const existing = this.getPaperCashState();
      if (existing !== null) return existing;
      const total = this.db.prepare('SELECT COUNT(*) AS n FROM paper_trades').get() as { n: number };
      if (total.n !== 0) return null; // legacy: no automatic, unverified bootstrap
      if (!Number.isFinite(startingBankrollXRP) || startingBankrollXRP <= 0)
        throw new Error('Invalid starting PAPER bankroll');
      this.db.prepare('INSERT INTO paper_cash_state(singleton_id, bankroll_xrp, updated_at) VALUES (1, ?, ?)').run(
        startingBankrollXRP, Date.now());
      return startingBankrollXRP;
    })();
  }

  /** Persist volatile trailing-stop, TP/SL and profile state for safe process
   * restart. Does not mutate any economic ledger or old PAPER trade rows.
   * The trade ID+entry timestamp are validated when restoring the checkpoint.
   */
  savePaperPositionRuntime(state:PaperPositionRuntimeState): void {
    if(!Number.isInteger(state.tradeId) || state.tradeId<=0 ||
       !Number.isFinite(state.highestPriceSinceEntry) ||
       state.highestPriceSinceEntry<=0){
      throw new Error('Invalid PAPER runtime state');
    }
    this.db.prepare(`
      INSERT INTO paper_position_runtime (trade_id,state_json,updated_at)
      VALUES (?,?,?)
      ON CONFLICT(trade_id) DO UPDATE SET
        state_json=excluded.state_json,updated_at=excluded.updated_at
    `).run(state.tradeId,JSON.stringify(state),Date.now());
  }

  getPaperPositionRuntime(trade:PaperTrade):PaperPositionRuntimeState|null {
    if(!trade.id)return null;
    const row=this.db.prepare(
      'SELECT state_json FROM paper_position_runtime WHERE trade_id=?'
    ).get(trade.id) as {state_json:string}|undefined;
    if(!row)return null;
    try {
      const state=JSON.parse(row.state_json);
      return validPaperPositionRuntime(state,trade)?state:null;
    }catch{return null;}
  }

  getPaperInventory(tradeId: number | undefined): number | null {
    if (!tradeId) return null;
    const row = this.db.prepare('SELECT tokens_held AS tokens FROM paper_inventory WHERE trade_id = ?').get(tradeId) as { tokens: number } | undefined;
    return row && Number.isFinite(row.tokens) && row.tokens >= 0 ? row.tokens : null;
  }

  /**
   * Atomic economic checkpoint: trade row + remaining tokens + spendable cash.
   * If an operation fails, SQLite rolls all writes back; callers must only
   * update in-memory cash/positions AFTER this method returns.
   */
  commitPaperMutation(trade: PaperTrade, cashXRP: number, tokensHeld: number, kind: 'entry' | 'update'): void {
    if (!Number.isFinite(tokensHeld) || tokensHeld < 0)
      throw new Error('Invalid PAPER remaining token quantity');
    this.db.transaction(() => {
      const persistedCash = this.getPaperCashState();
      if (kind === 'entry' && persistedCash === null)
        throw new Error('PAPER cash baseline unreconciled: refusing entry');
      if (kind === 'entry') this.savePaperTrade(trade);
      else this.updatePaperTrade(trade);
      if (!trade.id) throw new Error('PAPER mutation missing persisted trade ID');
      this.db.prepare(`
        INSERT INTO paper_inventory(trade_id, tokens_held, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(trade_id) DO UPDATE SET tokens_held=excluded.tokens_held, updated_at=excluded.updated_at
      `).run(trade.id, tokensHeld, Date.now());
      if (persistedCash !== null) {
        if (!Number.isFinite(cashXRP) || cashXRP < 0)
          throw new Error('Invalid PAPER cash checkpoint');
        const result = this.db.prepare(`
          UPDATE paper_cash_state SET bankroll_xrp=?, updated_at=? WHERE singleton_id=1
        `).run(cashXRP, Date.now());
        if (result.changes !== 1) throw new Error('PAPER cash checkpoint update failed');
      }
      // For historical DBs, update trade and inventory only; never write
      // fabricated cash or silently verify the legacy baseline.
    })();
  }

  // ==================== PAPER TRADES ====================

  savePaperTrade(trade: PaperTrade): void {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO paper_trades
        (token_currency, token_issuer, entry_price_xrp, entry_amount_xrp,
         entry_timestamp, entry_score, entry_reason, exit_price_xrp,
         exit_timestamp, exit_score, exit_reason, status, pnl_xrp,
         pnl_percent, slippage_estimate, fees_paid, tp1_hit, tp2_hit,
         trailing_stop_active, remaining_position, xrp_returned,
         trade_profile, trade_source, raw_currency)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      this.runWithRetry(stmt, [
        trade.tokenCurrency,
        trade.tokenIssuer,
        trade.entryPriceXRP,
        trade.entryAmountXRP,
        trade.entryTimestamp,
        trade.entryScore,
        trade.entryReason,
        trade.exitPriceXRP,
        trade.exitTimestamp,
        trade.exitScore,
        trade.exitReason,
        trade.status,
        trade.pnlXRP,
        trade.pnlPercent,
        trade.slippageEstimate,
        trade.feesPaid,
        trade.tp1Hit ? 1 : 0,
        trade.tp2Hit ? 1 : 0,
        trade.trailingStopActive ? 1 : 0,
        trade.remainingPosition,
        trade.xrpReturned ?? 0,
        trade.tradeProfile ?? null,
        trade.tradeSource ?? null,
        trade.rawCurrency ?? null,
      ]);

      // Set the ID on the trade object
      const result: any = this.db.prepare('SELECT last_insert_rowid() as id').get();
      trade.id = Number(result.id);
      this.recordOpportunityEvent({tokenCurrency:trade.tokenCurrency,tokenIssuer:trade.tokenIssuer,
        rawCurrency:trade.rawCurrency,observedAt:trade.entryTimestamp,
        eventType:'paper_entry',source:trade.tradeSource ?? 'paper',
        priceXRP:trade.entryPriceXRP,tradeId:trade.id});
    } catch (err) {
      warn(`Error saving paper trade: ${err}`);
      throw err; // required for transaction rollback
    }
  }

  updatePaperTrade(trade: PaperTrade): void {
    try {
      const stmt = this.db.prepare(`
        UPDATE paper_trades
        SET exit_price_xrp = ?, exit_timestamp = ?, exit_score = ?,
            exit_reason = ?, status = ?, pnl_xrp = ?, pnl_percent = ?,
            fees_paid = ?, tp1_hit = ?, tp2_hit = ?,
            trailing_stop_active = ?, remaining_position = ?, xrp_returned = ?,
            trade_profile = COALESCE(trade_profile, ?),
            trade_source  = COALESCE(trade_source,  ?)
        WHERE id = ?
      `);
      this.runWithRetry(stmt, [
        trade.exitPriceXRP,
        trade.exitTimestamp,
        trade.exitScore,
        trade.exitReason,
        trade.status,
        trade.pnlXRP,
        trade.pnlPercent,
        trade.feesPaid,
        trade.tp1Hit ? 1 : 0,
        trade.tp2Hit ? 1 : 0,
        trade.trailingStopActive ? 1 : 0,
        trade.remainingPosition,
        trade.xrpReturned ?? 0,
        trade.tradeProfile ?? null,
        trade.tradeSource ?? null,
        trade.id
      ]);
      if (trade.status === 'closed' && trade.exitTimestamp) {
        this.recordOpportunityEvent({tokenCurrency:trade.tokenCurrency,tokenIssuer:trade.tokenIssuer,
          rawCurrency:trade.rawCurrency,observedAt:trade.exitTimestamp,
          eventType:'paper_exit',source:trade.tradeSource ?? 'paper',
          priceXRP:trade.exitPriceXRP,tradeId:trade.id,
          detail:trade.exitReason ?? null});
      }
    } catch (err) {
      warn(`Error updating paper trade: ${err}`);
      throw err; // required for transaction rollback
    }
  }

  /** FIX #28: Get the N most recently closed trades for a specific token (for conviction re-entry sizing) */
  getRecentClosedTrades(currency: string, issuer: string, limit: number = 1): PaperTrade[] {
    try {
      const rows = this.db.prepare(`
        SELECT * FROM paper_trades
        WHERE token_currency = ? AND token_issuer = ? AND status = 'closed'
        ORDER BY exit_timestamp DESC LIMIT ?
      `).all(currency, issuer, limit) as any[];
      return rows.map(row => this.rowToPaperTrade(row));
    } catch (err) {
      warn(`Error getting recent closed trades: ${err}`);
      return [];
    }
  }

  getOpenTrades(): PaperTrade[] {
    try {
      const rows = this.db.prepare(`
        SELECT * FROM paper_trades WHERE status IN ('open', 'partial')
      `).all() as any[];

      return rows.map(row => this.rowToPaperTrade(row));
    } catch (err) {
      warn(`Error getting open trades: ${err}`);
      return [];
    }
  }

  getOpenPositionCount(): number {
    try {
      const row = this.db.prepare(`
        SELECT COUNT(*) as cnt FROM paper_trades WHERE status = 'open'
      `).get() as { cnt: number };
      return row?.cnt ?? 0;
    } catch (err) {
      warn(`[DB] getOpenPositionCount error: ${err}`);
      return 0;
    }
  }

  getPartialPositionCount(): number {
    try {
      const row = this.db.prepare(`
        SELECT COUNT(*) as cnt FROM paper_trades WHERE status = 'partial'
      `).get() as { cnt: number };
      return row?.cnt ?? 0;
    } catch (err) {
      warn(`[DB] getPartialPositionCount error: ${err}`);
      return 0;
    }
  }

  getTotalClosedTradeCount(): number {
    try {
      const row = this.db.prepare(`
        SELECT COUNT(*) as cnt FROM paper_trades WHERE status = 'closed'
      `).get() as { cnt: number };
      return row?.cnt ?? 0;
    } catch (err) {
      return 0;
    }
  }

  getClosedTradeCountSince(sinceMs: number): number {
    try {
      const row = this.db.prepare(`
        SELECT COUNT(*) as cnt FROM paper_trades
        WHERE status = 'closed' AND exit_timestamp >= ?
      `).get(Date.now() - sinceMs) as { cnt: number };
      return row?.cnt ?? 0;
    } catch (err) {
      return 0;
    }
  }

  getWinningTradeCountSince(sinceMs: number): number {
    try {
      const row = this.db.prepare(`
        SELECT COUNT(*) as cnt FROM paper_trades
        WHERE status = 'closed' AND exit_timestamp >= ? AND pnl_xrp > 0
      `).get(Date.now() - sinceMs) as { cnt: number };
      return row?.cnt ?? 0;
    } catch (err) {
      return 0;
    }
  }


  /**
   * DB-level check: is there already an open/partial trade for this token?
   * Used as a hard guard against duplicate entries even across restarts.
   */
  hasOpenTradeForToken(currency: string, issuer: string, rawCurrency?: string): boolean {
    // One XRPL issued asset is defined by exact raw currency + issuer, NOT
    // by displayed name. This DB-backed guard works across bot restarts.
    // In particular PHNIX and its 40-hex representation must share a slot.
    const candidate=normalizeIssuedCurrency(rawCurrency || currency);
    if(!candidate || !issuer)return true; // fail closed on malformed identity
    try {
      const rows = this.db.prepare(`
        SELECT token_currency, raw_currency FROM paper_trades
        WHERE token_issuer = ? AND status IN ('open', 'partial')
      `).all(issuer) as Array<{token_currency:string;raw_currency:string|null}>;
      return rows.some(row=>{
        const stored=normalizeIssuedCurrency(row.raw_currency||row.token_currency);
        // A malformed stored open row is not safe to ignore.
        return !stored || stored===candidate;
      });
    } catch (err) {
      warn('Open-trade identity verification unavailable: '+String(err));
      return true; // fail closed rather than open duplicate during DB trouble
    }
  }

  getTradesForDate(date: string): PaperTrade[] {
    try {
      const startOfDay = new Date(date).getTime();
      const endOfDay = startOfDay + 24 * 60 * 60 * 1000;

      const rows = this.db.prepare(`
        SELECT * FROM paper_trades
        WHERE entry_timestamp >= ? AND entry_timestamp < ?
      `).all(startOfDay, endOfDay) as any[];

      return rows.map(row => this.rowToPaperTrade(row));
    } catch (err) {
      warn(`Error getting trades for date: ${err}`);
      return [];
    }
  }

  private rowToPaperTrade(row: any): PaperTrade {
    return {
      id: row.id,
      tokenCurrency: row.token_currency,
      tokenIssuer: row.token_issuer,
      entryPriceXRP: row.entry_price_xrp,
      entryAmountXRP: row.entry_amount_xrp,
      entryTimestamp: row.entry_timestamp,
      entryScore: row.entry_score,
      entryReason: row.entry_reason,
      exitPriceXRP: row.exit_price_xrp,
      exitTimestamp: row.exit_timestamp,
      exitScore: row.exit_score,
      exitReason: row.exit_reason,
      status: row.status,
      pnlXRP: row.pnl_xrp,
      pnlPercent: row.pnl_percent,
      slippageEstimate: row.slippage_estimate,
      feesPaid: row.fees_paid,
      xrpReturned: row.xrp_returned ?? 0,
      tp1Hit: row.tp1_hit === 1,
      tp2Hit: row.tp2_hit === 1,
      trailingStopActive: row.trailing_stop_active === 1,
      remainingPosition: row.remaining_position,
      tradeProfile: row.trade_profile ?? undefined,
      tradeSource: row.trade_source ?? undefined,
      rawCurrency: row.raw_currency ?? undefined,
    };
  }

  // ==================== ALERTS ====================

  saveAlert(payload: AlertPayload): void {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO alerts (alert_type, token_currency, token_issuer, timestamp, message, score)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      this.runWithRetry(stmt, [
        payload.type,
        payload.tokenCurrency || null,
        payload.tokenIssuer || null,
        Date.now(),
        payload.message,
        payload.score || null
      ]);
    } catch (err) {
      warn(`Error saving alert: ${err}`);
    }
  }

  // ==================== DAILY SUMMARIES ====================

  saveDailySummary(summary: DailySummary): void {
    try {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO daily_summaries
        (date, trades_opened, trades_closed, total_pnl_xrp, win_rate,
         max_drawdown, best_trade, worst_trade)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      this.runWithRetry(stmt, [
        summary.date,
        summary.tradesOpened,
        summary.tradesClosed,
        summary.totalPnLXRP,
        summary.winRate,
        summary.maxDrawdown,
        summary.bestTrade,
        summary.worstTrade
      ]);
    } catch (err) {
      warn(`Error saving daily summary: ${err}`);
    }
  }

  getRecentSummaries(limit: number = 7): DailySummary[] {
    try {
      const rows = this.db.prepare(`
        SELECT * FROM daily_summaries ORDER BY date DESC LIMIT ?
      `).all(limit) as any[];

      return rows.map(row => ({
        date: row.date,
        tradesOpened: row.trades_opened,
        tradesClosed: row.trades_closed,
        totalPnLXRP: row.total_pnl_xrp,
        winRate: row.win_rate,
        maxDrawdown: row.max_drawdown,
        bestTrade: row.best_trade,
        worstTrade: row.worst_trade,
      }));
    } catch (err) {
      warn(`Error getting recent summaries: ${err}`);
      return [];
    }
  }

  /**
   * QUICK WIN #5: Execute multiple operations in a transaction
   * Much faster than individual writes due to reduced fsync overhead
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // In-memory alert cooldown tracker (no DB write needed)
  private alertTimes: Map<string, number> = new Map();

  getLastAlertTime(currency: string, issuer: string): number {
    return this.alertTimes.get(`${currency}:${issuer}`) || 0;
  }

  setLastAlertTime(currency: string, issuer: string, ts: number): void {
    this.alertTimes.set(`${currency}:${issuer}`, ts);
  }

  // ==================== SCORES (QUERY FOR BACKTEST) ====================

  getScoresInRange(startTs: number, endTs: number): TokenScore[] {
    try {
      const rows = this.db.prepare(`
        SELECT * FROM scores
        WHERE timestamp >= ? AND timestamp <= ?
        ORDER BY timestamp ASC
      `).all(startTs, endTs) as any[];
      return rows.map(row => ({
        tokenCurrency: row.token_currency,
        tokenIssuer: row.token_issuer,
        timestamp: row.timestamp,
        totalScore: row.total_score,
        liquidityScore: row.liquidity_score,
        holderGrowthScore: row.holder_growth_score,
        buyPressureScore: row.buy_pressure_score,
        volumeAccelScore: row.volume_accel_score,
        devSafetyScore: row.dev_safety_score,
        whitelistBoost: row.whitelist_boost,
        spreadScore: row.spread_score,
      }));
    } catch (err) {
      warn(`Error getting scores in range: ${err}`);
      return [];
    }
  }

  getSnapshotsForToken(
    currency: string,
    issuer: string,
    startTs: number,
    endTs: number
  ): MarketSnapshot[] {
    try {
      const rows = this.db.prepare(`
        SELECT * FROM market_snapshots
        WHERE token_currency = ? AND token_issuer = ?
          AND timestamp >= ? AND timestamp <= ?
        ORDER BY timestamp ASC
      `).all(currency, issuer, startTs, endTs) as any[];
      return rows.map(row => ({
        tokenCurrency: row.token_currency,
        tokenIssuer: row.token_issuer,
        timestamp: row.timestamp,
        priceXRP: row.price_xrp,
        liquidityXRP: row.liquidity_xrp,
        buyVolume5m: row.buy_volume_5m,
        sellVolume5m: row.sell_volume_5m,
        buyCount5m: row.buy_count_5m,
        sellCount5m: row.sell_count_5m,
        uniqueBuyers5m: row.unique_buyers_5m || 0,
        uniqueSellers5m: row.unique_sellers_5m || 0,
        priceChange5m: row.price_change_5m,
        priceChange15m: row.price_change_15m,
        priceChange1h: row.price_change_1h,
        holderEstimate: row.holder_estimate,
        spreadPercent: row.spread_percent,
      }));
    } catch (err) {
      warn(`Error getting snapshots for token: ${err}`);
      return [];
    }
  }

  // ==================== WHALE WALLETS ====================

  upsertWhaleWallet(
    address: string,
    wins: number,
    totalXrpProfit: number,
    firstSeen: number,
    lastSeen: number,
    winRatePct = 0,
    volumeXrp = 0
  ): void {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO whale_wallets (address, wins, total_xrp_profit, first_seen, last_seen, win_rate_pct, volume_xrp)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(address) DO UPDATE SET
          wins = excluded.wins,
          total_xrp_profit = excluded.total_xrp_profit,
          last_seen = excluded.last_seen,
          win_rate_pct = excluded.win_rate_pct,
          volume_xrp = excluded.volume_xrp
      `);
      this.runWithRetry(stmt, [address, wins, totalXrpProfit, firstSeen, lastSeen, winRatePct, volumeXrp]);
    } catch (err) {
      warn(`Error upserting whale wallet: ${err}`);
    }
  }

  getWhaleWallets(): { address: string; wins: number; totalXrpProfit: number; firstSeen: number; lastSeen: number; winRatePct: number; volumeXrp: number }[] {
    try {
      const rows = this.db.prepare('SELECT * FROM whale_wallets').all() as any[];
      return rows.map(row => ({
        address: row.address,
        wins: row.wins,
        totalXrpProfit: row.total_xrp_profit,
        firstSeen: row.first_seen,
        lastSeen: row.last_seen,
        winRatePct: row.win_rate_pct ?? 0,
        volumeXrp: row.volume_xrp ?? 0,
      }));
    } catch (err) {
      warn(`Error getting whale wallets: ${err}`);
      return [];
    }
  }

  // ==================== EXECUTION VALIDATION ====================

  saveIntendedPrice(
    currency: string,
    issuer: string,
    intendedPrice: number,
    sizeXrp: number
  ): void {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO execution_validation
        (token_currency, token_issuer, timestamp, intended_price, size_xrp)
        VALUES (?, ?, ?, ?, ?)
      `);
      this.runWithRetry(stmt, [currency, issuer, Date.now(), intendedPrice, sizeXrp]);
    } catch (err) {
      warn(`Error saving intended price: ${err}`);
    }
  }

  updateActualFill(
    currency: string,
    issuer: string,
    actualPrice: number
  ): void {
    try {
      // Update the most recent unfilled record for this token
      const stmt = this.db.prepare(`
        UPDATE execution_validation
        SET actual_price = ?,
            slippage_pct = ABS((? - intended_price) / intended_price) * 100
        WHERE token_currency = ? AND token_issuer = ?
          AND actual_price IS NULL
        ORDER BY timestamp DESC
        LIMIT 1
      `);
      this.runWithRetry(stmt, [actualPrice, actualPrice, currency, issuer]);
    } catch (err) {
      warn(`Error updating actual fill: ${err}`);
    }
  }

  getExecutionValidationRecords(): {
    id: number;
    tokenCurrency: string;
    tokenIssuer: string;
    timestamp: number;
    intendedPrice: number;
    actualPrice: number | null;
    slippagePct: number | null;
    sizeXrp: number;
  }[] {
    try {
      const rows = this.db.prepare('SELECT * FROM execution_validation ORDER BY timestamp DESC').all() as any[];
      return rows.map(row => ({
        id: row.id,
        tokenCurrency: row.token_currency,
        tokenIssuer: row.token_issuer,
        timestamp: row.timestamp,
        intendedPrice: row.intended_price,
        actualPrice: row.actual_price ?? null,
        slippagePct: row.slippage_pct ?? null,
        sizeXrp: row.size_xrp,
      }));
    } catch (err) {
      warn(`Error getting execution validation records: ${err}`);
      return [];
    }
  }

  // ==================== MISSED OPPORTUNITIES ====================

  ensureMissedOpportunitiesTable(): void {
    try {
      this.db.exec(SCHEMA.missedOpportunities);
      this.db.exec(SCHEMA.profileStats);
      this.db.exec(SCHEMA.shadowTrades);
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_missed_opp_currency ON missed_opportunities(currency, issuer)`);
      // Required by ON CONFLICT(currency, issuer, skipped_at) in upsertMissedOpportunity.
      this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_missed_opp_natural_key ON missed_opportunities(currency, issuer, skipped_at)`);
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_profile_stats_profile ON profile_stats(profile, closed_at)`);
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_shadow_currency ON shadow_trades(currency, issuer, skipped_at)`);
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_shadow_unresolved ON shadow_trades(resolved_at, skipped_at)`);
    } catch { /* already exists */ }
  }

  // ==================== STRATEGY V2 STREAM OBSERVATION ====================
  /**
   * An eligible STREAM signal which the PAPER strategy would have traded.
   * This inserts ONLY a shadow observation, never a PAPER trade or any cash /
   * inventory mutation. Deduped by exact ledger issue per UTC 15m bucket.
   * We deliberately DO NOT use the legacy shadow resolver's delayed spot
   * price as historical window highs; the forensic report queries dated
   * market_snapshots and reports missing observation coverage explicitly.
   */
  recordPaperStreamShadowSignal(data: {
    currency: string; issuer: string; rawCurrency: string;
    observedAt: number; priceXRP: number; priceObservedAt?: number | null;
    poolXrpReserve: number; uniqueBuyers: number;
    buyCount5m: number; sellCount5m: number;
    buySellRatio: number; buyVolumeXRP: number; newWalletBuys: number;
    signalType: 'stream' | 'whale_stream'; assignedProfile: string;
    approvedSizeXRP: number; roundTripLossPct: number;
  }): boolean {
    const numbers = [
      data.observedAt, data.priceXRP, data.poolXrpReserve,
      data.uniqueBuyers, data.buyCount5m, data.sellCount5m,
      data.buySellRatio, data.buyVolumeXRP, data.newWalletBuys,
      data.approvedSizeXRP, data.roundTripLossPct,
    ];
    if (!data.currency || !data.issuer || !data.rawCurrency ||
        !data.assignedProfile || !['stream','whale_stream'].includes(data.signalType) ||
        numbers.some(x => !Number.isFinite(x)) ||
        data.observedAt <= 0 || data.priceXRP <= 0 || data.poolXrpReserve <= 0 ||
        data.approvedSizeXRP <= 0 || data.roundTripLossPct < 0 ||
        data.uniqueBuyers < 0 || data.buyCount5m < 0 || data.sellCount5m < 0 ||
        data.buyVolumeXRP < 0 || data.newWalletBuys < 0 ||
        data.buySellRatio < 0 || data.buySellRatio > 1 ||
        [data.uniqueBuyers,data.buyCount5m,data.sellCount5m,data.newWalletBuys]
          .some(x => !Number.isInteger(x))) {
      throw new Error('Invalid eligible PAPER STREAM shadow signal evidence');
    }
    const ts = data.priceObservedAt ?? null;
    if (ts !== null && (!Number.isFinite(ts) || ts <= 0 ||
        ts > data.observedAt + 30000)) {
      throw new Error('Invalid STREAM source quote timestamp');
    }
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO paper_stream_shadow_signals
        (token_currency, token_issuer, raw_currency, observed_at,
         bucket_15m, price_xrp, price_observed_at, pool_xrp_reserve,
         unique_buyers, buy_count_5m, sell_count_5m, buy_sell_ratio,
         buy_volume_xrp, new_wallet_buys, signal_type, assigned_profile,
         approved_size_xrp, round_trip_loss_pct)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = this.runWithRetry(stmt, [
      data.currency,data.issuer,data.rawCurrency,data.observedAt,
      Math.floor(data.observedAt / (15*60*1000)),
      data.priceXRP,ts,data.poolXrpReserve,data.uniqueBuyers,
      data.buyCount5m,data.sellCount5m,data.buySellRatio,
      data.buyVolumeXRP,data.newWalletBuys,data.signalType,
      data.assignedProfile,data.approvedSizeXRP,data.roundTripLossPct,
    ]);
    if (result.changes === 1) {
      this.recordOpportunityEvent({tokenCurrency:data.currency,tokenIssuer:data.issuer,
        rawCurrency:data.rawCurrency,observedAt:data.observedAt,
        eventType:'stream_qualified',source:data.signalType,priceXRP:data.priceXRP,
        detail:'buyers='+data.uniqueBuyers+' buyVolXRP='+data.buyVolumeXRP.toFixed(2)});
    }
    return result.changes === 1;
  }

  // ==================== SHADOW BACKTEST ====================

  recordShadowTrade(data: {
    currency: string; issuer: string; rawCurrency?: string;
    signalType: string; rejectReason: string;
    priceAtSignal: number; poolXrpReserve?: number; signalScore?: number;
    skippedAt: number;
  }): void {
    try {
      const stmt = this.db.prepare(`
        INSERT OR IGNORE INTO shadow_trades
          (currency, issuer, raw_currency, signal_type, reject_reason,
           price_at_signal, pool_xrp_reserve, signal_score, skipped_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      this.runWithRetry(stmt, [
        data.currency, data.issuer, data.rawCurrency ?? null,
        data.signalType, data.rejectReason,
        data.priceAtSignal, data.poolXrpReserve ?? null, data.signalScore ?? null,
        data.skippedAt,
      ]);
    } catch (err) {
      warn(`[ShadowTrade] record error: ${err}`);
    }
  }

  resolveShadowTrades(
    getPrice: (currency: string, issuer: string, rawCurrency?: string | null) => Promise<number | null>
  ): void {
    // Resolve shadow trades that are old enough but not yet resolved.
    // 15m, 1h, 4h windows — only resolve once all windows have elapsed.
    const now = Date.now();
    const RESOLVE_AFTER_MS = 4 * 60 * 60 * 1000; // resolve after 4h
    try {
      const rows = this.db.prepare(`
        SELECT * FROM shadow_trades
        WHERE resolved_at IS NULL AND skipped_at < ?
        ORDER BY skipped_at ASC LIMIT 20
      `).all(now - RESOLVE_AFTER_MS) as any[];

      if (rows.length === 0) return;

      (async () => { for (const row of rows) {
        // Best effort: use current price as proxy for "what it is now"
        // Real resolution needs price history — use missed_opportunities max_price fields if available
        const missedRow = this.db.prepare(`
          SELECT max_price_10m, max_price_30m, max_price_60m
          FROM missed_opportunities
          WHERE currency = ? AND issuer = ? AND ABS(skipped_at - ?) < 5*60*1000
          LIMIT 1
        `).get(row.currency, row.issuer, row.skipped_at) as any;

        const base = row.price_at_signal;
        const pct = (p: number | null) => p && base > 0 ? ((p - base) / base) * 100 : null;

        // FIX #37: fall back to live price when missed_opportunities has no match.
        // Without this, resolved_at gets set but pct_gain_* stays NULL forever.
        let max15m = missedRow?.max_price_10m ?? null;
        let max1h  = missedRow?.max_price_30m ?? null;
        let max4h  = missedRow?.max_price_60m ?? null;

        // If no missed_opportunity match, use live price as 4h proxy (best effort)
        if (max1h === null && max4h === null) {
          const livePrice = await getPrice(row.raw_currency || row.currency, row.issuer, row.raw_currency);
          if (livePrice && livePrice > 0) {
            max4h = livePrice;
            // 15m/1h unknown — leave null (honest about missing data)
          }
        }

        this.db.prepare(`
          UPDATE shadow_trades SET
            max_price_15m = ?, max_price_1h = ?, max_price_4h = ?,
            pct_gain_15m = ?, pct_gain_1h = ?, pct_gain_4h = ?,
            resolved_at = ?
          WHERE id = ?
        `).run(
          max15m, max1h, max4h,
          pct(max15m), pct(max1h), pct(max4h),
          now, row.id
        );
      } })().catch(err => warn(`[ShadowBacktest] async error: ${err}`));

      if (rows.length > 0) {
        debug(`[ShadowBacktest] Resolved ${rows.length} shadow trades`);
      }
    } catch (err) {
      warn(`[ShadowBacktest] resolve error: ${err}`);
    }
  }

  getShadowStats(): Record<string, { count: number; avgGain1h: number; avgGain4h: number; missedWinners: number }> {
    try {
      const rows = this.db.prepare(`
        SELECT reject_reason,
          COUNT(*) as cnt,
          ROUND(AVG(pct_gain_1h), 1) as avg_1h,
          ROUND(AVG(pct_gain_4h), 1) as avg_4h,
          SUM(CASE WHEN pct_gain_1h > 50 THEN 1 ELSE 0 END) as winners_1h
        FROM shadow_trades
        WHERE resolved_at IS NOT NULL
        GROUP BY reject_reason
        ORDER BY cnt DESC
      `).all() as any[];

      const result: Record<string, any> = {};
      for (const r of rows) {
        result[r.reject_reason] = {
          count: r.cnt,
          avgGain1h: r.avg_1h ?? 0,
          avgGain4h: r.avg_4h ?? 0,
          missedWinners: r.winners_1h ?? 0,
        };
      }
      return result;
    } catch {
      return {};
    }
  }

  saveMissedOpportunity(sig: import('../market/missedOpportunityTracker').MissedSignal): void {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO missed_opportunities
          (currency, issuer, skipped_at, skip_reason, price_at_skip, pool_xrp_reserve,
           max_price_10m, max_price_30m, max_price_60m, pct_gain_10m, pct_gain_30m, pct_gain_60m)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      `);
      this.runWithRetry(stmt, [
        sig.currency, sig.issuer, sig.skippedAt, sig.skipReason,
        sig.priceAtSkip, sig.poolXrpReserve,
        sig.maxPrice10m ?? null, sig.maxPrice30m ?? null, sig.maxPrice60m ?? null,
        sig.pctGain10m ?? null, sig.pctGain30m ?? null, sig.pctGain60m ?? null,
      ]);
    } catch (err) {
      warn(`Error saving missed opportunity: ${err}`);
    }
  }

  /**
   * Upsert a missed opportunity — inserts immediately on skip, updates when follow-up prices arrive.
   * Uses skipped_at + currency + issuer as the natural key.
   */
  upsertMissedOpportunity(sig: import('../market/missedOpportunityTracker').MissedSignal): void {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO missed_opportunities
          (currency, issuer, skipped_at, skip_reason, price_at_skip, pool_xrp_reserve,
           max_price_10m, max_price_30m, max_price_60m, pct_gain_10m, pct_gain_30m, pct_gain_60m)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(currency, issuer, skipped_at) DO UPDATE SET
          max_price_10m = COALESCE(excluded.max_price_10m, max_price_10m),
          max_price_30m = COALESCE(excluded.max_price_30m, max_price_30m),
          max_price_60m = COALESCE(excluded.max_price_60m, max_price_60m),
          pct_gain_10m  = COALESCE(excluded.pct_gain_10m,  pct_gain_10m),
          pct_gain_30m  = COALESCE(excluded.pct_gain_30m,  pct_gain_30m),
          pct_gain_60m  = COALESCE(excluded.pct_gain_60m,  pct_gain_60m)
      `);
      this.runWithRetry(stmt, [
        sig.currency, sig.issuer, sig.skippedAt, sig.skipReason,
        sig.priceAtSkip, sig.poolXrpReserve,
        sig.maxPrice10m ?? null, sig.maxPrice30m ?? null, sig.maxPrice60m ?? null,
        sig.pctGain10m ?? null, sig.pctGain30m ?? null, sig.pctGain60m ?? null,
      ]);
    } catch (err) {
      warn(`Error upserting missed opportunity: ${err}`);
    }
  }

  getTopMissedOpportunities(limit = 20): any[] {
    try {
      return this.db.prepare(`
        SELECT * FROM missed_opportunities
        WHERE pct_gain_60m IS NOT NULL
        ORDER BY pct_gain_60m DESC
        LIMIT ?
      `).all(limit) as any[];
    } catch { return []; }
  }

  // ==================== PROFILE STATS ====================

  saveProfileStat(stat: {
    profile: string;
    closedAt: number;
    tokenCurrency: string;
    tokenIssuer: string;
    entryXRP: number;
    exitXRP: number;
    pnlXRP: number;
    pnlPct: number;
    holdMs: number;
    exitReason: string;
    won: boolean;
  }): void {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO profile_stats
          (profile, closed_at, token_currency, token_issuer,
           entry_xrp, exit_xrp, pnl_xrp, pnl_pct, hold_ms, exit_reason, won)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
      `);
      this.runWithRetry(stmt, [
        stat.profile, stat.closedAt, stat.tokenCurrency, stat.tokenIssuer,
        stat.entryXRP, stat.exitXRP, stat.pnlXRP, stat.pnlPct,
        stat.holdMs, stat.exitReason, stat.won ? 1 : 0,
      ]);
    } catch (err) {
      warn(`Error saving profile stat: ${err}`);
    }
  }

  /**
   * Compute profile stats directly from paper_trades — never from the profile_stats
   * accumulator table, which carries stale data across DB resets and restarts.
   * pnl_percent is capped at ±999 to prevent single outlier trades from corrupting averages.
   */
  getProfileStats(): Record<string, {
    trades: number;
    wins: number;
    winRate: number;
    avgWinPct: number;
    avgLossPct: number;
    bestRunPct: number;
    avgHoldMs: number;
    netPnlXRP: number;
  }> {
    try {
      const rows = this.db.prepare(`
        SELECT
          trade_profile                                        AS profile,
          COUNT(*)                                            AS trades,
          SUM(CASE WHEN pnl_xrp > 0 THEN 1 ELSE 0 END)      AS wins,
          SUM(CASE WHEN pnl_xrp > 0
            THEN MIN(MAX(pnl_percent, -999), 999) ELSE 0 END) AS sum_win_pct,
          SUM(CASE WHEN pnl_xrp <= 0
            THEN MIN(MAX(pnl_percent, -999), 999) ELSE 0 END) AS sum_loss_pct,
          MAX(MIN(MAX(pnl_percent, -999), 999))               AS best_pct,
          AVG(CASE WHEN exit_timestamp IS NOT NULL
            THEN exit_timestamp - entry_timestamp ELSE NULL END) AS avg_hold_ms,
          SUM(COALESCE(pnl_xrp, 0))                          AS net_pnl_xrp
        FROM paper_trades
        WHERE status = 'closed'
          AND trade_profile IS NOT NULL
          AND pnl_xrp IS NOT NULL
          AND ABS(COALESCE(pnl_xrp, 0)) <= MAX(1000, ABS(COALESCE(entry_amount_xrp, 0)) * 20)
        GROUP BY trade_profile
      `).all() as any[];
      const result: Record<string, any> = {};
      for (const row of rows) {
        const wins    = row.wins   ?? 0;
        const losses  = row.trades - wins;
        result[row.profile] = {
          trades:     row.trades,
          wins,
          winRate:    row.trades > 0 ? wins / row.trades : 0,
          avgWinPct:  wins   > 0 ? row.sum_win_pct  / wins   : 0,
          avgLossPct: losses > 0 ? row.sum_loss_pct / losses : 0,
          bestRunPct: row.best_pct ?? 0,
          avgHoldMs:  row.avg_hold_ms ?? 0,
          netPnlXRP:  row.net_pnl_xrp ?? 0,
        };
      }
      return result;
    } catch { return {}; }
  }

  /**
   * Bounded observation-history retention for compact PAPER recovery only.
   * Deletes up to 5000 aged rows from each ephemeral history table per pass.
   * Never touches tokens, token_archive, paper_trades, alerts, or trading logs.
   * SQLite reuses freed pages; this does not VACUUM or grow a second DB copy.
   */
  pruneRecoveryObservations(): void {
    if (!this.isCompactRecoveryDb ||
        process.env.BOT_ENABLE_OBSERVATION_RETENTION !== '1' ||
        process.env.MODE !== 'PAPER' ||
        process.env.LIVE_TRADING !== 'false') {
      warn('Recovery observation retention skipped (requires explicit PAPER-only opt-in)');
      return;
    }
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    try {
      const removed: Record<string, number> = {};
      this.db.transaction(() => {
        for (const table of ['market_snapshots', 'scores', 'risk_flags']) {
          // Table identifiers are from this fixed internal allowlist.
          const result = this.db.prepare(`
            DELETE FROM ${table} WHERE id IN (
              SELECT id FROM ${table} WHERE timestamp < ? ORDER BY timestamp LIMIT 5000
            )
          `).run(cutoff);
          removed[table] = result.changes;
        }
      })();
      if (Object.values(removed).some(n => n > 0)) {
        info(`Recovery observation retention (7d): ${JSON.stringify(removed)}`);
      }
    } catch (err) {
      warn(`Recovery observation retention failed: ${err}`);
    }
  }

  /**
   * Close database connection
   */
  close(): void {
    try {
      this.db.close();
      info('Database closed');
    } catch (err) {
      warn(`Error closing database: ${err}`);
    }
  }
}
