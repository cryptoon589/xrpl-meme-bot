/**
 * TradeAnalyzer — Self-learning feedback loop
 *
 * Reads closed paper trade history from the DB and derives
 * concrete parameter recommendations. After 20+ trades it
 * produces a JSON recommendation file that the bot can apply
 * (with human approval, or autonomously once win rate is trusted).
 *
 * Runs as a cron inside the bot (every 6h).
 */

import * as fs from 'fs';
import * as path from 'path';
import { Database } from '../db/database';
import { info, warn } from '../utils/logger';

const MIN_TRADES_FOR_ANALYSIS = 20;
const RECOMMENDATIONS_PATH = path.join(process.cwd(), 'state', 'recommendations.json');
const REPORT_PATH          = path.join(process.cwd(), 'state', 'trade_analysis.md');

export interface ScoreWeights {
  liquidityScore: number;
  holderGrowthScore: number;
  buyPressureScore: number;
  volumeAccelScore: number;
  devSafetyScore: number;
  spreadScore: number;
}

export interface TradeRecommendations {
  generatedAt: number;
  tradesAnalyzed: number;
  overallWinRate: number;

  // Burst trade params
  minLiquidityXRP: number;
  burstStopLossPercent: number;
  burstTp1Percent: number;
  burstTp2Percent: number;
  burstTrailingActivation: number;
  burstTrailingDistance: number;

  // Scored trade params
  minScorePaperTrade: number;
  scoredTp1Percent: number;
  scoredTp2Percent: number;

  // Score component weights (relative importance 0-100)
  // Used to reweight the scorer so winning predictors matter more
  scoreWeights: ScoreWeights;
  // Which component threshold guarantees best win rate
  bestScoredSignalCombo: string;

  insights: string[];
  autoApplyReady: boolean;

  // #1 Entry timing: learned pullback depth before continuation
  entryPullbackPct: number;      // wait for this % dip after burst signal before entering
  entryConfirmBars: number;      // number of scan cycles to confirm momentum resuming

  // #2 Exit sizing: learned from actual run lengths
  medianRunPct: number;          // median peak gain across all closed trades
  p75RunPct: number;             // 75th percentile peak gain
  burstMedianRunPct: number;     // median for burst-only trades
  scoredMedianRunPct: number;    // median for scored-only trades

  // #3 Time-of-day: best UTC hours to trade
  bestHours: number[];           // UTC hours with >50% win rate and >=3 trades
  worstHours: number[];          // UTC hours with <30% win rate and >=3 trades
  tradingPauseEnabled: boolean;  // true if worst hours are significantly worse
}

interface ClosedTrade {
  id: number;
  token_currency: string;
  token_issuer: string;
  entry_price_xrp: number;
  entry_amount_xrp: number;
  entry_timestamp: number;
  entry_score: number;
  entry_reason: string | null;
  exit_price_xrp: number;
  exit_timestamp: number;
  exit_reason: string | null;
  pnl_xrp: number;
  pnl_percent: number;
  tp1_hit: number;
  tp2_hit: number;
  trailing_stop_active: number;
}

interface TradeWithScore extends ClosedTrade {
  liquidity_score: number | null;
  holder_growth_score: number | null;
  buy_pressure_score: number | null;
  volume_accel_score: number | null;
  dev_safety_score: number | null;
  spread_score: number | null;
}

