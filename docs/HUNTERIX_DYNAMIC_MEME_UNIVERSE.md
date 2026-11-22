# HUNTERIX — Dynamic XRPL Meme Universe (PAPER)

Status: DESIGN CONTRACT / NOT DEPLOYED. Running vNext remains locked to exact ARMY and DROP issue approvals. Do not change the user's separate four-token permanent blacklist.

## Product objective

Trade MOMENTUM in any qualifying XRPL meme coin, not a manually curated list. Markets eligible for screening:
- NEW_LAUNCH: new pools with independent validated buys after pool creation.
- BREAKOUT: established memes with sustained buy-pressure/volume/price acceleration.
- REVIVAL: old and dormant memes with credible renewed unique buyers and fresh liquidity.
- BURST: sudden validated buyer activity, distinguishing wallets and wash patterns.
- RUNNER: continued momentum after prior profit-taking, with cooldown and exposure limits.

An asset's popularity, age, market cap, project affiliation, or inclusion in an initial list does not confer entry priority. Classification makes a token eligible for risk assessment; it never directly triggers a buy.

## Dynamic classification (issuer + raw currency)

XRPL IOUs have no authoritative meme/not-meme flag. Never conclude a token is a meme just because its price rises, a ticker sounds funny, or it launched through a particular platform.

Classifications: MEME_CONFIRMED, MEME_LIKELY, NON_MEME, UNKNOWN. Preserve source, issuer, original 3-char or raw-hex currency, original category value, observedAt, expiry, evidence and reason.

Evidence sources:
- Documented XRPL.to API /v1/tokens and tag=Memes filter and /v1/tags; preserve exact issuer+currency. API docs: https://xrpl.to/docs/tokens/get-tokens (public endpoint is documented as no-key; production access/usage terms, provider attribution, partner and rate limits must be reviewed; contact hello@xrpl.to about bulk use).
- XRPL Meta token metadata where source and issuer can be verified, or other credible category metadata with source provenance.
- A brand-new meme not yet indexed: independent positive meme-type metadata or community/site evidence tied to an exact issuer AND validated on-ledger launch and buyer observations. Launchpad origin alone is insufficient. Implement a safe lower-confidence PAPER path only after tests; until then mark it as candidate/review.

Hard negatives: stablecoins/fiat-pegs, XRP native, BTC ETH SOL and wrapped variants, payment rails, utility/DeFi infrastructure, RWA, issuer impersonation; handle 40-hex aliases and ambiguous standard 3-character XRPL codes carefully.

UNKNOWN and provider outage must not authorize new entries automatically. Keep existing open positions and exit processing intact. Positive evidence is evaluated automatically, without manually entering each meme into a static allowlist. Manual exact-issue approvals can remain a secondary override.

## Scanner redesign

Actual code index.ts:startPeriodicScan caps working set at MAX_TRACKED_TOKENS=300, while discovery lists 10k+ assets. Replace naive lastUpdated slicing with a BOUNDED ROTATING PRIORITY QUEUE:
- Open position exits receive priority and their market quotes must remain available.
- High momentum classified memes receive fast scans.
- New launches get a separate watch queue and validated-buy confirmation.
- Revival candidates get a rolling quiet-to-active comparison and fair opportunity to be rescanned.
- Older established memes rotate through cheaper observations.
- Do not spend AMM/account_lines/book_offers requests on thousands of inactive/non-meme assets.

Maintain the existing 2 inflight, 3/s XRPL public node guards or tune downward based on observed quota failures. Batch category-provider queries; cache by issuer/raw code with expiry; use circuit breaker/backoff, avoid hammering providers after quota errors. Telegram should report discovered / classified / eligible / actively scanned / signals / risk rejected / opened, plus reasons for no trades.

## Single authoritative entry gate

All entry paths: burst, scored, stream, new launch, momentum, wakeup and runner re-entry must require the same meme eligibility result AND existing TDE approval. Direct PaperTrader entry methods must be protected too. Keep separate permanent operator blacklist unchanged.

Minimum real-time conditions: validated distinct buyers, freshness, sufficient XRP-side pool reserve, complete timestamped AMM reserves, limited entry and round-trip impact, holder concentration and issuer restrictions, legitimate trade direction, daily loss guard, position cap and cooldown. A single huge wallet or isolated spike is not enough.

## Exits and accounting

Preserve the original PAPER epoch/database, existing history, cash/inventory and stop/TP1/trailing/time/risk exits. Do not pretend a no-price position was sold or refund its entry. Use reserve-aware simulated sell economics and fees. Paper profits are not guaranteed executable LIVE profits.

Measure cohort PnL and rejection counts separately: NEW_LAUNCH, BREAKOUT, REVIVAL, BURST, RUNNER.

## Tests and release gate

1. Non-meme fixtures USDC, RLUSD, USDT, BTC/ETH/SOL, wrapped variants, SOLO, REAL, EVR, RWA and spoofed ticker/issuer stay rejected even during a surge.
2. Unlisted new meme, dormant revived meme, established meme with issuer-specific positive evidence qualify for analysis with no manual addition to a small token list.
3. Classification expires and stale/provider failures fail closed for entry; open positions are still monitored and managed.
4. Simulated 10k token catalog scans bounded rotating cohorts; no starvation for launch/revival; no XRPL provider flood.
5. Existing TDE, paper accounting, PM2 guarded startup and legacy blacklist tests remain green.
6. Deploy separately with entry cap 0, no wallet seed or LIVE, validate existing account, canary, then lift cap only when trustworthy.
7. Resolve legacy daily report cron to vNext PAPER DB and display accurate strategy breakdown.

## Last operator-confirmed baseline

PAPER mode, five slots enabled, dynamic classification NOT deployed; ARMY/DROP-only gates, no open positions, 16 closed trade rows, 105.4998 simulated XRP cash and healthy XRPL stream at last check. The 5.50 XRP surplus includes trades from the older broader universe, not evidence of new meme-only results.
