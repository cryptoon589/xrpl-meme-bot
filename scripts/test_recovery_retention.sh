#!/usr/bin/env bash
# Test observation retention and identity/trade safety on a DISPOSABLE copy only.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
test -f "$ROOT/data/meme_bot.recovery.db" || { echo "Recovery DB missing"; exit 1; }
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/data"
# SQLite online backup handles WAL safely even if any reader remains.
python3 - "$ROOT/data/meme_bot.recovery.db" "$tmp/data/meme_bot.recovery.db" <<'PY'
import sqlite3, sys
source = sqlite3.connect("file:" + sys.argv[1] + "?mode=ro", uri=True)
dest = sqlite3.connect(sys.argv[2])
source.backup(dest)
dest.close()
source.close()
PY
(
  cd "$tmp"
  BOT_ENABLE_OBSERVATION_RETENTION=1 MODE=PAPER LIVE_TRADING=false node - "$ROOT" <<'JS'
const assert = require('node:assert/strict');
const root = process.argv[2];
const DB = require(root + '/node_modules/better-sqlite3');
const { Database } = require(root + '/dist/db/database');
const path = process.cwd() + '/data/meme_bot.recovery.db';
const sql = new DB(path);
const preserved = Object.fromEntries(
  ['tokens', 'paper_trades', 'token_archive'].map(t =>
    [t, sql.prepare('SELECT COUNT(*) n FROM ' + t).get().n])
);
const now = Date.now(), aged = now - 9 * 86400000;
const tables = [
  ['market_snapshots', 'token_currency, token_issuer, timestamp', ['TEST', 'TEST_ISSUER', aged]],
  ['scores', 'token_currency, token_issuer, timestamp, total_score', ['TEST', 'TEST_ISSUER', aged, 20]],
  ['risk_flags', 'token_currency, token_issuer, timestamp', ['TEST', 'TEST_ISSUER', aged]]
];
for (const [t,cols,vals] of tables) {
  const stmt = sql.prepare('INSERT INTO ' + t + ' (' + cols + ') VALUES (' + vals.map(()=>'?').join(',') + ')');
  stmt.run(...vals);
  const recent = vals.slice(); recent[2] = now;
  stmt.run(...recent);
}
sql.close();
const db = new Database();
db.pruneRecoveryObservations();
db.close();
const after = new DB(path, { readonly: true, fileMustExist: true });
for (const [t] of tables) {
  const rows = after.prepare('SELECT timestamp FROM ' + t +
    " WHERE token_currency='TEST' AND token_issuer='TEST_ISSUER'").all();
  assert.deepEqual(rows.map(r=>r.timestamp), [now], t + ' aged row deleted, current row kept');
}
for (const [t, count] of Object.entries(preserved))
  assert.equal(after.prepare('SELECT COUNT(*) n FROM ' + t).get().n, count, t + ' unchanged');
assert.equal(after.pragma('quick_check', { simple: true }), 'ok');
after.close();
console.log('RETENTION TEST PASS: aged observations deleted, fresh kept, tokens/archive/trades unchanged');
JS
)
