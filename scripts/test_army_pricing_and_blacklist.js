#!/usr/bin/env node
/**
 * XRP ARMY exact-issuer AMM pricing & user blacklist integration regression.
 * All observations are synthetic; no XRPL calls, trading, or DB writes.
 */
const assert=require('node:assert/strict');
const path=require('node:path');
const {XRP_ARMY,PRIORITY_MONITORED_ISSUES,priorityTrackedToken}=
  require('../dist/market/priorityIssues');
const {normalizeIssuedCurrency}=require('../dist/xrpl/currencyCode');
const {parseXrpIssuedAmm}=require('../dist/market/parseIssuedAmm');
const {AMMPriceFetcher}=require('../dist/market/ammPriceFetcher');
const {BurstDetector}=require('../dist/scanner/burstDetector');
const {TokenDiscovery}=require('../dist/scanner/tokenDiscovery');
const {OperatorBlacklist}=require('../dist/risk/operatorBlacklist');

const official={
  amount:'20000000000', // 20,000 XRP in drops
  amount2:{currency:XRP_ARMY.rawCurrency,issuer:XRP_ARMY.issuer,value:'4000000'},
  trading_fee:500, // 0.5% (1/100000 units)
  account:'rMockAMMPoolAccount'
};
const approx=(a,b,e=1e-10)=>assert.ok(Math.abs(a-b)<e,String(a)+' != '+String(b));
const parsed=parseXrpIssuedAmm(official,XRP_ARMY.rawCurrency,XRP_ARMY.issuer);
assert.ok(parsed);
approx(parsed.priceXRP,.005);
approx(parsed.poolXRP,20000);
assert.equal(parsed.tradingFeeUnits,500);
assert.equal(normalizeIssuedCurrency('ARMY'),XRP_ARMY.rawCurrency);
assert.equal(PRIORITY_MONITORED_ISSUES.length,1);
assert.equal(XRP_ARMY.issuer,'rGG3wQ4kUzd7Jnmk1n5NWPZjjut62kCBfC');

const reversed={amount:official.amount2,amount2:official.amount,trading_fee:500};
approx(parseXrpIssuedAmm(reversed,XRP_ARMY.rawCurrency,XRP_ARMY.issuer).priceXRP,.005);
for(const [caseNo,bad] of [
 {...official,amount2:{...official.amount2,issuer:'rDifferentIssuer'}},
 {...official,amount2:{...official.amount2,currency:'41524d5800000000000000000000000000000000'}},
 {...official,amount:'NaN'},
 {...official,amount2:{...official.amount2,value:'0'}},
 {...official,amount2_frozen:true},
 {...reversed,asset_frozen:true},
 {...official,trading_fee:1001},
 {...official,trading_fee:-1},
].entries()) assert.equal(parseXrpIssuedAmm(bad,XRP_ARMY.rawCurrency,XRP_ARMY.issuer),null,'invalid AMM case '+caseNo);

const blacklist=OperatorBlacklist.load(path.resolve('state/manual_token_blacklist.json'));
assert.deepEqual(blacklist.list().map(t=>t.currency).sort(),['CORE','MXI','OCT','SHX']);
assert.equal(blacklist.list().length,4,'no inferred/permanent auto exclusions');
for(const t of ['ARMY','LOVE','XSPECTAR','XOGE','XRDOGE','BEAR','BULL','FURY'])
  assert.equal(blacklist.isBlocked(t,XRP_ARMY.issuer),false,t+' must not be permanently blacklisted');
for(const t of ['CORE','MXI','OCT','SHX'])
  assert.equal(blacklist.isBlocked(t,'rAnyOtherIssuer'),true);
assert.equal(blacklist.isBlocked('ARMY',XRP_ARMY.issuer,XRP_ARMY.rawCurrency),false);
console.log('PASS exact four user-confirmed permanent exclusions, ARMY/LOVE permitted with risk checks');

