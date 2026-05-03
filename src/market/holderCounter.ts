/**
 * Holder Counter
 *
 * Counts real trustline holders for a token by paginating account_lines
 * on the ISSUER account.
 *
 * Key fix: account_lines returns currency as raw hex for non-standard codes.
 * We must compare both the raw currency AND the decoded name to match correctly.
 */

import { XRPLClient } from '../xrpl/client';
import { warn, debug } from '../utils/logger';

interface HolderCache {
  count: number;
  lastUpdated: number;
}

export class HolderCounter {
  private xrplClient: XRPLClient;
  private cache: Map<string, HolderCache> = new Map();
  private readonly CACHE_TTL_MS = 30 * 60 * 1000; // 30 min — holders don't change fast
  private readonly MAX_PAGES = 5;                   // 5 × 400 = 2,000 holders max (was 25 × = 10k)

  // Semaphore: max 8 concurrent account_lines requests to avoid WebSocket flood
  private readonly MAX_CONCURRENT = 8;
  private activeRequests = 0;
  private waitQueue: Array<() => void> = [];

  constructor(xrplClient: XRPLClient) {
    this.xrplClient = xrplClient;
  }

  private async acquireSemaphore(): Promise<void> {
    if (this.activeRequests < this.MAX_CONCURRENT) {
      this.activeRequests++;
      return;
    }
    return new Promise(resolve => this.waitQueue.push(() => { this.activeRequests++; resolve(); }));
  }

  private releaseSemaphore(): void {
    this.activeRequests--;
    const next = this.waitQueue.shift();
    if (next) next();
  }

  /** Return cached holder count if available (null if not cached or expired) */
  getCached(currency: string, issuer: string): number | null {
    const key = `${currency}:${issuer}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.lastUpdated < this.CACHE_TTL_MS) return cached.count;
    return null;
  }

  async getHolderCount(currency: string, issuer: string, rawCurrency?: string): Promise<number | null> {
    const key = `${currency}:${issuer}`;
    const cached = this.cache.get(key);

    if (cached && Date.now() - cached.lastUpdated < this.CACHE_TTL_MS) {
      return cached.count;
    }

    await this.acquireSemaphore();
    try {
      const count = await this.fetchHolderCount(issuer, currency, rawCurrency);
      this.cache.set(key, { count, lastUpdated: Date.now() });
      debug(`Holder count for ${key}: ${count}`);
      return count;
    } catch (err) {
      warn(`Failed to fetch holder count for ${key}: ${err}`);
      return cached?.count ?? null;
    } finally {
      this.releaseSemaphore();
    }
  }

  /**
   * Count holders by paginating account_lines on the issuer.
   *
   * XRPL returns trustlines as the counterparty's perspective:
   *   - line.currency may be raw hex (e.g. "4C6175676800...") or 3-char (e.g. "USD")
   *   - A positive balance means the holder OWNS tokens (issuer sees it as negative)
   *     but from the issuer's account_lines, it's shown as NEGATIVE balance
   *   - We count lines where abs(balance) > 0 AND currency matches
   *
   * Match logic: compare line.currency against BOTH the raw hex AND decoded name.
   */
  private async fetchHolderCount(
    issuer: string,
    currency: string,       // decoded display name, e.g. "Laugh"
    rawCurrency?: string    // original hex, e.g. "4C61756768..."
  ): Promise<number> {
    const client = this.xrplClient.getClient();
    if (!client) throw new Error('No XRPL client');

    // Build a set of currency strings to match against
    // (some nodes return hex, some return decoded, handle both)
    const matchSet = new Set<string>();
    matchSet.add(currency);
    if (rawCurrency) matchSet.add(rawCurrency);

    // Also add the hex encoding of the display name in case we have a 3-char
    if (currency.length <= 3) {
      matchSet.add(currency.toUpperCase());
    } else {
      // Add hex version of display name (in case we only have decoded)
      const hex = Buffer.from(currency).toString('hex').toUpperCase().padEnd(40, '0');
      matchSet.add(hex);
    }

    let holders = 0;
    let marker: any = undefined;
    let pages = 0;

    do {
      pages++;
      if (pages > this.MAX_PAGES) {
        warn(`Holder count capped at ${this.MAX_PAGES} pages for ${issuer}`);
        break;
      }

      const req: any = {
        command: 'account_lines',
        account: issuer,
        ledger_index: 'validated',
        limit: 400,
      };
      if (marker) req.marker = marker;

      let result: any;
      try {
        const res: any = await client.request(req);
        result = res?.result;
      } catch (err: any) {
        warn(`account_lines failed for ${issuer}: ${err.message}`);
        break;
      }

      const lines: any[] = result?.lines || [];
      marker = result?.marker;

      for (const line of lines) {
        // Match currency (handle both hex and decoded)
        if (!matchSet.has(line.currency)) continue;

        // From issuer's perspective, balance is negative when holder has tokens.
        // Count anyone with a non-zero balance (either direction).
        const bal = parseFloat(line.balance || '0');
        if (bal !== 0) holders++;
      }

      if (lines.length === 0) break;

    } while (marker);

    return holders;
  }

  pruneCache(): void {
    const now = Date.now();
    for (const [key, c] of this.cache.entries()) {
      if (now - c.lastUpdated > this.CACHE_TTL_MS * 2) this.cache.delete(key);
    }
  }

  getCacheSize(): number {
    return this.cache.size;
  }
}
