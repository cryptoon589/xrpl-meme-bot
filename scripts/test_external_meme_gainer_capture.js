#!/usr/bin/env node
/** Prospective top-gainer observation, shared provider budget, no real HTTP. */
'use strict';
const assert=require('node:assert/strict');
const {MemeCategoryFeed}=require('../dist/market/memeCategoryFeed');
const {dynamicMemeUniverse}=require('../dist/risk/dynamicMemeUniverse');
const issuer='rDFXbW2ZZCG5WgPtqwNiA2xZokLMm9ivmN';
const token='50484E4958000000000000000000000000000000';
let clock=1800000000000;
const calls=[];
const f=async u=>{
  const url=new URL(u);calls.push(url);
  const gainers=url.searchParams.get('sort')==='pro24h';
  return {ok:true,status:200,headers:{get:()=>null},
    text:async()=>JSON.stringify({
      success:true,tagName:'Memes',
      tokens:[{
        currency:token,issuer,tags:['Memes'],tokenType:'trustline',
        pro24h:gainers?85:0,vol24hxrp:360,exch:0.00001
      },...(gainers ? [{
        currency:Buffer.from('ONLYGAINER').toString('hex').toUpperCase().padEnd(40,'0'),
        issuer,tags:['Memes'],tokenType:'trustline',
        pro24h:66,vol24hxrp:420,exch:0.0003
      }]:[]),{
        currency:'4842415200000000000000000000000000000000',
        issuer,tags:['Memes','RWA'],tokenType:'trustline',
        pro24h:150,vol24hxrp:360,exch:0.002
      }]
    })};
};
const observed=[];
const feed=new MemeCategoryFeed(()=>{},f,()=>clock);
feed.onGainerObserved=item=>observed.push(item);
async function main(){
  for(let i=0;i<4;i++){
    await feed.refresh();
    clock+=15*60*1000+1000;
  }
  assert.equal(calls.length,4,'must use one category request each 15min');
  assert.deepEqual(calls.map(x=>x.searchParams.get('sort')),
    ['vol24hxrp','dateon','vol24hxrp','pro24h']);
  assert.equal(calls[3].searchParams.get('min_vol24hxrp'),'50');
  assert.equal(observed.length,2,'tagged genuine gainers only; conflicting RWA rejected');
  const gainerOnly=Buffer.from('ONLYGAINER').toString('hex').toUpperCase().padEnd(40,'0');
  assert(observed.some(i=>i.currency===gainerOnly));
  assert.equal(dynamicMemeUniverse.hasIssue(gainerOnly,issuer,undefined,clock),false,
    'observation-only gainer must not enter the shared live trading universe');
  assert.equal(observed[0].currency,token);
  assert.equal(observed[0].issuer,issuer);
  assert.equal(observed[0].change24hPct,85);
  assert.equal(observed[0].volume24hXRP,360);
  assert.equal(observed[0].priceXRP,0.00001);
  assert(feed.stats().budgetUsed<=1,
    'the rotating gainer page must not exceed the provider request window');
  console.log('PASS hourly prospective gainer observation, same budget, issuer exact, conflicting RWA tag rejected; no trades or network');
}
main().catch(e=>{console.error(e);process.exitCode=1});
