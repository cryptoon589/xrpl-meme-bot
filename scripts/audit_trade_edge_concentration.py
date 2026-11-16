#!/usr/bin/env python3
"""Concentration and regime audit. READ ONLY. No database changes or trades.

Run: python3 scripts/audit_trade_edge_concentration.py
The 'economic_pnl' formula is an estimate, NOT a real XRPL fill outcome.
Historic fees/fill modeling and ghost reversals are not validated.
"""
from collections import defaultdict, Counter
from datetime import datetime, timezone
from pathlib import Path
import re
import sqlite3
import statistics

ROOT = Path(__file__).resolve().parents[1]
DB = ROOT / "data" / "meme_bot.recovery.db"

def n(value):
    try: return float(value or 0)
    except (TypeError, ValueError): return 0.

def source(r):
    if r["trade_source"]: return r["trade_source"]
    reason = r["entry_reason"] or ""
    if reason.startswith("[BURST]"): return "burst"
    if reason.startswith("[STREAM]"): return "stream"
    if reason.startswith("[MOMENTUM]"): return "momentum"
    if reason.startswith("[SCORED]"): return "scored"
    return "scored_or_unknown"

def pretty(rows):
    if not rows: return "n=0"
    profits = sum(max(r["estimated_net"], 0) for r in rows)
    losses = -sum(min(r["estimated_net"], 0) for r in rows)
    p = sorted(r["estimated_net"] for r in rows)
    return "n=%3d net=%+9.3f XRP med=%+7.3f win=%.1f%% PF=%s" % (
        len(rows), sum(p), statistics.median(p),
        100*sum(x > 0 for x in p)/len(p), "%.2f" % (profits/losses) if losses else "unbounded"
    )

def when(ts):
    try: return datetime.fromtimestamp(n(ts)/1000, timezone.utc).strftime("%Y-%m-%d")
    except (OSError, ValueError, OverflowError): return "?"

def time_minutes(r):
    end = n(r["exit_timestamp"])
    start = n(r["entry_timestamp"])
    return (end-start)/60000 if end and start and end>=start else 0

def group(rows, f, title):
    d = defaultdict(list)
    for r in rows: d[str(f(r))].append(r)
    print("\n"+title)
    for k, arr in sorted(d.items(), key=lambda a:-len(a[1])):
        print("  %-28s %s" % (k[:28], pretty(arr)))

