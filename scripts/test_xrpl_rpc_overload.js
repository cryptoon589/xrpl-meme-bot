#!/usr/bin/env node
/** XRP Ledger RPC overload/reconnect protection — offline deterministic mocks. */
const assert=require('node:assert/strict');
const {AMMPriceFetcher}=require('../dist/market/ammPriceFetcher');
const {XRP_ARMY}=require('../dist/market/priorityIssues');

async function main() {
  let amms=0,books=0;
  const rateLimited = {
    getClient:()=>({request:async()=>{
      amms++;
      throw new Error('DisconnectedError: websocket was closed, threshold exceeded');
    }}),
    getBookOffers:async()=>{books++; return {offers:[]};}
  };
  const fetcher=new AMMPriceFetcher(rateLimited);
  const first=await fetcher.getPrice('ARMY',XRP_ARMY.issuer,XRP_ARMY.rawCurrency,true,true);
  assert.equal(first,null);
  assert.equal(amms,1);
  assert.equal(books,0,'rate-limited AMM must NOT start order book fallback');
  const second=await fetcher.getPrice('LOVE','rAnotherIssuer','LOVE',true,true);
  assert.equal(second,null);
  assert.equal(amms,1,'forced fresh requests must still obey provider-wide cooldown');
  assert.equal(books,0);
  console.log('PASS threshold-exceeded circuit breaker blocks BOTH AMM and DEX calls without token blacklist');

  let notFound=0,bookFallback=0;
  const noPool={
    getClient:()=>({request:async()=>{notFound++;throw new Error('actNotFound: Account not found');}}),
    getBookOffers:async()=>{bookFallback++;return {offers:[]};}
  };
  const noPoolFetcher=new AMMPriceFetcher(noPool);
  assert.equal(await noPoolFetcher.getPrice('ARMY',XRP_ARMY.issuer,XRP_ARMY.rawCurrency,true,true),null);
  assert.equal(notFound,1);
  assert.equal(bookFallback,2,'true no-pool response should still permit DEX book inspection');
  console.log('PASS genuine missing AMM is distinguished from overloaded provider');

  let disconnected=0;
  const transport={
    getClient:()=>({request:async()=>{disconnected++;throw new Error('WebSocket is not connected');}}),
    getBookOffers:async()=>{throw new Error('must not request order book while transport unavailable')}
  };
  const another=new AMMPriceFetcher(transport);
  assert.equal(await another.getPrice('ARMY',XRP_ARMY.issuer,XRP_ARMY.rawCurrency,true,true),null);
  assert.equal(await another.getPrice('ARMY',XRP_ARMY.issuer,XRP_ARMY.rawCurrency,true,true),null);
  assert.equal(disconnected,1);
  console.log('PASS disconnected RPC fails closed with bounded retries, not fabricated price');
  console.log('XRPL RPC RATE LIMIT REGRESSION PASSED (OFFLINE)');
}
main().catch(e=>{console.error(e);process.exitCode=1});
