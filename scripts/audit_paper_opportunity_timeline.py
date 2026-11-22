#!/usr/bin/env python3
"""Read-only, exact-issue HUNTERIX PAPER opportunity timeline.

First detection is the first BOT-TRACKED observation, not the token's ledger
creation time. A new event table starts with V2.1; it is never backfilled with
invented first-signal times. Subsequent highs are sampled spot observations,
NOT executable AMM sell quotes or an achievable trading counterfactual.
"""
from __future__ import annotations
import argparse
from collections import Counter
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
import sqlite3
import sys

EVENTS = "paper_opportunity_events"

def timestamp(ms):
    if ms is None:
        return "unknown"
    return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")

def open_ro(path):
    if not path.is_file() or path.is_symlink():
        raise RuntimeError("Missing regular PAPER epoch database: " + str(path))
    db = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=8)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA query_only=ON")
    db.execute("BEGIN")
    db.execute("SELECT 1 FROM sqlite_master LIMIT 1").fetchone()
    return db

def post_exit_high(db, trade, hours):
    if not trade["exit_timestamp"] or not trade["exit_price_xrp"] or trade["exit_price_xrp"] <= 0:
        return None
    codes = sorted(set([trade["token_currency"], trade["raw_currency"] or trade["token_currency"]]))
    marks = ",".join("?" for _ in codes)
    row = db.execute(
        "SELECT COUNT(*) AS n, MAX(price_xrp) AS high "
        "FROM market_snapshots WHERE token_issuer=? "
        "AND token_currency IN (" + marks + ") AND timestamp>? "
        "AND timestamp<=? AND price_xrp>0",
        [trade["token_issuer"], *codes, trade["exit_timestamp"],
         trade["exit_timestamp"] + hours * 3600000]
    ).fetchone()
    if not row or row["n"] < 2 or row["high"] is None:
        return {"samples": row["n"] if row else 0, "high_pct": None}
    return {"samples": row["n"],
            "high_pct": (row["high"] / trade["exit_price_xrp"] - 1) * 100}

def report(db_path, issuer=None, recent=30):
    if not 1 <= recent <= 200:
        raise RuntimeError("--recent must be between 1 and 200")
    with closing(open_ro(db_path)) as db:
        exists = db.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
            (EVENTS,)
        ).fetchone()
        print("=== HUNTERIX V2.1 OPPORTUNITY TIMELINE (READ ONLY) ===")
        print("Database:", db_path)
        if not exists:
            print("V2.1 event table absent; upgraded code has not created observations.")
            return
        where = "WHERE token_issuer=?" if issuer else ""
        params = (issuer,) if issuer else ()
        counts = db.execute(
            "SELECT event_type, COUNT(*) n FROM " + EVENTS + " " + where +
            " GROUP BY event_type ORDER BY event_type", params
        ).fetchall()
        print("Persisted events:", sum(int(r["n"]) for r in counts))
        for r in counts:
            print(" ", r["event_type"], r["n"])
        rows = db.execute(
            "SELECT * FROM " + EVENTS + " " + where +
            " ORDER BY observed_at DESC, id DESC LIMIT ?", (*params, recent)
        ).fetchall()
        print("\n=== RECENT OPPORTUNITY EVENTS ===")
        for r in reversed(rows):
            price = f'{r["price_xrp"]:.12g}' if r["price_xrp"] is not None else "unknown"
            detail = (r["detail"] or "")[:100]
            print(f'{timestamp(r["observed_at"])} {r["token_currency"][:18]:18s} '
                  f'{r["token_issuer"][:12]}... {r["event_type"]:17s} '
                  f'source={r["source"] or "-"} price={price} '
                  f'trade={r["trade_id"] or "-"} {detail}')
        if not issuer:
            print("\nPass --issuer EXACT_LEDGER_ISSUER to inspect its trade lifecycle and subsequent prices.")
            print("Recent observations are not a representative sample of all XRPL tokens.")
            return
        issues = db.execute(
            "SELECT raw_currency, MIN(token_currency) name FROM " + EVENTS +
            " WHERE token_issuer=? GROUP BY raw_currency", (issuer,)
        ).fetchall()
        print("\n=== FIRST RECORDED MILESTONES FOR THIS ISSUER ===")
        for issue in issues:
            print("Issue:", issue["name"], issue["raw_currency"], issuer)
            for kind in ("first_detected", "burst_seen", "stream_quoted",
                         "burst_qualified", "stream_qualified",
                         "momentum_seen", "paper_entry", "paper_exit"):
                r = db.execute(
                    "SELECT MIN(observed_at) ts FROM " + EVENTS +
                    " WHERE token_issuer=? AND raw_currency=? AND event_type=?",
                    (issuer, issue["raw_currency"], kind)
                ).fetchone()
                if r and r["ts"] is not None:
                    print(" ", f'{kind:18s}', timestamp(r["ts"]))
        print("Missing milestones are UNKNOWN, not inferred from later trades.")
        trades = db.execute(
            "SELECT id, token_currency, raw_currency, token_issuer, "
            "entry_timestamp, entry_price_xrp, exit_timestamp, exit_price_xrp, "
            "exit_reason, status, pnl_xrp FROM paper_trades "
            "WHERE token_issuer=? ORDER BY entry_timestamp DESC LIMIT ?",
            (issuer, recent)
        ).fetchall()
        print("\n=== RECORDED PAPER TRADES & POST-EXIT OBSERVATIONS ===")
        for t in reversed(trades):
            print(f'#{t["id"]} {t["token_currency"]} {t["status"]} '
                  f'entry={timestamp(t["entry_timestamp"])} '
                  f'exit={timestamp(t["exit_timestamp"])} '
                  f'reason={t["exit_reason"] or "-"} net={t["pnl_xrp"]}')
            if t["status"] != "closed":
                print("  Open/partial inventory not marked to spot or executable quote.")
                continue
            for h in (1, 4, 24):
                v = post_exit_high(db, t, h)
                if v is None or v["high_pct"] is None:
                    print(f"  After {h}h: insufficient sampled prices "
                          f"({v['samples'] if v else 0} observations)")
                else:
                    print(f"  After {h}h: observed high vs exit "
                          f'{v["high_pct"]:+.1f}% ({v["samples"]} samples)')
        print("\nCAVEATS: No pre-V2.1 detection events are invented. First tracking "
              "is not ledger creation; overlapping post-exit periods cannot be "
              "summed. Spot highs are not executable proceeds, and missed "
              "moves cannot be inferred without a qualifying signal and "
              "fresh reserve-aware sell quote.")

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", required=True, type=Path)
    parser.add_argument("--issuer", default=None)
    parser.add_argument("--recent", type=int, default=30)
    args = parser.parse_args()
    try:
        report(args.db, args.issuer, args.recent)
        return 0
    except (RuntimeError, ValueError, sqlite3.Error, OverflowError) as exc:
        print("OPPORTUNITY AUDIT BLOCKED:", exc, file=sys.stderr)
        return 2

if __name__ == "__main__":
    raise SystemExit(main())
