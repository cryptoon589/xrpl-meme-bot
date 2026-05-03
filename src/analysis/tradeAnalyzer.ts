/**
 * TradeAnalyzer — Self-learning feedback loop
 *
 * Reads closed paper trade history from the DB and derives
 * concrete parameter recommendations. After 20+ trades it
 * produces a JSON recommendation file that the bot can apply
 * (with human approval, or autonomously once win rate is trusted).
 *
 * Runs as a cron inside the bot (weekly, or on-demand).
 */

import * as fs from 'fs';
import * as path from 'path';
import { Database } from '../db/database';
import { info, warn, debug } from '../utils/logger';

const MIN_TRADES_FOR_ANALYSIS = 20;
const RECOMMENDATIONS_PATH = path.join(process.cwd(), 'state', 'recommendations.json');
const REPORT_PATH          = path.join(process.cwd(), 'state', 'trade_analysis.md');

export interface TradeRecommendations {
  generatedAt: number;
  tradesAnalyzed: number;
  overallWinRate: number;

  // Tunable parameters with recommended values
  minLiquidityXRP: number;         // current default: 2000
  burstStopLossPercent: number;    // current default: -8
  burstTp1Percent: number;         // current default: +15
  burstTp2Percent: number;         // current default: +30
  burstTrailingActivation: number; // current default: +10
  burstTrailingDistance: number;   // current default: 5%
  minScorePaperTrade: number;      // current default: from config

