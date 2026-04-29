# Quick Start Guide

## Project Summary

**XRPL Meme Token Trading Bot** — A 24/7 scanner for new XRPL meme tokens with paper trading simulation and Telegram alerts.

### What's Built

| Module | Status | Description |
|--------|--------|-------------|
| XRPL Client | ✅ Complete | WebSocket connection with auto-reconnect |
| Token Discovery | ✅ Complete | Detects TrustSet and Payment transactions |
| AMM Scanner | ✅ Complete | Monitors AMMCreate, AMMDeposit, AMMWithdraw |
| Market Data | ✅ Complete | Price, liquidity, spread calculation |
| Risk Filters | ✅ Complete | 8 risk flags evaluated per token |
| Token Scorer | ✅ Complete | 0-100 score with 7 weighted factors |
| Paper Trader | ✅ Complete | Simulated trades with TP/SL/trailing stops |
| Telegram Alerts | ✅ Complete | Formatted alerts for all events |
| SQLite Database | ✅ Complete | 8 tables with indexes |
| Config System | ✅ Complete | Environment variable based |

### Modes

- **WATCH**: Scan and alert only (default)
- **PAPER**: + simulated trades with tracked PnL
- **AUTO**: Falls back to WATCH (not implemented for safety)

## Setup (5 minutes)

### 1. Install dependencies
```bash
cd xrpl-meme-bot
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
# Edit .env with your values
```

Minimum required:
```env
TELEGRAM_BOT_TOKEN=your_token_from_botfather
TELEGRAM_CHAT_ID=your_chat_id
MODE=WATCH    # or PAPER
```

### 3. Run locally
```bash
npm run build
npm start
```

Or use the helper script:
```bash
./start.sh
```

## Deploy to VPS

### Option A: PM2 (recommended)
```bash
npm install -g pm2
npm run build
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

### Option B: systemd
See README.md for full systemd service file template.

## Switching Modes

**WATCH → PAPER:**
1. Stop the bot
2. Edit `.env`: `MODE=PAPER`
3. Restart

The bot preserves bankroll and open positions across restarts via the database.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Main entry point, orchestrates all modules |
| `src/config.ts` | Loads .env variables |
| `src/types.ts` | TypeScript type definitions |
| `src/xrpl/client.ts` | XRPL WebSocket wrapper |
| `src/scanner/tokenDiscovery.ts` | New token detection |
| `src/scanner/ammEvents.ts` | AMM event monitoring |
| `src/market/marketData.ts` | Price/liquidity calculations |
| `src/risk/riskFilters.ts` | Risk evaluation |
| `src/scoring/tokenScorer.ts` | 0-100 scoring |
| `src/paper/paperTrader.ts` | Simulated trading engine |
| `src/telegram/alerts.ts` | Telegram formatter |
| `src/db/database.ts` | SQLite wrapper |
| `data/meme_bot.db` | Persistent storage |

## Safety Notes

- No real trade execution
- No private keys in code
- AUTO mode disabled (falls back to WATCH)
- All XRPL queries are read-only
- Graceful shutdown on SIGTERM/SIGINT

## Known Limitations (MVP)

1. Holder count estimation returns null (needs trustline scanning)
2. Volume tracking returns zeros (needs transaction analysis)
3. Dev dumping detection is mock (needs issuer tx history)
4. Concentrated supply check is mock (needs distribution analysis)
5. Whitelist system not implemented

These are marked with TODO comments in the code.

## Testing

Quick connectivity test:
```bash
timeout 15 node dist/index.js
```

Expected output:
- Configuration printed
- "Connected to XRPL successfully"
- "Subscribed to transactions stream"
- "XRPL Meme Bot is running!"
- Graceful shutdown after timeout

## Support

For issues, check:
1. `logs/combined.log` for full logs
2. `logs/error.log` for errors only
3. Database integrity: `ls -lh data/meme_bot.db`