async function main(){
  const observations=[];
  let current=official;
  const xrpl={
    getClient:()=>({request:async req=>{
      observations.push(req);
      if(req.command!=='amm_info')throw Error('Unexpected request');
      return {result:{amm:current}};
    }}),
    getBookOffers:async()=>({offers:[]})
  };
  const fetcher=new AMMPriceFetcher(xrpl);
  const got=await fetcher.getPrice('ARMY',XRP_ARMY.issuer,'ARMY',true,true);
  assert.ok(got&&got.source==='amm');
  approx(got.priceXRP,.005);
  assert.equal(got.poolXRP,20000);
  assert.equal(got.poolTokens,4000000);
  assert.equal(got.tradingFee,500);
  assert.ok(Number.isFinite(got.observedAtMs));
  assert.equal(observations[0].asset.currency,'XRP');
  assert.deepEqual(observations[0].asset2,{currency:XRP_ARMY.rawCurrency,issuer:XRP_ARMY.issuer});
  assert.equal(observations[0].ledger_index,'validated');
  const same=await fetcher.getPrice('ARMY',XRP_ARMY.issuer,XRP_ARMY.rawCurrency,true,true);
  approx(same.priceXRP,.005);
  current={...official,amount2:{...official.amount2,issuer:'rDifferentIssuer'}};
  assert.equal(await fetcher.getPrice('ARMY',XRP_ARMY.issuer,XRP_ARMY.rawCurrency,true,true),null);
  current=official;
  assert.ok(await fetcher.getPrice('ARMY',XRP_ARMY.issuer,XRP_ARMY.rawCurrency,true,true));
  assert.equal(await fetcher.getPrice('ARMY','rAnotherSameTickerIssuer',XRP_ARMY.rawCurrency,true,true),null);
  console.log('PASS ARMY hex normalization, exact issuer AMM lookup, recovery from null, no cross-issuer price leakage');

  const burst=new BurstDetector(xrpl,{sendAlert:async()=>true},{getTrackedTokens:()=>[]});
  const burstPrice=await burst.fetchAMMInfo(XRP_ARMY.rawCurrency,XRP_ARMY.issuer);
  assert.ok(burstPrice);
  approx(burstPrice.priceXRP,got.priceXRP);
  assert.equal(burstPrice.tradingFeeUnits,500);
  assert.ok(observations.at(-1).ledger_index==='validated');
  console.log('PASS burst and normal scanning calculate same ARMY XRP price');

  const saved=[];
  const old={currency:'ARMY',issuer:XRP_ARMY.issuer,
    rawCurrency:'ARMY',firstSeen:12345,lastUpdated:12345};
  const mockDb={
    getTrackedTokens:()=>[old],saveToken:t=>saved.push({...t})
  };
  const td=new TokenDiscovery(xrpl,mockDb);
  await td.initialize();
  assert.equal(td.addTrackedToken(priorityTrackedToken(XRP_ARMY)),false);
  assert.equal(td.getTrackedTokens().length,1,'do not create duplicate ARMY issue on repair');
  assert.equal(td.getTrackedTokens()[0].rawCurrency,XRP_ARMY.rawCurrency);
  assert.equal(saved[0].rawCurrency,XRP_ARMY.rawCurrency);
  const again=td.addTrackedToken({...priorityTrackedToken(XRP_ARMY),rawCurrency:'4141414100000000000000000000000000000000'});
  assert.equal(again,false,'do not blindly overwrite one valid code with another');
  assert.equal(td.getTrackedTokens()[0].rawCurrency,XRP_ARMY.rawCurrency);
  console.log('PASS older ARMY ticker-only records upgraded to correct exact raw issue before AMM preload');
  console.log('ARMY PRICING + USER BLACKLIST TESTS PASSED (MOCKS ONLY)');
}
main().catch(e=>{console.error(e);process.exitCode=1});