  // Insights (human-readable, not applied automatically)
  insights: string[];
  autoApplyReady: boolean; // true only if winRate >= 50% with 30+ trades
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

export class TradeAnalyzer {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * Run full analysis. Returns null if not enough trades yet.
   */
  analyze(): TradeRecommendations | null {
    const trades = this.getClosedTrades();

    if (trades.length < MIN_TRADES_FOR_ANALYSIS) {
      info(`TradeAnalyzer: only ${trades.length} closed trades (need ${MIN_TRADES_FOR_ANALYSIS}), skipping`);
      return null;
    }

    const burst  = trades.filter(t => t.entry_reason?.startsWith('[BURST]'));
    const scored = trades.filter(t => !t.entry_reason?.startsWith('[BURST]'));

    info(`TradeAnalyzer: analyzing ${trades.length} trades (${burst.length} burst, ${scored.length} scored)`);

    const insights: string[] = [];

    // ── Overall stats ──────────────────────────────────────────────
    const wins      = trades.filter(t => t.pnl_xrp > 0);
    const losses    = trades.filter(t => t.pnl_xrp <= 0);
    const winRate   = wins.length / trades.length;
    const avgWin    = wins.length    > 0 ? wins.reduce((s, t) => s + t.pnl_percent, 0)   / wins.length    : 0;
    const avgLoss   = losses.length  > 0 ? losses.reduce((s, t) => s + t.pnl_percent, 0) / losses.length  : 0;
    const totalPnL  = trades.reduce((s, t) => s + t.pnl_xrp, 0);

    insights.push(`Overall: ${trades.length} trades | Win rate: ${(winRate*100).toFixed(1)}% | Avg win: +${avgWin.toFixed(1)}% | Avg loss: ${avgLoss.toFixed(1)}% | Total PnL: ${totalPnL.toFixed(2)} XRP`);

    // ── Burst trade analysis ───────────────────────────────────────
    let recMinLiquidity   = 2000;
    let recStopLoss       = -8;
    let recTp1            = 15;
    let recTp2            = 30;
    let recTrailActivate  = 10;
    let recTrailDistance  = 5;

    if (burst.length >= 5) {
      // Bucket by liquidity range and find win rates
      const liqBuckets: Record<string, { wins: number; total: number; pnl: number }> = {
        '<2k':   { wins: 0, total: 0, pnl: 0 },
        '2k-5k': { wins: 0, total: 0, pnl: 0 },
        '5k-20k':{ wins: 0, total: 0, pnl: 0 },
        '>20k':  { wins: 0, total: 0, pnl: 0 },
      };

      for (const t of burst) {
        // Liquidity not stored on trade — approximate from entry amount * 10
        // TODO: join with market_snapshots for real liquidity data
        const bucket = this.getLiquidityBucket(t);
        if (liqBuckets[bucket]) {
          liqBuckets[bucket].total++;
          liqBuckets[bucket].pnl += t.pnl_xrp;
          if (t.pnl_xrp > 0) liqBuckets[bucket].wins++;
        }
      }

      for (const [range, data] of Object.entries(liqBuckets)) {
        if (data.total > 0) {
          const wr = (data.wins / data.total * 100).toFixed(0);
          insights.push(`Burst liquidity ${range}: ${wr}% win rate (${data.total} trades, ${data.pnl.toFixed(2)} XRP PnL)`);
        }
      }

      // Exit reason analysis
      const exitReasons: Record<string, { count: number; avgPnl: number; pnlSum: number }> = {};
      for (const t of burst) {
        const reason = t.exit_reason || 'unknown';
        if (!exitReasons[reason]) exitReasons[reason] = { count: 0, avgPnl: 0, pnlSum: 0 };
        exitReasons[reason].count++;
        exitReasons[reason].pnlSum += t.pnl_percent;
      }
      for (const [reason, data] of Object.entries(exitReasons)) {
        data.avgPnl = data.pnlSum / data.count;
        insights.push(`Burst exit [${reason}]: ${data.count}× avg PnL ${data.avgPnl.toFixed(1)}%`);
      }

      // Stop loss frequency — if >40% of trades hit stop loss → pump is dumping before our exit
      const stopLossHits = burst.filter(t => t.exit_reason?.includes('stop_loss') || t.pnl_percent <= -7).length;
      const stopLossRate = stopLossHits / burst.length;
      if (stopLossRate > 0.4) {
        // Too many stop losses — we're entering too late or pool too shallow
        recMinLiquidity = 5000;
        insights.push(`⚠️ ${(stopLossRate*100).toFixed(0)}% of burst trades hit stop loss → recommend raising min liquidity to ${recMinLiquidity} XRP`);
      } else if (stopLossRate < 0.2) {
        insights.push(`✅ Stop loss rate healthy at ${(stopLossRate*100).toFixed(0)}% — current -8% stop seems right`);
      }

      // TP1 analysis — if TP1 rarely hits, pumps aren't reaching +15%
      const tp1Rate = burst.filter(t => t.tp1_hit).length / burst.length;
      if (tp1Rate < 0.25 && burst.length >= 10) {
        recTp1 = 10; // Lower TP1 to capture more partial closes
        insights.push(`⚠️ TP1 only hit ${(tp1Rate*100).toFixed(0)}% of the time → lowering TP1 to ${recTp1}% to capture more gains`);
      } else if (tp1Rate > 0.6) {
        insights.push(`✅ TP1 hit rate ${(tp1Rate*100).toFixed(0)}% — pumps regularly reaching +15%, consider raising TP1 to 20%`);
        recTp1 = 20;
      }

      // Hold duration analysis
      const holdDurations = burst
        .filter(t => t.exit_timestamp && t.entry_timestamp)
        .map(t => (t.exit_timestamp - t.entry_timestamp) / 60000); // minutes
      if (holdDurations.length > 0) {
        const avgHold = holdDurations.reduce((s, d) => s + d, 0) / holdDurations.length;
        const winHolds = burst.filter(t => t.pnl_xrp > 0 && t.exit_timestamp)
          .map(t => (t.exit_timestamp - t.entry_timestamp) / 60000);
        const avgWinHold = winHolds.length > 0 ? winHolds.reduce((s, d) => s + d, 0) / winHolds.length : 0;
        insights.push(`Burst avg hold: ${avgHold.toFixed(1)}m | Winning trades avg hold: ${avgWinHold.toFixed(1)}m`);

        if (avgHold > 20) {
          insights.push(`⚠️ Avg hold ${avgHold.toFixed(1)}m is long — trailing stop may need tightening`);
          recTrailDistance = 4; // Tighter trail
        }
      }

      // Trailing stop analysis
      const trailingWins = burst.filter(t => t.trailing_stop_active && t.pnl_xrp > 0).length;
      const trailingTotal = burst.filter(t => t.trailing_stop_active).length;
      if (trailingTotal > 0) {
        const trailWinRate = trailingWins / trailingTotal;
        insights.push(`Trailing stop activated: ${trailingTotal} trades, ${(trailWinRate*100).toFixed(0)}% won`);
        if (trailWinRate < 0.4) {
          recTrailActivate = 8; // Activate earlier
          insights.push(`⚠️ Trailing stop win rate low → activating earlier at +${recTrailActivate}%`);
        }
      }
    } else {
      insights.push(`Not enough burst trades for burst-specific analysis (have ${burst.length}, need 5)`);
    }

    // ── Scored trade analysis ─────────────────────────────────────
    let recMinScore = 65;
    if (scored.length >= 5) {
      // Find optimal score threshold
      const scoreThresholds = [50, 55, 60, 65, 70, 75, 80];
      let bestThreshold = 65;
      let bestThresholdWinRate = 0;

      for (const threshold of scoreThresholds) {
        const above = scored.filter(t => t.entry_score >= threshold);
        if (above.length < 3) continue;
        const wr = above.filter(t => t.pnl_xrp > 0).length / above.length;
        insights.push(`Score ≥${threshold}: ${above.length} trades, ${(wr*100).toFixed(0)}% win rate`);
        if (wr > bestThresholdWinRate) {
          bestThresholdWinRate = wr;
          bestThreshold = threshold;
        }
      }
      recMinScore = bestThreshold;
      if (bestThreshold !== 65) {
        insights.push(`📊 Optimal score threshold: ${bestThreshold} (${(bestThresholdWinRate*100).toFixed(0)}% win rate)`);
      }
    }

    // ── Build recommendation object ────────────────────────────────
    const autoApplyReady = winRate >= 0.5 && trades.length >= 30;
    if (autoApplyReady) {
      insights.push(`✅ Win rate ${(winRate*100).toFixed(0)}% with ${trades.length} trades — recommendations ready for auto-apply`);
    } else {
      insights.push(`⏳ Need 30+ trades and 50%+ win rate for auto-apply (currently ${trades.length} trades, ${(winRate*100).toFixed(0)}% win rate)`);
    }

    const recs: TradeRecommendations = {
      generatedAt: Date.now(),
      tradesAnalyzed: trades.length,
      overallWinRate: parseFloat((winRate * 100).toFixed(1)),
      minLiquidityXRP: recMinLiquidity,
      burstStopLossPercent: recStopLoss,
      burstTp1Percent: recTp1,
      burstTp2Percent: recTp2,
      burstTrailingActivation: recTrailActivate,
      burstTrailingDistance: recTrailDistance,
      minScorePaperTrade: recMinScore,
      insights,
      autoApplyReady,
    };

    // Write files
    try {
      fs.mkdirSync(path.dirname(RECOMMENDATIONS_PATH), { recursive: true });
      fs.writeFileSync(RECOMMENDATIONS_PATH, JSON.stringify(recs, null, 2));
      this.writeMarkdownReport(recs);
      info(`TradeAnalyzer: report written to ${REPORT_PATH}`);
    } catch (err) {
      warn(`TradeAnalyzer: failed to write report: ${err}`);
    }

    return recs;
  }

