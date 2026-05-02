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
   * Format token alert as an actionable trading signal
   */
  private formatTokenAlert(payload: AlertPayload): string {
    const isSignal = payload.type === 'high_score';
    const score = payload.score || 0;
    const price = payload.price;
    const liq = payload.liquidity;

    // Signal strength label
    const strength = score >= 85 ? '🚀 STRONG BUY SIGNAL'
      : score >= 75 ? '🔥 BUY SIGNAL'
      : score >= 65 ? '⚡ WATCH SIGNAL'
      : '🆕 NEW TOKEN';

    const lines: string[] = [
      `${strength}`,
      '',
      `<b>Token:</b> <code>${payload.tokenCurrency || 'N/A'}</code>`,
      `<b>Signal Score:</b> ${score}/100`,
    ];

    // Price line
    if (price != null) {
      lines.push(`<b>Current Price:</b> ${price.toFixed(8)} XRP`);
    }

    // Liquidity
    if (liq != null) {
      const liqLabel = liq >= 10000 ? '🟢 High' : liq >= 3000 ? '🟡 Medium' : '🔴 Low';
      lines.push(`<b>Liquidity:</b> ${liq.toFixed(0)} XRP ${liqLabel}`);
    }

    // Price momentum
    const c5 = payload.change5m, c15 = payload.change15m, c1h = payload.change1h;
    if (c5 != null || c15 != null || c1h != null) {
      lines.push('');
      lines.push('<b>📈 Price Momentum:</b>');
      if (c5 != null)  lines.push(`  5m:  ${c5  >= 0 ? '+' : ''}${c5.toFixed(1)}%`);
      if (c15 != null) lines.push(`  15m: ${c15 >= 0 ? '+' : ''}${c15.toFixed(1)}%`);
      if (c1h != null) lines.push(`  1h:  ${c1h >= 0 ? '+' : ''}${c1h.toFixed(1)}%`);
    }

    // Buy pressure
    if (payload.buyPressure) {
      lines.push(`<b>Buy Pressure:</b> ${payload.buyPressure}`);
    }

    // Actionable entry/exit levels (only for real signals)
    if (isSignal && price != null && score >= 65) {
      const stopLoss  = price * 0.85;  // -15%
      const target1   = price * 1.35;  // +35%
      const target2   = price * 1.75;  // +75%
      lines.push('');
      lines.push('<b>💰 Trade Levels:</b>');
      lines.push(`  Entry:    ${price.toFixed(8)} XRP  ← buy here`);
      lines.push(`  Stop:     ${stopLoss.toFixed(8)} XRP  (-15%)`);
      lines.push(`  Target 1: ${target1.toFixed(8)} XRP  (+35%) — take 40%`);
      lines.push(`  Target 2: ${target2.toFixed(8)} XRP  (+75%) — take 30%`);
      lines.push(`  Trail:    move stop to entry after T1 hit`);
    }

    // Risk flags — shown prominently
    if (payload.riskFlags && payload.riskFlags.length > 0) {
      lines.push('');
      lines.push(`<b>⚠️ Risks:</b> ${payload.riskFlags.join(' | ')}`);
    }

    // Holders
    if (payload.holders != null) {
      lines.push(`<b>Holders:</b> ${payload.holders}`);
    }

    // Links
    if (payload.explorerLinks) {
      lines.push('');
      const issuer = payload.tokenIssuer || '';
      lines.push(`<a href="https://firstledger.net/token/${issuer}/${payload.tokenCurrency}">FirstLedger</a> | <a href="https://xmagnetic.org/tokens/${payload.tokenCurrency}+${issuer}">xMagnetic</a> | <a href="https://livenet.xrpl.org/accounts/${issuer}">Explorer</a>`);
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
