#!/usr/bin/env node
/** Offline learning governance regression; no XRPL, Telegram or production writes. */
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'hunterix-learning-'));
const state=path.join(root,'state');fs.mkdirSync(state);
const workdir=process.cwd();
process.chdir(root);
// Runtime recommendation paths resolve relative to cwd at initial import.
const { isLearningApproved,learningRecommendationDigest }=require(path.join(workdir,'dist/analysis/learningApproval'));
const { RuntimeLearning }=require(path.join(workdir,'dist/analysis/runtimeLearning'));
const { TokenScorer }=require(path.join(workdir,'dist/scoring/tokenScorer'));
const { TradeAnalyzer }=require(path.join(workdir,'dist/analysis/tradeAnalyzer'));
const now=Date.now();
const baselineWeights={buyPressureScore:30,holderGrowthScore:20,volumeAccelScore:35,
                       liquidityScore:15,devSafetyScore:0,spreadScore:0};
const approvedWeights={buyPressureScore:35,holderGrowthScore:15,volumeAccelScore:30,
                       liquidityScore:20,devSafetyScore:0,spreadScore:0};
const rec={
  generatedAt:now-180000,tradesAnalyzed:200,overallWinRate:55,
  autoApplyReady:true,burstTp1Percent:8,burstTp2Percent:35,
  scoredTp1Percent:7,scoredTp2Percent:23,
  entryPullbackPct:2,entryConfirmBars:2,
  scoreWeights:approvedWeights,worstHours:[3],tradingPauseEnabled:true,
  minScorePaperTrade:50,minLiquidityXRP:1000,
};
const validation={
  status:'approved_out_of_sample',epochId:'meme_bot.paper-epoch-20261116-ci',
  trainingEndMs:now-200000,testStartMs:now-170000,
  testEndMs:now-30000,approvedAtMs:now,
  testTrades:75,testProfitFactor:1.35,testNetXRP:5,
};
rec.validation={...validation,recommendationDigest:learningRecommendationDigest(rec)};
const write=()=>fs.writeFileSync(path.join(state,'recommendations.json'),JSON.stringify(rec));
const defaults=()=>{
  const runtime=new RuntimeLearning();
  assert.deepEqual(runtime.getTpTargets('burst'),{tp1:15,tp2:30});
  assert.equal(runtime.getPullbackThreshold(),0);
  assert.equal(runtime.getConfirmBars(),0);
  assert.equal(runtime.isGoodTradingHour(),true);
  const scorer=new TokenScorer({});
  assert.deepEqual(scorer.getWeights(),baselineWeights);
  assert.equal(new TradeAnalyzer({}).applyRecommendations(rec,path.join(root,'config.json')),false);
  return {runtime,scorer};
};
try {
  fs.writeFileSync(path.join(root,'config.json'),'{"untouched":true}');
  write();
  process.env.MODE='PAPER';
  delete process.env.BOT_ENABLE_VALIDATED_LEARNING;
  process.env.BOT_PAPER_EPOCH_ID=validation.epochId;
  assert.equal(isLearningApproved(rec),false);
  defaults();
  console.log('PASS advisory data cannot alter TP, scorer, timing or config without explicit opt-in');

  process.env.BOT_ENABLE_VALIDATED_LEARNING='1';
  rec.autoApplyReady=false;assert.equal(isLearningApproved(rec),false);
  rec.autoApplyReady=true;
  rec.validation.recommendationDigest='tampered';assert.equal(isLearningApproved(rec),false);
  rec.validation.recommendationDigest=learningRecommendationDigest(rec);
  process.env.BOT_PAPER_EPOCH_ID='different';assert.equal(isLearningApproved(rec),false);
  process.env.BOT_PAPER_EPOCH_ID=validation.epochId;
  assert.equal(isLearningApproved(rec),true);
  write();
  const rt=new RuntimeLearning();
  assert.deepEqual(rt.getTpTargets('burst'),{tp1:8,tp2:35});
  assert.equal(rt.getPullbackThreshold(),2);
  const scorer=new TokenScorer({});
  assert.deepEqual(scorer.getWeights(),approvedWeights);
  console.log('PASS independent OOS approval and parameter digest gate allow explicitly enabled PAPER adaptations');

  rec.burstTp1Percent=5;write();rt.reload();scorer.loadLearnedWeights();
  assert.deepEqual(rt.getTpTargets('burst'),{tp1:15,tp2:30});
  assert.deepEqual(scorer.getWeights(),baselineWeights);
  assert.equal(isLearningApproved(rec),false);
  console.log('PASS changed recommendations revoke previous approval and restore defaults');

  rec.burstTp1Percent=8;
  rec.validation.recommendationDigest=learningRecommendationDigest(rec);
  process.env.MODE='LIVE';assert.equal(isLearningApproved(rec),false);
  process.env.MODE='PAPER';
  rec.validation.testTrades=5;assert.equal(isLearningApproved(rec),false);
  rec.validation.testTrades=75;
  rec.validation.testEndMs=rec.validation.trainingEndMs-1000;
  assert.equal(isLearningApproved(rec),false);
  console.log('PASS LIVE and invalid out-of-sample chronology/test size are rejected');

  console.log('PAPER LEARNING GOVERNANCE TESTS PASSED');
}finally {
  process.chdir(workdir);
  delete process.env.BOT_ENABLE_VALIDATED_LEARNING;
  delete process.env.BOT_PAPER_EPOCH_ID;
  delete process.env.MODE;
  fs.rmSync(root,{recursive:true,force:true});
}
