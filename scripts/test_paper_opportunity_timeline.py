#!/usr/bin/env python3
"""Offline synthetic V2.1 timeline: exact issue, no future leakage or DB writes."""
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
import sqlite3
import tempfile
from audit_paper_opportunity_timeline import report

def main():
    with tempfile.TemporaryDirectory() as tmp:
        dbpath = Path(tmp) / "epoch.db"
        with sqlite3.connect(dbpath) as db:
            db.executescript("""
            CREATE TABLE paper_opportunity_events(
                id INTEGER PRIMARY KEY,token_currency TEXT,token_issuer TEXT,
                raw_currency TEXT,observed_at INTEGER,event_type TEXT,source TEXT,
                price_xrp REAL,trade_id INTEGER,detail TEXT,dedup_key TEXT UNIQUE
            );
            CREATE TABLE paper_trades(
                id INTEGER PRIMARY KEY,token_currency TEXT,raw_currency TEXT,
                token_issuer TEXT,entry_timestamp INTEGER,entry_price_xrp REAL,
                exit_timestamp INTEGER,exit_price_xrp REAL,exit_reason TEXT,
                status TEXT,pnl_xrp REAL
            );
            CREATE TABLE market_snapshots(
                id INTEGER PRIMARY KEY,token_currency TEXT,
                token_issuer TEXT,timestamp INTEGER,price_xrp REAL
            );
            """)
            for ident, issuer, code, name, when, kind, price in [
                (1,"rIssuerOne","AAA","AAA",1000000,"first_detected",None),
                (2,"rIssuerOne","AAA","AAA",2000000,"burst_seen",1.0),
                (3,"rIssuerOne","AAA","AAA",3000000,"paper_entry",1.0),
                (4,"rIssuerOne","AAA","AAA",4000000,"paper_exit",1.0),
                (5,"rIssuerTwo","AAA","AAA",2000000,"burst_seen",999.0),
            ]:
                db.execute(
                    "INSERT INTO paper_opportunity_events VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                    (ident,name,issuer,code,when,kind,"burst",price,
                     3 if kind.startswith("paper_") else None,None,str(ident))
                )
            db.execute("INSERT INTO paper_trades VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (3,"AAA","AAA","rIssuerOne",3000000,1,4000000,1,"time_stop_loss","closed",-0.01))
            db.execute("INSERT INTO market_snapshots VALUES(1,'AAA','rIssuerOne',5000000,1.1)")
            db.execute("INSERT INTO market_snapshots VALUES(2,'AAA','rIssuerOne',6000000,1.25)")
            db.execute("INSERT INTO market_snapshots VALUES(3,'AAA','rIssuerTwo',7000000,10000)")
        before = dbpath.read_bytes()
        out = StringIO()
        with redirect_stdout(out):
            report(dbpath, "rIssuerOne", 20)
        msg = out.getvalue()
        for phrase in ("first_detected","burst_seen", "paper_entry", "paper_exit",
                       "#3 AAA closed", "+25.0%", "Spot highs are not executable"):
            assert phrase in msg, (phrase,msg)
        assert "999" not in msg and "10000" not in msg, "different issuer contaminated audit"
        assert before == dbpath.read_bytes(), "read-only report changed SQLite"
        print("PASS V2.1 timeline: issuer-exact events, first timestamps, post-exit samples, no cross-issuer lookahead, read-only")

if __name__ == "__main__":
    main()
