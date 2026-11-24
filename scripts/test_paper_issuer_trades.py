#!/usr/bin/env python3
"""Offline identity/overlap forensic fixture; no real PAPER database."""
import io
import sqlite3
import tempfile
from contextlib import redirect_stdout
from pathlib import Path
from audit_paper_issuer_trades import report
ISSUER="rDFXbW2ZZCG5WgPtqwNiA2xZokLMm9ivmN"
RAW="50484E4958000000000000000000000000000000"
def main():
    with tempfile.TemporaryDirectory() as d:
        p=Path(d)/"fixture.db"
        with sqlite3.connect(p) as c:
            c.execute("""
              CREATE TABLE paper_trades (
                id INTEGER PRIMARY KEY,token_currency TEXT,token_issuer TEXT,
                raw_currency TEXT,status TEXT,entry_timestamp INTEGER,
                exit_timestamp INTEGER,entry_reason TEXT,trade_source TEXT,
                pnl_xrp REAL
              )
            """)
            c.executemany("INSERT INTO paper_trades VALUES(?,?,?,?,?,?,?,?,?,?)",[
                (73,"PHNIX",ISSUER,RAW,"open",1800000000000,None,"[BURST]","burst",None),
                (74,RAW,ISSUER,RAW,"closed",1800000001000,1800000600000,"[BURST]","burst",-0.2),
                (75,"HBAR","rOtherIssuer","4842415200000000000000000000000000000000",
                 "closed",1800000002000,1800000600000,"[BURST]","burst",-0.1)
            ])
        before=p.read_bytes()
        out=io.StringIO()
        with redirect_stdout(out):report(p,73)
        text=out.getvalue()
        assert "SAME ISSUE OVERLAP #73" in text,text
        assert "#74" in text and RAW in text,text
        assert "HBAR" in text,text
        assert "Trades in selected cohort: 3" in text,text
        assert p.read_bytes()==before,"audit should never mutate offline SQLite"
        print("PASS read-only exact-issuer alias overlap and suspicious-asset forensic")
if __name__=="__main__":main()
