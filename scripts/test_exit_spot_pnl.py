#!/usr/bin/env python3
"""Offline price-vs-net PAPER diagnostic regression (no production DB)."""
from contextlib import redirect_stdout
from pathlib import Path
import io,sqlite3,tempfile
from audit_exit_spot_pnl import report, analysis, summary

RAW="50554E5800000000000000000000000000000000"
BASE=1800000000000

def main():
  with tempfile.TemporaryDirectory() as tmp:
    path=Path(tmp)/"paper.db"
    with sqlite3.connect(path) as db:
      db.executescript("""
        CREATE TABLE paper_trades(
          id INTEGER PRIMARY KEY,token_currency TEXT,token_issuer TEXT,
          raw_currency TEXT,entry_price_xrp REAL,exit_price_xrp REAL,
          entry_amount_xrp REAL,entry_timestamp INTEGER,exit_timestamp INTEGER,
          xrp_returned REAL,slippage_estimate REAL,fees_paid REAL,
          tp1_hit INTEGER,tp2_hit INTEGER,exit_reason TEXT,pnl_xrp REAL,
          status TEXT
        );
      """)
      db.executemany("INSERT INTO paper_trades VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",[
        (133,"PUNX","rIssuer1",RAW,.001,.0013,5,BASE,BASE+100000,
         3.5,.01,.011,0,0,"stop_loss",-1.515,"closed"),
        (134,"PUNX","rIssuer2",RAW,.001,.00105,5,BASE,BASE+900000,
         5.50,.01,.012,0,0,"time_stop_profit",.485,"closed"),
        (140,"STORM","rIssuer3","53544F524D000000000000000000000000000000",
         .001,.001,5,BASE,BASE+15000,
         2.6,.01,.011,0,0,"kill_liq_drop",-2.415,"closed"),
        (142,"PHNIX","rIssuer4","50484E4958000000000000000000000000000000",
         .001,.0012,5,BASE,BASE+100000,
         4.0,.01,.011,1,0,"time_stop_profit",-1.015,"closed"),
        (143,"HODL","rIssuer5","484F444C00000000000000000000000000000000",
         .001,.001,5,BASE,BASE+100000,
         4.0,.01,.011,0,0,"time_stop_loss",-9.0,"closed")
      ])
    before=path.read_bytes()
    out=io.StringIO()
    with redirect_stdout(out): report(path,72,[133,134,140,142,143],15)
    s=out.getvalue()
    assert "Closed trades id > 72 : 5" in s,s
    assert "Booked P&L reconciliation anomalies: 1" in s,s
    assert "SPOT-UP / CASH-LOSS without TP1/TP2: 1" in s,s
    assert "CRITICAL: simulation P&L and recorded proceeds do NOT reconcile" in s,s
    assert "#133 PUNX" in s and "recorded_spot_change_pct: 30.0" in s,s
    assert "net_cash_returned_xrp: 3.5" in s,s
    assert "#134 PUNX" in s and "rIssuer2" in s,s
    assert "TP1/TP2=True" in s,s
    assert path.read_bytes()==before,"read-only forensic mutated database"
    print("PASS PAPER net proceeds reconciliation, partial exclusion, issuer identities, spot divergence and immutable SQLite")
if __name__=="__main__":main()
