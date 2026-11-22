/**
 * Versioned recovery checkpoint for non-economic PAPER exit state.
 * Cash and remaining token quantities remain in the atomic PAPER ledger.
 * DO NOT reconstruct a high-water price by assuming entry price after restart:
 * that would change the trailing stop and silently alter exit economics.
 */
import { PaperTrade } from '../types';
import { TradeProfileName, PROFILES } from '../execution/tradeProfiles';

export interface PaperPositionRuntimeState {
  version: 1;
  tradeId: number;
  entryTimestamp: number;
  highestPriceSinceEntry: number;
  openedAt: number;
  lastBuySeenAt: number;
  liquidityAtEntry: number;
  tradeProfile: 'burst'|'scored';
  profileName: TradeProfileName;
  priceHistory: number[];
  stopLossPercent?: number;
  tp1Pct?: number;
  tp2Pct?: number;
}

export function validPaperPositionRuntime(
  raw: unknown, trade: PaperTrade
): raw is PaperPositionRuntimeState {
  if(!raw || typeof raw!=='object')return false;
  const x=raw as Partial<PaperPositionRuntimeState>;
  const validNumber=(n:unknown)=>typeof n==='number' && Number.isFinite(n);
  const optionalNumber=(n:unknown)=>n===undefined||
    (validNumber(n) && (n as number)>=0 && (n as number)<=100);
  return x.version===1 && Number.isInteger(x.tradeId) &&
    x.tradeId===trade.id && x.entryTimestamp===trade.entryTimestamp &&
    validNumber(x.highestPriceSinceEntry) &&
    x.highestPriceSinceEntry!>=trade.entryPriceXRP &&
    validNumber(x.openedAt) && x.openedAt!>=trade.entryTimestamp &&
    validNumber(x.lastBuySeenAt) && x.lastBuySeenAt!>=0 &&
    validNumber(x.liquidityAtEntry) && x.liquidityAtEntry!>=0 &&
    (x.tradeProfile==='burst'||x.tradeProfile==='scored') &&
    typeof x.profileName==='string' && x.profileName in PROFILES &&
    Array.isArray(x.priceHistory) &&
    x.priceHistory.length>=1 && x.priceHistory.length<=10 &&
    x.priceHistory.every(n=>validNumber(n)&&n>0) &&
    optionalNumber(x.stopLossPercent) &&
    optionalNumber(x.tp1Pct) && optionalNumber(x.tp2Pct);
}
