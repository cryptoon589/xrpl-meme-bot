/**
 * Market Data Module
 * Calculates price, liquidity, volume, holder estimates for tracked tokens
 */

import { XRPLClient } from '../xrpl/client';
import { TrackedToken, AMMPool, MarketSnapshot } from '../types';
import { info, debug, warn } from '../utils/logger';
import { Database } from '../db/database';

// Price history cache: key = "currency:issuer", value = array of {timestamp, price}
interface PricePoint {
  timestamp: number;
  price: number;
}

export class MarketDataCollector {
  private xrplClient: XRPLClient;
  private db: Database;
  private priceHistory: Map<string, PricePoint[]> = new Map();
  private snapshots: Map<string, MarketSnapshot> = new Map();
  private maxHistoryPoints = 150; // Keep last 150 price points per token (~2.5h at 60s scan interval)
  private lastPruneTime = 0;
  private readonly PRUNE_INTERVAL_MS = 3600000; // Prune every hour

  // FIX #16: Track consecutive failures per token
  private failureCounts: Map<string, number> = new Map();
  private readonly MAX_CONSECUTIVE_FAILURES = 5;

  constructor(xrplClient: XRPLClient, db: Database) {
    this.xrplClient = xrplClient;
    this.db = db;
  }

  /**
   * FIX #19 & #21: Prune old price history and snapshots to prevent memory leaks
   */
  private pruneOldData(): void {
    const now = Date.now();
    if (now - this.lastPruneTime < this.PRUNE_INTERVAL_MS) return;

    this.lastPruneTime = now;
    const cutoffTime = now - 24 * 60 * 60 * 1000; // 24 hours ago

    let prunedSnapshots = 0;
    let prunedHistories = 0;

    // Prune snapshots not updated in 24 hours
    for (const [key, snapshot] of this.snapshots.entries()) {
      if (snapshot.timestamp < cutoffTime) {
        this.snapshots.delete(key);
        prunedSnapshots++;
      }
    }

    // Prune price history for tokens with no recent snapshots
    for (const [key, history] of this.priceHistory.entries()) {
      if (!this.snapshots.has(key) || history.length === 0) {
        this.priceHistory.delete(key);
        prunedHistories++;
      }
    }

    if (prunedSnapshots > 0 || prunedHistories > 0) {
      info(`Pruned ${prunedSnapshots} stale snapshots, ${prunedHistories} empty price histories`);
    }
  }

  /**
   * Collect market data for a token with real volume and holder data
   */
  async collectMarketDataWithExtras(
    token: TrackedToken,
    ammPool: AMMPool | null | undefined,
    volumeData: { buyVolume: number; sellVolume: number; buyCount: number; sellCount: number; uniqueBuyers: number; uniqueSellers: number },
    holderCount: number | null,
    ammPrice?: { priceXRP: number; liquidityXRP: number } | null  // pre-fetched AMM price
  ): Promise<MarketSnapshot | null> {
    try {
      const key = `${token.currency}:${token.issuer}`;
      const rawCurrency = token.rawCurrency || token.currency;

      // Fix 5+6: Use pre-fetched AMM price when available (correct price for history/changes)
      let priceXRP: number | null = ammPrice?.priceXRP ?? null;
      let liquidityXRP: number | null = ammPrice?.liquidityXRP ?? null;

      // Fall back to AMM pool object, then order book (with raw currency)
      if (priceXRP === null) {
        if (ammPool) {
          const result = this.calculatePriceFromAMM(ammPool, token.currency, token.issuer);
          priceXRP = result.price;
          liquidityXRP = result.liquidity;
        } else {
          // Fix 1: use rawCurrency for book_offers
          const bookResult = await this.getPriceFromBookOffers(rawCurrency, token.issuer);
          priceXRP = bookResult.price;
          liquidityXRP = bookResult.liquidity;
        }
      }

      // Calculate price changes (now using correct price)
      const priceChanges = this.calculatePriceChanges(key, priceXRP);

      // Fix 3: use rawCurrency for spread; Fix 4: null spread = not wide
      const spreadPercent = await this.calculateSpread(rawCurrency, token.issuer);

      const snapshot: MarketSnapshot = {
        tokenCurrency: token.currency,
        tokenIssuer: token.issuer,
        timestamp: Date.now(),
        priceXRP,
        liquidityXRP,
        buyVolume5m: volumeData.buyVolume,
        sellVolume5m: volumeData.sellVolume,
        buyCount5m: volumeData.buyCount,
        sellCount5m: volumeData.sellCount,
        uniqueBuyers5m: volumeData.uniqueBuyers,
        uniqueSellers5m: volumeData.uniqueSellers,
        priceChange5m: priceChanges.change5m,
        priceChange15m: priceChanges.change15m,
        priceChange1h: priceChanges.change1h,
        holderEstimate: holderCount,
        spreadPercent,
      };

      // Save snapshot
      this.snapshots.set(key, snapshot);
      this.db.saveMarketSnapshot(snapshot);

      // Update price history
      if (priceXRP !== null && priceXRP > 0) {
        this.updatePriceHistory(key, priceXRP);
      }

      // Reset failure count on success
      this.resetFailureCount(key);

      // Periodically prune old data
      this.pruneOldData();

      return snapshot;
    } catch (err) {
      const key = `${token.currency}:${token.issuer}`;
      const failures = (this.failureCounts.get(key) || 0) + 1;
      this.failureCounts.set(key, failures);

      if (failures >= this.MAX_CONSECUTIVE_FAILURES) {
        warn(`⚠️ Token ${key} has failed ${failures} consecutive market data collections`);
      }

      warn(`Error collecting market data for ${token.currency}:${token.issuer}: ${err}`);
      return null;
    }
  }

