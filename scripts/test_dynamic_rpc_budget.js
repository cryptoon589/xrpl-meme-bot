#!/usr/bin/env node
/** Offline regression: dynamic PAPER mode avoids AMM flood for unknown tokens. */
'use strict';
const assert=require('node:assert/strict');
const {ActiveDiscovery}=require('../dist/scanner/activeDiscovery');
const {BurstDetector}=require('../dist/scanner/burstDetector');
const {dynamicMemeUniverse}=require('../dist/risk/dynamicMemeUniverse');

async function main(){
  const saved={MODE:process.env.MODE,BOT_PAPER_MEME_DISCOVERY:process.env.BOT_PAPER_MEME_DISCOVERY};
  process.env.MODE='PAPER';
  process.env.BOT_PAPER_MEME_DISCOVERY='1';
  try {
    const issuer='rGG3wQ4kUzd7Jnmk1n5NWPZjjut62kCBfC';
    const unknown='4E4F4E4D454D45000000000000000000000000';
    const known='544553544D454D450000000000000000000000';
    const confirmed='4C41554E43484D454D450000000000000000';
    const observed=[];
    const request=async arg=>{
      observed.push(arg);
      return {result:{amm:null}};
    };
    const client={getClient:()=>({request})};
    const discovery=new ActiveDiscovery(client, {});
    const payment=currency=>({
      validated:true,tx_json:{TransactionType:'Payment',Amount:{currency,issuer}}
    });
    assert(discovery.processLiveTx(payment(unknown)));
    await new Promise(r=>setImmediate(r));
    assert.equal(observed.length,0,
      'routine unclassified token discovery must not issue expensive AMM RPC');

    dynamicMemeUniverse.acceptTaggedPage([
      {currency:known,issuer,tags:['Memes'],tokenType:'trustline'}
    ],Date.now());
    assert(discovery.processLiveTx(payment(known)));
    await new Promise(r=>setImmediate(r));
    assert.equal(observed.length,1,
      'confirmed meme token discovery may request one AMM quote');

    const create={
      validated:true,engine_result:'tesSUCCESS',
      tx_json:{TransactionType:'AMMCreate',Amount:'1000000',Amount2:{currency:confirmed,issuer}},
      meta:{TransactionResult:'tesSUCCESS'}
    };
    assert(discovery.processLiveTx(create));
    await new Promise(r=>setImmediate(r));
    assert.equal(observed.length,2,
      'validated AMMCreate stays discoverable even when meme metadata is missing');

    const poolCalls=[];
    const tokens=[{currency:'AAA',rawCurrency:known,issuer,firstSeen:Date.now(),lastUpdated:Date.now()},
      {currency:'BBB',rawCurrency:unknown,issuer,firstSeen:Date.now(),lastUpdated:Date.now()}];
    const db={getTrackedTokens:()=>tokens};
    const burst=new BurstDetector(client,{},db);
    burst.fetchAMMAccount=async (raw,iss)=>{
      poolCalls.push(raw+':'+iss);
      return null;
    };
    await burst.preloadAMMs([tokens[0]]);
    assert.equal(poolCalls.length,1,'explicit subset limits AMM preload work');
    assert.equal(poolCalls[0],known+':'+issuer);

    console.log('PASS dynamic RPC budget: unknown passive tokens 0 AMM requests, validated launches 1, exact burst preload bounded');
  } finally {
    for(const [key,value] of Object.entries(saved)){
      if(value===undefined)delete process.env[key];else process.env[key]=value;
    }
  }
}
main().catch(e=>{console.error(e);process.exitCode=1});
