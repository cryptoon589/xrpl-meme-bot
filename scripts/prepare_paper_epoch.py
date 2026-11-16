#!/usr/bin/env python3
"""Prepare a clean, versioned PAPER accounting epoch without touching production.

DEFAULT is --plan (read-only, no files created).
--create is explicit; writes ONLY a new named destination file with O_EXCL.
Does not copy historical trades, P&L, open positions, price snapshots, or
learned recommendations. Existing PAPER databases and PM2 are untouched.

Example:
 python3 scripts/prepare_paper_epoch.py --plan \
     --output data/meme_bot.paper-epoch-20261116.db
 python3 scripts/prepare_paper_epoch.py --create \
     --output data/meme_bot.paper-epoch-20261116.db --bankroll 100
"""
import argparse
from datetime import datetime, timezone
import os
from pathlib import Path
import re
import sqlite3
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'data'
DEFAULT_SOURCE = DATA / 'meme_bot.recovery.db'
DEST_PATTERN = re.compile(r'^meme_bot\.paper-epoch-[0-9]{8}(?:-[a-z0-9]+)?\.db$')


def ro_connection(path: Path) -> sqlite3.Connection:
    # Important: mode=ro is WAL-aware. Do not use immutable=1 on active DB.
    conn = sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA query_only=ON')
    return conn


def table_exists(db, name):
    return db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone() is not None


def row_count(db, name):
    if name not in {'tokens','paper_trades','token_archive','market_snapshots','scores'}:
        raise ValueError('Table not allowlisted')
    return db.execute(f'SELECT COUNT(*) FROM {name}').fetchone()[0] if table_exists(db, name) else 0


def main():
    p = argparse.ArgumentParser(description='Read-only plan or explicitly create fresh PAPER epoch')
    group = p.add_mutually_exclusive_group()
    group.add_argument('--plan', action='store_true', help='read-only preview (default)')
    group.add_argument('--create', action='store_true', help='create new epoch file, never overwrite')
    p.add_argument('--source', type=Path, default=DEFAULT_SOURCE)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--bankroll', type=float, default=100.)
    args = p.parse_args()

    src = args.source.expanduser().resolve()
    dst = args.output.expanduser().resolve()
    if dst.parent != DATA.resolve() or not DEST_PATTERN.fullmatch(dst.name):
        raise SystemExit('Output must be a new data/meme_bot.paper-epoch-YYYYMMDD[-tag].db filename')
    if dst == src or dst.exists():
        raise SystemExit('Destination already exists (or equals source); refusing overwrite')
    if src != DEFAULT_SOURCE.resolve() and os.environ.get('HUNTERIX_TEST_SOURCE_OVERRIDE') != '1':
        raise SystemExit('Source override prohibited outside isolated tests')
    if not src.is_file():
        raise SystemExit('Source recovery DB is missing')
    if not (args.bankroll > 0 and args.bankroll <= 1000000 and float('inf') > args.bankroll):
        raise SystemExit('Invalid PAPER bankroll')
    if DATA.is_symlink():
        raise SystemExit('Data directory must not be a symlink')

    with ro_connection(src) as origin:
        if not table_exists(origin, 'tokens'):
            raise SystemExit('Source tokens table missing; cannot seed discovery')
        info = origin.execute('PRAGMA table_info(tokens)').fetchall()
        cols = {row['name'] for row in info}
        required = {'currency','issuer','first_seen','last_updated'}
        if not required.issubset(cols):
            raise SystemExit('Unexpected tokens schema; source was not modified')
        query = 'SELECT currency, issuer, first_seen, last_updated, ' + (
            'raw_currency' if 'raw_currency' in cols else 'NULL AS raw_currency') + ' FROM tokens'
        snapshot = origin.execute(query).fetchall()
        counts = {name:row_count(origin,name) for name in
                  ('tokens','paper_trades','token_archive','market_snapshots','scores')}
        unresolved = origin.execute(
            "SELECT COUNT(*) FROM paper_trades WHERE status IN ('open', 'partial')"
        ).fetchone()[0] if table_exists(origin,'paper_trades') else 0
        print('HUNTERIX CLEAN PAPER EPOCH — ' + ('CREATE' if args.create else 'READ-ONLY PLAN'))
        print('Source:',src)
        print('Destination:',dst)
        print('Starting new isolated PAPER cash: %.6f XRP' % args.bankroll)
        print('Source counts:',counts)
        print('Legacy open/partial positions preserved ONLY in source:',unresolved)
        print('Seed copied: token identities and raw currency codes only,',len(snapshot),'records')
        print('NOT copied: past trades, legacy positions, cash, ghosts, profile stats,')
        print('            scores, snapshots, risk flags, Telegram logs or learner files')
        print('No PM2 environment, wallet or Telegram configuration changes.')
        if not args.create:
            print('PLAN COMPLETE. No file or database was modified.')
            return

        # Reserve destination atomically: no accidental overwrite, no symlink race.
        DATA.mkdir(parents=True, exist_ok=True)
        fd = os.open(dst, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.close(fd)
        ok = False
        try:
            conn = sqlite3.connect(dst, timeout=10)
            try:
                with conn:
                    conn.execute('PRAGMA foreign_keys=ON')
                    conn.execute('''CREATE TABLE tokens(
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        currency TEXT NOT NULL, issuer TEXT NOT NULL,
                        first_seen INTEGER NOT NULL, last_updated INTEGER NOT NULL,
                        raw_currency TEXT,
                        UNIQUE(currency,issuer))''')
                    conn.executemany(
                        'INSERT OR IGNORE INTO tokens(currency,issuer,first_seen,last_updated,raw_currency) VALUES(?,?,?,?,?)',
                        [(r['currency'],r['issuer'],r['first_seen'],r['last_updated'],r['raw_currency'])
                         for r in snapshot])
                    conn.execute('''CREATE TABLE paper_cash_state (
                        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id=1),
                        bankroll_xrp REAL NOT NULL CHECK (bankroll_xrp>=0),
                        updated_at INTEGER NOT NULL)''')
                    conn.execute('INSERT INTO paper_cash_state VALUES(1,?,?)',(args.bankroll,int(time.time()*1000)))
                    conn.execute('''CREATE TABLE paper_epoch_metadata(
                        epoch_id TEXT PRIMARY KEY,
                        created_at INTEGER NOT NULL,
                        source_name TEXT NOT NULL,
                        seeded_tokens INTEGER NOT NULL,
                        excluded_legacy_positions INTEGER NOT NULL,
                        initial_bankroll_xrp REAL NOT NULL)''')
                    conn.execute('INSERT INTO paper_epoch_metadata VALUES(?,?,?,?,?,?)',
                        (dst.stem, int(time.time()*1000),src.name,len(snapshot),unresolved,args.bankroll))
                if conn.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
                    raise RuntimeError('New epoch DB integrity check failed')
                cash=conn.execute('SELECT bankroll_xrp FROM paper_cash_state WHERE singleton_id=1').fetchone()[0]
                if cash != args.bankroll: raise RuntimeError('Initial cash checkpoint mismatch')
                if conn.execute('SELECT count(*) FROM tokens').fetchone()[0] != len(snapshot):
                    raise RuntimeError('Catalog copy incomplete')
                ok = True
            finally:
                conn.close()
        finally:
            if not ok:
                dst.unlink(missing_ok=True)
        print('CREATED new epoch DB safely:',dst)
        print('No other database or service was modified.')
        print('NOT DEPLOYED. Review legacy positions and controlled cutover before starting a process.')


if __name__ == '__main__':
    main()
