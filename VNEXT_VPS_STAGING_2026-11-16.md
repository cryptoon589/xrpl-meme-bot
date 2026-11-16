# Hunterix vNext: safe one-time VPS staging

**No old PAPER stop/restart, new PM2 start, LIVE trading, wallet transactions or cron edits in these steps.**
The DigitalOcean connector cannot run shell commands; the operator must run these commands in SSH on xrpl-bot.

## Phase 1 — separate Git worktree and coherent recovery snapshot

```bash
cd /root/xrpl-meme-bot &&
git fetch --no-tags origin release/hunterix-vnext-paper-20261116 &&
git worktree add --detach /root/hunterix-vnext-stage-20261116 FETCH_HEAD &&
cd /root/hunterix-vnext-stage-20261116 &&
python3 scripts/stage_vnext_safely.py --old-root /root/xrpl-meme-bot &&
python3 scripts/prepare_paper_epoch.py --plan --output data/meme_bot.paper-epoch-20261116-vnext.db
```

Run this block only ONCE and only if the staging directory does not already exist. `git worktree add` creates an isolated checkout from the just-fetched release commit while preserving the current working directory and all its uncommitted files. It uses the existing repo's GitHub credentials; it does not reset, pull or switch the running code. The script checks disk, manual blacklist, compact DB and PM2 state. Its sole DB write is a NEW SQLite online backup into the separate stage tree; it does NOT modify the live source recovery database, original 18GiB historical database, PM2 or Telegram.

Expected permanent exclusions: **OCT, SHX, MXI, CORE only**. ARMY and LOVE remain eligible subject to normal pricing and risk checks. The stage script displays the four-item file and SHA256; no wallet secrets are printed.

The original four legacy unresolved PAPER positions are printed and preserved, not copied into a clean epoch or refunded. Phase 1 only runs the --plan mode for epoch creation. If it fails, stop and share the error; do not reset or delete any DB.

## Phase 2 — build separately and verify the exact original VPS XRPL endpoint

Only after Phase 1 passes:

```bash
cd /root/hunterix-vnext-stage-20261116 &&
nice -n 10 npm ci --no-audit --no-fund &&
nice -n 10 npm run build &&
node scripts/test_army_pricing_and_blacklist.js &&
node scripts/diagnose_army_using_legacy_endpoint.js /root/xrpl-meme-bot
```

The diagnostic reads only XRPL_WS_URL from the original .env, never sources the shell file, and uses the old bot's config fallback URL when needed. It sends a single validated-ledger amm_info request for the exact XRP ARMY issuer/currency and prints PRICE_VALID or NO_PRICE. It makes no trades, no Telegram send, and no DB modifications.

## Future cutover remains separate and gated

After Phase 2 results, prepare a new simulated PAPER epoch with create-only mode and run vnext_preflight.py --initial-cutover. An operator-approved blacklist hash, Telegram configuration, old-position watcher and rollback procedure are mandatory before stopping old PAPER and starting vNext PAPER. Never run both simultaneously. Passing AMM pricing checks does not establish sellability or profits.

## Stage status and provider throttling diagnostic

Phase 1 succeeded on the original VPS: stage backup 851 trades, 896 tokens, **3** legacy unresolved PAPER positions (rCODE 15%, XRPB 40%, CORE 50%). Phase 2 build/fixture tests passed, but the original endpoint closed the ARMY WebSocket with `threshold exceeded`, consistent with documented XRPL server rate limiting. This is not a token blacklist or proven absent pool.

The next phase is **one read-only request against a separate documented public Mainnet provider**, from the staged checkout only. Do not repeatedly retry the old throttled endpoint. After fetching the latest release commit into the independent worktree and rebuilding, run:

```bash
XRPL_WS_URL=wss://xrplcluster.com timeout 30s node scripts/diagnose_army_price.js
```

The latest CLI reports rate-limit vs transport failure vs no-pool separately. vNext now requires a separately selected/pinned XRPL WebSocket URL, conservative RPC pacing, and 120s backoff for 1008. **Neither PM2 nor old .env should be edited during this check.** A successful spot quote is still not proof of executable sell liquidity.

## November 16 — ARM​Y price validation and account-prep stage

The operator has run the staged alternative-provider diagnostic on VPS and obtained a real validated AMM price for the exact popular XRP ARMY issue using `wss://xrplcluster.com`: ledger `108370699`, ARMY spot `0.00538925961512 XRP`, XRP-side reserve `233626.539831`, token reserve `43350396.2540`, AMM fee 0%. The same staged run passed RPC 1008 cooldown and both scanner/stream reconnect regressions. The original bot's previous endpoint returned `threshold exceeded`; this is a provider issue, not token unavailability. Use the separate working provider for PAPER evaluation only and continue monitoring stability.

**One more release-safety correction**: the disk low-space stop now includes the versioned epoch DB, and strict startup requires a minimal owner-only Telegram credential file with exactly two keys (token and chat ID). `scripts/prepare_vnext_telegram_env.js` can prepare that in the independent worktree without copying any wallet seed or full old `.env`; it is **explicit and never automatic**. The last offline CI run for both changes passed. Neither current PM2 nor any old database was changed.

Suggested next step, with NO PM2 changes: update only the independent staging worktree to the newest vetted release head, compile, run `node scripts/prepare_vnext_telegram_env.js /root/xrpl-meme-bot` in PLAN mode, then run `python3 scripts/prepare_paper_epoch.py --create --output data/meme_bot.paper-epoch-20261116-vnext.db --bankroll 100` to create a new simulated PAPER account. Explicit creation never overwrites. Use `python3 scripts/vnext_preflight.py --epoch data/meme_bot.paper-epoch-20261116-vnext.db --legacy /root/xrpl-meme-bot/data/meme_bot.recovery.db --manifest state/manual_token_blacklist.json --initial-cutover` to assess it read-only.

After a clean initial preflight, operator may explicitly run `node scripts/prepare_vnext_telegram_env.js --create /root/xrpl-meme-bot` to create the staged Telegram-only 0600 `.env`, which the vNext Node bot reads via `dotenv`. A *strict startup preflight* is designed to fail while old `hunterix-paper` is still ONLINE, and **that is intentional**. Do not stop the old process yet. A controlled migration plan must first cover the three legacy unresolved positions: rCODE 15%, XRPB 40%, and CORE 50%. Even blacklisted CORE must not be forcibly closed without a valid user-directed exit.
