#!/usr/bin/env python3
"""GitHub CI only: disposable epoch/manifest and simulated PM2. No VPS changes."""
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile

ROOT=Path(__file__).resolve().parents[1]
DATA=ROOT/'data'
EPOCH=DATA/'meme_bot.paper-epoch-20261116-releaseci.db'
PRE=ROOT/'scripts/vnext_preflight.py'
PREP=ROOT/'scripts/prepare_paper_epoch.py'

def run(tool,*args,env=None):
    return subprocess.run([sys.executable,str(tool),*map(str,args)],
        cwd=ROOT,capture_output=True,text=True,timeout=25,env=env)

def check(result,expected=0):
    if result.returncode!=expected:
        raise AssertionError('unexpected RC %s expected %s\n%s\n%s' %
              (result.returncode,expected,result.stdout,result.stderr))
    return result

def main():
    if os.environ.get('CI')!='true':
        raise SystemExit('CI only; refusing any operator/VPS use')
    if EPOCH.exists():
        raise SystemExit('test epoch exists; refusing to overwrite or delete it')
    with tempfile.TemporaryDirectory(prefix='hunterix-release-preflight-') as folder:
        tmp=Path(folder)
        legacy=tmp/'meme_bot.recovery.db'
        manifest=tmp/'reviewed_operator.json'
        c=sqlite3.connect(legacy)
        c.execute('CREATE TABLE tokens (currency TEXT, issuer TEXT, first_seen INTEGER, last_updated INTEGER, raw_currency TEXT)')
        c.execute('''CREATE TABLE paper_trades(
             id INTEGER, token_currency TEXT, token_issuer TEXT,
             status TEXT, remaining_position REAL,
             entry_timestamp INTEGER, entry_amount_xrp REAL,
             xrp_returned REAL, fees_paid REAL)''')
        c.execute("INSERT INTO tokens VALUES('SYNTH','rSyntheticIssuer',1,1,'53594e5448000000000000000000000000000000')")
        c.executemany("INSERT INTO paper_trades VALUES(?,?,?,?,?,?,?,?,?)",
            [(i,'LEGACY','rLegacyIssuer','partial' if i<4 else 'open',i*20,1,5,2,0)
             for i in range(1,5)])
        c.commit()
        c.close()
        before=hashlib.sha256(legacy.read_bytes()).hexdigest()

        manifest.write_text(json.dumps({
            'format':'hunterix-manual-blacklist-v1',
            'managedBy':'operator',
            'tokens':[{'currency':'SYNTHONLY','reason':'CI fixture, not user list'}]
        }))
        digest=hashlib.sha256(manifest.read_bytes()).hexdigest()
        env=dict(os.environ,HUNTERIX_TEST_SOURCE_OVERRIDE='1')
        # Fixture only: synthetic nonworking Telegram credentials. No actual
        # Telegram request and no overwrite of a developer's staged .env.
        stagedEnv=ROOT/'.env'
        if stagedEnv.exists() or stagedEnv.is_symlink():
            raise RuntimeError('CI fixture refuses existing .env')
        fd=os.open(stagedEnv,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
        with os.fdopen(fd,'w',encoding='utf8') as f:
            f.write('TELEGRAM_BOT_TOKEN=123456:'+'T'*35+
                    '\\nTELEGRAM_CHAT_ID=-1001234567890\\n')
        try:
            check(run(PREP,'--create','--source',legacy,'--output',EPOCH,env=env))
            check(run(PRE,'--epoch',EPOCH,'--legacy',legacy,
                '--manifest',manifest,'--initial-cutover',env=env))
            assert before==hashlib.sha256(legacy.read_bytes()).hexdigest()
            print('PASS epoch and 4 legacy open positions preserved; operator manifest synthetic-only')

            pm2=tmp/'pm2'
            pm2.write_text('#!/usr/bin/env python3\nimport os,json\n'
                'online=os.environ.get("TEST_OLD_ONLINE")=="1"\n'
                'print(json.dumps([{"name":"hunterix-paper","pm2_env":'
                '{"status":"online" if online else "stopped"}}]))\n')
            pm2.chmod(0o700)
            testEnv=dict(env,
                PATH=str(tmp)+os.pathsep+os.environ.get('PATH',''),
                MODE='PAPER',LIVE_TRADING='false',
                TRADING_WALLET_SEED='',
                BOT_DB_PATH=str(EPOCH.resolve()),BOT_PAPER_EPOCH_ID=EPOCH.stem,
                HUNTERIX_MANUAL_BLOCKLIST_FILE=str(manifest.resolve()),
                HUNTERIX_LEGACY_SOURCE_DB_PATH=str(legacy.resolve()),
                HUNTERIX_OPERATOR_BLACKLIST_APPROVED_SHA256=digest,
                XRPL_WS_URL='wss://xrplcluster.com',
                HUNTERIX_VNEXT_XRPL_WS_URL='wss://xrplcluster.com',
                BOT_USE_RESERVE_QUOTES='1',BOT_ENABLE_LIQUIDITY_LOSS_GUARD='1',
                BOT_ENABLE_STARTUP_PRUNE='0',BOT_ENABLE_OBSERVATION_RETENTION='1',
                BOT_ENABLE_RECOVERY_DISK_GUARD='1',
                XRPL_SEPARATE_STREAM='1',XRPL_RPC_MAX_INFLIGHT='2',XRPL_RPC_MAX_PER_SEC='3',
                BOT_ENABLE_VALIDATED_LEARNING='0',
                TEST_OLD_ONLINE='0')
            ready=run(PRE,'--epoch',EPOCH,'--legacy',legacy,
                '--manifest',manifest,'--strict-startup',env=testEnv)
            check(ready)
            assert 'PASS runtime: operator-reviewed manifest hash' in ready.stdout
            print('PASS valid PAPER-only config, exact manual digest, PM2 uniqueness and fresh epoch')
            stagedEnv.write_text('TELEGRAM_BOT_TOKEN=123456:'+'T'*35+
                                 '\\nTELEGRAM_CHAT_ID=-1001234567890\\nTRADING_WALLET_SEED=FAKE\\n')
            assert run(PRE,'--epoch',EPOCH,'--legacy',legacy,
                '--manifest',manifest,'--strict-startup',env=testEnv).returncode==2
            stagedEnv.write_text('TELEGRAM_BOT_TOKEN=123456:'+'T'*35+
                                 '\\nTELEGRAM_CHAT_ID=-1001234567890\\n')
            print('PASS accidental legacy wallet seed in staged .env refused')

            for field, bad in [
                ('HUNTERIX_OPERATOR_BLACKLIST_APPROVED_SHA256','0'*64),
                ('MODE','LIVE'),('LIVE_TRADING','true'),
                ('BOT_DB_PATH',str(legacy)),
                ('BOT_USE_RESERVE_QUOTES','0'),
                ('BOT_ENABLE_VALIDATED_LEARNING','1'),
                ('TRADING_WALLET_SEED','FAKE_SAFETY_TEST_NON_SECRET'),
                ('TEST_OLD_ONLINE','1'),
            ]:
                test=run(PRE,'--epoch',EPOCH,'--legacy',legacy,
                    '--manifest',manifest,'--strict-startup',
                    env={**testEnv,field:bad})
                assert test.returncode==2,(field,test.stdout,test.stderr)
            print('PASS wrong DB, LIVE, stale approval, seed, duplicate PM2 and unsafe flags refused')

            # A rolling PAPER restart must NOT be blocked just because the
            # fresh epoch has since traded; but unreconciled open inventory
            # must block new process startup.
            c=sqlite3.connect(EPOCH)
            c.execute('CREATE TABLE paper_trades (id INTEGER PRIMARY KEY, status TEXT)')
            c.execute("INSERT INTO paper_trades VALUES(1,'closed')")
            c.commit()
            c.close()
            running=run(PRE,'--epoch',EPOCH,'--legacy',legacy,
                '--manifest',manifest,'--strict-startup',env=testEnv)
            assert running.returncode==2,'trade history without inventory schema must reject'
            c=sqlite3.connect(EPOCH)
            c.execute('CREATE TABLE paper_inventory (trade_id INTEGER PRIMARY KEY, tokens_held REAL)')
            c.execute("INSERT INTO paper_trades VALUES(2,'partial')")
            c.commit()
            c.close()
            assert run(PRE,'--epoch',EPOCH,'--legacy',legacy,
                '--manifest',manifest,'--strict-startup',env=testEnv).returncode==2
            c=sqlite3.connect(EPOCH)
            c.execute("INSERT INTO paper_inventory VALUES(2,20)")
            c.commit()
            c.close()
            check(run(PRE,'--epoch',EPOCH,'--legacy',legacy,
                '--manifest',manifest,'--strict-startup',env=testEnv))
            assert run(PRE,'--epoch',EPOCH,'--legacy',legacy,
                '--manifest',manifest,'--initial-cutover',env=testEnv).returncode==2
            print('PASS later PAPER restarts accepted with durable inventory; incomplete inventory/first-cutover reuse refused')
        finally:
            stagedEnv.unlink(missing_ok=True)
            for suffix in ('','-wal','-shm'):
                p=Path(str(EPOCH)+suffix)
                if p.exists():
                    p.unlink()  # CI fixture filename and CI=true are mandatory
    print('VNext RELEASE PREFLIGHT CI TESTS PASSED')

if __name__=='__main__':
    main()
