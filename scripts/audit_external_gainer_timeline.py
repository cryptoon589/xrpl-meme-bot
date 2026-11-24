#!/usr/bin/env python3
"""Read-only, issuer-exact external gainer vs HUNTERIX discovery timeline.

Prospective snapshots only: a 24-hour gainer rank at observed_at does NOT
show the price before the move. The categories mean what the BOT observed
by that timestamp, not a historical missed executable trade or counterfactual
profit. No provider requests; uses the same existing opportunity-event DB.
"""
import argparse
from collections import Counter
from datetime import datetime,timezone
from pathlib import Path
import re,sqlite3,sys
PCT=re.compile(r'24h change=([+-]?\d+(?:\.\d+)?)%')
def stamp(ms):
    return datetime.fromtimestamp(ms/1000,timezone.utc).strftime("%m-%d %H:%M UTC")
def report(path,limit=30):
    if not path.is_file() or path.is_symlink(): raise ValueError("Expected regular PAPER DB")
    db=sqlite3.connect(path.resolve().as_uri()+"?mode=ro",uri=True,timeout=8)
    db.row_factory=sqlite3.Row
    db.execute("PRAGMA query_only=ON")
    db.execute("BEGIN")
    try:
        tables={r["name"] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if "paper_opportunity_events" not in tables:
            raise ValueError("Opportunity event evidence missing")
        latest=db.execute("""
            SELECT MAX(observed_at) latest
            FROM paper_opportunity_events
            WHERE event_type='external_gainer_seen'
        """).fetchone()["latest"]
        print("=== HUNTERIX / XRPL.TO MEME GAINER TIMELINE (READ ONLY) ===")
        print("Data by xrpl.to https://xrpl.to | prospective snapshot, not trade advice")
        if latest is None:
            print("No gainer observations yet. The observation-only collector"
                  " attempts a refresh about two minutes after startup and hourly"
                  " thereafter, subject to shared API limits.")
            return
        # Select ALL of the most recent provider batch before LIMIT. A simple
        # ORDER BY observed_at DESC LIMIT N selects arbitrary tokens on ties,
        # NOT the strongest N gainers from that snapshot.
        batch=[dict(r) for r in db.execute("""
            SELECT token_currency,token_issuer,raw_currency,observed_at,
                   detail,price_xrp
            FROM paper_opportunity_events
            WHERE event_type='external_gainer_seen' AND observed_at=?
        """,(latest,))]
        ranked=[]
        seen=set()
        for g in batch:
            key=(g["raw_currency"],g["token_issuer"])
            if key in seen:continue
            seen.add(key)
            m=PCT.search(g["detail"] or "")
            if not m:continue
            try:gain=float(m.group(1))
            except ValueError:continue
            if not (-1e9<gain<1e9):continue
            g["change24h"]=gain
            ranked.append(g)
        ranked.sort(key=lambda g:(-g["change24h"],g["raw_currency"],g["token_issuer"]))
        gainers=ranked[:limit]
        print("Latest provider snapshot:",stamp(latest))
        print("Exact-issue observations in latest snapshot:",len(batch))
        print("Rankable distinct issues:",len(ranked))
        print("Displayed top by observed 24h % gain:",len(gainers))
        print("This ranking is retrospective and does not establish tradable missed entries.")
        results=Counter()
        for g in gainers:
            code=g["raw_currency"]
            issuer=g["token_issuer"]
            ts=g["observed_at"]
            rows=list(db.execute("""
                SELECT event_type,MIN(observed_at) first_at,COUNT(*) n
                FROM paper_opportunity_events
                WHERE raw_currency=? AND token_issuer=?
                  AND observed_at<=?
                  AND event_type IN ('first_detected','burst_seen','burst_qualified',
                        'stream_quoted','stream_qualified','momentum_seen',
                        'paper_entry','paper_exit')
                GROUP BY event_type
            """,(code,issuer,ts)))
            events={r["event_type"]:dict(r) for r in rows}
            kinds=[k for k in ('burst_seen','burst_qualified','stream_quoted',
                               'stream_qualified','momentum_seen') if k in events]
            traded='paper_entry' in events
            status='TRADED_BEFORE_RANK' if traded else (
                'SIGNAL_BEFORE_RANK_NO_ENTRY' if kinds else 'NO_PRIOR_SIGNAL_RECORDED')
            results[status]+=1
            change=g["change24h"]
            print(f"{stamp(ts)}  {g['token_currency'][:18]:18} "
                  f"24h={change:+.2f}% "
                  f"{status}  signals={','.join(kinds) or '-'} "
                  f"issue={code}:{issuer}")
        print("\nStatus counts:",dict(results))
        print("Limitations: only the latest snapshot is compared. A rising"
              " 24-hour price observed NOW is not an earlier entry opportunity;"
              " a missing signal is not a failed scan without activity, liquidity"
              " and signal-decision records at the relevant earlier time."
              " Sellable returns require issuer-exact contemporaneous AMM quotes.")
    finally:db.close()
def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--db",required=True,type=Path)
    p.add_argument("--limit",type=int,default=30)
    a=p.parse_args()
    if not 1<=a.limit<=100:
        print("limit must be 1..100",file=sys.stderr);return 2
    try:report(a.db,a.limit);return 0
    except (sqlite3.Error,OSError,ValueError) as e:
        print("GAINER TIMELINE BLOCKED:",e,file=sys.stderr);return 2
if __name__=="__main__":raise SystemExit(main())
