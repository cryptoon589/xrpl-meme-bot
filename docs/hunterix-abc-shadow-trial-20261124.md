# HUNTERIX – A/B/C shadow strategy research protocol (2026-11-24)

**Research only.** Active HUNTERIX remains entry-frozen in PAPER; STREAM is shadow-only. This study is **not a deployed trading strategy** or proof of profitability.

## Objective

Determine whether **pre-entry momentum quality** improves modeled net XRP returns and return per XRP committed **without losing the best runners**. Determine whether 1/2/5 XRP adaptive sizing improves results compared with fixed 5 XRP on the same momentum-confirmed candidates.

## Prospective data

The observations come from:
- **paper_opportunity_events:** exact raw currency and issuer, time-stamped burst_seen / momentum_seen before trade decision. These events are **not approved orders**.
- **market_snapshots:** observed price changes, 5m buy/sell volume, number of trades and unique buyer count; historically keyed by display name, only linked through exact raw-currency+issuer token registration.
- **paper_amm_reserve_evidence:** independently observed complete source AMM XRP/token reserves and fee units, collected since V2.1.5.
- **meme_evidence_refreshed:** positive provider tag event within 45m preceding a candidate. Operator-approved tokens without a logged provider tag may be excluded. This does not exhaust the eligible universe.
- **include-untagged option:** *exploratory only*. It never authorizes real or PAPER trading.

## Hypotheses frozen BEFORE analyzing returns

For signal cohort, use the first source event after 70m cooldown with a complete AMM reserve observed within 90 seconds before signal and market features observed within 120 seconds before signal. Scanner cohort uses the first market snapshot after a reserve fetch, up to 90 seconds later. No features from later than candidate time are permitted.

| Arm | Rules |
|---|---|
| A – **AMM-depth proxy, NOT actual deployed TDE** | At least 500 XRP on AMM XRP side; at 5 XRP buy, entry impact at most 4%, immediate modeled round-trip loss at most 12%. Every such reference candidate models 5 XRP. |
| B – momentum quality | Same opportunities and 5 XRP size as A, additionally 5m price change 1–20%, 15m change 0–60%, at least 3 buys from 3 distinct wallets, >=5 XRP 5m buy volume, and buy volume >=1.5 times max(1 XRP, sell volume). |
| C – adaptive capital | Exactly B's selected issues, 5 XRP on deepest/highest-breadth signals (XRP reserve >=3000, >=5 buyers, >=6 buys, buy/sell ratio >=2.5, 5m move <=12%); otherwise 2 XRP if reserve >=900 with >=3 buyers; otherwise 1 XRP. C never authorizes extra trades. |

These B/C thresholds are initial research hypotheses, **not** validated strategy parameters. Missing price history is classified as missing feature evidence. This may exclude newly launched tokens; it must not be presumed beneficial.

## Forward observations

Evaluate exactly the same candidate source+issuer at +10m, +30m and +60m, using the first complete AMM reserve within [target, target+5 minutes]. Exclude all missing future quote cases from P&L denominators for **all arms**; report missing counts separately. The quote model uses constant-product math and each side's AMM fee plus nominal 0.3% additional simulated overhead per leg.

Important: recorded future AMM reserves were measured without our hypothetical trade. This does **not** reconstruct fillable trades or live transfer fees, routes, rival orders, partial exits, or a price path. The 10/30/60m research exit is not HUNTERIX's actual trailing/kill-switch exit.

Compare each arm's net XRP, return per XRP deployed, win rate, profit factor, peak-to-trough modeled loss, average size, and opportunities selected. A higher win rate after taking only two trades is **not** established profitability.

## Historical sanity check

The **audit_abc_historical_quality.js** report applies B's pre-entry features only to the subset of already closed PAPER trades having a timestamped, issuer-verified earlier market snapshot. It reports the recorded historical P&L of retained/excluded trades and the share of historical winners retained. It cannot revalue C, replay skipped trades, or claim returns available to a new portfolio. No conclusions from post-entry snapshots or name-only issuer aliases.

## Go/no-go research gates

1. Offline CI passes; no PIN mismatch, raw-issuer cross-match, future-feature leakage, database mutation, or missing-price fill.
2. Keep the running bot flat, entry-frozen and STREAM shadow-only. Run the diagnostics from a separate pinned review worktree; do not deploy a new bot.
3. Report matched reserve/feature completeness before drawing any strategy conclusion.
4. Preserve a later chronological, out-of-sample observation period. Changed thresholds need a newly accrued future period, not retesting the same winning samples.
5. Target at least 100 distinct matched opportunities across several market days before considering a parameter trial; this is a working research milestone, not a guarantee of statistical confidence or future profitability. Assess instrument diversity, missingness, tail losses and opportunity/winner retention.
6. No automatic parameter change, real wallet use, classification bypass, liquidity relaxation, or PAPER unfreeze. A future executable experiment needs a **separate reviewed release and operator action**.

### Example (separate review checkout, existing DB)

    node /root/hunterix-abc-review-20261124/scripts/audit_abc_shadow_edge.js /root/hunterix-vnext-stage-20261116/data/meme_bot.paper-epoch-20261116-vnext.db --cohort=signals --hours=72 --limit=2000

    node /root/hunterix-abc-review-20261124/scripts/audit_abc_shadow_edge.js /root/hunterix-vnext-stage-20261116/data/meme_bot.paper-epoch-20261116-vnext.db --cohort=scans --hours=72 --limit=2000

    node /root/hunterix-abc-review-20261124/scripts/audit_abc_historical_quality.js /root/hunterix-vnext-stage-20261116/data/meme_bot.paper-epoch-20261116-vnext.db --from-id=72

**Discovery, eligibility, quote coverage, executable entry, and future profitability are separate conditions.**
