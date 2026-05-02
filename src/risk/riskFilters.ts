/**
 * Risk Filter Module
 * Evaluates tokens for rug-pull risks and other red flags
 */

import { TrackedToken, AMMPool, MarketSnapshot, RiskFlags } from '../types';
import { BotConfig } from '../config';
import { debug } from '../utils/logger';

export class RiskFilter {
  private config: BotConfig;

  constructor(config: BotConfig) {
    this.config = config;
  }

  /**
   * Evaluate all risk flags for a token
   */
  evaluate(token: TrackedToken, snapshot: MarketSnapshot | null, pool: AMMPool | null): RiskFlags {
    const flags: string[] = [];

    // Check liquidity
    const lowLiquidity = this.checkLowLiquidity(snapshot);
    if (lowLiquidity) flags.push('low_liquidity');

    // Check spread
    const wideSpread = this.checkWideSpread(snapshot);
    if (wideSpread) flags.push('wide_spread');

    // Check holder count
    const lowHolderCount = this.checkLowHolders(snapshot);
    if (lowHolderCount) flags.push('low_holders');

    // Check buy activity
    const noBuyActivity = this.checkNoBuyActivity(snapshot);
    if (noBuyActivity) flags.push('no_buy_activity');

    // Check concentrated supply (mock - needs issuer analysis)
    const concentratedSupply = this.checkConcentratedSupply(token, pool);
    if (concentratedSupply) flags.push('concentrated_supply');

    // Check for dev dumping (mock - needs transaction history analysis)
    const devDumping = this.checkDevDumping(token);
    if (devDumping) flags.push('dev_dumping');

    // Check for sudden liquidity removal
    const liquidityRemoved = this.checkLiquidityRemoved(pool);
    if (liquidityRemoved) flags.push('liquidity_removed');

    // Check single wallet price manipulation
    const singleWalletPrice = this.checkSingleWalletPrice(snapshot);
    if (singleWalletPrice) flags.push('single_wallet_price');

    return {
      lowLiquidity,
      wideSpread,
      concentratedSupply,
      devDumping,
      liquidityRemoved,
      lowHolderCount,
      noBuyActivity,
      singleWalletPrice,
      flags,
    };
  }

  /**
   * Check if liquidity is below minimum threshold.
   * null liquidityXRP means price fetch failed (no AMM + no DEX data yet) —
   * treat as UNKNOWN, not confirmed low. Don't penalise tokens we simply
   * haven't got data for yet.
   */
  private checkLowLiquidity(snapshot: MarketSnapshot | null): boolean {
    if (!snapshot) return true;                  // no snapshot at all = skip
    if (snapshot.liquidityXRP === null) return false; // no data → don't flag
    return snapshot.liquidityXRP < this.config.minLiquidityXRP;
  }

  /**
   * Check if spread is too wide (>8% default)
   */
  private checkWideSpread(snapshot: MarketSnapshot | null): boolean {
    // Fix: null spread = AMM-only token (no order book) = unknown, not wide
    if (!snapshot || snapshot.spreadPercent === null) return false;
    return snapshot.spreadPercent > 8;
  }

  /**
   * Check if holder count is too low (<10 estimated)
   */
  private checkLowHolders(snapshot: MarketSnapshot | null): boolean {
    if (!snapshot || snapshot.holderEstimate === null) return false; // Unknown = not flagged
    return snapshot.holderEstimate < 10;
  }

  /**
   * Check if there's no real buy activity.
   * Only flag if we have price data AND confirmed zero buys.
   * If price is null (data fetch failed), we can't distinguish "no buys"
   * from "we didn't get data" — don't flag.
   */
  private checkNoBuyActivity(snapshot: MarketSnapshot | null): boolean {
    if (!snapshot) return true;
    if (snapshot.priceXRP === null) return false; // no data → don't flag
    return snapshot.buyCount5m === 0 && snapshot.buyVolume5m === 0;
  }

  /**
   * Check if supply is concentrated in few wallets
   * TODO: Implement by analyzing trustline distribution
   */
  private checkConcentratedSupply(token: TrackedToken, pool: AMMPool | null): boolean {
    // Mock implementation - would need to scan all trustlines for the issuer
    // For MVP, assume not concentrated unless we have data
    return false;
  }

  /**
   * Check if dev/issuer wallet is dumping
   * TODO: Implement by tracking issuer's outgoing transactions
   */
  private checkDevDumping(token: TrackedToken): boolean {
    // Mock implementation - would need transaction history analysis
    return false;
  }

  /**
   * Check if liquidity was suddenly removed
   */
  private checkLiquidityRemoved(pool: AMMPool | null): boolean {
    // This would compare current vs previous pool state
    // For MVP, we don't track historical pool states in memory
    return false;
  }

  /**
   * Check if price movement appears caused by single wallet
   * TODO: Implement by analyzing transaction sources
   */
  private checkSingleWalletPrice(snapshot: MarketSnapshot | null): boolean {
    // Mock implementation
    return false;
  }

  /**
   * Check if token passes all critical risk filters
   */
  isSafe(riskFlags: RiskFlags): boolean {
    // Critical flags that must be false
    return !riskFlags.lowLiquidity && !riskFlags.wideSpread;
  }

  /**
   * Get risk severity level
   */
  getSeverity(riskFlags: RiskFlags): 'low' | 'medium' | 'high' | 'critical' {
    const flagCount = riskFlags.flags.length;

    if (flagCount === 0) return 'low';
    if (flagCount <= 2) return 'medium';
    if (flagCount <= 4) return 'high';
    return 'critical';
  }
}
