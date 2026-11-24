#!/usr/bin/env node
/** Fully offline AMM micro observation regression; no real PAPER database. */
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process');
const {Database}=require('../dist/db/database');
const {micro}=require('./audit_micro_amm_shadow');
const cwd=process.cwd(),oldMode=process.env.MODE,oldLive=process.env.LIVE_TRADING;
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hunterix-micro-evidence-'));
let db;
const raw='424C41434B53574E000000000000000000000000',issuer='rMockEvidenceIssuer';
try{
  process.chdir(dir);fs.mkdirSync('data');
  process.env.MODE='PAPER';process.env.LIVE_TRADING='false';
  const filename=path.join(dir,'data','meme_bot.paper-epoch-20261124-test.db');
  db=new Database(filename);
  const t=Date.now()-900;
  const fresh={tokenCurrency:'BLACKSWN',rawCurrency:raw,tokenIssuer:issuer,
    observedAt:t,poolXrpReserve:300,poolTokenReserve:2000000,
    tradingFeeUnits:300,source:'amm'};
  assert.equal(db.recordPaperAmmReserveEvidence(fresh),true);
  assert.equal(db.recordPaperAmmReserveEvidence(fresh),false,
    '5-minute exact issue bucket dedup');
  assert.equal(db.recordPaperAmmReserveEvidence({...fresh,tokenIssuer:'rOtherIssuer'}),true);
  assert.equal(db.recordPaperAmmReserveEvidence({...fresh,tradingFeeUnits:1001,observedAt:t+1}),false);
  assert.equal(db.recordPaperAmmReserveEvidence({...fresh,observedAt:t-1000000}),false,'no stale reserve evidence');
  assert.equal(db.recordPaperAmmReserveEvidence({...fresh,source:'orderbook'}),false);
  process.env.MODE='LIVE';
  assert.equal(db.recordPaperAmmReserveEvidence({...fresh,observedAt:t+1}),false,'LIVE disabled');
  process.env.MODE='PAPER';
  const row=db.db.prepare('SELECT * FROM paper_amm_reserve_evidence WHERE token_issuer=?').get(issuer);
  assert.equal(row.pool_xrp_reserve,300);
  assert.equal(row.pool_token_reserve,2000000);
  assert.equal(row.trading_fee_units,300);
  assert.equal(db.db.prepare('SELECT COUNT(*) n FROM paper_trades').get().n,0);
  assert.equal(db.db.prepare('SELECT COUNT(*) n FROM paper_opportunity_events').get().n,0);
  const early=Date.now()-65*60000;
  const stamp=(minute)=>early+minute*60000;
  db.db.prepare('DELETE FROM paper_amm_reserve_evidence').run();
  const insert=db.db.prepare('INSERT INTO paper_amm_reserve_evidence (token_currency,raw_currency,token_issuer,observed_at,bucket_5m,pool_xrp_reserve,pool_token_reserve,trading_fee_units,source) VALUES(?,?,?,?,?,?,?,?,?)');
  for(const [minute,xrp,tokens] of [[0,300,2000000],[11,390,1700000],[31,120,4000000],[61,620,1400000]]){
    const ts=stamp(minute);
    insert.run('BLACKSWN',raw,issuer,ts,Math.floor(ts/300000),xrp,tokens,300,'amm');
  }
  const e={pool_xrp_reserve:300,pool_token_reserve:2000000,trading_fee_units:300};
  const x={pool_xrp_reserve:390,pool_token_reserve:1700000,trading_fee_units:300};
  assert(micro(1,e,x).netXRP>0,'rising AMM reserve scenario gives indicative positive return');
  assert(micro(5,e,x).entryImpact>micro(1,e,x).entryImpact,'larger size costs more');
  assert.equal(micro(0,e,x),null);
  db.close();db=null;
  const before=fs.statSync(filename).size;
  const log=cp.execFileSync(process.execPath,[
    path.join(cwd,'scripts','audit_micro_amm_shadow.js'),filename,
    '--focus=BLACKSWN','--limit=5','--hours=72'
  ],{cwd,encoding:'utf8'});
  assert(log.includes('BLACKSWN') && log.includes('1 XRP:')&&log.includes('2 XRP:')&&log.includes('5 XRP:')&&log.includes('+60m observed'),log);
  assert(log.includes('NO actual fills')&&log.includes('counterfactual'),log);
  assert.equal(fs.statSync(filename).size,before,'no audit mutation');
  console.log('PASS issuer-specific, time-stamped 1/2/5 XRP reserve data, fee/impact estimates, no entries/PM2/RPC, read-only audit');
}finally{
  if(db)db.close();
  if(oldMode===undefined)delete process.env.MODE;else process.env.MODE=oldMode;
  if(oldLive===undefined)delete process.env.LIVE_TRADING;else process.env.LIVE_TRADING=oldLive;
  process.chdir(cwd);fs.rmSync(dir,{recursive:true,force:true});
}
