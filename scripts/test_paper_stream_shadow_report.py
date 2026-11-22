#!/usr/bin/env python3
"""Synthetic forward-window/issuer coverage regression. SQLite read only."""
import io
import sqlite3
import tempfile
from pathlib import Path
from contextlib import redirect_stdout
from audit_paper_stream_shadow import run

NOW=1700000000000+5*60*60*1000
BASE=1700000000000

def seed(p):
    with sqlite3.connect(p) as c:
        c.executescript("""
          CREATE TABLE paper_stream_shadow_signals (
            id INTEGER PRIMARY KEY, token_currency TEXT, token_issuer TEXT,
            raw_currency TEXT, observed_at INTEGER, signal_type TEXT,
            price_xrp REAL, unique_buyers INTEGER, buy_count_5m INTEGER,
            sell_count_5m INTEGER, buy_volume_xrp REAL
          );
          CREATE TABLE market_snapshots (
            id INTEGER PRIMARY KEY,token_currency TEXT,token_issuer TEXT,
            timestamp INTEGER,price_xrp REAL
          );
          CREATE TABLE paper_trades (
            entry_timestamp INTEGER,trade_source TEXT,entry_reason TEXT,
            status TEXT,xrp_returned REAL,entry_amount_xrp REAL
          );
        """)
        c.execute('INSERT INTO paper_stream_shadow_signals VALUES(1,?,?,?,?,?,?,?,?,?,?)',
                  ('TEST','rIssueA','5445535400000000000000000000000000000000',
                   BASE,'stream',1,2,2,1,416))
        c.execute('INSERT INTO paper_stream_shadow_signals VALUES(2,?,?,?,?,?,?,?,?,?,?)',
                  ('TEST','rIssueB','5445535400000000000000000000000000000000',
                   BASE+2*60*60*1000,'whale_stream',2,6,8,1,100))
        c.executemany('INSERT INTO market_snapshots VALUES(?,?,?,?,?)',[
            # First matched issuer has two observations, reaches +20%
            (1,'TEST','rIssueA',BASE+2*60000,1.2),
            (2,'TEST','rIssueA',BASE+6*60000,0.9),
            # Mismatching issuer must not create sample coverage for issue B
            (3,'TEST','rIssueC',BASE+2*60*60*1000+2*60000,2.5),
            (4,'TEST','rIssueC',BASE+2*60*60*1000+5*60000,3.5),
        ])
        c.execute("INSERT INTO paper_trades VALUES(?,?,?,?,?,?)",
                  (BASE+1,'burst','[BURST]', 'closed',5.6,5))
        c.execute("INSERT INTO paper_trades VALUES(?,?,?,?,?,?)",
                  (BASE+2,'stream','[STREAM]', 'closed',4.5,5))

def main():
    with tempfile.TemporaryDirectory() as d:
        path=Path(d)/'paper.db'
        seed(path)
        before=path.read_bytes()
        out=io.StringIO()
        with redirect_stdout(out):run(path,NOW,25)
        t=out.getvalue()
        for phrase in (
            'Eligible observations: 2',
            '0-2 buyers: 1',
            '6+ buyers: 1',
            '15m: matured=2, >=2 snapshots=1, one snapshot=0, no snapshots=1',
            '4h: matured=1, >=2 snapshots=1',
            'Observed high >= entry +15%: 1/1',
            'BURST since first shadow signal: entries=1 completed=1 wins=1',
            'NON-RANDOMIZED',
            'NOT actual TP fills',
        ):
            assert phrase in t,(phrase,t)
        assert before==path.read_bytes(),'audit must never mutate SQLite'
        empty=Path(d)/'empty.db'
        with sqlite3.connect(empty) as c:
            c.execute('CREATE TABLE other(x INTEGER)')
        with redirect_stdout(io.StringIO()) as o:
            run(empty,NOW,25)
        assert 'No V2 evidence table' in o.getvalue()
        print('PASS V2 STREAM shadow forensic: issuer-exact observed future windows, 15m/4h maturity, missing data, BURST comparator and read-only fixture')

if __name__=='__main__':main()
