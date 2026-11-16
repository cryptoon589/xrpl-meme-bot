#!/usr/bin/env python3
"""CI-only vNext separate checkout staging smoke with synthetic active-WAL DB."""
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile

ROOT=Path(__file__).resolve().parents[1]
TARGET=ROOT/'data/meme_bot.recovery.db'
STAGER=ROOT/'scripts/stage_vnext_safely.py'

def digest(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()

def run(old,env):
    return subprocess.run([sys.executable,str(STAGER),'--old-root',str(old)],
        cwd=ROOT,env=env,capture_output=True,text=True,timeout=40)

def main():
    if os.getenv('CI')!='true':
        raise SystemExit('CI only: not a production command')
    if TARGET.exists() or TARGET.is_symlink():
        raise SystemExit('Refusing tests when staged compact recovery file already exists')
    with tempfile.TemporaryDirectory(prefix='hunterix-stage-ci-') as d:
        tmp=Path(d)
        old=tmp/'original';old.mkdir();data=old/'data';data.mkdir()
        src=data/'meme_bot.recovery.db'
        c=sqlite3.connect(src)
        c.execute('PRAGMA journal_mode=WAL')
        c.execute('''CREATE TABLE tokens(currency TEXT, issuer TEXT,
            first_seen INTEGER,last_updated INTEGER,raw_currency TEXT)''')
        c.execute('''CREATE TABLE paper_trades(
            id INTEGER PRIMARY KEY,token_currency TEXT,token_issuer TEXT,
            status TEXT,remaining_position REAL)''')
        c.execute("INSERT INTO tokens VALUES('ARMY','rArmy',1,1,'41524D5900000000000000000000000000000000')")
        for i in range(1,5):
            c.execute('INSERT INTO paper_trades VALUES(?,?,?,?,?)',
                      (i,'ARMY','rArmy','partial' if i<4 else 'open',i*20))
        c.commit()
        before=digest(src)
        pm2=tmp/'pm2'
        pm2.write_text('#!/usr/bin/env python3\nimport json\n'
                'print(json.dumps([{"name":"hunterix-paper","pm2_env":{"status":"online"}}]))\n')
        pm2.chmod(0o700)
        env=dict(os.environ,PATH=str(tmp)+os.pathsep+os.getenv('PATH',''))
        try:
            result=run(old,env)
            assert result.returncode==0,(result.stdout,result.stderr)
            assert 'PASS staged compact recovery copy' in result.stdout
            assert 'legacy positions' in result.stdout
            assert TARGET.is_file() and TARGET.stat().st_size>0
            assert digest(src)==before,'original compact WAL database was modified'
            with sqlite3.connect(TARGET) as db:
                assert db.execute('PRAGMA quick_check').fetchone()[0]=='ok'
                assert db.execute('SELECT COUNT(*) FROM paper_trades').fetchone()[0]==4
                assert db.execute('SELECT COUNT(*) FROM tokens').fetchone()[0]==1
            assert run(old,env).returncode==2,'must refuse overwrite of prior staged copy'
            print('PASS source WAL-preserving online SQLite backup, legacy 4 positions, no PM2 changes and no-overwrite rerun')
        finally:
            c.close()
            for suffix in ('','-wal','-shm'):
                p=Path(str(TARGET)+suffix)
                if p.exists(): p.unlink()
    print('STAGING SAFETY TESTS PASSED (SYNTHETIC FIXTURES ONLY)')

if __name__=='__main__':
    main()
