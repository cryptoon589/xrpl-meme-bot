#!/usr/bin/env node
/** Offline, no-network meme-only PAPER entry policy regression. */
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const crypto=require('node:crypto');
const path=require('node:path');
const {paperMemeEntryDecision}=require('../dist/risk/memeEntryUniverse');
const {TradeDecisionEngine}=require('../dist/execution/tradeDecisionEngine');
const {PaperTrader}=require('../dist/paper/paperTrader');

const file=path.resolve('state/paper_meme_entry_allowlist.json');
process.env.BOT_PAPER_MEME_ONLY='1';
process.env.HUNTERIX_MEME_ENTRY_ALLOWLIST_FILE=file;
process.env.HUNTERIX_OPERATOR_MEME_ALLOWLIST_APPROVED_SHA256=
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const issuer='rGG3wQ4kUzd7Jnmk1n5NWPZjjut62kCBfC';
const code='41524D5900000000000000000000000000000000';
const allow=(currency,who=issuer,raw)=>paperMemeEntryDecision(currency,who,raw).allowed;
assert.equal(allow('ARMY',issuer,code),true,'exact approved ARMY issue');
const dropIssuer='rszenFJoDdiGjyezQc8pME9KWDQH43Tswh';
const dropHex='44524F5000000000000000000000000000000000';
assert.equal(allow('DROP',dropIssuer,dropHex),true,'verified XRPL DROP issue');
assert.equal(allow('DRO',dropIssuer,dropHex),true,'truncated display allowed only with exact raw DROP code');
assert.equal(allow('DRO',dropIssuer),false,'DRO display alone is not proof of DROP');
assert.equal(allow('DROP',issuer,dropHex),false,'DROP other issuer must reject');
assert.equal(allow('ARMY',issuer,'41524d5900000000000000000000000000000000'),true,'same code case');
assert.equal(allow('ARMY','rDifferentIssuer',code),false,'same ticker, other issuer');
assert.equal(allow('UNREVIEWED',issuer),false,'unknown XRPL token must not trade');
assert.equal(allow('LOX',issuer),false,'meme branding alone not an issuer approval');
for(const name of ['USDC','RLUSD','URLSD','USDT','USD','DAI','EURC',
                   'BTC','WBTC','ETH','WETH','SOL','WSOL','BNB','PAXG','HBAR','NVIDIA']){
  assert.equal(allow(name,issuer),false,'non-meme rejected: '+name);
}
const usdcHex=Buffer.from('USDC').toString('hex').toUpperCase().padEnd(40,'0');
assert.equal(allow(usdcHex,issuer,usdcHex),false,'hex-encoded stablecoin rejected');
assert.equal(allow('USDC',issuer,code),false,'misleading display symbol rejected');
assert.equal(allow('ARMY',issuer,usdcHex),false,'misleading raw code rejected');
for (const asset of ['HBAR','NVIDIA']){
  const hex=Buffer.from(asset).toString('hex').toUpperCase().padEnd(40,'0');
  assert.equal(allow(asset,issuer,hex),false,
    asset+'-named XRPL meme tag cannot authorize external-asset branded PAPER trade');
  assert.equal(allow('UNRELATED',issuer,hex),false,
    'encoded '+asset+' cannot evade type exclusion via misleading display');
}

const correctHash=process.env.HUNTERIX_OPERATOR_MEME_ALLOWLIST_APPROVED_SHA256;
process.env.HUNTERIX_OPERATOR_MEME_ALLOWLIST_APPROVED_SHA256='0'.repeat(64);
assert.equal(allow('ARMY',issuer,code),false,'tampered/unapproved hash rejected');
process.env.HUNTERIX_OPERATOR_MEME_ALLOWLIST_APPROVED_SHA256=correctHash;
delete process.env.HUNTERIX_MEME_ENTRY_ALLOWLIST_FILE;
assert.equal(allow('ARMY',issuer,code),false,'missing file path fails closed');
process.env.HUNTERIX_MEME_ENTRY_ALLOWLIST_FILE=file;

// All direct PaperTrader PAPER open paths must reject before any sizing,
// database mutation or open-position lookups; exits are unaffected.
const paper=Object.create(PaperTrader.prototype);
paper.config={mode:'PAPER'};
paper.cashReconciled=true;
paper.getPoolXrpReserve=()=>{throw Error('non-meme burst advanced beyond universe guard')};
const forbidden={currency:'USDC',issuer,rawCurrency:'USDC'};
assert.equal(paper.tryOpenBurstTrade(forbidden,null,'test'),null);
assert.equal(paper.tryOpenTrade(forbidden,null,70,'test'),null);

// TDE's PAPER entry path rejects unknown issues before examining price/risk.
const cfg={mode:'PAPER',maxOpenTrades:5,maxDailyLossXRP:30,minTradeXRP:5,
 maxTradeXRP:10,startingBankrollXRP:100,minLiquidityXRP:500};
const tde=new TradeDecisionEngine(cfg);
const snapshot={priceXRP:0.1,liquidityXRP:5000,poolXrpReserve:2500};
(async()=>{
  for(const currency of ['USDC','RLUSD','URLSD','BTC','ETH','SOL','HBAR','NVIDIA','UNREVIEWED']){
    const result=await tde.decide({currency,issuer,rawCurrency:currency,
      snapshot,signalType:'burst',signalScore:70,bankrollXRP:100,
      openPositions:0,dailyPnL:0,openPositionKeys:new Set(),blocklist:new Set()});
    assert.equal(result.outcome,'REJECTED',currency+' TDE must reject');
    assert.match(result.rejectReason,/Meme-only universe/);
  }
  console.log('PASS: exact-issue meme approvals; stablecoin/L1 exclusions; hash fail-closed; TDE PAPER gate');
})().catch(e=>{console.error(e);process.exitCode=1});
