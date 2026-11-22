#!/usr/bin/env node
/** Offline new-wallet breadth regression: no XRPL, SQLite, PM2 or trades. */
'use strict';
const assert=require('node:assert/strict');
const {BuyPressureTracker}=require('../dist/market/buyPressureTracker');
const ticker='TEST', issuer='rSyntheticIssuer';
const key=()=>new BuyPressureTracker();
const oldNow=Date.now;
let clock=1800000000000;
Date.now=()=>clock;
const advance=ms=>{clock+=ms;};
try {
  const tracker=key();
  // Event-scoped "new" means first tracked token participation, not merely
  // absence from the last five minutes of in-memory events.
  tracker.recordTrade(ticker+':'+issuer,'rBuyerA','buy',10);
  tracker.recordTrade(ticker+':'+issuer,'rBuyerA','buy',20);
  let snap=tracker.getSnapshot(ticker,issuer);
  assert.equal(snap.buyCount,2);
  assert.equal(snap.uniqueBuyers,1);
  assert.equal(snap.newWalletBuys,1,'repeat buys in same window count only once');
  advance(5*60*1000+1);
  tracker.recordTrade(ticker+':'+issuer,'rBuyerA','buy',10);
  snap=tracker.getSnapshot(ticker,issuer);
  assert.equal(snap.uniqueBuyers,1);
  assert.equal(snap.newWalletBuys,0,'returning buyer is not new after pruning');
  assert.equal(snap.newWalletPercent,0);
  tracker.recordTrade(ticker+':'+issuer,'rBuyerB','buy',5);
  snap=tracker.getSnapshot(ticker,issuer);
  assert.equal(snap.newWalletBuys,1,'genuinely new buyer still counted');
  assert.equal(snap.newWalletPercent,50);
  tracker.recordTrade(ticker+':'+issuer,'rSellerFirst','sell',2);
  tracker.recordTrade(ticker+':'+issuer,'rSellerFirst','buy',3);
  snap=tracker.getSnapshot(ticker,issuer);
  assert.equal(snap.uniqueBuyers,3);
  assert.equal(snap.newWalletBuys,1,
    'wallet previously seen selling cannot masquerade as new buying');
  tracker.clear(ticker,issuer);
  tracker.recordTrade(ticker+':'+issuer,'rBuyerB','buy',1);
  assert.equal(tracker.getSnapshot(ticker,issuer).newWalletBuys,0,
    'cleared short-term activity retains historical wallet identity');

  const full=key();
  for(let i=0;i<500;i++){
    full.recordTrade(ticker+':'+issuer,'rCap'+i,'buy',1);
  }
  assert.equal(full.getSnapshot(ticker,issuer).newWalletBuys,500);
  full.recordTrade(ticker+':'+issuer,'rUnverified501','buy',1);
  assert.equal(full.getSnapshot(ticker,issuer).newWalletBuys,500,
    'full lifetime wallet history must not label unverified addresses as new');
  assert.equal(full.getSnapshot(ticker,issuer).uniqueBuyers,501,
    'buyer breadth count stays separate from first-time buyer count');

  console.log('PASS five-minute returning wallet, repeat buys, sell-first wallet, clear and wallet-cap fail-closed new-buyer accounting');
} finally {
  Date.now=oldNow;
}
