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
   * Evaluate risk flags that matter for quick profit trades.
   *
   * Philosophy: we are NOT long-term holders. We do not care about
   * holder concentration, dev reputation, or supply distribution.
   * We care about 3 things:
   *   1. Can we enter? (min liquidity)
   *   2. Can we exit? (spread cost vs expected gain)
   *   3. Is this real buying? (not a single-wallet wash trade)
   *
   * devDumping and liquidityRemoved are stubs - always false.
   * lowHolderCount is irrelevant - a 10-holder token can 5x in 10 min.
   * concentratedSupply is only flagged for truly ghost tokens (<3 holders).
   */
  evaluate(token: TrackedToken, snapshot: MarketSnapshot | null, pool: AMMPool | null): RiskFlags {
    const flags: string[] = [];

    // Gate 1: minimum liquidity to enter and exit without wrecking the price
    const lowLiquidity = this.checkLowLiquidity(snapshot);
    if (lowLiquidity) flags.push('low_liquidity');

    // Gate 2: spread cost. >8% spread means execution eats our profit before we start
    const wideSpread = this.checkWideSpread(snapshot);
    if (wideSpread) flags.push('wide_spread');

    // Gate 3: single-wallet wash trade. Price moving but 1 wallet = not real demand.
    // We can't profit off wash - we'd be buying into a dump with no other exit.
    const singleWalletPrice = this.checkSingleWalletPrice(snapshot);
    if (singleWalletPrice) flags.push('single_wallet_price');

    // Ghost token check: <3 holders means effectively no market
    const concentratedSupply = this.checkGhostToken(snapshot);
    if (concentratedSupply) flags.push('concentrated_supply');

    // No buy activity at all (0 buys AND 0 volume with a valid price)
    const noBuyActivity = this.checkNoBuyActivity(snapshot);
    if (noBuyActivity) flags.push('no_buy_activity');

    return {
      lowLiquidity,
      wideSpread,
      concentratedSupply,
      devDumping:       false, // stub - not implemented, not needed for quick trades
      liquidityRemoved: false, // stub - not implemented
      lowHolderCount:   false, // irrelevant for quick trades
      noBuyActivity,
      singleWalletPrice,
      flags,
    };
  }

  /**
   * Check if liquidity is below minimum threshold.
   * null liquidityXRP means price fetch failed (no AMM + no DEX data yet) -
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

  // lowHolderCount removed - irrelevant for quick trades.

  /**
   * Check if there's no real buy activity.
   * Only flag if we have price data AND confirmed zero buys.
   * If price is null (data fetch failed), we can't distinguish "no buys"
   * from "we didn't get data" - don't flag.
   */
  private checkNoBuyActivity(snapshot: MarketSnapshot | null): boolean {
    if (!snapshot) return true;
    if (snapshot.priceXRP === null) return false; // no data → don't flag
    return snapshot.buyCount5m === 0 && snapshot.buyVolume5m === 0;
  }

  /**
   * Ghost token check: <3 total holders means effectively no market exists.
   * Holder concentration (10 holders, 90% in 1 wallet) is NOT flagged -
   * that's a long-term holding concern, not our problem on a quick trade.
   */
  private checkGhostToken(snapshot: MarketSnapshot | null): boolean {
    if (!snapshot || snapshot.holderEstimate === null) return false;
    return snapshot.holderEstimate < 3;
  }

  /**
   * Check if price movement appears caused by a single wallet (wash trading)
   * Flags when: price moved meaningfully but <2 unique buyers drove it.
   * Real organic pumps have distributed buying.
   */
  private checkSingleWalletPrice(snapshot: MarketSnapshot | null): boolean {
    if (!snapshot) return false;
    const uniqueBuyers = snapshot.uniqueBuyers5m ?? 0;
    const buyCount     = snapshot.buyCount5m     ?? 0;
    const priceMove    = Math.abs(snapshot.priceChange5m ?? 0);

    // Flag: price moved >10% but only 1 unique buyer drove it
    if (priceMove > 10 && uniqueBuyers <= 1 && buyCount >= 2) return true;

    // Flag: >5 buys but all from the same 1-2 wallets (ratio check)
    // uniqueBuyers / buyCount < 0.3 means very few distinct wallets
    if (buyCount >= 5 && uniqueBuyers > 0 && (uniqueBuyers / buyCount) < 0.3) return true;

    return false;
  }

  /**
   * Hard entry gates — only 3 things block a trade:
   *
   *   1. Min liquidity not met (can't enter/exit cleanly)
   *   2. Spread >8% (execution cost destroys expected P&L)
   *   3. Single-wallet wash trade (no real demand to profit from)
   *
   * Everything else — holder count, dev reputation, supply concentration —
   * is a long-term holding concern, not our problem on a 10-60 min trade.
   */
  isSafe(riskFlags: RiskFlags): boolean {
    if (riskFlags.lowLiquidity)      return false; // can't trade it
    if (riskFlags.wideSpread)        return false; // cost > expected gain
    if (riskFlags.singleWalletPrice) return false; // wash trade, no real exit
    if (riskFlags.concentratedSupply) return false; // ghost token (<3 holders)
    return true;
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
