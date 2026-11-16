#!/usr/bin/env node
/**
 * One-shot read-only XRP ARMY price diagnostic.
 * Receives ONLY an XRPL endpoint. No wallet seed, DB or Telegram.
 * Classifies server rate limiting separately from a missing/invalid pool.
 */
'use strict';
require('dotenv').config();
const {Client}=require('xrpl');
const {XRP_ARMY}=require('../dist/market/priorityIssues');
const {parseXrpIssuedAmm}=require('../dist/market/parseIssuedAmm');

const endpoint=process.env.XRPL_WS_URL || 'wss://xrplcluster.com';
const u=new URL(endpoint);
if(u.protocol!=='wss:' || u.username || u.password) {
  console.error('CONFIG_ERROR: encrypted non-credentialed XRPL WebSocket URL required');
  process.exit(2);
}
const client=new Client(endpoint,{timeout:12000,connectionTimeout:9000});
const withDeadline=async(promise,ms)=>{
  let timer;
  try {
    return await Promise.race([promise,new Promise((_,reject)=>{
      timer=setTimeout(()=>reject(new Error('read-only XRPL request timed out')),ms);
    })]);
  } finally {if(timer)clearTimeout(timer);}
};
function category(err){
  const msg=String(err?.message || '')+' '+String(err?.data?.error || '');
  if(/threshold exceeded|rate.limit|slow.down|too busy|overloaded/i.test(msg))
    return ['RATE_LIMITED',3,'The provider closed the connection due to load. Do not immediately retry this endpoint.'];
  if(/disconnect|websocket|closed|connection|timeout|not.connected|network|ECONN/i.test(msg))
    return ['RPC_UNAVAILABLE',2,'The network/WebSocket connection failed before a usable AMM quote.'];
  if(/actNotFound|Account not found|objectNotFound/i.test(msg))
    return ['NO_POOL',2,'No matching AMM returned for this exact currency and issuer.'];
  return ['RPC_FAILED',2,'The XRPL read-only request was rejected; no usable AMM quote.'];
}

async function main(){
  console.log('ARMY PRICE DIAGNOSTIC — READ ONLY');
  console.log('Issue: '+XRP_ARMY.currency);
  console.log('Issuer: '+XRP_ARMY.issuer);
  console.log('Currency (40-hex): '+XRP_ARMY.rawCurrency);
  console.log('Uses configured XRPL WS endpoint (credentials and URL not printed)');
  let result=0;
  try {
    await withDeadline(client.connect(),11000);
    const response=await withDeadline(client.request({
      command:'amm_info',
      asset:{currency:'XRP'},
      asset2:{currency:XRP_ARMY.rawCurrency,issuer:XRP_ARMY.issuer},
      ledger_index:'validated'
    }),13000);
    const amm=response?.result?.amm;
    if (!amm) {
      console.error('NO_POOL: No matching validated AMM returned for the exact ARMY issue.');
      result=2;
    } else {
      const quote=parseXrpIssuedAmm(amm,XRP_ARMY.rawCurrency,XRP_ARMY.issuer);
      if (!quote) {
        console.error('INVALID_POOL: Incorrect issuer, malformed reserves/fees or frozen AMM; no trading authorization.');
        result=2;
      } else {
        console.log('PRICE_VALID: true (read-only, validated AMM spot)');
        console.log('Pool XRP reserve: '+quote.poolXRP.toFixed(6)+' XRP');
        console.log('Pool ARMY units: '+quote.poolTokens.toPrecision(12));
        console.log('Spot price: '+quote.priceXRP.toPrecision(12)+' XRP per ARMY');
        console.log('AMM fee: '+(quote.tradingFeeUnits/1000).toFixed(3)+'%');
        console.log('Ledger index: '+(response?.result?.ledger_index??'not returned'));
        console.log('Not an executable sell quote, trade recommendation, or profit guarantee.');
      }
    }
  } catch(err) {
    const [tag,code,description]=category(err);
    console.error(tag+': '+description);
    result=code;
  } finally {
    try {if(client.isConnected())await withDeadline(client.disconnect(),2500);}catch{}
  }
  // xrpl.js may leave internal timers or reconnect handlers alive even after
  // a closed socket. This isolated, no-write CLI must terminate deterministically.
  process.exit(result);
}
main().catch(()=>{
  console.error('RPC_FAILED: Unexpected read-only diagnostic error (no trades sent).');
  process.exit(2);
});
