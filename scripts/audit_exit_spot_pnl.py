#!/usr/bin/env python3
"""Read-only PAPER trade PnL-vs-spot reconciliation, exact XRPL issue.

A spot price is NOT a fill. Price increasing while booked PnL decreases
does NOT by itself prove a bug. For partial TP trades final exit_price is
NOT a complete representation of all exit legs. This audit never fabricates
inventory or historical AMM reserves, never changes PM2 or the SQLite DB.
"""
from __future__ import annotations
from contextlib import closing
from pathlib import Path
from datetime import datetime,timezone
import argparse, math, sqlite3, sys, re

ENTRY_FEE=0.003
PRICE_DIFF_THRESHOLD=0.015

def as_utc(t):
    return datetime.fromtimestamp(t/1000,timezone.utc).strftime("%m-%d %H:%M:%S UTC") if t else "-"

def label_from_raw(raw):
    if raw and re.fullmatch(r"[a-fA-F0-9]{40}",raw):
        try:
            b=bytes.fromhex(raw).split(b"\0",1)[0].decode("ascii")
            if b and all(32<=ord(c)<=126 for c in b):
                return b
        except (ValueError,UnicodeError):pass
    return raw

def read_trades(db,from_id):
    fields={r["name"] for r in db.execute("PRAGMA table_info(paper_trades)")}
    required={"id","token_currency","token_issuer","raw_currency","entry_price_xrp",
        "exit_price_xrp","entry_amount_xrp","entry_timestamp","exit_timestamp",
        "xrp_returned","slippage_estimate","fees_paid","tp1_hit","tp2_hit",
        "exit_reason","pnl_xrp","status"}
    if not required<=fields:
        raise ValueError("Required paper_trades fields absent: "+str(sorted(required-fields)))
    return [dict(r) for r in db.execute("""
      SELECT id,token_currency,token_issuer,raw_currency,entry_price_xrp,
             exit_price_xrp,entry_amount_xrp,entry_timestamp,exit_timestamp,
             xrp_returned,slippage_estimate,fees_paid,tp1_hit,tp2_hit,
             exit_reason,pnl_xrp,status
      FROM paper_trades
      WHERE id>? AND status='closed'
      ORDER BY id
    """,(from_id,))]

def analysis(trade):
    spend=trade["entry_amount_xrp"]
    entry=trade["entry_price_xrp"]
    exit=trade["exit_price_xrp"]
    returned=trade["xrp_returned"]
    pnl=trade["pnl_xrp"]
    if not all(isinstance(v,(int,float)) and math.isfinite(v) for v in [spend,entry,exit,returned,pnl]):
        return {"status":"MISSING_PRICE_OR_PAYOUT"}
    if spend<=0 or entry<=0 or exit<=0 or returned<0:
        return {"status":"INVALID_PRICE_OR_PAYOUT"}
    price_pct=(exit/entry-1)*100
    actual_pct=(returned/(spend*(1+ENTRY_FEE))-1)*100
    implied=returned-spend*(1+ENTRY_FEE)
    error=(pnl-implied)
    tp=bool(trade["tp1_hit"] or trade["tp2_hit"])
    mismatch=(price_pct>0 and actual_pct<0)
    return {"status":"OK" if abs(error)<=0.0001 else "PNL_RECONCILIATION_MISMATCH",
       "spot_pct":price_pct,"economic_pct":actual_pct,
       "cash_pnl":implied,"mismatch":mismatch,"partial":tp,
       "reconciliation_error":error,
       "divergence_pp":price_pct-actual_pct}

def summary(trades,ids=None,top=30):
    analyzed=[(t,analysis(t)) for t in trades]
    errors=[(t,a) for t,a in analyzed if a["status"]=="PNL_RECONCILIATION_MISMATCH"]
    raw_mismatches=[(t,a) for t,a in analyzed if a.get("mismatch") and not a.get("partial")]
    raw_mismatches.sort(key=lambda x:x[1]["divergence_pp"],reverse=True)
    byid={t["id"]:(t,a) for t,a in analyzed}
    selected=[]
    seen=set()
    for id in ids or []:
        if id in byid and id not in seen:
            selected.append(byid[id]);seen.add(id)
    for t,a in raw_mismatches[:top]:
        if t["id"] not in seen:
            selected.append((t,a));seen.add(t["id"])
    return analyzed,errors,raw_mismatches,selected

