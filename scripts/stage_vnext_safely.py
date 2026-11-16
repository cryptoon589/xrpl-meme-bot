#!/usr/bin/env python3
"""Hunterix vNext one-time stage safety, run from an ISOLATED checkout.

Does NOT start/stop PM2, alter the old checkout, trade, copy wallet/env secrets,
create a new PAPER epoch, merge git, or use the old historical 18 GiB database.

- Only source read: old-root/data/meme_bot.recovery.db in SQLite URI mode=ro.
- Destination: NEW staging-root/data/meme_bot.recovery.db, SQLite online backup
  that captures active WAL correctly (never plain cp of a live SQLite file).
- Never overwrite an existing backup, never touch source database contents.
- Print stage catalogue/legacy unsold positions and manifest SHA256 for review.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import time

ROOT=Path(__file__).resolve().parents[1]
DEFAULT_OLD=Path('/root/xrpl-meme-bot')
MAX_COMPACT_BYTES=2*1024**3
MIN_FREE=3*1024**3

def fail(reason):
    raise RuntimeError(reason)

def ro_db(p):
    if p.is_symlink() or not p.is_file():
        fail('Expected original regular compact recovery DB missing: '+str(p))
    if p.stat().st_size > MAX_COMPACT_BYTES:
        fail('Recovery DB unexpectedly >2 GiB; refusing to touch historic giant database')
    c=sqlite3.connect(p.resolve().as_uri()+'?mode=ro',uri=True,timeout=12)
    c.row_factory=sqlite3.Row
    c.execute('PRAGMA query_only=ON')
    return c

def count(db,table):
    if table not in ('paper_trades','tokens','paper_inventory'):fail('unknown table')
    if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",(table,)).fetchone():
        return None
    return db.execute('SELECT COUNT(*) FROM '+table).fetchone()[0]

def assert_source_healthy(db):
    if db.execute('PRAGMA quick_check').fetchone()[0]!='ok':
        fail('Source compact SQLite integrity check not ok')
    for name in ('tokens','paper_trades'):
        if count(db,name) is None:fail('Required recovery table missing: '+name)
    return count(db,'paper_trades'),count(db,'tokens')

def positions(db):
    return db.execute("""
        SELECT id, token_currency, token_issuer, status, remaining_position
        FROM paper_trades WHERE status IN ('open','partial') ORDER BY id
    """).fetchall()

def check_manifest():
    p=ROOT/'state/manual_token_blacklist.json'
    if p.is_symlink() or not p.is_file():fail('Missing reviewed manual blacklist')
    raw=p.read_bytes()
    doc=json.loads(raw)
    if doc.get('format')!='hunterix-manual-blacklist-v1' or \
       doc.get('managedBy')!='operator':
        fail('Invalid operator manifest schema')
    names=[x.get('currency') for x in doc.get('tokens',[])]
    if len(names)!=4 or set(names)!={'OCT','SHX','MXI','CORE'} or len(names)!=len(set(names)):
        fail('Blacklisted tokens must be exactly user-approved OCT SHX MXI CORE')
    if any(e.get('issuer') for e in doc['tokens']):
        fail('No issuer-specific permanent bans were user-approved')
    print('Manual permanent blacklist:',', '.join(names))
    print('Manual manifest SHA256:',hashlib.sha256(raw).hexdigest())

def check_pm2():
    try:
        r=subprocess.run(['pm2','jlist'],capture_output=True,text=True,timeout=12)
        if r.returncode:fail('pm2 jlist failed')
        jobs=json.loads(r.stdout)
        for name in ('hunterix-paper','hunterix-vnext-paper'):
            matches=[x.get('pm2_env',{}).get('status','unknown')
                     for x in jobs if x.get('name')==name]
            print('PM2 '+name+':',','.join(matches) if matches else 'not registered')
        if any(x.get('name')=='hunterix-vnext-paper' and
                x.get('pm2_env',{}).get('status')=='online' for x in jobs):
            fail('vNext already running; stage-only checks should NOT run against active vNext')
    except (FileNotFoundError,subprocess.TimeoutExpired,json.JSONDecodeError) as ex:
        fail('Cannot verify existing PM2 processes: '+str(ex))

def safe_backup(source, target):
    # source is already opened mode=ro by caller. SQLite backup is WAL-safe
    # and copies a coherent page snapshot while old PAPER continues running.
    if target.exists() or target.is_symlink():
        fail('A prior stage backup already exists (never overwrite): '+str(target))
    if target.parent.is_symlink():fail('Staging data folder may not be symlink')
    target.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
    temp=target.with_name(target.name+'.partial-'+str(os.getpid()))
    fd=os.open(temp,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
    os.close(fd)
    try:
        with sqlite3.connect(temp,timeout=12) as dest:
            source.backup(dest,pages=128,sleep=0.15)
            if dest.execute('PRAGMA quick_check').fetchone()[0]!='ok':
                fail('Staged recovery copy integrity check failed')
        # os.link fails if destination exists: atomic no-overwrite publish.
        os.link(temp,target)
        os.unlink(temp)
    finally:
        if temp.exists():temp.unlink()

def main():
    a=argparse.ArgumentParser()
    a.add_argument('--old-root',type=Path,default=DEFAULT_OLD)
    args=a.parse_args()
    old=args.old_root.expanduser().resolve()
    if ROOT==old:fail('Run ONLY from independent staging checkout')
    if not (ROOT/'.git').exists() and not (ROOT/'.git').is_file():
        fail('Staging checkout missing .git')
    if (ROOT/'data').is_symlink() or old.is_symlink():
        fail('Symlinked checkout/data rejected')
    # Verify both workspaces are distinct paths before reading any DB.
    if str(ROOT).startswith(str(old)+os.sep):
        fail('Staging checkout must not live inside original checkout')
    disk=os.statvfs(ROOT)
    free=disk.f_bavail*disk.f_frsize
    if free<MIN_FREE:fail('Need >=3 GiB free to stage safely')
    print('HUNTERIX vNext SAFE STAGING — NO PM2/OLD-DB WRITES')
    print('Original checkout:',old)
    print('Independent stage:',ROOT)
    print('Free disk GiB:',round(free/1024**3,2))
    check_manifest()
    check_pm2()
    original=old/'data/meme_bot.recovery.db'
    dst=ROOT/'data/meme_bot.recovery.db'
    with ro_db(original) as src:
        n,t=assert_source_healthy(src)
        before=positions(src)
        print('Original compact DB:',n,'PAPER trade records,',t,'token records')
        print('Original unresolved positions at snapshot:',len(before))
        for r in before:
            print('  legacy id=%s %s issuer=%s… status=%s remaining=%s%%' %
                  (r['id'],r['token_currency'],str(r['token_issuer'])[:12],
                   r['status'],r['remaining_position']))
        print('Creating NEW coherent SQLite backup in isolated stage (source remains read-only).')
        safe_backup(src,dst)
    with ro_db(dst) as copy:
        cn,ct=assert_source_healthy(copy)
        saved=positions(copy)
        if cn!=n or ct!=t or len(saved)!=len(before):
            fail('Staged snapshot counts differ from source snapshot; REVIEW before using')
        print('PASS staged compact recovery copy:',cn,'trades,',ct,'tokens,',len(saved),'legacy positions')
    print('PREPARATION COMPLETE. Did NOT create clean epoch or install dependencies.')
    print('Did NOT start/restart/stop PM2, send Telegram, trade, or modify original DB.')
    print('Next: build in staging, read-only ARMY pricing on configured endpoint, then review cutover.')
if __name__=='__main__':
    try:main()
    except Exception as ex:
        print('STAGE BLOCKED:',str(ex),file=sys.stderr)
        sys.exit(2)
