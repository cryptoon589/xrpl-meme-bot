#!/usr/bin/env python3
"""Read-only issuer-exact top-mover coverage and trade outcome audit.

Prospective gainer event ranking at ONE latest timestamp. Separate:
- tracked/no signal (eligible scanner not proved),
- prior price observations (not a guarantee of active sampling),
- prior entry signals, simulated entries and observed subsequent P&L,
- rejected signals with validated raw currency issue where available.

NO inference that a 24h gainer was tradable at an earlier price; no external
fetch, no SQLite writes, no config/PM2 changes.
"""
from __future__ import annotations
import argparse
from collections import Counter
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
import math
import re
import sqlite3
import sys

GAIN_RE = re.compile(r"24h change=([+-]?\d+(?:\.\d+)?)%")

def date(ms):
    if ms is None:return "-"
    return datetime.fromtimestamp(ms/1000,timezone.utc).strftime("%m-%d %H:%M UTC")

def decoded(raw):
    if not raw or not re.fullmatch(r"[0-9a-fA-F]{40}",raw):return raw
    try:
        b=bytes.fromhex(raw)
        word=b.split(b"\x00",1)[0].decode("ascii")
        return word if word and all(32<=ord(x)<=126 for x in word) else raw
    except (ValueError,UnicodeError):return raw

def aliases(raw,label):
    out={raw,label}
    if re.fullmatch(r"[0-9a-fA-F]{40}",raw):
        out.add(raw.upper())
        out.add(raw.lower())
        out.add(decoded(raw))
    return sorted(a for a in out if a)

def table_names(db):
    return {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}

def parse_gainer_rows(rows, limit):
    seen=set()
    result=[]
    for row in rows:
        d=dict(row)
        key=(d["raw_currency"],d["token_issuer"])
        if key in seen:continue
        seen.add(key)
        match=GAIN_RE.search(d["detail"] or "")
        if not match:continue
        x=float(match.group(1))
        if not math.isfinite(x):continue
        d["change24h"]=x
        result.append(d)
    result.sort(key=lambda d:(-d["change24h"],d["raw_currency"],d["token_issuer"]))
    return result[:limit]

def diagnose(db, latest, token, tables):
    raw, issuer=token["raw_currency"],token["token_issuer"]
    names=aliases(raw,token["token_currency"])
    placeholders=",".join("?" for _ in names)
    tracked=0; first_seen=None
    if "tokens" in tables:
        # Explicit raw code match or a plain/hex name plus same issuer.
        found=db.execute("""
            SELECT currency,raw_currency,first_seen,last_updated
            FROM tokens WHERE issuer=?
        """,(issuer,)).fetchall()
        matched=[r for r in found if r["raw_currency"]==raw
                 or (not r["raw_currency"] and r["currency"] in names)]
        tracked=len(matched)
        if matched:
            first_seen=min(r["first_seen"] for r in matched)
    all_events=list(db.execute("""
       SELECT event_type,MIN(observed_at) earliest,MAX(observed_at) latest,COUNT(*) n
       FROM paper_opportunity_events
       WHERE raw_currency=? AND token_issuer=?
         AND observed_at<=?
       GROUP BY event_type
    """,(raw,issuer,latest)))
    events={r["event_type"]:r for r in all_events}

    # Does persisted price collection indicate the bot previously monitored it?
    # Restrict to the immediately preceding 24h; never use later prices.
    previous=None
    if "market_snapshots" in tables:
        previous=db.execute(f"""
           SELECT COUNT(*) n,MIN(timestamp) earliest,MAX(timestamp) latest,
                  MAX(liquidity_xrp) high_liq_xrp
           FROM market_snapshots
           WHERE token_issuer=? AND token_currency IN ({placeholders})
             AND timestamp>=? AND timestamp<=?
        """, (issuer,*names,latest-24*3600*1000,latest)).fetchone()

    # Only exact-raw-code matched rejects are issuer-provable; a plain
    # ticker-only rejection is NOT sufficient evidence of same token identity.
    rejects=[]
    if "shadow_trades" in tables:
        rejects=db.execute(f"""
           SELECT reject_reason,COUNT(*) n,MAX(skipped_at) last_at
           FROM shadow_trades
           WHERE issuer=? AND currency IN ({placeholders})
             AND raw_currency=? AND skipped_at<=?
           GROUP BY reject_reason
           ORDER BY n DESC LIMIT 3
        """,(issuer,*names,raw,latest)).fetchall()

    # Only the exact issuer and stored exact raw code identify matching trades.
    trades=[]
    if "paper_trades" in tables:
        trades=db.execute(f"""
           SELECT id,token_currency,trade_source,status,entry_timestamp,
                  exit_timestamp,pnl_xrp,exit_reason
           FROM paper_trades
           WHERE token_issuer=? AND entry_timestamp<=?
             AND (raw_currency=? OR
                  (raw_currency IS NULL AND token_currency=?))
           ORDER BY entry_timestamp DESC LIMIT 5
        """,(issuer,latest,raw,raw)).fetchall()
    if trades:
        classification="TRADED_BEFORE_RANK"
    elif any(x in events for x in ["burst_seen","burst_qualified","momentum_seen","stream_qualified"]):
        classification="QUALIFIED_SIGNAL_NO_ENTRY"
    elif "stream_quoted" in events:
        # STREAM quote is only a priced observation, not a qualifying
        # TDE-eligible or executable trading signal.
        classification="QUOTE_ONLY_NO_QUALIFIED_SIGNAL"
    elif (previous and previous["n"]>0):
        classification="PRICE_SAMPLED_NO_SIGNAL"
    elif tracked or "first_detected" in events:
        classification="TRACKED_NO_SAMPLED_SIGNAL"
    else:
        classification="NO_PRIOR_BOT_COVERAGE_EVIDENCE"
    # Legacy near-miss table stores issuer + displayed currency, no raw code.
    # Require issuer AND matching known display alias, but label this result as
    # provisional; never call it cryptographically issuer-exact evidence.
    near_misses=[]
    if "missed_opportunities" in tables:
        legacy=set(names)
        if re.fullmatch(r"[A-Fa-f0-9]{40}",raw):
            # Historical decoder incorrectly stripped a final zero nibble
            # from letters such as P (0x50) / digit 0 (0x30).
            truncated=re.sub(r"00+$","",raw)
            # Match the legacy Node Buffer.from(hex) odd-nibble behaviour.
            if len(truncated)%2:truncated=truncated[:-1]
            try:
                legacy_name=bytes.fromhex(truncated).decode("ascii","ignore")
                if legacy_name:
                    legacy.add(legacy_name.replace("\x00","").strip())
            except ValueError:
                pass
        aliases_sql=",".join("?" for _ in legacy)
        near_misses=db.execute(f"""
            SELECT currency,skip_reason,COUNT(*) n,MAX(skipped_at) last_at,
                   MAX(pct_gain_60m) max_spot_gain_60m
            FROM missed_opportunities
            WHERE issuer=? AND currency IN ({aliases_sql}) AND skipped_at<=?
            GROUP BY currency,skip_reason ORDER BY n DESC LIMIT 5
        """,(issuer,*sorted(legacy),latest)).fetchall()
    return classification,events,previous,rejects,trades,tracked,first_seen,near_misses

