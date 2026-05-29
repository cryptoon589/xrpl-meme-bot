#!/usr/bin/env python3
"""
Deep trade history analysis — run on VPS to surface hidden bugs and improvement signals.
Usage: python3 scripts/trade_analysis.py
"""
import sqlite3, os, sys
from datetime import datetime, timezone

DB_PATH = os.environ.get('DB_PATH', '/root/xrpl-meme-bot/data/meme_bot.db')
conn = sqlite3.connect(DB_PATH)
c = conn.cursor()

def h(title): print(f"\n{'='*60}\n{title}\n{'='*60}")

# ── 1. TABLE SIZES ───────────────────────────────────────────────
h("1. TABLE SIZES")
for t in ['paper_trades','shadow_trades','missed_opportunities','profile_stats','tokens','scores']:
    try:
        c.execute(f"SELECT COUNT(*) FROM {t}")
        print(f"  {t}: {c.fetchone()[0]}")
    except: print(f"  {t}: MISSING")

# ── 2. STATUS BREAKDOWN ──────────────────────────────────────────
h("2. TRADE STATUS BREAKDOWN")
c.execute("SELECT status, COUNT(*) FROM paper_trades GROUP BY status")
for r in c.fetchall(): print(f"  {r[0]}: {r[1]}")

# ── 3. EXIT REASON BREAKDOWN (all time) ─────────────────────────
h("3. EXIT REASON BREAKDOWN — all time")
c.execute("""SELECT exit_reason, COUNT(*),
    ROUND(100.0*SUM(CASE WHEN pnl_xrp>0 THEN 1 ELSE 0 END)/COUNT(*),1) as wr,
    ROUND(AVG(pnl_percent),1) as avg_pct,
    ROUND(SUM(pnl_xrp),2) as net
    FROM paper_trades WHERE status='closed'
    GROUP BY exit_reason ORDER BY COUNT(*) DESC""")
for r in c.fetchall(): print(f"  {r[0]:35s} cnt={r[1]:4d}  WR={r[2]}%  avg={r[3]}%  net={r[4]} XRP")

# ── 4. TRADE SOURCE ──────────────────────────────────────────────
h("4. TRADE SOURCE BREAKDOWN (excl ghosts)")
c.execute("""SELECT COALESCE(trade_source,'unknown'), COUNT(*),
    ROUND(100.0*SUM(CASE WHEN pnl_xrp>0 THEN 1 ELSE 0 END)/COUNT(*),1) as wr,
    ROUND(AVG(CASE WHEN pnl_xrp>0 THEN pnl_percent END),1) as avg_win,
    ROUND(AVG(CASE WHEN pnl_xrp<=0 THEN pnl_percent END),1) as avg_loss,
    ROUND(SUM(pnl_xrp),2) as net
    FROM paper_trades WHERE status='closed' AND exit_reason!='force_close_no_price'
    GROUP BY trade_source ORDER BY net DESC""")
for r in c.fetchall():
    print(f"  src={r[0]:10s}  cnt={r[1]:4d}  WR={r[2]}%  avgW=+{r[3]}%  avgL={r[4]}%  net={r[5]} XRP")

# ── 5. HOLD TIME BUCKETS ─────────────────────────────────────────
h("5. HOLD TIME vs WIN RATE (excl ghosts)")
c.execute("""SELECT
    CASE
        WHEN (exit_timestamp-entry_timestamp)/60000.0 < 2   THEN 'a:<2min'
        WHEN (exit_timestamp-entry_timestamp)/60000.0 < 5   THEN 'b:2-5min'
        WHEN (exit_timestamp-entry_timestamp)/60000.0 < 10  THEN 'c:5-10min'
        WHEN (exit_timestamp-entry_timestamp)/60000.0 < 20  THEN 'd:10-20min'
        WHEN (exit_timestamp-entry_timestamp)/60000.0 < 60  THEN 'e:20-60min'
        WHEN (exit_timestamp-entry_timestamp)/60000.0 < 120 THEN 'f:1-2h'
        ELSE                                                      'g:>2h'
    END as bucket,
    COUNT(*),
    ROUND(100.0*SUM(CASE WHEN pnl_xrp>0 THEN 1 ELSE 0 END)/COUNT(*),1) as wr,
    ROUND(SUM(pnl_xrp),2) as net,
    ROUND(AVG(pnl_percent),1) as avg_pct
    FROM paper_trades WHERE status='closed' AND exit_reason!='force_close_no_price'
    AND exit_timestamp IS NOT NULL AND entry_timestamp IS NOT NULL
    GROUP BY bucket ORDER BY bucket""")
