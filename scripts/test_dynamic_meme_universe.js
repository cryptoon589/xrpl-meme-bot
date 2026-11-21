#!/usr/bin/env node
/** Synthetic-only regression. No remote API, XRPL RPC, Telegram, or DB writes. */
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {DynamicMemeUniverse,canonicalIssue,dynamicMemeUniverse}=
  require('../dist/risk/dynamicMemeUniverse');
const {MemeCategoryFeed,setActiveMemeCategoryFeed}=
  require('../dist/market/memeCategoryFeed');
const {selectDynamicScanTokens}=
  require('../dist/scanner/dynamicMemeScheduler');
const {paperMemeEntryDecision}=require('../dist/risk/memeEntryUniverse');

const issuer='rGG3wQ4kUzd7Jnmk1n5NWPZjjut62kCBfC';
const other='rszenFJoDdiGjyezQc8pME9KWDQH43Tswh';
const newHex='4E45574D454D4500000000000000000000000000'; // NEWMEME
const oldHex='4F4C444D454D4500000000000000000000000000'; // OLDMEME
const code='41524D5900000000000000000000000000000000';
const usdc='5553444300000000000000000000000000000000';
let clock=Date.now();
process.env.BOT_PAPER_MEME_ONLY='1';
process.env.BOT_PAPER_MEME_DISCOVERY='1';
const reviewed=path.resolve('state/paper_meme_entry_allowlist.json');
process.env.HUNTERIX_MEME_ENTRY_ALLOWLIST_FILE=reviewed;
process.env.HUNTERIX_OPERATOR_MEME_ALLOWLIST_APPROVED_SHA256=
  crypto.createHash('sha256').update(fs.readFileSync(reviewed)).digest('hex');
const tagged=(currency,who=issuer,tags=['Memes'])=>
  ({currency,issuer:who,tags,tokenType:'trustline',dateon:clock-1000});

