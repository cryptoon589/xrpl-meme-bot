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
    // Raised from 100 → 500 XRP — 100 XRP pools are near-certain rugs/failures.
    // Small pools need more TP room and wider stops since they're more volatile.
    minPoolXrpReserve: 500,
    maxSlippage: 0.06,
    maxRoundTripLossPct: 15,
    baseSizeXRP: 2,
    maxSizeXRP: 5,
    scalePoolXRP: 500,
    // Widened stop: -15% (was -10%). Thin pools wick harder; tight stops get shaken out.
    stopLossPct: 15,
    // Kept aggressive TP1 to lock profits fast on thin pools
    tp1Pct: 25,  tp1SellPct: 80,
    tp2Pct: 50,  tp2SellPct: 20,
    runnerPct: 0,
    trailActivationPct: 18,
    trailDistancePct: 10,
    timeStopMs: 45 * 60 * 1000,  // 45 min (was 30)
    // Relaxed kill switches: thin pools have natural quiet periods
    killSwitches: { noNewBuyMins: 20, sellVolumeMultiple: 4, liqDropPct: 30 },
  },

  BURST_SCALP: {
    name: 'BURST_SCALP',
    minPoolXrpReserve: 500,
    maxSlippage: 0.04,
    maxRoundTripLossPct: 12,
    baseSizeXRP: 5,
    maxSizeXRP: 25,
    scalePoolXRP: 5000,
    // Widened stop: -12% (was -8%). Meme tokens wick -10% routinely before continuing.
    // -8% was stopping out on normal volatility, not real reversals.
    stopLossPct: 12,
    // TP1=60%, TP2=25%, 15% runner (was 70/20/10)
    tp1Pct: 15,  tp1SellPct: 60,
    tp2Pct: 30,  tp2SellPct: 25,
    runnerPct: 15,
    // Trail activation raised: 15% (was 10%) — avoid triggering on first retrace
    trailActivationPct: 15,
    trailDistancePct: 8,  // wider trail (was 5%) to survive consolidations
    timeStopMs: 60 * 60 * 1000,  // 60 min (was 45)
    // Kill switches relaxed:
    // noNewBuyMins: 20 (was 10) — meme tokens go quiet 10-20min between legs
    // sellVolumeMultiple: 4 (was 2) — AMM arb creates reflected sells; 2x fires too easily
    killSwitches: { noNewBuyMins: 20, sellVolumeMultiple: 4, liqDropPct: 30 },
  },

  MOMENTUM_RUNNER: {
    name: 'MOMENTUM_RUNNER',
    minPoolXrpReserve: 2000,
    maxSlippage: 0.03,
    maxRoundTripLossPct: 10,
    baseSizeXRP: 5,
    maxSizeXRP: 20,
    scalePoolXRP: 10000,
    // Widened stop: -12% (was -10%). Sustained movers need room to breathe.
    stopLossPct: 12,
    // TP1=40%, TP2=35%, 25% runner (was 50/30/20) — let winners run more
    tp1Pct: 12,  tp1SellPct: 40,
    tp2Pct: 25,  tp2SellPct: 35,
    runnerPct: 25,
    trailActivationPct: 15,
    trailDistancePct: 12,
    timeStopMs: 120 * 60 * 1000,  // 120 min (was 90) — momentum runners need time
    killSwitches: { noNewBuyMins: 25, sellVolumeMultiple: 4, liqDropPct: 30 },
  },

  WAKEUP_TRADE: {
    name: 'WAKEUP_TRADE',
    minPoolXrpReserve: 500,  // raised from 300 — too shallow otherwise
    maxSlippage: 0.05,
    maxRoundTripLossPct: 12,
    baseSizeXRP: 3,
    maxSizeXRP: 10,
    scalePoolXRP: 2000,
    // Widened stop: -12% (was -8%)
    stopLossPct: 12,
    tp1Pct: 20,  tp1SellPct: 40,
    tp2Pct: 40,  tp2SellPct: 40,
    runnerPct: 20,
    trailActivationPct: 18,
    trailDistancePct: 10,  // wider trail (was 7%)
    timeStopMs: 90 * 60 * 1000,  // 90 min (was 60)
    killSwitches: { noNewBuyMins: 20, sellVolumeMultiple: 4, liqDropPct: 30 },
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
