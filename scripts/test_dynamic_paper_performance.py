#!/usr/bin/env python3
"""Synthetic SQLite regression for the read-only dynamic PAPER audit."""
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

AUDIT=Path(__file__).with_name("audit_dynamic_paper_performance.py")
CASH=105.49975938260103
CASES=[
    # id, token, status, entry, returned, remaining, stored PNL, TP1, TP2, reason
    (17,"PUNX","partial",5.0,5.262354716906869,15.0,0.999605,1,1,None),
    (18,"JEZUS","closed",5.0,4.298630807756428,0.0,-0.716369,0,0,"stop_loss"),
    (19,"DRO","closed",7.63461,7.476125807294968,0.0,-0.181388,0,0,"time_stop_loss"),
    (20,"V4X","open",5.0,0.0,100.0,None,0,0,None),
]

def populate(p,with_new=False):
    db=sqlite3.connect(p)
    db.executescript("""
    CREATE TABLE paper_trades(
      id INTEGER PRIMARY KEY,token_currency TEXT,token_issuer TEXT,status TEXT,
      entry_amount_xrp REAL,xrp_returned REAL,pnl_xrp REAL,remaining_position REAL,
      tp1_hit INTEGER,tp2_hit INTEGER,exit_reason TEXT,trade_profile TEXT,trade_source TEXT
    );
    CREATE TABLE paper_inventory(trade_id INTEGER PRIMARY KEY,tokens_held REAL);
    CREATE TABLE paper_cash_state(singleton_id INTEGER PRIMARY KEY,bankroll_xrp REAL);
    """)
    for i in range(1,17):
        db.execute("INSERT INTO paper_trades VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                   (i,"OLD"+str(i),"rOld","closed",1.0,1.003,0.0,0.0,0,0,"old",
                    "BURST_SCALP","burst"))
        db.execute("INSERT INTO paper_inventory VALUES(?,0)",(i,))
    cash=CASH
    if with_new:
        cash-=sum(c[3] for c in CASES)
        cash+=sum(c[4] for c in CASES)
        for i,token,status,entry,returned,remaining,pnl,tp1,tp2,reason in CASES:
            db.execute("INSERT INTO paper_trades VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                       (i,token,"rTest",status,entry,returned,pnl,remaining,tp1,tp2,reason,
                        "BURST_SCALP","burst"))
            db.execute("INSERT INTO paper_inventory VALUES(?,?)",
                       (i, 0 if status=="closed" else 700 if status=="partial" else 1000))
    db.execute("INSERT INTO paper_cash_state VALUES(1,?)",(cash,))
    db.commit()
    db.close()

def run(current,base):
    return subprocess.run([sys.executable,str(AUDIT),"--db",str(current),
                           "--baseline",str(base)],capture_output=True,text=True)

def main():
    with tempfile.TemporaryDirectory() as d:
        root=Path(d)
        old=root/"old.db"
        current=root/"current.db"
        populate(old)
        populate(current,True)
        before=(current.read_bytes(),old.read_bytes())
        r=run(current,old)
        assert r.returncode==0,(r.stdout,r.stderr)
        for needle in ("4 new","fully closed: 2 (0 wins, 2 non-wins)",
                       "partial: 1 | open: 1","Combined realized: +0.101848",
                       "PUNX", "15.0%", "PASS: cash reconciles"):
            assert needle in r.stdout,(needle,r.stdout)
        assert (current.read_bytes(),old.read_bytes())==before,"read-only audit modified database"
        with sqlite3.connect(current) as db:
            db.execute("UPDATE paper_cash_state SET bankroll_xrp=bankroll_xrp+1")
        r=run(current,old)
        assert r.returncode==1 and "Cash movements DO NOT reconcile" in r.stderr,r.stderr
        with sqlite3.connect(current) as db:
            db.execute("UPDATE paper_cash_state SET bankroll_xrp=bankroll_xrp-1")
            db.execute("UPDATE paper_trades SET status='closed' WHERE token_currency='PUNX'")
        r=run(current,old)
        assert r.returncode==1 and "Closed trade" in r.stderr,r.stderr
        print("PASS read-only dynamic PAPER performance audit: completed win rate, partial realized PnL, no valuation of runners, cash and inventory checks")
if __name__=="__main__":main()
