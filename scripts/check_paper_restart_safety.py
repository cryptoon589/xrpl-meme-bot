#!/usr/bin/env python3
"""Read-only cutover gate: NEVER restart PAPER inventory without verified exit state.

Older versions persist PAPER cash and tokens but not the highest observed
price since entry, live trailing profile or learned exits. A restart while
those positions are open silently changes the exit algorithm. Before a
release swap, demand either a FLAT PAPER portfolio or a valid checkpoint
for EVERY active trade, uniquely bound to trade ID and entry timestamp.

This audit never freezes, stops, restarts, trades, or changes SQLite.
"""
from __future__ import annotations
import argparse
import json
import math
import sqlite3
import sys
from contextlib import closing
from pathlib import Path

def num(x):
    return isinstance(x, (int,float)) and not isinstance(x,bool) and math.isfinite(x)

def validate(state, row):
    if not isinstance(state,dict): return False
    if state.get("version") != 1 or state.get("tradeId") != row["id"]: return False
    if state.get("entryTimestamp") != row["entry_timestamp"]: return False
    if not num(state.get("highestPriceSinceEntry")): return False
    if state["highestPriceSinceEntry"] < row["entry_price_xrp"]: return False
    if not num(state.get("openedAt")) or state["openedAt"] < row["entry_timestamp"]: return False
    if not num(state.get("lastBuySeenAt")): return False
    if not num(state.get("liquidityAtEntry")) or state["liquidityAtEntry"] < 0: return False
    if state.get("tradeProfile") not in ("burst","scored"): return False
    if state.get("profileName") not in (
        "BURST_SCALP","NEW_LAUNCH","LOW_LIQ_PROBE","MOMENTUM_RUNNER","WAKEUP_TRADE"
    ): return False
    prices=state.get("priceHistory")
    if not isinstance(prices,list) or not 1<=len(prices)<=10: return False
    if any(not num(p) or p <= 0 for p in prices): return False
    if any(k in state and (not num(state[k]) or not 0<=state[k]<=100)
           for k in ("stopLossPercent","tp1Pct","tp2Pct")): return False
    return True

def check(path):
    if not path.is_file():
        raise RuntimeError("PAPER epoch does not exist: "+str(path))
    uri=path.resolve().as_uri()+"?mode=ro"
    with closing(sqlite3.connect(uri,uri=True,timeout=5)) as db:
        db.row_factory=sqlite3.Row
        db.execute("PRAGMA query_only=ON")
        if db.execute("PRAGMA quick_check").fetchone()[0]!="ok":
            raise RuntimeError("PAPER DB integrity check failed")
        rows=db.execute("""
            SELECT id,token_currency,token_issuer,entry_timestamp,entry_price_xrp,
                   status,remaining_position
            FROM paper_trades
            WHERE status IN ('open','partial') ORDER BY id
        """).fetchall()
        print("=== PAPER RESTART HIGH-WATER SAFETY CHECK (READ ONLY) ===")
        print("Open/partial positions:",len(rows))
        if not rows:
            print("PASS: portfolio flat, no in-memory trailing state to lose")
            return True
        table=db.execute("""
            SELECT name FROM sqlite_master
            WHERE type='table' AND name='paper_position_runtime'
        """).fetchone()
        if not table:
            print("BLOCK: pre-upgrade bot has no verified runtime checkpoint table")
            for r in rows:
                print(" ",r["id"],r["token_currency"],r["status"],
                      "issuer="+r["token_issuer"])
            return False
        bad=[]
        for r in rows:
            record=db.execute(
                "SELECT state_json FROM paper_position_runtime WHERE trade_id=?",
                (r["id"],)).fetchone()
            try: state=json.loads(record[0]) if record else None
            except (TypeError,ValueError,KeyError):state=None
            if not validate(state,r):
                bad.append((r["id"],r["token_currency"]))
        if bad:
            print("BLOCK: missing, malformed or mismatched runtime snapshots:",bad)
            return False
        print("PASS: all open PAPER trade IDs have validated exact high-water checkpoints")
        return True

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--db",type=Path,required=True)
    args=p.parse_args()
    try:return 0 if check(args.db) else 2
    except (RuntimeError,sqlite3.Error) as ex:
        print("BLOCK:",ex,file=sys.stderr)
        return 2

if __name__=="__main__":
    raise SystemExit(main())
