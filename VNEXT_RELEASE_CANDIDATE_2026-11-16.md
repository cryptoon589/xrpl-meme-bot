# Hunterix vNext PAPER release candidate — 2026-11-16

STATUS: INTEGRATED AND CI-TESTED; NOT DEPLOYED; NO LIVE TRADING.

This branch stacks on draft PR #6 (which stacks on PR #5, then PR #4), and integrates the separate temporary-loss-quarantine experiment from PR #3. PR #2 is audit-only.

## Improvements integrated
- Fee-adjusted PAPER accounting, atomic durable cash/inventory, correct partial + full exits, explicit inability to sell when no price is available, restart recovery.
- Versioned clean PAPER epoch and read-only preservation of original 851-trade recovery dataset / four historically unresolved open or partial PAPER positions.
- No unvalidated adaptive recommendations; training excludes ghost closes and post-entry scores.
- Fresh/time-bounded whale data, authenticated and operator-reviewed webhook with original whale wallet history preserved.
- Corrected burst first-price baseline, real verified AMMCreate and buyer confirmation (no blind new-pool entry), no LP-deposit-as-buy false signals.
- Reserve-aware PAPER entry, partial exit, full exit and full-size depth costs. Fee-unit/freshness guards. No on-chain execution promises.
- Single **operator-only permanent blacklist** with no automatic entries, and a separate temporary token+issuer loss quarantine (12h after >=50% losses; 24h after one collapse/unpriceable close; 72h after repeated collapses). Neither one adds entries to the permanent blacklist.
- Separate PAPER-only PM2 candidate, strict preflight and original recovery DB read-only position report.
- Compact snapshot retention on the versioned PAPER database; the 18GiB original history is untouched.

## Critical blockers: do NOT cut over yet

1. Original permanent blacklist must be verified by the operator. The repository does NOT prove the exact user-chosen tokens from direct user messages. A May 4 commit describes OCT/SHX/MXI/CORE as operator-confirmed *established, non-meme exclusions*, then explicitly removes XSPECTAR as a meme; the initial commit also removed guessed XRDOGE/XOGE/BEAR/BULL/FURY exclusions. On May 11, ARMY/LOVE were blocked due to no-price errors, not because they are rugs. **User clarification Nov 16: ARMY and LOVE are legitimate XRPL tickers and should NOT be permanently blacklisted. They remain eligible whenever their prices are obtainable and they meet normal temporary liquidity, issuer and risk checks.** A May 24 commit removed automatic ghost-exit blocking to avoid missing dormant winners. These commits provide history, not permission to migrate a list automatically. The manifest is deliberately NOT created. Do not insert ANY token without explicit user review. The file must use format hunterix-manual-blacklist-v1 and managedBy operator. An empty list in a schema example does not mean the user's actual list is empty.

2. The recovery database's four unresolved PAPER positions remain in the original database. The new epoch must NOT import, delete, refund, forcibly close or mark-to-market those positions. The script scripts/legacy_positions_report.py reads their status safely without a fake current price, and the original SQLite is never modified.

3. Avoid changing the current working tree or PM2 process directly: the original server has uncommitted files and active databases. Use a *separate* source tree/worktree. Take a SQLite online backup of the compact recovery DB for token seeding in the staged tree, never plain-copy an active .db without its WAL. The original giant 18GiB data/meme_bot.db must be left untouched.

4. The candidate runs ONLY as a separate vNext PM2 app, after the old hunterix-paper instance has been STOPPED. The new scripts/vnext_paper_entrypoint.sh refuses unsafe MODE, wallet seed, missing/manual blacklist, absent cash checkpoint or inventory, wrong DB, insufficient disk, unapproved operator manifest hash, and any still-running legacy PAPER instance. It requires explicit HUNTERIX_LEGACY_SOURCE_DB_PATH to the original compact recovery DB, NOT the staging backup.

## Safe preparatory commands (read-only; do not start or stop trading)

