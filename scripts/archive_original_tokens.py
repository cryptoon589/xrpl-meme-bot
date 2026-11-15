#!/usr/bin/env python3
"""Safely copy historical token identities out of the original 18 GiB DB.

The original is opened read-only. Historical tokens go to token_archive in the
compact recovery database, NOT the live tokens table. Active tracked tokens,
trades, snapshots and scoring are unchanged. Requires the bot to be stopped.
"""
from datetime import datetime, timezone
from pathlib import Path
import os
import sqlite3
import sys

ROOT = Path(__file__).resolve().parents[1]
ORIGINAL = ROOT / "data" / "meme_bot.db"
RECOVERY = ROOT / "data" / "meme_bot.recovery.db"
BACKUPS = ROOT / "recovery-backups"

def bot_running():
    proc = Path("/proc")
    if not proc.is_dir():
        sys.exit("Cannot verify bot is stopped; aborting")
    for entry in proc.iterdir():
        if not entry.name.isdecimal() or int(entry.name) == os.getpid():
            continue
        try:
            args = (entry / "cmdline").read_bytes().replace(bytes([0]), b" ")
        except (OSError, PermissionError):
            continue
        if b"node " in args and b"dist/index.js" in args:
            return True
    return False

def open_original():
    con = sqlite3.connect(ORIGINAL.resolve().as_uri() + "?mode=ro", uri=True, timeout=5)
    cols = {r[1] for r in con.execute("PRAGMA table_info(tokens)")}
    if not {"currency", "issuer", "first_seen", "last_updated"}.issubset(cols):
        sys.exit("Source tokens schema is unexpected")
    raw = "raw_currency" if "raw_currency" in cols else "NULL AS raw_currency"
    rows = con.execute(
        f"SELECT currency, issuer, first_seen, last_updated, {raw} FROM tokens"
    ).fetchall()
    con.close()
    return rows

def main():
    if not ORIGINAL.is_file() or not RECOVERY.is_file():
        sys.exit("Missing original or recovered DB; no changes made")
    if bot_running():
        sys.exit("Hunterix appears to be running; stop it before archival")
    vfs = os.statvfs(ROOT)
    if vfs.f_bavail * vfs.f_frsize < 400 * 1024 * 1024:
        sys.exit("Less than 400 MiB free. Refusing to write.")
    source_rows = open_original()
    source_keys = {(r[0], r[1]) for r in source_rows}
    if len(source_keys) != len(source_rows):
        sys.exit("Duplicate token keys in original DB; refusing archival")

    BACKUPS.mkdir(exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup_path = BACKUPS / f"meme_bot.recovery.pre-archive.{timestamp}.db"
    if backup_path.exists():
        sys.exit(f"Backup already exists: {backup_path}")

    dest = sqlite3.connect(str(RECOVERY), timeout=5)
    try:
        before_keys = set(dest.execute("SELECT currency, issuer FROM tokens"))
        before_trades = dest.execute("SELECT COUNT(*) FROM paper_trades").fetchone()[0]
        before_open = dest.execute(
            "SELECT COUNT(*) FROM paper_trades WHERE status IN ('open','partial')"
        ).fetchone()[0]
        if dest.execute("PRAGMA quick_check").fetchone()[0] != "ok":
            sys.exit("Recovery DB failed quick_check; no changes made")

        backup = sqlite3.connect(str(backup_path))
        try:
            dest.backup(backup)
        finally:
            backup.close()
        print(f"Recovery DB backed up before archive: {backup_path}", flush=True)

        dest.execute("BEGIN IMMEDIATE")
        try:
            dest.execute("""CREATE TABLE IF NOT EXISTS token_archive (
                currency TEXT NOT NULL,
                issuer TEXT NOT NULL,
                first_seen INTEGER NOT NULL,
                last_updated INTEGER NOT NULL,
                raw_currency TEXT,
                archive_source TEXT NOT NULL DEFAULT 'original_2026_11',
                PRIMARY KEY (currency, issuer)
            )""")
            dest.executemany("""INSERT OR IGNORE INTO token_archive
                (currency, issuer, first_seen, last_updated, raw_currency)
                VALUES (?, ?, ?, ?, ?)""", source_rows)
            archived_keys = set(dest.execute("SELECT currency, issuer FROM token_archive"))
            if not source_keys.issubset(archived_keys):
                raise RuntimeError("Archive token key verification failed")
            if set(dest.execute("SELECT currency, issuer FROM tokens")) != before_keys:
                raise RuntimeError("Active tracked tokens changed unexpectedly")
            if dest.execute("SELECT COUNT(*) FROM paper_trades").fetchone()[0] != before_trades:
                raise RuntimeError("Paper trade count changed unexpectedly")
            dest.commit()
        except Exception:
            dest.rollback()
            raise
        if dest.execute("PRAGMA quick_check").fetchone()[0] != "ok":
            raise RuntimeError("Recovery DB failed integrity check after archival")
        print(f"ARCHIVE PASSED: {len(source_keys)} original tokens in token_archive")
        print(f"ACTIVE UNCHANGED: {len(before_keys)} tracked tokens")
        print(f"PAPER TRADES UNCHANGED: {before_trades} total; {before_open} open/partial")
        print("Original 18 GiB database was read-only and remains untouched")
    finally:
        dest.close()

if __name__ == "__main__":
    try:
        main()
    except (OSError, sqlite3.Error, RuntimeError) as e:
        sys.exit(f"ARCHIVE FAILED; inspect backup before retrying: {e}")
