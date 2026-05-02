/**
 * AMM Price Fetcher
 *
 * Fetches real price and liquidity directly from AMM pools via amm_info.
 * This is the authoritative price source for XRPL meme tokens — most
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
  private readonly CACHE_TTL_MS = 15_000; // 15s cache — AMM prices move fast

  constructor(xrplClient: XRPLClient) {
    this.xrplClient = xrplClient;
  }

  /**
   * Get the current price of a token in XRP.
   * Tries AMM first, falls back to order book.
   */
  async getPrice(currency: string, issuer: string): Promise<TokenPrice | null> {
    const key = `${currency}:${issuer}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.fetchedAt < this.CACHE_TTL_MS) {
      return cached.price;
    }

    // Try AMM pool first
    const ammPrice = await this.fetchFromAMM(currency, issuer);
    if (ammPrice) {
      this.cache.set(key, { price: ammPrice, fetchedAt: Date.now() });
      return ammPrice;
    }

    // Fall back to order book
    const bookPrice = await this.fetchFromOrderBook(currency, issuer);
    if (bookPrice) {
      this.cache.set(key, { price: bookPrice, fetchedAt: Date.now() });
      return bookPrice;
    }

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

      if (typeof amount1 === 'string') {
        xrpDrops = parseInt(amount1);
        tokenUnits = parseFloat(amount2?.value || '0');
      } else if (typeof amount2 === 'string') {
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
      // "actNotFound" means no AMM pool exists — normal, not an error
      if (err?.message?.includes('actNotFound') || err?.message?.includes('Account not found')) {
        return null;
      }
      debug(`AMM price fetch failed for ${currency}:${issuer}: ${err?.message}`);
      return null;
    }
  }

  /**
   * Fetch price from DEX order book (fallback).
   */
  private async fetchFromOrderBook(currency: string, issuer: string): Promise<TokenPrice | null> {
    try {
      const result = await this.xrplClient.getBookOffers(
        { currency, issuer },
        { currency: 'XRP' },
        5
      );

      if (!result?.offers?.length) return null;

      let totalXRP = 0;
      let totalTokens = 0;

      for (const offer of result.offers.slice(0, 5)) {
        const xrp = this.parseDrops(offer.TakerPays);
        const tokens = this.parseTokenUnits(offer.TakerGets);
        if (xrp > 0 && tokens > 0) {
          totalXRP += xrp;
          totalTokens += tokens;
        }
      }

      if (totalTokens <= 0) return null;

      const priceXRP = totalXRP / totalTokens;
      return {
        priceXRP,
        liquidityXRP: totalXRP * 2,
        poolXRP: totalXRP,
        poolTokens: totalTokens,
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
