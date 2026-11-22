#!/usr/bin/env node
/**
 * Old-release behavioral contract: PAPER entry INSERT happens in an atomic
 * transaction before in-memory cash or position changes; exits UPDATE old
 * rows and remain executable under a SQLite INSERT-only trigger.
 *
 * Uses actual compiled PaperTrader and Database, disposable SQLite, no web
 * requests, no real wallet, no Telegram, no changes to VPS.
 */
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {Database}=require('../dist/db/database');
const {PaperTrader}=require('../dist/paper/paperTrader');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'hunterix-old-gate-contract-'));
const cwd=process.cwd();
const names=['BOT_PAPER_MEME_ONLY','BOT_PAPER_MEME_DISCOVERY',
  'BOT_USE_RESERVE_QUOTES','BOT_PAPER_STREAM_SHADOW_ONLY'];
const previous=Object.fromEntries(names.map(n=>[n,process.env[n]]));
let db;
try{
  process.chdir(temp);
  fs.mkdirSync('state');
  process.env.BOT_PAPER_MEME_ONLY='0';
  process.env.BOT_PAPER_MEME_DISCOVERY='0';
  process.env.BOT_USE_RESERVE_QUOTES='0';
  const cfg={mode:'PAPER',startingBankrollXRP:100,
    minTradeXRP:5,maxTradeXRP:25,maxOpenTrades:5,maxDailyLossXRP:25};
  db=new Database(path.join(temp,'paper-epoch-test.db'));
  const trader=new PaperTrader(cfg,db);
  const token={
    currency:'HELD',rawCurrency:'48454C4400000000000000000000000000000000',
    issuer:'rSyntheticOldIssuer',firstSeen:Date.now(),lastUpdated:Date.now(),
  };
  const snap={
    timestamp:Date.now(),tokenCurrency:token.currency,tokenIssuer:token.issuer,
    priceXRP:1,liquidityXRP:10000,poolXrpReserve:5000,
    buyCount5m:4,sellCount5m:1,uniqueBuyers5m:4,uniqueSellers5m:1,
    priceChange5m:7,priceChange15m:5,buyVolumeXRP:100,
  };
  const held=trader.tryOpenBurstTrade(token,snap,'OFFLINE',undefined,5);
  assert.ok(held?.id,'held trade opened prior to gate');
  const oldCash=trader.getState().bankrollXRP;
  const oldRowCount=db.db.prepare('SELECT COUNT(*) n FROM paper_trades').get().n;
  db.db.exec(`CREATE TRIGGER hunterix_legacy_paper_insert_gate BEFORE INSERT ON paper_trades BEGIN SELECT RAISE(ABORT, 'HUNTERIX_OLD_PAPER_ENTRY_ONLY_BLOCK'); END`);
  const second={...token,currency:'NEW',issuer:'rSyntheticNewIssuer',
    rawCurrency:'4E45570000000000000000000000000000000000'};
  assert.throws(
    ()=>trader.tryOpenBurstTrade(second,snap,'OFFLINE',undefined,5),
    /HUNTERIX_OLD_PAPER_ENTRY_ONLY_BLOCK/,
    'frozen insert should raise before debit or in-memory new trade'
  );
  assert.equal(trader.getState().bankrollXRP,oldCash);
  assert.equal(trader.getOpenPositionsSummary().length,1);
  assert.equal(db.db.prepare('SELECT COUNT(*) n FROM paper_trades').get().n,oldRowCount);
  assert.equal(db.db.prepare('SELECT COUNT(*) n FROM paper_inventory').get().n,1);

  const hit=trader.checkExits({...snap,priceXRP:1.20,timestamp:Date.now()+1000});
  assert.ok(hit.some(x=>x.tp1Hit===true),
    'existing trade must take partial TP1 while INSERT gate armed');
  assert(db.db.prepare(
    "SELECT xrp_returned v FROM paper_trades WHERE id=?"
  ).get(held.id).v>0,'existing PAPER exit proceeds must persist');
  assert(trader.getState().bankrollXRP>oldCash,
    'existing TP1 exit must credit PAPER cash checkpoint');
  const next=db.db.prepare('SELECT COUNT(*) n FROM paper_trades').get().n;
  assert.equal(next,oldRowCount,'no synthetic entry from exit');
  console.log('PASS real PaperTrader/Database contract: INSERT gate rejects new PAPER trade BEFORE cash debit and allows existing TP1 exit UPDATE and bankroll credit');
}catch(err){
  console.error(err);
  process.exitCode=1;
}finally{
  if(db)db.close();
  process.chdir(cwd);
  for(const [k,v] of Object.entries(previous)){
    if(v===undefined)delete process.env[k];else process.env[k]=v;
  }
  fs.rmSync(temp,{recursive:true,force:true});
}