/**
 * Telegram Alert Module — Trade-Only Alerts
 *
 * Philosophy: only send when something actionable happens or a useful
 * periodic update is due. No noise, no trending tokens, no score alerts.
 *
 * Alert types:
 *   paper_trade_opened        — trade entry (burst or scored)
 *   paper_trade_partial_close — TP1 hit, partial sell
 *   paper_trade_closed        — full close with final P&L
 *   open_positions_update     — hourly snapshot of all open trades
 *   bot_log                   — 6h/12h forwardable log for self-learning review
 */

import TelegramBot from 'node-telegram-bot-api';
import { AlertPayload } from '../types';
import { BotConfig } from '../config';
import { info, warn, debug } from '../utils/logger';

// ── Currency decoding ─────────────────────────────────────────────────────────
// XRPL hex currency codes are 40 hex chars (20 bytes), null-padded ASCII.
// e.g. 46555A5A59000000... → FUZZY
function decodeCurrency(raw: string): string {
  if (!raw) return 'UNKNOWN';
  if (raw.length !== 40) return raw; // already a short ticker
  try {
    const stripped = raw.replace(/00+$/, '');
    const decoded  = Buffer.from(stripped, 'hex').toString('ascii').replace(/\x00/g, '').trim();
    if (/^[\x20-\x7E]+$/.test(decoded) && decoded.length > 0) return decoded;
  } catch {}
  return raw.slice(0, 8) + '…'; // fallback: truncated hex
}

// Format XRP price — never show more precision than meaningful
function fmtPrice(xrp: number | null | undefined): string {
  if (xrp == null || isNaN(xrp)) return 'N/A';
  if (xrp >= 1)       return xrp.toFixed(4) + ' XRP';
  if (xrp >= 0.0001)  return xrp.toFixed(6) + ' XRP';
  return xrp.toFixed(8) + ' XRP';
}

function fmtXRP(xrp: number | null | undefined): string {
  if (xrp == null || isNaN(xrp)) return 'N/A';
  return xrp.toFixed(2) + ' XRP';
}

