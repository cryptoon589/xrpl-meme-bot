/**
 * Reserve-aware AMM quote ESTIMATES for PAPER accounting and diagnostics.
 * XRPL AMM trading_fee is an integer in units of 1/100,000 (0..1000).
 * The equal-weight XRPL AMM uses a constant-product curve. This is NOT an
 * executable quote, trustline/issuer check, transaction simulation, or guarantee
 * of token delivery; actual routes may use both AMM and CLOB.
 */
export interface AmmQuote {
  amountOut: number;
  spotValue: number;
  priceImpactPct: number;
  feeRate: number;
}

function feeRateFromUnits(units: number): number | null {
  return Number.isInteger(units) && units >= 0 && units <= 1000
    ? units / 100000 : null;
}

export function estimateAmmSell(
  tokensIn: number, reserveTokens: number, reserveXRP: number,
  tradingFeeUnits: number
): AmmQuote | null {
  const fee = feeRateFromUnits(tradingFeeUnits);
  if (fee === null || !Number.isFinite(tokensIn) || !(tokensIn > 0) ||
      !Number.isFinite(reserveTokens) || !(reserveTokens > 0) ||
      !Number.isFinite(reserveXRP) || !(reserveXRP > 0)) return null;
  const effectiveTokens = tokensIn * (1 - fee);
  const outXRP = reserveXRP * effectiveTokens / (reserveTokens + effectiveTokens);
  const spotValue = tokensIn * reserveXRP / reserveTokens;
  if (!(outXRP > 0) || !(outXRP < reserveXRP) ||
      !Number.isFinite(outXRP) || !Number.isFinite(spotValue)) return null;
  return {
    amountOut: outXRP, spotValue, feeRate: fee,
    priceImpactPct: 100 * (1 - outXRP / spotValue),
  };
}

export function estimateAmmBuy(
  xrpIn: number, reserveXRP: number, reserveTokens: number,
  tradingFeeUnits: number
): AmmQuote | null {
  const fee = feeRateFromUnits(tradingFeeUnits);
  if (fee === null || !Number.isFinite(xrpIn) || !(xrpIn > 0) ||
      !Number.isFinite(reserveXRP) || !(reserveXRP > 0) ||
      !Number.isFinite(reserveTokens) || !(reserveTokens > 0)) return null;
  const effectiveXRP = xrpIn * (1 - fee);
  const outTokens = reserveTokens * effectiveXRP / (reserveXRP + effectiveXRP);
  const spotValue = xrpIn * reserveTokens / reserveXRP;
  if (!(outTokens > 0) || !(outTokens < reserveTokens) ||
      !Number.isFinite(outTokens) || !Number.isFinite(spotValue)) return null;
  return {
    amountOut: outTokens, spotValue, feeRate: fee,
    priceImpactPct: 100 * (1 - outTokens / spotValue),
  };
}
