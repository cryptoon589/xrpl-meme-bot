/**
 * Parse a validated XRP / issued-token AMM response without accepting a
 * different issuer/ticker collision, reversed reserves, frozen assets,
 * malformed amounts, or nonsensical fee units as a tradable price.
 *
 * Pure helper for burst signals and normal price reads. NOT a firm sell quote.
 */
import { normalizeIssuedCurrency } from '../xrpl/currencyCode';

export interface ParsedIssuedAmm {
  priceXRP: number;
  liquidityXRP: number;
  poolXRP: number;
  poolTokens: number;
  tradingFeeUnits: number;
}

export function parseXrpIssuedAmm(
  amm: any, expectedCurrency: string, expectedIssuer: string
): ParsedIssuedAmm | null {
  const expected = normalizeIssuedCurrency(expectedCurrency);
  if (!expected || !expectedIssuer || !amm || typeof amm !== 'object') return null;

  const a=amm.amount, b=amm.amount2;
  const xrpFirst=typeof a==='string' && b != null && typeof b==='object' && !Array.isArray(b);
  const xrpSecond=typeof b==='string' && a != null && typeof a==='object' && !Array.isArray(a);
  if (!xrpFirst && !xrpSecond) return null;
  const dropsRaw: string=xrpFirst?a:b;
  const issued=xrpFirst?b:a;
  if (!/^[0-9]+$/.test(dropsRaw)) return null;
  const drops=Number(dropsRaw);
  const tokenUnits=Number(issued.value);
  if (!Number.isSafeInteger(drops) || drops<=0 ||
      !Number.isFinite(tokenUnits) || tokenUnits<=0 ||
      typeof issued.currency!=='string' || issued.issuer!==expectedIssuer ||
      normalizeIssuedCurrency(issued.currency)!==expected) return null;

  // On XRP AMM the issued asset is the only potentially frozen side.
  if ((xrpFirst && amm.asset2_frozen===true) ||
      (xrpSecond && amm.asset_frozen===true) ||
      amm.asset_frozen===true || amm.asset2_frozen===true) return null;
  const fee=amm.trading_fee==null?0:Number(amm.trading_fee);
  if (!Number.isInteger(fee) || fee<0 || fee>1000) return null; // 1/100000 units

  const poolXRP=drops/1_000_000;
  const priceXRP=poolXRP/tokenUnits;
  if (!Number.isFinite(poolXRP) || !(poolXRP>0) ||
      !Number.isFinite(priceXRP) || !(priceXRP>0)) return null;
  return {
    priceXRP,poolXRP,poolTokens:tokenUnits,
    liquidityXRP:poolXRP*2,tradingFeeUnits:fee
  };
}
