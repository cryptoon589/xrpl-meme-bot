#!/usr/bin/env python3
"""Hunterix vNext PAPER cutover preflight. READ-ONLY; no network, PM2 mutation,
database migration, wallet access, or Telegram messages.

--plan is usable before a new epoch or approved blacklist is created.
--strict-startup is called by the separate vNext entrypoint and refuses
startup unless the operator reviewed the exact manifest, epoch and environment.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'data'
DEFAULT_LEGACY = DATA / 'meme_bot.recovery.db'
DEFAULT_MANIFEST = ROOT / 'state/manual_token_blacklist.json'
EPOCH_RE = re.compile(r'^meme_bot[.]paper-epoch-[0-9]{8}(?:-[a-z0-9]+)?[.]db$')
ISSUER_RE = re.compile(r'^r[1-9A-HJ-NP-Za-km-z]{24,34}$')


def conn_ro(path):
    if not path.is_file() or path.is_symlink():
        raise ValueError('missing regular SQLite database: ' + str(path))
    c = sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True, timeout=8)
    c.execute('PRAGMA query_only=ON')
    return c


def count(c, name):
    if name not in {'paper_trades', 'tokens', 'paper_cash_state', 'paper_epoch_metadata', 'paper_inventory'}:
        raise ValueError('unexpected table')
    has = c.execute(
        'SELECT 1 FROM sqlite_master WHERE type="table" AND name=?', (name,)
    ).fetchone()
    return c.execute('SELECT COUNT(*) FROM ' + name).fetchone()[0] if has else None


def read_manifest(path):
    if not path.is_file() or path.is_symlink():
        raise ValueError('operator blacklist manifest missing/not regular (no automatic substitute)')
    raw = path.read_bytes()
    value = json.loads(raw)
    if not isinstance(value, dict) or value.get('format') != 'hunterix-manual-blacklist-v1' or \
       value.get('managedBy') != 'operator' or not isinstance(value.get('tokens'), list):
        raise ValueError('operator blacklist schema invalid')
    if len(value['tokens']) > 5000:
        raise ValueError('operator blacklist too large')
    seen = set()
    for entry in value['tokens']:
        if not isinstance(entry,dict) or not isinstance(entry.get('currency'),str) or \
           not (1 <= len(entry['currency'].strip()) <= 100):
            raise ValueError('invalid manual blacklist token entry')
        cur = entry['currency'].strip()
        issuer = entry.get('issuer')
        if issuer is not None and (not isinstance(issuer,str) or not ISSUER_RE.fullmatch(issuer)):
            raise ValueError('invalid issuer in operator blacklist')
        reason=entry.get('reason')
        if reason is not None and (not isinstance(reason,str) or len(reason)>300):
            raise ValueError('invalid reason in operator blacklist')
        key=(cur.upper(),issuer or '')
        if key in seen:
            raise ValueError('duplicate operator blacklist entry')
        seen.add(key)
    return len(value['tokens']),hashlib.sha256(raw).hexdigest()


def legacy_state(path):
    with conn_ro(path) as db:
        if db.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
            raise ValueError('legacy recovery database quick_check failed')
        if count(db, 'paper_trades') is None:
            raise ValueError('legacy paper_trades table missing')
        rows=db.execute(
            "SELECT token_currency, token_issuer, status, remaining_position "
            "FROM paper_trades WHERE status IN ('open','partial') ORDER BY id"
        ).fetchall()
        return count(db,'paper_trades'),rows


def epoch_state(path, expected_legacy):
    if path.parent.resolve() != DATA.resolve() or not EPOCH_RE.fullmatch(path.name):
        raise ValueError('epoch must be a named data/meme_bot.paper-epoch-YYYYMMDD[-tag].db')
    with conn_ro(path) as db:
        if db.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
            raise ValueError('epoch database quick_check failed')
        cash = db.execute('SELECT bankroll_xrp FROM paper_cash_state WHERE singleton_id=1').fetchone()
        if cash is None or not isinstance(cash[0],float) and not isinstance(cash[0],int) or cash[0] <= 0:
            raise ValueError('epoch starting cash missing or invalid')
        meta=db.execute(
            'SELECT epoch_id, source_name, excluded_legacy_positions '
            'FROM paper_epoch_metadata LIMIT 1'
        ).fetchone()
        if meta is None or meta[0] != path.stem or meta[1] != expected_legacy.name:
            raise ValueError('epoch metadata does not match intended source')
        n=count(db,'paper_trades')
        if n:
            # A restart of an already-running PAPER epoch MUST preserve valid
            # existing positions; do not require trade history to be empty.
            # However, an existing open/partial row without persisted inventory
            # means restart recovery is unverified and must be stopped.
            if count(db,'paper_inventory') is None:
                raise ValueError('epoch has trades but no persistent inventory table')
            missing=db.execute('''
                SELECT COUNT(*) FROM paper_trades pt
                LEFT JOIN paper_inventory pi ON pi.trade_id = pt.id
                WHERE pt.status IN ('open','partial') AND pi.trade_id IS NULL
            ''').fetchone()[0]
            if missing:
                raise ValueError('unreconciled active PAPER position inventory: '+str(missing))
        return cash[0],count(db,'tokens'),meta[2],n or 0


def check_runtime(epoch, manifest, legacy, digest):
    expected_db=str(epoch.resolve())
    expected_id=epoch.stem
    checks={
        'MODE=PAPER':os.environ.get('MODE')=='PAPER',
        'LIVE_TRADING=false':os.environ.get('LIVE_TRADING')=='false',
        'wallet seed absent':not os.environ.get('TRADING_WALLET_SEED'),
        'epoch DB exact path':os.environ.get('BOT_DB_PATH')==expected_db,
        'legacy DB explicit original path':
          os.environ.get('HUNTERIX_LEGACY_SOURCE_DB_PATH')==str(legacy.resolve()),
        'epoch ID match':os.environ.get('BOT_PAPER_EPOCH_ID')==expected_id,
        'manual blacklist exact path':
          str(Path(os.environ.get('HUNTERIX_MANUAL_BLOCKLIST_FILE','')).resolve())==str(manifest.resolve()),
        'operator-reviewed manifest hash':
          os.environ.get('HUNTERIX_OPERATOR_BLACKLIST_APPROVED_SHA256')==digest,
        'reserve-aware PAPER fills':os.environ.get('BOT_USE_RESERVE_QUOTES')=='1',
        'temporary loss guard':os.environ.get('BOT_ENABLE_LIQUIDITY_LOSS_GUARD')=='1',
        'no startup token deletion':os.environ.get('BOT_ENABLE_STARTUP_PRUNE')=='0',
        'observation retention':os.environ.get('BOT_ENABLE_OBSERVATION_RETENTION')=='1',
        'disk guard':os.environ.get('BOT_ENABLE_RECOVERY_DISK_GUARD')=='1',
        'separate XRPL stream':os.environ.get('XRPL_SEPARATE_STREAM')=='1',
        'unvalidated learning disabled':os.environ.get('BOT_ENABLE_VALIDATED_LEARNING')!='1',
    }
    for label, passed in checks.items():
        print(('PASS' if passed else 'FAIL')+' runtime: '+label)
    if not all(checks.values()):
        raise ValueError('unsafe PAPER runtime configuration; refusing startup')
    # Conservative: never start vNext in parallel with the old executing PAPER
    # process, or both may scan and create independent token trades.
    try:
        result=subprocess.run(['pm2','jlist'],text=True,capture_output=True,timeout=10)
        if result.returncode: raise ValueError('pm2 status unavailable')
        jobs=json.loads(result.stdout)
        online=[j for j in jobs if j.get('name')=='hunterix-paper'
                and j.get('pm2_env',{}).get('status')=='online']
        if online: raise ValueError('old hunterix-paper is still ONLINE: stop it only during reviewed cutover')
    except (FileNotFoundError,subprocess.TimeoutExpired,ValueError,json.JSONDecodeError) as exc:
        raise ValueError('cannot verify PM2 exclusivity: '+str(exc)) from exc
    if not (ROOT/'dist/index.js').is_file():
        raise ValueError('compiled bot dist/index.js missing')
    stats=os.statvfs(DATA)
    if stats.f_bavail*stats.f_frsize < 700*1024*1024:
        raise ValueError('less than 700 MiB free disk')


def main():
    p=argparse.ArgumentParser()
    p.add_argument('--epoch',type=Path,required=True)
    p.add_argument('--legacy',type=Path,default=DEFAULT_LEGACY)
    p.add_argument('--manifest',type=Path,default=DEFAULT_MANIFEST)
    p.add_argument('--strict-startup',action='store_true')
    p.add_argument('--initial-cutover',action='store_true',
                   help='require no trades in new epoch before first deployment')
    args=p.parse_args()
    epoch=args.epoch.expanduser().resolve()
    manifest=args.manifest.expanduser().resolve()
    legacy=args.legacy.expanduser().resolve()
    print('HUNTERIX vNext PAPER PREFLIGHT — READ ONLY')
    print('Legacy source:',legacy)
    print('New epoch:',epoch)
    print('Blacklist manifest:',manifest)
    passed=True
    try:
        trades,positions=legacy_state(legacy)
        print('Legacy saved trade rows:',trades,'| unresolved positions:',len(positions))
        for currency,issuer,status,remaining in positions[:30]:
            print('  LEGACY UNSOLD: %s issuer=%s... status=%s remaining=%s%%' %
                  (currency,str(issuer)[:11],status,remaining))
        if positions: print('Old PAPER positions remain legacy-only; never migrated or assumed sold.')
    except (ValueError,sqlite3.Error) as ex:
        print('NOT READY: legacy verification:',ex)
        passed=False
        positions=None
    try:
        entries,digest=read_manifest(manifest)
        print('Operator-only manual exclusions:',entries)
        print('Manifest SHA256 (to approve after reviewing exact entries):',digest)
    except (ValueError, OSError, json.JSONDecodeError) as ex:
        print('NOT READY: operator manual blacklist:',ex)
        passed=False
        digest=None
    try:
        cash,tokens,excluded,trades_so_far=epoch_state(epoch,legacy)
        print('Spendable PAPER cash checkpoint:',cash,'XRP | catalog tokens:',tokens)
        print('New epoch trade records:',trades_so_far)
        if args.initial_cutover and trades_so_far != 0:
            print('NOT READY: initial cutover requires zero prior epoch trades')
            passed=False
        print('Epoch metadata recorded legacy unresolved positions:',excluded)
        if positions is not None and len(positions)!=excluded:
            print('REVIEW: legacy open-position count changed since epoch creation.')
            if args.initial_cutover: passed=False
    except (ValueError,OSError,sqlite3.Error) as ex:
        print('NOT READY: clean PAPER epoch:',ex)
        passed=False
    if args.strict_startup and legacy.resolve() == (ROOT/'data/meme_bot.recovery.db').resolve():
        # For an isolated vNext worktree the reviewed legacy source must be
        # outside the staging folder; never silently use a copied DB.
        print('NOT READY: release must reference original legacy DB outside staging directory')
        passed=False
    if args.strict_startup and passed:
        try: check_runtime(epoch,manifest,legacy,digest)
        except (ValueError,OSError) as ex:
            print('NOT READY: runtime:',ex)
            passed=False
    if passed:
        print('PASS: read-only eligibility checks. This does NOT start, switch or certify trading.')
    else:
        print('NOT READY: release blocked; old bot and all databases unchanged.')
    return 0 if passed else 2


if __name__=='__main__':
    sys.exit(main())
