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
