# Hunterix PAPER Accounting & Hourly Telegram Fix — 2026-11-16

## Scope and verification
- **Isolation:** `fix/paper-accounting-reporting-20261116`, based on `recovery/database-safety-20261114`. No merge, PM2 restart, database writes on VPS, or LIVE activation performed.
- CI workflow `.github/workflows/paper-accounting-recovery.yml` compiles TypeScript, runs synthetic disposable SQLite tests, and simulates Telegram success and transport failure with a local stub. Latest passing run: [43785530793](https://github.com/cryptoon589/xrpl-meme-bot/actions/runs/43785530793).
- Changes preserve `MODE=PAPER`; trading wallet and LIVE execution code are untouched.

## Fixed forward-going accounting defects
1. **Correct remaining inventory.** The old final close used `tokensHeld * remainingPosition/100` even though `tokensHeld` had already been reduced by partial sales. The new full close sells all remaining inventory. The new `paper_inventory` table checkpoints exact held units per trade on entry and every partial/final exit.
2. **Restart cash.** Prior `loadState()` used `startingBankrollXRP + latestDailySummary.totalPnLXRP`, losing partial proceeds, locked entry principal and older results. A new `paper_cash_state` table retains spendable PAPER cash. Entry and exit operations commit trade, inventory, and cash **atomically** via `Database.commitPaperMutation`.
3. **Correct realized P&L.** Closed trade `pnlXRP` includes simulated 0.3% entry fees; partial leg P&L deducts sold fraction of entry cost *and* matching entry fee. Partial reported `pnlXRP` is realized-only; unsold inventory is not booked as a loss.
4. **No phantom exit.** Positions with no price are retained. Emergency exit requests without price do not fabricate a 10% loss sale or credit cash. Any true sell is still a PAPER estimate, not a validated on-ledger swap receipt or executable order quote.
5. **Legacy position inventory fallback.** Historical open/partial trades with no `paper_inventory` checkpoint can reconstruct a provisional quantity from `entryAmountXRP/(entryPriceXRP*(1+entrySlippage)) * remainingPosition/100`. This is an estimate, flagged as not independently verified. The rows are not rewritten merely by startup.
6. **Telegram hourly report.** No highest-price-ever mark as a fake current quote. Fresh AMM spot quotes use the original XRPL raw currency code. Indicative P&L is shown only when an audited cash/inventory checkpoint exists; otherwise show N/A and `UNRECONCILED`. Such marks are NOT fillable sell quotes.
7. **Diagnostics delivery.** Separate cooldown keys for open-position and diagnostics notifications, boolean acknowledgment from TelegramAlerter, and reset diagnostic counters only on confirmed send. The close alert uses the corrected `trade.pnlXRP` rather than recalculating gross proceeds less entry principal.

## Critical rollout gate: existing 851-trade recovery database

The production compact recovery DB has 847 closed trades, 199 ghost closures, three partial and one fully open position. Its old cash state is **not reconstructable with assurance**: the operator's forensic report obtained a negative hypothetical cashflow and the old reported 94.91 XRP derived from a flawed daily summary method. **It would be unsafe to install the new code and silently declare that value verified.**

**Fail-closed behavior:** `ensureFreshPaperCashState()` creates an initial checkpoint only when the PAPER database contains **zero** historical `paper_trades`. On any pre-existing trade history without a checkpoint, `cashReconciled=false`: the process can read positions and process supported exits but **refuses all new PAPER entries**. The hourly report says `UNRECONCILED`; no authoritative bankroll is claimed. This is intentional. It prevents new strategy behavior from building on corrupted balances.

### Deployment decision
- Do **not** copy/merge/deploy this branch onto the running `hunterix-paper` instance yet. It would stop opening new PAPER trades on the current DB.
- Do **not** delete/reinitialize the original 18GB `data/meme_bot.db`, compact recovery DB, or the four existing positions.
- For a clean forward-running experiment, plan a **new versioned PAPER-only database**, a fresh baseline bankroll, and a separately preserved read-only archive of old trades and open positions. Alternatively, produce an operator-reviewed reconciliation using trustworthy cash and trade-leg evidence before bootstrapping the existing recovery DB. Never guess `94.91` XRP.
- Before rollout: create a SQLite online backup of the compact DB; validate all historical position IDs and recovery quantities read-only; run compiled candidate against an **isolated copy** with no Telegram credentials or LIVE wallet; require tests/health checks and a controlled restart plan.

## Known limitations intentionally left open
- Quotes/slippage are still simplified PAPER estimates. Real AMM order-size market impact, liquidity withdrawal timing, XRPL transfer fees, issuer restrictions, and on-ledger delivery are not validated. A 15s cached spot price is not guaranteed executable.
- Trades entered before this patch have unverifiable exact historical cash and may have inventory distortions from prior final-close code. No backfill or historical re-write is attempted.
- Historical daily-summary and learning rows are still contaminated by ghost closes and old fee handling. This PR does not certify profitability or fix the learner's readiness-flag bypass.
- The Telegram HTML chunker, 6h narrative analysis, and DAILY REPORT cron are separate surfaces. The latter was corrected independently and manually delivered earlier.
- The independent loss cooldown protection remains in separate **draft PR #3**; it is not combined or enabled here.
