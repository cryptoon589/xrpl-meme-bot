#!/usr/bin/env bash
# Controlled 90-second PAPER-only startup probe. No persistent service installed.
set -euo pipefail
cd "$(dirname "$0")/.."
test -f data/meme_bot.recovery.db || { echo "FAIL: recovery DB missing"; exit 1; }
test -f data/meme_bot.db || { echo "FAIL: original DB missing"; exit 1; }
if pgrep -af 'node.*dist/index.js' | grep -v 'pgrep -af' >/dev/null; then
  echo "FAIL: bot process already running"; exit 1
fi
if ! command -v timeout >/dev/null; then echo "FAIL: timeout unavailable"; exit 1; fi
mkdir -p recovery-backups
backup="recovery-backups/meme_bot.recovery.pre-start.$(date -u +%Y%m%dT%H%M%SZ).db"
cp data/meme_bot.recovery.db "$backup"
export BOT_DB_PATH="$PWD/data/meme_bot.recovery.db"
export MODE=PAPER LIVE_TRADING=false
unset TRADING_WALLET_SEED
echo "Recovery DB backed up: $backup"
echo "PAPER startup probe for 90 seconds; not starting a background service."
set +e
timeout --signal=INT --kill-after=10s 90s node dist/index.js > recovery-backups/paper-probe.log 2>&1
status=$?
set -e
echo "Process exit status: $status (124 means timeout reached)"
echo "Recent startup log:"
tail -n 35 recovery-backups/paper-probe.log
python3 - <<'PY'
import sqlite3
db=sqlite3.connect('file:data/meme_bot.recovery.db?mode=ro',uri=True)
assert db.execute('PRAGMA quick_check').fetchone()[0]=='ok'
print('Recovery DB integrity after probe: PASS')
db.close()
PY
echo "Original 18 GiB database path untouched; inspect logs before persistent launch."
