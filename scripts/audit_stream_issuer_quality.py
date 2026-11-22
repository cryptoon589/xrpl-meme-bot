#!/usr/bin/env python3
"""Read-only XRPL PAPER STREAM cohort-quality audit.

Each first eligible observation is grouped by exact raw currency+issuer. Repeated
15-minute signals are shown separately, NOT treated as independent opportunities.
Only observed forward market snapshots with genuine price diversity and broad
time coverage qualify for the stricter comparable cohort. A spot high is NOT an
executable AMM quote or PnL. No retroactive trade signals are invented.
"""
from __future__ import annotations

import argparse
from collections import Counter
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
import math
import sqlite3
import statistics
import sys
import time

WINDOWS = (("15m", 900_000), ("1h", 3_600_000), ("4h", 14_400_000))

def open_ro(path: Path) -> sqlite3.Connection:
    if not path.is_file() or path.is_symlink():
        raise ValueError("PAPER epoch database must be an existing regular file")
    c = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=8)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA query_only=ON")
    c.execute("BEGIN")
    return c

def audited_window(c: sqlite3.Connection, signal: dict, ms: int, now: int) -> dict:
    start = int(signal["observed_at"])
    if start + ms > now:
        return {"status": "immature"}
    entry = float(signal["price_xrp"])
    if not math.isfinite(entry) or entry <= 0:
        return {"status": "invalid_entry"}
    r = c.execute("""
        SELECT COUNT(*) AS n, COUNT(DISTINCT price_xrp) AS varied,
               MIN(timestamp) AS first_at, MAX(timestamp) AS last_at,
               MIN(price_xrp) AS low, MAX(price_xrp) AS high
        FROM market_snapshots
        WHERE token_issuer=?
          AND token_currency IN (?,?)
          AND timestamp>? AND timestamp<=?
          AND price_xrp>0
    """, (signal["token_issuer"], signal["token_currency"],
          signal["raw_currency"], start, start+ms)).fetchone()
    if r["n"] < 2:
        return {"status": "no_coverage", "samples": int(r["n"])}
    if r["varied"] < 2:
        return {"status": "flat_quotes", "samples": int(r["n"])}
    if (r["first_at"] > start + ms * .25
            or r["last_at"] < start + ms * .75):
        return {"status": "narrow_span", "samples": int(r["n"])}
    return {"status": "covered", "samples": int(r["n"]),
            "high_pct": 100*(float(r["high"])/entry-1),
            "low_pct": 100*(float(r["low"])/entry-1)}

def summarise(c, signals: list[dict], now: int, label: str) -> None:
    print("\n=== " + label + " ===")
    for window, ms in WINDOWS:
        statuses = Counter()
        good = []
        for signal in signals:
            finding = audited_window(c, signal, ms, now)
            statuses[finding["status"]] += 1
            if finding["status"] == "covered":
                good.append(finding)
        matured = len(signals) - statuses["immature"]
        print(
            f"{window}: mature={matured}/{len(signals)} "
            f"robust={len(good)} "
            f"missing={statuses['no_coverage']} "
            f"unchanged={statuses['flat_quotes']} "
            f"poor_span={statuses['narrow_span']} "
            f"invalid_entry={statuses['invalid_entry']}"
        )
        if good:
            up = sum(x["high_pct"] >= 15 for x in good)
            high = statistics.median(x["high_pct"] for x in good)
            low = statistics.median(x["low_pct"] for x in good)
            print(
                f"  Observed high >=+15%: {up}/{len(good)} ROBUST ONLY; "
                f"median observed high {high:+.2f}% "
                f"median observed low {low:+.2f}%"
            )
        else:
            print("  No reliable high/low comparison available")

def report(db_path: Path, now: int | None = None, recent: int = 15) -> None:
    if not 1 <= recent <= 100:
        raise ValueError("--recent must be 1..100")
    if now is None:
        now = int(time.time()*1000)
    with closing(open_ro(db_path)) as c:
        names = {r["name"] for r in c.execute(
            "SELECT name FROM sqlite_master WHERE type='table'")}
        if not {"paper_stream_shadow_signals", "market_snapshots"} <= names:
            raise ValueError("Required STREAM evidence/market snapshot tables missing")
        signals = [dict(r) for r in c.execute("""
            SELECT token_currency,token_issuer,raw_currency,
                   observed_at,price_xrp,unique_buyers
            FROM paper_stream_shadow_signals ORDER BY observed_at,id
        """)]
        print("=== HUNTERIX: STREAM QUALITY BY EXACT ISSUER (READ ONLY) ===")
        print("Database:", db_path)
        print("Eligible observations:", len(signals))
        if not signals:
            print("No prospective evidence available")
            return
        unique = {}
        concentration = Counter()
        for s in signals:
            key = (s["raw_currency"], s["token_issuer"])
            if key not in unique:
                unique[key] = s
            concentration[key] += 1
        firsts = list(unique.values())
        print("Independent exact issues:", len(firsts))
        print("Repeat observations:", len(signals)-len(firsts),
              "(not independent token launches)")
        counts = Counter(
            "0-2" if (s["unique_buyers"] or 0) <= 2 else
            ("3-5" if s["unique_buyers"] <= 5 else "6+")
            for s in signals)
        print("Reported buyer breadth:", dict(sorted(counts.items())))
        print("STREAM buyer estimates are legacy heuristics, NOT proven purchases.")
        summarise(c, signals, now, "ALL OBSERVATIONS (CORRELATED)")
        summarise(c, firsts, now, "FIRST OBSERVATION PER EXACT ISSUE")
        print("\n=== MOST REPEATED ISSUES ===")
        for (raw, issuer), n in concentration.most_common(recent):
            if n <= 1: continue
            display = next(s["token_currency"] for s in signals
                           if s["raw_currency"] == raw
                           and s["token_issuer"] == issuer)
            print(f"{display[:18]:18} {issuer[:13]}... signals={n}")
        print("\nLIMITATIONS: historical observed spot highs are not executable "
              "AMM sale quotes, returns, or independently validated organic buys.")
        print("No trades placed, no DB mutations, no settings changed.")

def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--db", required=True, type=Path)
    p.add_argument("--recent", type=int, default=15)
    p.add_argument("--now-ms", type=int, help="Fixture tests only")
    a = p.parse_args()
    try:
        report(a.db, a.now_ms, a.recent)
        return 0
    except (OSError, sqlite3.Error, ValueError, OverflowError) as err:
        print("STREAM QUALITY AUDIT BLOCKED:", err, file=sys.stderr)
        return 2

if __name__ == "__main__":
    raise SystemExit(main())
