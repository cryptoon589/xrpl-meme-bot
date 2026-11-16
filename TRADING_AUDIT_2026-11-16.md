# Hunterix — Trading Integrity & Profitability Audit
Date: 2026-11-16
Source: GitHub `recovery/database-safety-20261114`, plus operator-supplied 5-minute and PM2 logs.
Status: **Code audit completed; empirical profitability audit pending read-only database output.**
This is an assessment, not a validated profitability claim. No production bot settings, orders, or database rows were changed.

## Objective
An XRPL meme trading engine must identify actionable moves early across the token universe, buy at *executable* prices, sell with positive *net* realized XRP after spread, AMM price impact, transfer fees and network fees, avoid unable-to-exit assets, and improve only from statistically supported *forward* performance.

## Operational facts (observed)
- Isolated dedicated transaction stream stopped the prior 1008 disconnects in a 300s probe; longer stability unknown.
- Post-fix diagnostics show 0 invalid-parameter AMM RPC errors in observed window; not-found errors remain.
- PM2 PAPER process and health endpoint showed both connections healthy; 330 tracked tokens as of one reading (note: scanner hot set hard cap 300).
- Disk expanded to 50 GB, ~26 GB free; snapshots verified.
- All 3,093 historical tokens archived, only active set scanned; 850 paper trades at archive verification with four open/partial then.
- Live wallet execution not tested or authorized.

## P0 — MUST FIX BEFORE RELYING ON P&L OR ENABLING LIVE TRADING

### P0.1 PAPER position accounting double scales remainder
`src/paper/paperTrader.ts` `partialClose` subtracts sold tokens from `position.tokensHeld`. Later `closePosition` calculates `position.tokensHeld * (trade.remainingPosition / 100)`. Those are *two* reductions of inventory. E.g. a 40% partial exit leaves 60 tokens; final sell incorrectly counts 36. The trade is marked fully closed despite unaccounted 24. This distorts realized P&L, fees and bankroll.

### P0.2 PAPER restart reconstructs the wrong inventory and cash
`loadState` / `loadOpenPositionFromDB`: rebuild `tokensHeld = entryAmountXRP / entryPriceXRP`; this ignores entry slippage and partially sold tokens. `loadState` sets cash to starting bankroll plus the most recent daily-summary P&L, ignoring prior days, open entry debits, partial proceeds and full trade cashflows. A restarted process may simulate different amounts of money and coins than it held before shutdown.

### P0.3 Reported P&L omits entry fees
Open paths debit `entryAmountXRP + 0.003 * entryAmountXRP`; `xrpReturned` already excludes modeled exit fees. Final `trade.pnlXRP = xrpReturned - entryAmountXRP` omits entry fees. Daily P&L, learned win/loss stats and reported profitable labels may therefore be biased. Historic fees may have used different model versions; do not blindly rewrite historic rows.

### P0.4 LIVE executor loses positions on reboot
`src/execution/tradeExecutor.ts` uses an in-memory Map without a persisted, reconciled on-ledger position journal. On restart, live XRP token balances can remain while risk-monitoring state vanishes. No live execution until wallet/trustline reconciliation, durable fill ledger and idempotent restart reconciliation exist.

### P0.5 Executable quotes versus simulated price
PAPER buys/sells use observed spot price times a coarse capped price-impact estimate (max 10%). It does not verify actual quote-route min-out, fillable quantities, issuer transfer fee, missed/partial fill or price update at ledger inclusion. Closing a no-price position at entry-price fallback is not equivalent to a sell: if liquidity disappears, genuine realized losses may be far worse.

### P0.6 Backtesting look-ahead and concurrency errors
`src/backtest/backtestEngine.ts` selects the closest snapshot within ±5min (which may be *after* the scored signal), assumes ideal TP/SL fills even across price gaps, and computes P&L without fees/slippage. It deletes `openPositions` inside the same score-record loop as soon as it projects the future exit, so max-concurrent-position handling does not represent time correctly. Results cannot validate an executable edge.

## P1 — NEXT ENGINEERING PRIORITIES

### P1.1 Learning can overfit and some learned gates are unused
`src/analysis/tradeAnalyzer.ts` constructs recommendations from historical winners, permits small per-hour samples, joins a score as late as 5min *after* entry, and may auto-apply based on historical win rate without holdout/walk-forward testing. `RuntimeLearning.getPullbackThreshold`, `getConfirmBars`, and `isGoodTradingHour` are defined but not called from `src/index.ts`; take-profit targets and score weights are read, but not all advertised learning is actually executed. Learn only on economic outcomes and with walk-forward comparison versus frozen controls.

### P1.2 Entry decision size differs from executed PAPER size
`TradeDecisionEngine.decide` validates `sizeXRP`. Burst path passes this to `tryOpenBurstTrade`, but scored/stream path calls `tryOpenTrade` without passing authoritative TDE size. It runs a different Kelly/conviction formula. Risk/sizing gates can validate one size and simulate another.

