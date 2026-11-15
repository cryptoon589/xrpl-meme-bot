#!/usr/bin/env python3
"""Read-only preflight for the XRPL bot database recovery.

No table scans, no database writes, no secrets printed.
Run from the bot repository after the DigitalOcean snapshot is complete.
"""
import os
import sqlite3
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DB = ROOT / "data" / "meme_bot.db"
TARGET = ROOT / "data" / "meme_bot.recovery.db"
REQUIRED = {
    "tokens", "amm_pools", "market_snapshots", "scores", "alerts",
    "paper_trades", "daily_summaries", "profile_stats",
    "missed_opportunities", "shadow_trades",
}
def main():
    problems = []
    if not DB.is_file():
        sys.exit("FAIL: database missing")
    free = os.statvfs(ROOT)
    free_mib = free.f_bavail * free.f_frsize / 1024**2
    print(f"Original DB: {DB.stat().st_size / 1024**3:.2f} GiB")
    print(f"Available disk: {free_mib:.0f} MiB")
    if free_mib < 1150:
        problems.append("Less than 1150 MiB free; recovery may not fit safely")
    if TARGET.exists():
        problems.append("Recovery target already exists; do not overwrite")
    for suffix in ("-wal", "-shm", "-journal"):
        file = Path(str(DB) + suffix)
        if file.exists():
            print(f"SQLite sidecar: {file.name} ({file.stat().st_size} bytes)")
            if suffix == "-wal":
                problems.append("WAL file exists; confirm checkpoint/consistent snapshot before copying")
    try:
        p = subprocess.run(["pgrep", "-af", "node.*(dist/index|ts-node.*src/index)|pm2.*xrpl-meme-bot"],
                           capture_output=True, text=True, timeout=5)
        if p.returncode == 0:
            print("Potential trading bot processes detected; inspect before proceeding:")
            print(p.stdout[:1500])
            problems.append("Potential bot process detected")
    except (OSError, subprocess.TimeoutExpired):
        problems.append("Unable to verify bot is stopped")
    try:
        connection = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=3)
        tables = {row[0] for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type='table'")}
        missing = sorted(REQUIRED - tables)
        print(f"Tables present: {len(tables)}")
        if missing:
            problems.append(f"Missing required tables: {', '.join(missing)}")
        page_count = connection.execute("PRAGMA page_count").fetchone()[0]
        freelist = connection.execute("PRAGMA freelist_count").fetchone()[0]
        print(f"SQLite pages: {page_count:,}; free pages: {freelist:,}")
        connection.close()
    except sqlite3.Error as exc:
        problems.append(f"Cannot read SQLite metadata: {exc}")
    if problems:
        print("\nNOT READY:")
        for problem in problems:
            print(f"- {problem}")
        sys.exit(1)
    print("\nPREFLIGHT PASSED: metadata only; no database modified.")
    print("Do not cut over until recovered DB is validated.")

if __name__ == "__main__":
    main()
