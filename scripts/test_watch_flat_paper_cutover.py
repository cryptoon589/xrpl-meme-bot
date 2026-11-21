#!/usr/bin/env python3
"""Offline bounded observer regression: never invokes cutover while nonflat."""
import io
import sqlite3
import tempfile
from pathlib import Path
from contextlib import redirect_stdout
from watch_flat_paper_cutover import observe_then_invoke, positions_ro

def make_db(path):
    with sqlite3.connect(path) as db:
        db.execute('CREATE TABLE paper_trades(id INTEGER PRIMARY KEY,token_currency TEXT,status TEXT)')
        db.execute("INSERT INTO paper_trades VALUES(24,'PHNIX','open')")
        db.execute("INSERT INTO paper_trades VALUES(27,'SLT','open')")

def test():
    with tempfile.TemporaryDirectory() as d:
        dbpath=Path(d)/'epoch.db'
        make_db(dbpath)
        assert [row[0] for row in positions_ro(dbpath)]==[24,27]
        now=[0.0]
        calls=[]
        def clock():return now[0]
        def sleep(seconds):now[0]+=seconds
        def deploy():
            calls.append('DEPLOY')
            return 0
        def current():return positions_ro(dbpath)
        with redirect_stdout(io.StringIO()) as output:
            result=observe_then_invoke(
                current,deploy,clock,sleep,
                timeout_seconds=5.0,interval_seconds=1.0)
        assert result==3 and calls==[],(result,calls)
        assert 'positions remain; PM2 and database untouched' in output.getvalue()
        assert [row[0] for row in positions_ro(dbpath)]==[24,27]

        # Allow an exit transition between polls; never force-close anything.
        now[0]=0
        def exit_without_bot_calls(seconds):
            sleep(seconds)
            if now[0]>=2.0:
                with sqlite3.connect(dbpath) as db:
                    db.execute("UPDATE paper_trades SET status='closed' WHERE id IN (24,27)")
        calls.clear()
        with redirect_stdout(io.StringIO()) as output:
            result=observe_then_invoke(
                current,deploy,clock,exit_without_bot_calls,
                timeout_seconds=10,interval_seconds=1)
        assert result==0 and calls==['DEPLOY'],(result,calls)
        assert 'appears FLAT' in output.getvalue()

        # A one-shot cutover failure is propagated and never retried.
        calls.clear()
        def failed():calls.append('BLOCKED');return 2
        result=observe_then_invoke(
            current,failed,clock,sleep,
            timeout_seconds=10,interval_seconds=1)
        assert result==2 and calls==['BLOCKED']
        print('PASS bounded foreground watcher: never invokes PM2 cutover with open trades, deploys once only on flat, propagates failure without retries')

if __name__=='__main__':test()
