#!/usr/bin/env python3
"""Offline smoke test for the non-destructive recovery utility."""
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("prepare_recovery_db.py")

class RecoverySmokeTest(unittest.TestCase):
    def test_preserves_trades_and_source_without_copying_snapshots(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "scripts").mkdir()
            (root / "data").mkdir()
            (root / "scripts" / SCRIPT.name).write_bytes(SCRIPT.read_bytes())
            source = root / "data" / "meme_bot.db"
            db = sqlite3.connect(source)
            db.executescript("""
                CREATE TABLE tokens(id INTEGER PRIMARY KEY, currency TEXT, issuer TEXT);
                CREATE TABLE paper_trades(id INTEGER PRIMARY KEY, status TEXT);
                CREATE TABLE market_snapshots(id INTEGER PRIMARY KEY, price_xrp REAL);
                CREATE TABLE scores(id INTEGER PRIMARY KEY, total_score INTEGER);
                CREATE TABLE alerts(id INTEGER PRIMARY KEY, message TEXT);
                INSERT INTO tokens VALUES(1, 'TEST', 'issuer');
                INSERT INTO paper_trades VALUES(1, 'closed');
                INSERT INTO market_snapshots VALUES(1, 0.01);
                INSERT INTO scores VALUES(1, 42);
                INSERT INTO alerts VALUES(1, 'test');
            """)
            db.commit()
            db.close()
            original = source.read_bytes()
            result = subprocess.run(
                [sys.executable, str(root / "scripts" / SCRIPT.name)],
                capture_output=True, text=True, timeout=30
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(source.read_bytes(), original)
            target = sqlite3.connect(root / "data" / "meme_bot.recovery.db")
            self.assertEqual(target.execute("SELECT COUNT(*) FROM paper_trades").fetchone()[0], 1)
            self.assertEqual(target.execute("SELECT COUNT(*) FROM market_snapshots").fetchone()[0], 0)
            self.assertEqual(target.execute("SELECT COUNT(*) FROM scores").fetchone()[0], 0)
            self.assertEqual(target.execute("SELECT COUNT(*) FROM alerts").fetchone()[0], 0)
            target.close()

if __name__ == "__main__":
    unittest.main()
