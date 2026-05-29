/**
 * AMM Price Fetcher
 *
 * Fetches real price and liquidity directly from AMM pools via amm_info.
 * This is the authoritative price source for XRPL meme tokens - most
 * liquidity lives in AMM pools, not the DEX order book.
 *
 * Falls back to book_offers if no AMM pool exists.
 */

import { XRPLClient } from '../xrpl/client';
import { debug, warn } from '../utils/logger';

export interface TokenPrice {
  priceXRP: number;
  liquidityXRP: number;       // total XRP in the pool * 2 (both sides)
  poolXRP: number;             // actual XRP side of pool
  poolTokens: number;          // token side of pool
  tradingFee: number;          // AMM fee in basis points
  source: 'amm' | 'orderbook';
  poolAge?: number;            // ms since pool created (if available)
}

export class AMMPriceFetcher {
  private xrplClient: XRPLClient;
  // Cache: key = "currency:issuer", value = { price, fetchedAt }
  private cache: Map<string, { price: TokenPrice; fetchedAt: number }> = new Map();
  // Null cache: tokens confirmed to have no price source - skip retrying for 5 min
  private nullCache: Map<string, number> = new Map();
  // FIX #33: tiered price cache TTLs.
  // Open positions need fresh exit prices - 90s stale price on a dumping meme = missed stop.
  // Non-position scanning can tolerate 90s (reduces AMM hammering during discovery).
  private readonly CACHE_TTL_MS = 90_000;           // 90s for non-position scanning
  private readonly OPEN_POS_CACHE_TTL_MS = 15_000;  // 15s for tokens with open positions
  private readonly NULL_CACHE_TTL_MS = 300_000;     // 5 min null cache - don't retry no-price tokens
  // Open position tracking: bypass null cache for tokens with open trades
  private openPositionKeys: Set<string> = new Set();

  constructor(xrplClient: XRPLClient) {
    this.xrplClient = xrplClient;
  }

  /** Register an open position - bypasses null cache so exit checks always get a live price */
  registerOpenPosition(currency: string, issuer: string): void {
    this.openPositionKeys.add(`${currency}:${issuer}`);
  }

  /** Unregister when position closes */
  unregisterOpenPosition(currency: string, issuer: string): void {
    const key = `${currency}:${issuer}`;
    this.openPositionKeys.delete(key);
    // Also clear the null cache entry so next scan gets a fresh attempt
    this.nullCache.delete(key);
  }

  /**
   * Get the current price of a token in XRP.
   * Tries AMM first, falls back to order book.
   * bypassNullCache: force a live fetch even if token is null-cached (used for open positions).
   */
  async getPrice(currency: string, issuer: string, rawCurrency?: string, bypassNullCache = false): Promise<TokenPrice | null> {
    const key = `${currency}:${issuer}`;
    const now = Date.now();
    // Open positions always bypass null cache - we need a price to manage exit
    const isOpen = this.openPositionKeys.has(key);
    const effectiveBypass = bypassNullCache || isOpen;

    // FIX #33: use shorter TTL for open positions — exit accuracy matters more than scan efficiency.
    const cacheTtl = isOpen ? this.OPEN_POS_CACHE_TTL_MS : this.CACHE_TTL_MS;
    const cached = this.cache.get(key);
    if (cached && now - cached.fetchedAt < cacheTtl) {
      return cached.price;
    }

    // Skip tokens that previously returned no price - avoid hammering the network
    // Exception: open positions bypass the null cache so exit checks always fire
    const nullTs = this.nullCache.get(key);
    if (!effectiveBypass && nullTs && now - nullTs < this.NULL_CACHE_TTL_MS) {
      return null;
    }

    // Use rawCurrency (hex) for API calls - decoded name causes "Issue is malformed"
    const apiCurrency = rawCurrency || currency;

    // Try AMM pool first (primary)
    const ammPrice = await this.fetchFromAMM(apiCurrency, issuer);
    if (ammPrice) {
      this.cache.set(key, { price: ammPrice, fetchedAt: now });
      return ammPrice;
    }

    // FIX #32: If rawCurrency was a decoded name (short ASCII), also try the hex form.
    // Some tokens have their AMM indexed under the hex-padded key, not the ASCII key.
    // This catches cases where currency='ARMY' but AMM registered as hex equivalent.
    if (apiCurrency === currency && currency.length <= 20) {
      // currency might be ASCII - try hex-padded version
      const hexPadded = Buffer.from(currency).toString('hex').toUpperCase().padEnd(40, '0');
      if (hexPadded !== apiCurrency) {
        const ammPrice2 = await this.fetchFromAMM(hexPadded, issuer);
        if (ammPrice2) {
          this.cache.set(key, { price: ammPrice2, fetchedAt: now });
          return ammPrice2;
        }
      }
    }

    // Fall back to order book
    const bookPrice = await this.fetchFromOrderBook(apiCurrency, issuer);
    if (bookPrice) {
      this.cache.set(key, { price: bookPrice, fetchedAt: now });
      return bookPrice;
    }

    // Cache the null result so we don't retry for 5 minutes
    // FIX #32: For open positions, use a shorter null cache (30s not 5min)
    // so we retry more aggressively when a position needs an exit price.
    const nullTtl = isOpen ? 30_000 : this.NULL_CACHE_TTL_MS;
    this.nullCache.set(key, now - (this.NULL_CACHE_TTL_MS - nullTtl));
    return null;
  }

