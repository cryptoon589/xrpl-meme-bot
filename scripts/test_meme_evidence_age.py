#!/usr/bin/env python3
"""Offline classification evidence age regression; never opens production DB."""
from contextlib import redirect_stdout
from pathlib import Path
from datetime import datetime,timezone
from audit_meme_evidence_age import report
import io,sqlite3,tempfile
RAW="434F4C4400000000000000000000000000000000"
A="rMockEvidenceIssuer"
B="rOtherIssuer"
def main():
    t=int(datetime.now(timezone.utc).timestamp()*1000)-30000
    with tempfile.TemporaryDirectory() as td:
        p=Path(td)/"paper.db"
        with sqlite3.connect(p) as c:
            c.executescript("""
            CREATE TABLE shadow_trades(
              currency TEXT,issuer TEXT,raw_currency TEXT,
              skipped_at INTEGER,reject_reason TEXT
            );
            CREATE TABLE paper_opportunity_events(
              raw_currency TEXT,token_issuer TEXT,observed_at INTEGER,
              event_type TEXT
            );
            """)
            c.executemany("INSERT INTO paper_opportunity_events VALUES(?,?,?,?)",[
              (RAW,A,t-30*60000,"meme_evidence_refreshed"),
              (RAW,B,t-60*60000,"meme_evidence_refreshed")
            ])
            c.executemany("INSERT INTO shadow_trades VALUES(?,?,?,?,?)",[
              ("COLD",A,RAW,t,"Meme-only universe: Unknown/unreviewed token: not approved as XRPL meme coin"),
              ("COLD",B,RAW,t,"Meme-only universe: Unknown/unreviewed token: not approved as XRPL meme coin"),
              ("COLD","rThirdIssuer",RAW,t,"Meme-only universe: Unknown/unreviewed token: not approved as XRPL meme coin")
            ])
        before=p.read_bytes()
        out=io.StringIO()
        with redirect_stdout(out):report(p,20,72)
        s=out.getvalue()
        assert "REJECTED_WHILE_TAG_FRESH" in s,s
        assert "EXPIRED_OR_REVOKED_NOT_PROVEN" in s,s
        assert "NO_PREVIOUS_CLASSIFICATION_OBSERVATION" in s,s
        assert p.read_bytes()==before,"read-only report changed SQLite"
        print("PASS exact-issuer evidence age, expiry uncertainty and no-write report")
if __name__=="__main__":main()
