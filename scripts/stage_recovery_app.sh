#!/usr/bin/env bash
# Stage recovery application code without switching databases or starting the bot.
set -euo pipefail
cd "$(dirname "$0")/.."
BRANCH="origin/recovery/database-safety-20261114"
if ! git rev-parse --verify "$BRANCH" >/dev/null 2>&1; then
  echo "FAIL: fetch recovery branch first"; exit 1
fi
if pgrep -af 'node.*(dist/index|ts-node.*src/index)' | grep -v 'pgrep -af' >/dev/null; then
  echo "FAIL: trading bot appears to be running"; exit 1
fi
if ! test -f data/meme_bot.recovery.db; then
  echo "FAIL: recovered database missing"; exit 1
fi
if ! python3 - <<'PY'
import sqlite3
db=sqlite3.connect('file:data/meme_bot.recovery.db?mode=ro',uri=True)
assert db.execute('PRAGMA quick_check').fetchone()[0]=='ok'
db.close()
PY
then echo "FAIL: recovered database integrity"; exit 1; fi
if ! git diff --quiet -- src/db/database.ts; then
  echo "FAIL: local edits in src/db/database.ts; manual review required"; exit 1
fi
mkdir -p recovery-backups
cp -p src/db/database.ts recovery-backups/database.ts.pre-recovery
git show "$BRANCH:src/db/database.ts" > src/db/database.ts
echo "Staged corrected database startup code; preserved scanner edits."
if npm run build; then
  echo "BUILD PASSED. Original database active path unchanged. Bot NOT started."
else
  echo "BUILD FAILED. Restoring previous database module."
  cp -p recovery-backups/database.ts.pre-recovery src/db/database.ts
  exit 1
fi
