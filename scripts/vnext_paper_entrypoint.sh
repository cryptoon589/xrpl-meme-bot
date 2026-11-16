#!/usr/bin/env bash
# Separate vNext PAPER entrypoint. NEVER use for LIVE or wallet execution.
# Refuses startup while original hunterix-paper is online.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "${MODE:-}" != "PAPER" || "${LIVE_TRADING:-}" != "false" || -n "${TRADING_WALLET_SEED:-}" ]]; then
  echo "[vNext] FATAL: PAPER-only mode and no wallet seed required" >&2
  exit 1
fi
if [[ -z "${BOT_DB_PATH:-}" || -z "${HUNTERIX_MANUAL_BLOCKLIST_FILE:-}" || -z "${HUNTERIX_LEGACY_SOURCE_DB_PATH:-}" ]]; then
  echo "[vNext] FATAL: explicit epoch path and operator manifest required" >&2
  exit 1
fi
if [[ ! -s dist/index.js ]]; then
  echo "[vNext] FATAL: compiled application missing" >&2
  exit 1
fi
python3 scripts/vnext_preflight.py --strict-startup \
  --epoch "$BOT_DB_PATH" --manifest "$HUNTERIX_MANUAL_BLOCKLIST_FILE" \
  --legacy "$HUNTERIX_LEGACY_SOURCE_DB_PATH"
exec node dist/index.js