### P1.3 Exit latency and data freshness
PAPER exits generally run on periodic scans and orphan-position fetches; live trade monitor uses a 30-second interval. A meme can move far beyond TP/SL between observations, and stale quotes may generate optimistic exits. Add prioritized event-triggered position revaluation, quote freshness TTL, and latency histograms (stream→signal→decision→quote→submit→validated).

### P1.4 Coverage not actually 'any' meme token
A hot-set cap of ~300 tracked tokens and capped 10-page AMM ledger sweep limit full-market coverage. Separate cheap global event detection from expensive hot scanner: maintain broad indexed universe, dynamically promote unusual activity into a bounded hot set, guarantee open-position priority and evict cold tokens. Explicitly quantify universe coverage.

### P1.5 Exitability and issuer controls
`src/risk/riskFilters.ts` hardcodes `devDumping: false` and `liquidityRemoved: false`, and does not comprehensively enforce issuer freeze, deep freeze, clawback/transfer fees, wallet concentration or depleted pool trade depth. Fast flipping does not protect against an unable-to-sell token. Add exit simulation and issuer risk checks to *gates*, not retrospective warnings.

### P1.6 Monitoring overclaims 'live PnL'
`PaperTrader.getOpenPositionsSummary` uses `highestPriceSinceEntry` as a proxy for current price. This can display peak gains as if they are currently realizable. Distinguish high-water mark, fresh current bid/quote and marked-to-liquidation value.

### P1.7 Database history and learning contamination
The compact DB intentionally lacks most old scores/market snapshots; historical backtests from that database do not cover original 18GB training data. Training results should be versioned, timeframe-scoped and linked to code SHA/config so past regimes do not silently dominate.

### P1.8 Public health listener
`src/index.ts` uses `healthServer.listen(PORT)`, which listens on all interfaces by default. If the droplet firewall allows TCP/3000, telemetry/validation endpoints may be exposed. Bind to `127.0.0.1` by default and expose through an authenticated/secured proxy only if intentional.

## Proposed architecture
1. **Discovery lane:** transaction stream AMMCreate + swaps + OfferCreate + liquidity shifts; store immutable event times, issuer and raw currency; prioritize 0–30min launches, waking older assets and high-velocity token bursts.
2. **Candidate lane:** confirm organic new buyers, acceleration, XRP-buy imbalance, pool reserve/fee, historical microstructure, no wash activity; compare action price to prior high, avoid chasing exhausted spikes.
3. **Execution lane:** fresh quote per order, simulate effective buy/sell XRP after AMM/orderbook routing, transfer fee and ledger fee; max age and max price impact; reject if expected short-horizon edge < costs. Validate fills with transaction metadata.
4. **Exit lane:** prioritize positions over discovering more tokens; triggers on stream swaps and quote changes, ladder profits, trailing stops, failed follow-through, adverse liquidity shifts, timed exits, catastrophic inability-to-exit warnings.
5. **Risk lane:** bounded aggregate exposure and per-issuer exposure, position sizing conditional on validated expected edge, market price impact, honest stranded assets, daily *realized* drawdown and streak controls.
6. **Learning lane:** immutable trade-leg journal, shadow trades for rejected signals, leakage-free replay and walk-forward benchmarks, explicit model/config version; promote new parameter only if post-cost forward results improve with uncertainty interval.

## Success criteria before live-trading consideration
- Exact reproducible trade-leg accounting across partials/restarts, matching cash and inventory to DB.
- 100% of live-wallet balances reconciled to persisted positions; no orphan open coins after crash.
- 24–72 hour stable stream and scanner while position exits retain priority.
- End-to-end latency instrumentation, p50/p95/p99, under variable concurrency.
- Quotes, min-out, realized fills and issuer fees modeled; sensitivity tested at adverse slippage, delays and thin pools.
- Several non-overlapping forward periods with positive *post-cost* expectancy, not only win rate or hindsight TP fills.
- Controlled counterfactual comparison to unmodified baseline; reject overfit changes.

## Next evidence: run read-only data audit
Fetch only the audit scripts from branch `audit/trading-integrity-20261116` to the droplet and run:
```bash
cd /root/xrpl-meme-bot
git fetch origin audit/trading-integrity-20261116
git show FETCH_HEAD:scripts/audit_trading_integrity.py > scripts/audit_trading_integrity.py
git show FETCH_HEAD:scripts/audit_paper_accounting.js > scripts/audit_paper_accounting.js
python3 scripts/audit_trading_integrity.py
node scripts/audit_paper_accounting.js
```
Scripts read only the recovery database or use a disposable temporary database. The PM2 PAPER bot remains running; no source replacement, npm build, or restart is required.