async function run() {
  const local=new DynamicMemeUniverse();
  const tokens=[
    tagged(newHex),tagged(oldHex),
    tagged(usdc,issuer,['Memes','Stablecoin']),
    tagged('534F4C4F00000000000000000000000000000000',issuer,['Utility','Memes']),
    tagged(newHex,other,['RWA']),
    {...tagged('5350414D00000000000000000000000000000000'),tokenType:'lp'},
    {...tagged('4E4F544D454D45000000000000000000000000'),tags:['Trending']},
    {...tagged('4141414100000000000000000000000000000000'),issuer:'not-an-issuer'}
  ];
  assert.deepEqual(local.acceptTaggedPage(tokens,clock),{accepted:2,rejected:6});
  assert(local.hasIssue('NEWMEME',issuer,newHex,clock+1000));
  assert(!local.hasIssue('NEWMEME',other,newHex,clock+1000));
  assert(!local.hasIssue('NEWMEME',issuer,newHex,clock+46*60*1000));
  assert.equal(canonicalIssue('NEWMEME',issuer),null,
    'display name cannot substitute for original ledger issue');
  assert.equal(canonicalIssue(newHex,issuer),newHex+':'+issuer);
  local.acceptTaggedPage([tagged(newHex,issuer,['Memes','RWA'])],clock+2000);
  assert.equal(local.hasIssue('NEWMEME',issuer,newHex,clock+3000),false,
    'a later explicit negative category revokes prior meme evidence');

  // End-to-end: documented tagged-list response, issuer identity, TTL and
  // on-demand token lookup. Both 3-character and 40-hex XRPL codes supported.
  const calls=[];
  const getBody=url=>{
    const u=new URL(url);
    calls.push(u.toString());
    if(u.pathname.endsWith('/tokens')) return {
      success:true,tagName:'Memes',tokens:[tagged(newHex),tagged(oldHex),tagged(usdc,issuer,['Memes','Stablecoin'])]
    };
    if(u.pathname.includes('/token/')) return {
      success:true,token:tagged('4C41544500000000000000000000000000000000')
    };
    throw Error('unexpected test endpoint');
  };
  const fetcher=async url=>{
    const obj=getBody(url);
    return {ok:true,headers:{get:()=>''},text:async()=>JSON.stringify(obj)};
  };
  const emitted=[];
  const feed=new MemeCategoryFeed(issue=>emitted.push(issue),fetcher,()=>clock);
  await feed.refresh();
  assert.equal(calls.length,3,'three bounded category pages per refresh');
  assert(dynamicMemeUniverse.hasIssue('NEWMEME',issuer,newHex,clock));
  assert(emitted.some(t=>t.currency===newHex));
  assert.equal(paperMemeEntryDecision('NEWMEME',issuer,newHex).allowed,true);
  assert.equal(paperMemeEntryDecision('NEWMEME',other,newHex).allowed,false);
  assert.equal(paperMemeEntryDecision('USDC',issuer,usdc).allowed,false,
    'metadata never overrides non-meme symbol ban');
  assert.equal(paperMemeEntryDecision('SOLO',issuer,'534F4C4F00000000000000000000000000000000').allowed,
    false,'conflicting metadata excludes utility asset');
  const solo='534F4C4F00000000000000000000000000000000';
  const knownSoloIssuer='rsoLo2S1kiGeCcn6hCUXVrCpGMWLrRrLZz';
  dynamicMemeUniverse.acceptTaggedPage([tagged(solo,knownSoloIssuer)],clock);
  assert.equal(paperMemeEntryDecision('SOLO',knownSoloIssuer,solo).allowed,false,
    'known conventional issue cannot be authorized by a false meme tag');

  const late='4C41544500000000000000000000000000000000';
  assert.equal(await feed.ensureIssue('LATE',issuer,late),true);
  const afterOne=calls.length;
  assert.equal(await feed.ensureIssue('LATE',issuer,late),true);
  assert.equal(calls.length,afterOne,'verified issue cached; no duplicate provider calls');

  const unknown='554E4B4E4F574E00000000000000000000000000';
  assert.equal(await feed.ensureIssue('UNKNOWN',issuer,unknown),false,
    'request throttling is fail-closed');

  clock+=46*60*1000;
  assert.equal(dynamicMemeUniverse.hasIssue('NEWMEME',issuer,newHex,clock),false,
    'provider evidence expires without refreshed metadata');
  // Tests never enable the external network when metadata API is unavailable.

  const catalog=[];
  const allow=new Set();
  for(let i=0;i<450;i++){
    // unique 160-bit codes with canonical issuer; varied age/activity.
    const symbol='M'+i.toString().padStart(4,'0');
    const hex=Buffer.from(symbol).toString('hex').toUpperCase().padEnd(40,'0');
    const now=clock;
    catalog.push({
      currency:symbol,rawCurrency:hex,issuer,
      firstSeen:now-(i%3===0?2:10)*24*3600000,
      lastUpdated:now-(i%5)*24*3600000
    });
    allow.add(canonicalIssue(hex,issuer));
  }
  const inventoryKey=canonicalIssue(catalog[449].rawCurrency,issuer);
  const holdings=new Set([inventoryKey]);
  const q1=selectDynamicScanTokens(catalog,allow,holdings,1,300,clock);
  const q2=selectDynamicScanTokens(catalog,allow,holdings,2,300,clock);
  assert(q1.length<=300 && q2.length<=300);
  assert(q1.some(x=>x.rawCurrency===catalog[449].rawCurrency),'open inventory never starved');
  assert(q1.some(x=>clock-x.firstSeen<7*24*3600000),'new launch cohort covered');
  assert(q1.some(x=>clock-x.firstSeen>=7*24*3600000),'older revival cohort covered');
  const union=new Set([...q1,...q2].map(x=>x.rawCurrency));
  assert(union.size>300,'rotating cohorts go beyond static 300-token slice');
  assert.equal(selectDynamicScanTokens(catalog,new Set(),holdings,3,300,clock).length,1,
    'no unclassified issue enters an RPC-heavy scan absent an open position');

  setActiveMemeCategoryFeed(null);
  console.log('PASS dynamic meme category ingestion, expiry, exact issue, non-meme conflicts, bounded on-demand API, moving scan cohorts');
}

run().catch(e=>{setActiveMemeCategoryFeed(null);console.error(e);process.exitCode=1});
