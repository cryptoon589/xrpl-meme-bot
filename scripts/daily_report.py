#!/usr/bin/env python3
"""
Daily live-readiness report for xrpl-meme-bot.
Sends a Telegram message with key stats and a go/no-go checklist.
Run via cron at 08:00 UTC daily.
"""

import sqlite3
import os
import sys
import urllib.request
import urllib.parse
import json
from datetime import datetime, timezone

DB_PATH = os.environ.get('DB_PATH', '/root/xrpl-meme-bot/data/meme_bot.db')
BOT_TOKEN = os.environ.get('TELEGRAM_BOT_TOKEN', '')
CHAT_ID = os.environ.get('TELEGRAM_CHAT_ID', '')

def send_telegram(text: str) -> bool:
    if not BOT_TOKEN or not CHAT_ID:
        return False
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"
    data = urllib.parse.urlencode({
        'chat_id': CHAT_ID,
        'text': text,
        'parse_mode': 'HTML'
    }).encode()
    try:
        req = urllib.request.Request(url, data=data, method='POST')
        urllib.request.urlopen(req, timeout=10)
        return True
    except Exception as e:
        print(f"Telegram send failed: {e}")
        return False

def main():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    now_ts = int(datetime.now(timezone.utc).timestamp() * 1000)
    day_ms = 24 * 60 * 60 * 1000
    week_ms = 7 * day_ms

    # --- Overall stats (excl ghosts) ---
    c.execute("""SELECT COUNT(*),
        ROUND(100.0*SUM(CASE WHEN pnl_xrp>0 THEN 1 ELSE 0 END)/COUNT(*),1),
        ROUND(SUM(pnl_xrp),2)
        FROM paper_trades WHERE status='closed'
        AND exit_reason!='force_close_no_price'""")
    total_t, total_wr, total_net = c.fetchone()

    # --- Last 7 days ---
    c.execute("""SELECT COUNT(*),
        ROUND(100.0*SUM(CASE WHEN pnl_xrp>0 THEN 1 ELSE 0 END)/COUNT(*),1),
        ROUND(SUM(pnl_xrp),2),
        ROUND(AVG(CASE WHEN pnl_xrp>0 THEN pnl_percent END),1),
        ROUND(AVG(CASE WHEN pnl_xrp<=0 THEN pnl_percent END),1)
        FROM paper_trades WHERE status='closed'
        AND exit_reason!='force_close_no_price'
        AND entry_timestamp > ?""", (now_ts - week_ms,))
    w7_t, w7_wr, w7_net, w7_avgW, w7_avgL = c.fetchone()

    # --- Last 24h ---
    c.execute("""SELECT COUNT(*),
        ROUND(100.0*SUM(CASE WHEN pnl_xrp>0 THEN 1 ELSE 0 END)/COUNT(*),1),
        ROUND(SUM(pnl_xrp),2)
        FROM paper_trades WHERE status='closed'
        AND exit_reason!='force_close_no_price'
        AND entry_timestamp > ?""", (now_ts - day_ms,))
    d1_t, d1_wr, d1_net = c.fetchone()

    # --- kill_no_followthrough last 7 days ---
    c.execute("""SELECT COUNT(*) FROM paper_trades
        WHERE status='closed' AND exit_reason='kill_no_followthrough'
        AND entry_timestamp > ?""", (now_ts - week_ms,))
    knf_7d = c.fetchone()[0]

    # --- Ghost closes last 7 days ---
    c.execute("""SELECT COUNT(*) FROM paper_trades
        WHERE status='closed' AND exit_reason='force_close_no_price'
        AND entry_timestamp > ?""", (now_ts - week_ms,))
    ghost_7d = c.fetchone()[0]

    # --- NEW_LAUNCH profile stats ---
    c.execute("""SELECT COUNT(*),
        ROUND(100.0*SUM(CASE WHEN pnl_xrp>0 THEN 1 ELSE 0 END)/COUNT(*),1),
        ROUND(SUM(pnl_xrp),2)
        FROM paper_trades WHERE status='closed'
        AND trade_profile='NEW_LAUNCH'
        AND exit_reason!='force_close_no_price'""")
    nl_t, nl_wr, nl_net = c.fetchone()

    # --- Per-profile 7-day breakdown ---
    c.execute("""SELECT trade_profile, COUNT(*),
        ROUND(100.0*SUM(CASE WHEN pnl_xrp>0 THEN 1 ELSE 0 END)/COUNT(*),1),
        ROUND(SUM(pnl_xrp),2)
        FROM paper_trades WHERE status='closed'
        AND exit_reason!='force_close_no_price'
        AND entry_timestamp > ?
        AND trade_profile IS NOT NULL
        GROUP BY trade_profile ORDER BY SUM(pnl_xrp) DESC""", (now_ts - week_ms,))
    profiles = c.fetchall()

    # --- Bankroll (real trades only, excl ghost closes) ---
    c.execute("""SELECT ROUND(SUM(pnl_xrp),2) FROM paper_trades
        WHERE status='closed' AND exit_reason != 'force_close_no_price'""")
    all_pnl = c.fetchone()[0] or 0
    bankroll_est = 100 + all_pnl

    # --- Exit reason breakdown (7d) ---
    c.execute("""SELECT exit_reason, COUNT(*), ROUND(AVG(pnl_percent),1)
        FROM paper_trades WHERE status='closed' AND entry_timestamp > ?
        GROUP BY exit_reason ORDER BY COUNT(*) DESC LIMIT 8""", (now_ts - week_ms,))
    exit_reasons = c.fetchall()

    # --- Shadow backtest stats (resolved) ---
    shadow_rows = []
    try:
        c.execute("""SELECT reject_reason,
            COUNT(*) as cnt,
            ROUND(AVG(pct_gain_1h),1) as avg_1h,
            ROUND(AVG(pct_gain_4h),1) as avg_4h,
            SUM(CASE WHEN pct_gain_1h > 50 THEN 1 ELSE 0 END) as winners
            FROM shadow_trades WHERE resolved_at IS NOT NULL
            AND skipped_at > ?
            GROUP BY reject_reason ORDER BY cnt DESC LIMIT 6""", (now_ts - week_ms,))
        shadow_rows = c.fetchall()
    except Exception:
        pass  # table may not exist on older DBs

    conn.close()

    # --- Live readiness checks ---
    checks = []
    wr_ok     = (w7_wr or 0) >= 20
    knf_ok    = knf_7d <= 15
    net_ok    = (w7_net or 0) > 0
    nl_ok     = (nl_t or 0) >= 5 and (nl_wr or 0) > 0
    ghost_ok  = ghost_7d <= 20

    checks.append(("WR ≥20% (7d)",        wr_ok,    f"{w7_wr}%"))
    checks.append(("kill_nofollow ≤15 (7d)", knf_ok, f"{knf_7d}x"))
    checks.append(("Net PnL > 0 (7d)",    net_ok,   f"{'+' if (w7_net or 0)>=0 else ''}{w7_net} XRP"))
    checks.append(("NEW_LAUNCH ≥5 trades", nl_ok,   f"{nl_t}t WR {nl_wr}%"))
    checks.append(("Ghosts ≤20 (7d)",     ghost_ok, f"{ghost_7d}x"))

    all_green = all(ok for _, ok, _ in checks)
    readiness = "🟢 READY FOR LIVE" if all_green else "🔴 NOT READY YET"

    # --- Build message ---
    profile_lines = '\n'.join(
        f"  {p[0]}: {p[1]}t WR {p[2]}% net {'+' if (p[3] or 0)>=0 else ''}{p[3]} XRP"
        for p in profiles
    ) or "  no data"

    check_lines = '\n'.join(
        f"  {'✅' if ok else '❌'} {label}: {val}"
        for label, ok, val in checks
    )

    exit_lines = '\n'.join(
        f"  {r[0] or 'unknown'}: {r[1]}x avg {r[2]}%"
        for r in exit_reasons
    ) or '  no data'

    shadow_lines = '\n'.join(
        f"  {r[0]}: {r[1]}x | avg 1h {'+' if (r[2] or 0)>=0 else ''}{r[2]}% | {r[4]} winners"
        for r in shadow_rows
    ) or '  no data (table empty or unresolved)'

    msg = f"""📊 <b>DAILY BOT REPORT — {datetime.now(timezone.utc).strftime('%d %b %Y %H:%M UTC')}</b>

<b>Bankroll:</b> ~{bankroll_est:.2f} XRP

<b>Last 24h</b>
Trades: {d1_t} | WR: {d1_wr}% | Net: {'+' if (d1_net or 0)>=0 else ''}{d1_net} XRP

<b>Last 7 days</b>
Trades: {w7_t} | WR: {w7_wr}% | Net: {'+' if (w7_net or 0)>=0 else ''}{w7_net} XRP
AvgW: +{w7_avgW}% | AvgL: {w7_avgL}%
kill_nofollow: {knf_7d}x | Ghosts: {ghost_7d}x

<b>All-time (excl ghosts)</b>
Trades: {total_t} | WR: {total_wr}% | Net: {'+' if (total_net or 0)>=0 else ''}{total_net} XRP

<b>By Profile (7d)</b>
{profile_lines}

<b>Exit Reasons (7d)</b>
{exit_lines}

<b>Shadow Backtest — Rejected Signals (7d)</b>
{shadow_lines}

<b>Live Readiness: {readiness}</b>
{check_lines}"""

    sent = send_telegram(msg)
    if not sent:
        print("[No Telegram credentials — stdout only]")
        print(msg)

if __name__ == '__main__':
    main()
