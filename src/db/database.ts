/**
 * Database Module using SQLite (better-sqlite3)
 */

import BetterSQLite3 from 'better-sqlite3';
import path from 'path';
import { SCHEMA, INDEXES } from './schema';
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
import { info, warn } from '../utils/logger';

export class Database {
  private db: BetterSQLite3.Database;
  private readonly MAX_RETRIES = 3;
  private readonly RETRY_DELAY_MS = 100;

  constructor(dbPath?: string) {
    const filePath = dbPath || path.join(process.cwd(), 'data', 'meme_bot.db');

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
    // Create tables with retry
    for (const [name, sql] of Object.entries(SCHEMA)) {
      try {
        this.execWithRetry(sql);
      } catch (err) {
        warn(`Error creating table ${name}: ${err}`);
      }
    }

    // Create indexes with retry
    for (const indexSql of INDEXES) {
      try {
        this.execWithRetry(indexSql);
      } catch (err) {
        warn(`Error creating index: ${err}`);
      }
    }
  }

  // ==================== TOKENS ====================

  saveToken(token: TrackedToken): void {
    try {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO tokens (currency, issuer, first_seen, last_updated)
        VALUES (?, ?, ?, ?)
      `);
      this.runWithRetry(stmt, [token.currency, token.issuer, token.firstSeen, token.lastUpdated]);
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
      }));
    } catch (err) {
      warn(`Error getting tracked tokens: ${err}`);
      return [];
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
        Date.now(),
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

  // ==================== PAPER TRADES ====================

  savePaperTrade(trade: PaperTrade): void {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO paper_trades
        (token_currency, token_issuer, entry_price_xrp, entry_amount_xrp,
         entry_timestamp, entry_score, entry_reason, exit_price_xrp,
         exit_timestamp, exit_score, exit_reason, status, pnl_xrp,
         pnl_percent, slippage_estimate, fees_paid, tp1_hit, tp2_hit,
         trailing_stop_active, remaining_position)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        trade.remainingPosition
      ]);

      // Set the ID on the trade object
      const result: any = this.db.prepare('SELECT last_insert_rowid() as id').get();
      trade.id = Number(result.id);
    } catch (err) {
      warn(`Error saving paper trade: ${err}`);
    }
  }

  updatePaperTrade(trade: PaperTrade): void {
    try {
      const stmt = this.db.prepare(`
        UPDATE paper_trades
        SET exit_price_xrp = ?, exit_timestamp = ?, exit_score = ?,
            exit_reason = ?, status = ?, pnl_xrp = ?, pnl_percent = ?,
            fees_paid = ?, tp1_hit = ?, tp2_hit = ?,
            trailing_stop_active = ?, remaining_position = ?
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
        trade.id
      ]);
    } catch (err) {
      warn(`Error updating paper trade: ${err}`);
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
      tp1Hit: row.tp1_hit === 1,
      tp2Hit: row.tp2_hit === 1,
      trailingStopActive: row.trailing_stop_active === 1,
      remainingPosition: row.remaining_position,
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
