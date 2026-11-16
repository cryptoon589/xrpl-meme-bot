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

### P0.5 LIVE entries are not wired correctly
`src/index.ts` registers `burstDetector.onBurst` only inside `if (paperTrader)`; in LIVE mode `paperTrader` is null. The scored LIVE branch does call `tradeExecutor.openTrade`, but its TDE input passes `walletXrpBalance: undefined`. `TradeDecisionEngine.runLivePreflight` interprets that as 0 and rejects every positive-size live entry requiring an XRP buffer. Hence the advertised snipe/momentum live routes are not release-ready even if MODE=LIVE is configured. Fix wiring, use fresh real wallet balances, verify with end-to-end testnet and account reconciliation before activating any live seed.

### P0.6 Executable quotes versus simulated price
PAPER buys/sells use observed spot price times a coarse capped price-impact estimate (max 10%). It does not verify actual quote-route min-out, fillable quantities, issuer transfer fee, missed/partial fill or price update at ledger inclusion. Closing a no-price position at entry-price fallback is not equivalent to a sell: if liquidity disappears, genuine realized losses may be far worse.

### P0.7 Learning readiness flag is not honored by runtime TP targets
`state/recommendations.json` from the forensic run says `autoApplyReady=false`, `tradesAnalyzed=847`, `overallWinRate=13.9%`, and `burstTp1Percent=8`. `RuntimeLearning.getTpTargets()` consumes those TP levels whenever the file exists, **without checking `autoApplyReady`**. `src/index.ts` calls `runtimeLearning.reload()` after every analysis regardless of approval and passes the returned targets into PAPER trades. `autoApplyReady` only gates `TradeAnalyzer.applyRecommendations()`, not these runtime parameters. Learned TP policy can therefore change despite failing the documented readiness gate. Freeze adaptive TP changes behind a separate opt-in and versioned forward-validation, including after restart.

### P0.8 Backtesting look-ahead and concurrency errors
`src/backtest/backtestEngine.ts` selects the closest snapshot within ±5min (which may be *after* the scored signal), assumes ideal TP/SL fills even across price gaps, and computes P&L without fees/slippage. It deletes `openPositions` inside the same score-record loop as soon as it projects the future exit, so max-concurrent-position handling does not represent time correctly. Results cannot validate an executable edge.

## Empirical PAPER forensic findings, 2026-11-16 00:21 UTC

Read-only production recovery DB output supplied by operator. 851 rows total: 847 closed, one open, three partial. Of 847 closed, 199 `force_close_no_price` ghost rows (23.5%); 648 reconstructable non-ghost closes. **Reconstructed trade P&L on this subset: -127.448 XRP; win rate 16.8%; profit factor 0.75.** This is a historical estimate, not an audited executable-live return. 648/648 reconstructed P&Ls differ from saved `pnl_xrp` by >0.001 XRP, with total -11.490 XRP difference (largely entry-fee accounting assumptions; do not edit historical rows). Only three closed trades in latest 30 days (+4.689 XRP) — no basis for claiming a new profitable regime.

By entry source: burst n=295 +121.148 XRP, PF 1.72, median -0.185 XRP; stream n=195 -29.710; momentum n=106 **-212.047 XRP** (median -1.401); scored n=31 -13.570; unknown n=21 +6.730. Burst's positive net with negative median implies winner concentration / high variance; quantify before retaining or scaling.

By exit: `kill_liq_drop` n=81 **-299.490 XRP** (average -3.697), `trailing_stop_profit` n=56 +271.844, `kill_no_followthrough` n=157 -38.040, `time_stop_loss` n=122 -20.760, `stop_loss` n=40 -36.048. Liquidity-collapse failures overwhelm large trailing winners. Need identify market regimes, pool reserve at entry, specific tokens, time-to-collapse and actual exitability; do not simply remove the exit rule (that could worsen loss).

