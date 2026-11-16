#!/usr/bin/env node
/**
 * Read-only live ARMY AMM diagnostic for a staged Hunterix checkout.
 * Makes one XRPL amm_info request at the validated ledger, no wallet use,
 * trustlines, trades, database writes, PM2, or Telegram. Never prints secrets.
 *
 * npm run build && node scripts/diagnose_army_price.js
 */
'use strict';
require('dotenv').config();
const {Client}=require('xrpl');
const {XRP_ARMY}=require('../dist/market/priorityIssues');
const {parseXrpIssuedAmm}=require('../dist/market/parseIssuedAmm');

const endpoint=process.env.XRPL_WS_URL || 'wss://xrplcluster.com';
const client=new Client(endpoint,{connectionTimeout:10000});
const timeout=ms=>new Promise((_,rej)=>setTimeout(()=>rej(new Error('XRPL read-only request timed out')),ms));
async function main(){
  console.log('ARMY PRICE DIAGNOSTIC — READ ONLY');
  console.log('Issue: '+XRP_ARMY.currency);
  console.log('Issuer: '+XRP_ARMY.issuer);
  console.log('Currency (40-hex): '+XRP_ARMY.rawCurrency);
  console.log('Uses configured XRPL WS endpoint (credentials and URL not printed)');
  try {
    await Promise.race([client.connect(),timeout(12000)]);
    const response=await Promise.race([client.request({
      command:'amm_info',
      asset:{currency:'XRP'},
      asset2:{currency:XRP_ARMY.rawCurrency,issuer:XRP_ARMY.issuer},
      ledger_index:'validated'
    }),timeout(12000)]);
    const amm=response?.result?.amm;
    if (!amm) {
      console.error('NO_PRICE: AMM not returned for the exact ARMY issue. No trade authorized.');
      process.exitCode=2;return;
    }
    const quote=parseXrpIssuedAmm(amm,XRP_ARMY.rawCurrency,XRP_ARMY.issuer);
    if (!quote) {
      console.error('NO_PRICE: incorrect issuer, invalid reserve/fee, or frozen AMM. No trade authorized.');
      process.exitCode=2;return;
    }
    console.log('PRICE_VALID: true (read-only, validated AMM spot)');
    console.log('Pool XRP reserve: '+quote.poolXRP.toFixed(6)+' XRP');
    console.log('Pool ARMY units: '+quote.poolTokens.toPrecision(12));
    console.log('Spot price: '+quote.priceXRP.toPrecision(12)+' XRP per ARMY');
    console.log('AMM fee: '+(quote.tradingFeeUnits/1000).toFixed(3)+'%');
    console.log('Ledger index: '+(response?.result?.ledger_index??'not returned'));
    console.log('This is NOT an executable order-size sell price, trade recommendation or profit guarantee.');
  } catch(err) {
    console.error('NO_PRICE: XRPL RPC or response failure ('+
      String(err?.message||err).slice(0,160).replace(/https?:\/\/\S+/g,'[endpoint]')+')');
    process.exitCode=2;
  } finally {
    try{if(client.isConnected())await Promise.race([client.disconnect(),timeout(3000)]);}catch{}
  }
}
main().catch(()=>{console.error('NO_PRICE: unexpected read-only diagnostic failure');process.exitCode=2;});
