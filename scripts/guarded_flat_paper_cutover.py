#!/usr/bin/env python3
"""Single-shot, fail-closed HUNTERIX vNext PAPER release switch.

Only deploys when the old bot's PAPER portfolio is *flat*. The old release
cannot reliably restore historical trailing highs, so restarting PM2 while
it has open or partial positions is unsafe.

To close the race where the old bot can open a trade between a read-only
flat-book check and a PM2 stop, this script obtains a short-lived SQLite WAL
BEGIN IMMEDIATE writer lock, checks the book, and invokes PM2 stop while
holding the lock. No new entry can commit before stop. It then releases the
lock, creates a coherent online SQLite backup, installs a pinned code commit,
and boots the NEW release with its entry-freeze sentinel already present.

NEVER runs in LIVE mode, deletes positions, copies a wallet seed, or modifies
the four-token manual blacklist. Never unfreezes entries automatically.

The script uses the current working repository paths explicitly; it is not a
background watcher. --status is read only. --deploy-if-flat may change PM2
and code ONLY when flat and all preconditions succeed.
"""
from __future__ import annotations
import argparse
from contextlib import closing
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request

OLD_SHA = '6c5d4d0c6c10c1da1608be90ce2725ee71e5645f'
MIN_TESTED_SHA = 'f41766589db940c257357eb403bff1f29b7f16b9'
STRATEGY_V2_MIN_SHA = 'fd2c296031a7f9f6a91024490f02c8c261ba589c'
PM2_NAME = 'hunterix-vnext-paper'
EPOCH_NAME = 'meme_bot.paper-epoch-20261116-vnext.db'
PORT = 3000

def abort(message: str) -> None:
    raise RuntimeError(message)

def cmd(args: list[str], *, cwd: Path | None = None, timeout: int = 90) -> str:
    r=subprocess.run(args, cwd=str(cwd) if cwd else None,
                     text=True, capture_output=True, timeout=timeout)
    if r.returncode:
        abort(f"Command failed ({' '.join(args[:3])}): "+
              (r.stderr or r.stdout)[-1600:])
    return r.stdout

def git_head(repo: Path) -> str:
    return cmd(['git','rev-parse','HEAD'],cwd=repo).strip()

def pm2_process() -> dict:
    processes=json.loads(cmd(['pm2','jlist'],timeout=15))
    matches=[p for p in processes if p.get('name')==PM2_NAME]
    if len(matches)!=1:
        abort(f"Exactly one {PM2_NAME} required, found {len(matches)}")
    if any(p.get('name')=='hunterix-paper' and
           p.get('pm2_env',{}).get('status')=='online'
           for p in processes):
        abort('Legacy hunterix-paper is also online; refuse dual bot cutover')
    return matches[0]

def require_safe_runtime(p: dict, active: Path, *, online: bool) -> None:
    e=p.get('pm2_env') or {}
    expected='online' if online else 'stopped'
    if e.get('status')!=expected:
        abort(f"PM2 {PM2_NAME} must be {expected}, got {e.get('status')}")
    if e.get('MODE')!='PAPER' or str(e.get('LIVE_TRADING'))!='false':
        abort('PM2 mode is not verified PAPER-only')
    if e.get('TRADING_WALLET_SEED'):
        abort('PM2 wallet seed present, refusing to operate')
    if str(e.get('BOT_PAPER_MEME_ONLY'))!='1':
        abort('PAPER meme-only restriction missing')
    if str(e.get('BOT_PAPER_MEME_DISCOVERY'))!='1':
        abort('Dynamic meme discovery not enabled')
    if Path(e.get('pm_cwd','')).resolve()!=active.resolve():
        abort('PM2 process is not running from expected active root')
    if Path(e.get('BOT_DB_PATH','')).resolve()!=(active/'data'/EPOCH_NAME).resolve():
        abort('PM2 uses a different PAPER epoch DB')
    if e.get('HUNTERIX_MANUAL_BLOCKLIST_FILE') != str(active/'state'/'manual_token_blacklist.json'):
        abort('Unexpected manual blacklist manifest location')
    if e.get('HUNTERIX_MEME_ENTRY_ALLOWLIST_FILE') != str(active/'state'/'paper_meme_entry_allowlist.json'):
        abort('Unexpected meme operator allowlist location')

def ro_db(db_path:Path):
    if not db_path.is_file() or db_path.is_symlink():
        abort('Expected regular PAPER epoch SQLite DB is missing')
    con=sqlite3.connect(db_path.resolve().as_uri()+'?mode=ro',
                        uri=True,timeout=6)
    con.execute('PRAGMA query_only=ON')
    return con

