#!/usr/bin/env python3
"""Foreground, bounded PAPER flat-book observer with a SINGLE guarded cutover.

The old running bot has no entry-freeze support and may fill vacant slots
before an operator can type a new command. This helper polls READ-ONLY and,
when the PAPER book first appears flat, executes the reviewed guarded cutover
*once*. That cutover rechecks flatness under SQLite BEGIN IMMEDIATE while
stopping PM2; a race always fails closed without stopping with positions.

This helper never writes SQLite, stops PM2, unfreezes PAPER entries, force
closes inventory, touches wallet keys, schedules itself or daemonizes.
It must be deliberately invoked in the foreground by the operator.
"""
from __future__ import annotations
import argparse
from contextlib import closing
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import time

from guarded_flat_paper_cutover import (
    EPOCH_NAME, pm2_process, require_safe_runtime, verify_repositories,
    paper_state
)

DEFAULT_ACTIVE=Path('/root/hunterix-vnext-stage-20261116')
DEFAULT_REVIEW=Path('/root/hunterix-dynamic-meme-review-20261121')

def positions_ro(db_path:Path)->list[tuple[int,str,str]]:
    if db_path.is_symlink() or not db_path.is_file():
        raise RuntimeError('Verified PAPER epoch database missing/not regular')
    uri=db_path.resolve().as_uri()+'?mode=ro'
    with closing(sqlite3.connect(uri,uri=True,timeout=5)) as db:
        db.execute('PRAGMA query_only=ON')
        return list(db.execute(
            "SELECT id,token_currency,status FROM paper_trades "+
            "WHERE status IN ('open','partial') ORDER BY id"
        ))

def observe_then_invoke(
    read_positions, invoke_cutover, monotonic, sleep, *,
    timeout_seconds:float, interval_seconds:float
)->int:
    """Pure injectable logic for offline tests; cutover never retried."""
    start=monotonic()
    last_snapshot=None
    while True:
        snapshot=read_positions()
        if snapshot!=last_snapshot:
            if snapshot:
                tokens=', '.join(f'#{i} {symbol} ({status})'
                                 for i,symbol,status in snapshot)
                print(f'PAPER book: {len(snapshot)} still open: {tokens}',flush=True)
            else:
                print('PAPER book appears FLAT; invoking guarded, race-safe cutover ONCE.',
                      flush=True)
            last_snapshot=snapshot
        if not snapshot:
            return invoke_cutover()
        remaining=timeout_seconds-(monotonic()-start)
        if remaining<=0:
            print('WATCH ENDED WITHOUT DEPLOYMENT: positions remain; PM2 and database untouched.',flush=True)
            return 3
        sleep(min(interval_seconds,remaining))

def main()->int:
    parser=argparse.ArgumentParser(
        description='Operator-attended, bounded watcher; deploys ONCE only when PAPER book appears flat.'
    )
    parser.add_argument('--watch-and-deploy',action='store_true',required=True)
    parser.add_argument('--pin',required=True,help='Full SHA of CI-passed release')
    parser.add_argument('--active',type=Path,default=DEFAULT_ACTIVE)
    parser.add_argument('--review',type=Path,default=DEFAULT_REVIEW)
    parser.add_argument('--timeout-seconds',type=int,default=900)
    parser.add_argument('--interval-seconds',type=float,default=2.0)
    args=parser.parse_args()
    if not re.fullmatch(r'[0-9a-fA-F]{40}',args.pin):
        raise RuntimeError('Full pinned 40-hex SHA required')
    if not 1<=args.timeout_seconds<=3600 or not 0.25<=args.interval_seconds<=30:
        raise RuntimeError('Unsafe watcher bounds; timeout must be 1..3600 seconds, interval 0.25..30')
    active=args.active.resolve()
    review=args.review.resolve()
    db=active/'data'/EPOCH_NAME

    # Fail before waiting if PM2, paths, release SHA or operator manifests
    # do not match the reviewed PAPER-only production baseline.
    verify_repositories(active,review,args.pin.lower())
    require_safe_runtime(pm2_process(),active,online=True)
    n,trades,cash=paper_state(db)
    print(f'PRECHECK PASS: PAPER={n} open, {trades} trades, cash={cash:.6f} XRP')
    print(f'Foreground watch: max {args.timeout_seconds}s; every {args.interval_seconds:g}s; Ctrl-C cancels.')
    print('The eventual guarded cutover always repeats safety checks and NEVER auto-unfreezes PAPER entries.')

    command=[
        sys.executable,str(review/'scripts'/'guarded_flat_paper_cutover.py'),
        '--deploy-if-flat','--pin',args.pin.lower(),
        '--active',str(active),'--review',str(review)
    ]
    return observe_then_invoke(
        lambda: positions_ro(db),
        lambda: subprocess.run(command,check=False).returncode,
        time.monotonic,time.sleep,
        timeout_seconds=float(args.timeout_seconds),
        interval_seconds=args.interval_seconds
    )

if __name__=='__main__':
    try:raise SystemExit(main())
    except KeyboardInterrupt:
        print('WATCH CANCELLED by operator; no further deployment attempt.')
        raise SystemExit(130)
    except (RuntimeError,sqlite3.Error,subprocess.SubprocessError) as error:
        print('WATCH BLOCKED:',error,file=sys.stderr)
        raise SystemExit(2)
