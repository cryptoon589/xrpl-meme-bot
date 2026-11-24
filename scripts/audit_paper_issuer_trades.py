#!/usr/bin/env python3
"""Issuer-exact PAPER forensic report; read-only, no network, no PM2 changes.

Shows whether PHNIX labels were aliases of ONE ledger issue, whether overlapping
positions existed, and which HBAR/NVIDIA identities actually traded. Includes
observed opportunity breadcrumbs; never calls a ticker match a proved issue.
"""
import argparse
from collections import Counter,defaultdict
from datetime import datetime,timezone
from pathlib import Path
import sqlite3,sys

WATCH = {"PHNIX","DROP","DRO","BCHAMP","BCHAM","BCHA","HBAR","NVIDIA"}

def label(value):
    if value is None: return ""
    s=str(value)
    if len(s)==40:
        try:
            d=bytes.fromhex(s)
            d=d[:d.index(0)] if 0 in d else d
            x=d.decode('ascii')
            if x and all(33<=ord(c)<=126 for c in x):return x
        except (ValueError,UnicodeError):pass
    return s

def issue(row):
    raw=row.get("raw_currency")
    currency=row["token_currency"]
    value=raw or currency
    if value is None:return None
    if len(value)==40:
        try: int(value,16)
        except ValueError:return None
        code=value.upper()
    else:
        try: encoded=value.encode('ascii')
        except UnicodeError:return None
        if len(encoded)>20:return None
        if len(encoded)==3: code=value  # preserve standard 3-char code case
        else: code=encoded.hex().upper().ljust(40,'0')
    return (code,row["token_issuer"])

def stamp(ms):
    if ms is None: return "ongoing"
    return datetime.fromtimestamp(ms/1000,timezone.utc).strftime("%m-%d %H:%M UTC")

def report(path,from_id=73):
    if not path.is_file() or path.is_symlink():
        raise RuntimeError("Expected regular PAPER epoch SQLite DB")
    db=sqlite3.connect(path.resolve().as_uri()+"?mode=ro",uri=True,timeout=10)
    db.row_factory=sqlite3.Row
    db.execute("PRAGMA query_only=ON")
    db.execute("BEGIN")
    try:
        cols={r["name"] for r in db.execute("PRAGMA table_info(paper_trades)")}
        needed={"id","token_currency","token_issuer","status","entry_timestamp",
                "exit_timestamp","raw_currency","entry_reason","trade_source","pnl_xrp"}
        if not needed<=cols:raise RuntimeError("Missing fields: "+str(sorted(needed-cols)))
        all_trades=[dict(x) for x in db.execute("""
          SELECT id,token_currency,token_issuer,raw_currency,status,
                 entry_timestamp,exit_timestamp,entry_reason,trade_source,pnl_xrp
          FROM paper_trades ORDER BY id
        """)]
        trial=[t for t in all_trades if t["id"]>=from_id]
        print("=== HUNTERIX ISSUER-EXACT PAPER FORENSICS (READ ONLY) ===")
        print("DB:",path)
        print(f"Trades in selected cohort: {len(trial)} (id >= {from_id})")
        print("Open/partial: ",sum(t["status"] in ("open","partial") for t in all_trades))
        print("\n=== WATCHED OR RAW-HEX TRADES ===")
        watched=[]
        for t in trial:
            display=label(t["token_currency"])
            raw=label(t["raw_currency"])
            if (display.upper() in WATCH or raw.upper() in WATCH
                or len(t["token_currency"])==40):
                watched.append(t)
                print(f'#{t["id"]:>3} stored={t["token_currency"]!s:20.20} '
                      f'decoded={display:14.14} raw={t["raw_currency"] or "-"} '
                      f'issuer={t["token_issuer"]} status={t["status"]} '
                      f'source={t["trade_source"]} pnl={t["pnl_xrp"]}')
        if not watched:print("none")
        groups=defaultdict(list)
        for t in all_trades:
            identity=issue(t)
            if identity:groups[identity].append(t)
        print("\n=== OVERLAPPING TRADES ON SAME EXACT ISSUE ===")
        matches=0
        for (code,issuer), trades in groups.items():
            ordered=sorted(trades,key=lambda x:x["entry_timestamp"])
            for i,a in enumerate(ordered):
                end=a["exit_timestamp"] if a["status"]=="closed" and a["exit_timestamp"] else float("inf")
                for b in ordered[i+1:]:
                    if b["entry_timestamp"]>=end:break
                    # Flag cases where either trade is in this cohort.
                    if a["id"]<from_id and b["id"]<from_id:continue
                    matches+=1
                    print(f'SAME ISSUE OVERLAP #{a["id"]} ({a["token_currency"]}, {stamp(a["entry_timestamp"])}) '
                          f'with #{b["id"]} ({b["token_currency"]}, {stamp(b["entry_timestamp"])}) '
                          f'| raw={code} issuer={issuer}')
        if not matches:print("No proven same-issue overlaps in selected cohort.")
        print("\n=== PHNIX TRADE IDENTITIES ===")
        for (code,issuer), trades in groups.items():
            if label(code).upper()=="PHNIX" or any(label(t["token_currency"]).upper()=="PHNIX" for t in trades):
                print("Issue:",code,issuer)
                for t in trades:
                    print(f'  #{t["id"]} stored={t["token_currency"]} {t["status"]} '
                          f'entry={stamp(t["entry_timestamp"])} exit={stamp(t["exit_timestamp"])}')
        print("\n=== CURRENT COHORT EXIT LOSS CONTRIBUTION ===")
        by=defaultdict(list)
        for t in trial:
            if t["status"]=="closed" and t["pnl_xrp"] is not None:
                by[t["entry_reason"][:20] if False else t["trade_source"] or "unknown"].append(t)
        for src,arr in sorted(by.items()):
            print(src, "closed",len(arr),"net_xrp",round(sum(t["pnl_xrp"] for t in arr),4))
        print("\n=== POST-DEPLOYMENT OBSERVATION EVENTS ===")
        names={x["name"] for x in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if "paper_opportunity_events" in names:
            for r in db.execute("""
                SELECT event_type,COUNT(*) n
                FROM paper_opportunity_events
                WHERE observed_at>=1795378337505
                  AND event_type IN ('amm_pressure_compare','amm_xrp_inflow',
                                     'amm_xrp_outflow','burst_seen','stream_qualified',
                                     'paper_entry','momentum_seen')
                GROUP BY event_type ORDER BY event_type
            """):
                print(r["event_type"],r["n"])
        print("\nNo provider ticker, category tag or positive spot move proves correct issuer or tradable PnL.")
    finally:db.close()

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--db",type=Path,required=True)
    p.add_argument("--from-id",type=int,default=73)
    args=p.parse_args()
    try:report(args.db,args.from_id);return 0
    except (OSError,ValueError,sqlite3.Error,RuntimeError) as e:
        print("FORENSIC AUDIT BLOCKED:",e,file=sys.stderr);return 2
if __name__=="__main__":raise SystemExit(main())