def paper_state(db_path: Path) -> tuple[int,int,float]:
    with closing(ro_db(db_path)) as c:
        if c.execute('PRAGMA quick_check').fetchone()[0]!='ok':
            abort('PAPER database quick_check failed')
        positions=int(c.execute(
            "SELECT COUNT(*) FROM paper_trades WHERE status IN ('open','partial')"
        ).fetchone()[0])
        trades=int(c.execute('SELECT COUNT(*) FROM paper_trades').fetchone()[0])
        cashrow=c.execute(
            'SELECT bankroll_xrp FROM paper_cash_state WHERE singleton_id=1'
        ).fetchone()
        if cashrow is None or cashrow[0] is None or float(cashrow[0])<0:
            abort('PAPER cash checkpoint missing/invalid')
        return positions,trades,float(cashrow[0])

def verify_repositories(active:Path,review:Path,release:str) -> None:
    if not active.is_dir() or not review.is_dir() or active.resolve()==review.resolve():
        abort('Distinct existing active and review Git checkouts required')
    if git_head(active)!=OLD_SHA:
        abort('Active release SHA differs from reviewed old bot; no automatic switch')
    if git_head(review)!=release:
        abort('Review worktree is not at pinned target release SHA')
    if cmd(['git','status','--porcelain','--untracked-files=no'],cwd=active).strip():
        abort('Active checkout contains local tracked changes, refusing merge')
    if cmd(['git','status','--porcelain','--untracked-files=no'],cwd=review).strip():
        abort('Review checkout contains local tracked changes')
    cmd(['git','cat-file','-e',release+'^{commit}'],cwd=active)
    cmd(['git','merge-base','--is-ancestor',OLD_SHA,release],cwd=active)
    cmd(['git','merge-base','--is-ancestor',MIN_TESTED_SHA,release],cwd=active)
    cmd(['git','merge-base','--is-ancestor',STRATEGY_V2_MIN_SHA,release],cwd=active)

def acquire_stop_if_flat(db_path:Path) -> bool:
    """Prevent new SQLite trade commits between flat check and PM2 stop."""
    with closing(sqlite3.connect(str(db_path),timeout=8,isolation_level=None)) as c:
        c.execute('PRAGMA busy_timeout=8000')
        c.execute('BEGIN IMMEDIATE')
        try:
            n=c.execute(
                "SELECT COUNT(*) FROM paper_trades WHERE status IN ('open','partial')"
            ).fetchone()[0]
            if n:
                print(f"BLOCK: {n} PAPER positions remain; PM2 untouched")
                return False
            print('PASS: flat book held under SQLite writer lock; stopping old PM2 without an entry race')
            cmd(['pm2','stop',PM2_NAME],timeout=50)
            p=pm2_process()
            if p.get('pm2_env',{}).get('status')!='stopped':
                abort('PM2 did not reach stopped state; release not installed')
            n2=c.execute(
                "SELECT COUNT(*) FROM paper_trades WHERE status IN ('open','partial')"
            ).fetchone()[0]
            if n2:
                abort('PAPER book unexpectedly changed while writer lock held')
            return True
        finally:
            c.execute('ROLLBACK')

