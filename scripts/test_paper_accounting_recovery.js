#!/usr/bin/env node
/**
 * Real class integration, synthetic disposable SQLite only.
 * No LIVE mode, wallet seed, network call, PM2, or historic data modification.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Database } = require('../dist/db/database');
const { PaperTrader } = require('../dist/paper/paperTrader');
const { initialTokens } = require('../dist/paper/paperAccounting');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hunterix-accounting-'));
const config = {
  mode:'PAPER',startingBankrollXRP:100,minTradeXRP:5,maxTradeXRP:25,
  maxOpenTrades:5,maxDailyLossXRP:30,
};
const token={currency:'AUDIT',issuer:'rSyntheticPaperIssuer',rawCurrency:'4155444954000000000000000000000000000000',
             firstSeen:Date.now(),lastUpdated:Date.now()};
const snapshot={
  tokenCurrency:token.currency,tokenIssuer:token.issuer,timestamp:Date.now(),
  priceXRP:1,poolXrpReserve:2000,liquidityXRP:4000,
  buyCount5m:11,sellCount5m:2,uniqueBuyers5m:9,uniqueSellers5m:2,
  buyVolume5m:30,sellVolume5m:5,priceChange5m:8,priceChange15m:12,priceChange1h:20,
  holderEstimate:100,spreadPercent:1,
};
const key=token.currency+':'+token.issuer;
const approx=(a,b,epsilon=1e-7)=>assert.ok(Math.abs(a-b)<epsilon, String(a)+' != '+String(b));

let db;
try {
  delete process.env.TRADING_WALLET_SEED;
  process.env.BOT_DB_PATH=path.join(temp,'fresh-paper.db');
  db=new Database(process.env.BOT_DB_PATH);
  const trader = new PaperTrader(config,db);
  assert.equal(trader.getState().cashReconciled,true,'fresh cash baseline must be verified');
  approx(trader.getState().bankrollXRP,100);

  const t=trader.tryOpenBurstTrade(token,snapshot,'OFFLINE_ONLY',undefined,5);
  assert.ok(t && t.id,'durable trade ID required');
  const bought=initialTokens(t);
  approx(db.getPaperInventory(t.id),bought);
  approx(trader.openPositions.get(key).tokensHeld,bought);
  approx(trader.getState().bankrollXRP,100-5-5*0.003);

  const before=trader.getState().bankrollXRP;
  const s1={...snapshot,priceXRP:1.6};
  trader.partialClose(key,1.6,40,'take_profit_1',s1);
  const t1=trader.openPositions.get(key).trade;
  assert.equal(t1.remainingPosition,60);
  approx(db.getPaperInventory(t.id),bought*0.6);
  approx(trader.openPositions.get(key).tokensHeld,bought*0.6);
  assert.ok(t1.pnlXRP>0,'partial P&L must be realized gains, not full entry-cost loss');
  assert.ok(trader.getState().bankrollXRP>before);

  const cashBeforeRestart=trader.getState().bankrollXRP;
  const traderAfterRestart=new PaperTrader(config,db);
  approx(traderAfterRestart.getState().bankrollXRP,cashBeforeRestart);
  assert.equal(traderAfterRestart.getState().cashReconciled,true);
  approx(traderAfterRestart.openPositions.get(key).tokensHeld,bought*.6);
  assert.equal(traderAfterRestart.closePosition(key,0,'force_close_no_price',null),null);
  assert.ok(traderAfterRestart.hasOpenPosition(token.currency,token.issuer),
    'no-price must never mint a refund or remove inventory');

  const beforeFull=traderAfterRestart.getState().bankrollXRP;
  const s2={...snapshot,priceXRP:1.4};
  const closed=traderAfterRestart.closePosition(key,1.4,'time_stop',s2);
  assert.ok(closed && closed.status==='closed');
  const unsold=bought*.6;
  const slip=(unsold*1.4)/(2000+unsold*1.4);
  const finalNet=unsold*1.4*(1-slip)*(1-0.003);
  approx(db.getPaperCashState(),beforeFull+finalNet,0.0001); // getState deliberately rounds display to 4 dp
  approx(traderAfterRestart.getState().bankrollXRP,beforeFull+finalNet,0.0001);
  approx(closed.xrpReturned - closed.entryAmountXRP*(1+0.003),closed.pnlXRP,1e-6);
  approx(db.getPaperInventory(t.id),0);
  assert.ok(!traderAfterRestart.hasOpenPosition(token.currency,token.issuer));
  const afterLastRestart=new PaperTrader(config,db);
  approx(afterLastRestart.getState().bankrollXRP,traderAfterRestart.getState().bankrollXRP);
  assert.equal(afterLastRestart.getState().openPositions,0);
  console.log('PASS fresh cash checkpoint, partial quantity, mid-trade restart, full close and fees');

  const noSaleDir=path.join(temp,'historic');
  fs.mkdirSync(noSaleDir,{recursive:true});
  const legacyDb=new Database(path.join(noSaleDir,'legacy.db'));
  const old={
    ...closed,id:undefined,tokenCurrency:'LEGACY',tokenIssuer:'rLegacyOtherIssuer',
    entryTimestamp:Date.now()-3600000,entryAmountXRP:5,status:'closed',entryReason:'OLD',
  };
  legacyDb.savePaperTrade(old);
  const legacyTrader=new PaperTrader(config,legacyDb);
  assert.equal(legacyTrader.getState().cashReconciled,false);
  assert.equal(legacyDb.getPaperCashState(),null);
  assert.equal(legacyTrader.tryOpenBurstTrade(token,snapshot,'OFFLINE_ONLY',undefined,5),null);
  assert.equal(legacyDb.getPaperCashState(),null,'must not bootstrap old account by guess');
  legacyDb.close();
  console.log('PASS historical DB fails closed instead of resetting cash to fabricated baseline');

  const bad={...closed,id:0,tokenCurrency:'BAD',tokenIssuer:'rInvalid',status:'open'};
  const oldCash=db.getPaperCashState(); // compare full-precision persisted value
  assert.throws(()=>db.commitPaperMutation(bad,oldCash, -1,'entry'));
  approx(db.getPaperCashState(),oldCash);
  console.log('PASS invalid checkpoint fails atomically');
  console.log('PAPER ACCOUNTING RECOVERY TESTS PASSED');
} finally {
  if(db)db.close();
  fs.rmSync(temp,{recursive:true,force:true});
}