for r in c.fetchall():
    print(f"  {r[0]:12s}  cnt={r[1]:4d}  WR={r[2]}%  net={r[3]} XRP  avg={r[4]}%")

# ── 6. ENTRY SCORE vs OUTCOME ────────────────────────────────────
h("6. ENTRY SCORE vs WIN RATE")
c.execute("""SELECT
    CASE
        WHEN entry_score = 0    THEN 'a:0 (burst)'
        WHEN entry_score < 30   THEN 'b:1-29'
        WHEN entry_score < 50   THEN 'c:30-49'
        WHEN entry_score < 70   THEN 'd:50-69'
        ELSE                         'e:70+'
    END as bucket,
    COUNT(*),
    ROUND(100.0*SUM(CASE WHEN pnl_xrp>0 THEN 1 ELSE 0 END)/COUNT(*),1) as wr,
    ROUND(SUM(pnl_xrp),2) as net,
    ROUND(AVG(pnl_percent),1) as avg_pct
    FROM paper_trades WHERE status='closed' AND exit_reason!='force_close_no_price'
    GROUP BY bucket ORDER BY bucket""")
for r in c.fetchall():
    print(f"  score={r[0]:12s}  cnt={r[1]:4d}  WR={r[2]}%  net={r[3]} XRP  avg={r[4]}%")

# ── 7. PnL DISTRIBUTION ──────────────────────────────────────────
h("7. PnL DISTRIBUTION — where does money come from/go?")
c.execute("""SELECT
    CASE
        WHEN pnl_percent < -10  THEN 'a:<-10%'
        WHEN pnl_percent < -5   THEN 'b:-10 to -5%'
        WHEN pnl_percent < 0    THEN 'c:-5 to 0%'
        WHEN pnl_percent < 10   THEN 'd:0 to +10%'
        WHEN pnl_percent < 30   THEN 'e:+10 to +30%'
        WHEN pnl_percent < 100  THEN 'f:+30 to +100%'
        ELSE                         'g:>+100%'
    END as bucket,
    COUNT(*), ROUND(SUM(pnl_xrp),2) as net
    FROM paper_trades WHERE status='closed' AND exit_reason!='force_close_no_price'
    GROUP BY bucket ORDER BY bucket""")
for r in c.fetchall():
    print(f"  {r[0]:18s}  cnt={r[1]:4d}  net={r[2]} XRP")

# ── 8. POOL SIZE vs OUTCOME ──────────────────────────────────────
h("8. POOL SIZE AT ENTRY vs WIN RATE")
# need pool reserve — stored in entry_reason text or we estimate from snapshot
c.execute("""SELECT
    CASE
        WHEN entry_reason LIKE '%pool: %' THEN
            CAST(SUBSTR(entry_reason,
                INSTR(entry_reason,'pool: ')+6,
                INSTR(SUBSTR(entry_reason,INSTR(entry_reason,'pool: ')+6),' ')-1
            ) AS REAL)
        ELSE NULL
    END as pool_est,
    COUNT(*),
    ROUND(100.0*SUM(CASE WHEN pnl_xrp>0 THEN 1 ELSE 0 END)/COUNT(*),1) as wr,
    ROUND(SUM(pnl_xrp),2) as net
    FROM paper_trades WHERE status='closed' AND exit_reason!='force_close_no_price'
    AND entry_reason LIKE '[BURST]%'
    GROUP BY
    CASE
        WHEN pool_est IS NULL    THEN 'unknown'
        WHEN pool_est < 500      THEN 'a:<500 XRP'
        WHEN pool_est < 1000     THEN 'b:500-1k'
        WHEN pool_est < 2000     THEN 'c:1k-2k'
        WHEN pool_est < 5000     THEN 'd:2k-5k'
        ELSE                          'e:>5k'
    END
    ORDER BY MIN(pool_est)""")
