#!/usr/bin/env node
/** Offline Strategy V2 regression. Synthetic PAPER only; no provider, Telegram,
 * wallet, LIVE, or real VPS database. Tests intended shadow-only branch AND
 * direct PaperTrader bypass guards, plus exact-issue deduped evidence storage. */
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {Database}=require('../dist/db/database');
const {PaperTrader}=require('../dist/paper/paperTrader');
const {TradeDecisionEngine}=require('../dist/execution/tradeDecisionEngine');
const {paperStreamShadowOnly,PAPER_STREAM_SHADOW_REASON}=
  require('../dist/risk/paperStreamShadowOnly');
const {setActiveMemeCategoryFeed}=require('../dist/market/memeCategoryFeed');

const oldCwd=process.cwd(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'hunterix-v2-stream-'));
const oldEnv={};
for(const name of ['BOT_PAPER_STREAM_SHADOW_ONLY','BOT_PAPER_MEME_DISCOVERY',
  'BOT_PAPER_MEME_ONLY','BOT_USE_RESERVE_QUOTES'])oldEnv[name]=process.env[name];
let db=null;
async function main(){
  process.chdir(dir);
  fs.mkdirSync('state');
  process.env.BOT_PAPER_MEME_DISCOVERY='1';
  process.env.BOT_PAPER_MEME_ONLY='0';
  process.env.BOT_USE_RESERVE_QUOTES='0';
  delete process.env.BOT_PAPER_STREAM_SHADOW_ONLY;
  setActiveMemeCategoryFeed(null);

  const cfg={mode:'PAPER',startingBankrollXRP:100,minTradeXRP:5,
    maxTradeXRP:25,maxOpenTrades:5,maxDailyLossXRP:50};
  db=new Database(path.join(dir,'shadow-test.db'));
  const trader=new PaperTrader(cfg,db);
  const tde=new TradeDecisionEngine(cfg);
  const issuer='rGenericSyntheticIssuerForOfflineTests';
  const raw='544553544D454D45000000000000000000000000';
  const token={currency:'TESTMEME',rawCurrency:raw,issuer,firstSeen:Date.now(),lastUpdated:Date.now()};
  const snap={
    tokenCurrency:'TESTMEME',tokenIssuer:issuer,priceXRP:1,
    liquidityXRP:10000,poolXrpReserve:5000,timestamp:Date.now(),
    buyCount5m:6,sellCount5m:2,uniqueBuyers5m:5,uniqueSellers5m:2,
    buyVolume5m:180,sellVolume5m:20,priceChange5m:6,
    priceChange15m:4,priceChange1h:8,holderEstimate:50,spreadPercent:0.3,
  };
  const input={currency:token.currency,issuer,rawCurrency:raw,snapshot:snap,
    signalType:'stream',signalScore:75,bankrollXRP:100,openPositions:0,
    dailyPnL:0,openPositionKeys:new Set(),blocklist:new Set()};
  assert.equal(paperStreamShadowOnly('PAPER','stream'),true,
    'dynamic PAPER should default to shadow even if prior PM2 lacks flag');
  assert.equal(paperStreamShadowOnly('PAPER','whale_stream'),true);
  assert.equal(paperStreamShadowOnly('PAPER','burst'),false);
  assert.equal(paperStreamShadowOnly('PAPER','scored'),false);
  assert.equal(paperStreamShadowOnly('LIVE','stream'),false);

  for(const signalType of ['stream','whale_stream']){
    const result=await tde.decide({...input,signalType});
    assert.equal(result.outcome,'REJECTED');
    assert.equal(result.rejectReason,PAPER_STREAM_SHADOW_REASON);
    assert(result.sizeXRP>=5 && result.roundTripLossPct>0,
      'shadow signals must pass economics before being classified eligible');
  }
  for(const signalType of ['burst','scored']){
    const result=await tde.decide({...input,signalType});
    assert.equal(result.outcome,'APPROVED_PAPER',
      signalType+' eligible comparison group unchanged');
  }
  const cashBefore=db.getPaperCashState();
  assert.equal(trader.tryOpenTrade(token,snap,75,'[STREAM] 5 buyers 75% buys 180 XRP'),null,
    'direct stream trade must fail closed even without TDE');
  assert.equal(trader.tryOpenBurstTrade(token,snap,'[STREAM] bypass attempt',undefined,5),null,
    'direct burst-labelled stream bypass must also be blocked');
  assert.equal(db.getPaperCashState(),cashBefore,
    'shadow observation must not debit PAPER cash');
  assert.equal(db.getOpenTrades().length,0);

  const observedAt=Math.floor(Date.now()/900000)*900000+60000;
  const evidence={
    currency:'TESTMEME',issuer,rawCurrency:raw,
    observedAt,priceXRP:1,priceObservedAt:observedAt-1000,
    poolXrpReserve:5000,uniqueBuyers:5,buyCount5m:6,sellCount5m:2,
    buySellRatio:0.75,buyVolumeXRP:180,newWalletBuys:2,
    signalType:'stream',assignedProfile:'BURST_SCALP',
    approvedSizeXRP:5,roundTripLossPct:0.8
  };
  assert.equal(db.recordPaperStreamShadowSignal(evidence),true);
  assert.equal(db.recordPaperStreamShadowSignal({...evidence,observedAt:observedAt+500}),false,
    'same exact issue in same 15m bucket must not inflate sample size');
  assert.equal(db.recordPaperStreamShadowSignal({...evidence,issuer:'rOtherSyntheticIssuer'}),true,
    'same ticker from DIFFERENT issuer must be separately attributed');
  assert.equal(db.recordPaperStreamShadowSignal({...evidence,
    observedAt:observedAt+900000,priceObservedAt:null}),true,
    'new 15m bucket is a new observation');
  assert.equal(db.db.prepare('SELECT COUNT(*) n FROM paper_stream_shadow_signals').get().n,3);
  assert.equal(db.db.prepare('SELECT COUNT(*) n FROM paper_trades').get().n,0,
    'shadow observations are not PAPER trades');
  assert.equal(db.getPaperCashState(),cashBefore);
  assert.throws(()=>db.recordPaperStreamShadowSignal({...evidence,
    priceXRP:0}),/Invalid eligible/);

  process.env.BOT_PAPER_STREAM_SHADOW_ONLY='0';
  assert.equal(paperStreamShadowOnly('PAPER','stream'),false,
    'explicit opt-out works only for future deliberately approved releases');
  const allowed=await tde.decide(input);
  assert.equal(allowed.outcome,'APPROVED_PAPER');
  process.env.BOT_PAPER_STREAM_SHADOW_ONLY='1';
  assert.equal(paperStreamShadowOnly('LIVE','whale_stream'),false);
  console.log('PASS Strategy V2: dynamic PAPER STREAM+whale_stream only shadow; BURST/scored preserved; direct bypass prevented; deduped issuer evidence; no PAPER cash/position mutations');
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{
  setActiveMemeCategoryFeed(null);
  if(db)db.close();
  process.chdir(oldCwd);
  for(const [k,v] of Object.entries(oldEnv)){
    if(v===undefined)delete process.env[k];else process.env[k]=v;
  }
  fs.rmSync(dir,{recursive:true,force:true});
});