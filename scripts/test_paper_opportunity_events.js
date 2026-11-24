#!/usr/bin/env node
/** Synthetic V2.1 observation events; never use live network or original DB. */
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {Database}=require('../dist/db/database');
const cwd=process.cwd();
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hunterix-v21-events-'));
let db;
try {
  process.chdir(dir);
  fs.mkdirSync('data');
  db=new Database(path.join(dir,'data','meme_bot.paper-epoch-20261122-test.db'));
  const first=Date.now()-60000, issuer='rSyntheticIssuer1', raw='504E580000000000000000000000000000000000';
  const token={currency:'PNX',issuer,rawCurrency:raw,firstSeen:first,lastUpdated:first};
  db.saveToken(token);
  db.saveToken(token);
  const count=kind=>db.db.prepare(
    'SELECT COUNT(*) n FROM paper_opportunity_events WHERE event_type=?'
  ).get(kind).n;
  assert.equal(count('first_detected'),1,'token first sighting is idempotent');
  // An externally tagged meme may have a historical provider dateon
  // (seconds or milliseconds). HUNTERIX first-detection is the INSERT time,
  // not the original token issuance date.
  const pastDateon=1600000000;
  const beforeInsert=Date.now();
  db.saveToken({currency:'OLDMETA',issuer:'rSyntheticIssuerDateon',
    rawCurrency:'4F4C444D45544100000000000000000000000000',
    firstSeen:pastDateon,lastUpdated:beforeInsert});
  const firstRow=db.db.prepare(
    "SELECT observed_at FROM paper_opportunity_events WHERE event_type='first_detected' AND token_issuer=?"
  ).get('rSyntheticIssuerDateon');
  assert(firstRow && firstRow.observed_at>=beforeInsert &&
    firstRow.observed_at<=Date.now(),
    'first_detected must use the actual bot observation time');
  const tokenRow=db.db.prepare(
    "SELECT first_seen FROM tokens WHERE issuer=?"
  ).get('rSyntheticIssuerDateon');
  assert.equal(tokenRow.first_seen,pastDateon,
    'existing provider token metadata must not be rewritten');

  const record=(eventType,issuerArg=issuer,when=first)=>db.recordOpportunityEvent({
    tokenCurrency:'PNX',tokenIssuer:issuerArg,rawCurrency:raw,
    observedAt:when,eventType,source:'burst',priceXRP:1,
  });
  assert.equal(record('burst_seen'),true);
  assert.equal(record('burst_seen'),false,'repeat same 15m bucket deduped');
  assert.equal(record('burst_seen','rOtherIssuer'),true,'different issuer independent');
  assert.equal(record('burst_seen',issuer,first+900000),true,'later bucket retained');
  assert.equal(record('stream_qualified'),true);
  assert.equal(record('stream_qualified'),false);
  assert.equal(count('burst_seen'),3);
  assert.equal(count('stream_qualified'),1);
  assert.equal(record('external_gainer_seen'),true);
  assert.equal(record('external_gainer_seen'),false,
    '15m issuer-exact gainer duplicates must be suppressed');
  assert.equal(record('external_gainer_seen','rOtherIssuer'),true,
    'identical ticker but different issuers must remain independent');
  assert.equal(count('external_gainer_seen'),2);

  assert.equal(record('amm_pressure_compare'),true,
    'side-by-side AMM metadata evidence must persist independently');
  assert.equal(record('amm_pressure_compare'),false,
    'AMM compare event must dedup by exact issue per 15m');
  assert.equal(record('amm_pressure_compare','rOtherIssuer'),true,
    'same ticker with different issuer must remain separate');
  assert.equal(count('amm_pressure_compare'),2);

  assert.equal(record('burst_seen',issuer,NaN),false,'invalid timestamps are refused');
  const evidence={
    currency:'PNX',issuer,rawCurrency:raw,observedAt:first+1000,
    priceXRP:1,priceObservedAt:first+500,poolXrpReserve:5000,
    uniqueBuyers:4,buyCount5m:5,sellCount5m:1,buySellRatio:0.8,
    buyVolumeXRP:100,newWalletBuys:2,signalType:'stream',
    assignedProfile:'BURST_SCALP',approvedSizeXRP:5,roundTripLossPct:0.8
  };
  assert.equal(db.recordPaperStreamShadowSignal(evidence),true);
  assert.equal(db.recordPaperStreamShadowSignal(evidence),false);
  assert.equal(count('stream_qualified'),1,'stream shadow does not duplicate event bucket');
  assert.equal(db.db.prepare('SELECT COUNT(*) n FROM paper_trades').get().n,0);
  console.log('PASS V2.1: first-detected and 15m exact issuer events, no PAPER trade, no duplicate shadow events');
}finally{
  if(db)db.close();
  process.chdir(cwd);
  fs.rmSync(dir,{recursive:true,force:true});
}
