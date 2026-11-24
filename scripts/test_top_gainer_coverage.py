#!/usr/bin/env python3
"""Offline issuer-exact coverage fixture; must not touch live PAPER/PM2."""
import io,sqlite3,tempfile
from pathlib import Path
from contextlib import redirect_stdout
from audit_top_gainer_coverage import report,parse_gainer_rows
T=1800000000000
CODE="424C41434B53574E000000000000000000000000"
A="rIssuerA"
B="rIssuerB"
def main():
  with tempfile.TemporaryDirectory() as d:
    path=Path(d)/"synthetic.paper.db"
    with sqlite3.connect(path) as c:
      c.executescript("""
        CREATE TABLE paper_opportunity_events(
          token_currency TEXT,token_issuer TEXT,raw_currency TEXT,
          observed_at INTEGER,event_type TEXT,detail TEXT,price_xrp REAL
        );
        CREATE TABLE tokens(
          currency TEXT,issuer TEXT,raw_currency TEXT,
          first_seen INTEGER,last_updated INTEGER
        );
        CREATE TABLE market_snapshots(
          token_currency TEXT,token_issuer TEXT,
          timestamp INTEGER,liquidity_xrp REAL
        );
        CREATE TABLE shadow_trades(
          currency TEXT,issuer TEXT,raw_currency TEXT,
          skipped_at INTEGER,reject_reason TEXT
        );
        CREATE TABLE paper_trades(
          id INTEGER PRIMARY KEY,token_currency TEXT,token_issuer TEXT,
          raw_currency TEXT,trade_source TEXT,status TEXT,
          entry_timestamp INTEGER,exit_timestamp INTEGER,
          pnl_xrp REAL,exit_reason TEXT
        );
      """)
      c.executemany("INSERT INTO paper_opportunity_events VALUES(?,?,?,?,?,?,?)",[
        ("BLACKSWN",A,CODE,T,"external_gainer_seen","24h change=149.45% vol24h=100 XRP",0.1),
        ("BLACKSWN",B,CODE,T,"external_gainer_seen","24h change=153.0% vol24h=200 XRP",0.2),
        ("SWOOF",A,"53574F4F46000000000000000000000000000000",
         T,"external_gainer_seen","24h change=55.00% vol24h=80 XRP",0.003),
        ("BLACKSWN",A,CODE,T-60000,"burst_seen","candidate",0.09),
        ("BLACKSWN",A,CODE,T-30000,"paper_entry","",0.09),
        ("BLACKSWN",B,CODE,T-60000000,"first_detected","",None),
        ("SWOOF",A,"53574F4F46000000000000000000000000000000",
         T-30000,"first_detected","",None),
      ])
      c.execute("INSERT INTO tokens VALUES(?,?,?,?,?)",
                ("BLACKSWN",A,CODE,T-60*3600000,T-100000))
      c.execute("INSERT INTO market_snapshots VALUES(?,?,?,?)",
                ("BLACKSWN",A,T-100000,9000.0))
      c.execute("INSERT INTO shadow_trades VALUES(?,?,?,?,?)",
                ("BLACKSWN",A,CODE,T-200000,"Slippage too high"))
      c.execute("INSERT INTO paper_trades VALUES(?,?,?,?,?,?,?,?,?,?)",
                (1,"BLACKSWN",A,CODE,"burst","closed",T-30000,T+1000,-0.5,"kill"))
    before=path.read_bytes()
    out=io.StringIO()
    with redirect_stdout(out): report(path,3)
    s=out.getvalue()
    assert "Top distinct: 3" in s,s
    assert s.index("#1 BLACKSWN +153.00%")<s.index("#2 BLACKSWN +149.45%"),s
    assert "#1 BLACKSWN +153.00% [TRACKED_NO_SAMPLED_SIGNAL]" in s or (
      "#1 BLACKSWN +153.00% [NO_PRIOR_BOT_COVERAGE_EVIDENCE]" in s),s
    assert "#2 BLACKSWN +149.45% [TRADED_BEFORE_RANK]" in s,s
    assert "exact_issue_rejects: Slippage too high" in s,s
    assert "matching_paper_entries: #1 burst closed pnl=-0.5 XRP" in s,s
    assert "TRACKED_NO_SAMPLED_SIGNAL" in s,s
    assert path.read_bytes()==before,"read-only tool must not mutate fixture DB"
    print("PASS full latest snapshot ranking, distinct issuer isolation, prior sampling, reject and P&L linkage, no writes")
if __name__=="__main__":main()
