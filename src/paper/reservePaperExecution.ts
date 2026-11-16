/**
 * Fail-closed opt-in PAPER execution quotes using FULL XRPL AMM reserves.
 * Does not represent validated swap execution, ledger reserve locks, or
 * issuer/transfer-fee authorization checks.
 */
import { estimateAmmBuy, estimateAmmSell, AmmQuote } from './ammExecutionQuote';

export interface PaperReserveSnapshot {
  poolXrpReserve?: number;
  poolTokens?: number;
  tradingFeeUnits?: number;
  priceObservedAtMs?: number;
  priceSource?: string;
}

export interface PaperRoundTripQuote {
  boughtTokens: number;
  expectedSellBackXRP: number;
  entryImpactPct: number;
  exitImpactPct: number;
  roundTripLossPct: number;
}

export function isFreshAmmSnapshot(
  source: PaperReserveSnapshot | null | undefined, now = Date.now(),
  maxAgeMs = 15_000
): boolean {
  if (!source || source.priceSource !== 'amm' ||
      !Number.isFinite(source.poolXrpReserve) || !(source.poolXrpReserve! > 0) ||
      !Number.isFinite(source.poolTokens) || !(source.poolTokens! > 0) ||
      !Number.isInteger(source.tradingFeeUnits) ||
      source.tradingFeeUnits! < 0 || source.tradingFeeUnits! > 1000 ||
      !Number.isFinite(source.priceObservedAtMs) ||
      source.priceObservedAtMs! > now + 1000 ||
      now - source.priceObservedAtMs! > maxAgeMs) return false;
  return true;
}

export function quotePaperBuy(
  xrpIn: number, source: PaperReserveSnapshot | null | undefined,
  now = Date.now()
): AmmQuote | null {
  if (!isFreshAmmSnapshot(source, now)) return null;
  return estimateAmmBuy(xrpIn,source!.poolXrpReserve!,
    source!.poolTokens!,source!.tradingFeeUnits!);
}

export function quotePaperSell(
  tokensIn: number, source: PaperReserveSnapshot | null | undefined,
  now = Date.now()
): AmmQuote | null {
  if (!isFreshAmmSnapshot(source, now)) return null;
  return estimateAmmSell(tokensIn,source!.poolTokens!,
    source!.poolXrpReserve!,source!.tradingFeeUnits!);
}

export function quotePaperRoundTrip(
  xrpIn: number, source: PaperReserveSnapshot | null | undefined,
  now=Date.now()
): PaperRoundTripQuote | null {
  const buy=quotePaperBuy(xrpIn,source,now);
  if (!buy || !source || !(buy.amountOut>0)) return null;
  // For a hypothetical immediate round trip with no intervening activity:
  // buy adds XRP reserve, removes token reserve; sell after that into the
  // new reserve state. Includes AMM trading fee twice, plus 0.3% overhead on
  // PAPER entry and exit to avoid misleading break-even estimates.
  const sell=estimateAmmSell(buy.amountOut,
    source.poolTokens!-buy.amountOut,
    source.poolXrpReserve!+xrpIn,
    source.tradingFeeUnits!);
  if (!sell) return null;
  const expectedSellBackXRP=sell.amountOut*(1-0.003);
  const totalEntryCost=xrpIn*(1+0.003);
  return {
    boughtTokens:buy.amountOut,
    expectedSellBackXRP,
    entryImpactPct:buy.priceImpactPct,
    exitImpactPct:sell.priceImpactPct,
    roundTripLossPct:100*(1-expectedSellBackXRP/totalEntryCost),
  };
}