  /**
   * Fetch price directly from the AMM pool via amm_info.
   * Calculates price from pool reserves: price = XRP_reserve / token_reserve
   */
  private async fetchFromAMM(currency: string, issuer: string): Promise<TokenPrice | null> {
    const client = this.xrplClient.getClient();
    if (!client) return null;

    try {
      const res: any = await client.request({
        command: 'amm_info',
        asset: { currency: 'XRP' },
        asset2: { currency, issuer },
        ledger_index: 'validated',
      });

      const amm = res?.result?.amm;
      if (!amm) return null;

      // Parse pool reserves
      const amount1 = amm.amount;   // XRP side (in drops)
      const amount2 = amm.amount2;  // Token side

      let xrpDrops: number;
      let tokenUnits: number;

      // XRPL AMM: XRP side is always a string (drops), token side is always an object
      // amount1 is XRP (string) and amount2 is the token (object) - or vice versa
      if (typeof amount1 === 'string' && typeof amount2 === 'object') {
        // Normal layout: amount1=XRP drops, amount2=token
        xrpDrops = parseInt(amount1);
        tokenUnits = parseFloat(amount2?.value || '0');
      } else if (typeof amount2 === 'string' && typeof amount1 === 'object') {
        // Reversed layout: amount2=XRP drops, amount1=token
        xrpDrops = parseInt(amount2);
        tokenUnits = parseFloat(amount1?.value || '0');
      } else {
        return null;
      }

      if (xrpDrops <= 0 || tokenUnits <= 0) return null;

      const poolXRP = xrpDrops / 1_000_000;
      const priceXRP = poolXRP / tokenUnits;
      const liquidityXRP = poolXRP * 2; // TVL = both sides

      const tradingFee = amm.trading_fee || 0; // in basis points (e.g. 500 = 0.5%)

      return {
        priceXRP,
        liquidityXRP,
        poolXRP,
        poolTokens: tokenUnits,
        tradingFee,
        source: 'amm',
      };
    } catch (err: any) {
      // "actNotFound" means no AMM pool exists - normal, not an error
      if (err?.message?.includes('actNotFound') || err?.message?.includes('Account not found')) {
        return null;
      }
      debug(`AMM price fetch failed for ${currency}:${issuer}: ${err?.message}`);
      return null;
    }
  }

  /**
   * Fetch price from DEX order book (fallback for tokens with no AMM pool).
   *
   * Queries the SELL side: taker_gets=XRP, taker_pays=token
   * These are offers where someone wants XRP and is selling the token.
   * TakerGets = XRP drops, TakerPays = token amount -> price = XRP / tokens
   *
   * Also queries the BUY side for liquidity depth estimation.
   */
  private async fetchFromOrderBook(currency: string, issuer: string): Promise<TokenPrice | null> {
    try {
      // SELL side: people selling tokens for XRP
      // taker_gets = XRP (what taker receives), taker_pays = token (what taker gives)
      const sellSide = await this.xrplClient.getBookOffers(
        { currency: 'XRP' },
        { currency, issuer },
        10
      );

      // BUY side: people buying tokens with XRP
      // taker_gets = token, taker_pays = XRP
      const buySide = await this.xrplClient.getBookOffers(
        { currency, issuer },
        { currency: 'XRP' },
        10
      );

      // Parse sell side (TakerGets=XRP drops, TakerPays=token)
      let bestAskXRP = 0;
      let totalSellLiqXRP = 0;
      if (sellSide?.offers?.length) {
        for (const offer of sellSide.offers.slice(0, 5)) {
          const xrp = this.parseDrops(offer.TakerGets);
          const tokens = this.parseTokenUnits(offer.TakerPays);
          if (xrp > 0 && tokens > 0) {
            if (bestAskXRP === 0) bestAskXRP = xrp / tokens; // best ask = first offer
            totalSellLiqXRP += xrp;
          }
        }
      }

      // Parse buy side (TakerGets=token, TakerPays=XRP drops)
      let bestBidXRP = 0;
      let totalBuyLiqXRP = 0;
      if (buySide?.offers?.length) {
        for (const offer of buySide.offers.slice(0, 5)) {
          const xrp = this.parseDrops(offer.TakerPays);
          const tokens = this.parseTokenUnits(offer.TakerGets);
          if (xrp > 0 && tokens > 0) {
            if (bestBidXRP === 0) bestBidXRP = xrp / tokens; // best bid = first offer
            totalBuyLiqXRP += xrp;
          }
        }
      }

      // Need at least one side to have data
      if (bestAskXRP === 0 && bestBidXRP === 0) return null;

      // Mid price: average of best bid and ask, or whichever side has data
      const priceXRP = bestAskXRP > 0 && bestBidXRP > 0
        ? (bestAskXRP + bestBidXRP) / 2
        : bestAskXRP || bestBidXRP;

      const totalLiqXRP = totalSellLiqXRP + totalBuyLiqXRP;

      debug(`DEX price for ${currency}: ask=${bestAskXRP.toFixed(8)} bid=${bestBidXRP.toFixed(8)} liq=${totalLiqXRP.toFixed(0)} XRP`);

      return {
        priceXRP,
        liquidityXRP: totalLiqXRP,
        poolXRP: totalBuyLiqXRP,
        poolTokens: totalBuyLiqXRP / (priceXRP || 1),
        tradingFee: 0,
        source: 'orderbook',
      };
    } catch (err) {
      debug(`Order book price fetch failed for ${currency}:${issuer}: ${err}`);
      return null;
    }
  }

  private parseDrops(amount: any): number {
    if (typeof amount === 'string') return parseInt(amount) / 1_000_000;
    return 0;
  }

  private parseTokenUnits(amount: any): number {
    if (typeof amount === 'object' && amount?.value) return parseFloat(amount.value);
    if (typeof amount === 'string') return parseFloat(amount);
    return 0;
  }

  invalidate(currency: string, issuer: string): void {
    this.cache.delete(`${currency}:${issuer}`);
  }

  clearCache(): void {
    this.cache.clear();
  }
}
