#!/usr/bin/env python3
"""Read-only investigation of PAPER liquidity collapse and no-followthrough.

Reports exact trade issue, fee-adjusted booked PnL and nearby saved market
liquidity/price samples. Saved liquidity is *not* an executable exit reserve:
this tool never changes trades, never makes hypothetical fills, never calls RPC.
"""
import argparse
from contextlib import closing
from datetime import datetime,timezone
from pathlib import Path
import sqlite3,sys,re

def stamp(ms):
    return datetime.fromtimestamp(ms/1000,timezone.utc).strftime("%m-%d %H:%M UTC") if ms else "-"

def aliases(raw,display):
    ans={display,raw}
    if raw and re.fullmatch(r"[0-9a-fA-F]{40}",raw):
        try:
            b=bytes.fromhex(raw).split(b"\x00",1)[0].decode("ascii")
            if b:ans.add(b)
        except (ValueError,UnicodeError): pass
    return sorted(x for x in ans if x)

def report(file:Path,after_id=72,limit=30):
    if not file.is_file() or file.is_symlink():
        raise ValueError("Expected existing regular SQLite PAPER epoch database")
    with closing(sqlite3.connect(file.resolve().as_uri()+"?mode=ro",
                                 uri=True,timeout=10)) as db:
        db.row_factory=sqlite3.Row
        db.execute("PRAGMA query_only=ON")
        db.execute("BEGIN")
        cols={r["name"] for r in db.execute("PRAGMA table_info(paper_trades)")}
        required={"id","token_currency","token_issuer","raw_currency",
                  "entry_timestamp","exit_timestamp","entry_price_xrp",
                  "exit_price_xrp","entry_amount_xrp","exit_reason","pnl_xrp","status"}
        if not required<=cols:raise ValueError("Missing PAPER fields: "+str(required-cols))
        reasons=["kill_liq_drop","stop_loss","kill_no_followthrough"]
        rows=db.execute("""
            SELECT id,token_currency,token_issuer,raw_currency,
                   entry_timestamp,exit_timestamp,entry_price_xrp,exit_price_xrp,
                   entry_amount_xrp,exit_reason,pnl_xrp,status
            FROM paper_trades
            WHERE id>? AND status='closed'
              AND exit_reason IN ('kill_liq_drop','stop_loss','kill_no_followthrough')
            ORDER BY id DESC LIMIT ?
        """,(after_id,limit)).fetchall()
        total=db.execute("""
          SELECT exit_reason,COUNT(*) n,SUM(pnl_xrp) net
          FROM paper_trades
          WHERE id>? AND status='closed'
          GROUP BY exit_reason
          ORDER BY SUM(pnl_xrp) ASC
        """,(after_id,)).fetchall()
        print("=== HUNTERIX LIQUIDITY & NO-FOLLOWTHROUGH LOSS FORENSICS (READ ONLY) ===")
        print("Selected cohort: id >",after_id,"| recent risky exits shown:",len(rows))
        print("EXIT P&L CONTRIBUTION")
        for r in total:
            print(" ",r["exit_reason"] or "unknown",r["n"],
                  ("%.4f" % (r["net"] or 0))+" XRP")
        for t in rows:
            print("\n#"+str(t["id"]),t["token_currency"],t["exit_reason"],
                  "pnl_xrp=",t["pnl_xrp"],
                  "size_xrp=",t["entry_amount_xrp"],
                  "hold=",round((t["exit_timestamp"]-t["entry_timestamp"])/60000,2)
                    if t["exit_timestamp"] is not None else "unknown","min")
            print("  issue:",(t["raw_currency"] or t["token_currency"])+":"+t["token_issuer"])
            print("  entry",stamp(t["entry_timestamp"]),"exit",stamp(t["exit_timestamp"]))
            a=aliases(t["raw_currency"],t["token_currency"])
            qs=",".join("?" for _ in a)
            # Measurements are close to trade timestamps, not guaranteed
            # trade-time reserves. Never compare across different issuers.
            def observed(start,end,descending=False):
                order="DESC" if descending else "ASC"
                return db.execute(f"""
                    SELECT timestamp,price_xrp,liquidity_xrp
                    FROM market_snapshots
                    WHERE token_issuer=? AND token_currency IN ({qs})
                      AND timestamp BETWEEN ? AND ?
                    ORDER BY timestamp {order} LIMIT 1
                """,(t["token_issuer"],*a,start,end)).fetchone()
            pre=observed(t["entry_timestamp"]-5*60000,t["entry_timestamp"],True)
            post=observed(t["exit_timestamp"]-5*60000,
                          t["exit_timestamp"]+5*60000,False) if t["exit_timestamp"] else None
            for name,p in [("entry-near",pre),("exit-near",post)]:
                print("  "+name+":",
                      (stamp(p["timestamp"])+" price="+str(p["price_xrp"])+
                       " total_liq_xrp="+str(p["liquidity_xrp"])) if p else "NO nearby snapshot")
            if pre and post and pre["liquidity_xrp"] and post["liquidity_xrp"]:
                x=100*(post["liquidity_xrp"]/pre["liquidity_xrp"]-1)
                print("  total_liquidity_change_near_trade:",round(x,2),"%",
                      "(NOT verified AMM XRP-side reserve change)")
        print("\nCAVEATS: nearest stored values are not execution-time reserves,"
              " route-specific fills or proof of a rug. Preserve raw issuer"
              " and exit timestamps for future reserve-evidence matching.")
        print("No DB mutation, trading, freeze or PM2 changes.")

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--db",required=True,type=Path)
    p.add_argument("--after-id",type=int,default=72)
    p.add_argument("--limit",type=int,default=30)
    a=p.parse_args()
    if not 0<=a.after_id<=10000000 or not 1<=a.limit<=100:
        p.error("Invalid after-id or limit")
    try:report(a.db,a.after_id,a.limit);return 0
    except (sqlite3.Error,OSError,ValueError) as e:
        print("EXIT LOSS FORENSIC BLOCKED:",e,file=sys.stderr);return 2
if __name__=="__main__":raise SystemExit(main())