export class TradeAnalyzer {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * Run full analysis. Returns null if not enough trades yet.
   */
  analyze(): TradeRecommendations | null {
    const trades     = this.getClosedTradesWithScores();
    const rawTrades  = trades as ClosedTrade[];

    if (rawTrades.length < MIN_TRADES_FOR_ANALYSIS) {
      info(`TradeAnalyzer: only ${rawTrades.length} closed trades (need ${MIN_TRADES_FOR_ANALYSIS}), skipping`);
      return null;
    }

    const burst  = rawTrades.filter(t => t.entry_reason?.startsWith('[BURST]'));
    const scored = trades.filter(t => !t.entry_reason?.startsWith('[BURST]'));

    info(`TradeAnalyzer: analyzing ${rawTrades.length} trades (${burst.length} burst, ${scored.length} scored)`);

    const insights: string[] = [];

    // ── Overall stats ──────────────────────────────────────────────
    const wins     = rawTrades.filter(t => t.pnl_xrp > 0);
    const losses   = rawTrades.filter(t => t.pnl_xrp <= 0);
    const winRate  = wins.length / rawTrades.length;
    const avgWin   = wins.length   > 0 ? wins.reduce((s, t) => s + t.pnl_percent, 0)   / wins.length   : 0;
    const avgLoss  = losses.length > 0 ? losses.reduce((s, t) => s + t.pnl_percent, 0) / losses.length : 0;
    const totalPnL = rawTrades.reduce((s, t) => s + t.pnl_xrp, 0);

    insights.push(`Overall: ${rawTrades.length} trades | Win rate: ${(winRate*100).toFixed(1)}% | Avg win: +${avgWin.toFixed(1)}% | Avg loss: ${avgLoss.toFixed(1)}% | Total PnL: ${totalPnL.toFixed(2)} XRP`);

    // ── Burst trade analysis ───────────────────────────────────────
    let recMinLiquidity  = 2000;
    let recStopLoss      = -8;
    let recTp1Burst      = 15;
    let recTp2Burst      = 30;
    let recTrailActivate = 10;
    let recTrailDistance = 5;

    if (burst.length >= 5) {
      // Liquidity bucket win rates
      const liqBuckets: Record<string, { wins: number; total: number; pnl: number }> = {
        '<2k':    { wins: 0, total: 0, pnl: 0 },
        '2k-5k':  { wins: 0, total: 0, pnl: 0 },
        '5k-20k': { wins: 0, total: 0, pnl: 0 },
        '>20k':   { wins: 0, total: 0, pnl: 0 },
      };
      for (const t of burst) {
        const bucket = this.getLiquidityBucket(t);
        liqBuckets[bucket].total++;
        liqBuckets[bucket].pnl += t.pnl_xrp;
        if (t.pnl_xrp > 0) liqBuckets[bucket].wins++;
      }
      let bestLiqBucket = '2k-5k';
      let bestLiqWR = 0;
      for (const [range, data] of Object.entries(liqBuckets)) {
        if (data.total === 0) continue;
        const wr = data.wins / data.total;
        insights.push(`Burst liquidity ${range}: ${(wr*100).toFixed(0)}% win rate (${data.total} trades, ${data.pnl.toFixed(2)} XRP)`);
        if (wr > bestLiqWR) { bestLiqWR = wr; bestLiqBucket = range; }
      }
      // Recommend min liquidity at start of best bucket
      const bucketFloors: Record<string, number> = { '<2k': 0, '2k-5k': 2000, '5k-20k': 5000, '>20k': 20000 };
      recMinLiquidity = bucketFloors[bestLiqBucket] || 2000;
      if (recMinLiquidity > 2000) {
        insights.push(`📈 Best win rate in ${bestLiqBucket} bucket → raising min liquidity to ${recMinLiquidity} XRP`);
      }

      // Exit reason breakdown
      const exitMap: Record<string, { count: number; pnlSum: number }> = {};
      for (const t of burst) {
        const r = t.exit_reason || 'unknown';
        if (!exitMap[r]) exitMap[r] = { count: 0, pnlSum: 0 };
        exitMap[r].count++;
        exitMap[r].pnlSum += t.pnl_percent;
      }
      for (const [reason, data] of Object.entries(exitMap)) {
        insights.push(`Burst exit [${reason}]: ${data.count}× avg ${(data.pnlSum/data.count).toFixed(1)}%`);
      }

      // Stop loss rate
      const stopHits = burst.filter(t => t.exit_reason?.includes('stop_loss') || t.pnl_percent <= -7).length;
      const stopRate = stopHits / burst.length;
      if (stopRate > 0.4) {
        recMinLiquidity = Math.max(recMinLiquidity, 5000);
        insights.push(`⚠️ ${(stopRate*100).toFixed(0)}% stop loss rate — entering too early/shallow → min liquidity → ${recMinLiquidity} XRP`);
      } else {
        insights.push(`✅ Stop loss rate ${(stopRate*100).toFixed(0)}% — acceptable`);
      }

      // TP1 hit rate
      const tp1Rate = burst.filter(t => t.tp1_hit).length / burst.length;
      if (tp1Rate < 0.25 && burst.length >= 10) {
        recTp1Burst = 10;
        insights.push(`⚠️ TP1 hit only ${(tp1Rate*100).toFixed(0)}% of the time → lowering TP1 to ${recTp1Burst}%`);
      } else if (tp1Rate > 0.6) {
        recTp1Burst = 20;
        insights.push(`✅ TP1 hit ${(tp1Rate*100).toFixed(0)}% → raising TP1 to ${recTp1Burst}% (pumps going further)`);
      }

      // Hold duration
      const holds = burst.filter(t => t.exit_timestamp).map(t => (t.exit_timestamp - t.entry_timestamp) / 60000);
      if (holds.length > 0) {
        const avgHold = holds.reduce((s, d) => s + d, 0) / holds.length;
        const winHolds = burst.filter(t => t.pnl_xrp > 0 && t.exit_timestamp)
          .map(t => (t.exit_timestamp - t.entry_timestamp) / 60000);
        const avgWinHold = winHolds.length > 0 ? winHolds.reduce((s, d) => s + d, 0) / winHolds.length : 0;
        insights.push(`Burst hold: avg ${avgHold.toFixed(1)}m | winning trades avg ${avgWinHold.toFixed(1)}m`);
        if (avgHold > 20) {
          recTrailDistance = 4;
          insights.push(`⚠️ Long avg hold (${avgHold.toFixed(1)}m) → tightening trail to ${recTrailDistance}%`);
        }
      }

      // Trailing stop performance
      const trailTotal = burst.filter(t => t.trailing_stop_active).length;
      const trailWins  = burst.filter(t => t.trailing_stop_active && t.pnl_xrp > 0).length;
      if (trailTotal > 0) {
        const trailWR = trailWins / trailTotal;
        insights.push(`Trailing stop activated ${trailTotal}×, ${(trailWR*100).toFixed(0)}% won`);
        if (trailWR < 0.4) {
          recTrailActivate = 8;
          insights.push(`⚠️ Trailing stop underperforming → activating earlier at +${recTrailActivate}%`);
        }
      }
    } else {
      insights.push(`Not enough burst trades for analysis (${burst.length}/5 needed)`);
    }

    // ── Scored trade analysis ─────────────────────────────────────
    let recMinScore   = 65;
    let recTp1Scored  = 35;
    let recTp2Scored  = 75;
    let recWeights: ScoreWeights = {
      liquidityScore:    17,
      holderGrowthScore: 17,
      buyPressureScore:  17,
      volumeAccelScore:  17,
      devSafetyScore:    17,
      spreadScore:       15,
    };
    let bestSignalCombo = 'default';

    if (scored.length >= 5) {
      // ── Score threshold optimisation ─────────────────────────────
      const thresholds = [50, 55, 60, 65, 70, 75, 80];
      let bestThrWR = 0;
      for (const thr of thresholds) {
        const above = scored.filter(t => t.entry_score >= thr);
        if (above.length < 3) continue;
        const wr = above.filter(t => t.pnl_xrp > 0).length / above.length;
        insights.push(`Scored ≥${thr}: ${above.length} trades | ${(wr*100).toFixed(0)}% win rate`);
        if (wr > bestThrWR) { bestThrWR = wr; recMinScore = thr; }
      }
      if (recMinScore !== 65) {
        insights.push(`📊 Optimal score threshold: ${recMinScore} (${(bestThrWR*100).toFixed(0)}% win rate)`);
      }

      // ── TP optimisation for scored trades ─────────────────────────
      // Check: did trades that hit TP1 (35%) continue to TP2 (75%)?
      const tp1Hits  = scored.filter(t => t.tp1_hit).length;
      const tp2Hits  = scored.filter(t => t.tp2_hit).length;
      const tp1Rate  = scored.length > 0 ? tp1Hits / scored.length : 0;
      const tp2Rate  = scored.length > 0 ? tp2Hits / scored.length : 0;
      insights.push(`Scored TP1 hit rate: ${(tp1Rate*100).toFixed(0)}% | TP2 hit rate: ${(tp2Rate*100).toFixed(0)}%`);

      if (tp1Rate < 0.2) {
        recTp1Scored = 20; // Pumps not reaching 35% — lower the target
        insights.push(`⚠️ Scored TP1 rarely hit → lowering scored TP1 to ${recTp1Scored}%`);
      }
      if (tp2Rate < 0.1 && tp1Rate > 0.3) {
        recTp2Scored = 50; // TP1 hits fine but TP2 never — lower TP2
        insights.push(`⚠️ Scored TP2 rarely hit → lowering scored TP2 to ${recTp2Scored}%`);
      }

      // ── Score component analysis ──────────────────────────────────
      if (scored.length >= 10) {
        const components: (keyof TradeWithScore)[] = [
          'liquidity_score', 'holder_growth_score', 'buy_pressure_score',
          'volume_accel_score', 'dev_safety_score', 'spread_score',
        ];

        // For each component: split trades into "high" (>=10) vs "low" (<10)
        // and compare win rates. Higher delta = component is more predictive.
        const componentDeltas: Record<string, number> = {};
        for (const comp of components) {
          const high = scored.filter(t => (t[comp] as number || 0) >= 10);
          const low  = scored.filter(t => (t[comp] as number || 0) < 10);
          if (high.length < 2 || low.length < 2) continue;
          const highWR = high.filter(t => t.pnl_xrp > 0).length / high.length;
          const lowWR  = low.filter(t  => t.pnl_xrp > 0).length / low.length;
          const delta  = highWR - lowWR;
          componentDeltas[comp] = delta;
          insights.push(`Score component [${comp}]: high→${(highWR*100).toFixed(0)}% win, low→${(lowWR*100).toFixed(0)}% win (delta: ${(delta*100).toFixed(0)}pp)`);
        }

        // Reweight: components with highest positive delta get more weight
        const totalDelta = Object.values(componentDeltas).reduce((s, d) => s + Math.max(d, 0), 0);
        if (totalDelta > 0) {
          const baseWeight = 10; // minimum weight per component
          const poolToDistribute = 100 - baseWeight * 6;

          recWeights = {
            liquidityScore:    baseWeight + Math.round(((componentDeltas['liquidity_score']    || 0) / totalDelta) * poolToDistribute),
            holderGrowthScore: baseWeight + Math.round(((componentDeltas['holder_growth_score']|| 0) / totalDelta) * poolToDistribute),
            buyPressureScore:  baseWeight + Math.round(((componentDeltas['buy_pressure_score'] || 0) / totalDelta) * poolToDistribute),
            volumeAccelScore:  baseWeight + Math.round(((componentDeltas['volume_accel_score'] || 0) / totalDelta) * poolToDistribute),
            devSafetyScore:    baseWeight + Math.round(((componentDeltas['dev_safety_score']   || 0) / totalDelta) * poolToDistribute),
            spreadScore:       baseWeight + Math.round(((componentDeltas['spread_score']       || 0) / totalDelta) * poolToDistribute),
          };

          // Find the strongest single predictor
          const best = Object.entries(componentDeltas).sort((a, b) => b[1] - a[1])[0];
          insights.push(`🏆 Strongest win predictor: ${best[0]} (${(best[1]*100).toFixed(0)}pp delta)`);
        }

        // ── Combo analysis: find best 2-component combination ─────
        // Only check if high on BOTH components → win rate
        const comboResults: { combo: string; wr: number; count: number }[] = [];
        for (let i = 0; i < components.length; i++) {
          for (let j = i + 1; j < components.length; j++) {
            const c1 = components[i];
            const c2 = components[j];
            const both = scored.filter(
              t => (t[c1] as number || 0) >= 10 && (t[c2] as number || 0) >= 10
            );
            if (both.length < 3) continue;
            const wr = both.filter(t => t.pnl_xrp > 0).length / both.length;
            comboResults.push({ combo: `${c1} + ${c2}`, wr, count: both.length });
          }
        }
        if (comboResults.length > 0) {
          comboResults.sort((a, b) => b.wr - a.wr);
          const top = comboResults[0];
          bestSignalCombo = top.combo;
          insights.push(`🔬 Best signal combo: ${top.combo} → ${(top.wr*100).toFixed(0)}% win rate (${top.count} trades)`);
          if (comboResults.length > 1) {
            const second = comboResults[1];
            insights.push(`   2nd: ${second.combo} → ${(second.wr*100).toFixed(0)}% (${second.count} trades)`);
          }
        }
      } else {
        insights.push(`Need ${10 - scored.length} more scored trades for component analysis`);
      }
    } else {
      insights.push(`Not enough scored trades for analysis (${scored.length}/5 needed)`);
    }

    // ── #1 Entry timing: pullback depth analysis ─────────────────
    // Goal: find the average dip after initial signal before the real move.
    // Proxy: look at trades where entry_score >= threshold but PnL was negative
    // in the first few minutes (would have been better to wait).
    // Since we don't store intra-trade ticks, we use a simpler heuristic:
    // winning trades that started with a stop-loss close (pnl_percent near stop)
    // suggest entries were too early. For now derive from stop-hit rate.
    let recPullbackPct = 0;    // 0 = enter immediately (current behaviour)
    let recConfirmBars = 0;    // 0 = no confirmation needed

    const burstStopRate = burst.length > 0
      ? burst.filter(t => t.exit_reason?.includes('stop_loss')).length / burst.length
      : 0;

    if (burstStopRate > 0.45 && burst.length >= 8) {
      // More than 45% stopping out = entering too early on burst
      // Recommend waiting for a 3% pullback from burst peak to confirm hold
      recPullbackPct = 3;
      recConfirmBars = 2; // wait 2 scan cycles (~2 min) for momentum to resume
      insights.push(`⏱️ Entry timing: ${(burstStopRate*100).toFixed(0)}% burst stop rate → wait for 3% pullback before entering`);
    } else if (burstStopRate > 0.3 && burst.length >= 5) {
      recPullbackPct = 2;
      recConfirmBars = 1;
      insights.push(`⏱️ Entry timing: ${(burstStopRate*100).toFixed(0)}% burst stop rate → wait for 2% pullback`);
    } else {
      insights.push(`✅ Entry timing: stop rate ${(burstStopRate*100).toFixed(0)}% — immediate entry is working`);
    }

    // ── #2 Exit sizing: actual run length analysis ─────────────────
    // Calculate the peak gain each trade reached before closing.
    // Since we don't store intra-trade highs directly, use:
    //   - tp1_hit → trade peaked at least at TP1
    //   - tp2_hit → trade peaked at least at TP2
    //   - exit pnl_percent as a floor (actual close price)
    // Best proxy: pnl_percent on winning trades shows where they actually closed.
    const winPnls = rawTrades.filter(t => t.pnl_percent > 0).map(t => t.pnl_percent).sort((a,b)=>a-b);
    const burstWinPnls = burst.filter(t => t.pnl_percent > 0).map(t => t.pnl_percent).sort((a,b)=>a-b);
    const scoredWinPnls = scored.filter(t => t.pnl_percent > 0).map(t => t.pnl_percent).sort((a,b)=>a-b);

    const median = (arr: number[]) => arr.length === 0 ? 0 :
      arr.length % 2 === 0
        ? (arr[arr.length/2 - 1] + arr[arr.length/2]) / 2
        : arr[Math.floor(arr.length/2)];
    const percentile = (arr: number[], p: number) =>
      arr.length === 0 ? 0 : arr[Math.floor(arr.length * p / 100)];

    const medianRun   = median(winPnls);
    const p75Run      = percentile(winPnls, 75);
    const burstMedian = median(burstWinPnls);
    const scoredMedian= median(scoredWinPnls);

    if (winPnls.length >= 5) {
      insights.push(`📏 Run lengths: median win +${medianRun.toFixed(1)}% | p75 +${p75Run.toFixed(1)}% | burst median +${burstMedian.toFixed(1)}% | scored median +${scoredMedian.toFixed(1)}%`);

      // If median run is below current TP1 targets, lower them to bank more wins
      if (burstMedian > 0 && burstMedian < recTp1Burst * 0.8) {
        const newTp1 = Math.max(8, Math.round(burstMedian * 0.75));
        insights.push(`⬇️ Burst TP1 → ${newTp1}% (median run only ${burstMedian.toFixed(1)}%, banking earlier)`);
        recTp1Burst = newTp1;
      }
      if (burstMedian > 0 && p75Run < recTp2Burst * 0.8) {
        const newTp2 = Math.max(recTp1Burst + 5, Math.round(p75Run * 0.85));
        insights.push(`⬇️ Burst TP2 → ${newTp2}% (p75 run only ${p75Run.toFixed(1)}%)`);
        recTp2Burst = newTp2;
      }
      if (scoredMedian > 0 && scoredMedian < recTp1Scored * 0.8) {
        const newTp1 = Math.max(10, Math.round(scoredMedian * 0.75));
        insights.push(`⬇️ Scored TP1 → ${newTp1}% (median run ${scoredMedian.toFixed(1)}%)`);
        recTp1Scored = newTp1;
      }
    } else {
      insights.push(`📏 Not enough wins yet for run-length analysis (${winPnls.length}/5)`);
    }

    // ── #3 Time-of-day win rate analysis ──────────────────────────
    const hourBuckets: Record<number, { wins: number; total: number; pnl: number }> = {};
    for (let h = 0; h < 24; h++) hourBuckets[h] = { wins: 0, total: 0, pnl: 0 };

    for (const t of rawTrades) {
      if (!t.entry_timestamp) continue;
      const hour = new Date(t.entry_timestamp).getUTCHours();
      hourBuckets[hour].total++;
      hourBuckets[hour].pnl += t.pnl_xrp;
      if (t.pnl_xrp > 0) hourBuckets[hour].wins++;
    }

    const bestHours: number[] = [];
    const worstHours: number[] = [];

    for (let h = 0; h < 24; h++) {
      const b = hourBuckets[h];
      if (b.total < 3) continue; // not enough data
      const wr = b.wins / b.total;
      if (wr >= 0.55) bestHours.push(h);
      if (wr <= 0.25) worstHours.push(h);
    }

    if (bestHours.length > 0) {
      insights.push(`🕐 Best trading hours (UTC): ${bestHours.map(h=>`${h}:00`).join(', ')}`);
    }
    if (worstHours.length > 0) {
      insights.push(`🚫 Worst trading hours (UTC): ${worstHours.map(h=>`${h}:00`).join(', ')} — consider pausing`);
    }

    // Enable pause only if worst hours are materially worse than best
    // and we have enough data to be confident
    const tradingPauseEnabled = worstHours.length >= 2 && rawTrades.length >= 40;
    if (tradingPauseEnabled) {
      insights.push(`⏸️ Trading pause enabled for worst hours — bot will skip entries during ${worstHours.map(h=>`${h}:00`).join(', ')} UTC`);
    }

    // ── Auto-apply readiness ──────────────────────────────────────
    const autoApplyReady = winRate >= 0.5 && rawTrades.length >= 30;
    if (autoApplyReady) {
      insights.push(`✅ ${(winRate*100).toFixed(0)}% win rate with ${rawTrades.length} trades — auto-apply active`);
    } else {
      const need = Math.max(0, 30 - rawTrades.length);
      insights.push(`⏳ Need ${need} more trades + 50%+ win rate for auto-apply`);
    }

    const recs: TradeRecommendations = {
      generatedAt: Date.now(),
      tradesAnalyzed: rawTrades.length,
      overallWinRate: parseFloat((winRate * 100).toFixed(1)),
      minLiquidityXRP: recMinLiquidity,
      burstStopLossPercent: recStopLoss,
      burstTp1Percent: recTp1Burst,
      burstTp2Percent: recTp2Burst,
      burstTrailingActivation: recTrailActivate,
      burstTrailingDistance: recTrailDistance,
      minScorePaperTrade: recMinScore,
      scoredTp1Percent: recTp1Scored,
      scoredTp2Percent: recTp2Scored,
      scoreWeights: recWeights,
      bestScoredSignalCombo: bestSignalCombo,
      // #1 Entry timing
      entryPullbackPct: recPullbackPct,
      entryConfirmBars: recConfirmBars,
      // #2 Exit sizing
      medianRunPct: parseFloat(median(winPnls).toFixed(1)),
      p75RunPct: parseFloat(percentile(winPnls, 75).toFixed(1)),
      burstMedianRunPct: parseFloat(burstMedian.toFixed(1)),
      scoredMedianRunPct: parseFloat(scoredMedian.toFixed(1)),
      // #3 Time-of-day
      bestHours,
      worstHours,
      tradingPauseEnabled,
      insights,
      autoApplyReady,
    };

    try {
      fs.mkdirSync(path.dirname(RECOMMENDATIONS_PATH), { recursive: true });
      fs.writeFileSync(RECOMMENDATIONS_PATH, JSON.stringify(recs, null, 2));
      this.writeMarkdownReport(recs);
      info(`TradeAnalyzer: report written → ${REPORT_PATH}`);
    } catch (err) {
      warn(`TradeAnalyzer: failed to write report: ${err}`);
    }

    return recs;
  }