def coherent_backup(db_path:Path, active:Path) -> Path:
    folder=active/'recovery-backups'
    if not folder.is_dir() or folder.is_symlink():
        abort('Expected recovery-backups directory missing/unsafe')
    need=max(100*1024*1024,db_path.stat().st_size*2)
    if shutil.disk_usage(folder).free<need:
        abort('Insufficient disk free for coherent PAPER cutover backup')
    stamp=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    dst=folder/('before-exit-only-cutover-'+stamp+'.db')
    fd=os.open(dst,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    os.close(fd)
    try:
        with closing(ro_db(db_path)) as src:
            with closing(sqlite3.connect(dst,timeout=10)) as target:
                src.backup(target,pages=128,sleep=0.05)
        if paper_state(dst)!=paper_state(db_path):
            abort('PAPER backup cash/trades/positions differ from source')
        print('PASS: coherent SQLite backup:',dst)
        return dst
    except Exception:
        dst.unlink(missing_ok=True)
        raise

def verify_health(timeout_seconds:int=95):
    deadline=time.monotonic()+timeout_seconds
    last='not yet listening'
    while time.monotonic()<deadline:
        try:
            with urllib.request.urlopen(
                f'http://127.0.0.1:{PORT}/health',timeout=3
            ) as res:
                status=json.load(res)
            if (status.get('status')=='ok' and
                status.get('positions')==0 and
                status.get('paperEntryFrozen') is True and
                status.get('paperStreamShadowOnly') is True and
                status.get('xrplConnected') is True and
                status.get('xrplStreamConnected') is True):
                return status
            last=f"health not ready (status={status.get('status')}, frozen={status.get('paperEntryFrozen')}, v2_stream_shadow={status.get('paperStreamShadowOnly')}, positions={status.get('positions')})"
        except (urllib.error.URLError,TimeoutError,ValueError,ConnectionError) as ex:
            last=str(ex)
        time.sleep(2)
    abort('New release did not pass frozen/flat/healthy checks: '+last+
          '. Leave entry-freeze sentinel in place and inspect PM2 logs.')

def main() -> int:
    ap=argparse.ArgumentParser()
    mode=ap.add_mutually_exclusive_group(required=True)
    mode.add_argument('--status',action='store_true')
    mode.add_argument('--deploy-if-flat',action='store_true')
    ap.add_argument('--pin',required=True,help='Full 40-hex CI-passed release commit (no implicit latest)')
    ap.add_argument('--active',type=Path,default=Path('/root/hunterix-vnext-stage-20261116'))
    ap.add_argument('--review',type=Path,default=Path('/root/hunterix-dynamic-meme-review-20261121'))
    args=ap.parse_args()
    active=args.active.resolve()
    review=args.review.resolve()
    release=args.pin.lower()
    if len(release)!=40 or any(c not in '0123456789abcdef' for c in release):
        abort('--pin must be the exact full 40-character commit SHA')
    db_path=active/'data'/EPOCH_NAME

    verify_repositories(active,review,release)
    p=pm2_process()
    require_safe_runtime(p,active,online=True)
    n,trades,cash=paper_state(db_path)
    print(f"Active PAPER: {n} open/partial, {trades} recorded trades, {cash:.6f} XRP cash")
    if n:
        print('BLOCK: Do not restart old release; its open positions have no provable trailing-high checkpoint.')
        return 0 if args.status else 2
    if args.status:
        print('READY: book is currently flat. This is NOT an atomic deployment authorization.')
        return 0

    print('Checking staged build and release fixtures before cutover...')
    cmd(['npm','run','build'],cwd=review,timeout=90)
    for test in ('test_paper_exit_only_restart.js','test_verified_project_issuers.js',
                 'test_dynamic_paper_performance.py','test_paper_stream_shadow_v2.js',
                 'test_paper_stream_shadow_report.py'):
        if test.endswith('.py'):
            cmd(['python3','scripts/'+test],cwd=review,timeout=60)
        else:
            cmd(['node','scripts/'+test],cwd=review,timeout=60)
    if not acquire_stop_if_flat(db_path):
        return 2

    # Failures after PM2 stops leave it stopped rather than silently
    # resume an older release without verified trailing-stop checkpoints.
    try:
        require_safe_runtime(pm2_process(),active,online=False)
        if paper_state(db_path)[0]:
            abort('PAPER position appeared after old bot stopped: manual recovery required')
        coherent_backup(db_path,active)
        sentinel=active/'state'/'paper-entry-freeze.flag'
        if sentinel.is_symlink() or not sentinel.parent.is_dir():
            abort('Unsafe PAPER entry-freeze sentinel directory')
        try:
            fd=os.open(sentinel,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
            with os.fdopen(fd,'w') as out:
                out.write('Operator cutover: all new PAPER entries frozen until explicitly resumed.\n')
                out.flush()
                os.fsync(out.fileno())
        except FileExistsError:
            if not sentinel.is_file():abort('Existing freeze sentinel not regular file')
        print('PASS: exit-only freeze sentinel active for new release')
        cmd(['git','merge','--ff-only',release],cwd=active)
        if git_head(active)!=release:
            abort('Code pin failed after fast-forward')
        cmd(['npm','run','build'],cwd=active,timeout=100)
        cmd(['python3','scripts/check_paper_restart_safety.py',
             '--db',str(db_path)],cwd=active,timeout=30)
        if paper_state(db_path)[0]:
            abort('Book is not flat before new PM2 start')
        # The old process may have been armed with an emergency SQLITE
        # BEFORE INSERT gate without restarting. It must NOT survive the new
        # release: new code now enforces a durable ENTRY-FROZEN sentinel and
        # Strategy V2 shadow-only policy at TDE / PaperTrader boundaries.
        # Only remove our exact reviewed trigger, only after old PM2 stopped,
        # private online backup exists, the new release code/build is verified,
        # restart preflight passed and exit-only sentinel is already present.
        from arm_legacy_paper_entry_gate import drop_gate_after_old_stopped
        if drop_gate_after_old_stopped(db_path):
            print('PASS: reviewed legacy SQLite INSERT gate removed under stopped PM2; new freeze sentinel remains')
        cmd(['pm2','restart',PM2_NAME],timeout=30)
        require_safe_runtime(pm2_process(),active,online=True)
        health=verify_health()
        if git_head(active)!=release or paper_state(db_path)[0]:
            abort('Release or PAPER account changed during health check')
        cmd(['pm2','save'],timeout=20)
        print('PASS: NEW PAPER release online, healthy, FLAT, ENTRY-FROZEN and STREAM-SHADOW-ONLY')
        print('Deployed:',release)
        print('Health uptime:',health.get('uptime'))
        print('No PAPER entries have been resumed; explicit operator review required.')
        return 0
    except Exception:
        print('RELEASE SWITCH INCOMPLETE: leave entry freeze in place; do not unfreeze/restart blindly.',
              file=sys.stderr)
        raise

if __name__=='__main__':
    try:raise SystemExit(main())
    except Exception as error:
        print('CUTOVER BLOCKED:',error,file=sys.stderr)
        raise SystemExit(2)