The audit prints `reconstructed cash=-147.485 XRP` using **all** entry debits, including 199 ghost trades, and stored proceeds; the PAPER code's ghost-close bookkeeping and restart resets do not form a consistent finance ledger. This negative number is **NOT** a demonstrable cash balance or proof of margin debt. The corrected starting cash, all open risk and exact terminal NAV are not identifiable from these schema rows. Shadow-trade resolution unavailable (all four unresolved); historical scores/snapshots absent before Nov 15, so leakage-free replay over May–Nov trade history is not possible from compact DB.

`RuntimeLearning` consumes learned 8% burst TP1 even when `autoApplyReady=false`; mark historical adaptive outputs contaminated until accounting and ghost filtering repaired. Critically, the auto-learning report analyzed `847` closed records at `13.9%` win rate while the non-ghost forensic sample includes only `648` at `16.8%`: the raw learning sample is not the same economic trade population. Learn only from verified realized trade legs and explain sample filters.

`PaperTrader.checkAllOpenExits` currently invokes `closePosition` at entry price for positions unpriceable for >2 hours; this is not an executable exit. `closePosition` uses modeled proceeds and classifies as a ghost but still updates some trading counters/stats. A real wallet cannot be refunded automatically when an AMM is drained or unreachable. Ghost frequency is therefore a material tail-risk/exitability signal, not an innocuous bookkeeping exclusion.

Follow-up forensic script `scripts/audit_trade_edge_concentration.py` (audit branch) measures by month, profile, winner concentration, 81 liquidity-loss trades, top 12 winners/losers and partial entry-pool fields without changing the database. This is essential before choosing which signals to shadow-only or suppress.

## Concentration drilldown — 2026-11-16 00:35 UTC, read-only historical PAPER data

A subsequent operator-run forensic script found **58 trades with estimated losses of at least 50% totaling -341.787 XRP**, offset in part by **25 winners over +50% yielding +349.923 XRP**. The full sample's positive outcomes are very sparse and heavy-tailed. Source=burst n=295 estimated net +121.148 XRP, but removing its **three largest wins** flips burst to **-59.875 XRP**; removing just the largest reduces profit to +36.863 XRP. **Do not classify burst as a verified robust alpha source.**

Repeated historical CFH trades dominate the 12 largest individual losses (11 are CFH; worst is XPM). OLX appears repeatedly among biggest winners, alongside a PHNUX trade that gained an estimated **+84.286 XRP from a 3.75 XRP entry**, but had exit_reason=`kill_liq_drop` after ~1.6 min. This unusual outlier needs price-reserve and token-identity verification and executable sell quote reconstruction. **Ticker names alone do not prove unique issuer identity**. Use the enhanced `scripts/audit_trade_edge_concentration.py` (same audit branch) to show token+issuer pairs, quick reentry after losses, and all positive liquidity-drop exits. CI synthetic test passed.

The 81 historical `kill_liq_drop` trades were all `trade_profile=BURST_SCALP`, **but 55 have trade_source=momentum**, 18 burst, 5 stream, 3 scored. This is not a contradiction in the output: the current `PaperTrader.tryOpenTrade` explicitly assigns `profileName='BURST_SCALP'` for scored/stream entries, meaning a profile is *exit policy*, not entry source. Historical tags may reflect earlier code versions. Never use `BURST_SCALP` profile aggregates to claim burst *entry* profitability; retain separate source, profile and versioned entry signal.

The current `tryOpenBurstTrade` re-entry cooldown is held in `lastCloseTime`, an in-memory Map that is **not reconstructed after a restart**; the 10-minute rule may be circumvented by PM2 restarts. Scored/stream cooldowns use the same in-memory map (15m/2h conditional). With repeated large losses in CFH, add persisted *per-issuer* and *per-token+issuer* cooldown / drawdown guards, validated against historical event timing. Do not automatically blacklist all CFH ticker matches without issuer-level proof.

`kill_liq_drop` triggers based on pool reserve falling by a percentage relative to entry while the exit uses the latest price and the simplistic slippage model. Liquidity withdrawals can occur without an equivalent spot-price fall, and price may be stale or untradeable. The `kill_liq_drop` category must be evaluated using observed reserve changes, validated fillable sell quotes and proper token accounting.

## P1 — NEXT ENGINEERING PRIORITIES