  /**
   * Apply recommendations to the live config file.
   * Only called when autoApplyReady = true OR operator explicitly approves.
   */
  applyRecommendations(recs: TradeRecommendations, configPath: string): boolean {
    try {
      const raw = fs.readFileSync(configPath, 'utf8');
      let config = JSON.parse(raw);

      config.minLiquidityXRP    = recs.minLiquidityXRP;
      config.minScorePaperTrade = recs.minScorePaperTrade;
      // Burst params are in paperTrader hardcoded for now — log for manual apply
      info(`TradeAnalyzer: applying recommendations to ${configPath}`);
      info(`  minLiquidityXRP: ${recs.minLiquidityXRP}`);
      info(`  minScorePaperTrade: ${recs.minScorePaperTrade}`);
      info(`  Burst params (manual): stopLoss=${recs.burstStopLossPercent}%, TP1=${recs.burstTp1Percent}%, TP2=${recs.burstTp2Percent}%, trailActivate=${recs.burstTrailingActivation}%, trailDist=${recs.burstTrailingDistance}%`);

      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      return true;
    } catch (err) {
      warn(`TradeAnalyzer: failed to apply recommendations: ${err}`);
      return false;
    }
  }

  private getClosedTrades(): ClosedTrade[] {
    try {
      const db = (this.db as any).db;
      return db.prepare(`
        SELECT * FROM paper_trades
        WHERE status = 'closed'
          AND pnl_xrp IS NOT NULL
        ORDER BY exit_timestamp DESC
      `).all() as ClosedTrade[];
    } catch (err) {
      warn(`TradeAnalyzer: DB query failed: ${err}`);
      return [];
    }
  }

  private getLiquidityBucket(trade: ClosedTrade): string {
    // We don't have liquidity stored on the trade itself yet
    // Use entry_reason which may contain pool XRP info e.g. "Buy burst — pool: 3500 XRP"
    const match = trade.entry_reason?.match(/pool:\s*([\d.]+)\s*XRP/i);
    if (match) {
      const liq = parseFloat(match[1]);
      if (liq < 2000)  return '<2k';
      if (liq < 5000)  return '2k-5k';
      if (liq < 20000) return '5k-20k';
      return '>20k';
    }
    return '2k-5k'; // default bucket
  }

  private writeMarkdownReport(recs: TradeRecommendations): void {
    const date = new Date(recs.generatedAt).toISOString().slice(0, 10);
    const lines = [
      `# Trade Analysis Report — ${date}`,
      ``,
      `**Trades analyzed:** ${recs.tradesAnalyzed}  `,
      `**Overall win rate:** ${recs.overallWinRate}%  `,
      `**Auto-apply ready:** ${recs.autoApplyReady ? '✅ Yes' : '⏳ No'}`,
      ``,
      `## Insights`,
      ...recs.insights.map(i => `- ${i}`),
      ``,
      `## Recommended Parameters`,
      `| Parameter | Value |`,
      `|---|---|`,
      `| Min pool liquidity | ${recs.minLiquidityXRP} XRP |`,
      `| Burst stop loss | ${recs.burstStopLossPercent}% |`,
      `| Burst TP1 | +${recs.burstTp1Percent}% |`,
      `| Burst TP2 | +${recs.burstTp2Percent}% |`,
      `| Trailing stop activation | +${recs.burstTrailingActivation}% |`,
      `| Trailing stop distance | ${recs.burstTrailingDistance}% |`,
      `| Min score for scored trades | ${recs.minScorePaperTrade} |`,
      ``,
      `## How to apply`,
      `Tell the bot: \`apply trade recommendations\``,
      `It will patch the config and restart. No code change needed.`,
    ];
    fs.writeFileSync(REPORT_PATH, lines.join('\n'));
  }
}