def report(path:Path,limit:int=20):
    if not path.is_file() or path.is_symlink():
        raise ValueError("Expected existing regular PAPER epoch DB")
    with closing(sqlite3.connect(path.resolve().as_uri()+"?mode=ro",
                                 uri=True,timeout=15)) as db:
        db.row_factory=sqlite3.Row
        db.execute("PRAGMA query_only=ON")
        db.execute("BEGIN")
        tables=table_names(db)
        if "paper_opportunity_events" not in tables:
            raise ValueError("paper_opportunity_events missing")
        latest=db.execute("""
           SELECT MAX(observed_at) FROM paper_opportunity_events
           WHERE event_type='external_gainer_seen'
        """).fetchone()[0]
        print("=== HUNTERIX: TOP GAINER SIGNAL / COVERAGE AUDIT (READ ONLY) ===")
        if latest is None:
            print("No external gainer observations recorded yet.")
            return
        batch=db.execute("""
           SELECT token_currency,token_issuer,raw_currency,
                  observed_at,detail,price_xrp
           FROM paper_opportunity_events
           WHERE event_type='external_gainer_seen' AND observed_at=?
        """,(latest,)).fetchall()
        winners=parse_gainer_rows(batch,limit)
        print("Snapshot:",date(latest))
        print("Stored issues:",len(batch),"Top distinct:",len(winners))
        print("All 24h changes retrospective; prior sellable highs NOT established.")
        counts=Counter()
        for i,t in enumerate(winners,1):
            status,ev,price,rejects,trades,tracked,first,near_misses=diagnose(db,latest,t,tables)
            counts[status]+=1
            print(f"\n#{i} {t['token_currency'][:16]} {t['change24h']:+.2f}% "
                  f"[{status}]")
            print("  issue:",t["raw_currency"]+":"+t["token_issuer"])
            print("  tracked_rows:",tracked,"first_seen_field:",date(first),
                  "(may describe external provider history)")
            observed=price["n"] if price else 0
            print("  price_snapshots_last_24h:",observed,
                  "last:",date(price["latest"] if price else None),
                  "max_observed_liquidity_xrp:",
                  round(price["high_liq_xrp"],2)
                    if price and price["high_liq_xrp"] is not None else "-")
            print("  bot_events:",
                  ", ".join(f"{k}={v['n']}@{date(v['earliest'])}"
                            for k,v in sorted(ev.items())
                            if k not in ("external_gainer_seen",
                                         "amm_pressure_compare","amm_xrp_inflow",
                                         "amm_xrp_outflow")) or "-")
            if rejects:
                print("  exact_issue_rejects:",
                      "; ".join(f"{x['reject_reason'][:110]} ({x['n']})"
                                for x in rejects))
            if near_misses:
                print("  near_misses_issuer+display (raw not stored):",
                      "; ".join(f"{x['currency']} {x['skip_reason'][:50]} ({x['n']})"
                                for x in near_misses))
            if trades:
                print("  matching_paper_entries:",
                      "; ".join(f"#{x['id']} {x['trade_source']} "
                                f"{x['status']} pnl={x['pnl_xrp']} XRP "
                                f"exit={x['exit_reason'] or '-'}"
                                for x in trades))
        print("\nCOVERAGE CATEGORIES:",dict(counts))
        print("CAVEATS: no-event is not a proven missed tradable move; "
              "no saved snapshot is not proof the asset never traded; "
              "shadow rejections require exact raw code; legacy near-misses"
              " are only issuer+display matches and may be ambiguous; "
              "max observed liquidity is not liquidity at a hypothetical entry.")
        print("No bot changes, no trades, no external requests.")

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--db",required=True,type=Path)
    p.add_argument("--limit",type=int,default=20)
    a=p.parse_args()
    if not 1<=a.limit<=50:
        p.error("--limit must be 1..50")
    try:report(a.db,a.limit);return 0
    except (sqlite3.Error,ValueError,OSError,OverflowError) as e:
        print("COVERAGE AUDIT BLOCKED:",e,file=sys.stderr);return 2

if __name__=="__main__":
    raise SystemExit(main())
