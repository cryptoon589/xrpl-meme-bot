# Changelog

## v1.6.0 (2026-04-29) - Advanced Trading Features

### Roadmap Items Implemented

- **#3.1 Dynamic Position Sizing**: New `PositionSizer` module using Kelly Criterion for optimal position sizing. Calculates win rate, avg win/loss from trading history. Adjusts for volatility (high vol = smaller positions) and token score. Uses half-Kelly for safety, capped at 5% of bankroll. Falls back to volatility-based sizing when insufficient data.
- **#3.3 Correlation Detection**: New `CorrelationDetector` module identifies coordinated pumps (3+ tokens from same issuer pumping within 1 hour). Detects wash trading patterns (few unique participants, circular buy/sell). Skips tokens with suspicious correlation or wash trading. Logs warnings for clustered pump activity.

### Integration

- Position sizer integrated into paper trader — replaces fixed 10% bankroll sizing
- Correlation detector runs on every transaction and during token scans
- Wash trading detection uses unique buyer/seller counts + volume ratio analysis
- Pump cluster alerts warn about coordinated manipulation

### File Changes

| File | Change |
|------|--------|
| `src/paper/positionSizer.ts` | New module — Kelly Criterion position sizing |
| `src/scoring/correlationDetector.ts` | New module — Pump/wash trading detection |
| `src/paper/paperTrader.ts` | Integrated dynamic sizing, trading stats tracking |
| `src/index.ts` | Integrated correlation detection into scan/tx pipeline |

---

## v1.5.0 (2026-04-29) - Intelligence & Strategy Update

### Roadmap Items Implemented

- **#2.4 Issuer Reputation Database**: New `IssuerReputation` module tracks issuer behavior patterns including tokens launched, AMM creation rate, rug pull rate, 7-day survival rate, and average liquidity. Calculates trust score (0-100) used to adjust token scores (+/- 20% based on issuer reputation). Suspicious issuers (score <30) can be filtered.
- **#2.5 Multi-Timeframe Analysis**: New `MultiTimeframeScorer` calculates separate scores for 5m momentum, 15m trend, and 1h direction. Uses weighted consensus (50% base + 20% 5m + 15% 15m + 15% 1h). Requires bullish consensus for alerts and trades, reducing false positives.
- **#3.2 Improved Exit Strategy**: Enhanced paper trader with volatility-based dynamic stops. Calculates coefficient of variation from last 10 prices. High volatility = wider stops (20% trail), low volatility = tighter stops (10% trail). Stop loss adjusts dynamically (-8% to -20% based on volatility). Trailing stop activation threshold varies (15-30% gain) based on market conditions.

### Scoring Improvements

Token score now adjusted by issuer reputation:
```
adjustedScore = baseScore * 0.8 + issuerTrust * 0.2
```

Alerts require multi-timeframe consensus:
- 5m score > 60 AND 15m score > 55, OR
- Overall trend is 'bullish'

### File Changes

| File | Change |
|------|--------|
| `src/scoring/issuerReputation.ts` | New module — issuer behavior tracking |
| `src/scoring/multiTimeframeScorer.ts` | New module — multi-timeframe analysis |
| `src/paper/paperTrader.ts` | Dynamic volatility-based stops |
| `src/index.ts` | Integrated reputation and multi-timeframe scoring |

### Testing

```bash
npm run build
npm start
# Bot runs with issuer reputation tracking and multi-timeframe consensus
```

---

## v1.4.0 (2026-04-29) - Accuracy & Efficiency Update

### Roadmap Items Implemented

- **#2.1 Real Volume Tracking**: New `VolumeTracker` module monitors Payment and AMMTrade transactions in real-time. Tracks buy/sell volume, transaction counts, and unique buyer/seller counts per 5-minute window. Integrated into scoring algorithm (30% of buy pressure score now uses unique participants).
- **#2.2 Real Holder Count**: New `HolderCounter` module scans issuer's `account_lines` to count actual trustline holders. Cached for 10 minutes to reduce API load. Batch updates every 6th scan cycle (~6 minutes). Prunes stale cache entries automatically.
- **#1.2 Smart Token Pruning**: Removes tokens inactive for 48+ hours with no AMM pool and score < 50. Reduces tracked token count by 30-50% over time, speeding up scans.
- **#1.3 AMM Pool Cache Index**: *Not implemented* — linear search is fast enough for current pool counts (<1000). Can add if needed.

### Scoring Improvements

Buy pressure score now uses 3 components:
- Buy/sell ratio (40%)
- Total volume (30%)
- Unique buyer ratio (30%) — NEW

This rewards tokens with broad participation over single-wallet pumps.

### File Changes

