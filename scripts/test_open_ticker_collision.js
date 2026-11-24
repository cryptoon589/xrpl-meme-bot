#!/usr/bin/env node
'use strict';
/** All tests offline. Pure issuer/ticker identity and both PAPER entry methods. */
const assert=require('node:assert/strict');
const {findOpenTickerCollision}=require('../dist/risk/openTickerCollision');
const {PaperTrader}=require('../dist/paper/paperTrader');
const official='rDFXbW2ZZCG5WgPtqwNiA2xZokLMm9ivmN';
const collision='r4xx1QrhivG12aYBizd1k1Mwv9mKic7ssd';
const phnix='50484E4958000000000000000000000000000000';
const other='535741524D000000000000000000000000000000';
const held={tokenCurrency:'PHNIX',tokenIssuer:official,rawCurrency:phnix,remainingPosition:100};
const copy={currency:'PHNIX',rawCurrency:phnix,issuer:collision};

assert.equal(findOpenTickerCollision(copy,[held]),held,
  'different issuer with identical ledger-issued currency must be classified as active ticker collision');
assert.equal(findOpenTickerCollision(
  {currency:'PHNIX',issuer:official,rawCurrency:phnix},[held]),held,
  'identical issued asset must block duplicate position, including alternate encodings');
assert.equal(findOpenTickerCollision(
  {currency:phnix,issuer:official,rawCurrency:phnix},[held]),held,
  'raw-hex versus human PHNIX alias cannot create a second open position');
assert.equal(findOpenTickerCollision(
  {currency:'SWARM',issuer:collision,rawCurrency:other},[held]),null,
  'independent ticker not blocked');
assert.equal(findOpenTickerCollision(copy,[{...held,remainingPosition:0}]),null,
  'fully closed position should not restrict a later same-name token');
assert.equal(findOpenTickerCollision(
  {currency:'PHNIX',issuer:collision},[held]),held,
  'encoded ticker and plain display alias still collide');
assert.equal(findOpenTickerCollision(
  {currency:'XRP',issuer:collision},[held]),null,
  'native XRP does not gain a derived issued identity');

const prev={
  MODE:process.env.MODE,
  BOT_PAPER_MEME_DISCOVERY:process.env.BOT_PAPER_MEME_DISCOVERY,
  BOT_PAPER_MEME_ONLY:process.env.BOT_PAPER_MEME_ONLY
};
try{
  process.env.MODE='PAPER';
  process.env.BOT_PAPER_MEME_DISCOVERY='1';
  process.env.BOT_PAPER_MEME_ONLY='0';
  // Object.create invokes class methods directly and avoids touching SQLite,
  // AMM, wallet, Telegram or real broker; both entry paths return at guard.
  const trader=Object.create(PaperTrader.prototype);
  trader.config={mode:'PAPER',maxOpenTrades:5};
  trader.cashReconciled=true;
  trader.openPositions=new Map([
    ['PHNIX:'+official,{trade:held,remainingPercent:100}]
  ]);
  assert.equal(trader.tryOpenBurstTrade(copy,null,'offline fixture'),null,
    'burst entry must reject the concurrent same-ticker different-issuer exposure');
  assert.equal(trader.tryOpenTrade(copy,null,70,'offline fixture'),null,
    'scored/stream entry must reject the same concurrent same-ticker exposure');
  assert.equal(trader.tryOpenBurstTrade({currency:phnix,issuer:official,rawCurrency:phnix},null,'offline fixture'),null,
    'burst must reject same issuer even if only hex/display representation differs');
  assert.equal(trader.tryOpenTrade({currency:phnix,issuer:official,rawCurrency:phnix},null,70,'offline fixture'),null,
    'scored must reject same issuer even if only hex/display representation differs');
  // Exits and existing trade rows are never mutated by either check.
  assert.equal(trader.openPositions.size,1);
  assert.equal(held.remainingPosition,100);
  console.log('PASS exact-issued ticker collision detection; both PAPER entry paths reject duplicate-name exposure while keeping existing inventory');
}finally{
  for(const [key,value] of Object.entries(prev)){
    if(value===undefined)delete process.env[key];else process.env[key]=value;
  }
}
