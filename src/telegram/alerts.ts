/**
 * Telegram Alert Module
 * Sends formatted alerts to Telegram
 */

import TelegramBot from 'node-telegram-bot-api';
import { AlertPayload } from '../types';
import { BotConfig } from '../config';
import { info, warn, debug } from '../utils/logger';

export class TelegramAlerter {
  private bot: TelegramBot | null = null;
  private chatId: string = '';
  private enabled: boolean = false;
  private lastAlertTime: Map<string, number> = new Map();
  private alertCooldownMs: number = 5 * 60 * 1000; // 5 minutes cooldown per alert type+token

  constructor(config: BotConfig) {
    if (config.telegramBotToken && config.telegramChatId) {
      try {
        this.bot = new TelegramBot(config.telegramBotToken, { polling: false });
        this.chatId = config.telegramChatId;
        this.enabled = true;
        info('Telegram bot initialized');
      } catch (err) {
        warn(`Failed to initialize Telegram bot: ${err}`);
        this.enabled = false;
      }
    } else {
      warn('Telegram not configured - alerts disabled');
    }
  }

  /**
   * Send an alert
   */
  async sendAlert(payload: AlertPayload): Promise<void> {
    if (!this.enabled || !this.bot) {
      debug(`Alert skipped (Telegram disabled): ${payload.type}`);
      return;
    }

    // Check cooldown
    const cooldownKey = `${payload.type}:${payload.tokenCurrency || 'global'}`;
    const now = Date.now();
    const lastSent = this.lastAlertTime.get(cooldownKey) || 0;

    if (now - lastSent < this.alertCooldownMs) {
      debug(`Alert cooldown active for ${cooldownKey}`);
      return;
    }

    try {
      const message = this.formatAlert(payload);
      await this.bot.sendMessage(this.chatId, message, { parse_mode: 'HTML' });
      this.lastAlertTime.set(cooldownKey, now);
      info(`Alert sent: ${payload.type}`);
    } catch (err) {
      warn(`Failed to send Telegram alert: ${err}`);
    }
  }

  /**
   * Format alert message
   */
  private formatAlert(payload: AlertPayload): string {
    switch (payload.type) {
      case 'new_token':
      case 'high_score':
        return this.formatTokenAlert(payload);

      case 'amm_pool':
        return this.formatAMMPoolAlert(payload);

      case 'liquidity_added':
      case 'liquidity_removed':
        return this.formatLiquidityAlert(payload);

      case 'whale_buy':
      case 'dev_sell':
        return this.formatActivityAlert(payload);

      case 'paper_trade_opened':
        return this.formatPaperTradeOpen(payload);

      case 'paper_trade_partial_close':
        return this.formatPaperTradePartial(payload);

      case 'paper_trade_closed':
        return this.formatPaperTradeClose(payload);

      case 'daily_summary':
        return this.formatDailySummary(payload);

      default:
        return `<b>${payload.type}</b>\n${payload.message}`;
    }
  }

