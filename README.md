# XRPL Meme Token Trading Bot

A 24/7 XRPL meme-token scanner that detects new launches, early movers, AMM liquidity events, and suspicious rug-risk behavior. Features paper trading with tracked PnL and Telegram alerts.

## ⚠️ Important Safety Notes

- **ALERT MODE and PAPER TRADING ONLY** - No real trade execution
- AUTO mode is stubbed out and falls back to WATCH mode
- No private keys or wallet seeds in code
- All XRPL operations use read-only queries

## Features

- **Token Discovery**: Detects new tokens via TrustSet and Payment transactions
- **AMM Monitoring**: Tracks AMMCreate, AMMDeposit, AMMWithdraw events
- **Market Data**: Price, liquidity, volume, spread analysis
- **Risk Filtering**: Flags low liquidity, wide spreads, concentrated supply, dev dumping
- **Scoring System**: 0-100 score based on 7 weighted factors
- **Paper Trading**: Simulated trades with stop-loss, take-profit, trailing stops
- **Telegram Alerts**: Real-time notifications for high-score tokens and trade events
- **SQLite Database**: Persistent storage for all data

## Tech Stack

- Node.js + TypeScript
- xrpl.js v4 for XRPL connectivity
- better-sqlite3 for local database
- node-telegram-bot-api for alerts
- winston for logging

## Project Structure

```
src/
├── index.ts                 # Main entry point
├── config.ts                # Environment variable loader
├── types.ts                 # TypeScript type definitions
├── xrpl/
│   └── client.ts            # XRPL WebSocket client with auto-reconnect
├── scanner/
│   ├── tokenDiscovery.ts    # New token detection
│   └── ammEvents.ts         # AMM event monitoring
├── market/
│   └── marketData.ts        # Price, liquidity, volume calculation
├── scoring/
│   └── tokenScorer.ts       # 0-100 scoring algorithm
├── risk/
│   └── riskFilters.ts       # Rug-pull risk evaluation
├── paper/
│   └── paperTrader.ts       # Simulated trading engine
├── telegram/
│   └── alerts.ts            # Telegram notification formatter
├── db/
│   ├── database.ts          # SQLite wrapper
│   └── schema.ts            # Database schema definitions
└── utils/
    └── logger.ts            # Winston logger setup
```

## Setup

### Prerequisites

- Node.js 18+ installed
- Telegram bot token (from @BotFather)
- Your Telegram chat ID

### Installation

1. Clone/copy this project

2. Install dependencies:
```bash
npm install
```

3. Create `.env` file from example:
```bash
cp .env.example .env
```

4. Edit `.env` with your settings:
```env
XRPL_WS_URL=wss://rpc.xrplclaw.com/ws
TELEGRAM_BOT_TOKEN=your_bot_token_here
TELEGRAM_CHAT_ID=your_chat_id_here
MODE=WATCH
```

### Getting Telegram Bot Token

1. Message @BotFather on Telegram
2. Send `/newbot` and follow instructions
3. Copy the token provided

### Getting Your Chat ID

1. Message your new bot
2. Visit: `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`
3. Find your chat ID in the response

## Running Locally

### Development mode (with auto-reload):
```bash
npm run dev
```

### Production mode:
```bash
npm run build
npm start
```

## Running on VPS

### Using PM2 (recommended):

1. Install PM2:
```bash
npm install -g pm2
```

2. Build the project:
```bash
npm run build
```

3. Start with PM2:
```bash
pm2 start dist/index.js --name xrpl-meme-bot
```

4. Enable auto-restart on reboot:
```bash
pm2 startup
pm2 save
```

5. Monitor logs:
```bash
pm2 logs xrpl-meme-bot
```

### Using systemd:

