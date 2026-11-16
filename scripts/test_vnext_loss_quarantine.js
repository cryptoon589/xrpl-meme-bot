#!/usr/bin/env node
/**
 * Offline/PAPER-only integration test of persisted cooldowns.
 * Creates disposable SQLite databases under /tmp. No XRPL network,
 * no wallet seed, no production DB, no PM2 process changes.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Database } = require('../dist/db/database');
const { PaperTrader } = require('../dist/paper/paperTrader');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hunterix-loss-guard-'));
const config = {
  mode: 'PAPER', startingBankrollXRP:100, minTradeXRP:5,
  maxTradeXRP:25,maxOpenTrades:5,maxDailyLossXRP:30,
};
const token = {
  currency:'CFH_AUDIT',issuer:'rSyntheticIssuerNoWallet',
  rawCurrency:'4346485F41554449540000000000000000000000',
  firstSeen:Date.now(),lastUpdated:Date.now()
};
const snap = {
  tokenCurrency:token.currency,tokenIssuer:token.issuer,
  priceXRP:1,poolXrpReserve:1500,liquidityXRP:3000,
  uniqueBuyers5m:10,buyCount5m:10,sellCount5m:1,
  timestamp:Date.now()
};
const hr=3600*1000;
let counter=0;
function useDb(test, fn) {
  const dir=path.join(root,test);
  fs.mkdirSync(dir,{recursive:true});
  const db=new Database(path.join(dir,'synthetic.db'));
  try {
    // This is a fresh PAPER epoch; create the durable cash checkpoint
    // BEFORE inserting synthetic historical exits. No legacy balance guessing.
    assert.equal(db.ensureFreshPaperCashState(100),100);
    fn(db);
  }finally{db.close();}
}
function historicalClosed(db,ageHours,exitReason,pnlXRP,entryAmount=10) {
  const entryTimestamp=Date.now()-ageHours*hr-10*60*1000;
  const exitTimestamp=Date.now()-ageHours*hr;
  db.savePaperTrade({
    tokenCurrency:token.currency,tokenIssuer:token.issuer,
    entryPriceXRP:1,entryAmountXRP:entryAmount,entryTimestamp,
    entryScore:65,entryReason:'[MOMENTUM] AUDIT ONLY',
    exitPriceXRP:0.3,exitTimestamp,exitScore:null,exitReason,
    status:'closed',pnlXRP,pnlPercent:100*pnlXRP/entryAmount,
    slippageEstimate:0.02,feesPaid:0.03,xrpReturned:Math.max(0,entryAmount+pnlXRP),
    tp1Hit:false,tp2Hit:false,trailingStopActive:false,remainingPosition:0,
    tradeProfile:'BURST_SCALP',tradeSource:'momentum',
  });
}
function burst(p){return p.tryOpenBurstTrade(token,snap,'OFFLINE_AUDIT',undefined,5);}
function scored(p){return p.tryOpenTrade(token,snap,65,'[SCORED] OFFLINE_AUDIT');}
try {
  delete process.env.TRADING_WALLET_SEED;
  process.env.BOT_ENABLE_LIQUIDITY_LOSS_GUARD='1';
  process.env.BOT_USE_RESERVE_QUOTES='0';
  useDb('recent-collapse',db=>{
    historicalClosed(db,0.5,'kill_liq_drop',-8);
    const before=new PaperTrader(config,db);
    assert.equal(burst(before),null,'burst must not reenter recent collapsed pool');
    assert.equal(scored(before),null,'scored route must not bypass guard');
    const afterRestart=new PaperTrader(config,db);
    assert.equal(burst(afterRestart),null,'restart must not bypass persisted guard');
    console.log('PASS recent liquidity collapse blocked in both routes and after restart');
  });
  useDb('catastrophic-other',db=>{
    historicalClosed(db,1,'stop_loss',-8);
    assert.equal(burst(new PaperTrader(config,db)),null);
    assert.equal(scored(new PaperTrader(config,db)),null);
    console.log('PASS catastrophic 80% loss blocked even when ordinary exit reason');
  });
  useDb('multiple-collapses',db=>{
    historicalClosed(db,55,'kill_liq_drop',-8);
    historicalClosed(db,25,'kill_liq_drop',-7);
    assert.equal(burst(new PaperTrader(config,db)),null,
                 'repeated collapses block even after 24h single-event timeout');
    console.log('PASS repeated collapses trigger 72h rule');
  });
  useDb('two-recovered-collapses',db=>{
    historicalClosed(db,122,'kill_liq_drop',-8);
    historicalClosed(db,74,'kill_liq_drop',-7);
    assert.ok(burst(new PaperTrader(config,db)),
              'later recovery can be entered after 72h from last collapse');
    console.log('PASS guard expires; not a permanent ticker blacklist');
  });
  useDb('isolated-old-collapse',db=>{
    historicalClosed(db,25,'kill_liq_drop',-8);
    assert.ok(burst(new PaperTrader(config,db)),'single collapse should expire after 24h');
  });
  useDb('unpriceable',db=>{
    historicalClosed(db,1,'force_close_no_price',0);
    assert.equal(burst(new PaperTrader(config,db)),null,'ghost/unpriceable exit must block 24h');
    console.log('PASS unpriceable token is a temporary safety block');
  });
  useDb('guard-disabled-default',db=>{
    historicalClosed(db,0.5,'kill_liq_drop',-8);
    process.env.BOT_ENABLE_LIQUIDITY_LOSS_GUARD='0';
    assert.ok(burst(new PaperTrader(config,db)),'opt-in feature must be disabled by default');
    console.log('PASS current production behavior unchanged when flag disabled');
  });
  console.log('PAPER LOSS GUARD TEST PASS: all checks isolated and offline');
} finally {
  delete process.env.BOT_ENABLE_LIQUIDITY_LOSS_GUARD;
  delete process.env.BOT_USE_RESERVE_QUOTES;
  fs.rmSync(root,{recursive:true,force:true});
}
