#!/bin/bash
# Supervisor script for xrpl-meme-bot
# Runs the bot, restarts on crash, logs to logs/bot.log

BOT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="$BOT_DIR/logs/bot.log"
LOCKFILE="$BOT_DIR/logs/supervisor.lock"
mkdir -p "$BOT_DIR/logs"

# Prevent duplicate supervisor instances
if [ -f "$LOCKFILE" ]; then
  OLD_PID=$(cat "$LOCKFILE")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    echo "[supervisor] Already running (PID $OLD_PID). Exiting."
    exit 1
  fi
fi
echo $$ > "$LOCKFILE"
trap "rm -f '$LOCKFILE'" EXIT

# Kill any orphaned bot process still holding port 3000
fuser -k 3000/tcp 2>/dev/null && echo "[supervisor] Freed port 3000" | tee -a "$LOG"

echo "[supervisor] Starting xrpl-meme-bot from $BOT_DIR (PID $$)" | tee -a "$LOG"

while true; do
  cd "$BOT_DIR"
  echo "[supervisor] $(date -u +%Y-%m-%dT%H:%M:%SZ) Launching bot..." | tee -a "$LOG"
  node dist/index.js >> "$LOG" 2>&1
  EXIT_CODE=$?
  echo "[supervisor] $(date -u +%Y-%m-%dT%H:%M:%SZ) Bot exited with code $EXIT_CODE. Restarting in 10s..." | tee -a "$LOG"
  sleep 5
  fuser -k 3000/tcp 2>/dev/null # free port before next launch
  sleep 5
done
