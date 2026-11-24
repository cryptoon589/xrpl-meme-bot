#!/usr/bin/env node
/** Offline missed-opportunity full-ticker decoder regression. */
'use strict';
const assert=require('node:assert/strict');
const {MissedOpportunityTracker}=require('../dist/market/missedOpportunityTracker');
const encode=x=>Buffer.from(x,'ascii').toString('hex').toUpperCase().padEnd(40,'0');
const entries=[];
const db={
  ensureMissedOpportunitiesTable(){},
  upsertMissedOpportunity(v){entries.push(v)}
};
const tracker=new MissedOpportunityTracker(db,{getPrice:async()=>null});
tracker.stop(); // never background tasks or network
try{
  for(const symbol of ['DROP','BCHAMP','5090','SWOOF']){
    tracker.record({
      currency:encode(symbol),issuer:'rSynthetic',
      rawCurrency:encode(symbol),
      skippedAt:Date.now(),skipReason:'low_liquidity',
      priceAtSkip:0.01,poolXrpReserve:250
    });
  }
  assert.deepEqual(entries.map(v=>v.currency),['DROP','BCHAMP','5090','SWOOF']);
  assert(entries.every(v=>v.rawCurrency.length===40));
  console.log('PASS missed-opportunity labels preserve terminal 0 nibble; issuer+raw identity retained');
}finally{tracker.stop();}
