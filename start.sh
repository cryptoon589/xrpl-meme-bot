#!/bin/bash
# Supervisor script for xrpl-meme-bot
# Runs the bot, restarts on crash, logs to logs/bot.log

BOT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="$BOT_DIR/logs/bot.log"
mkdir -p "$BOT_DIR/logs"

echo "[supervisor] Starting xrpl-meme-bot from $BOT_DIR" | tee -a "$LOG"

while true; do
  cd "$BOT_DIR"
  echo "[supervisor] $(date -u +%Y-%m-%dT%H:%M:%SZ) Launching bot..." | tee -a "$LOG"
  node dist/index.js >> "$LOG" 2>&1
  EXIT_CODE=$?
  echo "[supervisor] $(date -u +%Y-%m-%dT%H:%M:%SZ) Bot exited with code $EXIT_CODE. Restarting in 10s..." | tee -a "$LOG"
  sleep 10
done
