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
        gainers=[dict(r) for r in db.execute("""
          SELECT token_currency,token_issuer,raw_currency,observed_at,
                 detail,price_xrp
          FROM paper_opportunity_events
          WHERE event_type='external_gainer_seen'
          ORDER BY observed_at DESC
          LIMIT ?
        """,(limit,))]
        print("=== HUNTERIX / XRPL.TO MEME GAINER TIMELINE (READ ONLY) ===")
        print("Data by xrpl.to https://xrpl.to | prospective snapshot, not trade advice")
        print("Ranked gainer observations:",len(gainers))
        if not gainers:
            print("No gainer observations yet. The rotating metadata poll visits"
                  " gainers once per four successful 15-minute requests.")
            return
        print("One token may appear at multiple later observations.")
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
            m=PCT.search(g["detail"] or "")
            change=float(m.group(1)) if m else None
            print(f"{stamp(ts)}  {g['token_currency'][:18]:18} "
                  f"24h={change if change is not None else 'n/a'}% "
                  f"{status}  signals={','.join(kinds) or '-'} "
                  f"issue={code}:{issuer}")
        print("\nStatus counts:",dict(results))
        print("Limitations: no historical 24h gainer list is backfilled; no signal "
              "does not prove missed tradable momentum; future prices require "
              "issuer-exact timestamped AMM reserve quotes.")
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