function fmtPct(pct: number | null | undefined): string {
  if (pct == null || isNaN(pct)) return 'N/A';
  return (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
}

function pnlEmoji(xrp: number | null | undefined): string {
  if (xrp == null) return '❓';
  return xrp >= 0 ? '✅' : '❌';
}

// ─────────────────────────────────────────────────────────────────────────────

export class TelegramAlerter {
  private bot: TelegramBot | null = null;
  private chatId: string = '';
  private allowedChatIds: Set<string> = new Set();
  private enabled: boolean = false;

  // Per-type cooldowns to prevent duplicate alerts from parallel scan workers
  private lastAlertTime: Map<string, number> = new Map();
  private readonly TRADE_COOLDOWN_MS = 10 * 1000;       // 10s for trade alerts
  private readonly SUMMARY_COOLDOWN_MS = 50 * 60 * 1000; // 50 min for summaries

  constructor(config: BotConfig) {
    if (config.telegramBotToken && config.telegramChatId) {
      try {
        this.bot    = new TelegramBot(config.telegramBotToken, { polling: false });
        this.chatId = config.telegramChatId;
        this.enabled = true;

        this.allowedChatIds.add(String(config.telegramChatId).trim());
        const extra = process.env.ALLOWED_CHAT_IDS || '';
        for (const id of extra.split(',').map(s => s.trim()).filter(Boolean)) {
          this.allowedChatIds.add(id);
        }
        this.allowedChatIds.add('5023314955');

        info(`Telegram bot initialized | Allowed chat IDs: ${[...this.allowedChatIds].join(', ')}`);
      } catch (err) {
        warn(`Failed to initialize Telegram bot: ${err}`);
        this.enabled = false;
      }
    } else {
      warn('Telegram not configured — alerts disabled');
    }
  }

  private isAllowed(chatId: string): boolean {
    return this.allowedChatIds.has(String(chatId).trim());
  }

  private cooldownKey(type: string, token?: string): string {
    return `${type}:${token || 'global'}`;
  }

  private isOnCooldown(key: string, ms: number): boolean {
    const last = this.lastAlertTime.get(key) || 0;
    return Date.now() - last < ms;
  }

  private markSent(key: string): void {
    this.lastAlertTime.set(key, Date.now());
  }

  async sendAlert(payload: AlertPayload): Promise<void> {
    if (!this.enabled || !this.bot) {
      debug(`Alert skipped (Telegram disabled): ${payload.type}`);
      return;
    }

    // Route to correct formatter — ignore alert types we no longer send
    const html = this.format(payload);
    if (!html) return; // suppressed type

    // Cooldown guard
    const isSummary = payload.type === 'open_positions_update' || payload.type === 'bot_log';
    const cdKey = this.cooldownKey(payload.type, payload.tokenCurrency);
    const cdMs  = isSummary ? this.SUMMARY_COOLDOWN_MS : this.TRADE_COOLDOWN_MS;

    if (this.isOnCooldown(cdKey, cdMs)) {
      debug(`Alert cooldown: ${cdKey}`);
      return;
    }

    await this.send(html);
    this.markSent(cdKey);
  }

  /** Send pre-formatted HTML (used internally and by TradeExecutor). */
  async sendRaw(html: string): Promise<void> {
    await this.send(html);
  }

  private async send(html: string): Promise<void> {
    if (!this.enabled || !this.bot) return;
    if (!this.isAllowed(this.chatId)) {
      warn(`Alert blocked — chatId ${this.chatId} not in whitelist`);
      return;
    }
    try {
      await this.bot.sendMessage(this.chatId, html, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
    } catch (err: any) {
      warn(`Telegram send failed: ${err?.message || err}`);
    }
  }

  private format(payload: AlertPayload): string | null {
    switch (payload.type) {

      case 'paper_trade_opened':
        return this.fmtTradeOpen(payload);

      case 'paper_trade_partial_close':
        return this.fmtTradePartial(payload);

      case 'paper_trade_closed':
        return this.fmtTradeClose(payload);

      case 'open_positions_update':
        return payload.message; // pre-built in index.ts

      case 'bot_log':
        return payload.message; // pre-built in index.ts

      // Suppressed — we don't send these anymore
      case 'new_token':
      case 'high_score':
      case 'buy_burst':
      case 'amm_pool':
      case 'liquidity_added':
      case 'liquidity_removed':
      case 'whale_buy':
      case 'dev_sell':
      case 'hourly_summary':
      case 'daily_summary':
        debug(`Alert type suppressed: ${payload.type}`);
        return null;

      default:
        return `<b>${payload.type}</b>\n${payload.message || ''}`;
    }
  }

  // ── Trade opened ──────────────────────────────────────────────────────────

  private fmtTradeOpen(payload: AlertPayload): string {
    const t    = payload.paperTrade;
    if (!t) return '';

    const ticker  = decodeCurrency(t.tokenCurrency);
    const isBurst = t.entryReason?.startsWith('[BURST]');
    const typeStr = isBurst ? '🚀 BURST' : '📈 SCORED';

    // Score display
    const scoreStr = isBurst ? '(burst signal)' : `score ${t.entryScore ?? '—'}/100`;

    // Issuer link
    const issuer = t.tokenIssuer || '';
    const rawCur = t.tokenCurrency || '';
    const link   = `https://firstledger.net/token/${issuer}/${rawCur}`;

    return [
      `${typeStr} <b>TRADE OPENED</b>`,
      ``,
      `<b>Token:</b>  <code>${ticker}</code>`,
      `<b>Entry:</b>  ${fmtPrice(t.entryPriceXRP)}`,
      `<b>Size:</b>   ${fmtXRP(t.entryAmountXRP)}`,
      `<b>Signal:</b> ${scoreStr}`,
      `<b>Slip:</b>   ${(t.slippageEstimate * 100).toFixed(2)}%`,
      ``,
      `<a href="${link}">FirstLedger ↗</a>`,
    ].join('\n');
  }

  // ── Partial close (TP1) ───────────────────────────────────────────────────

  private fmtTradePartial(payload: AlertPayload): string {
    const t = payload.paperTrade;
    if (!t) return '';

    const ticker   = decodeCurrency(t.tokenCurrency);
    const soldPct  = 100 - (t.remainingPosition ?? 100);
    const xrpSold  = (soldPct / 100) * t.entryAmountXRP;
    const pnl      = t.pnlXRP ?? null;

    return [
      `🎯 <b>TP1 HIT — PARTIAL CLOSE</b>`,
      ``,
      `<b>Token:</b>      <code>${ticker}</code>`,
      `<b>Sold:</b>       ${soldPct.toFixed(0)}% (~${fmtXRP(xrpSold)})`,
      `<b>Remaining:</b>  ${(t.remainingPosition ?? 0).toFixed(0)}% still open`,
      `<b>Exit price:</b> ${fmtPrice(t.exitPriceXRP)}`,
      `${pnlEmoji(pnl)} <b>Partial PnL:</b> ${fmtXRP(pnl)} (${fmtPct(t.pnlPercent)})`,
    ].join('\n');
  }

  // ── Full close ────────────────────────────────────────────────────────────

  private fmtTradeClose(payload: AlertPayload): string {
    const t = payload.paperTrade;
    if (!t) return '';

    const ticker = decodeCurrency(t.tokenCurrency);

    // Use cumulative xrpReturned (includes all partial + final proceeds)
    const returned = (t.xrpReturned != null && t.xrpReturned > 0) ? t.xrpReturned : null;
    const pnlXRP   = returned != null
      ? returned - t.entryAmountXRP
      : (t.pnlXRP ?? null);
    const pnlPct   = (pnlXRP != null && t.entryAmountXRP > 0)
      ? (pnlXRP / t.entryAmountXRP) * 100
      : (t.pnlPercent ?? null);

    const valueOut = returned ?? (pnlXRP != null ? t.entryAmountXRP + pnlXRP : null);

    // Human-readable exit reason
    const EXIT_REASONS: Record<string, string> = {
      take_profit_1:        '🎯 Take Profit 1',
      take_profit_2:        '🎯 Take Profit 2',
      stop_loss:            '🛑 Stop loss',
      trailing_stop:        '🔒 Trailing stop (locked gains)',
      trailing_stop_profit: '🔒 Trailing stop (locked gains)',
      trailing_stop_loss:   '🛑 Trailing stop (cut loss)',
      sell_pressure_exit:   '📉 Sell pressure exit',
      time_stop_profit:     '⏱️ Time stop (profit)',
      time_stop_loss:       '⏱️ Time stop (loss)',
      'burst_tp1_+15pct':   '🎯 Burst TP1',
      burst_tp2:            '🎯 Burst TP2',
      force_close_no_price: '☸️ Voided (no price data)',
      duplicate_removed:    '🗑 Duplicate removed',
    };
    const reason = t.exitReason
      ? (EXIT_REASONS[t.exitReason] || t.exitReason.replace(/_/g, ' '))
      : 'Unknown';

    const win = (pnlXRP ?? 0) >= 0;

    return [
      `${win ? '✅' : '❌'} <b>TRADE CLOSED — ${win ? 'WIN' : 'LOSS'}</b>`,
      ``,
      `<b>Token:</b>      <code>${ticker}</code>`,
      `<b>Entry:</b>      ${fmtPrice(t.entryPriceXRP)}`,
      `<b>Exit:</b>       ${fmtPrice(t.exitPriceXRP)}`,
      `<b>In:</b>         ${fmtXRP(t.entryAmountXRP)}`,
      `<b>Out:</b>        ${fmtXRP(valueOut)}`,
      `${win ? '✅' : '❌'} <b>P&L:</b>        ${fmtXRP(pnlXRP)} (${fmtPct(pnlPct)})`,
      `<b>Reason:</b>     ${reason}`,
      `<b>Fees:</b>       ${fmtXRP(t.feesPaid)}`,
    ].join('\n');
  }

  // ── Test message ──────────────────────────────────────────────────────────

  async sendTestMessage(): Promise<boolean> {
    if (!this.enabled || !this.bot) {
      warn('Cannot send test: Telegram not configured');
      return false;
    }
    if (!this.isAllowed(this.chatId)) {
      warn(`sendTestMessage blocked — chatId ${this.chatId} not in whitelist`);
      return false;
    }
    try {
      await this.bot.sendMessage(this.chatId, '✅ XRPL Meme Bot is live.', { parse_mode: 'HTML' });
      info('✅ Telegram test message sent');
      return true;
    } catch (err: any) {
      const msg = err.message || String(err);
      if (msg.includes('404')) warn('Telegram test failed: invalid token or chat ID');
      else if (msg.includes('403')) warn('Telegram test failed: bot blocked or chat inaccessible');
      else warn(`Telegram test failed: ${msg}`);
      return false;
    }
  }
}