In a separate staged tree with its own data folder and a new SQLite online backup of the original compact DB:

- python3 scripts/prepare_paper_epoch.py --plan --output data/meme_bot.paper-epoch-20261116-vnext.db
- python3 scripts/legacy_positions_report.py --db /root/xrpl-meme-bot/data/meme_bot.recovery.db

Only AFTER the user manually approves the exact blacklist and the staged environment has been verified, use the explicit create-only flag for a new simulated 100 XRP benchmark. The create operation refuses an existing filename, copies only token IDs/issuers/currency codes, and never copies trades/positions/cash or learned recommendations.

- python3 scripts/prepare_paper_epoch.py --create --output data/meme_bot.paper-epoch-20261116-vnext.db --bankroll 100

Before any cutover, a read-only preflight with --initial-cutover checks zero prior epoch trades and all legacy positions. A strict PM2-startup preflight additionally checks the 64-character SHA256 fingerprint that the operator approved for the exact manual blacklist file, separate live legacy DB path, safe PAPER env flags, PM2 mutual exclusion and compiled artifacts.

- python3 scripts/vnext_preflight.py --epoch data/meme_bot.paper-epoch-20261116-vnext.db --legacy /root/xrpl-meme-bot/data/meme_bot.recovery.db --manifest state/manual_token_blacklist.json --initial-cutover

The PM2 config ecosystem.vnext.paper.config.cjs requires HUNTERIX_VNEXT_EPOCH_ID, HUNTERIX_LEGACY_SOURCE_DB_PATH, and HUNTERIX_OPERATOR_BLACKLIST_APPROVED_SHA256 in the deploying operator environment. Those fields are NOT filled with guesses and no secrets belong in Git. The startup script reruns fail-closed checks after every reboot or restart. Test against offline synthetic fixtures before the actual cutover.

At a reviewed cutover window: verify compact DB online backup and legacy positions, stop the OLD PAPER PM2 process (do not delete it), start the new PAPER PM2 process (never run both), check health/inventory/daily summary/Telegram, then change the daily reporting cron to the new explicitly named epoch. Rollback means STOP the new PM2 process BEFORE restarting the old one; preserve both histories.

## Known constraints

This is not yet evidence of a profitable strategy. Real AMM executable routing, fee-on-transfer tokens, freeze/authorization and stale-ledger issues can differ materially from the constant-product PAPER estimate. Whale observations are source-gated but not independently proven profitable. No LIVE activation. The historical PAPER sample was loss-making, with severe liquidity collapses and concentrated winners. Forward time-separated profitability, exit reliability and maximum drawdown have to be established before claiming an edge.

Dependency vulnerabilities observed in npm ci logs also require a focused lockfile/dependency review. Never run npm audit fix --force directly on the running VPS.

## Verification

GitHub Actions workflow .github/workflows/vnext-release-candidate.yml compiles, tests accounting/restarts, reserve-aware PAPER trades, burst/AMM launches, whale/webhook security, exact operator blacklist, learning controls, loss quarantine, PM2 entrypoint and full synthetic read-only cutover/rollback guards. No XRPL orders, real Telegram messages, source DB edits or deployed runtime changes are performed by CI.

## Historical chat-history cross-check and operator clarification

A search of past XRPL bot/Hunterix chat history found a general instruction to blacklist known rugs, and an April 2 preference to stop BTC/XRP pair tracking in favor of XRPL-native token/pool discovery. **Neither establishes an exhaustive token blacklist or authorization to exclude every stablecoin/L1/established project permanently.** No direct user message validating OCT/SHX/MXI/CORE as the permanent list was retrieved, despite the May 4 commit's operator-verified description. Treat those symbols as candidates for review, not as already approved bans. Do not auto-migrate them, or XRDOGE/XOGE/XSPECTAR/ARMY/LOVE. Do not convert any no-price, liquidity or issuer risk into a permanent manual blacklist.
