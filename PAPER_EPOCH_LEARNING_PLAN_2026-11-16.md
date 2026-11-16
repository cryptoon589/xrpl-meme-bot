# Hunterix PAPER Epoch + Learning Integrity — 2026-11-16

## Purpose
Build a trustworthy **forward PAPER experiment** while preserving the existing corrupted/legacy 851-trade recovery history and its four unresolved open/partial trades. This branch is stacked on draft accounting PR #4; it is **not deployed**.

## Clean epoch preparation (offline script)

`scripts/prepare_paper_epoch.py`:
- Defaults to `--plan`: strictly read-only against the current `data/meme_bot.recovery.db`.
- `--create` requires an explicit NEW destination inside the `data/` directory with name `meme_bot.paper-epoch-YYYYMMDD[-tag].db`. Creation uses O_EXCL; no overwrite or deletion is possible.
- Reads the original compact DB via URI `mode=ro` (WAL-aware). Does not touch the historical 18 GiB `data/meme_bot.db`, PM2, Telegram credentials, or Git state.
- Copies **only token identities, issuer, dates and raw XRPL currency codes**. No old prices, snapshots, scores, analytics, shadow trades, alerts, historical trades, open/partial inventory, P&L or learning parameters are copied.
- Seeds new `paper_cash_state` with an explicit example initial **100 simulated XRP**, and records `paper_epoch_metadata`. The newly initialized accounting code maintains this exact checkpoint; this is not real capital or a backfilled historical cash balance.
- Old trades and **four existing positions remain in the unchanged source database**; they will **NOT** automatically appear or be managed in a fresh epoch. Operator must retain separate, read-only legacy reporting or fully reconcile those positions before a production cutover. Do not silently discard or count them as sold.
- Disposable synthetic tests verify read-only plan, no overwrites, original source hash unchanged, catalog preservation and a working `PaperTrader` with clean 100 XRP cash and zero inherited trades/positions.

**Example read-only preview (NOT an instruction to deploy):**
```bash
python3 scripts/prepare_paper_epoch.py --plan --output data/meme_bot.paper-epoch-20261116.db
```
A new epoch must not be started under the existing PM2 config: `scripts/recovery_paper_entrypoint.sh` and `ecosystem.recovery.paper.config.cjs` deliberately pin `BOT_DB_PATH` to `meme_bot.recovery.db`. A separate reviewed PM2 cutover and legacy position watcher are required. No parallel Telegram/strategy bot instances without isolation.

## Learning integrity safeguards

There are **three separate paths** that previously bypassed the learner's `autoApplyReady=false`: learned TP levels in `RuntimeLearning`, `TokenScorer.loadLearnedWeights()`, and 6h `TradeAnalyzer.applyRecommendations()`. Current historical data has 199 ghost closures and contaminated P&L; treating training WR as proof of edge would overfit.

- `TradeAnalyzer` now excludes `force_close_no_price` and joins **only the latest score available at or before trade entry**, not up to five minutes into the future. Analysis outputs advisory recommendations, not automatic policy approval.
- `isLearningApproved()` blocks adaptive settings by default; it requires `MODE=PAPER`, `BOT_ENABLE_VALIDATED_LEARNING=1`, an exact epoch ID, approved recommendation digest, post-training OOS period, at least 60 OOS trades, 100 training trades, OOS positive net with profit factor ≥1.2, current approval and the explicit `autoApplyReady` flag. The current analyzer writes `autoApplyReady=false` and **does not auto-issue OOS approval**. A separately verified validation process remains future work.
- Runtime TP, pullback, entry confirmation, time-of-day gating, scorer weights and JSON config auto-apply all use this single gate. Missing/malformed/changed recommendation files revert to fixed defaults.
- This does not guarantee profitable execution. Thresholds are *review triggers*, not proof of a competitive edge. A real walk-forward and time-split evaluation is still necessary.
- LIVE mode can never pass this adaptive PAPER approval gate.

## Reporting
The corrected `scripts/daily_report.py` from the Telegram audit is included and can read either `meme_bot.recovery.db` or an explicit versioned PAPER epoch. The new report distinguishes a verified spendable PAPER cash checkpoint from *total equity*, which includes unpriced open inventory. All reports state that prices/fills are simulated and LIVE trading is not certified.

**Do not change cron to the new epoch until a controlled cutover**: the currently installed daily cron still targets the recovery DB by default. Credentials must remain out of logs and repository.

## Reserve-aware AMM PAPER valuation improvement

`src/paper/ammExecutionQuote.ts` now contains independently tested full-reserve constant-product buy/sell estimates. The XRPL AMM fee `trading_fee` is correctly interpreted as an integer in units of **1/100,000** (0..1000 gives 0%-1%). No 10% artificial limit applies to the **reporting quote**: in a drained pool, selling the original token quantity can have >50% impact. All calculations use the current XRP and token reserves, not a past high-water mark or spot price multiplied by arbitrary trade size.

`AMMPriceFetcher` now tags newly obtained AMM/book quote observations with `observedAtMs`, preserved through caching. The Telegram hourly open-position display only estimates post-size AMM sale proceeds if the actual reserve quote was observed within **15 seconds** and PAPER cash is reconciled. A pure spot price, book fallback, or stale observation returns N/A instead of pretending a profitable exit. The display includes a simulated 0.3% extra execution overhead *separately* from the XRPL AMM trading fee, and labels quotes **non-executable**. Real token transfer fees, issuer freeze/authorization, cross-book routing, ledger latency and full transaction fill are **not** verified.

**Critically, the existing PAPER fill/exit algorithm still uses its simplified slippage model and 10% cap.** This phase improves reporting and provides the pure calculation module for the next engine refactor; it does **not** yet make stored PAPER P&L or strategy profitability executable. The next mandatory work is to pipe fresh pool-token reserves and fee units into all entry/exit decision paths and replace the optimistic fill assumptions with guarded reserve-aware estimates, including no-price failure handling.

CI regression `scripts/test_amm_sell_quotes.js` verifies fee scaling, full-size price impact, reserve-bounded XRP output and invalid input protection, without any network calls. Official reference: https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/path-and-order-book-methods/amm_info and https://xrpl.org/docs/concepts/tokens/decentralized-exchange/automated-market-makers .

## Tests, residual risks and deployment gate
CI: `.github/workflows/paper-epoch-learning.yml`. Tested using disposable databases and mock/offline operations. No live network, Telegram or on-chain transactions.

Before replacing a running PAPER instance:
1. Verify compact DB SQLite online backup and disk headroom; retain original 18 GiB DB unchanged.
2. Decide how to monitor and resolve four legacy open/partial positions independently. They are NOT migrated into the clean epoch.
3. Validate new epoch schema and initial cash in an isolated subprocess (MODE=PAPER, LIVE_TRADING=false, no seed, no Telegram), without overwriting current PM2 configuration or active DB.
4. Add exact-path guarded PM2 config and monitoring for the selected epoch. Avoid running two bots sending duplicate alerts against the same account or token set.
5. Update cron's `DAILY_REPORT_DB_PATH` only at cutover and monitor reports and runtime health. Keep rollback straightforward.
6. Implement accurate AMM executable sell quotes, issuer transfer restrictions, fill latency/cost, durable alert delivery and shadow/controlled A/B evaluation. Do not enable LIVE without extended post-cost positive forward results and incident/restart testing.

**Status: CI-tested code, not merged or deployed, no source database modified.**