for r in c.fetchall():
    print(f"  pool={str(r[0]):10s}  cnt={r[1]:4d}  WR={r[2]}%  net={r[3]} XRP")

# ── 9. WORST LOSS TRADES ─────────────────────────────────────────
h("9. WORST 10 LOSSES (all time)")
c.execute("""SELECT token_currency, trade_profile, trade_source,
    ROUND(pnl_xrp,2), ROUND(pnl_percent,1), exit_reason,
    ROUND((exit_timestamp-entry_timestamp)/60000.0,1) as hold_min,
    datetime(entry_timestamp/1000,'unixepoch') as entered
    FROM paper_trades WHERE status='closed' AND pnl_xrp IS NOT NULL AND pnl_xrp < 0
    ORDER BY pnl_xrp ASC LIMIT 10""")
for r in c.fetchall():
    print(f"  {r[7]}  {r[0]:12s} {r[1]:15s} src={r[2]:8s}  {r[3]:7.2f} XRP  {r[4]:8.1f}%  {r[5]:30s}  hold={r[6]}min")

# ── 10. BEST WIN TRADES ──────────────────────────────────────────
h("10. BEST 10 WINS (all time)")
c.execute("""SELECT token_currency, trade_profile, trade_source,
    ROUND(pnl_xrp,2), ROUND(pnl_percent,1), exit_reason,
    ROUND((exit_timestamp-entry_timestamp)/60000.0,1) as hold_min,
    datetime(entry_timestamp/1000,'unixepoch') as entered
    FROM paper_trades WHERE status='closed' AND pnl_xrp IS NOT NULL AND pnl_xrp > 0
    ORDER BY pnl_xrp DESC LIMIT 10""")
for r in c.fetchall():
    print(f"  {r[7]}  {r[0]:12s} {r[1]:15s} src={r[2]:8s}  {r[3]:7.2f} XRP  {r[4]:8.1f}%  {r[5]:30s}  hold={r[6]}min")

# ── 11. REPEAT TOKEN PATTERNS ────────────────────────────────────
h("11. TOKENS TRADED 3+ TIMES (pattern tokens)")
c.execute("""SELECT token_currency, COUNT(*) as trades,
    SUM(CASE WHEN pnl_xrp>0 THEN 1 ELSE 0 END) as wins,
    ROUND(SUM(pnl_xrp),2) as net,
    GROUP_CONCAT(DISTINCT exit_reason) as reasons
    FROM paper_trades WHERE status='closed' AND exit_reason!='force_close_no_price'
    GROUP BY token_currency HAVING trades >= 3
    ORDER BY trades DESC""")
for r in c.fetchall():
    print(f"  {r[0]:15s}  trades={r[1]}  wins={r[2]}  net={r[3]} XRP  exits: {r[4]}")

# ── 12. OPEN POSITIONS RIGHT NOW ─────────────────────────────────
h("12. CURRENTLY OPEN POSITIONS")
c.execute("""SELECT token_currency, trade_profile, trade_source,
    ROUND(entry_amount_xrp,2),
    ROUND((strftime('%s','now')*1000 - entry_timestamp)/60000.0,0) as age_min,
    exit_reason, remaining_position
    FROM paper_trades WHERE status='open'""")
rows = c.fetchall()
if rows:
    for r in rows:
        print(f"  {r[0]:15s} {r[1]:15s} src={r[2]:8s}  size={r[3]} XRP  age={r[4]}min  rem={r[6]}%")
else:
    print("  (none)")

# ── 13. DAILY PnL TREND ──────────────────────────────────────────
h("13. DAILY PnL TREND (last 14 days)")
c.execute("""SELECT
    DATE(entry_timestamp/1000,'unixepoch') as day,
    COUNT(*) as trades,
    SUM(CASE WHEN pnl_xrp>0 THEN 1 ELSE 0 END) as wins,
    ROUND(SUM(pnl_xrp),2) as net,
    ROUND(100.0*SUM(CASE WHEN pnl_xrp>0 THEN 1 ELSE 0 END)/COUNT(*),0) as wr
    FROM paper_trades WHERE status='closed' AND exit_reason!='force_close_no_price'
    AND entry_timestamp > (strftime('%s','now')-14*86400)*1000
    GROUP BY day ORDER BY day DESC""")