  /**
   * Collect market data for a token (legacy method, uses mock volume/holders)
   */
  async collectMarketData(token: TrackedToken, ammPool?: AMMPool | null): Promise<MarketSnapshot | null> {
    try {
      const key = `${token.currency}:${token.issuer}`;

      // Get current price and liquidity
      let priceXRP: number | null = null;
      let liquidityXRP: number | null = null;

      if (ammPool) {
        // Calculate price from AMM pool using constant product formula
        const result = this.calculatePriceFromAMM(ammPool, token.currency, token.issuer);
        priceXRP = result.price;
        liquidityXRP = result.liquidity;
      } else {
        // Fallback: try to get price from order book
        const bookResult = await this.getPriceFromBookOffers(token.currency, token.issuer);
        priceXRP = bookResult.price;
        liquidityXRP = bookResult.liquidity;
      }

      // Get volume data (mock fallback)
      const volumeData = this.getVolumeEstimate(key);

      // Calculate price changes
      const priceChanges = this.calculatePriceChanges(key, priceXRP);

      // Estimate holder count (mock - real implementation would scan trustlines)
      const holderEstimate = this.estimateHolders(token.issuer, token.currency);

      // Calculate spread
      const spreadPercent = await this.calculateSpread(token.currency, token.issuer);

      const snapshot: MarketSnapshot = {
        tokenCurrency: token.currency,
        tokenIssuer: token.issuer,
        timestamp: Date.now(),
        priceXRP,
        liquidityXRP,
        buyVolume5m: volumeData.buyVolume,
        sellVolume5m: volumeData.sellVolume,
        buyCount5m: volumeData.buyCount,
        sellCount5m: volumeData.sellCount,
        uniqueBuyers5m: 0, // Mock - only available via collectMarketDataWithExtras
        uniqueSellers5m: 0,
        priceChange5m: priceChanges.change5m,
        priceChange15m: priceChanges.change15m,
        priceChange1h: priceChanges.change1h,
        holderEstimate,
        spreadPercent,
      };

      // Save snapshot
      this.snapshots.set(key, snapshot);
      this.db.saveMarketSnapshot(snapshot);

      // Update price history
      if (priceXRP !== null && priceXRP > 0) {
        this.updatePriceHistory(key, priceXRP);
      }

      // FIX #16: Reset failure count on success
      this.resetFailureCount(key);

      // FIX #19 & #21: Periodically prune old data
      this.pruneOldData();

      return snapshot;
    } catch (err) {
      // FIX #16: Track consecutive failures
      const key = `${token.currency}:${token.issuer}`;
      const failures = (this.failureCounts.get(key) || 0) + 1;
      this.failureCounts.set(key, failures);

      if (failures >= this.MAX_CONSECUTIVE_FAILURES) {
        warn(`⚠️ Token ${key} has failed ${failures} consecutive market data collections`);
      }

      warn(`Error collecting market data for ${token.currency}:${token.issuer}: ${err}`);
      return null;
    }
  }

  /**
   * FIX #16: Reset failure count on successful collection
   */
  private resetFailureCount(key: string): void {
    if (this.failureCounts.has(key)) {
      this.failureCounts.delete(key);
    }
  }

