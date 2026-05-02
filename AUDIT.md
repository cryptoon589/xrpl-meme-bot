# Trading Bot Audit — 2026-05-02

## Bugs Found & Fixed

### CRITICAL (would cause wrong trades or silent failures)

1. **marketData.ts: book_offers uses decoded currency name** — same hex bug as amm_info. `getPriceFromBookOffers` and `calculateSpread` pass `currency` (decoded ASCII like "Laugh") to `getBookOffers` which passes it to `book_offers`. Result: price = null for all non-3-char tokens that have no AMM → scored as 0 liquidity → filtered out.

2. **marketData.ts: priceChange window too tight (2 min tolerance)** — `findPriceAtTime` only accepts a price point within 2 minutes of the target. The scan cycle runs every 60 seconds. A token discovered 3 minutes ago has price history at t=0 and t=60s. Asking for "price 5 min ago" finds nothing within 2 min → priceChange5m = null for the first 7 minutes → momentum score = 50 (neutral) → misses early pumps.

3. **marketData.ts: spread calculation uses decoded currency** — same hex bug. `calculateSpread` passes decoded currency to both `getBookOffers` calls → always returns null → `isSafe()` returns false (wide spread flagged as true) → tokens blocked even when spread is fine.

4. **riskFilters.ts: isSafe() blocks on null spread** — `checkWideSpread` returns true when `spreadPercent === null`. For AMM tokens the spread is always null (no order book). So `isSafe()` always returns false for AMM tokens → NO AMM trades ever fire.

5. **index.ts: ammPrice injected AFTER snapshot built** — `collectMarketDataWithExtras` runs first using the old order-book price. Then ammPrice is injected onto the snapshot. But `priceChanges` are calculated inside `collectMarketDataWithExtras` using the wrong price. The price history is also saved with the wrong price.

6. **marketData.ts: calculatePriceFromAMM never called** — The scan loop passes `pool` (from `ammScanner.findPoolByToken`) but `ammScanner` only knows about pools from the initial AMM sweep, not all pools. Most tokens have `pool = null` so it falls through to `getPriceFromBookOffers` with the broken decoded currency.

### MEDIUM (degrades signal quality)

7. **tokenScorer.ts: scoreNewWallets returns 0 when no live data yet** — During first scan cycle, `uniqueBuyers5m = 0` so `scoreNewWallets` returns 0. This is correct but the weight is 25% so all tokens start with a 25% handicap. Should fall back to neutral (50) when no data.

8. **tokenScorer.ts: scoreMomentum starts at 50 but returns 50 when count=0** — If no price history exists, momentum = 50 (neutral). But the score formula uses this as 20% weight → all new tokens get +10 points "free". Should return 0 when no price data (unknown ≠ neutral).

9. **riskFilters.ts: checkWideSpread returns true on null** — Should return false (unknown spread ≠ wide spread). Wide spread should only block when we have evidence of a wide spread, not absence of data.

10. **ammPriceFetcher.ts: 15s cache too short under load** — With 80+ tokens scanning every 60s in batches of 10 concurrent, 15s cache means re-fetching within the same cycle. Should be 45s to cover one full batch.

## All fixes applied in this commit.
