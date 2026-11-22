#!/usr/bin/env python3
"""Synthetic regression: exact-issue independence, robust forward windows, no writes."""
import io
import sqlite3
import tempfile
from contextlib import redirect_stdout
from pathlib import Path
from audit_stream_issuer_quality import report, audited_window

BASE = 1_800_000_000_000
NOW = BASE + 5 * 3_600_000
RAW = "5445535400000000000000000000000000000000"

def seed(path):
    with sqlite3.connect(path) as c:
        c.executescript("""
            CREATE TABLE paper_stream_shadow_signals(
                id INTEGER PRIMARY KEY, token_currency TEXT, token_issuer TEXT,
                raw_currency TEXT, observed_at INTEGER, price_xrp REAL,
                unique_buyers INTEGER
            );
            CREATE TABLE market_snapshots(
                id INTEGER PRIMARY KEY, token_currency TEXT, token_issuer TEXT,
                timestamp INTEGER, price_xrp REAL
            );
        """)
        c.executemany(
            "INSERT INTO paper_stream_shadow_signals VALUES(?,?,?,?,?,?,?)",
            [
                (1, "TEST", "rIssuerA", RAW, BASE, 1.0, 2),
                (2, "TEST", "rIssuerA", RAW, BASE+40*60000, 1.0, 3),
                (3, "TEST", "rIssuerB", RAW, BASE, 2.0, 2),
                (4, "FLAT", "rIssuerC", "FLAT", BASE, 1.0, 2),
            ])
        a = [
            (2,1.0), (12,1.2),
            (43,1.0), (53,1.2),
            (95,1.3), (190,1.1), (222,1.1)
        ]
        c.executemany("INSERT INTO market_snapshots VALUES(?,?,?,?,?)",
                      [(i+1, "TEST", "rIssuerA", BASE+minute*60000, px)
                       for i,(minute,px) in enumerate(a)])
        c.executemany("INSERT INTO market_snapshots VALUES(?,?,?,?,?)",
                      [(100, "FLAT", "rIssuerC", BASE+2*60000, 1.0),
                       (101, "FLAT", "rIssuerC", BASE+12*60000, 1.0)])
        # A wrong-issuer high cannot create coverage for B.
        c.execute("INSERT INTO market_snapshots VALUES(?,?,?,?,?)",
                  (102, "TEST", "rIssuerD", BASE+4*60000, 999.0))

def main():
    with tempfile.TemporaryDirectory() as d:
        p=Path(d)/"fixture.db"
        seed(p)
        before=p.read_bytes()
        buf=io.StringIO()
        with redirect_stdout(buf):
            report(p, NOW, recent=5)
        out=buf.getvalue()
        assert "Eligible observations: 4" in out,out
        assert "Independent exact issues: 3" in out,out
        assert "Repeat observations: 1" in out,out
        assert "ALL OBSERVATIONS (CORRELATED)" in out,out
        assert "FIRST OBSERVATION PER EXACT ISSUE" in out,out
        assert "Observed high >=+15%: 1/1 ROBUST ONLY" in out,out
        assert "unchanged=1" in out,out
        assert "missing=1" in out,out
        assert "STREAM buyer estimates are legacy heuristics" in out,out
        assert p.read_bytes()==before,"Read-only audit mutated SQLite"

        with sqlite3.connect(p) as c:
            c.row_factory=sqlite3.Row
            rec=dict(c.execute("""
                SELECT token_currency,token_issuer,raw_currency,
                       observed_at,price_xrp
                FROM paper_stream_shadow_signals WHERE id=1
            """).fetchone())
            assert audited_window(c, rec, 900_000, NOW)["status"]=="covered"
            assert audited_window(c, rec, 14_400_000, NOW)["status"]=="covered"
            b=dict(rec, token_issuer="rIssuerB")
            assert audited_window(c,b,900_000,NOW)["status"]=="no_coverage"
            flat=dict(rec, token_currency="FLAT",raw_currency="FLAT",
                      token_issuer="rIssuerC")
            assert audited_window(c,flat,900_000,NOW)["status"]=="flat_quotes"
            assert audited_window(c,rec,900_000,BASE+1000)["status"]=="immature"
        print("PASS exact-issuer dedup, robust windows, flat/missing coverage and no-write audit")

if __name__=="__main__":
    main()