Create `/etc/systemd/system/xrpl-meme-bot.service`:
```ini
[Unit]
Description=XRPL Meme Bot
After=network.target

[Service]
Type=simple
User=your_username
WorkingDirectory=/path/to/xrpl-meme-bot
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Then:
```bash
sudo systemctl enable xrpl-meme-bot
sudo systemctl start xrpl-meme-bot
sudo systemctl status xrpl-meme-bot
```

## Configuration

### Operating Modes

| Mode | Description |
|------|-------------|
| `WATCH` | Scan and alert only. No simulated trades. |
| `PAPER` | Scan, alert, AND simulate trades with tracked PnL. |
| `AUTO` | Stub only - falls back to WATCH for safety. |

### Switching from WATCH to PAPER Mode

1. Stop the bot
2. Edit `.env`: change `MODE=WATCH` to `MODE=PAPER`
3. Restart the bot

The bot will resume with existing bankroll and any open positions from the database.

### Key Configuration Options

| Variable | Default | Description |
|----------|---------|-------------|
| `MIN_LIQUIDITY_XRP` | 2000 | Minimum liquidity to consider a token |
| `MIN_SCORE_ALERT` | 75 | Score threshold for alerts |
| `MIN_SCORE_PAPER_TRADE` | 80 | Score threshold for paper trades |
| `STARTING_BANKROLL_XRP` | 500 | Paper trading starting balance |
| `MAX_TRADE_XRP` | 20 | Maximum size per trade |
| `MAX_OPEN_TRADES` | 3 | Maximum concurrent positions |
| `MAX_DAILY_LOSS_XRP` | 50 | Daily loss limit before stopping |

### Scoring Weights

The total score (0-100) is calculated from:

| Factor | Weight | Description |
|--------|--------|-------------|
| Liquidity depth | 20% | More liquidity = higher score |
| Holder growth | 15% | Growing holder base |
| Buy pressure | 20% | Buy/sell ratio and volume |
| Volume acceleration | 15% | Increasing transaction activity |
| Dev wallet safety | 15% | No dumping or red flags |
| Whitelist boost | 10% | Manual verification bonus |
| Spread/slippage | 5% | Tighter spread = better |

## Paper Trading Mechanics

### Entry Conditions
- Score >= `MIN_SCORE_PAPER_TRADE` (default 80)
- Passes critical risk filters (liquidity, spread)
- Under max open trades limit
- Under daily loss limit
- Sufficient bankroll

### Exit Strategy
- **Stop Loss**: -10% from entry
- **Take Profit 1**: Sell 40% at +35%
- **Take Profit 2**: Sell 30% at +75%
- **Trailing Stop**: Remaining 30% trails 15% below highest price
- **Emergency Exit**: Risk filter triggers post-entry

### Tracking
- Entry/exit price and timestamps
- Entry/exit scores and reasons
- Slippage estimates
- Fees (0.3% per trade)
- PnL in XRP and percentage
- Win rate, max drawdown, daily summaries

## Alert Types

The bot sends Telegram alerts for:

- 🆕 New token detected
- 🔥 High score token (>= 75)
- 🏊 New AMM pool created
- 💧 Liquidity added/removed
- 🐋 Whale buy detected
- 🚨 Dev wallet sell
- 📈 Paper trade opened
- 📊 Paper trade partially closed
- ✅/❌ Paper trade closed
- 📋 Daily PnL summary

### Alert Format Example

```
🔥 HIGH SCORE TOKEN

Token: MEME
Issuer: rABC123...
Score: 85/100
Liquidity: 5234.50 XRP
Price: 0.00001234 XRP
5m change: +12.50%
15m change: +25.30%
1h change: +45.00%
Holders: 150
Buy pressure: 25 buys / 8 sells
Risk flags: none
Action: HIGH SCORE - Eligible for paper trading

Links:
• Token: https://livenet.xrpl.org/accounts/rABC123...
• Issuer: https://livenet.xrpl.org/accounts/rABC123...
```

## Database

SQLite database stored at `data/meme_bot.db` contains:

- `tokens`: All discovered tokens
- `amm_pools`: AMM liquidity pools
- `market_snapshots`: Historical price/liquidity data
- `risk_flags`: Risk assessment history
- `scores`: Token scoring history
- `paper_trades`: All simulated trades
- `alerts`: Alert history
- `daily_summaries`: Daily PnL summaries

## Logging

Logs are written to:
- `logs/combined.log`: All log levels
- `logs/error.log`: Errors only
- Console: Colored output during runtime

Log level controlled by `LOG_LEVEL` env var (debug, info, warn, error).

## Limitations & TODOs

### Current MVP Limitations

1. **Holder count estimation**: Returns null - requires scanning all trustlines for an issuer
2. **Volume tracking**: Returns zeros - requires transaction-level analysis
3. **Dev dumping detection**: Mock implementation - needs issuer transaction history
4. **Concentrated supply**: Mock - needs trustline distribution analysis
5. **Whitelist system**: Not implemented - manual boost always returns 0

### Future Improvements

- [ ] Real holder counting via account_lines iteration
- [ ] Transaction-based volume tracking
- [ ] Issuer wallet monitoring for dump detection
- [ ] Trustline distribution analysis
- [ ] Manual whitelist management UI
- [ ] Backtesting engine
- [ ] Multi-chain support
- [ ] Web dashboard for monitoring

## Safety Reminders

- Never share your wallet seed or private key
- This bot does NOT execute real trades
- Paper trading results are simulations only
- Always verify token contracts before investing
- DYOR - This tool provides data, not financial advice

## License

MIT
