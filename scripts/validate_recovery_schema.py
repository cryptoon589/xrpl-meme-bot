#!/usr/bin/env python3
"""Validate recovered SQLite schema on a disposable copy; never edit recovery/source."""
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "data" / "meme_bot.recovery.db"
INDEXES = (
    "CREATE INDEX IF NOT EXISTS idx_tokens_currency ON tokens(currency)",
    "CREATE INDEX IF NOT EXISTS idx_tokens_issuer ON tokens(issuer)",
    "CREATE INDEX IF NOT EXISTS idx_market_snapshots_token ON market_snapshots(token_currency, token_issuer, timestamp)",
    "CREATE INDEX IF NOT EXISTS idx_scores_token ON scores(token_currency, token_issuer, timestamp)",
    "CREATE INDEX IF NOT EXISTS idx_paper_trades_status ON paper_trades(status)",
    "CREATE INDEX IF NOT EXISTS idx_paper_trades_entry ON paper_trades(entry_timestamp)",
    "CREATE INDEX IF NOT EXISTS idx_alerts_type ON alerts(alert_type, timestamp)",
    "CREATE INDEX IF NOT EXISTS idx_daily_summaries_date ON daily_summaries(date)",
)
MIGRATIONS = (
    ("market_snapshots", "unique_buyers_5m", "INTEGER DEFAULT 0"),
    ("market_snapshots", "unique_sellers_5m", "INTEGER DEFAULT 0"),
    ("tokens", "raw_currency", "TEXT"),
    ("paper_trades", "xrp_returned", "REAL DEFAULT 0"),
    ("paper_trades", "trade_profile", "TEXT"),
    ("paper_trades", "trade_source", "TEXT"),
    ("paper_trades", "raw_currency", "TEXT"),
    ("whale_wallets", "win_rate_pct", "REAL DEFAULT 0"),
    ("whale_wallets", "volume_xrp", "REAL DEFAULT 0"),
)
TABLES = ("tokens", "amm_pools", "paper_trades", "daily_summaries", "profile_stats", "whale_wallets")
def main():
    if not SOURCE.is_file():
        sys.exit("FAIL: recovery database missing")
    with tempfile.TemporaryDirectory(prefix="hunterix-schema-") as directory:
        target = Path(directory) / "compat.db"
        shutil.copyfile(SOURCE, target)
        db = sqlite3.connect(target)
        try:
            before = {table: db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] for table in TABLES}
            trade_before = db.execute("SELECT COALESCE(SUM(pnl_xrp),0) FROM paper_trades").fetchone()[0]
            for table, column, definition in MIGRATIONS:
                existing = {row[1] for row in db.execute(f"PRAGMA table_info({table})")}
                if column not in existing:
                    db.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")
            for statement in INDEXES:
                db.execute(statement)
            db.execute("DROP VIEW IF EXISTS tracked_tokens")
            db.execute("CREATE VIEW tracked_tokens AS SELECT id, currency, issuer, first_seen, last_updated, raw_currency FROM tokens")
            db.commit()
            after = {table: db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] for table in TABLES}
            trade_after = db.execute("SELECT COALESCE(SUM(pnl_xrp),0) FROM paper_trades").fetchone()[0]
            assert before == after, "Row counts changed"
            assert trade_before == trade_after, "Historical trade PnL changed"
            assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
            db.execute("SELECT * FROM tracked_tokens LIMIT 1").fetchall()
            print("PASS: migrations, 8 indexes, compatibility view, integrity, record counts, historical PnL")
            print("Preserved:", before)
            print("Recovery DB and original DB were not modified.")
        finally:
            db.close()

if __name__ == "__main__":
    main()
