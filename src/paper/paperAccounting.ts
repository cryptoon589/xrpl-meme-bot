/**
 * Deterministic PAPER inventory and fee accounting.
 *
 * These are *simulated* fill economics, not verified XRPL executable quotes.
 * Token quantities represent inventory, and must never be multiplied by the
 * percentage remaining a second time on a full close.
 */
import { PaperTrade } from '../types';

export const PAPER_ENTRY_FEE_RATE = 0.003;
export const PAPER_EXIT_FEE_RATE = 0.003;

export function initialTokens(trade: PaperTrade): number {
  const { entryAmountXRP: spend, entryPriceXRP: price } = trade;
  if (!(spend > 0) || !(price > 0)) return 0;
  const entrySlippage = Math.max(0, trade.slippageEstimate || 0);
  return spend / (price * (1 + entrySlippage));
}

/** Fallback ONLY for legacy rows lacking a persisted inventory checkpoint. */
export function reconstructedRemainingTokens(trade: PaperTrade): number {
  const remaining = Math.max(0, Math.min(100, trade.remainingPosition ?? 100));
  return initialTokens(trade) * remaining / 100;
}

/** Total realized P&L: proceeds from all legs less entry spend and entry fee. */
export function closedEconomicPnl(trade: PaperTrade): number {
  return (trade.xrpReturned || 0) -
    trade.entryAmountXRP * (1 + PAPER_ENTRY_FEE_RATE);
}

/** Realized P&L of sold fraction; remaining inventory is not marked to market. */
export function partialRealizedPnl(trade: PaperTrade): number {
  const soldFraction = 1 - Math.max(0, Math.min(100, trade.remainingPosition)) / 100;
  return (trade.xrpReturned || 0) -
    trade.entryAmountXRP * (1 + PAPER_ENTRY_FEE_RATE) * soldFraction;
}

/**
 * Indicative unsold-position mark at a recent XRP spot price.
 * Never call this a fillable sell quote; execution slippage is not modeled.
 */
export function indicativeOpenPnl(
  trade: PaperTrade, tokensRemaining: number, priceXRP: number
): { pnlXRP: number; pnlPercent: number } | null {
  if (!(priceXRP > 0) || !(tokensRemaining >= 0)) return null;
  const remainingFraction = Math.max(0, Math.min(100, trade.remainingPosition)) / 100;
  const remainingCost = trade.entryAmountXRP * (1 + PAPER_ENTRY_FEE_RATE) * remainingFraction;
  const indicativeValue = tokensRemaining * priceXRP;
  const pnlXRP = indicativeValue - remainingCost;
  return {
    pnlXRP,
    pnlPercent: remainingCost > 0 ? (pnlXRP / remainingCost) * 100 : 0,
  };
}