def main():
    if not DB.is_file(): raise SystemExit("Compact DB not found; no changes made")
    con = sqlite3.connect(DB.resolve().as_uri()+"?mode=ro",uri=True,timeout=8)
    con.row_factory=sqlite3.Row
    try:
        assert con.execute("PRAGMA quick_check").fetchone()[0]=="ok"
        closed = [dict(r) for r in con.execute(
            """SELECT * FROM paper_trades WHERE status='closed'
               ORDER BY exit_timestamp, id""")]
        ghosts = [r for r in closed if r.get("exit_reason")=="force_close_no_price"]
        sample=[]
        for r in closed:
            if r.get("exit_reason")=="force_close_no_price": continue
            entry=n(r.get("entry_amount_xrp"))
            returned=n(r.get("xrp_returned"))
            if entry<=0 or returned<=0: continue
            r["estimated_net"]=returned-entry-entry*0.003
            r["source_group"]=source(r)
            r["held_minutes"]=time_minutes(r)
            r["profile_group"]=r.get("trade_profile") or "unknown"
            sample.append(r)
        print("HUNTERIX EDGE / LOSS CONCENTRATION -- READ-ONLY")
        print("Historical PAPER economic estimates; not executable XRPL P&L")
        print("Closed=%d ghost=%d valid_non_ghost=%d" % (len(closed),len(ghosts),len(sample)))
        print("Total:",pretty(sample))
        print("Ghost trade entry notional: %.3f XRP; recorded proceeds: %.3f XRP" % (
            sum(n(r["entry_amount_xrp"]) for r in ghosts),
            sum(n(r["xrp_returned"]) for r in ghosts)))
        print("NOTE: ghost entries are intentionally EXCLUDED from profitability; their debits/reversals prevent exact cash reconstruction.")
        group(sample,lambda r:r["source_group"], "BY SOURCE")
        group(sample,lambda r:r["profile_group"],"BY RECORDED PROFILE")
        group(sample,lambda r:when(r["entry_timestamp"])[:7],"BY ENTRY MONTH (regime)")
        group(sample,lambda r:when(r["exit_timestamp"])[:7],"BY EXIT MONTH (regime)")
        group(sample,lambda r:r.get("exit_reason") or "unknown","BY EXIT REASON")
        group(sample,lambda r: "loss <= -50%" if r["estimated_net"]<=-.5*n(r["entry_amount_xrp"]) else (
            "loss -10% to -50%" if r["estimated_net"]<=-.1*n(r["entry_amount_xrp"]) else (
                "loss <10%" if r["estimated_net"]<0 else (
                    "profit <10%" if r["estimated_net"]<.1*n(r["entry_amount_xrp"]) else (
                        "profit 10%-50%" if r["estimated_net"]<.5*n(r["entry_amount_xrp"]) else "profit >50%")))),
            "POSITION-RELATIVE OUTCOME BANDS")
        for lbl,arr in [("ALL",sample),("BURST",[r for r in sample if r["source_group"]=="burst"])]:
            top = sorted(arr,key=lambda r:r["estimated_net"],reverse=True)
            base=sum(r["estimated_net"] for r in arr)
            print("\nWINNER CONCENTRATION "+lbl+" baseline=%+.3f XRP"%base)
            for k in [1,3,5,10,20]:
                if k<len(top):
                    print("  remove top %-2d winners => %+9.3f XRP" %
                         (k,base-sum(r["estimated_net"] for r in top[:k])))
            for k in [1,3,5]:
                worst=sorted(arr,key=lambda r:r["estimated_net"])[:k]
                print("  remove worst %-2d losses => %+9.3f XRP" %
                      (k,base-sum(r["estimated_net"] for r in worst)))
        liq=[r for r in sample if r["exit_reason"]=="kill_liq_drop"]
        print("\nLIQUIDITY COLLAPSE FORENSICS")
        print("  "+pretty(liq))
        group(liq,lambda r:r["source_group"],"  BY ENTRY SOURCE")
        group(liq,lambda r:r["profile_group"],"  BY PROFILE")
        if liq:
            lengths=sorted(r["held_minutes"] for r in liq)
            print("  held duration median=%.1f min, p90=%.1f min"%
                  (statistics.median(lengths),lengths[min(len(lengths)-1,int(.9*len(lengths)))]))
        for label,data in [("worst",sorted(sample,key=lambda r:r["estimated_net"])[:12]),
                           ("best",sorted(sample,key=lambda r:-r["estimated_net"])[:12])]:
            print("\nTOP 12 "+label.upper()+" TRADES")
            for r in data:
                name=str(r.get("token_currency") or "?").replace("\n"," ")[:18]
                reason=str(r.get("exit_reason") or "")[:20]
                print(" id=%-5s %-18s %-12s %-21s %+.3f XRP entry=%.2f %s held=%.1fm"%
                      (r.get("id"),name,r["source_group"][:12],reason,r["estimated_net"],
                       n(r["entry_amount_xrp"]),when(r["entry_timestamp"]),r["held_minutes"]))
        # Entry-reason-reported pool is not a historical validated reserve; show coverage.
        amounts=[]
        for r in liq:
            m=re.search(r"pool\s*:\s*(\d+(?:\.\d+)?)\s*XRP",r.get("entry_reason") or "",re.I)
            if m: amounts.append(float(m.group(1)))
        print("\nENTRY POOL FIELD COVERAGE FOR LIQUIDITY EXITS:",len(amounts),"/",len(liq))
        if amounts:
            print("  entry-reason reported pool median=%.0f XRP (NOT validated on-ledger)"%statistics.median(amounts))
        print("\nREAD-ONLY EDGE AUDIT COMPLETE. No DB writes.")
    finally: con.close()

if __name__=="__main__":
    main()
