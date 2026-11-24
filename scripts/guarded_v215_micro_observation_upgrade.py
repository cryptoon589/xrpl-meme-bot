#!/usr/bin/env python3
"""One-shot fail-closed PAPER V2.1.5 micro-observation and diagnostics upgrade. Never unfreezes entries.

Accepts only the pinned, deployed V2.1.4 PAPER baseline and a pinned FF descendant.
Deployment requires ZERO open/partial trades; valid high-water checkpoints
are not a reason to interrupt recoverable inventory. An existing operator
freeze sentinel is mandatory, and both old and new releases must keep
STREAM shadow-only. The old guarded legacy cutover is NOT reused as a switch;
only its already-tested read-only DB/PM2/backup/flat-lock helper functions
are reused. Failure after PM2 stops leaves PM2 stopped and PAPER frozen.

--status is read-only; --deploy-if-flat can stop/restart the PAPER bot,
make a 0600 coherent backup and advance the active Git checkout.
"""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import stat
import sys
from urllib import request
import urllib.error
from guarded_flat_paper_cutover import (
    abort, cmd, git_head, pm2_process, require_safe_runtime,
    paper_state, acquire_stop_if_flat, coherent_backup, verify_health,
    PM2_NAME, EPOCH_NAME
)
from check_paper_restart_safety import check as restart_safety

BASE = "1fb418708a1e6df29dfe68a076fcd635af5cf04a"
ACTIVE_DEFAULT = Path("/root/hunterix-vnext-stage-20261116")
REVIEW_DEFAULT = Path("/root/hunterix-micro-shadow-review-20261124")
SENTINEL = "state/paper-entry-freeze.flag"
CHECKS = (
    ("node","scripts/test_paper_stream_shadow_v2.js"),
    ("node","scripts/test_paper_opportunity_events.js"),
    ("node","scripts/test_xrpl_amm_flow_evidence.js"),
    ("node","scripts/test_open_ticker_collision.js"),
    ("node","scripts/test_meme_entry_universe.js"),
    ("node","scripts/test_external_meme_gainer_capture.js"),
    ("node","scripts/test_xrpl_currency.js"),
    ("node","scripts/test_telegram_reporting_integrity.js"),
    ("node","scripts/test_verified_project_issuers.js"),
    ("python3","scripts/test_paper_issuer_trades.py"),
    ("python3","scripts/test_external_gainer_timeline.py"),
    ("node","scripts/test_amm_pressure_shadow.js"),
    ("node","scripts/test_micro_amm_shadow.js"),
    ("node","scripts/test_missed_currency_decoder.js"),
    ("python3","scripts/test_liquidity_exits.py"),
    ("python3","scripts/test_meme_evidence_age.py"),
    ("python3","scripts/test_top_gainer_coverage.py"),
    ("node","scripts/test_buy_pressure_new_wallet.js"),
    ("python3","scripts/test_stream_issuer_quality.py"),
    ("python3","scripts/test_paper_opportunity_timeline.py"),
    ("node","scripts/test_paper_exit_only_restart.js"),
    ("node","scripts/test_verified_project_issuers.js"),
    ("python3","scripts/test_paper_stream_shadow_report.py"),
)

def frozen(root: Path) -> bool:
    p = root / SENTINEL
    if p.is_symlink() or not p.is_file():
        return False
    meta = p.stat()
    if stat.S_IMODE(meta.st_mode) & 0o077 or meta.st_size > 4096:
        return False
    return True

def ensure_frozen(root: Path) -> None:
    if not frozen(root):
        abort("Operator PAPER freeze sentinel missing, symlinked, unsafe, or not private 0600")

def verify_code(active: Path, review: Path, pin: str) -> None:
    if len(pin) != 40 or any(c not in "0123456789abcdef" for c in pin):
        abort("--pin must be a full exact 40-character commit SHA")
    if not active.is_dir() or not review.is_dir() or active.resolve() == review.resolve():
        abort("Distinct active and V2.1.5 review Git checkouts required")
    if git_head(active) != BASE:
        abort("Active code is not pinned deployed V2.1.4 baseline; no upgrade")
    if git_head(review) != pin:
        abort("Review checkout is not at the exact requested V2.1.5 pin")
    for root in (active, review):
        if cmd(["git","status","--porcelain","--untracked-files=no"],cwd=root).strip():
            abort("Tracked Git changes present in " + str(root))
    cmd(["git","cat-file","-e",pin+"^{commit}"],cwd=active)
    cmd(["git","merge-base","--is-ancestor",BASE,pin],cwd=active)
    # Require all staged buy-breadth and validated AMM shadow corrections.
    # The required commit precedes this release guard and is immutable.
    required="f7f358f700e276b324fca522526e9f9736d6c561"
    cmd(["git","cat-file","-e",required+"^{commit}"],cwd=active)
    cmd(["git","merge-base","--is-ancestor",required,pin],cwd=active)

def require_runtime(active: Path, online: bool) -> None:
    require_safe_runtime(pm2_process(),active,online=online)
    ensure_frozen(active)
    e=pm2_process().get("pm2_env") or {}
    # Existing vNext PAPER releases may not have explicitly set this flag
    # in their inherited PM2 environment. Dynamic PAPER defaults to STREAM
    # shadow-only unless the operator EXPLICITLY opts out with '0'.
    # Online preflight and post-restart /health MUST still report True.
    if str(e.get("BOT_PAPER_STREAM_SHADOW_ONLY")) == "0":
        abort("STREAM shadow policy explicitly disabled in PM2; deployment blocked")
    if str(e.get("BOT_USE_RESERVE_QUOTES")) != "1":
        abort("Reserve-aware PAPER quotes not explicitly enabled; deployment blocked")

