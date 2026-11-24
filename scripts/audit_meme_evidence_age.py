#!/usr/bin/env python3
"""Read-only issuer-exact category-evidence recency versus rejected PAPER entries.

Classification events are new prospective observations: historical rejected
trades may lack the corresponding event despite having been valid at the time.
A stale classification alone does NOT prove a denied token should have traded.
No API calls, no approvals or allowlist changes.
"""
import argparse
from collections import Counter
from contextlib import closing
from datetime import datetime,timezone
from pathlib import Path
import sqlite3,sys
TTL_MS=45*60*1000
def stamp(ts):
    return datetime.fromtimestamp(ts/1000,timezone.utc).strftime("%m-%d %H:%M UTC") if ts else "-"
def report(dbfile,limit=70,hours=72):
    if not dbfile.is_file() or dbfile.is_symlink():raise ValueError("Expected regular PAPER DB file")
    with closing(sqlite3.connect(dbfile.resolve().as_uri()+"?mode=ro",
                                 uri=True,timeout=15)) as db:
        db.row_factory=sqlite3.Row
        db.execute("PRAGMA query_only=ON")
        db.execute("BEGIN")
        since=int(datetime.now(timezone.utc).timestamp()*1000)-hours*3600000
        rows=db.execute("""
            SELECT currency,issuer,raw_currency,skipped_at,reject_reason
            FROM shadow_trades
            WHERE skipped_at>=? AND raw_currency IS NOT NULL
              AND reject_reason LIKE '%Unknown/unreviewed token%'
            ORDER BY skipped_at DESC LIMIT ?
        """,(since,limit)).fetchall()
        print("=== HUNTERIX FRESH MEME-EVIDENCE AUDIT (READ ONLY) ===")
        print("Historical classification events from before this patch may be absent.")
        print("Checked exact-issue unknown/unreviewed rejection rows:",len(rows))
        statuses=Counter()
        for r in rows:
            found=db.execute("""
                SELECT observed_at
                FROM paper_opportunity_events
                WHERE raw_currency=? AND token_issuer=?
                  AND observed_at<=?
                  AND event_type='meme_evidence_refreshed'
                ORDER BY observed_at DESC LIMIT 1
            """,(r["raw_currency"],r["issuer"],r["skipped_at"])).fetchone()
            if not found:
                status="NO_PREVIOUS_CLASSIFICATION_OBSERVATION"
                age=None
            else:
                age=(r["skipped_at"]-found["observed_at"])/60000
                status=("REJECTED_WHILE_TAG_FRESH" if age<=45
                        else "EXPIRED_OR_REVOKED_NOT_PROVEN")
            statuses[status]+=1
            print(stamp(r["skipped_at"]),r["currency"],
                  r["raw_currency"]+":"+r["issuer"],
                  status,"tag_age_minutes="+
                  (str(round(age,1)) if age is not None else "n/a"))
        print("COUNTS:",dict(statuses))
        print("Interpretation: A tagged issue may be revoked by later negative"
              " tags or excluded by hard issuer/name checks. Do not automatically"
              " extend TTL, bypass approved-checksum controls or permit a trade.")
        print("No database writes, external provider calls or entry-state changes.")
def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--db",type=Path,required=True)
    p.add_argument("--limit",type=int,default=70)
    p.add_argument("--hours",type=int,default=72)
    a=p.parse_args()
    if not 1<=a.limit<=250 or not 1<=a.hours<=168:p.error("Out of range")
    try:report(a.db,a.limit,a.hours);return 0
    except (sqlite3.Error,OSError,ValueError) as e:
        print("MEME FRESHNESS AUDIT BLOCKED:",e,file=sys.stderr);return 2
if __name__=="__main__":raise SystemExit(main())
