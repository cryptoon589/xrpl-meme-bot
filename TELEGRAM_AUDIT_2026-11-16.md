# Hunterix Telegram, Notifications & Summary Logs Audit
Audited: 2026-11-16
Scope: \`src/telegram/alerts.ts\`, \`src/index.ts\` hourly/6h report scheduling and saveAlert, \`src/diagnostics/diagnostics.ts\`, \`scripts/daily_report.py\`, \`src/config.ts\`, \`src/db/database.ts\`, \`src/utils/logger.ts\`, \`ecosystem.recovery.paper.config.cjs\`.
Status: **Source reviewed and isolated notification defects reproduced; actual Telegram delivery, system cron and credentials NOT independently verified.**
No production files or server process modified. Test \`node scripts/audit_telegram_delivery.js\` uses a fake Telegram transport and no network requests.

## What the bot currently intends to send
- Startup: Telegram test message (“✅ XRPL Meme Bot is live.”), which is misleading when running PAPER.
- Every trade: PAPER entry, TP partial and full close. Miscellaneous token and score alerts intentionally suppressed.
- Every hour: OPEN POSITIONS summary; then DIAGNOSTICS and missed mover report.
- Every six hours, plus five minutes after process start: plain text forwardable BOT LOG with trade history, learned weights, profile stats and analysis.
- Daily: \`scripts/daily_report.py\` separate CLI that *claims* an 08:00 UTC cron. No cron installation exists in repository, and live crontab/systemd scheduling is unknown. \`daily_summary\` alert type in TelegramAlerter is suppressed.
- Mode: configured as one outbound Telegram chat via TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID, polling disabled.

## Critical / high priority verified defects
1. **Hourly diagnostics never arrives under normal ordering.** Both hourly OPEN POSITIONS and DIAGNOSTICS are sent with \`type: 'open_positions_update'\`. \`TelegramAlerter\` has one global cooldown key for that type (50 minutes). The positions message marks the cooldown before diagnostics; diagnostics is then skipped. The diagnostics is nevertheless inserted into the \`alerts\` DB via the sendAlert wrapper, giving a false record of delivery. Offline reproduction passed.
2. **Silent delivery failures and misleading success logs.** \`TelegramAlerter.send()\` catches errors and returns boolean to private callers, but public \`sendAlert()\` and \`sendRaw()\` return void. \`src/index.ts\` then logs “bot log sent successfully” even when message failed or was suppressed. \`db.saveAlert(payload)\` happens before attempting delivery; no delivery statuses or Telegram message IDs are stored. Offline reproduction passed.
3. **Reported PAPER P&L and bankroll are untrustworthy.** \`fmtTradeClose\` computes \`xrpReturned-entryAmountXRP\` and does not subtract entry fees, consistent with accounting defect P0.3. Hourly and 6h bankroll use flawed PaperTrader restart state and high-water fallback. The dedicated daily report estimates bankroll as 100 + historical closed-trade PnL, which ignores unsettled positions and finance ledger corrections. **Do not treat Telegram “P&L” or “READY FOR LIVE” as proof of real profitability.**
4. **Daily report targets wrong DB by default and “READY FOR LIVE” threshold is dangerously weak.** \`scripts/daily_report.py\` defaults to \`data/meme_bot.db\` (the original 18GB DB), not \`meme_bot.recovery.db\`; \`DB_PATH\` must be set explicitly. The script can declare “READY FOR LIVE” with a 20% 7d win rate, positive 7d PnL, five NEW_LAUNCH trades and low ghost counts, without valid net returns, execution fill verification, LIVE routing tests or out-of-sample results. Remove readiness certification pending audited risk controls.
5. **Unreliable hourly diagnostics counters.** \`diagnostics.resetHourly()\` runs before awaiting delivery of the diagnostics report. If Telegram fails, the window's counters are lost to the sent-message stream. No retry queue or transport ACK handling exists. Counters in logs are separate, but Telegram cannot be relied upon.
6. **On trade alert: targets may differ from actual position.** \`fmtTradeOpen\` prints defaults from \`PROFILES[profileName]\`, but runtime learning can override per-position TP1/TP2. Position-specific learned thresholds are tracked in memory rather than in the \`paperTrade\` payload and are not displayed. Incident review can therefore contradict actual exit decisions.

## Moderate reliability, usability and security defects
7. **Small token prices appear as zero.** \`fmtPrice\` and hourly \`fmtP\` use max 8 decimals. An actual price of 1e-10 XRP shows “0.00000000 XRP” (offline reproduced). Use adaptive significant digits or scientific notation with explicit units.
8. **HTML message chunking can break markup.** \`splitMessage()\` cuts an overlength HTML line at a fixed character boundary without carrying closing/opening tags, so Telegram rejects a chunk. Offline reproduced. Splitting by raw chars can also split entities; need Telegram-HTML-aware chunking or render safe plain text for long logs.
9. **No durable send queue or dedupe across restarts.** Current cooldowns are in-memory only. Concurrent messages can pass the cooldown before a slow first send completes. A partial multi-chunk success followed by retry may duplicate already delivered portions. Do not mark sent until Telegram confirms; include durable event IDs, per-chunk ACK state and exponential backoff for 429/5xx.
10. **Startup status text says “live”.** \`sendTestMessage\` sends “XRPL Meme Bot is live.” during PAPER operation. Change to mode-aware “PAPER monitoring started; LIVE TRADING OFF”.
11. **HTML escaping inconsistent.** Trade alert formatting escapes token display names, but hourly positions interpolate \`ticker\` into HTML unescaped; Telegram parsing can break for legitimate token symbols with \`<\`, \`&\`, or \`>\`. Default-format alert text also embeds arbitrary messages unescaped.
12. **A hard-coded allowed chat ID is added.** \`TelegramAlerter\` adds a literal chat ID in addition to config and environment allowlist. Currently polling is false and sends target only configured chat ID, so it is not proof of unauthorized access, but remove unconfigured exceptions and do not log all chat IDs unnecessarily.
13. **Daily/6h windows inconsistent.** \`daily_report.py\` filters 24h and 7d by *entry_timestamp* rather than *exit_timestamp*. \`src/db/database.ts\` hourly stats filter by exit timestamp and include ghost closes in rate denominators. The 6h log prints both all-time-including-ghost and excluding-ghost metrics; reported results can disagree without explanation.
14. **Daily report and hourly summaries are not reliably audited.** Direct hourly sends bypass DB persistence, while wrapped diagnostics persist the intent even if suppressed. The 6h BOT LOG is generated every 6h relative to process startup, not at fixed wall-clock hours; restart timing shifts it. System cron for daily_report.py not verified. Any Telegram delivery rate, missing alerts, or repeated messages must be measured from a delivery journal, not just \`alerts\` rows.

## Recommended notification design
- **Trade events:** immutable entry, fill, partial-exit and final-exit IDs; exact realized net P&L and fees, remaining token quantity, strategy/profile, quote age, confidence and first-seen timestamp.
- **Hourly digest:** one message containing separate sections OPEN POSITIONS, RISK, DIAGNOSTICS; no shared suppression that discards sections. Mark unrealized P&L using *current executable liquidation quote*, never highest historic price. Include price-as-of UTC.
- **6h analysis:** report audited sample size, strategy-level expectancy, economic profit factor, missed-mover lag, fraction of stale quotes and execution failure rate; clearly mark historical/estimated.
- **Daily report:** use active BOT_DB_PATH, avoid any “READY FOR LIVE” declaration until a formal release gate; ensure path and schedule are explicit.
- **Delivery transport:** bounded async queue, retry on rate limits/transients, acknowledgment and message IDs, dedup by trade-leg event key, success/failure metrics, 95th percentile delivery lag. Never block fast scanning on Telegram network.
- **Security:** prevent token/seed leakage into logs and version control; remove hardcoded external identifiers, use only intended chat IDs; Telegram is not a wallet authorization channel.

## Follow-up verification on the server (without revealing credentials)
- Confirm \`TELEGRAM_BOT_TOKEN\` and \`TELEGRAM_CHAT_ID\` are set only by checking whether they are present, never print values.
- Confirm successful test and live alerts via a safe dry-run Telegram delivery test. Requires explicitly agreeing to send a test message to the existing configured chat.
- Inspect \`pm2 logs hunterix-paper\` for warnings \`Telegram send failed\`, startup sends and six-hour completion. Logs alone are not proof of delivery.
- Inspect \`crontab -l\` and \`systemctl list-timers --all\` to confirm any daily_report.py schedule and use of BOT_DB_PATH. Do not change cron during audit.
- Reconcile actual received Telegram messages against recorded trade leg IDs and timestamps.

## Test commands
\`\`\`bash
npm run build
node scripts/audit_telegram_delivery.js  # offline, no real Telegram send
\`\`\`

See [Trading audit](TRADING_AUDIT_2026-11-16.md) for the accounting and execution blocking issues.