  /**
   * Apply recommendations to live config.
   * Called automatically when autoApplyReady, or on operator command.
   */
  applyRecommendations(recs: TradeRecommendations, configPath: string): boolean {
    try {
      const raw = fs.readFileSync(configPath, 'utf8');
      const config = JSON.parse(raw);

      config.minLiquidityXRP    = recs.minLiquidityXRP;
      config.minScorePaperTrade = recs.minScorePaperTrade;
      // #1 entry timing
      config.entryPullbackPct   = recs.entryPullbackPct;
      config.entryConfirmBars   = recs.entryConfirmBars;
      // #3 time-of-day
      config.worstTradingHours  = recs.worstHours;
      config.tradingPauseEnabled = recs.tradingPauseEnabled;

      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

      info(`TradeAnalyzer: applied → minLiquidity=${recs.minLiquidityXRP}, minScore=${recs.minScorePaperTrade}`);
      info(`  Entry: pullback=${recs.entryPullbackPct}%, confirmBars=${recs.entryConfirmBars}`);
      info(`  Burst: stopLoss=${recs.burstStopLossPercent}%, TP1=${recs.burstTp1Percent}%, TP2=${recs.burstTp2Percent}%`);
      info(`  Scored: TP1=${recs.scoredTp1Percent}%, TP2=${recs.scoredTp2Percent}%`);
      info(`  Run lengths: median=${recs.medianRunPct}%, p75=${recs.p75RunPct}%`);
      info(`  Trading pause: ${recs.tradingPauseEnabled} | worst hours: ${recs.worstHours.join(',')}`);
      return true;
    } catch (err) {
      warn(`TradeAnalyzer: apply failed: ${err}`);
      return false;
    }
  }