  /**
   * Calculate price from AMM pool using constant product formula
   * FIX #6: Only calculate price if one asset is XRP
   * Price of token in XRP = amountXRP / amountToken
   */
  private calculatePriceFromAMM(
    pool: AMMPool,
    tokenCurrency: string,
    tokenIssuer: string
  ): { price: number | null; liquidity: number | null } {
    try {
      // Determine which asset is the token and which is XRP
      let tokenAmount: number = 0;
      let xrpAmount: number = 0;

      const asset1IsToken =
        pool.asset1.currency === tokenCurrency && pool.asset1.issuer === tokenIssuer;
      const asset2IsToken =
        pool.asset2.currency === tokenCurrency && pool.asset2.issuer === tokenIssuer;

      if (asset1IsToken) {
        tokenAmount = this.parseAmount(pool.amount1);
        // XRP amounts from ledger are in drops — divide by 1e6
        xrpAmount = this.parseAmount(pool.amount2) / 1_000_000;

        // FIX #6: Verify the other asset is XRP
        if (pool.asset2.currency !== 'XRP') {
          debug(`AMM pool for ${tokenCurrency} is not paired with XRP (paired with ${pool.asset2.currency})`);
          return { price: null, liquidity: null };
        }
      } else if (asset2IsToken) {
        tokenAmount = this.parseAmount(pool.amount2);
        // XRP amounts from ledger are in drops — divide by 1e6
        xrpAmount = this.parseAmount(pool.amount1) / 1_000_000;

        // FIX #6: Verify the other asset is XRP
        if (pool.asset1.currency !== 'XRP') {
          debug(`AMM pool for ${tokenCurrency} is not paired with XRP (paired with ${pool.asset1.currency})`);
          return { price: null, liquidity: null };
        }
      } else {
        return { price: null, liquidity: null };
      }

      if (tokenAmount <= 0 || xrpAmount <= 0) {
        return { price: null, liquidity: null };
      }

      // Price of 1 token in XRP
      const price = xrpAmount / tokenAmount;

      // Liquidity in XRP terms (total pool value in XRP)
      const liquidity = xrpAmount * 2; // Both sides of the pool

      return { price, liquidity };
    } catch (err) {
      debug(`Error calculating AMM price: ${err}`);
      return { price: null, liquidity: null };
    }
  }

  /**
   * Parse amount string/value to number
   * FIX #11: Handle all XRPL amount formats including IssuedCurrencyAmount objects
   */
  private parseAmount(amount: string | number | any): number {
    if (typeof amount === 'number') return amount;
    if (typeof amount === 'string') {
      // Handle scientific notation (e.g., "1e6") or plain numbers
      const parsed = parseFloat(amount);
      return isNaN(parsed) ? 0 : parsed;
    }
    if (amount && typeof amount === 'object') {
      // XRPL IssuedCurrencyAmount: { value: "1.5", currency: "USD", issuer: "r..." }
      // Or alternative format: { amount: "123" }
      if (amount.value !== undefined) {
        const parsed = parseFloat(amount.value);
        return isNaN(parsed) ? 0 : parsed;
      }
      if (amount.amount !== undefined) {
        const parsed = parseFloat(amount.amount);
        return isNaN(parsed) ? 0 : parsed;
      }
      // Fallback: try to stringify and parse
      try {
        const str = JSON.stringify(amount);
        const parsed = parseFloat(str);
        return isNaN(parsed) ? 0 : parsed;
      } catch {
        return 0;
      }
    }
    return 0;
  }

  /**
   * Get price from order book (fallback when no AMM exists)
   */
  private async getPriceFromBookOffers(
    currency: string,
    issuer: string
  ): Promise<{ price: number | null; liquidity: number | null }> {
    try {
      // Get book offers: taker gets token, pays XRP
      const bookResult = await this.xrplClient.getBookOffers(
        { currency, issuer }, // taker_gets: the token
        { currency: 'XRP' }, // taker_pays: XRP
        10
      );

      if (!bookResult || !bookResult.offers || bookResult.offers.length === 0) {
        return { price: null, liquidity: null };
      }

      // Calculate weighted average price from top offers
      let totalXRP = 0;
      let totalTokens = 0;
      let liquidity = 0;

      for (const offer of bookResult.offers.slice(0, 5)) {
        const takerPays = this.parseAmount(offer.TakerPays);
        const takerGets = this.parseAmount(offer.TakerGets);

        if (takerGets > 0) {
          totalXRP += takerPays;
          totalTokens += takerGets;
          liquidity += takerPays;
        }
      }

      const price = totalTokens > 0 ? totalXRP / totalTokens : null;

      return { price, liquidity };
    } catch (err) {
      debug(`Error getting book offers: ${err}`);
      return { price: null, liquidity: null };
    }
  }

