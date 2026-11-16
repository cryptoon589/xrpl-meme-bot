/**
 * Single, fail-closed gate for PAPER adaptive settings.
 *
 * Historical PAPER win rate alone is not evidence of out-of-sample edge.
 * Recommendations are advisory unless an explicit operator opt-in and an
 * independently reviewed, epoch-specific OOS evaluation are both recorded.
 *
 * Not a trading certification or guarantee of profitability.
 */
import { createHash } from 'crypto';
import type { TradeRecommendations } from './tradeAnalyzer';

export interface LearningValidation {
  status: 'approved_out_of_sample' | 'pending';
  epochId: string;
  trainingEndMs: number;
  testStartMs: number;
  testEndMs: number;
  testTrades: number;
  testProfitFactor: number;
  testNetXRP: number;
  recommendationDigest: string;
  approvedAtMs: number;
}

export function learningRecommendationDigest(recs: TradeRecommendations): string {
  const parameters = {
    burstTp1Percent: recs.burstTp1Percent,
    burstTp2Percent: recs.burstTp2Percent,
    scoredTp1Percent: recs.scoredTp1Percent,
    scoredTp2Percent: recs.scoredTp2Percent,
    entryPullbackPct: recs.entryPullbackPct,
    entryConfirmBars: recs.entryConfirmBars,
    tradingPauseEnabled: recs.tradingPauseEnabled,
    worstHours: recs.worstHours,
    minScorePaperTrade: recs.minScorePaperTrade,
    minLiquidityXRP: recs.minLiquidityXRP,
    scoreWeights: recs.scoreWeights,
  };
  return createHash('sha256').update(JSON.stringify(parameters)).digest('hex');
}

export function isLearningApproved(recs: TradeRecommendations | null | undefined): boolean {
  if (!recs || process.env.MODE !== 'PAPER' ||
      process.env.BOT_ENABLE_VALIDATED_LEARNING !== '1') return false;
  const epoch = process.env.BOT_PAPER_EPOCH_ID;
  const v = recs.validation;
  if (!epoch || !v || v.epochId !== epoch ||
      v.status !== 'approved_out_of_sample' || recs.autoApplyReady !== true) return false;
  if (recs.tradesAnalyzed < 100 ||
      v.testTrades < 60 || v.testNetXRP <= 0 || v.testProfitFactor < 1.2) return false;
  const ts = [recs.generatedAt, v.trainingEndMs, v.testStartMs, v.testEndMs, v.approvedAtMs];
  if (!ts.every(x => Number.isFinite(x) && x > 0)) return false;
  if (!(v.trainingEndMs < v.testStartMs && v.testStartMs < v.testEndMs &&
        v.testEndMs <= v.approvedAtMs && v.approvedAtMs >= recs.generatedAt &&
        v.approvedAtMs <= Date.now() + 60000 &&
        Date.now() - v.approvedAtMs < 7 * 24 * 3600000)) return false;
  return v.recommendationDigest === learningRecommendationDigest(recs);
}