  // ── Private helpers ────────────────────────────────────────────

  private getClosedTradesWithScores(): TradeWithScore[] {
    try {
      const db = (this.db as any).db;
      // Join closed trades with their score at entry time (closest score within 5 min of entry)
      return db.prepare(`
        SELECT
          pt.*,
          s.liquidity_score,
          s.holder_growth_score,
          s.buy_pressure_score,
          s.volume_accel_score,
          s.dev_safety_score,
          s.spread_score
        FROM paper_trades pt
        LEFT JOIN scores s ON
          s.token_currency = pt.token_currency
          AND s.token_issuer = pt.token_issuer
          AND s.timestamp BETWEEN pt.entry_timestamp - 300000 AND pt.entry_timestamp + 300000
        WHERE pt.status = 'closed'
          AND pt.pnl_xrp IS NOT NULL
        GROUP BY pt.id
        ORDER BY pt.exit_timestamp DESC
      `).all() as TradeWithScore[];
    } catch (err) {
      warn(`TradeAnalyzer: DB query failed: ${err}`);
      return [];
    }
  }

  private getLiquidityBucket(trade: ClosedTrade): string {
    const match = trade.entry_reason?.match(/pool:\s*([\d.]+)\s*XRP/i);
    if (match) {
      const liq = parseFloat(match[1]);
      if (liq < 2000)  return '<2k';
      if (liq < 5000)  return '2k-5k';
      if (liq < 20000) return '5k-20k';
      return '>20k';
    }
    return '2k-5k';
  }

