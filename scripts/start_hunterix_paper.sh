#!/usr/bin/env bash
# Guarded one-time service activation. Does not run pm2 save or alter boot startup.
set -euo pipefail
cd "$(dirname "$0")/.."
if ! command -v pm2 >/dev/null; then echo "FAIL: PM2 not installed"; exit 1; fi
if [[ ! -s data/meme_bot.recovery.db || ! -s data/meme_bot.db || ! -s dist/index.js ]]; then
  echo "FAIL: missing source DB, recovery DB or compiled application"; exit 1
fi
if [[ ! -f ecosystem.recovery.paper.config.cjs || ! -f scripts/recovery_paper_entrypoint.sh ]]; then
  echo "FAIL: PAPER deployment files absent"; exit 1
fi
if pgrep -af 'node.*dist/index.js' | grep -v 'pgrep -af' >/dev/null; then
  echo "FAIL: another Hunterix bot process is already running"; exit 1
fi
if pm2 describe hunterix-paper >/dev/null 2>&1; then
  echo "FAIL: hunterix-paper already exists in PM2; inspect it rather than starting another"; exit 1
fi
free_kb="$(df -Pk data | awk 'NR==2 {print $4}')"
if [[ ! "$free_kb" =~ ^[0-9]+$ ]] || (( free_kb < 700 * 1024 )); then
  echo "FAIL: insufficient free disk (<700 MiB)"; exit 1
fi
python3 - <<'PY'
import sqlite3, sys
p = "data/meme_bot.recovery.db"
con = sqlite3.connect(f"file:{p}?mode=ro", uri=True, timeout=5)
try:
    assert con.execute("PRAGMA quick_check").fetchone()[0] == "ok", "DB quick_check failed"
    assert con.execute("SELECT COUNT(*) FROM token_archive").fetchone()[0] >= 3093, "archive incomplete"
    assert con.execute("SELECT COUNT(*) FROM paper_trades").fetchone()[0] >= 850, "paper trades missing"
    print("PAPER preflight PASS: archived tokens and paper trades preserved", flush=True)
finally: con.close()
PY
echo "Starting one guarded PAPER-only Hunterix instance; no boot-persistence changes."
pm2 start ecosystem.recovery.paper.config.cjs --only hunterix-paper
pm2 describe hunterix-paper
echo "Use: pm2 stop hunterix-paper  (stops safely without removing it)"
echo "After validation, consider pm2 save if reboot persistence is desired."
