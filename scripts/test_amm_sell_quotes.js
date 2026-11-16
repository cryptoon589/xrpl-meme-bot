#!/usr/bin/env node
/** Deterministic reserve quote regression, no network, wallets, Telegram or DB. */
const assert=require('node:assert/strict');
const {estimateAmmBuy,estimateAmmSell}=require('../dist/paper/ammExecutionQuote');
const eq=(a,b,tol=1e-8)=>assert.ok(Math.abs(a-b)<tol,String(a)+' != '+String(b));

const ideal=estimateAmmSell(500,1000,1000,0);
eq(ideal.spotValue,500);
eq(ideal.amountOut,1000*500/1500);
eq(ideal.priceImpactPct,100*(1-2/3));
assert.ok(ideal.priceImpactPct>30,'must never impose the legacy 10% slippage cap');

const fee=estimateAmmSell(500,1000,1000,100);
assert.ok(fee.amountOut<ideal.amountOut);
eq(fee.feeRate,0.001);
assert.ok(fee.priceImpactPct>ideal.priceImpactPct);
const drained=estimateAmmSell(1000,1000,2,0);
eq(drained.amountOut,1);
assert.ok(drained.priceImpactPct>49.9);
assert.ok(estimateAmmSell(1e9,1000,2,500).amountOut<2,
          'AMM can never pay out more than its XRP reserve');

const buy=estimateAmmBuy(500,1000,1000,0);
eq(buy.amountOut,1000/3);
eq(buy.spotValue,500);
const buyFee=estimateAmmBuy(500,1000,1000,1000);
assert.ok(buyFee.amountOut<buy.amountOut);
assert.equal(buyFee.feeRate,0.01);

for(const args of [
  [100,0,1000,0],[-1,1000,1000,0],
  [100,1000,0,0],[100,1000,1000,1001],
  [100,1000,1000,-1],[NaN,1000,1000,0],
]) assert.equal(estimateAmmSell(...args),null);
assert.equal(estimateAmmBuy(0,1000,1000,0),null);
console.log('PASS full-size AMM buy/sell curve, XRP Ledger fee units, liquidity-drain tail losses and invalid reserve guards');
console.log('NOTE: quote is an indicative AMM reserve estimate, NOT an executable swap, routed DEX fill or verified net P&L');