  /**
   * Format token discovery/high score alert
   */
  private formatTokenAlert(payload: AlertPayload): string {
    const emoji = payload.type === 'high_score' ? '🔥' : '🆕';
    const lines = [
      `${emoji} <b>${payload.type === 'high_score' ? 'HIGH SCORE TOKEN' : 'NEW TOKEN DETECTED'}</b>`,
      '',
      `<b>Token:</b> ${payload.tokenCurrency || 'N/A'}`,
      `<b>Issuer:</b> <code>${payload.tokenIssuer || 'N/A'}</code>`,
      `<b>Score:</b> ${payload.score || 'N/A'}/100`,
      `<b>Liquidity:</b> ${payload.liquidity !== null && payload.liquidity !== undefined ? `${payload.liquidity.toFixed(2)} XRP` : 'Unknown'}`,
      `<b>Price:</b> ${payload.price !== null && payload.price !== undefined ? `${payload.price.toFixed(8)} XRP` : 'Unknown'}`,
    ];

    if (payload.change5m !== null && payload.change5m !== undefined) {
      lines.push(`<b>5m change:</b> ${payload.change5m >= 0 ? '+' : ''}${payload.change5m.toFixed(2)}%`);
    }
    if (payload.change15m !== null && payload.change15m !== undefined) {
      lines.push(`<b>15m change:</b> ${payload.change15m >= 0 ? '+' : ''}${payload.change15m.toFixed(2)}%`);
    }
    if (payload.change1h !== null && payload.change1h !== undefined) {
      lines.push(`<b>1h change:</b> ${payload.change1h >= 0 ? '+' : ''}${payload.change1h.toFixed(2)}%`);
    }

    if (payload.holders !== null && payload.holders !== undefined) {
      lines.push(`<b>Holders:</b> ${payload.holders}`);
    }

    if (payload.buyPressure) {
      lines.push(`<b>Buy pressure:</b> ${payload.buyPressure}`);
    }

    if (payload.riskFlags && payload.riskFlags.length > 0) {
      lines.push(`<b>Risk flags:</b> ${payload.riskFlags.join(', ')}`);
    }

    if (payload.action) {
      lines.push('', `<b>Action:</b> ${payload.action}`);
    }

    if (payload.explorerLinks) {
      lines.push('', '<b>Links:</b>');
      if (payload.explorerLinks.token) {
        lines.push(`• Token: ${payload.explorerLinks.token}`);
      }
      if (payload.explorerLinks.issuer) {
        lines.push(`• Issuer: ${payload.explorerLinks.issuer}`);
      }
      if (payload.explorerLinks.amm) {
        lines.push(`• AMM: ${payload.explorerLinks.amm}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Format AMM pool alert
   */
  private formatAMMPoolAlert(payload: AlertPayload): string {
    return [
      '🏊 <b>NEW AMM POOL</b>',
      '',
      payload.message,
    ].join('\n');
  }

  /**
   * Format liquidity change alert
   */
  private formatLiquidityAlert(payload: AlertPayload): string {
    const emoji = payload.type === 'liquidity_added' ? '💧' : '⚠️';
    const action = payload.type === 'liquidity_added' ? 'ADDED' : 'REMOVED';

    return [
      `${emoji} <b>LIQUIDITY ${action}</b>`,
      '',
      `<b>Token:</b> ${payload.tokenCurrency || 'N/A'}`,
      payload.message,
    ].join('\n');
  }

  /**
   * Format whale/dev activity alert
   */
  private formatActivityAlert(payload: AlertPayload): string {
    const emoji = payload.type === 'whale_buy' ? '🐋' : '🚨';
    const action = payload.type === 'whale_buy' ? 'WHALE BUY' : 'DEV SELL';

    return [
      `${emoji} <b>${action}</b>`,
      '',
      `<b>Token:</b> ${payload.tokenCurrency || 'N/A'}`,
      payload.message,
    ].join('\n');
  }

  /**
   * Format paper trade opened alert
   */
  private formatPaperTradeOpen(payload: AlertPayload): string {
    const trade = payload.paperTrade;
    if (!trade) return 'Paper trade opened (no details)';

    return [
      '📈 <b>PAPER TRADE OPENED</b>',
      '',
      `<b>Token:</b> ${trade.tokenCurrency}`,
      `<b>Entry:</b> ${trade.entryPriceXRP.toFixed(8)} XRP`,
      `<b>Size:</b> ${trade.entryAmountXRP.toFixed(2)} XRP`,
      `<b>Score:</b> ${trade.entryScore}`,
      `<b>Reason:</b> ${trade.entryReason}`,
      `<b>Slippage:</b> ${(trade.slippageEstimate * 100).toFixed(2)}%`,
    ].join('\n');
  }

  /**
   * Format paper trade partial close alert
   */
  private formatPaperTradePartial(payload: AlertPayload): string {
    const trade = payload.paperTrade;
    if (!trade) return 'Paper trade partially closed (no details)';

    const pnlEmoji = (trade.pnlXRP || 0) >= 0 ? '✅' : '❌';

    return [
      '📊 <b>PAPER TRADE PARTIAL CLOSE</b>',
      '',
      `<b>Token:</b> ${trade.tokenCurrency}`,
      `<b>Remaining:</b> ${trade.remainingPosition}%`,
      `${pnlEmoji} <b>PnL:</b> ${trade.pnlXRP?.toFixed(4) || 'N/A'} XRP (${trade.pnlPercent?.toFixed(2) || 'N/A'}%)`,
    ].join('\n');
  }

  /**
   * Format paper trade closed alert
   */
  private formatPaperTradeClose(payload: AlertPayload): string {
    const trade = payload.paperTrade;
    if (!trade) return 'Paper trade closed (no details)';

    const pnlEmoji = (trade.pnlXRP || 0) >= 0 ? '✅' : '❌';

    return [
      `${pnlEmoji} <b>PAPER TRADE CLOSED</b>`,
      '',
      `<b>Token:</b> ${trade.tokenCurrency}`,
      `<b>Entry:</b> ${trade.entryPriceXRP.toFixed(8)} XRP`,
      `<b>Exit:</b> ${trade.exitPriceXRP?.toFixed(8) || 'N/A'} XRP`,
      `${pnlEmoji} <b>PnL:</b> ${trade.pnlXRP?.toFixed(4) || 'N/A'} XRP (${trade.pnlPercent?.toFixed(2) || 'N/A'}%)`,
      `<b>Reason:</b> ${trade.exitReason || 'N/A'}`,
      `<b>Fees:</b> ${trade.feesPaid.toFixed(4)} XRP`,
    ].join('\n');
  }

  /**
   * Format daily summary alert
   */
  private formatDailySummary(payload: AlertPayload): string {
    return [
      '📋 <b>DAILY P&L SUMMARY</b>',
      '',
      payload.message,
    ].join('\n');
  }

  /**
   * Send a test message
   * FIX #18: Improved error messages for common failure modes
   */
  async sendTestMessage(): Promise<boolean> {
    if (!this.enabled || !this.bot) {
      warn('Cannot send test: Telegram not configured');
      return false;
    }

    try {
      await this.bot.sendMessage(this.chatId, '✅ XRPL Meme Bot is running!', { parse_mode: 'HTML' });
      info('✅ Telegram test message sent successfully');
      return true;
    } catch (err: any) {
      const errMsg = err.message || String(err);

      // Provide helpful error messages for common issues
      if (errMsg.includes('404')) {
        warn('❌ Telegram test failed: Bot token or Chat ID is invalid');
        warn('   - Verify TELEGRAM_BOT_TOKEN from @BotFather');
        warn('   - Verify TELEGRAM_CHAT_ID (send /getid to your bot or use @userinfobot)');
        warn('   - Make sure you have messaged the bot at least once');
      } else if (errMsg.includes('403')) {
        warn('❌ Telegram test failed: Bot is blocked or chat is inaccessible');
        warn('   - Unblock the bot in Telegram');
        warn('   - Send a message to the bot first');
      } else if (errMsg.includes('429')) {
        warn('⚠️ Telegram rate limit hit. Retrying later...');
      } else {
        warn(`❌ Telegram test failed: ${errMsg}`);
      }

      return false;
    }
  }
}
