/**
 * Configuration loader from environment variables
 */

import dotenv from 'dotenv';
import { BotConfig } from './types';
import { error, warn } from './utils/logger';

// Load .env file
dotenv.config();

export type { BotConfig };

export function loadConfig(): BotConfig {
  const mode = (process.env.MODE || 'WATCH').toUpperCase() as 'WATCH' | 'PAPER' | 'AUTO';

  if (!['WATCH', 'PAPER', 'AUTO'].includes(mode)) {
    error(`Invalid MODE: ${mode}. Defaulting to WATCH`);
  }

  const config: BotConfig = {
    xrplWsUrl: process.env.XRPL_WS_URL || 'wss://rpc.xrplclaw.com/ws',
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
    mode: mode === 'AUTO' ? 'WATCH' : mode, // AUTO is stub-only, fallback to WATCH
    minLiquidityXRP: parseInt(process.env.MIN_LIQUIDITY_XRP || '2000', 10),
    minScoreAlert: parseInt(process.env.MIN_SCORE_ALERT || '75', 10),
    minScorePaperTrade: parseInt(process.env.MIN_SCORE_PAPER_TRADE || '80', 10),
    startingBankrollXRP: parseInt(process.env.STARTING_BANKROLL_XRP || '100', 10),
    maxTradeXRP: parseInt(process.env.MAX_TRADE_XRP || '25', 10),
    maxOpenTrades: parseInt(process.env.MAX_OPEN_TRADES || '5', 10),
    maxDailyLossXRP: parseInt(process.env.MAX_DAILY_LOSS_XRP || '30', 10),
    liveTrading: process.env.LIVE_TRADING === 'true',
    weights: {
      liquidity: parseInt(process.env.WEIGHT_LIQUIDITY || '20', 10),
      holderGrowth: parseInt(process.env.WEIGHT_HOLDER_GROWTH || '15', 10),
      buyPressure: parseInt(process.env.WEIGHT_BUY_PRESSURE || '20', 10),
      volumeAccel: parseInt(process.env.WEIGHT_VOLUME_ACCEL || '15', 10),
      devSafety: parseInt(process.env.WEIGHT_DEV_SAFETY || '15', 10),
      whitelistBoost: parseInt(process.env.WEIGHT_WHITELIST_BOOST || '10', 10),
      spread: parseInt(process.env.WEIGHT_SPREAD || '5', 10),
    },
    logLevel: process.env.LOG_LEVEL || 'info',
  };

  // FIX #17: Validate configuration values
  const weightSum = Object.values(config.weights).reduce((sum, w) => sum + w, 0);
  if (weightSum !== 100) {
    warn(`WARNING: Scoring weights sum to ${weightSum}, not 100. Normalizing may produce unexpected scores.`);
  }

  if (config.minLiquidityXRP <= 0) {
    warn(`WARNING: MIN_LIQUIDITY_XRP is ${config.minLiquidityXRP}, setting to default 2000`);
    config.minLiquidityXRP = 2000;
  }

  if (config.maxTradeXRP <= 0 || config.maxTradeXRP > config.startingBankrollXRP) {
    warn(`WARNING: MAX_TRADE_XRP (${config.maxTradeXRP}) is invalid, setting to 10% of bankroll`);
    config.maxTradeXRP = Math.floor(config.startingBankrollXRP * 0.1);
  }

  if (config.minScoreAlert < 0 || config.minScoreAlert > 100) {
    warn(`WARNING: MIN_SCORE_ALERT (${config.minScoreAlert}) out of range, setting to 75`);
    config.minScoreAlert = 75;
  }

  if (config.minScorePaperTrade < config.minScoreAlert) {
    warn(`WARNING: MIN_SCORE_PAPER_TRADE (${config.minScorePaperTrade}) < MIN_SCORE_ALERT (${config.minScoreAlert}). Setting to ${config.minScoreAlert + 5}`);
    config.minScorePaperTrade = config.minScoreAlert + 5;
  }

  // Validate Telegram credentials format
  if (config.telegramBotToken && !config.telegramBotToken.match(/^\d+:[A-Za-z0-9_-]{35,}$/)) {
    warn('WARNING: TELEGRAM_BOT_TOKEN format looks invalid. Alerts may fail.');
  }

  if (config.telegramChatId && !config.telegramChatId.match(/^-?\d+$/)) {
    warn('WARNING: TELEGRAM_CHAT_ID should be a numeric ID. Alerts may fail.');
  }

  // Log current mode
  console.log(`\n=== XRPL Meme Bot Configuration ===`);
  console.log(`Mode: ${config.mode}`);
  console.log(`XRPL WS: ${config.xrplWsUrl}`);
  console.log(`Min Liquidity: ${config.minLiquidityXRP} XRP`);
  console.log(`Alert Score Threshold: ${config.minScoreAlert}`);
  console.log(`Paper Trade Score Threshold: ${config.minScorePaperTrade}`);
  console.log(`Starting Bankroll: ${config.startingBankrollXRP} XRP`);
  console.log(`Max Trade Size: ${config.maxTradeXRP} XRP`);
  console.log(`Max Open Trades: ${config.maxOpenTrades}`);
  console.log(`Max Daily Loss: ${config.maxDailyLossXRP} XRP`);
  console.log(`==================================\n`);

  return config;
}
