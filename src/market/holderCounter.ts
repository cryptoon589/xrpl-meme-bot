/**
 * Holder Counter Module
 * Counts actual trustline holders for a token by scanning issuer's account_lines
 */

import { XRPLClient } from '../xrpl/client';
import { info, warn, debug } from '../utils/logger';

interface HolderCache {
  count: number;
  lastUpdated: number;
}

export class HolderCounter {
  private xrplClient: XRPLClient;
  private cache: Map<string, HolderCache> = new Map();
  private readonly CACHE_TTL_MS = 10 * 60 * 1000; // Cache for 10 minutes
  private readonly MAX_ISSUERS_PER_SCAN = 20; // Max issuers to scan per cycle

  constructor(xrplClient: XRPLClient) {
    this.xrplClient = xrplClient;
  }

  /**
   * Get holder count for a token (cached)
   */
  async getHolderCount(currency: string, issuer: string): Promise<number | null> {
    const key = `${currency}:${issuer}`;
    const cached = this.cache.get(key);

    // Return cached value if fresh
    if (cached && Date.now() - cached.lastUpdated < this.CACHE_TTL_MS) {
      return cached.count;
    }

    // Fetch fresh count
    try {
      const count = await this.fetchHolderCount(issuer, currency);
      this.cache.set(key, { count, lastUpdated: Date.now() });
      debug(`Holder count for ${key}: ${count}`);
      return count;
    } catch (err) {
      warn(`Failed to fetch holder count for ${key}: ${err}`);
      // Return cached value even if stale
      return cached?.count || null;
    }
  }

  /**
   * Fetch holder count by scanning issuer's account_lines
   */
  private async fetchHolderCount(issuer: string, currency: string): Promise<number> {
    let holders = 0;
    let marker: string | undefined;
    let iterations = 0;
    const MAX_ITERATIONS = 10; // Safety limit

    do {
      iterations++;
      if (iterations > MAX_ITERATIONS) {
        warn(`Holder count scan exceeded max iterations for ${issuer}`);
        break;
      }

      const result = await this.xrplClient.getAccountLinesWithMarker(issuer, marker);
      const lines = result.lines || [];
      if (lines.length === 0) break;

      // Count lines matching our currency
      for (const line of lines) {
        if (line.currency === currency && parseFloat(line.balance || '0') > 0) {
          holders++;
        }
      }

      marker = result.marker;
    } while (marker);

    return holders;
  }

  /**
   * Batch update holders for multiple tokens
   * Scans up to MAX_ISSUERS_PER_SCAN issuers per call
   */
  async batchUpdateHolders(tokens: Array<{ currency: string; issuer: string }>): Promise<Map<string, number>> {
    const results = new Map<string, number>();
    const uniqueIssuers = new Set(tokens.map(t => t.issuer));

    // Limit to MAX_ISSUERS_PER_SCAN issuers
    const issuersToScan = Array.from(uniqueIssuers).slice(0, this.MAX_ISSUERS_PER_SCAN);

    info(`Scanning holders for ${issuersToScan.length} issuers...`);

    for (const issuer of issuersToScan) {
      const issuerTokens = tokens.filter(t => t.issuer === issuer);

      try {
        const lines = await this.xrplClient.getAccountLines(issuer);

        // Count holders for each token from this issuer
        const tokenCounts = new Map<string, number>();

        for (const line of lines) {
          if (parseFloat(line.balance || '0') > 0) {
            const key = `${line.currency}:${issuer}`;
            tokenCounts.set(key, (tokenCounts.get(key) || 0) + 1);
          }
        }

        // Update cache and results
        for (const token of issuerTokens) {
          const key = `${token.currency}:${token.issuer}`;
          const count = tokenCounts.get(key) || 0;
          this.cache.set(key, { count, lastUpdated: Date.now() });
          results.set(key, count);
        }
      } catch (err) {
        warn(`Failed to scan holders for issuer ${issuer}: ${err}`);
      }

      // Rate limit between issuers
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    info(`Holder scan complete: ${results.size} tokens updated`);
    return results;
  }

  /**
   * Prune stale cache entries
   */
  pruneCache(): void {
    const now = Date.now();
    let pruned = 0;

    for (const [key, cache] of this.cache.entries()) {
      if (now - cache.lastUpdated > this.CACHE_TTL_MS * 2) { // 2x TTL
        this.cache.delete(key);
        pruned++;
      }
    }

    if (pruned > 0) {
      debug(`Pruned ${pruned} stale holder cache entries`);
    }
  }

  /**
   * Get cache size
   */
  getCacheSize(): number {
    return this.cache.size;
  }
}