### P1.1 Learning can overfit and some learned gates are unused
`src/analysis/tradeAnalyzer.ts` constructs recommendations from historical winners, permits small per-hour samples, joins a score as late as 5min *after* entry, and may auto-apply based on historical win rate without holdout/walk-forward testing. `RuntimeLearning.getPullbackThreshold`, `getConfirmBars`, and `isGoodTradingHour` are defined but not called from `src/index.ts`; take-profit targets and score weights are read, but not all advertised learning is actually executed. Learn only on economic outcomes and with walk-forward comparison versus frozen controls.

### P1.2 Entry decision size differs from executed PAPER size
`TradeDecisionEngine.decide` validates `sizeXRP`. Burst path passes this to `tryOpenBurstTrade`, but scored/stream path calls `tryOpenTrade` without passing authoritative TDE size. It runs a different Kelly/conviction formula. Risk/sizing gates can validate one size and simulate another.

### P1.3 New-launch gating contradicts the snipe objective
`PROFILES.NEW_LAUNCH` sets a minimum 300 XRP pool, `baseSizeXRP=3`, `scalePoolXRP=1000`; the default global `MIN_TRADE_XRP=5` then causes `TradeDecisionEngine.decide` to reject launches below approximately 1,667 XRP in pool reserve, even though the profile explicitly allows 300. Separately, `PaperTrader.tryOpenBurstTrade` hard-rejects any reserve below 500 XRP regardless of the NEW_LAUNCH profile. This makes many genuinely early low-liquidity launches impossible to enter in the advertised NEW_LAUNCH mode. Fix by giving each profile a coherent minimum executable size and measuring liquidity-adjusted expectancy; do not automatically reduce safety gates just to increase trade frequency.

### P1.4 Quote caches may be too stale for fast memes
`AMMPriceFetcher.getPrice` reuses a positive cached non-position price for 90 seconds and an open-position price for 15 seconds. The flag called `bypassNullCache` bypasses only *null* cache, not the positive price cache, even for launch entries that request a forced fetch. `onMomentumDetected` calls `getPrice` without forcing freshness. A 90-second-old momentum quote can turn a good-looking paper entry into a poor real fill. Introduce separate quote TTLs for watchlist (~30-90s), candidate (<2s target), and sell/buy execution (fresh validated or bounded quote age) plus coalescing/rate limits.

### P1.5 Exit latency and data freshness
PAPER exits generally run on periodic scans and orphan-position fetches; live trade monitor uses a 30-second interval. A meme can move far beyond TP/SL between observations, and stale quotes may generate optimistic exits. Add prioritized event-triggered position revaluation, quote freshness TTL, and latency histograms (stream→signal→decision→quote→submit→validated).

### P1.6 Coverage not actually 'any' meme token
A hot-set cap of ~300 tracked tokens and capped 10-page AMM ledger sweep limit full-market coverage. Separate cheap global event detection from expensive hot scanner: maintain broad indexed universe, dynamically promote unusual activity into a bounded hot set, guarantee open-position priority and evict cold tokens. Explicitly quantify universe coverage.

### P1.7 Exitability and issuer controls
`src/risk/riskFilters.ts` hardcodes `devDumping: false` and `liquidityRemoved: false`, and does not comprehensively enforce issuer freeze, deep freeze, clawback/transfer fees, wallet concentration or depleted pool trade depth. Fast flipping does not protect against an unable-to-sell token. Add exit simulation and issuer risk checks to *gates*, not retrospective warnings.

### P1.8 Monitoring overclaims 'live PnL'
`PaperTrader.getOpenPositionsSummary` uses `highestPriceSinceEntry` as a proxy for current price. This can display peak gains as if they are currently realizable. Distinguish high-water mark, fresh current bid/quote and marked-to-liquidation value.

### P1.9 Database history and learning contamination
The compact DB intentionally lacks most old scores/market snapshots; historical backtests from that database do not cover original 18GB training data. Training results should be versioned, timeframe-scoped and linked to code SHA/config so past regimes do not silently dominate.

### P1.10 Public health listener
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
