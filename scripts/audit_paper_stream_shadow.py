#!/usr/bin/env python3
"""Read-only prospective Strategy V2 STREAM shadow outcome audit.

A candidate is recorded only AFTER the regular PAPER preflight passed but
before an entry. This report uses OBSERVED market_snapshots in exact ledger
issuer + code and forward 15m/1h/4h windows. Snapshot highs are NOT AMM
executable exit quotes, and no synthetic entry or realized P&L is inferred.

Missing or sparse historical samples are explicitly counted. No provider,
Telegram, PM2 calls, new trades or DB writes. Offline report is not a
replacement for forward out-of-sample trading evaluation.
"""
from __future__ import annotations
import argparse
from collections import defaultdict
from contextlib import closing
from datetime import datetime,timezone
import math
from pathlib import Path
import sqlite3
import statistics
import sys
import time

WINDOWS=[('15m',15*60000),('1h',60*60000),('4h',4*60*60000)]

def open_ro(path:Path):
    if not path.is_file() or path.is_symlink():
        raise RuntimeError('Expected regular PAPER epoch DB, not a symlink: '+str(path))
    db=sqlite3.connect(path.resolve().as_uri()+'?mode=ro',uri=True,timeout=8)
    db.row_factory=sqlite3.Row
    db.execute('PRAGMA query_only=ON')
    db.execute('BEGIN')
    db.execute('SELECT 1 FROM sqlite_master LIMIT 1').fetchone()
    return db

def buyer_group(n:int)->str:
    return '0-2 buyers' if n<=2 else ('3-5 buyers' if n<=5 else '6+ buyers')

def evaluate_window(db,rec:dict,elapsed_ms:int):
    ts=int(rec['observed_at'])
    code=rec['raw_currency']
    row=db.execute("""
      SELECT COUNT(*) AS n,MIN(price_xrp) AS low,MAX(price_xrp) AS high,
             MIN(timestamp) AS first_at,MAX(timestamp) AS last_at
      FROM market_snapshots
      WHERE token_issuer=? AND token_currency IN (?,?)
        AND timestamp>? AND timestamp<=? AND price_xrp>0
    """,(rec['token_issuer'],rec['token_currency'],code,ts,ts+elapsed_ms)).fetchone()
    n=int(row['n'])
    if n<2:return {'samples':n,'high_pct':None,'low_pct':None}
    entry=float(rec['price_xrp'])
    return {
      'samples':n,
      'high_pct':100*(float(row['high'])/entry-1),
      'low_pct':100*(float(row['low'])/entry-1)
    }

