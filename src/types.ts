/**
 * Core type definitions for XRPL Meme Bot
 */

// Token representation
export interface TrackedToken {
  currency: string;      // decoded display name
  rawCurrency?: string;  // original hex code (used for API calls)
  issuer: string;
  firstSeen: number;
  lastUpdated: number;
}

// AMM Pool data
export interface AMMPool {
  asset1: { currency: string; issuer?: string };
  asset2: { currency: string; issuer?: string };
  amount1: string; // in drops or token units
  amount2: string;
  lpBalance: string;
  tradingFee: number; // basis points
  poolId: string;
  createdAt: number;
  lastUpdated: number;
}

// Market snapshot for a token
export interface MarketSnapshot {
  tokenCurrency: string;
  tokenIssuer: string;
  timestamp: number;
  priceXRP: number | null;
  liquidityXRP: number | null;
  buyVolume5m: number;
  sellVolume5m: number;
  buyCount5m: number;
  sellCount5m: number;
  uniqueBuyers5m: number;
  uniqueSellers5m: number;
  priceChange5m: number | null; // percentage
  priceChange15m: number | null;
  priceChange1h: number | null;
  holderEstimate: number | null;
  spreadPercent: number | null;
}

// Risk assessment
export interface RiskFlags {
  lowLiquidity: boolean;
  wideSpread: boolean;
  concentratedSupply: boolean;
  devDumping: boolean;
  liquidityRemoved: boolean;
  lowHolderCount: boolean;
  noBuyActivity: boolean;
  singleWalletPrice: boolean;
  flags: string[];
}

// Token score
export interface TokenScore {
  tokenCurrency: string;
  tokenIssuer: string;
  timestamp: number;
  totalScore: number; // 0-100
  liquidityScore: number;
  holderGrowthScore: number;
  buyPressureScore: number;
  volumeAccelScore: number;
  devSafetyScore: number;
  whitelistBoost: number;
  spreadScore: number;
}

// Paper trade record
export interface PaperTrade {
  id?: number;
  tokenCurrency: string;
  tokenIssuer: string;
  entryPriceXRP: number;
  entryAmountXRP: number;
  entryTimestamp: number;
  entryScore: number;
  entryReason: string;
  exitPriceXRP: number | null;
  exitTimestamp: number | null;
  exitScore: number | null;
  exitReason: string | null;
  status: 'open' | 'closed' | 'partial';
  pnlXRP: number | null;
  pnlPercent: number | null;
  slippageEstimate: number;
  feesPaid: number;
  xrpReturned: number;  // cumulative XRP returned (partial + final closes)
  tp1Hit: boolean;
  tp2Hit: boolean;
  trailingStopActive: boolean;
  remainingPosition: number; // percentage 0-100
}

// Daily PnL summary
export interface DailySummary {
  date: string; // YYYY-MM-DD
  tradesOpened: number;
  tradesClosed: number;
  totalPnLXRP: number;
  winRate: number;
  maxDrawdown: number;
  bestTrade: number;
  worstTrade: number;
}

// Alert payload
export interface AlertPayload {
  type:
    | 'new_token'
    | 'high_score'
    | 'buy_burst'
    | 'amm_pool'
    | 'liquidity_added'
    | 'liquidity_removed'
    | 'whale_buy'
    | 'dev_sell'
    | 'paper_trade_opened'
    | 'paper_trade_partial_close'
    | 'paper_trade_closed'
    | 'daily_summary'
    | 'hourly_summary';
  tokenCurrency?: string;
  tokenIssuer?: string;
  score?: number;
  liquidity?: number | null;
  price?: number | null;
  change5m?: number | null;
  change15m?: number | null;
  change1h?: number | null;
  holders?: number | null;
  buyPressure?: string;
  riskFlags?: string[];
  action?: string;
  explorerLinks?: {
    token: string;
    issuer: string;
    amm?: string;
  };
  paperTrade?: PaperTrade;
  message: string;
}

// Configuration
export interface BotConfig {
  xrplWsUrl: string;
  telegramBotToken: string;
  telegramChatId: string;
  mode: 'WATCH' | 'PAPER' | 'AUTO';
  minLiquidityXRP: number;
  minScoreAlert: number;
  minScorePaperTrade: number;
  startingBankrollXRP: number;
  minTradeXRP: number;
  maxTradeXRP: number;
  maxOpenTrades: number;
  maxDailyLossXRP: number;
  weights: {
    liquidity: number;
    holderGrowth: number;
    buyPressure: number;
    volumeAccel: number;
    devSafety: number;
    whitelistBoost: number;
    spread: number;
  };
  logLevel: string;
  liveTrading: boolean;       // true = real txs, false = dry-run simulation
}

// Transaction metadata wrapper
export interface TxEvent {
  hash: string;
  ledgerIndex: number;
  timestamp: number;
  txType: string;
  account: string;
  meta: any;
}
