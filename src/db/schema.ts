/**
 * Database Schema Definitions
 */

export const SCHEMA = {
  tokens: `
    CREATE TABLE IF NOT EXISTS tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      currency TEXT NOT NULL,
      issuer TEXT NOT NULL,
      first_seen INTEGER NOT NULL,
      last_updated INTEGER NOT NULL,
      UNIQUE(currency, issuer)
    )
  `,

  ammPools: `
    CREATE TABLE IF NOT EXISTS amm_pools (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pool_id TEXT NOT NULL UNIQUE,
      asset1_currency TEXT NOT NULL,
      asset1_issuer TEXT,
      asset2_currency TEXT NOT NULL,
      asset2_issuer TEXT,
      amount1 TEXT NOT NULL,
      amount2 TEXT NOT NULL,
      lp_balance TEXT,
      trading_fee INTEGER,
      created_at INTEGER NOT NULL,
      last_updated INTEGER NOT NULL
    )
  `,

  marketSnapshots: `
    CREATE TABLE IF NOT EXISTS market_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_currency TEXT NOT NULL,
      token_issuer TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      price_xrp REAL,
      liquidity_xrp REAL,
      buy_volume_5m REAL DEFAULT 0,
      sell_volume_5m REAL DEFAULT 0,
      buy_count_5m INTEGER DEFAULT 0,
      sell_count_5m INTEGER DEFAULT 0,
      unique_buyers_5m INTEGER DEFAULT 0,
      unique_sellers_5m INTEGER DEFAULT 0,
      price_change_5m REAL,
      price_change_15m REAL,
      price_change_1h REAL,
      holder_estimate INTEGER,
      spread_percent REAL
    )
  `,

  riskFlags: `
    CREATE TABLE IF NOT EXISTS risk_flags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_currency TEXT NOT NULL,
      token_issuer TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      low_liquidity INTEGER DEFAULT 0,
      wide_spread INTEGER DEFAULT 0,
      concentrated_supply INTEGER DEFAULT 0,
      dev_dumping INTEGER DEFAULT 0,
      liquidity_removed INTEGER DEFAULT 0,
      low_holders INTEGER DEFAULT 0,
      no_buy_activity INTEGER DEFAULT 0,
      single_wallet_price INTEGER DEFAULT 0,
      flags_text TEXT
    )
  `,

  scores: `
    CREATE TABLE IF NOT EXISTS scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_currency TEXT NOT NULL,
      token_issuer TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      total_score INTEGER NOT NULL,
      liquidity_score INTEGER,
      holder_growth_score INTEGER,
      buy_pressure_score INTEGER,
      volume_accel_score INTEGER,
      dev_safety_score INTEGER,
      whitelist_boost INTEGER,
      spread_score INTEGER
    )
  `,

  paperTrades: `
    CREATE TABLE IF NOT EXISTS paper_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_currency TEXT NOT NULL,
      token_issuer TEXT NOT NULL,
      entry_price_xrp REAL NOT NULL,
      entry_amount_xrp REAL NOT NULL,
      entry_timestamp INTEGER NOT NULL,
      entry_score INTEGER NOT NULL,
      entry_reason TEXT,
      exit_price_xrp REAL,
      exit_timestamp INTEGER,
      exit_score INTEGER,
      exit_reason TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      pnl_xrp REAL,
      pnl_percent REAL,
      slippage_estimate REAL DEFAULT 0,
      fees_paid REAL DEFAULT 0,
      tp1_hit INTEGER DEFAULT 0,
      tp2_hit INTEGER DEFAULT 0,
      trailing_stop_active INTEGER DEFAULT 0,
      remaining_position REAL DEFAULT 100
    )
  `,

  alerts: `
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_type TEXT NOT NULL,
      token_currency TEXT,
      token_issuer TEXT,
      timestamp INTEGER NOT NULL,
      message TEXT,
      score INTEGER,
      sent INTEGER DEFAULT 1
    )
  `,

  dailySummaries: `
    CREATE TABLE IF NOT EXISTS daily_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL UNIQUE,
      trades_opened INTEGER DEFAULT 0,
      trades_closed INTEGER DEFAULT 0,
      total_pnl_xrp REAL DEFAULT 0,
      win_rate REAL DEFAULT 0,
      max_drawdown REAL DEFAULT 0,
      best_trade REAL DEFAULT 0,
      worst_trade REAL DEFAULT 0
    )
  `,
};

// Index definitions for performance
export const INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_tokens_currency ON tokens(currency)',
  'CREATE INDEX IF NOT EXISTS idx_tokens_issuer ON tokens(issuer)',
  'CREATE INDEX IF NOT EXISTS idx_market_snapshots_token ON market_snapshots(token_currency, token_issuer, timestamp)',
  'CREATE INDEX IF NOT EXISTS idx_scores_token ON scores(token_currency, token_issuer, timestamp)',
  'CREATE INDEX IF NOT EXISTS idx_paper_trades_status ON paper_trades(status)',
  'CREATE INDEX IF NOT EXISTS idx_paper_trades_entry ON paper_trades(entry_timestamp)',
  'CREATE INDEX IF NOT EXISTS idx_alerts_type ON alerts(alert_type, timestamp)',
  'CREATE INDEX IF NOT EXISTS idx_daily_summaries_date ON daily_summaries(date)',
];