  /**
   * Get volume estimate (MOCK - placeholder for real transaction tracking)
   * In production, this would analyze recent Payment/AMMTrade transactions
   */
  private getVolumeEstimate(key: string): {
    buyVolume: number;
    sellVolume: number;
    buyCount: number;
    sellCount: number;
  } {
    // TODO: Implement real volume tracking by monitoring transactions
    // For MVP, return zeros - this will be populated as we track trades
    return {
      buyVolume: 0,
      sellVolume: 0,
      buyCount: 0,
      sellCount: 0,
    };
  }

  /**
   * Calculate price changes over different time periods
   */
  private calculatePriceChanges(
    key: string,
    currentPrice: number | null
  ): { change5m: number | null; change15m: number | null; change1h: number | null } {
    const history = this.priceHistory.get(key) || [];

    if (!currentPrice || history.length === 0) {
      return { change5m: null, change15m: null, change1h: null };
    }

    const now = Date.now();
    const fiveMinAgo = now - 5 * 60 * 1000;
    const fifteenMinAgo = now - 15 * 60 * 1000;
    const oneHourAgo = now - 60 * 60 * 1000;

    const findPriceAtTime = (targetTime: number): number | null => {
      // Find closest price point to target time
      let closest: PricePoint | null = null;
      let minDiff = Infinity;

      for (const point of history) {
        const diff = Math.abs(point.timestamp - targetTime);
        if (diff < minDiff) {
          minDiff = diff;
          closest = point;
        }
      }

      // Accept price points within 80% of the target window
      // e.g. for 5m target: accept within 4m; for 1h target: accept within 48m
      // Relaxed from 50% to avoid N/A when token scan cadence is uneven
      if (closest && minDiff < Math.abs(now - targetTime) * 0.8) {
        return closest.price;
      }
      return null;
    };

    const price5m = findPriceAtTime(fiveMinAgo);
    const price15m = findPriceAtTime(fifteenMinAgo);
    const price1h = findPriceAtTime(oneHourAgo);

    const calcChange = (oldPrice: number | null): number | null => {
      if (!oldPrice || oldPrice <= 0) return null;
      return ((currentPrice - oldPrice) / oldPrice) * 100;
    };

    return {
      change5m: calcChange(price5m),
      change15m: calcChange(price15m),
      change1h: calcChange(price1h),
    };
  }

  /**
   * Update price history
   */
  private updatePriceHistory(key: string, price: number): void {
    const history = this.priceHistory.get(key) || [];
    history.push({ timestamp: Date.now(), price });

    // Keep only last N points
    if (history.length > this.maxHistoryPoints) {
      history.splice(0, history.length - this.maxHistoryPoints);
    }

    this.priceHistory.set(key, history);
  }

  /**
   * Estimate holder count (MOCK - placeholder)
   * Real implementation would query account_lines for the issuer
   */
  private estimateHolders(issuer: string, currency: string): number | null {
    // TODO: Implement real holder counting by scanning trustlines
    // For MVP, return null - this requires significant API calls
    return null;
  }

  /**
   * Calculate spread percentage from order book
   */
  private async calculateSpread(currency: string, issuer: string): Promise<number | null> {
    try {
      // Get both sides of the book
      const asks = await this.xrplClient.getBookOffers(
        { currency, issuer },
        { currency: 'XRP' },
        1
      );

      const bids = await this.xrplClient.getBookOffers(
        { currency: 'XRP' },
        { currency, issuer },
        1
      );

      if (!asks?.offers?.length || !bids?.offers?.length) {
        return null;
      }

      const bestAsk = this.parseAmount(asks.offers[0].TakerPays) / this.parseAmount(asks.offers[0].TakerGets);
      const bestBid = this.parseAmount(bids.offers[0].TakerGets) / this.parseAmount(bids.offers[0].TakerPays);

      if (bestAsk <= 0 || bestBid <= 0) return null;

      const spread = ((bestAsk - bestBid) / bestBid) * 100;
      return spread;
    } catch (err) {
      debug(`Error calculating spread: ${err}`);
      return null;
    }
  }

  /**
   * Get latest snapshot for a token
   */
  getSnapshot(currency: string, issuer: string): MarketSnapshot | null {
    const key = `${currency}:${issuer}`;
    return this.snapshots.get(key) || null;
  }

  /**
   * Get all snapshots
   */
  getAllSnapshots(): MarketSnapshot[] {
    return Array.from(this.snapshots.values());
  }
}
