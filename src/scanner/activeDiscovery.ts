/**
 * Active Discovery Engine
 *
 * Instead of passively waiting for TrustSet transactions (rare),
 * this module proactively finds meme tokens by:
 * 1. Scanning ledger objects for new AMM pools (like FirstLedger)
 * 2. Finding OfferCreate txs with new token pairs
 * 3. Scanning account_offers for active DEX markets
 * 4. Periodic full sweep of recent AMM pools
 */

import { XRPLClient } from '../xrpl/client';
import { Database } from '../db/database';
import { TrackedToken } from '../types';
import { info, warn, debug } from '../utils/logger';

export interface DiscoveredToken {
  currency: string;
  issuer: string;
  source: 'amm_pool' | 'offer_create' | 'token_payment' | 'ledger_sweep';
  liquidityXRP?: number;
  poolId?: string;
  discoveredAt: number;
}

export class ActiveDiscovery {
  private xrplClient: XRPLClient;
  private db: Database;
  private knownTokens: Map<string, DiscoveredToken> = new Map();
  private knownAMMs: Set<string> = new Set();
  private lastSweepLedger = 0;
  private spamIssuers: Set<string> = new Set();
  private issuerTokenCount: Map<string, number> = new Map();
  private readonly SPAM_THRESHOLD = 8;

  // Currency codes that are NOT meme tokens (ascii and hex forms)
  private readonly STABLECOINS = new Set([
    'USD', 'EUR', 'BTC', 'ETH', 'USDT', 'USDC', 'RLUSD', 'CNY', 'GBP', 'JPY', 'SOLO',
    // Hex-encoded stablecoins
    '524C555344000000000000000000000000000000', // RLUSD
    '5553440000000000000000000000000000000000', // USD hex
    '555344430000000000000000000000000000000000', // USDC
    '5553445400000000000000000000000000000000', // USDT
  ]);

  /**
   * Decode hex-encoded currency to ASCII if possible
   */
  private decodeCurrency(currency: string): string {
    if (currency.length !== 40) return currency; // Already ASCII (e.g. "XRP", "USD")
    // Hex-encoded: strip trailing zeros and decode
    try {
      const stripped = currency.replace(/00+$/, '');
      const decoded = Buffer.from(stripped, 'hex').toString('ascii').replace(/\x00/g, '');
      // Only return if it looks like printable ASCII
      if (/^[\x20-\x7E]+$/.test(decoded) && decoded.length > 0) return decoded;
    } catch {}
    return currency; // Return raw hex if can't decode
  }

  constructor(xrplClient: XRPLClient, db: Database) {
    this.xrplClient = xrplClient;
    this.db = db;
  }

  /**
   * Process a live transaction from the WebSocket stream.
   * Extract token info from OfferCreate and Payment transactions.
   */
  processLiveTx(tx: any): DiscoveredToken | null {
    const t = tx.tx_json || tx.tx || tx.transaction;
    if (!t) return null;

    const txType = t.TransactionType;
    const meta = tx.meta;

    // Discover tokens from AMM creation
    if (txType === 'AMMCreate') {
      return this.extractFromAMMCreate(t, meta);
    }

    // Discover tokens from OfferCreate (someone placing a DEX order for a new token)
    if (txType === 'OfferCreate') {
      return this.extractFromOffer(t, meta);
    }

    // Discover tokens from token Payments
    if (txType === 'Payment') {
      return this.extractFromPayment(t);
    }

    // Discover tokens from TrustSet (someone trusting a new issuer)
    if (txType === 'TrustSet') {
      return this.extractFromTrustSet(t);
    }

    return null;
  }

  private extractFromAMMCreate(t: any, meta: any): DiscoveredToken | null {
    // AMMCreate has Amount and Amount2 fields
    const amt1 = t.Amount;
    const amt2 = t.Amount2;

    let currency: string | null = null;
    let issuer: string | null = null;
    let liquidityXRP = 0;

    if (typeof amt1 === 'string' && amt2 && typeof amt2 === 'object') {
      currency = this.decodeCurrency(amt2.currency);
      issuer = amt2.issuer;
      liquidityXRP = parseInt(amt1) / 1_000_000;
    } else if (typeof amt2 === 'string' && amt1 && typeof amt1 === 'object') {
      currency = this.decodeCurrency(amt1.currency);
      issuer = amt1.issuer;
      liquidityXRP = parseInt(amt2) / 1_000_000;
    }

    if (!currency || !issuer) return null;
    if (this.STABLECOINS.has(currency)) return null;

    return this.registerToken(currency, issuer, 'amm_pool', liquidityXRP);
  }

  private extractFromOffer(t: any, meta: any): DiscoveredToken | null {
    const gets = t.TakerGets;
    const pays = t.TakerPays;

    let currency: string | null = null;
    let issuer: string | null = null;
    let xrpSide = 0;

    if (typeof gets === 'string' && pays && typeof pays === 'object') {
      currency = this.decodeCurrency(pays.currency);
      issuer = pays.issuer;
      xrpSide = parseInt(gets) / 1_000_000;
    } else if (typeof pays === 'string' && gets && typeof gets === 'object') {
      currency = this.decodeCurrency(gets.currency);
      issuer = gets.issuer;
      xrpSide = parseInt(pays) / 1_000_000;
    }

    if (!currency || !issuer) return null;
    if (this.STABLECOINS.has(currency)) return null;
    if (xrpSide < 1) return null;

    return this.registerToken(currency, issuer, 'offer_create', xrpSide);
  }