def run(db_path:Path,now_ms:int,limit:int):
    if limit<1 or limit>200:
        raise RuntimeError('Limit must be between 1 and 200')
    with closing(open_ro(db_path)) as db:
        exists=db.execute("""
          SELECT 1 FROM sqlite_master WHERE type='table'
            AND name='paper_stream_shadow_signals'
        """).fetchone()
        print('=== HUNTERIX STRATEGY V2: PROSPECTIVE PAPER STREAM SHADOW ===')
        print('Database:',db_path)
        if not exists:
            print('No V2 evidence table: upgraded PAPER release not active in this database.')
            return
        all_count=db.execute('SELECT COUNT(*) FROM paper_stream_shadow_signals').fetchone()[0]
        if all_count==0:
            print('No eligible V2 STREAM shadow signals recorded yet.')
            print('The upgraded bot must be deployed, PAPER entries deliberately unfrozen,')
            print('and qualifying STREAM signals observed before any forward comparison.')
            return
        first=db.execute('SELECT MIN(observed_at) FROM paper_stream_shadow_signals').fetchone()[0]
        last=db.execute('SELECT MAX(observed_at) FROM paper_stream_shadow_signals').fetchone()[0]
        print(f'Eligible observations: {all_count} (issuer-specific, max one per 15m bucket)')
        print('First observed (UTC):',datetime.fromtimestamp(first/1000,timezone.utc).isoformat())
        print('Last observed (UTC): ',datetime.fromtimestamp(last/1000,timezone.utc).isoformat())
        print('Observation does NOT mean an entry, sale or simulated profit occurred.')
        by_buyers=defaultdict(list)
        by_signal=defaultdict(list)
        recent=[dict(r) for r in db.execute("""
          SELECT * FROM paper_stream_shadow_signals ORDER BY observed_at DESC LIMIT ?
        """,(limit,))]
        for r in db.execute("SELECT unique_buyers,signal_type,price_xrp FROM paper_stream_shadow_signals"):
            if r['unique_buyers'] is not None:
                by_buyers[buyer_group(int(r['unique_buyers']))].append(1)
            by_signal[str(r['signal_type'])].append(1)
        print('\n=== REAL-TIME EVIDENCE AT ELIGIBLE SIGNAL ===')
        for k,v in sorted(by_signal.items()):print(f'  {k}: {len(v)}')
        for k,v in sorted(by_buyers.items()):print(f'  {k}: {len(v)}')
        print('Buyer counts are tracker-reported independent wallet counts, not the')
        print('unverified counts parsed from historical Telegram or entry reason text.')

        print('\n=== FORWARD OBSERVED MARKET SNAPSHOTS (NOT SELLABLE HIGHS) ===')
        for label,ms in WINDOWS:
            matured=0;covered=0;sparse=0;missing=0;above15=0
            gains=[];drawdowns=[]
            # Query every eligible signal for correct global rates, not just
            # newest "limit" display rows. Report coverage to avoid survivorship
            # and the old resolver's historical-price look-ahead bias.
            for row in db.execute('SELECT * FROM paper_stream_shadow_signals ORDER BY observed_at'):
                rec=dict(row)
                if now_ms<int(rec['observed_at'])+ms:
                    continue
                matured+=1
                v=evaluate_window(db,rec,ms)
                if v['samples']>=2:
                    covered+=1
                    gains.append(v['high_pct'])
                    drawdowns.append(v['low_pct'])
                    if v['high_pct']>=15:above15+=1
                elif v['samples']==1:sparse+=1
                else:missing+=1
            print(f'{label}: matured={matured}, >=2 snapshots={covered}, '
                  f'one snapshot={sparse}, no snapshots={missing}')
            if covered:
                print('  Observed high >= entry +15%:',
                      f'{above15}/{covered} COVERED signals only '
                      '(NOT actual TP fills)')
                print('  Median observed max vs signal price:',
                      f'{statistics.median(gains):+.1f}%')
                print('  Median observed min vs signal price:',
                      f'{statistics.median(drawdowns):+.1f}%')
            else:
                print('  Insufficient observations; no performance conclusion available.')

        print('\n=== CONTEMPORANEOUS BURST PAPER COMPARISON ===')
        has_paper=db.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='paper_trades'"
        ).fetchone()
        if has_paper:
            eligible=db.execute("""
               SELECT COUNT(*) n,
                      SUM(CASE WHEN status='closed' THEN 1 ELSE 0 END) closed,
                      SUM(CASE WHEN status='closed' AND
                            (xrp_returned-entry_amount_xrp*1.003)>0 THEN 1 ELSE 0 END) won,
                      SUM(CASE WHEN status='closed' THEN
                            xrp_returned-entry_amount_xrp*1.003 ELSE 0 END) net
               FROM paper_trades
               WHERE entry_timestamp>=? AND
                 (trade_source='burst' OR entry_reason LIKE '[BURST]%')
            """,(first,)).fetchone()
            n=int(eligible['n'] or 0);closed=int(eligible['closed'] or 0)
            won=int(eligible['won'] or 0);net=float(eligible['net'] or 0)
            print(f'BURST since first shadow signal: entries={n} completed={closed} '
                  f'wins={won} completed realized PnL={net:+.4f} XRP')
            print('This is a contemporaneous, NON-RANDOMIZED comparison.')
            print('It must NOT be compared as if shadow highs were realized returns.')
        print('\n=== MOST RECENT SHADOW SIGNALS ===')
        for rec in reversed(recent):
            age=(now_ms-rec['observed_at'])/60000
            print(f"#{rec['id']:>3} {rec['token_currency'][:18]:18s} "
                  f"{rec['signal_type']:12s} buyers={rec['unique_buyers']:2d} "
                  f"buy/sell={rec['buy_count_5m']}/{rec['sell_count_5m']} "
                  f"volume={rec['buy_volume_xrp']:.1f} XRP "
                  f"price={rec['price_xrp']:.12g} "
                  f"age={age:.1f}m")
        print('\nNEXT: accumulate enough mature, well-sampled candidates before '
              'testing buyer-confirmation thresholds. Missing coverage is not a loss.')

def main()->int:
    p=argparse.ArgumentParser()
    p.add_argument('--db',type=Path,required=True)
    p.add_argument('--now-ms',type=int,default=None,help='Fixture testing only')
    p.add_argument('--recent',type=int,default=25)
    args=p.parse_args()
    try:
        run(args.db,args.now_ms if args.now_ms is not None else int(time.time()*1000),args.recent)
        return 0
    except (RuntimeError,sqlite3.Error,ValueError,TypeError) as err:
        print('V2 SHADOW AUDIT BLOCKED:',err,file=sys.stderr)
        return 2

if __name__=='__main__':
    raise SystemExit(main())
