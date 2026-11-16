#!/usr/bin/env python3
"""Hunterix read-only PAPER trading forensic report.

Never opens a trading wallet, changes a database, or contacts XRPL.
Reads only compact recovery DB. Analysis may be incomplete for older
trades saved before xrp_returned / fees were recorded accurately.
"""
import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3
from statistics import median

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DB = ROOT / "data" / "meme_bot.recovery.db"
DAY_MS = 24 * 60 * 60 * 1000

def n(v, fallback=0.0):
    try:
        if v is None: return fallback
        x = float(v)
        return x if -1e16 < x < 1e16 else fallback
    except (TypeError, ValueError):
        return fallback

def iso(ms):
    if not ms: return "unknown"
    try: return datetime.fromtimestamp(float(ms) / 1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    except (ValueError, OverflowError, OSError): return "invalid"

def tbl(con, name):
    return bool(con.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone())

def count(con, name):
    return con.execute("SELECT COUNT(*) FROM " + name).fetchone()[0] if tbl(con, name) else None

def stats(rows):
    if not rows: return "n=0"
    pnls = [r["economic_pnl"] for r in rows]
    pos = [p for p in pnls if p > 0]
    neg = [p for p in pnls if p < 0]
    total = sum(pnls)
    pf = sum(pos) / abs(sum(neg)) if neg else float("inf") if pos else 0
    win_rate = len(pos) / len(rows) * 100
    mean = total / len(rows)
    return ("n=%d wins=%.1f%% net=%+.3f XRP avg=%+.3f XRP "
            "median=%+.3f XRP PF=%s" %
            (len(rows), win_rate, total, mean, median(pnls),
             "%.2f" % pf if pf != float("inf") else "inf(no losses)"))

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--starting-bankroll", type=float, default=100,
                        help="Cash reconstruction assumption, NOT verified from DB")
    args = parser.parse_args()
    source = args.db.resolve()
    if not source.is_file(): raise SystemExit(f"Database missing: {source}")
    con = sqlite3.connect(source.as_uri() + "?mode=ro", uri=True, timeout=8)
    con.row_factory = sqlite3.Row
    try:
        print("HUNTERIX PAPER FORENSIC AUDIT -- READ ONLY")
        print("Database:", source)
        print("Report time:", datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"))
        print("SQLite quick_check:", con.execute("PRAGMA quick_check").fetchone()[0])
        counts = {t: count(con, t) for t in
                  ["tokens", "token_archive", "paper_trades", "market_snapshots",
                   "scores", "risk_flags", "shadow_trades", "missed_opportunities",
                   "profile_stats", "daily_summaries"]}
        print("Table counts:", json.dumps(counts, sort_keys=True))
        if not tbl(con,"paper_trades"):
            print("MISSING paper_trades table -- cannot assess profitability")
            return

        rows = [dict(row) for row in con.execute("SELECT * FROM paper_trades ORDER BY entry_timestamp, id")]
        statuses = Counter(str(r.get("status") or "NULL") for r in rows)
        print("Trade statuses:", json.dumps(statuses, sort_keys=True))

        anomalies, closed_economic, open_rows = [], [], []
        ghosts, unreconciled, all_closed = [], [], []
        total_entry = total_returned = entry_fees_est = 0.0
        for r in rows:
            trade_id = r.get("id")
            entry = n(r.get("entry_amount_xrp"))
            returned = n(r.get("xrp_returned"))
            fees = n(r.get("fees_paid"))
            price = n(r.get("entry_price_xrp"))
            rem = n(r.get("remaining_position"), 100.0)
            fee_est = entry * 0.003  # matches current PAPER openTrade formulas
            total_entry += entry
            total_returned += returned
            entry_fees_est += fee_est
            flags = []
            if entry <= 0: flags.append("bad_entry_amount")
            if price <= 0: flags.append("bad_entry_price")
            if rem < -0.001 or rem > 100.001: flags.append("invalid_remaining_pct")
            if fees < 0: flags.append("negative_fees")
            if fees + 1e-8 < fee_est: flags.append("fees_less_than_current_entry_assumption")
            if r.get("status") == "closed" and rem > 0.001: flags.append("closed_with_remaining")
            if r.get("status") in ("open", "partial") and rem <= 0.001: flags.append("open_with_zero_remaining")
            if r.get("status") == "closed" and not r.get("exit_timestamp"): flags.append("closed_without_exit_timestamp")
            if r.get("status") in ("open", "partial") and r.get("exit_timestamp"): flags.append("open_with_exit_timestamp")
            if flags:
                anomalies.append((trade_id, str(r.get("token_currency")), ",".join(flags)))

            if r.get("status") in ("open","partial"):
                open_rows.append(r)
            if r.get("status") != "closed": continue
            all_closed.append(r)
            if r.get("exit_reason") == "force_close_no_price":
                ghosts.append(r)
                continue
            if returned <= 0 or entry <= 0:
                unreconciled.append(r)
                continue
            r["economic_pnl"] = returned - entry - fee_est
            r["recorded_pnl"] = n(r.get("pnl_xrp"))
            r["delta_pnl"] = r["economic_pnl"] - r["recorded_pnl"]
            closed_economic.append(r)

        print("\nACCOUNTING / RESTART INTEGRITY")
        print("Closed trades:", len(all_closed), "| economic sample:", len(closed_economic),
              "| ghost closes:", len(ghosts), "| missing/zero proceeds:", len(unreconciled))
        print("PAPER cashflow reconstruction (assumed start %.2f XRP):" % args.starting_bankroll)
        reconstructed = args.starting_bankroll - total_entry - entry_fees_est + total_returned
        print("  entry spend %.3f XRP, modeled entry fees %.3f XRP, saved net proceeds %.3f XRP" %
              (total_entry, entry_fees_est, total_returned))
        print("  reconstructed cash = %.3f XRP (NOT equity; excludes open-position market value)" % reconstructed)
        print("  WARNING: historic entry fee model may differ from current .3%% assumption.")
        diffs = [r for r in closed_economic if abs(r["delta_pnl"]) > 0.001]
        print("Closed-trade reported PnL reconciliation differences >0.001 XRP:",
              len(diffs), "/", len(closed_economic))
        if diffs:
            total_missing = sum(r["delta_pnl"] for r in closed_economic)
            print("  economic minus recorded across analyzable closed trades: %+.3f XRP" % total_missing)
        print("Open/partial positions:", len(open_rows))
        for r in open_rows[:15]:
            rem = n(r.get("remaining_position"),100.0)
            entry = n(r.get("entry_amount_xrp"))
            realized = n(r.get("xrp_returned")) - entry * (1-rem/100) - entry*.003*(1-rem/100)
            print("  id=%s token=%s status=%s entry=%.4f XRP remaining=%.1f%% "
                  "proceeds=%.4f XRP est_realized=%+.4f XRP" %
                  (r.get("id"),str(r.get("token_currency"))[:26],r.get("status"),entry,rem,
                   n(r.get("xrp_returned")),realized))
        print("Anomaly counts:", dict(Counter(f for _,_,csv in anomalies for f in csv.split(","))))
        for i,token,flags in anomalies[:15]: print("  anomaly id=%s token=%s flags=%s" % (i,token[:24],flags))

        print("\nPROFITABILITY (RECONSTRUCTABLE CLOSED, EXCLUDING GHOSTS)")
        print("All:", stats(closed_economic))
        now = datetime.now(timezone.utc).timestamp()*1000
        for days in [1, 7, 30]:
            subset = [r for r in closed_economic if n(r.get("exit_timestamp")) > now - days*DAY_MS]
            print("Last %sd:" % days,stats(subset))
        by_source = defaultdict(list)
        by_reason = defaultdict(list)
        for r in closed_economic:
            reason = str(r.get("entry_reason") or "")
            source = str(r.get("trade_source") or "")
            if not source:
                source = "burst" if reason.startswith("[BURST]") else "scored_or_unknown"
            by_source[source].append(r)
            by_reason[str(r.get("exit_reason") or "unknown")].append(r)
        print("By entry source:")
        for source,items in sorted(by_source.items(),key=lambda x:-len(x[1]))[:12]:
            print("  %s: %s" % (source,stats(items)))
        print("By exit reason:")
        for reason,items in sorted(by_reason.items(),key=lambda x:-len(x[1]))[:15]:
            print("  %s: %s" % (reason,stats(items)))

        print("\nEXECUTION REALISM / QUALITY")
        hit = sum(bool(r.get("tp1_hit")) for r in all_closed)
        print("TP1-hit closed trades: %s / %s" % (hit,len(all_closed)))
        print("Ghost closures (not executable profits):",len(ghosts))
        giant = [r for r in closed_economic if abs(r["economic_pnl"]) > max(100, abs(n(r.get("entry_amount_xrp")))*20)]
        print("Extreme closed outcomes (>100 XRP or >20x entry):",len(giant))
        if giant: print("  ids:",[r["id"] for r in giant[:12]])
        late = [r for r in all_closed if n(r.get("exit_timestamp"))-n(r.get("entry_timestamp")) > 7*DAY_MS]
        print("Held over 7 days:",len(late))
        if tbl(con,"shadow_trades"):
            unresolved=con.execute("SELECT COUNT(*) FROM shadow_trades WHERE resolved_at IS NULL").fetchone()[0]
            print("Unresolved shadow-trade outcomes:",unresolved)
        if tbl(con,"market_snapshots"):
            snapshots=con.execute("SELECT MIN(timestamp),MAX(timestamp) FROM market_snapshots").fetchone()
            print("Snapshot coverage:",iso(snapshots[0]),"to",iso(snapshots[1]))
        if tbl(con,"scores"):
            scores=con.execute("SELECT MIN(timestamp),MAX(timestamp) FROM scores").fetchone()
            print("Score coverage:",iso(scores[0]),"to",iso(scores[1]))
        if tbl(con,"paper_trades"):
            dates=con.execute("SELECT MIN(entry_timestamp),MAX(entry_timestamp) FROM paper_trades").fetchone()
            print("Trade entry coverage:",iso(dates[0]),"to",iso(dates[1]))
        print("NOTE: no real fill metadata, order book depth at execution, transfer fees, or on-chain trade receipts are validated by this report.")
        print("NOTE: source marks earlier rows with incomplete xrp_returned as unreconciled, NOT zero profit.")

        recfile=ROOT/"state"/"recommendations.json"
        print("\nLEARNING STATE")
        if recfile.exists():
            try:
                rec=json.loads(recfile.read_text(encoding="utf-8"))
                fields=["generatedAt","tradesAnalyzed","overallWinRate","autoApplyReady",
                        "entryPullbackPct","entryConfirmBars","burstTp1Percent",
                        "burstTp2Percent","scoredTp1Percent","scoredTp2Percent",
                        "tradingPauseEnabled"]
                print(json.dumps({k:rec.get(k) for k in fields},sort_keys=True))
            except (OSError,ValueError) as e: print("Could not read recommendations:",type(e).__name__)
        else:
            print("No recommendations.json found")
        print("\nREAD-ONLY FORENSIC AUDIT COMPLETE. No trades or DB records were modified.")
    finally:
        con.close()

if __name__=="__main__":
    main()