  private extractFromPayment(t: any): DiscoveredToken | null {
    const amount = t.Amount;
    if (!amount || typeof amount === 'string') return null;
    const currency = this.decodeCurrency(amount.currency);
    if (this.STABLECOINS.has(currency)) return null;

    return this.registerToken(currency, amount.issuer, 'token_payment', 0);
  }

  private extractFromTrustSet(t: any): DiscoveredToken | null {
    const limit = t.LimitAmount;
    if (!limit || typeof limit !== 'object') return null;
    const currency = this.decodeCurrency(limit.currency);
    if (this.STABLECOINS.has(currency)) return null;
    if (limit.issuer === t.Account) return null;

    return this.registerToken(currency, limit.issuer, 'token_payment', 0);
  }

  /**
   * Register a token - returns the token if newly discovered, null if already known
   */
  private registerToken(
    currency: string,
    issuer: string,
    source: DiscoveredToken['source'],
    liquidityXRP: number
  ): DiscoveredToken | null {
    if (!currency || !issuer) return null;

    const key = `${currency}:${issuer}`;

    // Already known
    if (this.knownTokens.has(key)) {
      // Update liquidity if better info
      const existing = this.knownTokens.get(key)!;
      if (liquidityXRP > existing.liquidityXRP!) {
        existing.liquidityXRP = liquidityXRP;
      }
      return null;
    }

    // Spam detection
    if (this.spamIssuers.has(issuer)) return null;
    const cnt = (this.issuerTokenCount.get(issuer) || 0) + 1;
    this.issuerTokenCount.set(issuer, cnt);
    if (cnt > this.SPAM_THRESHOLD) {
      this.spamIssuers.add(issuer);
      debug(`Spam issuer detected: ${issuer} (${cnt} tokens)`);
      return null;
    }

    const token: DiscoveredToken = {
      currency,
      issuer,
      source,
      liquidityXRP,
      discoveredAt: Date.now(),
    };

    this.knownTokens.set(key, token);
    info(`🔍 New token discovered via ${source}: ${currency} (issuer: ${issuer.slice(0, 12)}...) ${liquidityXRP > 0 ? `| Liq: ${liquidityXRP.toFixed(0)} XRP` : ''}`);

    return token;
  }

  /**
   * Sweep recent ledger objects to find AMM pools proactively.
   * This is how sites like FirstLedger find tokens — they scan the ledger state,
   * not just the transaction stream.
   */
  async sweepAMMPools(): Promise<DiscoveredToken[]> {
    const client = this.xrplClient.getClient();
    if (!client) return [];

    const found: DiscoveredToken[] = [];

    try {
      // Use ledger_data to fetch AMM objects
      let marker: any = undefined;
      let page = 0;
      const MAX_PAGES = 3; // Limit to avoid overloading

      do {
        const req: any = {
          command: 'ledger_data',
          ledger_index: 'validated',
          type: 'amm',
          limit: 200,
        };
        if (marker) req.marker = marker;

        const res: any = await client.request(req).catch(() => null);
        if (!res) break;

        const objects = res.result?.state || [];
        marker = res.result?.marker;

        for (const obj of objects) {
          if (obj.LedgerEntryType !== 'AMM') continue;

          const asset1 = obj.Asset;
          const asset2 = obj.Asset2;

          // We want XRP/token pairs
          let currency: string | null = null;
          let issuer: string | null = null;

          if (asset1.currency === 'XRP' && asset2.currency && asset2.issuer) {
            currency = this.decodeCurrency(asset2.currency);
            issuer = asset2.issuer;
          } else if (asset2.currency === 'XRP' && asset1.currency && asset1.issuer) {
            currency = this.decodeCurrency(asset1.currency);
            issuer = asset1.issuer;
          }

          if (!currency || !issuer) continue;
          if (this.STABLECOINS.has(currency)) continue;
          if (this.knownAMMs.has(`${currency}:${issuer}`)) continue;

          this.knownAMMs.add(`${currency}:${issuer}`);

          const token = this.registerToken(currency, issuer, 'ledger_sweep', 0);
          if (token) found.push(token);
        }

        page++;
        if (!marker || page >= MAX_PAGES) break;

      } while (true);

      if (found.length > 0) {
        info(`AMM sweep: found ${found.length} new tokens from ledger state`);
      }
    } catch (err) {
      warn(`AMM sweep error: ${err}`);
    }

    return found;
  }

  /**
   * Convert a DiscoveredToken to a TrackedToken for the main scanner
   */
  toTrackedToken(dt: DiscoveredToken): TrackedToken {
    return {
      currency: dt.currency,
      issuer: dt.issuer,
      firstSeen: dt.discoveredAt,
      lastUpdated: dt.discoveredAt,
    };
  }

  getKnownTokenCount(): number {
    return this.knownTokens.size;
  }

  getKnownTokens(): DiscoveredToken[] {
    return Array.from(this.knownTokens.values());
  }

  isSpam(issuer: string): boolean {
    return this.spamIssuers.has(issuer);
  }
}
