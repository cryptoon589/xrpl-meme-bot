#!/usr/bin/env python3
"""Synthetic read-only liquidity loss case; no live PAPER or network."""
from contextlib import redirect_stdout
from pathlib import Path
import io,sqlite3,tempfile
from audit_liquidity_exits import report
T=1800000000000
RAW="53544F524D000000000000000000000000000000"
ISSUER="rSyntheticPoolIssuer"
def main():
  with tempfile.TemporaryDirectory() as dir:
    p=Path(dir)/"paper.db"
    with sqlite3.connect(p) as db:
      db.executescript("""
        CREATE TABLE paper_trades(
         id INTEGER,token_currency TEXT,token_issuer TEXT,raw_currency TEXT,
         entry_timestamp INTEGER,exit_timestamp INTEGER,
         entry_price_xrp REAL,exit_price_xrp REAL,
         entry_amount_xrp REAL,exit_reason TEXT,pnl_xrp REAL,status TEXT
        );
        CREATE TABLE market_snapshots(
         token_currency TEXT,token_issuer TEXT,timestamp INTEGER,
         price_xrp REAL,liquidity_xrp REAL
        );
      """)
      db.execute("INSERT INTO paper_trades VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        (140,"STORM",ISSUER,RAW,T,T+180000,0.1,0.05,5,
         "kill_liq_drop",-2.38,"closed"))
      db.executemany("INSERT INTO market_snapshots VALUES(?,?,?,?,?)",[
        ("STORM",ISSUER,T-100000,0.1,2000),
        ("STORM",ISSUER,T+181000,0.05,500),
        ("STORM","rOtherIssuer",T+181000,0.05,15000)])
    before=p.read_bytes()
    output=io.StringIO()
    with redirect_stdout(output):report(p,72,10)
    s=output.getvalue()
    assert "kill_liq_drop 1 -2.3800 XRP" in s,s
    assert "total_liquidity_change_near_trade: -75.0 %" in s,s
    assert "total_liq_xrp=15000" not in s,s
    assert p.read_bytes()==before,"read-only report mutated DB"
    print("PASS loss reasons, issuer-isolated nearby liquidity, no hypothetical fills, no writes")
if __name__=="__main__":main()