for r in c.fetchall():
    bar = '+' * max(0, int((r[3] or 0)/2)) if (r[3] or 0) > 0 else '-' * max(0, int(abs(r[3] or 0)/2))
    print(f"  {r[0]}  {r[1]:3d}t  WR={r[4]:3d}%  net={r[3]:+7.2f} XRP  {bar}")

# ── 14. HOUR-OF-DAY WIN RATE (UTC) ──────────────────────────────
h("14. HOUR-OF-DAY WIN RATE (UTC, excl ghosts, all time)")
c.execute("""SELECT
    CAST(strftime('%H', entry_timestamp/1000,'unixepoch') AS INT) as hr,
    COUNT(*) as trades,
    ROUND(100.0*SUM(CASE WHEN pnl_xrp>0 THEN 1 ELSE 0 END)/COUNT(*),0) as wr,
    ROUND(SUM(pnl_xrp),2) as net
    FROM paper_trades WHERE status='closed' AND exit_reason!='force_close_no_price'
    GROUP BY hr ORDER BY hr""")
for r in c.fetchall():
    bar = '#' * max(0, int((r[2] or 0)/5))
    print(f"  {r[0]:02d}h  {r[1]:3d}t  WR={r[2]:3.0f}%  net={r[3]:+7.2f}  {bar}")

# ── 15. DUPLICATE / RACE CONDITIONS ─────────────────────────────
h("15. DUPLICATE TRADE DETECTOR (same token, entries <10s apart)")
c.execute("""SELECT a.token_currency, a.trade_source, b.trade_source,
    ROUND((b.entry_timestamp - a.entry_timestamp)/1000.0,1) as gap_sec,
    datetime(a.entry_timestamp/1000,'unixepoch') as t1
    FROM paper_trades a JOIN paper_trades b
    ON a.token_currency = b.token_currency
    AND a.id < b.id
    AND (b.entry_timestamp - a.entry_timestamp) BETWEEN 0 AND 10000
    ORDER BY gap_sec ASC LIMIT 20""")
dups = c.fetchall()
if dups:
    for r in dups: print(f"  {r[4]}  {r[0]:15s}  src1={r[1]:8s} src2={r[2]:8s}  gap={r[3]}s  *** POSSIBLE DUPE ***")
else:
    print("  No duplicates found (good)")

# ── 16. GHOST CLOSE PATTERN ─────────────────────────────────────
h("16. GHOST CLOSE ANALYSIS (force_close_no_price)")
c.execute("""SELECT token_currency, COUNT(*) as ghost_cnt,
    ROUND(AVG((exit_timestamp-entry_timestamp)/60000.0),1) as avg_hold_min
    FROM paper_trades WHERE exit_reason='force_close_no_price'
    GROUP BY token_currency ORDER BY ghost_cnt DESC LIMIT 15""")
for r in c.fetchall():
    print(f"  {r[0]:15s}  ghosts={r[1]}  avg_hold={r[2]}min")

# ── 17. PARTIAL CLOSE MATH CHECK ────────────────────────────────
h("17. PARTIAL CLOSE MATH SANITY (trades with tp1_hit)")
c.execute("""SELECT token_currency, trade_profile,
    ROUND(entry_amount_xrp,2) as entry,
    ROUND(xrp_returned,2) as returned,
    ROUND(pnl_xrp,2) as pnl,
    ROUND(pnl_percent,1) as pct,
    remaining_position, exit_reason
    FROM paper_trades WHERE status='closed' AND tp1_hit=1
    ORDER BY entry_timestamp DESC LIMIT 20""")
for r in c.fetchall():
    # Sanity: pnl = returned - entry (approximately)
    expected_pnl = round(r[3] - r[2], 2) if r[3] and r[2] else None
    mismatch = abs(expected_pnl - r[4]) > 0.1 if expected_pnl is not None and r[4] is not None else False
    flag = "  *** PnL MISMATCH ***" if mismatch else ""
    print(f"  {r[0]:12s} {r[1]:15s}  entry={r[2]:5.1f}  ret={r[3]:5.1f}  pnl={r[4]:6.2f}  pct={r[5]:7.1f}%  rem={r[6]}%  {r[7]}{flag}")

conn.close()
print("\n=== ANALYSIS COMPLETE ===")
