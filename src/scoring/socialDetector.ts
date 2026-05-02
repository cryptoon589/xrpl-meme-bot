/**
 * Social Signal Detector
 *
 * Detects social signals from the XRPL ledger itself — no external APIs needed.
 * Signals indicate the issuer is a real project (not a rug) and has community interest.
 *
 * Scoring (max 100):
 *   +30  Domain field set on issuer account
 *   +15  EmailHash set on issuer account
 *   +25  Account age > 30 days
 *   +30  Market makers present (active offers in the book)
 *
 * Results are cached per token for 15 minutes to avoid hammering the XRPL node.
 */

import * as xrpl from 'xrpl';
import { debug, warn } from '../utils/logger';

interface SocialCache {
  score: number;
  expiry: number;
}

export class SocialDetector {
  private wsUrl: string;
  private cache: Map<string, SocialCache> = new Map();

  private readonly CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

  constructor(wsUrl: string) {
    this.wsUrl = wsUrl;
  }

  /**
   * Get the combined social score for a token (0-100), cached 15 min.
   */
  async getSocialScore(currency: string, issuer: string): Promise<number> {
    const key = `${currency}:${issuer}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiry > Date.now()) {
      return cached.score;
    }

    let score = 0;

    try {
      const client = new xrpl.Client(this.wsUrl);
      await client.connect();

      try {
        const [domainScore, emailScore, ageScore, mmScore] = await Promise.all([
          this.checkDomain(client, issuer),
          this.checkEmailHash(client, issuer),
          this.checkAccountAge(client, issuer),
          this.checkMarketMakers(client, currency, issuer),
        ]);

        score = Math.min(100, domainScore + emailScore + ageScore + mmScore);
        debug(`[SocialDetector] ${currency}:${issuer} → domain=${domainScore} email=${emailScore} age=${ageScore} mm=${mmScore} total=${score}`);
      } finally {
        await client.disconnect().catch(() => {});
      }
    } catch (err) {
      warn(`[SocialDetector] Error scoring ${currency}:${issuer}: ${err}`);
      // Return 0 on failure, don't crash the scoring pipeline
    }

    this.cache.set(key, { score, expiry: Date.now() + this.CACHE_TTL_MS });
    return score;
  }

  /**
   * Check if the issuer has a Domain field set → +30 points.
   * Domain = hex-encoded URL proving the issuer has a web presence.
   */
  async checkDomain(client: xrpl.Client, issuer: string): Promise<number> {
    try {
      const resp = await client.request({
        command: 'account_info',
        account: issuer,
        ledger_index: 'validated',
      });
      const account = resp.result.account_data;
      if (account.Domain && account.Domain.length > 0) {
        return 30;
      }
    } catch {
      // Account not found or RPC error
    }
    return 0;
  }

  /**
   * Check if the issuer has an EmailHash set → +15 points.
   * Shows the issuer has a verified email (Gravatar protocol on XRPL).
   */
  async checkEmailHash(client: xrpl.Client, issuer: string): Promise<number> {
    try {
      const resp = await client.request({
        command: 'account_info',
        account: issuer,
        ledger_index: 'validated',
      });
      const account = resp.result.account_data;
      if (account.EmailHash && account.EmailHash.length > 0) {
        return 15;
      }
    } catch {
      // Account not found or RPC error
    }
    return 0;
  }

  /**
   * Check account age: if the issuer account is > 30 days old → +25 points.
   * An old account that issues a new token is a stronger signal than a fresh account.
   * Uses account sequence as a proxy (older accounts have lower sequences).
   */
  async checkAccountAge(client: xrpl.Client, issuer: string): Promise<number> {
    try {
      // Get the ledger sequence when this account was created via tx history
      const resp = await client.request({
        command: 'account_tx',
        account: issuer,
        ledger_index_min: -1,
        ledger_index_max: -1,
        limit: 1,
        forward: true, // oldest first
      });

      const txList = resp.result.transactions;
      if (!txList || txList.length === 0) return 0;

      // The first tx's close_time_iso or date field tells us account creation time
      const firstTx: any = txList[0];
      // XRPL ripple epoch: seconds since 2000-01-01
      const rippleEpoch = 946684800; // Unix timestamp of 2000-01-01
      let createdUnix: number | null = null;

      if (firstTx.tx?.date !== undefined) {
        createdUnix = (firstTx.tx.date + rippleEpoch) * 1000;
      } else if (firstTx.tx_json?.date !== undefined) {
        createdUnix = (firstTx.tx_json.date + rippleEpoch) * 1000;
      }

      if (createdUnix === null) return 0;

      const ageMs = Date.now() - createdUnix;
      const ageDays = ageMs / (1000 * 60 * 60 * 24);

      return ageDays > 30 ? 25 : 0;
    } catch {
      return 0;
    }
  }

  /**
   * Check how many unique market makers have active offers for this token.
   * +5 per unique maker, up to +30 (= 6+ market makers).
   * Multiple market makers = real trading interest.
   */
  async checkMarketMakers(
    client: xrpl.Client,
    currency: string,
    issuer: string
  ): Promise<number> {
    try {
      // Check both sides of the book
      const [offersA, offersB] = await Promise.all([
        client.request({
          command: 'book_offers',
          taker_gets: { currency: 'XRP' },
          taker_pays: { currency, issuer },
          limit: 50,
        }),
        client.request({
          command: 'book_offers',
          taker_gets: { currency, issuer },
          taker_pays: { currency: 'XRP' },
          limit: 50,
        }),
      ]);

      const makerSet = new Set<string>();

      const offersA_list = (offersA.result as any).offers || [];
      const offersB_list = (offersB.result as any).offers || [];

      for (const offer of [...offersA_list, ...offersB_list]) {
        if (offer.Account) makerSet.add(offer.Account);
      }

      const makerCount = makerSet.size;
      const pts = Math.min(30, makerCount * 5);
      debug(`[SocialDetector] ${currency}:${issuer} → ${makerCount} market makers → +${pts}`);
      return pts;
    } catch {
      return 0;
    }
  }

  /**
   * Clear the cache for a specific token (e.g. after token updates).
   */
  clearCache(currency: string, issuer: string): void {
    this.cache.delete(`${currency}:${issuer}`);
  }

  getCacheSize(): number {
    return this.cache.size;
  }
}
