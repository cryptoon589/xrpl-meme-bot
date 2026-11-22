#!/usr/bin/env python3
"""Synthetic disposable SQLite tests for one-shot PAPER cutover race closure."""
from pathlib import Path
import importlib.util
import sqlite3
import tempfile
import os
import json
import io
from unittest.mock import patch

CUTOVER=Path(__file__).with_name('guarded_flat_paper_cutover.py')
spec=importlib.util.spec_from_file_location('hunterix_flat_cutover',CUTOVER)
mod=importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

def create_db(root:Path,open_pos:int):
    root.mkdir(parents=True,exist_ok=True)
    p=root/'data'/mod.EPOCH_NAME
    p.parent.mkdir(parents=True,exist_ok=True)
    with sqlite3.connect(p) as db:
        db.execute('PRAGMA journal_mode=WAL')
        db.execute('CREATE TABLE paper_trades(id INTEGER PRIMARY KEY,status TEXT)')
        db.execute('CREATE TABLE paper_cash_state(singleton_id INTEGER, bankroll_xrp REAL)')
        db.execute('INSERT INTO paper_cash_state VALUES(1,80.173797)')
        for i in range(open_pos):
            db.execute('INSERT INTO paper_trades VALUES(?,?)',(i+1,'open'))
    return p

def run():
    with tempfile.TemporaryDirectory() as d:
        root=Path(d)
        open_db=create_db(root/'open',2)
        original_cmd,original_pm2=mod.cmd,mod.pm2_process
        calls=[]
        try:
            def dangerous_pm2(*args,**kwargs):
                calls.append(args)
                raise AssertionError('PM2 must NEVER be called when PAPER positions exist')
            mod.cmd=dangerous_pm2
            assert mod.acquire_stop_if_flat(open_db) is False
            assert not calls
            assert mod.paper_state(open_db)==(2,2,80.173797)

            flat_root=root/'flat'
            flat_db=create_db(flat_root,0)
            (flat_root/'recovery-backups').mkdir()
            state={'stopped':False}
            def fake_command(args,**kwargs):
                assert args==['pm2','stop',mod.PM2_NAME],args
                assert not state['stopped']
                # Crucial race test: after first flat-book check but BEFORE
                # PM2 stop, old Node cannot commit an in-flight PAPER entry.
                with sqlite3.connect(flat_db,timeout=0.1) as competitor:
                    try:
                        competitor.execute(
                            "INSERT INTO paper_trades(id,status) VALUES(1,'open')"
                        )
                    except sqlite3.OperationalError as exc:
                        assert 'locked' in str(exc).lower(),exc
                    else:
                        raise AssertionError(
                            'PAPER entry committed across critical PM2 stop boundary'
                        )
                state['stopped']=True
                return ''
            mod.cmd=fake_command
            mod.pm2_process=lambda: {
                'name':mod.PM2_NAME,
                'pm2_env':{'status':'stopped' if state['stopped'] else 'online'}
            }
            assert mod.acquire_stop_if_flat(flat_db) is True
            assert state['stopped']
            assert mod.paper_state(flat_db)==(0,0,80.173797)
            # After stop, backup is WAL safe, owner-private and fully complete.
            backup=mod.coherent_backup(flat_db,flat_root)
            assert backup.exists() and mod.paper_state(backup)==mod.paper_state(flat_db)
            assert (backup.stat().st_mode & 0o077)==0

            # If a PAPER row is somehow already open at the lock boundary,
            # no PM2 stop is attempted and no position row is changed.
            mod.cmd=dangerous_pm2
            with sqlite3.connect(flat_db) as c:
                c.execute("INSERT INTO paper_trades(id,status) VALUES(3,'partial')")
            assert mod.acquire_stop_if_flat(flat_db) is False
            assert mod.paper_state(flat_db)[0]==1
            print('PASS one-shot cutover: nonflat leaves PM2 unchanged, flat writer lock prevents entry commit until PM2 stopped, coherent backup integrity and 0600 permissions')
        finally:
            mod.cmd=original_cmd
            mod.pm2_process=original_pm2

def test_v2_health_gate():
    """A positive /health alone must not bless a release without V2 shadow."""
    status={
        'status':'ok','positions':0,
        'paperEntryFrozen':True,
        'paperStreamShadowOnly':True,
        'xrplConnected':True,
        'xrplStreamConnected':True
    }
    class Response:
        def __init__(self,body):self.body=body
        def __enter__(self):return self
        def __exit__(self,*exc):return False
        def read(self,*args):return json.dumps(self.body).encode()
    with patch.object(mod.urllib.request,'urlopen',side_effect=lambda *a,**k:Response(status)):
        r=mod.verify_health(timeout_seconds=1)
        assert r['paperStreamShadowOnly'] is True

    # If the right source code deployed but a PM2 override disables the
    # policy, deployment may not be declared SUCCESS.
    wrong={**status,'paperStreamShadowOnly':False}
    now=[0]
    def monotonic():
        now[0]+=0.25
        return now[0]
    with patch.object(mod.urllib.request,'urlopen',side_effect=lambda *a,**k:Response(wrong)):
        with patch.object(mod.time,'monotonic',side_effect=monotonic):
            with patch.object(mod.time,'sleep',side_effect=lambda *_:None):
                try:mod.verify_health(timeout_seconds=1)
                except RuntimeError as e:
                    assert 'v2_stream_shadow=False' in str(e),str(e)
                else:raise AssertionError('Deployment health must reject STREAM shadow disabled')
    print('PASS guarded cutover: requires /health V2 STREAM shadow policy ON as well as flat frozen PAPER inventory')

if __name__=='__main__':
    run()
    test_v2_health_gate()