def current_health() -> dict:
    try:
        with request.urlopen("http://127.0.0.1:3000/health",timeout=5) as res:
            h=json.load(res)
    except (urllib.error.URLError,TimeoutError,ValueError,ConnectionError) as exc:
        abort("Old vNext PAPER /health unavailable: "+str(exc))
    if not (h.get("status") == "ok"
        and h.get("paperEntryFrozen") is True
        and h.get("paperStreamShadowOnly") is True
        and h.get("xrplConnected") is True
        and h.get("xrplStreamConnected") is True):
        abort("Old PAPER bot is not healthy/frozen/shadow-only")
    return h

def preflight(active: Path, review: Path, pin: str) -> tuple[int,int,float]:
    verify_code(active,review,pin)
    require_runtime(active,online=True)
    health=current_health()
    db_path=active/"data"/EPOCH_NAME
    n,trades,cash=paper_state(db_path)
    if health.get("positions") != n:
        abort("PM2 /health position count differs from PAPER database")
    if not restart_safety(db_path):
        abort("Unverified PAPER trailing-high checkpoints")
    print(f"Active: {n} open/partial, {trades} trades, {cash:.6f} XRP PAPER cash")
    return n,trades,cash

def stage_tests(review: Path) -> None:
    print("Running pinned V2.1.5 passive AMM reserve observer and offline diagnostics regressions...")
    cmd(["npm","run","build"],cwd=review,timeout=150)
    for program,path in CHECKS:
        cmd([program,path],cwd=review,timeout=100)
    print("PASS: pinned V2.1.5 build and offline regressions")

def run(active: Path, review: Path, pin: str, deploy: bool) -> int:
    n,trade_count,cash=preflight(active,review,pin)
    if n:
        print(f"BLOCK: {n} PAPER position(s) remain. PM2 and Git unchanged.")
        return 2 if deploy else 0
    if not deploy:
        print("READY: currently flat and frozen; deploy will recheck atomically before PM2 stop")
        return 0
    stage_tests(review)
    # A position or runtime setting may have changed during staging/tests.
    # Revalidate exact target, PM2 environment, health and freeze NOW.
    n,trade_count,cash=preflight(active,review,pin)
    if n:
        print(f"BLOCK: {n} PAPER position(s) appeared during staging; PM2 untouched.")
        return 2
    # The shared helper acquires BEGIN IMMEDIATE, checks flat, stops PM2
    # before releasing the write lock, preventing an entry/exit race.
    if not acquire_stop_if_flat(active/"data"/EPOCH_NAME):
        return 2
    try:
        require_runtime(active,online=False)
        if paper_state(active/"data"/EPOCH_NAME) != (0,trade_count,cash):
            abort("PAPER state changed after stop; no code mutation")
        backup=coherent_backup(active/"data"/EPOCH_NAME,active)
        ensure_frozen(active)
        cmd(["git","merge","--ff-only",pin],cwd=active,timeout=60)
        if git_head(active)!=pin:
            abort("Active code did not reach exact V2.1.5 pin")
        cmd(["npm","run","build"],cwd=active,timeout=150)
        cmd(["python3","scripts/check_paper_restart_safety.py",
             "--db",str(active/"data"/EPOCH_NAME)],cwd=active,timeout=35)
        ensure_frozen(active)
        if paper_state(active/"data"/EPOCH_NAME) != (0,trade_count,cash):
            abort("PAPER economic state mutated before restart")
        cmd(["pm2","restart",PM2_NAME],timeout=50)
        require_runtime(active,online=True)
        h=verify_health(timeout_seconds=100)
        if git_head(active)!=pin or paper_state(active/"data"/EPOCH_NAME)!=(0,trade_count,cash):
            abort("PIN or PAPER accounting changed after restart")
        ensure_frozen(active)
        cmd(["pm2","save"],timeout=25)
        print("SUCCESS: V2.1.5 AMM micro-evidence and diagnostics pinned, PM2 online, flat, entry-frozen, STREAM shadow-only")
        print("Deployed:",pin)
        print("Verified backup:",backup)
        print("Health uptime:",h.get("uptime"))
        print("No PAPER entries resumed. Monitoring only until explicit operator action.")
        return 0
    except Exception:
        print("UPGRADE INCOMPLETE AFTER PM2 STOP: KEEP PAPER FROZEN; "+
              "inspect PM2/DB before any restart or rollback.",file=sys.stderr)
        raise

def main() -> int:
    ap=argparse.ArgumentParser()
    mode=ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--status",action="store_true")
    mode.add_argument("--deploy-if-flat",action="store_true")
    ap.add_argument("--pin",required=True)
    ap.add_argument("--active",type=Path,default=ACTIVE_DEFAULT)
    ap.add_argument("--review",type=Path,default=REVIEW_DEFAULT)
    args=ap.parse_args()
    return run(args.active.resolve(),args.review.resolve(),
               args.pin.lower(),bool(args.deploy_if_flat))

if __name__=="__main__":
    try:raise SystemExit(main())
    except Exception as exc:
        print("V2.1.5 UPGRADE BLOCKED:",exc,file=sys.stderr)
        raise SystemExit(2)
