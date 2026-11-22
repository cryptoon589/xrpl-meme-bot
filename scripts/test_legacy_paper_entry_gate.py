#!/usr/bin/env python3
"""Synthetic SQLite regression for reversible legacy PAPER insert-only gate."""
import sqlite3
import tempfile
from pathlib import Path
from contextlib import closing

from arm_legacy_paper_entry_gate import (
    NAME,MESSAGE,SQL,arm_gate,check_existing_gate,
    drop_gate_after_old_stopped,online_backup,verify_gate_sql
)

def run():
    with tempfile.TemporaryDirectory() as d:
        active=Path(d)
        (active/'recovery-backups').mkdir()
        path=active/'paper.db'
        with sqlite3.connect(path) as db:
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('CREATE TABLE paper_trades(id INTEGER PRIMARY KEY,status TEXT,token_currency TEXT)')
            db.execute('CREATE TABLE paper_cash_state(singleton_id INTEGER PRIMARY KEY,bankroll_xrp REAL)')
            db.execute('INSERT INTO paper_trades VALUES(24,?,?)',('open','PHNIX'))
            db.execute('INSERT INTO paper_trades VALUES(49,?,?)',('partial','DRO'))
            db.execute('INSERT INTO paper_cash_state VALUES(1,84.023756)')

        pre=online_backup(path,active)
        assert pre.exists() and pre.stat().st_mode&0o077==0
        with sqlite3.connect(pre) as db:
            assert db.execute("SELECT COUNT(*) FROM paper_trades").fetchone()[0]==2
        assert arm_gate(path)==(2,2,84.023756,True)
        assert arm_gate(path)==(2,2,84.023756,False),'idempotent'
        with closing(sqlite3.connect(path)) as db:
            assert check_existing_gate(db)
            try:
                db.execute("INSERT INTO paper_trades VALUES(50,'open','SHOULD_FAIL')")
            except sqlite3.IntegrityError as exc:
                assert MESSAGE in str(exc),str(exc)
            else:raise AssertionError('New PAPER INSERT was not blocked')
            assert db.execute("SELECT COUNT(*) FROM paper_trades").fetchone()[0]==2
            db.execute("UPDATE paper_trades SET status='closed' WHERE id=24")
            db.execute("UPDATE paper_cash_state SET bankroll_xrp=bankroll_xrp+0.20 WHERE singleton_id=1")
            db.commit()
            assert db.execute("SELECT status FROM paper_trades WHERE id=24").fetchone()[0]=='closed'
            assert abs(db.execute('SELECT bankroll_xrp FROM paper_cash_state').fetchone()[0]-84.223756)<1e-8
        try:drop_gate_after_old_stopped(path)
        except RuntimeError as err:
            assert 'positions remain open' in str(err)
        else:raise AssertionError('Gate removed while partial trade exists')
        with sqlite3.connect(path) as db:
            db.execute("UPDATE paper_trades SET status='closed' WHERE id=49")
        assert drop_gate_after_old_stopped(path) is True
        assert drop_gate_after_old_stopped(path) is False
        with sqlite3.connect(path) as db:
            assert not check_existing_gate(db)
            db.execute("INSERT INTO paper_trades VALUES(50,'open','NEW_RELEASE')")
            assert db.execute("SELECT COUNT(*) FROM paper_trades").fetchone()[0]==3

        # Existing trigger with same name but unreviewed body is never trusted.
        with sqlite3.connect(path) as db:
            db.execute(f"CREATE TRIGGER {NAME} BEFORE UPDATE ON paper_trades BEGIN SELECT RAISE(ABORT,'MALICIOUS'); END")
        try:arm_gate(path)
        except RuntimeError as exc:
            assert 'differs from reviewed' in str(exc),str(exc)
        else:raise AssertionError('Unknown gate body wrongly trusted')
        with sqlite3.connect(path) as db:
            assert db.execute('SELECT COUNT(*) FROM paper_trades').fetchone()[0]==3
        print('PASS legacy gate: 0600 WAL backup, only PAPER INSERT blocked, existing TP/exit UPDATE + cash work, no rows deleted, no disarm with partial, exact trigger verified, idempotent')

if __name__=='__main__':run()
