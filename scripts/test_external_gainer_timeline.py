#!/usr/bin/env python3
"""Offline gainer-vs-bot signal timeline: exact-issuer and read-only."""
import io,sqlite3,tempfile
from pathlib import Path
from contextlib import redirect_stdout
from audit_external_gainer_timeline import report
T=1800000000000
RAW="50484E4958000000000000000000000000000000"
A="rDFXbW2ZZCG5WgPtqwNiA2xZokLMm9ivmN"
B="rOtherFakeIssuer"
def main():
  with tempfile.TemporaryDirectory() as d:
    p=Path(d)/"paper.db"
    with sqlite3.connect(p) as db:
      db.execute("""CREATE TABLE paper_opportunity_events (
        token_currency TEXT,token_issuer TEXT,raw_currency TEXT,
        observed_at INTEGER,event_type TEXT,detail TEXT,price_xrp REAL
      )""")
      db.executemany("INSERT INTO paper_opportunity_events VALUES(?,?,?,?,?,?,?)",[
       ("PHNIX",A,RAW,T-5000,"burst_seen",None,0.00001),
       ("PHNIX",A,RAW,T-4000,"paper_entry",None,0.00001),
       ("PHNIX",A,RAW,T,"external_gainer_seen","24h change=42.00% vol24h=100 XRP",0.000012),
       ("PHNIX",B,RAW,T,"external_gainer_seen","24h change=45.00% vol24h=100 XRP",0.00002),
       ("NEW",A,"4E45570000000000000000000000000000000000",T,
          "external_gainer_seen","24h change=72.00% vol24h=60 XRP",0.5),
      ])
    before=p.read_bytes()
    out=io.StringIO()
    with redirect_stdout(out):report(p,30)
    text=out.getvalue()
    assert "TRADED_BEFORE_RANK" in text,text
    assert text.count("NO_PRIOR_SIGNAL_RECORDED")==3,text
    assert "Ranked gainer observations: 3" in text,text
    assert p.read_bytes()==before,"Read-only audit mutated SQLite"
    print("PASS prospective exact-issuer gainer ranks vs historical bot signals (no lookahead, no write)")
if __name__=="__main__":main()