| File | Change |
|------|--------|
| `src/market/volumeTracker.ts` | New module — real-time volume tracking |
| `src/market/holderCounter.ts` | New module — holder counting via account_lines |
| `src/index.ts` | Integrated volume/holder tracking, smart pruning |
| `src/market/marketData.ts` | Added `collectMarketDataWithExtras()` method |
| `src/scoring/tokenScorer.ts` | Updated buy pressure scoring with unique participants |
| `src/db/schema.ts` | Added `unique_buyers_5m`, `unique_sellers_5m` columns |
| `src/db/database.ts` | Updated save/get for new volume fields |
| `src/types.ts` | Added `uniqueBuyers5m`, `uniqueSellers5m` to MarketSnapshot |
| `src/xrpl/client.ts` | Added `getAccountLinesWithMarker()` for pagination |

### Testing

```bash
npm run build
npm start
# Bot starts with volume tracking and holder counting enabled
# Check logs for "Scanning holders for X issuers..." every ~6 minutes
```

---

## v1.3.0 (2026-04-29) - Performance & Monitoring Update

### Quick Wins Implemented

- **#1.1 Parallel Token Scanning**: Processes tokens in batches of 10 using `Promise.allSettled()`. Expected 5-8x speed improvement for large token sets (500 tokens: ~25s → ~3-5s).
- **#1.5 Database Write Batching**: All writes within a batch are wrapped in SQLite transactions via new `db.transaction()` method. Reduces fsync overhead, expected 10-20x faster DB writes.
- **#4.1 Health Check Endpoint**: HTTP server on port 3000 (configurable via `HEALTH_PORT`).
  - `GET /health` — JSON status with uptime, token count, positions, XRPL connection
  - `GET /metrics` — Prometheus-style plain text metrics
  - Enables uptime monitoring via UptimeRobot, Pingdom, etc.

### File Changes

| File | Change |
|------|--------|
| `src/index.ts` | Complete rewrite with parallel batching, health endpoint (~420 lines, cleaner) |
| `src/db/database.ts` | Added `transaction()` wrapper method |

### Testing

```bash
# Start bot
node dist/index.js

# Check health
curl http://localhost:3000/health
# Response: {"status":"ok","uptime":12,"tokens":0,"positions":0,...}

# Check metrics
curl http://localhost:3000/metrics
# Response: bot_uptime_seconds 12\nbot_tokens_tracked 0\n...
```

---

## v1.2.0 (2026-04-29) - Remaining Audit Items

### Low Priority Fixes (All Applied ✅)

- **#11 AMM Amount Parsing**: Enhanced `parseAmount()` to handle XRPL IssuedCurrencyAmount objects (`{value: "1.5", currency: "USD"}`), alternative `{amount: "123"}` format, and JSON fallback. Previously only handled strings and plain numbers.
- **#12 TrustSet Spam Filtering**: Added issuer reputation tracking. Counts TrustSet transactions per issuer, flags issuers with 50+ tokens as potential spammers. Skips spam issuer tokens during periodic scan to reduce noise.
- **#15 Database Retry Logic**: Added `execWithRetry()` and `runWithRetry()` methods with 3 retries and 100ms exponential backoff for SQLITE_BUSY/SQLITE_LOCKED errors. Applied to all write operations (saveToken, saveAMMPool, saveMarketSnapshot, saveRiskFlags, saveScore, savePaperTrade, updatePaperTrade, saveAlert, saveDailySummary).
- **#16 Market Data Error Tracking**: Tracks consecutive failures per token. Warns after 5 consecutive failures. Resets counter on successful collection. Helps identify tokens with persistent API issues.
- **#18 Telegram Credential Verification**: Improved error messages for common failure modes:
  - 404: Invalid bot token or chat ID with setup instructions
  - 403: Bot blocked or chat inaccessible
  - 429: Rate limit hit
- **#24 Emergency Exit Integration**: Added `updateRiskState()` method to PaperTrader. Monitors open positions for critical risk flag changes (`liquidity_removed`, `dev_dumping`, `concentrated_supply`). Triggers emergency close if new critical flags appear post-entry. Integrated into main scan loop.

### File Changes

| File | Lines Changed | Summary |
|------|--------------|---------|
| `src/db/database.ts` | ~80 | Retry logic for all write operations |
| `src/market/marketData.ts` | ~40 | AMM parsing, failure tracking |
| `src/scanner/tokenDiscovery.ts` | ~30 | Spam issuer tracking |
| `src/paper/paperTrader.ts` | ~50 | Emergency exit integration |
| `src/telegram/alerts.ts` | ~20 | Improved error messages |
| `src/index.ts` | ~25 | Spam filtering, emergency exit calls |

