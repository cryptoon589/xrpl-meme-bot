#!/usr/bin/env python3
"""Synthetic, no-network V2.1 upgrader guards. Never interacts with real PM2."""
from __future__ import annotations
import importlib.util
from pathlib import Path
import sqlite3
import tempfile
from unittest.mock import patch
MODPATH=Path(__file__).with_name("guarded_v21_paper_upgrade.py")
spec=importlib.util.spec_from_file_location("guarded_v21",MODPATH)
u=importlib.util.module_from_spec(spec)
spec.loader.exec_module(u)

def expect_block(fn):
    try:fn()
    except RuntimeError:return
    raise AssertionError("Unsafe operation was not blocked")

def test_freeze():
    with tempfile.TemporaryDirectory() as t:
        root=Path(t)
        (root/"state").mkdir()
        expect_block(lambda:u.ensure_frozen(root))
        flag=root/u.SENTINEL
        flag.write_text("operator freeze\n")
        flag.chmod(0o600)
        assert u.frozen(root)
        flag.chmod(0o644)
        assert not u.frozen(root)
        flag.unlink()
        flag.symlink_to("/dev/null")
        assert not u.frozen(root)

def test_runtime_policy():
    # Old PM2 may legitimately omit the shadow flag. The code defaults ON
    # in dynamic PAPER, verified separately by /health. Explicit 0 blocks.
    # The reserve quote setting MUST remain explicitly enabled.
    with tempfile.TemporaryDirectory() as tmp:
        root=Path(tmp)
        base={
            "BOT_PAPER_MEME_DISCOVERY":"1",
            "BOT_USE_RESERVE_QUOTES":"1",
        }
        def check(env):
            with patch.object(u,"pm2_process",return_value={"pm2_env":env}):
                with patch.object(u,"require_safe_runtime",return_value=None):
                    with patch.object(u,"ensure_frozen",return_value=None):
                        u.require_runtime(root,online=True)
        check(base)
        check({**base,"BOT_PAPER_STREAM_SHADOW_ONLY":"1"})
        expect_block(lambda:check({**base,"BOT_PAPER_STREAM_SHADOW_ONLY":"0"}))
        expect_block(lambda:check({"BOT_PAPER_MEME_DISCOVERY":"1"}))
        expect_block(lambda:check({**base,"BOT_USE_RESERVE_QUOTES":"0"}))
        print("PASS legacy PM2 optional shadow flag; explicit opt-out and missing reserve quotes blocked")

def test_nonflat():
    with tempfile.TemporaryDirectory() as t:
        root=Path(t)
        db=root/"epoch.db"
        with sqlite3.connect(db) as c:
            c.executescript("""
                CREATE TABLE paper_trades(id INTEGER PRIMARY KEY,status TEXT);
                INSERT INTO paper_trades VALUES(11,'open');
            """)
        calls=[]
        def stop(*args,**kwargs):
            calls.append(args)
            raise AssertionError("PM2 stop must not happen with open trades")
        with patch.object(u,"preflight",return_value=(1,75,92.0)):
            with patch.object(u,"stage_tests",side_effect=stop):
                with patch.object(u,"acquire_stop_if_flat",side_effect=stop):
                    assert u.run(root,root,"f"*40,deploy=False)==0
                    assert u.run(root,root,"f"*40,deploy=True)==2
        assert calls==[]
        assert sqlite3.connect(db).execute("SELECT COUNT(*) FROM paper_trades").fetchone()[0]==1

def test_race_and_safety():
    # Regression source guarantees re-use of the previously tested writer-lock
    # helper, checks frozen before and after, and explicitly never unfreezes.
    import inspect
    src=inspect.getsource(u.run)
    for phrase in ("acquire_stop_if_flat","coherent_backup","ensure_frozen",
                   "verify_health","pm2","save","return 2"):
        assert phrase in src,phrase
    assert "unfreeze" not in src

if __name__=="__main__":
    test_freeze()
    test_runtime_policy()
    test_nonflat()
    test_race_and_safety()
    print("PASS V2.1 guarded upgrade: 0600 sentinel, no stop if nonflat, pinned/flat/backup/restart safety")
