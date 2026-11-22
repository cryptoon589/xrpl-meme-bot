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
      remaining_position REAL DEFAULT 100,
      xrp_returned REAL DEFAULT 0,
      trade_profile TEXT,
      trade_source TEXT
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

  whaleWallets: `
    CREATE TABLE IF NOT EXISTS whale_wallets (
      address TEXT PRIMARY KEY,
      wins INTEGER DEFAULT 0,
      total_xrp_profit REAL DEFAULT 0,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL
    )
  `,

  executionValidation: `
    CREATE TABLE IF NOT EXISTS execution_validation (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_currency TEXT NOT NULL,
      token_issuer TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      intended_price REAL NOT NULL,
      actual_price REAL,
      slippage_pct REAL,
      size_xrp REAL NOT NULL
    )
  `,

  missedOpportunities: `
    CREATE TABLE IF NOT EXISTS missed_opportunities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      currency TEXT NOT NULL,
      issuer TEXT NOT NULL,
      skipped_at INTEGER NOT NULL,
      skip_reason TEXT NOT NULL,
      price_at_skip REAL NOT NULL,
      pool_xrp_reserve REAL NOT NULL,
      max_price_10m REAL,
      max_price_30m REAL,
      max_price_60m REAL,
      pct_gain_10m REAL,
      pct_gain_30m REAL,
      pct_gain_60m REAL,
      UNIQUE(currency, issuer, skipped_at)
    )
  `,

  // Shadow backtest: every rejected/skipped signal is recorded with entry price.
  // A background job periodically resolves max_price_Xm so we can measure
  // "what would have happened" for each rejection reason.
  shadowTrades: `
    CREATE TABLE IF NOT EXISTS shadow_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      currency TEXT NOT NULL,
      issuer TEXT NOT NULL,
      raw_currency TEXT,
      signal_type TEXT NOT NULL,
      reject_reason TEXT NOT NULL,
      price_at_signal REAL NOT NULL,
      pool_xrp_reserve REAL,
      signal_score REAL,
      skipped_at INTEGER NOT NULL,
      -- Filled in later by shadow resolver
      max_price_15m REAL,
      max_price_1h REAL,
      max_price_4h REAL,
      pct_gain_15m REAL,
      pct_gain_1h REAL,
      pct_gain_4h REAL,
      resolved_at INTEGER,
      UNIQUE(currency, issuer, skipped_at)
    )
  `,

  // Strategy V2: only risk-eligible STREAM signals are recorded here.
  // No simulated token purchase, bankroll debit, or phantom P&L is created.
  // Bucket uniqueness keeps frequent callbacks from oversampling one XRPL
  // issue. Future market price observations are analyzed offline by timestamp.
  paperStreamShadowSignals: `
    CREATE TABLE IF NOT EXISTS paper_stream_shadow_signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_currency TEXT NOT NULL,
      token_issuer TEXT NOT NULL,
      raw_currency TEXT NOT NULL,
      observed_at INTEGER NOT NULL,
      bucket_15m INTEGER NOT NULL,
      price_xrp REAL NOT NULL CHECK (price_xrp > 0),
      price_observed_at INTEGER,
      pool_xrp_reserve REAL,
      unique_buyers INTEGER NOT NULL,
      buy_count_5m INTEGER NOT NULL,
      sell_count_5m INTEGER NOT NULL,
      buy_sell_ratio REAL NOT NULL,
      buy_volume_xrp REAL NOT NULL,
      new_wallet_buys INTEGER NOT NULL,
      signal_type TEXT NOT NULL,
      assigned_profile TEXT NOT NULL,
      approved_size_xrp REAL NOT NULL,
      round_trip_loss_pct REAL NOT NULL,
      UNIQUE(raw_currency, token_issuer, bucket_15m)
    )
  `,

  // V2.1: compact, append-only PAPER opportunity event breadcrumbs.
  // Stores BOT first-sighting (not issuance), qualified signals and actual
  // simulated trade boundaries. Never contains wallet credentials or fills.
  paperOpportunityEvents: `
    CREATE TABLE IF NOT EXISTS paper_opportunity_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_currency TEXT NOT NULL,
      token_issuer TEXT NOT NULL,
      raw_currency TEXT NOT NULL,
      observed_at INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      source TEXT,
      price_xrp REAL,
      trade_id INTEGER,
      detail TEXT,
      dedup_key TEXT NOT NULL UNIQUE
    )
  `,

  // New-paper ledger: never backfill fabricated cash into existing historic DB.
  paperCashState: `
    CREATE TABLE IF NOT EXISTS paper_cash_state (
      singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      bankroll_xrp REAL NOT NULL CHECK (bankroll_xrp >= 0),
      updated_at INTEGER NOT NULL
    )
  `,
  // Exact remaining quantity for each trade, persisted atomically with updates.
  paperInventory: `
    CREATE TABLE IF NOT EXISTS paper_inventory (
      trade_id INTEGER PRIMARY KEY,
      tokens_held REAL NOT NULL CHECK (tokens_held >= 0),
      updated_at INTEGER NOT NULL
    )
  `,
  // Persist per-position trailing high, learned TP settings and exit profile.
  // This does not replace economic PAPER trade/inventory/cash checkpoints.
  paperPositionRuntime: `
    CREATE TABLE IF NOT EXISTS paper_position_runtime (
      trade_id INTEGER PRIMARY KEY,
      state_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `,
  profileStats: `
    CREATE TABLE IF NOT EXISTS profile_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile TEXT NOT NULL,
      closed_at INTEGER NOT NULL,
      token_currency TEXT NOT NULL,
      token_issuer TEXT NOT NULL,
      entry_xrp REAL NOT NULL,
      exit_xrp REAL NOT NULL,
      pnl_xrp REAL NOT NULL,
      pnl_pct REAL NOT NULL,
      hold_ms INTEGER NOT NULL,
      exit_reason TEXT NOT NULL,
      won INTEGER NOT NULL
    )
  `,
};

// Compatibility view: older queries used 'tracked_tokens' — the real table is 'tokens'
// This view makes both names work without a destructive rename.
export const VIEWS = [
  `CREATE VIEW IF NOT EXISTS tracked_tokens AS
   SELECT id, currency, issuer, first_seen, last_updated, raw_currency
   FROM tokens`,
];

// Index definitions for performance
export const INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_tokens_currency ON tokens(currency)',
  'CREATE INDEX IF NOT EXISTS idx_tokens_issuer ON tokens(issuer)',
  'CREATE INDEX IF NOT EXISTS idx_market_snapshots_token ON market_snapshots(token_currency, token_issuer, timestamp)',
  'CREATE INDEX IF NOT EXISTS idx_scores_token ON scores(token_currency, token_issuer, timestamp)',
  'CREATE INDEX IF NOT EXISTS idx_paper_trades_status ON paper_trades(status)',
  'CREATE INDEX IF NOT EXISTS idx_paper_trades_entry ON paper_trades(entry_timestamp)',
  'CREATE INDEX IF NOT EXISTS idx_stream_shadow_observed_at ON paper_stream_shadow_signals(observed_at)',
  'CREATE INDEX IF NOT EXISTS idx_paper_opp_issue_time ON paper_opportunity_events(raw_currency,token_issuer,observed_at)',
  'CREATE INDEX IF NOT EXISTS idx_paper_opp_event_time ON paper_opportunity_events(event_type,observed_at)',
  'CREATE INDEX IF NOT EXISTS idx_alerts_type ON alerts(alert_type, timestamp)',
  'CREATE INDEX IF NOT EXISTS idx_daily_summaries_date ON daily_summaries(date)',
];
