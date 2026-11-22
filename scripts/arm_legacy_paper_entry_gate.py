#!/usr/bin/env python3
"""Operator-armed legacy PAPER entry gate: stop NEW inserts, preserve exits.

The old 6c5d4d0 release does not check the V2 entry-freeze sentinel. Its
entry methods atomically INSERT into paper_trades before debiting in-memory
PAPER cash. Its TP and stop exits UPDATE existing paper_trades rows.

When operator explicitly runs --arm, a SQLite BEFORE INSERT trigger rejects
ONLY paper_trades INSERTs. This does NOT stop/restart PM2, change trades,
close inventory, or manufacture recovery state. It will cause rejected entry
attempts to log SQLite errors in the OLD Node app; the guard is temporary.

Only this exact reviewed trigger is allowed. A WAL-coherent private safety
backup is created BEFORE the gate is armed. The guarded flat-book cutover
verifies/removes the trigger ONLY AFTER the old process is stopped AND
PAPER-entry-freeze sentinel has been installed.

--status is read-only. Neither mode disarms or resumes trading. No LIVE mode.
"""
from __future__ import annotations

import argparse
from contextlib import closing
from datetime import datetime, timezone
import os
from pathlib import Path
import shutil
import sqlite3
import sys

from guarded_flat_paper_cutover import (
    OLD_SHA, EPOCH_NAME, pm2_process, require_safe_runtime,
    git_head, paper_state, ro_db, abort
)

NAME='hunterix_legacy_paper_insert_gate'
MESSAGE='HUNTERIX_OLD_PAPER_ENTRY_ONLY_BLOCK'
SQL=(f"CREATE TRIGGER {NAME} BEFORE INSERT ON paper_trades "
     f"BEGIN SELECT RAISE(ABORT, '{MESSAGE}'); END")
DEFAULT_ACTIVE=Path('/root/hunterix-vnext-stage-20261116')

def norm(x:str)->str:
    return ''.join((x or '').lower().split()).replace(';','')

def verify_gate_sql(body:str|None)->None:
    if body is None or norm(body)!=norm(SQL):
        abort('Existing legacy entry-gate trigger body differs from reviewed SQL')

def trigger_sql(db:sqlite3.Connection)->str|None:
    rec=db.execute(
        "SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?",
        (NAME,)
    ).fetchone()
    return rec[0] if rec else None

def check_existing_gate(db:sqlite3.Connection)->bool:
    present=trigger_sql(db)
    if present is None:return False
    verify_gate_sql(present)
    return True

def arm_gate(db_path:Path)->tuple[int,int,float,bool]:
    """Add one reviewed BEFORE INSERT trigger under an atomic writer lock.

    The trigger never changes an existing row. Exit UPDATE operations remain
    permitted and cash/inventory tables have no triggers installed.
    """
    if db_path.is_symlink() or not db_path.is_file():
        abort('PAPER epoch must be an existing regular database file')
    with closing(sqlite3.connect(str(db_path),timeout=8,isolation_level=None)) as c:
        c.execute('PRAGMA busy_timeout=8000')
        c.execute('BEGIN IMMEDIATE')
        try:
            before=(
                c.execute("SELECT COUNT(*) FROM paper_trades").fetchone()[0],
                c.execute("SELECT COUNT(*) FROM paper_trades WHERE status IN ('open','partial')").fetchone()[0],
                float(c.execute("SELECT bankroll_xrp FROM paper_cash_state WHERE singleton_id=1").fetchone()[0])
            )
            already=check_existing_gate(c)
            if not already:
                c.execute(SQL)
            if not check_existing_gate(c):
                abort('Unable to verify exact legacy gate SQL')
            after=(
                c.execute("SELECT COUNT(*) FROM paper_trades").fetchone()[0],
                c.execute("SELECT COUNT(*) FROM paper_trades WHERE status IN ('open','partial')").fetchone()[0],
                float(c.execute("SELECT bankroll_xrp FROM paper_cash_state WHERE singleton_id=1").fetchone()[0])
            )
            if before!=after:abort('Gate altered PAPER trade/cash rows unexpectedly')
            c.execute('COMMIT')
            return after[1],after[0],after[2],not already
        except BaseException:
            c.execute('ROLLBACK')
            raise

