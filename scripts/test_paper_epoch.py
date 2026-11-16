#!/usr/bin/env python3
"""Synthetic tests. Source in tempfile, only new destination in CI checkout."""
import hashlib
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'scripts/prepare_paper_epoch.py'
OUTPUT = ROOT / 'data/meme_bot.paper-epoch-20261116-ci.db'


def sh(*args):
    return subprocess.run([sys.executable,str(SCRIPT),*map(str,args)],
        cwd=ROOT, env={**os.environ,'HUNTERIX_TEST_SOURCE_OVERRIDE':'1'},
        text=True,capture_output=True)

def main():
    OUTPUT.unlink(missing_ok=True)
    with tempfile.TemporaryDirectory(prefix='hunterix-paper-epoch-') as tmp:
        source = Path(tmp)/'source.db'
        c=sqlite3.connect(source)
        c.execute('''CREATE TABLE tokens(currency TEXT NOT NULL,issuer TEXT NOT NULL,
                   first_seen INTEGER NOT NULL,last_updated INTEGER NOT NULL,
                   raw_currency TEXT, UNIQUE(currency,issuer))''')
        c.execute('''CREATE TABLE paper_trades(id INTEGER PRIMARY KEY,status TEXT)''')
        c.executemany('INSERT INTO tokens VALUES (?,?,?,?,?)',[
            ('TEST','rSyntheticOne',1234,5678,'5445535400000000000000000000000000000000'),
            ('DEGEN','rSyntheticTwo',2345,6789,'444547454E000000000000000000000000000000')])
        c.executemany('INSERT INTO paper_trades VALUES (?,?)',[(1,'closed'),(2,'partial')])
        c.commit()
        c.close()
        before=hashlib.sha256(source.read_bytes()).digest()
        plan=sh('--plan','--source',source,'--output',OUTPUT)
        assert plan.returncode==0,plan.stderr+plan.stdout
        assert 'Legacy open/partial positions preserved ONLY in source: 1' in plan.stdout
        assert not OUTPUT.exists(),'Read-only plan should not create a DB'
        created=sh('--create','--source',source,'--output',OUTPUT,'--bankroll','100')
        assert created.returncode==0,created.stderr+created.stdout
        assert OUTPUT.is_file()
        out=sqlite3.connect(OUTPUT)
        try:
            assert out.execute('SELECT COUNT(*) FROM tokens').fetchone()[0]==2
            assert out.execute('SELECT COUNT(*) FROM sqlite_master WHERE name="paper_trades"').fetchone()[0]==0
            assert out.execute('SELECT bankroll_xrp FROM paper_cash_state').fetchone()[0]==100
            assert out.execute('SELECT excluded_legacy_positions FROM paper_epoch_metadata').fetchone()[0]==1
        finally:out.close()
        assert before==hashlib.sha256(source.read_bytes()).digest(),'Source DB bytes changed!'
        after=hashlib.sha256(OUTPUT.read_bytes()).digest()
        second=sh('--create','--source',source,'--output',OUTPUT,'--bankroll','200')
        assert second.returncode!=0,'Existing output must NEVER be overwritten'
        assert hashlib.sha256(OUTPUT.read_bytes()).digest()==after
        denied=sh('--create','--source',source,'--output',source)
        assert denied.returncode!=0
        print('PASS read-only plan, token-only new epoch, original positions preserved, no overwrite')
        print('EPOCH_TEST_DEST=',OUTPUT)
        # Deliberately leave destination for Node runtime assertion in CI.
        # CI workflow will delete it in an always() step.


if __name__=='__main__':
    main()
