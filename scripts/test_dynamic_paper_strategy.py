#!/usr/bin/env python3
"""Synthetic regression for read-only source/profile/exit strategy report."""
from __future__ import annotations
from contextlib import redirect_stdout,redirect_stderr
from io import StringIO
from pathlib import Path
import sqlite3
import tempfile

from audit_dynamic_paper_strategy import print_audit, outcome, describe_source

CASH_BASE=105.499759
NOW=1763740000000
ROWS=[
    # id, symbol, issuer, status, pnl, left, reason, source, buyers, tp1
    (17,'PUNX','rIssuerA','closed', 1.1672,0.0,'take_profit_2','stream',2,1),
    (18,'JEZUS','rIssuerB','closed',-0.7164,0.0,'stop_loss','stream',2,0),
    (19,'V4X','rIssuerC','closed',-0.7018,0.0,'stop_loss','stream',5,0),
    (20,'PHNIX','rIncorrect','closed',-0.2124,0.0,'kill_no_followthrough','stream',2,0),
    (21,'PHNIX','rOfficial','open',0,100.0,None,'stream',2,0),
    (22,'PUNX','rIssuerA','partial',0.30,40.0,None,'burst',6,1),
    (23,'SWARM','rIssuerD','open',0,100.0,None,'burst',3,0),
]

def build(path:Path,current:bool):
    with sqlite3.connect(path) as db:
        db.executescript("""
            CREATE TABLE paper_trades (
              id INTEGER PRIMARY KEY, token_currency TEXT, token_issuer TEXT,
              raw_currency TEXT,status TEXT,entry_amount_xrp REAL,
              entry_price_xrp REAL,entry_timestamp INTEGER,
              exit_timestamp INTEGER,xrp_returned REAL,pnl_xrp REAL,
              remaining_position REAL,tp1_hit INTEGER,tp2_hit INTEGER,
              entry_reason TEXT,exit_reason TEXT,trade_source TEXT,
              trade_profile TEXT,entry_score INTEGER
            );
            CREATE TABLE paper_inventory(trade_id INTEGER PRIMARY KEY,tokens_held REAL);
            CREATE TABLE paper_cash_state(singleton_id INTEGER PRIMARY KEY,bankroll_xrp REAL);
            CREATE TABLE market_snapshots(
               id INTEGER PRIMARY KEY,token_currency TEXT,token_issuer TEXT,
               timestamp INTEGER,price_xrp REAL
            );
        """)
        for i in range(1,17):
            db.execute("""
              INSERT INTO paper_trades(id,token_currency,token_issuer,status,
                entry_amount_xrp,entry_price_xrp,entry_timestamp,exit_timestamp,
                xrp_returned,pnl_xrp,remaining_position,tp1_hit,tp2_hit,
                exit_reason,trade_profile,trade_source)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """,(i,'OLD'+str(i),'rOld','closed',1,1,NOW-9000000,NOW-8000000,
                 1.003,0,0,0,0,'old','BURST_SCALP','burst'))
            db.execute('INSERT INTO paper_inventory VALUES(?,0)',(i,))
        cash=CASH_BASE
        if current:
            for i,name,issuer,status,pnl,remaining,reason,src,buyers,tp1 in ROWS:
                entry=NOW+i*200000
                finish=entry+600000 if status=='closed' else None
                ret=0 if status=='open' else (
                    5*1.003*(100-remaining)/100+pnl)
                if status=='open':stored_pnl=None
                else:stored_pnl=pnl
                db.execute("""
                  INSERT INTO paper_trades VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                """,(i,name,issuer,None,status,5.0,1.0,entry,finish,ret,stored_pnl,
                     remaining,tp1,0,
                     ('[STREAM]' if src=='stream' else '[BURST]')+
                     f' {buyers} buyers 80% buys 416 XRP | profile: BURST_SCALP',
                     reason,src,'BURST_SCALP',75))
                db.execute('INSERT INTO paper_inventory VALUES(?,?)',
                           (i,0 if status=='closed' else 1000*remaining/100))
                cash-=5*1.003
                cash+=ret
                if i==20:
                    db.execute('INSERT INTO market_snapshots VALUES(?,?,?,?,?)',
                               (1,name,issuer,entry+100000,1.20))
                    db.execute('INSERT INTO market_snapshots VALUES(?,?,?,?,?)',
                               (2,name,issuer,entry+300000,0.94))
        db.execute('INSERT INTO paper_cash_state VALUES(1,?)',(cash,))

def run():
    with tempfile.TemporaryDirectory() as tmp:
        old=Path(tmp)/'baseline.db'
        curr=Path(tmp)/'epoch.db'
        build(old,False);build(curr,True)
        files_before=(old.read_bytes(),curr.read_bytes())
        out=StringIO()
        with redirect_stdout(out):
            print_audit(curr,old)
        text=out.getvalue()
        for expected in (
            "PASS: cash reconciles",
            "7 new", "4 (1 wins, 3 non-wins)",
            "Net closed PnL:",
            "ENTRY SOURCE",
            "stream",
            "burst",
            "STORED TRADE PROFILE",
            "kill_no_followthrough",
            "EXIT PATH CLASSIFICATION WARNING",
            "5 stream-origin trades recorded as BURST_SCALP",
            "1-2 buyers",
            "6+ buyers",
            "IDENTITY ALERT: ticker PHNIX used by 2 distinct issuers",
            "OBSERVED in-trade price >= entry +15%: 1",
            "Open-position valuation: UNKNOWN",
        ):
            assert expected in text,(expected,text)
        assert files_before==(old.read_bytes(),curr.read_bytes()),'read-only audit modified database'
        assert abs(outcome({'entry_amount_xrp':5,'remaining_position':40,
               'xrp_returned':5*1.003*0.6+0.3})-0.3)<1e-10
        assert describe_source({'trade_source':'stream','entry_reason':'[STREAM] test'})=='stream'
        with sqlite3.connect(curr) as db:
            db.execute('UPDATE paper_cash_state SET bankroll_xrp=bankroll_xrp+1')
        try:
            with redirect_stdout(StringIO()):
                print_audit(curr,old)
        except RuntimeError as ex:
            assert 'Cash movements DO NOT reconcile' in str(ex),str(ex)
        else:
            raise AssertionError('strategy audit must fail closed on economically inconsistent cash')
        print('PASS full strategy audit fixture: entry/exit segmentation, source/profile mismatch, 2-buyer gate, issuer collision, MFE versus sellability caveat, no database writes and cash fail-closed')
if __name__=='__main__':run()
