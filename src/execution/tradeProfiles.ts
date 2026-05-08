/**
 * Trade Profiles
 *
 * Defines risk/reward parameters for each trade archetype.
 * Used by TradeDecisionEngine, PaperTrader, and (future) LiveExecutor.
 *
 * Profiles:
 *   LOW_LIQ_PROBE   — tiny size on thin pools; reject only if slippage fatal
 *   BURST_SCALP     — fast pump; tight stop, quick exits
 *   MOMENTUM_RUNNER — sustained move; wider stop, ladder exits
 *   WAKEUP_TRADE    — first activity on dormant token; conservative size
 */

export type TradeProfileName =
  | 'LOW_LIQ_PROBE'
  | 'BURST_SCALP'
  | 'MOMENTUM_RUNNER'
  | 'WAKEUP_TRADE';

export interface TradeProfile {
  name: TradeProfileName;
  /** Minimum poolXrpReserve (XRP side of AMM) required to enter */
  minPoolXrpReserve: number;
  /** Maximum allowed slippage (0–1). Above this → reject. */
  maxSlippage: number;
  /** Maximum allowed round-trip loss % after fees+slippage before rejecting */
  maxRoundTripLossPct: number;
  /** Base trade size in XRP (subject to bankroll cap) */
  baseSizeXRP: number;
  /** Maximum trade size in XRP (hard cap) */
  maxSizeXRP: number;
  /** Sizing multiplier: tradeSize = baseSizeXRP * (poolXrpReserve / scalePoolXRP) capped at maxSizeXRP */
  scalePoolXRP: number;
  /** Stop loss % below entry (positive number, applied as negative) */
  stopLossPct: number;
  /** TP1 % gain → sell tp1SellPct of original position */
  tp1Pct: number;
  tp1SellPct: number;   // % of ORIGINAL position to sell at TP1
  /** TP2 % gain → sell tp2SellPct of original position */
  tp2Pct: number;
  tp2SellPct: number;   // % of ORIGINAL position to sell at TP2
  /** Runner: what remains after TP1+TP2 sells (should be 100 - tp1SellPct - tp2SellPct) */
  runnerPct: number;
  /** Trailing stop activation threshold (% gain) */
  trailActivationPct: number;
  /** Trailing stop distance (% below highest price) */
  trailDistancePct: number;
  /** Hard time stop in ms; 0 = disabled */
  timeStopMs: number;
  /** Kill switches (follow-through guard) */
  killSwitches: {
    noNewBuyMins: number;        // close if no new buy within N mins AND price < entry
    sellVolumeMultiple: number;  // close if sellVol > buyVol × N before TP1
    liqDropPct: number;          // close if liquidity drops > N%
  };
}

export const PROFILES: Record<TradeProfileName, TradeProfile> = {

  LOW_LIQ_PROBE: {
    name: 'LOW_LIQ_PROBE',
    minPoolXrpReserve: 100,       // as low as 100 XRP pool side
    maxSlippage: 0.08,            // up to 8% — small size minimises impact
    maxRoundTripLossPct: 15,
    baseSizeXRP: 2,
    maxSizeXRP: 5,
    scalePoolXRP: 500,
    stopLossPct: 10,
    tp1Pct: 25,  tp1SellPct: 60,
    tp2Pct: 50,  tp2SellPct: 30,
    runnerPct: 10,
    trailActivationPct: 18,
    trailDistancePct: 8,
    timeStopMs: 30 * 60 * 1000,  // 30 min
    killSwitches: { noNewBuyMins: 8, sellVolumeMultiple: 2, liqDropPct: 25 },
  },

  BURST_SCALP: {
    name: 'BURST_SCALP',
    minPoolXrpReserve: 500,
    maxSlippage: 0.04,
    maxRoundTripLossPct: 12,
    baseSizeXRP: 5,
    maxSizeXRP: 25,
    scalePoolXRP: 5000,
    stopLossPct: 8,
    tp1Pct: 15,  tp1SellPct: 60,
    tp2Pct: 30,  tp2SellPct: 30,
    runnerPct: 10,
    trailActivationPct: 10,
    trailDistancePct: 5,
    timeStopMs: 45 * 60 * 1000,  // 45 min
    killSwitches: { noNewBuyMins: 10, sellVolumeMultiple: 2, liqDropPct: 25 },
  },

  MOMENTUM_RUNNER: {
    name: 'MOMENTUM_RUNNER',
    minPoolXrpReserve: 2000,
    maxSlippage: 0.03,
    maxRoundTripLossPct: 10,
    baseSizeXRP: 5,
    maxSizeXRP: 20,
    scalePoolXRP: 10000,
    stopLossPct: 10,
    tp1Pct: 10,  tp1SellPct: 40,
    tp2Pct: 20,  tp2SellPct: 30,
    runnerPct: 30,
    trailActivationPct: 12,
    trailDistancePct: 12,
    timeStopMs: 90 * 60 * 1000,  // 90 min
    killSwitches: { noNewBuyMins: 10, sellVolumeMultiple: 2, liqDropPct: 25 },
  },

  WAKEUP_TRADE: {
    name: 'WAKEUP_TRADE',
    minPoolXrpReserve: 300,
    maxSlippage: 0.05,
    maxRoundTripLossPct: 12,
    baseSizeXRP: 3,
    maxSizeXRP: 10,
    scalePoolXRP: 2000,
    stopLossPct: 8,
    tp1Pct: 20,  tp1SellPct: 50,
    tp2Pct: 40,  tp2SellPct: 30,
    runnerPct: 20,
    trailActivationPct: 15,
    trailDistancePct: 7,
    timeStopMs: 60 * 60 * 1000,  // 60 min
    killSwitches: { noNewBuyMins: 10, sellVolumeMultiple: 2, liqDropPct: 25 },
  },
};

/**
 * Calculate dynamic trade size for a profile based on pool depth.
 * size = baseSizeXRP * (poolXrpReserve / scalePoolXRP), clamped [baseSizeXRP, maxSizeXRP].
 * Also capped to maxBankrollPct of current bankroll.
 */
export function calcProfileSize(
  profile: TradeProfile,
  poolXrpReserve: number,
  bankrollXRP: number,
  maxBankrollPct = 0.10
): number {
  const scaledSize = profile.baseSizeXRP * (poolXrpReserve / profile.scalePoolXRP);
  const bankrollCap = bankrollXRP * maxBankrollPct;
  return Math.min(
    Math.max(scaledSize, profile.baseSizeXRP),
    profile.maxSizeXRP,
    bankrollCap
  );
}

/**
 * Estimate round-trip loss % given slippage, fees, and profile.
 * Entry: buy at price*(1+slip), fee on entry.
 * Exit:  sell at price*(1-slip), fee on exit.
 * roundTripLoss = 2*slip + 2*fee  (symmetric worst case)
 */
export function estimateRoundTripLossPct(slippage: number, feePct = 0.003): number {
  return (slippage + feePct) * 2 * 100; // return as %
}
