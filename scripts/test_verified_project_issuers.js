#!/usr/bin/env node
/** Offline regressions: first-party issuer evidence vs misleading category/ticker. */
'use strict';
const assert=require('node:assert/strict');
const {decideVerifiedProjectIssuer,REVIEWED_PROJECT_ISSUERS}=
  require('../dist/risk/verifiedProjectIssuers');
const {PaperTrader}=require('../dist/paper/paperTrader');
const official='rDFXbW2ZZCG5WgPtqwNiA2xZokLMm9ivmN';
const unknown='r4xx1QrhivG12aYBizd1k1Mwv9mKic7ssd';
const raw='50484E4958000000000000000000000000000000';
const alternate='50484E4958000000000000000000000000000001';

assert.equal(REVIEWED_PROJECT_ISSUERS.length,1,
  'start with a small source-backed protected project registry, never a global meme whitelist');
assert.equal(REVIEWED_PROJECT_ISSUERS[0].issuerSource,'https://phnix.io/');
assert.equal(REVIEWED_PROJECT_ISSUERS[0].issuer,official);
assert.equal(REVIEWED_PROJECT_ISSUERS[0].currency,raw);

const authentic=decideVerifiedProjectIssuer('PHNIX',official,raw);
assert.deepEqual(authentic,{allowed:true,status:'issuer_confirmed'});
assert.equal(decideVerifiedProjectIssuer('PHNIX',unknown,raw).status,'issuer_mismatch',
  'Memes category or same token symbol is NOT evidence that issuer is official');
assert.equal(decideVerifiedProjectIssuer(raw,unknown,raw).status,'issuer_mismatch',
  'hex-encoded copy must also be blocked');
assert.equal(decideVerifiedProjectIssuer('PHNIX',official,alternate).status,'issuer_mismatch',
  'right issuer but altered currency is not the reviewed asset');
assert.equal(decideVerifiedProjectIssuer('PHNIX',official).status,'issuer_confirmed',
  'canonical plain name resolves to reviewed 160-bit code');
assert.equal(decideVerifiedProjectIssuer('PHNIX',unknown).status,'issuer_mismatch',
  'decoded currency without supplied raw currency remains issuer-protected');
for(const ticker of ['SWARM','FUZZY','$FLR','SOMENEWMEME','XRPBR']) {
  assert.deepEqual(decideVerifiedProjectIssuer(ticker,unknown),
    {allowed:true,status:'not_protected'},
    'the registry protects names; it must not block unrelated meme discovery');
}

const prev={
  MODE:process.env.MODE,
  BOT_PAPER_MEME_DISCOVERY:process.env.BOT_PAPER_MEME_DISCOVERY,
  BOT_PAPER_MEME_ONLY:process.env.BOT_PAPER_MEME_ONLY,
};
try {
  process.env.MODE='PAPER';
  process.env.BOT_PAPER_MEME_DISCOVERY='1';
  process.env.BOT_PAPER_MEME_ONLY='0';
  const trader=Object.create(PaperTrader.prototype);
  trader.config={mode:'PAPER',maxOpenTrades:5};
  trader.cashReconciled=true;
  trader.openPositions=new Map();
  const fake={currency:'PHNIX',issuer:unknown,rawCurrency:raw};
  assert.equal(trader.tryOpenBurstTrade(fake,null,'offline test'),null);
  assert.equal(trader.tryOpenTrade(fake,null,75,'offline test'),null);
  assert.equal(trader.openPositions.size,0,
    'protection is an entry-only guard; it does not alter inventory');
  // No live XRPL, wallet, metadata-provider or SQLite calls occurred.
  console.log('PASS verified official PHNIX issue, reject same-name alternate issuers in BOTH PAPER paths, unrelated meme discovery remains unrestricted');
}finally{
  for(const [key,value] of Object.entries(prev)){
    if(value===undefined)delete process.env[key];else process.env[key]=value;
  }
}
