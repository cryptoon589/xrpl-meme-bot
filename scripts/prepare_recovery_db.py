#!/usr/bin/env python3
"""Prepare a compact recovery database WITHOUT modifying the original.

Run only while the bot is stopped and after confirming an external snapshot.
Creates data/meme_bot.recovery.db. Does NOT activate it or delete the source.
Historical high-frequency observations and shadow/missed signal logs remain\navailable in the droplet snapshot.
"""
import os
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "data" / "meme_bot.db"
TARGET = ROOT / "data" / "meme_bot.recovery.db"
KEEP = (
    "tokens", "amm_pools", "paper_trades", "daily_summaries",
    "profile_stats", "whale_wallets",
)
# Avoid filling the last free gigabyte. Abort rather than touch the source.
MIN_FREE_AFTER = 500 * 1024 * 1024
MAX_RECOVERY_SIZE = 650 * 1024 * 1024
BATCH = 1000

def quote(identifier):
    return '"' + identifier.replace('"', '""') + '"'

def main():
    if not SOURCE.is_file():
        sys.exit("Original database not found")
    if TARGET.exists():
        sys.exit("Recovery target already exists; refusing to overwrite")
    if os.statvfs(ROOT).f_bavail * os.statvfs(ROOT).f_frsize < 700 * 1024 * 1024:
        sys.exit("Not enough free disk space to prepare recovery safely")
    source = sqlite3.connect(f"file:{SOURCE}?mode=ro", uri=True)
    source.execute("PRAGMA query_only=ON")
    target = sqlite3.connect(str(TARGET))
    target.execute("PRAGMA journal_mode=DELETE")
    target.execute("PRAGMA foreign_keys=OFF")
    try:
        schema = source.execute(
            "SELECT type,name,sql FROM sqlite_master "
            "WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' "
            "ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END"
        ).fetchall()
        for kind, name, sql in schema:
            if kind == "table":
                target.execute(sql)
        target.commit()
        for table in KEEP:
            if not any(kind == "table" and name == table for kind, name, _ in schema):
                print(f"Skipping missing table {table}", flush=True)
                continue
            print(f"Copying {table}...", flush=True)
            cursor = source.execute(f"SELECT * FROM {quote(table)}")
            cols = len(cursor.description)
            stmt = f"INSERT INTO {quote(table)} VALUES ({','.join('?' for _ in range(cols))})"
            copied = 0
            while True:
                batch = cursor.fetchmany(BATCH)
                if not batch:
                    break
                target.executemany(stmt, batch)
                target.commit()
                copied += len(batch)
                st = os.statvfs(ROOT)
                if TARGET.stat().st_size > MAX_RECOVERY_SIZE:
                    raise RuntimeError("Recovery DB exceeded 650 MiB; stop and choose a smaller retention set")
                if st.f_bavail * st.f_frsize < MIN_FREE_AFTER:
                    raise RuntimeError("Low disk space: stopped before exhausting disk")
                if copied % 100000 == 0:
                    print(f"  {copied:,} records", flush=True)
            print(f"  completed {copied:,}", flush=True)
        # Do not copy historical shadow/missed signals: they may be unbounded.\n        # These tables remain present but empty for future analysis.\n        # Leave indexes for the application schema initializer after the cutover.
        # Building indexes now could exhaust the nearly full disk.
        # Only lightweight views are created here.
        for kind, name, sql in schema:
            if kind == "view":
                target.execute(sql)
        target.commit()
        result = target.execute("PRAGMA quick_check").fetchone()[0]
        if result != "ok":
            raise RuntimeError(f"Recovery database quick_check failed: {result}")
        print(f"READY: {TARGET} ({TARGET.stat().st_size / 1024**2:.1f} MiB)")
        print("Original untouched. DO NOT delete/swap databases until reviewed.")
    except Exception as exc:
        print(f"INCOMPLETE: {exc}", file=sys.stderr)
        print(f"Partial target retained at {TARGET}; original untouched.", file=sys.stderr)
        sys.exit(1)
    finally:
        target.close()
        source.close()

if __name__ == "__main__":
    main()