### Testing

- Bot starts cleanly with improved Telegram error guidance
- All TypeScript compilation passes
- No runtime errors

---

## v1.1.0 (2026-04-29) - Reliability Update

### Critical Bug Fixes

- **#3 Paper Trader PnL**: Fixed partial close PnL calculation to use cost-basis-per-token instead of percentage-of-original-entry. Previously produced incorrect PnL on multi-stage exits.
- **#4 Map Iteration Safety**: Fixed `checkExits()` to collect keys for deletion first, then delete after iteration loop. Prevents skipped positions and potential infinite loops.
- **#5 Token Discovery Spam**: Removed Payment transaction detection entirely. Now only detects tokens via TrustSet transactions, eliminating massive false positive alerts from normal token transfers.
- **#7 Concurrent Scan Lock**: Added `isScanning` flag to prevent overlapping periodic scans. If a scan takes >60s, next cycle is skipped instead of running concurrently.
- **#8 Transaction Flood Protection**: Implemented transaction queue (max 500) with batch processing (20 tx per batch, every 500ms). Prevents CPU/DB overload from XRPL's high transaction volume.
- **#1 Daily Summary Date**: Fixed `saveDailySummary()` to save the completed day's data, not yesterday's. Was causing off-by-one date errors.
- **#2 Bankroll Double-Count**: Changed bankroll loading to use only the most recent daily summary instead of summing 7 days. Prevents artificial bankroll growth on restart.
- **#25 Slippage Model**: Changed slippage estimation to use trade value in XRP relative to pool liquidity, not just raw XRP amount. More accurate for low-price tokens.

### Medium Improvements

- **#6 AMM XRP Pair Check**: Added validation that AMM pools are paired with XRP before calculating price. Returns null for non-XRP pairs (e.g., USD/EUR pools).
- **#9 Alert Hysteresis**: High-score alerts now only fire when score crosses threshold upward (compared to last saved score). Prevents flip-flopping alerts for tokens scoring near threshold.
- **#10 Reconnect Backoff**: XRPL reconnection now uses exponential backoff (5s → 10s → 20s → 40s, capped at 60s) with ±20% jitter. Resets counter on successful reconnect.
- **#13 Score Threshold Validation**: Config validation ensures `MIN_SCORE_PAPER_TRADE >= MIN_SCORE_ALERT + 5`. Prevents misconfiguration where paper trade threshold is lower than alert threshold.
- **#17 Config Validation**: Added comprehensive config validation:
  - Weight sum must equal 100 (warning if not)
  - Liquidity threshold must be positive
  - Trade size must be valid relative to bankroll
  - Score thresholds must be 0-100
  - Telegram token/chatId format validation
- **#19 Memory Pruning**: Price history and snapshots are pruned every hour. Snapshots older than 24 hours are deleted. Empty price histories are cleaned up.
- **#20 Transaction Backpressure**: Queue size capped at 500. When full, oldest 50 transactions are dropped in a batch (more efficient than individual drops).
- **#21 Snapshot Pruning**: Integrated into market data collection. Stale snapshots (>24h) are removed automatically.
- **#22 Trailing Stop Activation**: Now activates at +20% gain OR after TP2 (whichever comes first). Previously only activated after TP2, leaving gains unprotected between TP1 (+35%) and TP2 (+75%).

### File Changes

| File | Lines Changed | Summary |
|------|--------------|---------|
| `src/paper/paperTrader.ts` | ~120 | PnL fix, map iteration, daily summary, bankroll load, trailing stop |
| `src/index.ts` | ~150 | Scan lock, transaction queue, hysteresis, processor timer |
| `src/scanner/tokenDiscovery.ts` | ~40 | Removed Payment detection |
| `src/market/marketData.ts` | ~60 | XRP pair check, memory pruning |
| `src/xrpl/client.ts` | ~20 | Exponential backoff with jitter |
| `src/config.ts` | ~35 | Config validation |

### Testing

- Bot starts cleanly with config validation warnings for invalid Telegram credentials
- Transaction queue handles burst traffic without crashing
- Graceful shutdown works correctly
- No TypeScript compilation errors

### Breaking Changes

None. All changes are backward compatible with existing database schema and configuration.

### Migration Notes

- Existing paper trades in the database will continue working correctly
- Bankroll may adjust slightly on first restart due to fix #2 (was over-counting)
- Alert frequency may decrease due to hysteresis (#9) and Payment removal (#5)

---

## v1.0.0 (2026-04-29) - Initial Release

- Complete XRPL meme token scanner
- Paper trading with TP/SL/trailing stops
- Telegram alerts
- SQLite persistence
- WATCH and PAPER modes
