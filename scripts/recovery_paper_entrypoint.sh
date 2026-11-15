#!/usr/bin/env bash
# Invoked by PM2 on every start/restart. Fail closed if PAPER safety is absent.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "${MODE:-}" != "PAPER" || "${LIVE_TRADING:-}" != "false" || -n "${TRADING_WALLET_SEED:-}" ]]; then
  echo "FATAL: PAPER-only environment not verified. Refusing Hunterix startup" >&2
  exit 1
fi
if [[ "${BOT_DB_PATH:-}" != "$PWD/data/meme_bot.recovery.db" ]]; then
  echo "FATAL: BOT_DB_PATH is not the compact recovery database" >&2
  exit 1
fi
if [[ "${XRPL_SEPARATE_STREAM:-}" != "1" || "${BOT_ENABLE_STARTUP_PRUNE:-}" != "0" ]]; then
  echo "FATAL: stream isolation or token deletion guard disabled" >&2
  exit 1
fi
if [[ "${BOT_ENABLE_RECOVERY_DISK_GUARD:-}" != "1" ]]; then
  echo "FATAL: runtime disk guard disabled" >&2
  exit 1
fi
if [[ ! -s "data/meme_bot.recovery.db" || ! -s "dist/index.js" ]]; then
  echo "FATAL: missing recovery DB or compiled bot" >&2
  exit 1
fi
free_kb="$(df -Pk data | awk 'NR==2 {print $4}')"
if [[ ! "$free_kb" =~ ^[0-9]+$ ]] || (( free_kb < 700 * 1024 )); then
  echo "FATAL: less than 700 MiB free disk; refusing startup" >&2
  exit 1
fi
exec node dist/index.js
