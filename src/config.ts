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
    mode: mode === 'AUTO' ? 'WATCH' : mode,
    minLiquidityXRP: parseInt(process.env.MIN_LIQUIDITY_XRP || '2000', 10),
    minScoreAlert: parseInt(process.env.MIN_SCORE_ALERT || '75', 10),
    minScorePaperTrade: parseInt(process.env.MIN_SCORE_PAPER_TRADE || '80', 10),
    startingBankrollXRP: parseInt(process.env.STARTING_BANKROLL_XRP || '100', 10),
    minTradeXRP: parseInt(process.env.MIN_TRADE_XRP || '5', 10),
    maxTradeXRP: parseInt(process.env.MAX_TRADE_XRP || '25', 10),
    maxOpenTrades: parseInt(process.env.MAX_OPEN_TRADES || '5', 10),
    maxDailyLossXRP: parseInt(process.env.MAX_DAILY_LOSS_XRP || '30', 10),
    liveTrading: process.env.LIVE_TRADING === 'true',
    // weights field kept for type compatibility but scoring uses self-learned
    // weights from state/recommendations.json — these env vars are ignored.
    weights: { liquidity: 0, holderGrowth: 0, buyPressure: 0, volumeAccel: 0, devSafety: 0, whitelistBoost: 0, spread: 0 },
    logLevel: process.env.LOG_LEVEL || 'info',
  };

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

  console.log(`\n=== XRPL Meme Bot ===`);
  console.log(`Mode:         ${config.mode}`);
  console.log(`Liquidity:    ${config.minLiquidityXRP} XRP min`);
  console.log(`Score gates:  alert=${config.minScoreAlert} trade=${config.minScorePaperTrade}`);
  console.log(`Sizing:       ${config.minTradeXRP}–${config.maxTradeXRP} XRP | max ${config.maxOpenTrades} open | stop ${config.maxDailyLossXRP} XRP/day`);
  console.log(`Bankroll:     ${config.startingBankrollXRP} XRP`);
  console.log(`Scoring:      self-learned weights (state/recommendations.json)`);
  console.log(`=====================\n`);

  return config;
}
