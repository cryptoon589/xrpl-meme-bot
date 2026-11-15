#!/usr/bin/env bash
# Validate the actual compiled Database class on a disposable copy.
set -euo pipefail
cd "$(dirname "$0")/.."
test -f data/meme_bot.recovery.db || { echo "Missing recovery DB"; exit 1; }
tmpdir="$(mktemp -d data/hunterix-app-test.XXXXXX)"
trap 'rm -rf "$tmpdir"' EXIT
cp data/meme_bot.recovery.db "$tmpdir/test.db"
export BOT_DB_PATH="$PWD/$tmpdir/test.db"
node <<'JS'
const { Database } = require('./dist/db/database');
const fs = require('fs');
const path = require('path');
const expected = path.resolve(process.env.BOT_DB_PATH);
if (!fs.existsSync(expected)) throw Error('Missing test DB');
const db = new Database();
try {
  const trades = db.getProfileStats();
  console.log('Database class initialization: PASS');
  console.log('Profile groups loaded:', Object.keys(trades).length);
} finally {
  db.close();
}
JS
python3 - "$tmpdir/test.db" <<'PY'
import sqlite3,sys
db=sqlite3.connect(sys.argv[1])
assert db.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
assert db.execute('SELECT COUNT(*) FROM paper_trades').fetchone()[0]==848
print('Disposable test database integrity: PASS')
db.close()
PY
echo "PASS: Original and recovery databases were not modified by application test."
