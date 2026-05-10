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
  private readonly TRADE_COOLDOWN_MS = 10 * 1000;          // 10s for trade alerts
  private readonly SUMMARY_COOLDOWN_MS = 50 * 60 * 1000;   // 50 min for hourly position updates
  private readonly BOT_LOG_COOLDOWN_MS = 5 * 60 * 60 * 1000; // 5h for bot_log (separate from summary)

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
    // Trade close/partial alerts use entry timestamp in the key so TP1 + final close
    // on the same token within 10s don't suppress each other.
    let cdKey: string;
    let cdMs: number;
    if (payload.type === 'bot_log') {
      cdKey = this.cooldownKey(payload.type);
      cdMs  = this.BOT_LOG_COOLDOWN_MS;
    } else if (payload.type === 'open_positions_update') {
      cdKey = this.cooldownKey(payload.type);
      cdMs  = this.SUMMARY_COOLDOWN_MS;
    } else if (
      payload.type === 'paper_trade_closed' ||
      payload.type === 'paper_trade_partial_close'
    ) {
      // Include entry timestamp so TP1 partial + later full close are never
      // treated as the same event even if they fire within 10s on the same token.
      const ts = payload.paperTrade?.entryTimestamp ?? Date.now();
      cdKey = `${payload.type}:${payload.tokenCurrency ?? 'global'}:${ts}`;
      cdMs  = this.TRADE_COOLDOWN_MS;
    } else {
      cdKey = this.cooldownKey(payload.type, payload.tokenCurrency);
      cdMs  = this.TRADE_COOLDOWN_MS;
    }

    if (this.isOnCooldown(cdKey, cdMs)) {
      debug(`Alert cooldown: ${cdKey}`);
      return;
    }

    // bot_log is plain text — no HTML tags, but may contain special chars that
    // break Telegram's HTML parser (<, >, &). Send without parse_mode.
    const isPlain = payload.type === 'bot_log';
    await this.send(html, isPlain);
    this.markSent(cdKey);
  }

  /** Send pre-formatted HTML (used internally and by TradeExecutor). */
  async sendRaw(html: string): Promise<void> {
    await this.send(html);
  }

  private async send(html: string, plainText = false): Promise<void> {
    if (!this.enabled || !this.bot) return;
    if (!this.isAllowed(this.chatId)) {
      warn(`Alert blocked — chatId ${this.chatId} not in whitelist`);
      return;
    }
    const MAX_LEN = 4000; // Telegram hard limit is 4096; keep a safe margin
    const chunks: string[] = [];
    let remaining = html;
    while (remaining.length > 0) {
      chunks.push(remaining.slice(0, MAX_LEN));
      remaining = remaining.slice(MAX_LEN);
    }
    for (const chunk of chunks) {
      try {
        await this.bot.sendMessage(this.chatId, chunk, {
          parse_mode: plainText ? undefined : 'HTML',
          disable_web_page_preview: true,
        });
      } catch (err: any) {
        warn(`Telegram send failed: ${err?.message || err}`);
      }
    }
  }

  /** Send pre-formatted plain text (no HTML parsing — safe for log output). */
  async sendPlain(text: string): Promise<void> {
    await this.send(text, true);
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

    // Profile (new) vs legacy source (fallback)
    const profileName = payload.tradeProfileName ?? t.tradeProfile ?? null;
    const source      = payload.tradeSource ?? t.tradeSource
      ?? (t.entryReason?.startsWith('[BURST]') ? 'burst'
        : t.entryReason?.startsWith('[STREAM]') ? 'stream' : 'scored');

    // Profile emoji + label
    const PROFILE_EMOJI: Record<string, string> = {
      LOW_LIQ_PROBE:   '🔬',
      BURST_SCALP:     '🚀',
      MOMENTUM_RUNNER: '📈',
      WAKEUP_TRADE:    '⏰',
    };
    const SOURCE_EMOJI: Record<string, string> = {
      burst: '💥', scored: '🎯', stream: '⚡', wakeup: '⏰',
    };
    const profileEmoji = PROFILE_EMOJI[profileName ?? ''] ?? '📊';
    const sourceEmoji  = SOURCE_EMOJI[source] ?? '🔔';

    // Grab profile thresholds if available
    let tp1Line = '', tp2Line = '', slLine = '', trailLine = '', timeLine = '';
    try {
      const { PROFILES } = require('../execution/tradeProfiles');
      const prof = profileName ? PROFILES[profileName] : null;
      if (prof) {
        tp1Line   = `TP1 +${prof.tp1Pct}% → sell ${prof.tp1SellPct}% | TP2 +${prof.tp2Pct}% → sell ${prof.tp2SellPct}%`;
        slLine    = `Stop -${prof.stopLossPct}% | Trail @+${prof.trailActivationPct}% (${prof.trailDistancePct}% dist)`;
        timeLine  = prof.timeStopMs > 0 ? `Time stop: ${prof.timeStopMs / 60000}min` : 'No time stop';
      }
    } catch { /* profile module unavailable */ }

    // Slippage — prefer TDE value, fall back to trade estimate
    const slipPct = payload.slippage != null
      ? (payload.slippage * 100).toFixed(2)
      : (t.slippageEstimate * 100).toFixed(2);

    const poolXrp = payload.poolXrpReserve;

    // Score display
    const scoreStr = source === 'burst' ? 'burst signal'
      : t.entryScore ? `score ${t.entryScore}/100` : '—';

    // Issuer link
    const link = `https://firstledger.net/token/${t.tokenIssuer}/${t.tokenCurrency}`;

    const lines = [
      `${profileEmoji} <b>TRADE OPENED</b>`,
      ``,
      `<b>Profile:</b> <code>${profileName ?? '—'}</code>  ${sourceEmoji} Source: ${source}`,
      `<b>Token:</b>   <code>${ticker}</code>`,
      `<b>Entry:</b>   ${fmtPrice(t.entryPriceXRP)}`,
      `<b>Size:</b>    ${fmtXRP(t.entryAmountXRP)}`,
      poolXrp != null ? `<b>Pool XRP:</b> ${poolXrp.toFixed(0)} XRP reserve` : null,
      `<b>Signal:</b>  ${scoreStr}`,
      `<b>Slip:</b>    ${slipPct}%`,
      tp1Line   ? `<b>TPs:</b>    ${tp1Line}` : null,
      slLine    ? `<b>Risk:</b>   ${slLine}` : null,
      timeLine  ? `<b>Time:</b>   ${timeLine}` : null,
      `<b>Reason:</b>  ${(t.entryReason ?? '').replace(/\[BURST\]\s*|\[SCORED\]\s*|\[STREAM\]\s*/g, '').split('|').slice(0, 3).join(' | ')}`,
      ``,
      `<a href="${link}">FirstLedger ↗</a>`,
    ].filter(Boolean) as string[];

    return lines.join('\n');
  }

  // ── Partial close (TP1 / TP2) ──────────────────────────────────────────────

  private fmtTradePartial(payload: AlertPayload): string {
    const t = payload.paperTrade;
    if (!t) return '';

    const ticker   = decodeCurrency(t.tokenCurrency);
    const soldPct  = 100 - (t.remainingPosition ?? 100);
    const xrpSold  = (soldPct / 100) * t.entryAmountXRP;
    const pnl      = t.pnlXRP ?? null;

    // Label partial close correctly — TP1 vs TP2 vs kill-switch partial
    const PARTIAL_REASONS: Record<string, string> = {
      take_profit_1:      '🎯 TP1 HIT',
      take_profit_2:      '🎯 TP2 HIT',
      kill_no_followthrough: '⚡ Kill: no follow-through',
      kill_sell_flood:    '⚡ Kill: sell flood',
      kill_liq_drop:      '⚡ Kill: liquidity dropped',
    };
    const exitReason = t.exitReason ?? '';
    const reasonLabel = PARTIAL_REASONS[exitReason]
      ?? (exitReason ? exitReason.replace(/_/g, ' ') : 'Partial close');

    return [
      `🔶 <b>PARTIAL CLOSE — ${reasonLabel}</b>`,
      ``,
      `<b>Token:</b>      <code>${ticker}</code>`,
      `<b>Sold:</b>       ${soldPct.toFixed(0)}% (~${fmtXRP(xrpSold)})`,
      `<b>Remaining:</b>  ${(t.remainingPosition ?? 0).toFixed(0)}% still open`,
      `<b>Exit price:</b> ${fmtPrice(t.exitPriceXRP)}`,
      `${pnlEmoji(pnl)} <b>P&L so far:</b> ${fmtXRP(pnl)} (${fmtPct(t.pnlPercent)})`,
      `<b>TP1:</b> ${t.tp1Hit ? '✅ hit' : '⬜ pending'}  <b>TP2:</b> ${t.tp2Hit ? '✅ hit' : '⬜ pending'}`,
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
      take_profit_1:           '🎯 Take Profit 1',
      take_profit_2:           '🎯 Take Profit 2',
      stop_loss:               '🛑 Stop loss',
      trailing_stop:           '🔒 Trailing stop',
      trailing_stop_profit:    '🔒 Trailing stop (profit locked)',
      trailing_stop_loss:      '🛑 Trailing stop (loss cut)',
      sell_pressure_exit:      '📉 Sell pressure exit',
      dead_volume_exit:        '💀 Dead volume (no activity)',
      time_stop_profit:        '⏱️ Time stop (profit)',
      time_stop_loss:          '⏱️ Time stop (loss)',
      kill_no_followthrough:   '⚡ Kill: no follow-through',
      kill_sell_flood:         '⚡ Kill: sell flood',
      kill_liq_drop:           '⚡ Kill: liquidity dropped',
      'burst_tp1_+15pct':      '🎯 Burst TP1',
      burst_tp2:               '🎯 Burst TP2',
      force_close_no_price:    '☁️ Voided (no price data)',
      duplicate_removed:       '🗑 Duplicate removed',
      stale_position_cleanup:  '🧹 Stale position cleanup',
      blocklisted_token_cleanup: '🚫 Blocklisted token',
    };
    const reason = t.exitReason
      ? (EXIT_REASONS[t.exitReason] || t.exitReason.replace(/_/g, ' '))
      : 'Unknown';

    const win = (pnlXRP ?? 0) >= 0;

    // Was this a partial-then-full close? Show TP legs hit.
    const hadPartials = t.tp1Hit || t.tp2Hit;
    const legsLine = hadPartials
      ? `TP1: ${t.tp1Hit ? '✅' : '⬜'}  TP2: ${t.tp2Hit ? '✅' : '⬜'}`
      : null;

    // Hold time
    const holdMs  = t.exitTimestamp && t.entryTimestamp ? t.exitTimestamp - t.entryTimestamp : null;
    const holdMin = holdMs != null ? Math.round(holdMs / 60000) : null;
    const holdStr = holdMin != null
      ? holdMin >= 60 ? `${Math.floor(holdMin / 60)}h ${holdMin % 60}m` : `${holdMin}m`
      : null;

    return [
      `${win ? '✅' : '❌'} <b>TRADE CLOSED — ${win ? 'WIN' : 'LOSS'}</b>`,
      ``,
      `<b>Token:</b>      <code>${ticker}</code>`,
      `<b>Reason:</b>     ${reason}`,
      legsLine ? `<b>Legs:</b>       ${legsLine}` : null,
      ``,
      `<b>Entry:</b>      ${fmtPrice(t.entryPriceXRP)}`,
      `<b>Exit:</b>       ${fmtPrice(t.exitPriceXRP)}`,
      holdStr ? `<b>Held:</b>       ${holdStr}` : null,
      `<b>In:</b>         ${fmtXRP(t.entryAmountXRP)}`,
      `<b>Out:</b>        ${fmtXRP(valueOut)}`,
      `${win ? '✅' : '❌'} <b>P&L:</b>        ${fmtXRP(pnlXRP)} (${fmtPct(pnlPct)})`,
      `<b>Fees:</b>       ${fmtXRP(t.feesPaid)}`,
    ].filter(Boolean).join('\n');
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
