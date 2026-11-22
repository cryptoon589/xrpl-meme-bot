#!/usr/bin/env python3
"""Read-only V2.1 capture coverage: distinguish scans from signal callbacks.

This NEVER writes to the active PAPER database, claims a sampled spot price
is executable, or assumes a token row recently updated was newly inserted.
"""
from __future__ import annotations

import argparse
from collections import Counter
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
import sqlite3
import sys

TRACKED_TABLES = (
    ("market_snapshots", "timestamp"),
    ("scores", "timestamp"),
    ("risk_flags", "timestamp"),
    ("paper_opportunity_events", "observed_at"),
    ("paper_stream_shadow_signals", "observed_at"),
    ("shadow_trades", "skipped_at"),
)

def to_ms(iso: str) -> int:
    dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        raise ValueError("--since needs a timezone, e.g. 2026-11-22T16:01:54Z")
    return int(dt.timestamp() * 1000)

def fmt(ms):
    return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime(
        "%Y-%m-%d %H:%M:%S UTC") if ms is not None else "none"

def report(path: Path, since_ms: int) -> None:
    if not path.is_file() or path.is_symlink():
        raise ValueError("Expected regular PAPER epoch SQLite database")
    db = sqlite3.connect(path.resolve().as_uri()+"?mode=ro",uri=True,timeout=10)
    try:
        db.row_factory=sqlite3.Row
        db.execute("PRAGMA query_only=ON")
        db.execute("BEGIN")
        tables = {
            r[0] for r in db.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
        }
        print("=== V2.1 CAPTURE PIPELINE (READ ONLY) ===")
        print("Since:",fmt(since_ms))
        print("Database:",path)
        print("")
        print("=== RECORDED AFTER CUTOFF ===")
        stats={}
        for name,stamp in TRACKED_TABLES:
            if name not in tables:
                print(f"{name}: TABLE ABSENT")
                continue
            # SQL identifiers come ONLY from the hardcoded safe allowlist.
            r=db.execute(
                f"SELECT COUNT(*) AS n, MAX({stamp}) AS last "
                f"FROM {name} WHERE {stamp}>=?",(since_ms,)
            ).fetchone()
            stats[name]=int(r["n"])
            print(f'{name}: {r["n"]} rows | latest={fmt(r["last"])}')

        if "market_snapshots" in tables:
            x=db.execute("""
                SELECT COUNT(*) AS n,
                  COUNT(DISTINCT token_currency||char(31)||token_issuer) AS issues,
                  SUM(CASE WHEN price_xrp>0 THEN 1 ELSE 0 END) AS priced,
                  SUM(CASE WHEN buy_count_5m>=2 THEN 1 ELSE 0 END) AS two_buys,
                  SUM(CASE WHEN buy_volume_5m>=50 THEN 1 ELSE 0 END) AS volume,
                  SUM(CASE WHEN price_change_5m>=5 THEN 1 ELSE 0 END) AS rising_5m,
                  SUM(CASE WHEN price_change_15m>=3 THEN 1 ELSE 0 END) AS rising_15m
                FROM market_snapshots WHERE timestamp>=?
            """,(since_ms,)).fetchone()
            print("\n=== MARKET SNAPSHOT COVERAGE ===")
            print("Samples:",x["n"],"| exact displayed-issue pairs:",x["issues"])
            print("Positive sampled price:",x["priced"] or 0)
            print("2+ buys in 5m:",x["two_buys"] or 0)
            print("50+ XRP buy volume in 5m:",x["volume"] or 0)
            print("5m price change >=5%:",x["rising_5m"] or 0)
            print("15m price change >=3%:",x["rising_15m"] or 0)
            print("These are separate sample counts, NOT combined entry approvals.")
            print("Spot prices and historical changes are NOT executable trade quotes.")

        if "tokens" in tables:
            total=db.execute("SELECT COUNT(*) n FROM tokens").fetchone()["n"]
            changed=db.execute("""
                SELECT COUNT(*) AS n,
                  SUM(CASE WHEN first_seen<? THEN 1 ELSE 0 END) AS old,
                  SUM(CASE WHEN first_seen>=? THEN 1 ELSE 0 END) AS recent
                FROM tokens WHERE last_updated>=?
            """,(since_ms,since_ms,since_ms)).fetchone()
            print("\n=== TRACKED TOKEN ROWS ===")
            print("Total token rows:",total)
            print("Updated after cutoff:",changed["n"])
            print("  with older first_seen:",changed["old"] or 0)
            print("  with first_seen after cutoff:",changed["recent"] or 0)
            print("Updated != inserted. Without an inserted_at timestamp,")
            print("these counts CANNOT prove new database inserts.")

        if "paper_opportunity_events" in tables:
            n=db.execute("SELECT COUNT(*) n FROM paper_opportunity_events").fetchone()["n"]
            print("\n=== OPPORTUNITY EVENTS ALL TIME ===")
            print("Total:",n)
            for r in db.execute("""
                SELECT event_type,COUNT(*) n,MIN(observed_at) earliest,
                  MAX(observed_at) latest
                FROM paper_opportunity_events
                GROUP BY event_type ORDER BY n DESC
            """):
                print(r["event_type"],r["n"],
                      "first",fmt(r["earliest"]),"last",fmt(r["latest"]))
            if not n:
                print("No persisted signal evidence. This alone does not prove")
                print("a callback or database write failed; compare timestamped")
                print("current-process logs and transaction/scanner metrics.")
    finally:
        db.close()

def main()->int:
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--db",required=True,type=Path)
    p.add_argument("--since",required=True,help="Offset-aware ISO time e.g. 2026-11-22T16:01:54Z")
    args=p.parse_args()
    try:
        report(args.db,to_ms(args.since))
        return 0
    except (OSError,sqlite3.Error,ValueError,OverflowError) as exc:
        print("V2.1 COVERAGE AUDIT BLOCKED:",exc,file=sys.stderr)
        return 2

if __name__=="__main__":
    raise SystemExit(main())
