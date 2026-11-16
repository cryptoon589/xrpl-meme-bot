#!/usr/bin/env node
/** Isolated PAPER AMM reserve execution integration; never calls XRPL/network. */
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {PaperTrader}=require('../dist/paper/paperTrader');
const {Database}=require('../dist/db/database');
const {TradeDecisionEngine}=require('../dist/execution/tradeDecisionEngine');
const {estimateAmmBuy,estimateAmmSell}=require('../dist/paper/ammExecutionQuote');
const {quotePaperRoundTrip}=require('../dist/paper/reservePaperExecution');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'hunterix-depth-execution-'));
const token={currency:'SYNTH',issuer:'rKfcfA5bLsELJfbkjKRqc5kAzrd22esfy',rawCurrency:'53594E5448000000000000000000000000000000',lastUpdated:Date.now()};
const config={mode:'PAPER',liveTrading:false,startingBankrollXRP:100,minTradeXRP:5,maxTradeXRP:25,maxOpenTrades:5,maxDailyLossXRP:30};
const q=(x=2000,y=2000,fee=100)=>({
  tokenCurrency:token.currency,tokenIssuer:token.issuer,
  priceXRP:x/y,poolXrpReserve:x,liquidityXRP:2*x,
  poolTokens:y,tradingFeeUnits:fee,priceObservedAtMs:Date.now(),priceSource:'amm',
  buyCount5m:5,sellCount5m:1,uniqueBuyers5m:3,
});
const approx=(a,b,e=1e-8)=>assert.ok(Math.abs(a-b)<=e,String(a)+' != '+String(b));
let db;
(async()=>{try{
  process.env.BOT_USE_RESERVE_QUOTES='1';
  db=new Database(path.join(tmp,'paper.db'));
  const tde=new TradeDecisionEngine(config);
  const trader=new PaperTrader(config,db);
  const snap=q();
  const input={currency:token.currency,issuer:token.issuer,rawCurrency:token.rawCurrency,
    snapshot:snap,signalType:'burst',signalScore:75,
    bankrollXRP:trader.getState().bankrollXRP,openPositions:0,dailyPnL:0,
    openPositionKeys:new Set(),blocklist:new Set()};
  const decision=await tde.decide(input);
  assert.equal(decision.outcome,'APPROVED_PAPER',decision.rejectReason);
  const originalSize=decision.sizeXRP;
  const exact=estimateAmmBuy(originalSize,snap.poolXrpReserve,snap.poolTokens,snap.tradingFeeUnits);
  const opened=trader.tryOpenBurstTrade(token,snap,'SYNTH',undefined,originalSize);
  assert.ok(opened?.id);
  approx(db.getPaperInventory(opened.id),exact.amountOut);
  approx(trader.getState().bankrollXRP,100-originalSize*1.003,1e-4);
  assert.ok((await tde.decide({...input,snapshot:{...snap,priceObservedAtMs:Date.now()-60_000}})).outcome==='REJECTED');
  assert.ok((await tde.decide({...input,snapshot:{...snap,poolTokens:undefined}})).outcome==='REJECTED');
  assert.equal(quotePaperRoundTrip(originalSize,{...snap,priceObservedAtMs:Date.now()-60000}),null);
  console.log('PASS full reserve-aware PAPER entry and strict stale/missing reserve rejection');

  const key=token.currency+':'+token.issuer;
  const sellSnap=q(2100,1400);
  const physical=trader.openPositions.get(key).tokensHeld;
  const leg=physical*0.4;
  const sell=estimateAmmSell(leg,1400,2100,100);
  assert.equal(trader.partialClose(key,sellSnap.priceXRP,40,'take_profit_1',sellSnap),true);
  const remain=trader.openPositions.get(key).tokensHeld;
  approx(remain,physical*.6);
  const expectedCash=100-originalSize*1.003+sell.amountOut*.997;
  approx(db.getPaperCashState(),expectedCash,1e-7);
  const restart=new PaperTrader(config,db);
  approx(restart.openPositions.get(key).tokensHeld,remain);
  const before=db.getPaperCashState();
  const invalid=q(2500,1400);invalid.priceObservedAtMs=Date.now()-60000;
  assert.equal(restart.closePosition(key,invalid.priceXRP,'time_stop',invalid),null);
  approx(db.getPaperCashState(),before);
  const doneSnap=q(2300,1250);
  const exit=estimateAmmSell(remain,1250,2300,100);
  const closed=restart.closePosition(key,doneSnap.priceXRP,'time_stop',doneSnap);
  assert.equal(closed.status,'closed');
  approx(db.getPaperCashState(),before+exit.amountOut*.997);
  approx(db.getPaperInventory(opened.id),0);
  approx(closed.xrpReturned-originalSize*1.003,closed.pnlXRP,1e-6);
  console.log('PASS partial sell, retry after absent quote, restart inventory and final full-reserve sale');

  const launch=q(300,300);launch.isNewLaunch=true;
  process.env.BOT_ENABLE_SMALL_LAUNCH_PROBES='1';
  const d=await tde.decide({...input,snapshot:launch,signalType:'burst'});
  assert.equal(d.outcome,'APPROVED_PAPER',d.rejectReason);
  assert.equal(d.profile.name,'NEW_LAUNCH');
  assert.ok(d.sizeXRP>=2&&d.sizeXRP<5);
  const launchTrader=new PaperTrader(config,new Database(path.join(tmp,'launch.db')));
  const launchTrade=launchTrader.tryOpenBurstTrade(token,launch,'NEW_LAUNCH',undefined,d.sizeXRP);
  assert.ok(launchTrade,'300 XRP freshly created AMM should permit explicitly enabled small PAPER probe');
  assert.ok(launchTrade.entryAmountXRP<5,'do not silently inflate a 3 XRP quote into 5 XRP purchase');
  console.log('PASS opt-in small new-launch probe respects quoted TDE size and pool minimum');
  console.log('PAPER RESERVE EXECUTION INTEGRATION TESTS PASSED');
}catch(e){console.error(e);process.exitCode=1;}finally{
  if(db)db.close();
  delete process.env.BOT_USE_RESERVE_QUOTES;
  delete process.env.BOT_ENABLE_SMALL_LAUNCH_PROBES;
  fs.rmSync(tmp,{recursive:true,force:true});
}})();
