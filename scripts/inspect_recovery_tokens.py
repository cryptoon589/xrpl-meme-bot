#!/usr/bin/env python3
"""Read-only audit of tracked-token history across original, recovery and pre-start backups.

Never creates, modifies or restores any database. Does not scan high-volume tables.
"""
from __future__ import annotations
import sqlite3
from pathlib import Path
from datetime import datetime, timezone
import sys

ROOT = Path(__file__).resolve().parents[1]
ORIGINAL = ROOT / "data" / "meme_bot.db"
RECOVERY = ROOT / "data" / "meme_bot.recovery.db"
BACKUPS = sorted((ROOT / "recovery-backups").glob("meme_bot.recovery.pre-start.*.db"))

def inspect(path: Path):
    if not path.is_file():
        print(f"MISSING: {path}")
        return None
    con = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=5)
    try:
        rows = con.execute("SELECT currency, issuer, last_updated FROM tokens").fetchall()
        keys = {(r[0], r[1]) for r in rows}
        cutoff_ms = int(datetime.now(timezone.utc).timestamp() * 1000) - 48 * 3600 * 1000
        stale = sum(1 for r in rows if r[2] < cutoff_ms)
        positions = con.execute("SELECT COUNT(*) FROM paper_trades WHERE status = 'open'").fetchone()[0]
        return {"count": len(rows), "keys": keys, "stale": stale, "open": positions}
    finally:
        con.close()

def summary(label, path, result):
    if result is None:
        return
    print(f"{label}: tokens={result['count']} stale_48h={result['stale']} open_paper_positions={result['open']} path={path}")

def main():
    original = inspect(ORIGINAL)
    current = inspect(RECOVERY)
    summary("Original 18 GiB (read-only)", ORIGINAL, original)
    summary("Active recovery (read-only)", RECOVERY, current)
    oldest = None
    if BACKUPS:
        oldest = inspect(BACKUPS[0])
        summary("Earliest pre-probe backup (read-only)", BACKUPS[0], oldest)
        if len(BACKUPS) > 1:
            newest = inspect(BACKUPS[-1])
            summary("Latest pre-probe backup (read-only)", BACKUPS[-1], newest)
    if current and original:
        print(f"Token keys present in original but missing from recovery: {len(original['keys'] - current['keys'])}")
        print(f"Token keys newly discovered since original: {len(current['keys'] - original['keys'])}")
    if current and oldest:
        print(f"Token keys in earliest recovery backup but missing now: {len(oldest['keys'] - current['keys'])}")
    print("READ-ONLY AUDIT COMPLETE: no database was modified")

if __name__ == "__main__":
    try:
        main()
    except (OSError, sqlite3.Error) as exc:
        sys.exit(f"Audit failed without making changes: {exc}")
