#!/usr/bin/env python3
"""Disposable SQLite regression for read-only V2.1 coverage audit."""
from __future__ import annotations
import io
import sqlite3
from contextlib import redirect_stdout
from pathlib import Path
import tempfile
from audit_v21_capture_coverage import report,to_ms

def run():
    with tempfile.TemporaryDirectory() as tmp:
        dbfile=Path(tmp)/"test.db"
        cutoff=to_ms("2026-11-22T16:01:54Z")
        with sqlite3.connect(dbfile) as db:
            db.executescript("""
                CREATE TABLE market_snapshots (
                  token_currency TEXT, token_issuer TEXT, timestamp INTEGER,
                  price_xrp REAL, buy_count_5m INTEGER,buy_volume_5m REAL,
                  price_change_5m REAL,price_change_15m REAL
                );
                CREATE TABLE tokens (
                  currency TEXT, issuer TEXT,first_seen INTEGER,last_updated INTEGER
                );
                CREATE TABLE paper_opportunity_events (
                  event_type TEXT,observed_at INTEGER
                );
                CREATE TABLE scores(timestamp INTEGER);
                CREATE TABLE risk_flags(timestamp INTEGER);
                CREATE TABLE paper_stream_shadow_signals(observed_at INTEGER);
                CREATE TABLE shadow_trades(skipped_at INTEGER);
            """)
            db.execute("INSERT INTO market_snapshots VALUES (?,?,?,?,?,?,?,?)",
                       ("AAA","rSynthetic",cutoff+1000,0.01,3,60,7,4))
            db.execute("INSERT INTO market_snapshots VALUES (?,?,?,?,?,?,?,?)",
                       ("AAA","rSynthetic",cutoff-1000,0.01,3,60,7,4))
            db.execute("INSERT INTO tokens VALUES (?,?,?,?)",
                       ("AAA","rSynthetic",cutoff-1000000,cutoff+2000))
        b=io.StringIO()
        with redirect_stdout(b):report(dbfile,cutoff)
        s=b.getvalue()
        assert "market_snapshots: 1 rows" in s,s
        assert "Positive sampled price: 1" in s,s
        assert "2+ buys in 5m: 1" in s,s
        assert "with older first_seen: 1" in s,s
        assert "No persisted signal evidence" in s,s
        assert sqlite3.connect(dbfile).execute(
            "SELECT COUNT(*) FROM paper_opportunity_events"
        ).fetchone()[0]==0
        print("PASS read-only coverage audit counts actual scans, not false first-detected events")

if __name__=="__main__":run()