def drop_gate_after_old_stopped(db_path:Path)->bool:
    """Only called after old PM2 is stopped AND new freeze sentinel exists."""
    if db_path.is_symlink() or not db_path.is_file():
        abort('Cannot disarm an unexpected database path')
    with closing(sqlite3.connect(str(db_path),timeout=8,isolation_level=None)) as c:
        c.execute('BEGIN IMMEDIATE')
        try:
            before=(
                c.execute("SELECT COUNT(*) FROM paper_trades").fetchone()[0],
                c.execute("SELECT COUNT(*) FROM paper_trades WHERE status IN ('open','partial')").fetchone()[0],
                float(c.execute("SELECT bankroll_xrp FROM paper_cash_state WHERE singleton_id=1").fetchone()[0])
            )
            if before[1]!=0:
                abort('Refuse to remove legacy gate while positions remain open')
            present=check_existing_gate(c)
            if present:
                c.execute(f'DROP TRIGGER {NAME}')
            after=(
                c.execute("SELECT COUNT(*) FROM paper_trades").fetchone()[0],
                c.execute("SELECT COUNT(*) FROM paper_trades WHERE status IN ('open','partial')").fetchone()[0],
                float(c.execute("SELECT bankroll_xrp FROM paper_cash_state WHERE singleton_id=1").fetchone()[0])
            )
            if before!=after:abort('Disarm changed trade/cash economics unexpectedly')
            if check_existing_gate(c):abort('Legacy gate remains after drop')
            c.execute('COMMIT')
            return present
        except BaseException:
            c.execute('ROLLBACK')
            raise

def online_backup(db_path:Path,active:Path)->Path:
    folder=active/'recovery-backups'
    if folder.is_symlink() or not folder.is_dir():
        abort('Expected private PAPER recovery-backups folder missing')
    need=max(100*1024*1024,db_path.stat().st_size*2)
    if shutil.disk_usage(folder).free<need:
        abort('Insufficient disk for pre-gate WAL-coherent PAPER backup')
    stamp=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    dest=folder/f'before-legacy-entry-gate-{stamp}.db'
    fd=os.open(dest,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    os.close(fd)
    try:
        with closing(ro_db(db_path)) as src:
            with closing(sqlite3.connect(dest,timeout=10)) as dst:
                src.backup(dst,pages=128,sleep=0.05)
        with closing(ro_db(dest)) as db:
            if db.execute('PRAGMA quick_check').fetchone()[0]!='ok':
                abort('Pre-gate backup SQLite integrity check failed')
            if db.execute('SELECT COUNT(*) FROM paper_trades').fetchone()[0]<1:
                abort('Pre-gate backup lacks historical PAPER trades')
        return dest
    except BaseException:
        dest.unlink(missing_ok=True)
        raise

def main()->int:
    p=argparse.ArgumentParser()
    mode=p.add_mutually_exclusive_group(required=True)
    mode.add_argument('--status',action='store_true')
    mode.add_argument('--arm',action='store_true')
    p.add_argument('--active',type=Path,default=DEFAULT_ACTIVE)
    args=p.parse_args()
    active=args.active.resolve()
    db_path=active/'data'/EPOCH_NAME
    if git_head(active)!=OLD_SHA:
        abort('Active Git SHA is not the exact reviewed legacy release: DO NOT change database')
    require_safe_runtime(pm2_process(),active,online=True)
    n,trades,cash=paper_state(db_path)
    with closing(ro_db(db_path)) as c:
        gate=check_existing_gate(c)
    print(f'Legacy PAPER: {n} open/partial, {trades} trades, {cash:.6f} XRP cash')
    print(f'Reviewed legacy INSERT entry gate: {"ARMED" if gate else "not installed"}')
    if args.status:
        print('READ-ONLY STATUS; PM2/SQLite untouched')
        return 0
    if gate:
        print('ALREADY ARMED: do not repeat / install duplicate entry triggers')
        return 0
    print('Creating WAL-coherent 0600 recovery backup BEFORE arming...')
    backup=online_backup(db_path,active)
    print('Verified recovery backup:',backup)
    n2,trades2,cash2,created=arm_gate(db_path)
    print(f'ENTRY GATE {"ARMED" if created else "ALREADY PRESENT"}: {n2} open, '
          f'{trades2} trades, {cash2:.6f} XRP cash')
    print('Existing PAPER exits continue; new INSERTs are rejected by SQLite.')
    print('Old app may log rejected-entry exceptions. Monitor PM2 health and exit updates.')
    print('Do not restart the old process or manually DROP trigger while positions exist.')
    return 0

if __name__=='__main__':
    try:raise SystemExit(main())
    except (RuntimeError,sqlite3.Error,OSError) as err:
        print('LEGACY ENTRY GATE BLOCKED:',err,file=sys.stderr)
        raise SystemExit(2)