  private writeMarkdownReport(recs: TradeRecommendations): void {
    const date = new Date(recs.generatedAt).toISOString().slice(0, 10);
    const w = recs.scoreWeights;
    const lines = [
      `# Trade Analysis Report — ${date}`,
      ``,
      `**Trades analyzed:** ${recs.tradesAnalyzed} | **Win rate:** ${recs.overallWinRate}% | **Auto-apply:** ${recs.autoApplyReady ? '✅ Active' : '⏳ Pending'}`,
      ``,
      `## Insights`,
      ...recs.insights.map(i => `- ${i}`),
      ``,
      `## #1 Entry Timing`,
      `| Parameter | Value |`,
      `|---|---|`,
      `| Pullback wait | ${recs.entryPullbackPct === 0 ? 'None (enter immediately)' : `-${recs.entryPullbackPct}% from burst peak`} |`,
      `| Confirm bars | ${recs.entryConfirmBars === 0 ? 'None' : `${recs.entryConfirmBars} scan cycles`} |`,
      ``,
      `## #2 Exit Sizing (learned run lengths)`,
      `| Metric | Value |`,
      `|---|---|`,
      `| Median winning run | +${recs.medianRunPct}% |`,
      `| 75th pct run | +${recs.p75RunPct}% |`,
      `| Burst median run | +${recs.burstMedianRunPct}% |`,
      `| Scored median run | +${recs.scoredMedianRunPct}% |`,
      ``,
      `## #3 Time-of-Day`,
      `| | Hours (UTC) |`,
      `|---|---|`,
      `| Best hours | ${recs.bestHours.length > 0 ? recs.bestHours.map(h=>`${h}:00`).join(', ') : 'Insufficient data'} |`,
      `| Worst hours | ${recs.worstHours.length > 0 ? recs.worstHours.map(h=>`${h}:00`).join(', ') : 'None identified'} |`,
      `| Pause enabled | ${recs.tradingPauseEnabled ? '✅ Yes' : '❌ No (need 40+ trades)'} |`,
      ``,
      `## Recommended Burst Parameters`,
      `| Parameter | Value |`,
      `|---|---|`,
      `| Min pool liquidity | ${recs.minLiquidityXRP} XRP |`,
      `| Stop loss | ${recs.burstStopLossPercent}% |`,
      `| TP1 | +${recs.burstTp1Percent}% |`,
      `| TP2 | +${recs.burstTp2Percent}% |`,
      `| Trail activation | +${recs.burstTrailingActivation}% |`,
      `| Trail distance | ${recs.burstTrailingDistance}% |`,
      ``,
      `## Recommended Scored Trade Parameters`,
      `| Parameter | Value |`,
      `|---|---|`,
      `| Min score | ${recs.minScorePaperTrade} |`,
      `| TP1 | +${recs.scoredTp1Percent}% |`,
      `| TP2 | +${recs.scoredTp2Percent}% |`,
      `| Best signal combo | ${recs.bestScoredSignalCombo} |`,
      ``,
      `## Score Component Weights (learned)`,
      `| Component | Weight |`,
      `|---|---|`,
      `| Liquidity | ${w.liquidityScore} |`,
      `| Holder growth | ${w.holderGrowthScore} |`,
      `| Buy pressure | ${w.buyPressureScore} |`,
      `| Volume accel | ${w.volumeAccelScore} |`,
      `| Dev safety | ${w.devSafetyScore} |`,
      `| Spread | ${w.spreadScore} |`,
      ``,
      `## Apply`,
      `Tell the bot: \`apply trade recommendations\` to activate these params.`,
    ];
    fs.writeFileSync(REPORT_PATH, lines.join('\n'));
  }
}
