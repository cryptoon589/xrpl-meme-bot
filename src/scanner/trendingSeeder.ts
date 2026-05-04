/**
 * Trending Token Seeder
 *
 * Polls xrplmeta.org every 15 minutes to find tokens with high recent
 * trading activity and seeds them into the bot's tracking list.
 *
 * This solves the cold-start problem: tokens that launched/pumped before
 * the bot discovered them via the live stream are now picked up via the
 * external trending feed, giving the scoring engine time to accumulate
 * live data before the next hourly report.
 *
 * Sort modes used (in priority order):
 *   1. exchanges_24h — trade count (raw market activity)
 *   2. takers_24h    — unique traders (filters wash bots)
 *   3. volume_24h    — XRP volume (size of moves)
 *
 * Filters applied:
 *   - takers_24h >= MIN_TAKERS  (organic activity, not 1-taker bots)
 *   - Not a stablecoin / known L1 token
 *   - Not a brand-impersonation hex token
 */

import { info, warn, debug } from '../utils/logger';

export interface TrendingToken {
  currency: string;   // raw currency code (hex or 3-char)
  issuer: string;
  name: string;       // decoded display name
  exchanges24h: number;
  takers24h: number;
  volume24h: number;
  priceChangePct24h: number;
}

const XRPLMETA_BASE = 'https://s1.xrplmeta.org';
const FETCH_LIMIT   = 50;   // tokens per sort mode
const MIN_TAKERS    = 5;    // require at least 5 unique traders to avoid wash bots

// Tokens to ignore (stablecoins, L1s, established projects)
const SEED_BLOCKLIST = new Set([
  'USD', 'USDC', 'USDT', 'RLUSD', 'EUR', 'BTC', 'ETH', 'CNY', 'GBP', 'JPY', 'AUD', 'CAD',
  'XAH', 'XLM', 'SGB', 'FLR', 'EVR', 'CSC', 'DRO', 'SOLO',
  'OCT', 'SHX', 'MXI', 'CORE',
]);

// Brand-impersonation keywords — filter hex tokens whose decoded name contains these
const BRAND_KEYWORDS = [
  'invest', 'etf', 'bank', 'financial', 'finance', 'capital', 'fund', 'asset',
  'deutsche', 'blackrock', 'vanguard', 'fidelity', 'grayscale', 'nasdaq', 'nyse',
  'federal', 'reserve', 'treasury', 'coinbase', 'binance', 'kraken', 'bitfinex', 'robinhood',
];

export class TrendingSeeder {
  private intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private onTokensFound: (tokens: TrendingToken[]) => void;

  constructor(
    onTokensFound: (tokens: TrendingToken[]) => void,
    intervalMs = 15 * 60 * 1000
  ) {
    this.onTokensFound = onTokensFound;
    this.intervalMs = intervalMs;
  }

  start(): void {
    // Run immediately on start, then on interval
    this.poll().catch(e => warn(`[TrendingSeeder] Initial poll failed: ${e}`));
    this.timer = setInterval(() => {
      this.poll().catch(e => warn(`[TrendingSeeder] Poll failed: ${e}`));
    }, this.intervalMs);
    info(`[TrendingSeeder] Started — polling every ${this.intervalMs / 60000} min`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async poll(): Promise<void> {
    const seen = new Map<string, TrendingToken>(); // key = currency:issuer

    // Fetch from multiple sort modes to get broad coverage
    const sortModes = ['exchanges_24h', 'takers_24h', 'volume_24h'];

    for (const sortBy of sortModes) {
      try {
        const url = `${XRPLMETA_BASE}/tokens?sort_by=${sortBy}&limit=${FETCH_LIMIT}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) {
          warn(`[TrendingSeeder] ${sortBy} fetch returned ${res.status}`);
          continue;
        }
        const data: any = await res.json();
        const tokens: any[] = Array.isArray(data) ? data : (data.tokens || []);

        for (const t of tokens) {
          const currency: string = t.currency || '';
          const issuer: string   = t.issuer   || '';
          if (!currency || !issuer) continue;

          const key = `${currency}:${issuer}`;
          if (seen.has(key)) continue; // already from another sort mode

          // Blocklist check
          if (SEED_BLOCKLIST.has(currency)) continue;

          // Decode name
          const name = this.decodeName(t);
          if (!name) continue;

          // Brand-impersonation filter
          const lower = name.toLowerCase();
          if (BRAND_KEYWORDS.some(kw => lower.includes(kw))) continue;

          const metrics  = t.metrics || {};
          const takers   = Number(metrics.takers_24h   || 0);
          const exchanges = Number(metrics.exchanges_24h || 0);
          const volume   = Number(metrics.volume_24h    || 0);
          const pricePct = Number(metrics.price_percent_24h || 0);

          if (takers < MIN_TAKERS) continue; // skip wash bots

          seen.set(key, {
            currency,
            issuer,
            name,
            exchanges24h: exchanges,
            takers24h: takers,
            volume24h: volume,
            priceChangePct24h: pricePct,
          });
        }
      } catch (err) {
        warn(`[TrendingSeeder] Error fetching ${sortBy}: ${err}`);
      }
    }

    const results = Array.from(seen.values());
    if (results.length > 0) {
      info(`[TrendingSeeder] Found ${results.length} trending tokens to seed`);
      this.onTokensFound(results);
    } else {
      debug(`[TrendingSeeder] No new trending tokens this poll`);
    }
  }

  private decodeName(t: any): string {
    const currency: string = t.currency || '';
    const meta = t.meta || {};
    const tokenMeta = meta.token || {};

    // Prefer human-readable name from metadata
    const metaName: string = tokenMeta.name || '';
    if (metaName && metaName.length > 0 && metaName.length <= 40) return metaName.trim();

    // Fall back to decoding hex currency
    if (currency.length === 40) {
      try {
        const stripped = currency.replace(/00+$/g, '');
        const decoded = Buffer.from(stripped, 'hex').toString('ascii').replace(/\x00/g, '');
        if (/^[\x20-\x7E]+$/.test(decoded) && decoded.length > 0) return decoded.trim();
      } catch {}
      return ''; // non-printable hex — skip
    }

    // Short ASCII code
    return currency;
  }
}
