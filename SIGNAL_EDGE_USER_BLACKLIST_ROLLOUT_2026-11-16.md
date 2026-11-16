# Hunterix — Signals, Whale Wallets, New Launches, Operator Blacklist
## 2026-11-16: staged, CI-only; not deployed

### Priority: user's permanent blacklist must include ONLY their manually added entries
Previous source code contains multiple distinct hard-coded exclusions (burst, discovery, scanning, trending and brand keyword filters). These were not one authoritative operator-managed list, and some were added programmatically. They have been removed from permanent-blacklist paths in this branch.

**Do not auto-migrate any static exclusions.** `src/risk/operatorBlacklist.ts` loads one operator-reviewed regular JSON file, `state/manual_token_blacklist.json`, or an explicitly named `HUNTERIX_MANUAL_BLOCKLIST_FILE`. Required schema:

```json
{
  "format": "hunterix-manual-blacklist-v1",
  "managedBy": "operator",
  "tokens": []
}
```

This is a **schema example only**, not a confirmed production list. No `state/manual_token_blacklist.json` has been created, and NO auto-detected token is permitted to enter it. Missing/invalid manifest fails startup closed; the branch **cannot be deployed as-is**. Operator must verify original manually chosen tokens against earlier discussions and current VPS configuration, then create the reviewed manifest. Supports exact `currency` plus optional `issuer`; a token name without issuer explicitly applies to all issuers only if the operator chose that. Source never writes the manifest. Existing open positions are NOT automatically liquidated merely because a token becomes manually excluded.

### Historical operator-intent breadcrumbs — NOT confirmed current blacklist
GitHub commit history shows:
- May 4 commit `2959436a` says it trimmed a generated list to operator-verified **OCT, SHX, MXI, CORE, XSPECTAR**; next commit `aa25ef78` explicitly **REMOVED XSPECTAR**, describing it as an XRPL meme.
- May 11 commit `ba23daec` inserted **ARMY and LOVE** in burst exclusions because of unpriceable pools. It is not established whether user requested them as permanent exclusions versus a temporary risk fix.
- May 24 commit `6b9c0b94` reverted automatic ghost-close-based token blacklisting, explicitly preferring no automatic bans.
- Broad generic stablecoin/L1 and brand-keyword exclusions existed elsewhere in the code but are **not proof of user selection**.

These are **candidates to review, not a migration set**. In particular, **XSPECTAR should NOT be silently re-added**. Do not treat a programmatic risk rejection or the 300-XRP pool threshold as a blacklisted token.

### Existing imported whale wallet list, kept intact
`state/top_traders_import.json` contains the prior imported FirstLedger radar wallet addresses (still preserved). Its `importedAt` is dated May 2025: the historic 70–95% win rates are far too old to justify current trading edge. New code maintains all known wallet identities and recorded history for review, but gives *current* trade boosts only to a deduplicated wallet with externally sourced win-rate/volume observations imported within 7 days. The file can be refreshed every five minutes without restarting. Simulated PAPER winning trades no longer create allegedly "validated" smart-money entry scores just because a wallet happened to buy the same token. This is a trust/calibration fix; not a performance forecast.

Webhook hardening now requires a 32+ character `WEBHOOK_SECRET` and binds to loopback unless `WEBHOOK_ALLOW_PUBLIC=1` explicitly authorizes public binding. Uploads are bounded to 64 KiB/100 wallets, checked for duplicates/format, and written atomically with restrictive permissions to a **separate** `state/top_traders_webhook.json`; the original `top_traders_import.json` is never overwritten. A webhook submission is labeled `operator_reviewed_webhook`, not a claimed FirstLedger API receipt. It only becomes a signal if an authenticated operator explicitly supplies `approvedForSignals: true` and an `observedAt` (Unix milliseconds) from the last seven days. Re-uploading old performance with a fresh `importedAt` cannot create a fresh trading signal. This does not prove claimed win rates; externally independently verified and forward-tested wallet outcomes are still necessary to establish predictive edge.

### Burst and new launch edge
- Burst detector preserves **first price** instead of overwriting the baseline; the late-pump check can now compare second/third burst to the original.
- New-launch age derives **only from observed, validated successful AMMCreate**, not bot process first-seen or reloaded tracked token.
- The previous blind buy 3 seconds after AMMCreate is removed: existence of a pool is not proof of demand. Register immediately; wait for at least two organic distinct buyers and the active burst checks.
- AMM deposits/withdrawals are liquidity management and no longer manufacture organic buy/sell pressure.
- New launch small PAPER probe (2–5 XRP) is opt-in `BOT_ENABLE_SMALL_LAUNCH_PROBES=1`; no automatic use in LIVE.
- User blacklist blocks burst alerts and entry routes before execution. High-frequency issuers are flagged for review but not permanently blacklisted.

### Opt-in reserve-aware PAPER trade pricing
`BOT_USE_RESERVE_QUOTES=1` in `MODE=PAPER` activates a full-size AMM constant-product reserve calculation with fresh quote age ≤15s and fee in XRPL units 1/100,000. The TDE temporarily REJECTS missing/stale/non-AMM data, excessive entry impact and round-trip loss. PAPER trader uses modeled AMM token quantity on entry, and XRP amount out on partial and final closes; stale quotes cannot mint proceeds or mark TP1 without an actual simulated fill. This is closer to size-dependent price impact than the old 10%-capped slippage model, but **not actual executable on-chain routing, validated fill receipts, transfer fees or issuer freeze authorization**. Do not claim profit based on it.

### Rollout gates
This branch is stacked on draft PR #5, which is stacked on PR #4. **Not merged, not deployed, no PM2 change, LIVE disabled, no active SQLite changes**. The original recovery DB has 851 historical trade rows and four unresolved positions, which do NOT migrate into a new PAPER epoch. Avoid deleting either historic database; a separate watcher/cutover is mandatory. In addition, the operator manual blacklist manifest is absent and intentionally makes this branch refuse to start.

Before any cutover, verify the exact user-only blacklist and wallet import provenance, preserve historic positions and SQLite backups, set a distinct versioned clean PAPER database, test the new flags and reconcile Telegram/webhook controls. Keep an unmodified legacy dataset for forensic comparisons.

### Automated tests
`.github/workflows/signal-blacklist-integrity.yml` compiles the TypeScript project and runs isolated tests for explicit-only blacklist, whales, validated AMMCreate, burst baseline, LP fake-buy exclusion, full-reserve PAPER execution and partial/restart accounting. Nothing trades, contacts XRPL, or sends Telegram.

### Latest CI
GitHub Actions signal-integrity workflow now additionally tests strict webhook authentication, loopback-only binding, bounded request size, atomic separate wallet file, manual-history preservation and performance-observation freshness. Passing offline CI proves these cases on synthetic inputs, not profitability or real-world wallet validity.