def report(path,from_id=72,trade_ids=None,limit=15):
    if not path.is_file() or path.is_symlink():
        raise ValueError("Expected existing regular PAPER epoch SQLite DB")
    with closing(sqlite3.connect(path.resolve().as_uri()+"?mode=ro",uri=True,timeout=10)) as db:
        db.row_factory=sqlite3.Row
        db.execute("PRAGMA query_only=ON")
        db.execute("BEGIN")
        trades=read_trades(db,from_id)
        analyzed,errors,mismatches,selected=summary(trades,trade_ids,limit)
        print("=== HUNTERIX PAPER EXIT P&L vs SPOT AUDIT (READ ONLY) ===")
        print("Closed trades id >",from_id,":",len(trades))
        print("Booked P&L reconciliation anomalies:",len(errors))
        print("SPOT-UP / CASH-LOSS without TP1/TP2:",len(mismatches))
        print("CAVEAT: EXIT SPOT != EXECUTABLE SELL QUOTE; SIMULATED CASH RETURNED is definitive for ledger accounting only.")
        print("Partial TP trades excluded from automated spot-up/cash-loss tally because final spot omits earlier exits.")
        if errors:print("CRITICAL: simulation P&L and recorded proceeds do NOT reconcile; keep entry freeze.")
        if not selected:print("No selected trades with complete fields.")
        for t,a in selected:
            ident=(t["raw_currency"] or t["token_currency"])+":"+t["token_issuer"]
            print("\n#"+str(t["id"]),label_from_raw(t["raw_currency"]) or t["token_currency"],
                t["exit_reason"] or "unknown",
                "accounting="+a["status"],"TP1/TP2="+str(a.get("partial","?")))
            print(" issue:",ident)
            print(" timing:",as_utc(t["entry_timestamp"]),"->",as_utc(t["exit_timestamp"]))
            print(" entry_spot:",t["entry_price_xrp"],"exit_spot:",t["exit_price_xrp"])
            if "spot_pct" in a:
                print(" recorded_spot_change_pct:",round(a["spot_pct"],3),
                      "final_cash_return_pct:",round(a["economic_pct"],3),
                      "divergence_pp:",round(a["divergence_pp"],3))
                print(" nominal_size_xrp:",t["entry_amount_xrp"],
                      "net_cash_returned_xrp:",t["xrp_returned"],
                      "booked_pnl_xrp:",t["pnl_xrp"],
                      "reconciliation_error_xrp:",round(a["reconciliation_error"],7))
                print(" entry_slippage_estimate:",t["slippage_estimate"],
                      "fees_paid_recorded:",t["fees_paid"])
            else:print(" missing price/cash data: no divergence conclusion")
        print("\nCAUTION: spot change and economic return can diverge through entry impact,")
        print("  reserve-aware simulated exit price impact, fees, asynchronous snapshot")
        print("  timing and partial exits. The historical trades do NOT persist complete")
        print("  timestamped AMM reserves for both legs: no reliable retroactive")
        print("  breakdown or actual executable quote is inferred.")
        print("No trading, database mutations, provider requests or PM2 actions.")

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--db",type=Path,required=True)
    p.add_argument("--from-id",type=int,default=72)
    p.add_argument("--trade-ids",default="105,133,134,140",
                   help="comma-separated exact PAPER trade IDs to show")
    p.add_argument("--limit",type=int,default=15)
    a=p.parse_args()
    if not (0<=a.from_id<10000000 and 1<=a.limit<=100):
        p.error("Invalid from-id or limit")
    try:ids=[int(x) for x in a.trade_ids.split(",") if x.strip()]
    except ValueError:p.error("Invalid trade IDs")
    if any(i<=0 for i in ids):p.error("Trade IDs must be positive")
    try:report(a.db,a.from_id,ids,a.limit);return 0
    except (sqlite3.Error,OSError,ValueError,OverflowError) as e:
        print("EXIT PNL DIAGNOSTIC BLOCKED:",e,file=sys.stderr);return 2
if __name__=="__main__":raise SystemExit(main())
