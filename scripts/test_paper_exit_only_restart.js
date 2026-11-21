#!/usr/bin/env node
/**
 * Real PAPER classes + disposable SQLite; zero network, zero LIVE trading.
 * Proves freeze rejects new positions BUT still permits TP partial exits,
 * and high-water/profile checkpoints survive new PaperTrader construction.
 */
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const { Database }=require('../dist/db/database');
const { PaperTrader }=require('../dist/paper/paperTrader');
const { TradeDecisionEngine }=require('../dist/execution/tradeDecisionEngine');
const { readPaperEntryFreeze,paperEntryFreezePath }=
  require('../dist/risk/paperEntryFreeze');

const start=process.cwd();
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'hunterix-exit-only-'));
const originalEnv={
  BOT_PAPER_MEME_ONLY:process.env.BOT_PAPER_MEME_ONLY,
  BOT_PAPER_MEME_DISCOVERY:process.env.BOT_PAPER_MEME_DISCOVERY,
  BOT_USE_RESERVE_QUOTES:process.env.BOT_USE_RESERVE_QUOTES,
};
let db;
async function main(){
  process.chdir(temp);
  const config={
    mode:'PAPER',startingBankrollXRP:100,minTradeXRP:5,
    maxTradeXRP:25,maxOpenTrades:5,maxDailyLossXRP:30,
  };
  process.env.BOT_PAPER_MEME_ONLY='0';
  process.env.BOT_PAPER_MEME_DISCOVERY='0';
  process.env.BOT_USE_RESERVE_QUOTES='0';

  // Missing state directory fails closed: broken filesystem may never
  // silently re-enable entry authorization.
  assert.equal(readPaperEntryFreeze().frozen,true);
  fs.mkdirSync(path.join(temp,'state'));
  assert.equal(readPaperEntryFreeze().frozen,false);
  db=new Database(path.join(temp,'paper-epoch-test.db'));
  const trader=new PaperTrader(config,db);

  const token={
    currency:'AUDIT',rawCurrency:'4155444954000000000000000000000000000000',
    issuer:'rSyntheticIssuedToken',firstSeen:Date.now(),lastUpdated:Date.now()
  };
  const snap={
    tokenCurrency:token.currency,tokenIssuer:token.issuer,
    timestamp:Date.now(),priceXRP:1,poolXrpReserve:2000,liquidityXRP:4000,
    buyCount5m:4,sellCount5m:1,uniqueBuyers5m:4,uniqueSellers5m:1,
    buyVolume5m:100,sellVolume5m:10,priceChange5m:5,priceChange15m:5,
    priceChange1h:5,holderEstimate:50,spreadPercent:1,
  };
  const opened=trader.tryOpenBurstTrade(token,snap,'OFFLINE',undefined,5);
  assert.ok(opened?.id,'synthetic PAPER trade opened before freeze');
  const key=token.currency+':'+token.issuer;
  assert.ok(db.getPaperPositionRuntime(opened),
    'new entry must carry a durable exit-state checkpoint');

  fs.writeFileSync(paperEntryFreezePath(),'exit-only\n',{mode:0o600});
  assert.equal(readPaperEntryFreeze().frozen,true);
  const newToken={...token,currency:'OTHER',issuer:'rOtherTest'};
  assert.equal(trader.tryOpenBurstTrade(newToken,snap,'OFFLINE',undefined,5),null,
    'new BURST trade MUST be frozen while existing position remains');
  assert.equal(trader.tryOpenTrade(newToken,snap,90,'OFFLINE'),null,
    'new scored/stream trade MUST be frozen');
  const decisionEngine=new TradeDecisionEngine(config);
  const tde=await decisionEngine.decide({
    currency:token.currency,issuer:token.issuer,rawCurrency:token.rawCurrency,
    snapshot:snap,signalType:'burst',signalScore:80,
    bankrollXRP:100,openPositions:0,dailyPnL:0,
    openPositionKeys:new Set(),blocklist:new Set(),
  });
  assert.equal(tde.outcome,'REJECTED');
  assert.match(tde.rejectReason||'',/entry frozen/);

  const peakSnap={...snap,priceXRP:1.18,timestamp:Date.now()+1000};
  const exits=trader.checkExits(peakSnap);
  assert.ok(exits.some(t=>t.status==='partial'),
    'TP1 PARTIAL SELL must still execute while entry freeze exists');
  const position=trader.openPositions.get(key);
  assert.ok(position?.trade.tp1Hit,'TP1 recorded');
  assert.equal(position.highestPriceSinceEntry,1.18);
  const checkpoint=db.getPaperPositionRuntime(position.trade);
  assert.equal(checkpoint?.highestPriceSinceEntry,1.18,
    'peak observed during freeze persisted immediately');
  assert.ok(checkpoint?.profileName,'exit profile persisted');

  const recovered=new PaperTrader(config,db);
  const restored=recovered.openPositions.get(key);
  assert.ok(restored,'existing position restored');
  assert.equal(restored.highestPriceSinceEntry,1.18);
  assert.equal(restored.profileName,checkpoint.profileName);
  assert.equal(restored.tradeProfile,checkpoint.tradeProfile);
  assert.equal(restored.trade.tp1Hit,true);
  assert.equal(restored.trade.remainingPosition,40);
  assert.equal(recovered.unverifiedRestartIds.size,0,
    'verified high-water recovery must not quarantine position');

  // Simulate pre-upgrade crash: a PAPER trade with NO exit-state checkpoint.
  db.db.prepare('DELETE FROM paper_position_runtime WHERE trade_id=?').run(opened.id);
  const cold=new PaperTrader(config,db);
  assert.ok(cold.unverifiedRestartIds.has(opened.id),
    'no restart must silently bless an unknown historical high-water');
  fs.unlinkSync(paperEntryFreezePath());
  assert.equal(readPaperEntryFreeze().frozen,false);
  assert.equal(cold.tryOpenBurstTrade(newToken,snap,'OFFLINE',undefined,5),null,
    'unknown historical trailing high-water quarantines NEW entries even after operator unfreeze');
  assert.ok(cold.hasOpenPosition(token.currency,token.issuer),
    'restart uncertainty NEVER deletes already open inventory');
  console.log('PASS PAPER entry-only freeze blocks new burst/scored/TDE decisions, allows TP1 sale, restores exact trailing high and quarantines missing historical checkpoints');
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{
  if(db)db.close();
  process.chdir(start);
  for(const [k,v] of Object.entries(originalEnv)){
    if(v===undefined)delete process.env[k];else process.env[k]=v;
  }
  fs.rmSync(temp,{recursive:true,force:true});
});
