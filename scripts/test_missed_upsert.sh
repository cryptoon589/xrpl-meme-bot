#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
tmpdir="$(mktemp -d data/hunterix-upsert-test.XXXXXX)"
trap 'rm -rf "$tmpdir"' EXIT
cp data/meme_bot.recovery.db "$tmpdir/test.db"
export BOT_DB_PATH="$PWD/$tmpdir/test.db"
node <<'JS'
const { Database } = require('./dist/db/database');
const BetterSQLite3 = require('better-sqlite3');
const db = new Database();
const sig = {currency:'RECOVERY_TEST_CURRENCY',issuer:'RECOVERY_TEST_ISSUER',skippedAt:1763200000000,skipReason:'test',priceAtSkip:0.01,poolXrpReserve:100};
try {
  db.upsertMissedOpportunity(sig);
  db.upsertMissedOpportunity({...sig,maxPrice10m:0.02,pctGain10m:100});
} finally { db.close(); }
const raw = new BetterSQLite3(process.env.BOT_DB_PATH,{readonly:true});
try {
  const row=raw.prepare('SELECT COUNT(*) AS n, MAX(max_price_10m) AS p FROM missed_opportunities WHERE currency=? AND issuer=? AND skipped_at=?').get(sig.currency,sig.issuer,sig.skippedAt);
  if (row.n!==1 || row.p!==0.02) throw Error('UPSERT verification failed: '+JSON.stringify(row));
  if(raw.pragma('integrity_check',{simple:true})!=='ok') throw Error('integrity check failed');
  console.log('PASS: missed-opportunity UPSERT inserted and updated exactly one row');
} finally { raw.close(); }
JS
echo "Original and recovered databases untouched."
