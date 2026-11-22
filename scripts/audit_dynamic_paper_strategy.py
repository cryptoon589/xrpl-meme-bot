#!/usr/bin/env python3
"""Read-only forensic strategy audit for HUNTERIX dynamic PAPER trades.

Baseline is verified pre-dynamic backup (16 trades). Uses the existing
cash+inventory accounting audit first, then analyzes ONLY new trade IDs.
No network, PM2, Telegram, wallet, live execution or database writes.

Important: open inventory remains unvalued. Recorded snapshot high/low
prices are historical observations, NOT sellable executable AMM quotes.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from contextlib import closing
from datetime import datetime, timezone
import math
from pathlib import Path
import re
import sqlite3
import statistics
import sys

from audit_dynamic_paper_performance import (
    PAPER_ENTRY_FEE_RATE, audit as cash_audit, open_read_only,
    original_backup
)

BUYERS_RE = re.compile(r'(\d+)\s+buyers\b', re.I)
BUY_PCT_RE = re.compile(r'(\d+(?:\.\d+)?)\s*%\s*buys\b', re.I)
BUY_VOL_RE = re.compile(r'(\d+(?:\.\d+)?)\s*XRP\b', re.I)
SUPPORTED = ("id","token_currency","token_issuer","raw_currency","status",
    "entry_amount_xrp","entry_price_xrp","entry_timestamp","exit_timestamp",
    "xrp_returned","pnl_xrp","remaining_position","tp1_hit","tp2_hit",
    "entry_reason","exit_reason","trade_source","trade_profile","entry_score")

def money(v: float) -> str:
    return f"{v:+.4f} XRP"

def describe_source(t:dict) -> str:
    reason=str(t.get('entry_reason') or '')
    source=str(t.get('trade_source') or '').strip().lower()
    if 'stream' in source or reason.startswith('[STREAM]'):
        return 'stream'
    if 'burst' in source or reason.startswith('[BURST]'):
        return 'burst'
    if 'whale' in source or reason.startswith('[WHALE'):
        return 'whale'
    if 'score' in source or reason.startswith('[SCORE'):
        return 'scored'
    return source if source else 'unknown'

def outcome(t:dict) -> float:
    fraction=(100-float(t['remaining_position']))/100
    return float(t.get('xrp_returned') or 0) - (
        float(t['entry_amount_xrp'])*(1+PAPER_ENTRY_FEE_RATE)*fraction)

def fmt_group(name, seq):
    completed=[t for t in seq if t['status']=='closed']
    open_count=len(seq)-len(completed)
    wins=[t for t in completed if outcome(t)>0]
    losses=[t for t in completed if outcome(t)<=0]
    win_sum=sum(outcome(t) for t in wins)
    loss_sum=sum(outcome(t) for t in losses)
    profit_factor=f"{win_sum/abs(loss_sum):.2f}" if loss_sum<0 else (
        "n/a (no losses)" if win_sum else "n/a")
    wr=f"{100*len(wins)/len(completed):.1f}%" if completed else 'n/a'
    return (f"{name[:23]:23s} trades={len(seq):2d} closed={len(completed):2d} "
            f"open/partial={open_count:2d} WR={wr:>6s} "
            f"realized_closed={money(sum(outcome(t) for t in completed)):>13s} "
            f"profit_factor={profit_factor}")

def percent_change(px,entry):
    return 100*(px/entry-1) if px and entry and px>0 and entry>0 else None

def price_excursion(db, trade):
    """Only exact-issuer and matching currency raw/display historical price.
    Sparse observations; not enough to estimate realized quote or slippage.
    Excludes post-exit prices to avoid forward-looking leakage.
    """
    ts0=int(trade['entry_timestamp'])
    ts1=int(trade['exit_timestamp'] or 0)
    if ts1<=ts0:return None
    raw=trade.get('raw_currency') or trade['token_currency']
    row=db.execute("""
      SELECT MIN(price_xrp) AS low,MAX(price_xrp) AS high,
             COUNT(*) AS samples,MIN(timestamp) AS first,MAX(timestamp) AS last
      FROM market_snapshots
      WHERE token_issuer=? AND token_currency IN (?,?)
        AND timestamp>=? AND timestamp<=?
        AND price_xrp>0
    """,(trade['token_issuer'],trade['token_currency'],raw,ts0,ts1)).fetchone()
    if not row or int(row['samples'])<2:return None
    return {
      'observed_low_pct':percent_change(row['low'],trade['entry_price_xrp']),
      'observed_high_pct':percent_change(row['high'],trade['entry_price_xrp']),
      'samples':int(row['samples']),
      'first_delay_s':(row['first']-ts0)/1000,
      'last_age_s':(ts1-row['last'])/1000,
    }

def print_audit(db_path:Path,baseline_path:Path, *,details:int=40)->None:
    # Fail closed if the established accounting audit finds unexplained cash,
    # impossible statuses, missing trade IDs or erroneous PnL.
    cash_audit(db_path,baseline_path)
    with closing(open_read_only(baseline_path)) as base, closing(open_read_only(db_path)) as db:
        old={r[0] for r in base.execute('SELECT id FROM paper_trades')}
        columns={r[1] for r in db.execute('PRAGMA table_info(paper_trades)')}
        required=set(SUPPORTED)-{'raw_currency'}
        if required-columns:
            raise RuntimeError('Missing PAPER trade fields: '+str(sorted(required-columns)))
        fields=[c for c in SUPPORTED if c in columns]
        raw=[dict(row) for row in db.execute(
            'SELECT '+','.join(fields)+' FROM paper_trades ORDER BY id')]
        trades=[t for t in raw if t['id'] not in old]
        if not trades:
            print('No post-baseline strategy trades to analyze.');return
        closed=sorted(
            [t for t in trades if t['status']=='closed'],
            key=lambda t:(t['exit_timestamp'] or 0,t['id'])
        )
        open_trades=[t for t in trades if t['status']!='closed']
        win=[t for t in closed if outcome(t)>0]
        lose=[t for t in closed if outcome(t)<=0]
        gross_gain=sum(outcome(t) for t in win)
        gross_loss=sum(outcome(t) for t in lose)
        realized_closed=gross_gain+gross_loss
        partial_realized=sum(outcome(t) for t in open_trades)
        trade_sizes=sum(t['entry_amount_xrp'] for t in closed)
        roi=(100*realized_closed/(trade_sizes*(1+PAPER_ENTRY_FEE_RATE))
             if trade_sizes>0 else 0)
        holding_mins=[
            (t['exit_timestamp']-t['entry_timestamp'])/60000
            for t in closed
            if t.get('exit_timestamp') and t['exit_timestamp']>=t['entry_timestamp']
        ]
        max_streak=streak=0
        for t in closed:
            streak=0 if outcome(t)>0 else streak+1
            max_streak=max(max_streak,streak)
        current_streak=streak
        # Closed-trade-only realized equity curve: open positions deliberately
        # not marked; no chronological cash-equity drawdown inference.
        running=peak=max_dd=0
        for t in closed:
            running+=outcome(t);peak=max(peak,running)
            max_dd=max(max_dd,peak-running)
        print('\n=== DYNAMIC PAPER STRATEGY DIAGNOSTICS (COMPLETED TRADES) ===')
        print(f'Sample: {len(trades)} new entries, {len(closed)} fully closed, '
              f'{len(open_trades)} still open/partial')
        print(f'Win rate: {len(win)}/{len(closed)} = '
              + (f'{100*len(win)/len(closed):.1f}%' if closed else 'N/A'))
        print('Gross winning PnL: ',money(gross_gain))
        print('Gross losing PnL:  ',money(gross_loss))
        print('Net closed PnL:    ',money(realized_closed))
        print('Partial realized:  ',money(partial_realized))
        print('Total realized (closed + sold fractions): ',
              money(realized_closed+partial_realized))
        print('Mean closed trade: ',money(realized_closed/len(closed)) if closed else 'n/a')
        print('Median closed PnL:',money(statistics.median(outcome(t) for t in closed))
              if closed else 'n/a')
        print('Avg winning trade:',money(gross_gain/len(win)) if win else 'n/a')
        print('Avg losing trade: ',money(gross_loss/len(lose)) if lose else 'n/a')
        print('Profit factor:    ',f'{gross_gain/abs(gross_loss):.2f}' if gross_loss<0 else 'n/a')
        print(f'Return on entry costs (closed trades ONLY): {roi:+.2f}%')
        print('Median hold time: ',
              f'{statistics.median(holding_mins):.1f} minutes'
              if holding_mins else 'n/a')
        print(f'Longest nonwinning closed streak: {max_streak}; current: {current_streak}')
        print('Maximum closed-only cumulative realized drawdown:',
              money(max_dd),'(NOT account-equity drawdown)')
        print('Open-position valuation: UNKNOWN (no live AMM executable quote)')

        def groups(title,key):
            print('\n=== '+title+' ===')
            by=defaultdict(list)
            for t in trades:by[str(key(t))].append(t)
            for name,items in sorted(by.items(),key=lambda kv:(-len(kv[1]),kv[0])):
                print(fmt_group(name,items))
        groups('ENTRY SOURCE',describe_source)
        groups('STORED TRADE PROFILE',lambda t:t.get('trade_profile') or 'missing')
        groups('EXITS (completed only)',lambda t:t.get('exit_reason') if t['status']=='closed'
               else 'OPEN (no exit)')
        groups('TOKEN TICKER (not necessarily same issuer)',lambda t:t['token_currency'])

        # When source is stream but the assigned profile is BURST_SCALP,
        # the current code uses scored stop/time logic: flag model ambiguity.
        mixed=[t for t in trades if describe_source(t)=='stream'
               and t.get('trade_profile')=='BURST_SCALP']
        if mixed:
            print('\n=== EXIT PATH CLASSIFICATION WARNING ===')
            print(f'{len(mixed)} stream-origin trades recorded as BURST_SCALP. '
                  'The current PaperTrader opens stream orders via the scored '
                  'entry method, whose exit-time logic differs from burst.')
            print('No historical runtime checkpoint records the precise internal '
                  'exit branch for all old trades; do NOT infer an exact '
                  'counterfactual from the profile label.')

        print('\n=== ENTRY TEXT SIGNAL STRENGTH (PARSER COVERAGE) ===')
        buckets=defaultdict(list)
        parsed=0
        for t in trades:
            r=str(t.get('entry_reason') or '')
            match=BUYERS_RE.search(r)
            if not match:
                buckets['buyers not recorded'].append(t)
            else:
                parsed+=1
                buyers=int(match.group(1))
                label='1-2 buyers' if buyers<=2 else ('3-5 buyers' if buyers<=5 else '6+ buyers')
                buckets[label].append(t)
        print(f'Entries with parseable buyer counts: {parsed}/{len(trades)}. '
              'Count is as written in entry reason, NOT independently verified distinct wallets.')
        for name,items in sorted(buckets.items()):
            print(fmt_group(name,items))
        pct_found=sum(bool(BUY_PCT_RE.search(t.get('entry_reason') or '')) for t in trades)
        vol_found=sum(bool(BUY_VOL_RE.search(t.get('entry_reason') or '')) for t in trades)
        print(f'Buy-ratio text coverage: {pct_found}/{len(trades)}; '
              f'buy-volume text coverage: {vol_found}/{len(trades)}')

        print('\n=== EXACT-ISSUER REPEATS ===')
        byissue=defaultdict(list)
        for t in trades:byissue[(t['token_currency'],t['token_issuer'])].append(t)
        for (symbol,issuer),items in sorted(byissue.items(),key=lambda x:-len(x[1])):
            if len(items)>1:
                print(fmt_group(symbol+' '+issuer[:7]+'…',items))
        if all(len(g)==1 for g in byissue.values()):
            print('No repeated exact-issuer entries since baseline.')
        cross=defaultdict(set)
        for t in trades:cross[t['token_currency']].add(t['token_issuer'])
        for symbol,issuers in sorted(cross.items()):
            if len(issuers)>1:
                print(f'IDENTITY ALERT: ticker {symbol} used by {len(issuers)} distinct issuers '
                      '(same ticker is NOT the same XRPL asset)')

        print('\n=== HISTORICAL OBSERVED EXCURSIONS (NOT EXECUTABLE QUOTES) ===')
        has_table=db.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='market_snapshots'"
        ).fetchone()
        excursions={}
        if has_table:
            for t in closed:
                x=price_excursion(db,t)
                if x:excursions[t['id']]=x
        adequate=[(t,excursions[t['id']]) for t in closed if t['id'] in excursions]
        print(f'Historical stored price range available: {len(adequate)}/{len(closed)} '
              'closed trades (>=2 positive observations while held).')
        favorable_losers=[
            (t,x) for t,x in adequate
            if outcome(t)<=0 and x['observed_high_pct']>=15
        ]
        print(f'Losers with OBSERVED in-trade price >= entry +15%: '
              f'{len(favorable_losers)} (sparse snapshots; not necessarily a sellable TP)')
        for t,x in favorable_losers[:12]:
            print(f"  #{t['id']} {t['token_currency']} "
                  f"high={x['observed_high_pct']:+.1f}% "
                  f"low={x['observed_low_pct']:+.1f}% "
                  f"samples={x['samples']} final={money(outcome(t))}")
        if not adequate:
            print('Not enough stored observations for excursion comparison. '
                  'Do not infer that targets were or were not reached.')

        print('\n=== RECENT COMPLETED TRADES (EXIT ORDER) ===')
        for t in closed[-details:]:
            held=((t['exit_timestamp']-t['entry_timestamp'])/60000
                  if t.get('exit_timestamp') else float('nan'))
            src=describe_source(t)
            buyer=BUYERS_RE.search(t.get('entry_reason') or '')
            buyers=buyer.group(1) if buyer else 'n/a'
            print(f"#{t['id']:>3} {t['token_currency'][:12]:12s} "
                  f"{src:7s} buy_count={buyers:>3s} "
                  f"held={held:7.1f}m pnl={outcome(t):+.4f} "
                  f"reason={t.get('exit_reason') or 'unknown'}")
        print('\nINTERPRETATION: This is realized simulated PAPER performance. '
              'Do not change entry gates or stops solely because one subgroup looks '
              'better in a small, non-random sample; validate on future out-of-sample trades.')

def main():
    p=argparse.ArgumentParser()
    p.add_argument('--db',type=Path,required=True)
    p.add_argument('--baseline',type=Path,default=None)
    p.add_argument('--recent',type=int,default=40)
    a=p.parse_args()
    if not 1<=a.recent<=200:
        p.error('--recent must be 1..200')
    try:
        print_audit(a.db,a.baseline or original_backup(a.db),details=a.recent)
        return 0
    except (RuntimeError,sqlite3.Error,ValueError,OverflowError) as err:
        print('STRATEGY AUDIT BLOCKED:',err,file=sys.stderr)
        return 2

if __name__=='__main__':
    raise SystemExit(main())
