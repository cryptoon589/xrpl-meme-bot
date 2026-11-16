#!/usr/bin/env python3
"""Read-only ledger of unresolved LEGACY PAPER positions.

Reads compact recovery DB via SQLite mode=ro, never original 18 GiB DB,
and never supplies fake current prices or zero-cost cash refunds.
"""
import argparse
from datetime import datetime,timezone
from pathlib import Path
import sqlite3
import sys

ROOT=Path(__file__).resolve().parents[1]
DB=ROOT/'data/meme_bot.recovery.db'

def fmt_date(ts):
    try:
        return datetime.fromtimestamp(float(ts)/1000,timezone.utc).strftime('%Y-%m-%d %H:%M UTC')
    except (ValueError,TypeError,OverflowError,OSError):
        return 'unknown'

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--db',type=Path,default=DB)
    args=parser.parse_args()
    path=args.db.expanduser().resolve()
    if not path.is_file() or path.name == 'meme_bot.db':
        raise SystemExit('Refusing missing or original 18GiB database')
    conn=sqlite3.connect(path.as_uri()+'?mode=ro',uri=True,timeout=8)
    try:
        conn.row_factory=sqlite3.Row
        conn.execute('PRAGMA query_only=ON')
        rows=conn.execute("""
            SELECT id, token_currency, token_issuer, status,
                entry_timestamp, entry_amount_xrp,
                remaining_position, xrp_returned, fees_paid
            FROM paper_trades
            WHERE status IN ('open','partial')
            ORDER BY id
        """).fetchall()
        print('HUNTERIX LEGACY PAPER UNSOLD POSITIONS (READ-ONLY)')
        print('Archive DB:',path)
        print('Unresolved positions:',len(rows))
        for r in rows:
            print('id=%s token=%s issuer=%s status=%s entry=%s principal=%.4f XRP remaining=%.1f%% prior_proceeds=%.4f XRP' % (
                r['id'],r['token_currency'],r['token_issuer'],
                r['status'],fmt_date(r['entry_timestamp']),
                r['entry_amount_xrp'] or 0,r['remaining_position'] or 0,
                r['xrp_returned'] or 0
            ))
        print('These are historical PAPER positions, NOT real XRPL wallet assets.')
        print('No current-price, sellable XRP, equity or bank balance is inferred.')
        print('The clean vNext epoch does not import, refund, or silently close them.')
    finally:
        conn.close()

if __name__=='__main__':
    main()
