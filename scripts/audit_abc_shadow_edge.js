#!/usr/bin/env node
/**
 * HUNTERIX observation-only A/B/C forward cohort experiment.
 *
 * A: 5 XRP, same validated signal/scanner timestamp plus basic AMM-depth and
 *    round-trip cost gates. This is NOT a replay of all deployed TDE rules.
 * B: same size and opportunity universe, add PRE-ENTRY buy breadth, buy/sell
 *    dominance and modest rising momentum (no future features).
 * C: same B selections, adapt size to 1/2/5 XRP using PRE-ENTRY depth/breadth.
 *
 * ALL THREE use identical issuer-exact source/exit timestamps and constant-
 * product AMM quote ESTIMATES from separately recorded complete XRP/token
 * reserves. They are NOT fillable orders, actual PAPER executions, and
 * cannot establish profitability. Untagged assets are excluded by default,
 * and even tagged assets still require live issuer/blacklist/risk checks.
 *
 * There is NO database write, outbound request, process/config change, or
 * alteration to HUNTERIX signal and execution decisions.
 */
'use strict';
const fs=require('node:fs');
const Database=require('better-sqlite3');
const {estimateAmmBuy,estimateAmmSell}=require('../dist/paper/ammExecutionQuote');
const {decodeIssuedCurrencyName}=require('../dist/xrpl/currencyCode');

const RESERVE_MAX_AGE_MS=90_000;
const FEATURE_MAX_AGE_MS=120_000;
const EXIT_WINDOW_MS=5*60_000;
const COOLDOWN_MS=70*60_000;
const TAG_TTL_MS=45*60_000;
const HORIZONS=[10,30,60];
const SOURCES=['burst_seen','momentum_seen'];
const SAMPLE_DISPLAY_LIMIT=12;

function readOptions(args) {
  if(!args[0] || args[0].startsWith('--'))
    throw Error('Usage: node scripts/audit_abc_shadow_edge.js <epoch.db> [--hours=72] [--limit=2000] [--cohort=signals|scans] [--include-untagged]');
  const out={path:args[0],hours:72,limit:2000,cohort:'signals',includeUntagged:false};
  for(const arg of args.slice(1)){
    if(arg.startsWith('--hours='))out.hours=Number(arg.slice(8));
    else if(arg.startsWith('--limit='))out.limit=Number(arg.slice(8));
    else if(arg.startsWith('--cohort='))out.cohort=arg.slice(9);
    else if(arg==='--include-untagged')out.includeUntagged=true;
    else throw Error('Unknown argument '+arg);
  }
  if(!Number.isInteger(out.hours)||out.hours<2||out.hours>168 ||
     !Number.isInteger(out.limit)||out.limit<1||out.limit>10000 ||
     !['signals','scans'].includes(out.cohort))
    throw Error('hours=2..168, limit=1..10000, cohort=signals|scans');
  return out;
}
function availableTable(db,name){
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}
function printable(raw,fallback){
  return decodeIssuedCurrencyName(raw) || fallback || raw;
}
function finitePositive(x){return typeof x==='number'&&Number.isFinite(x)&&x>0;}
function safeAliases(db,raw,issuer,hasTokens){
  const aliases=new Set([raw]);
  if(!hasTokens)return [...aliases];
  const records=db.prepare('SELECT currency,raw_currency FROM tokens WHERE issuer=?').all(issuer);
  const entries=records.filter(r=>r.raw_currency===raw);
  for(const r of entries){
    if(!records.some(other=>other.currency===r.currency &&
       other.raw_currency && other.raw_currency!==raw))
      aliases.add(r.currency);
  }
  return [...aliases];
}
function selectFeature(db,aliases,issuer,anchor,mode,quoteTime){
  if(!aliases.length)return null;
  const placeholders=aliases.map(()=>'?').join(',');
  if(mode==='scans'){
    return db.prepare(
      'SELECT * FROM market_snapshots WHERE token_issuer=? AND token_currency IN ('+
      placeholders+') AND timestamp>=? AND timestamp<=? ORDER BY timestamp ASC LIMIT 1'
    ).get(issuer,...aliases,quoteTime,quoteTime+RESERVE_MAX_AGE_MS) || null;
  }
  return db.prepare(
    'SELECT * FROM market_snapshots WHERE token_issuer=? AND token_currency IN ('+
    placeholders+') AND timestamp<=? AND timestamp>=? ORDER BY timestamp DESC LIMIT 1'
  ).get(issuer,...aliases,anchor,anchor-FEATURE_MAX_AGE_MS) || null;
}
function validReserve(r){return Boolean(r && r.source==='amm' &&
  finitePositive(r.pool_xrp_reserve)&&finitePositive(r.pool_token_reserve)&&
  Number.isInteger(r.trading_fee_units)&&r.trading_fee_units>=0&&r.trading_fee_units<=1000);}
function getBuy(xrp,entry){
  if(!validReserve(entry)||!finitePositive(xrp))return null;
  return estimateAmmBuy(xrp,entry.pool_xrp_reserve,
    entry.pool_token_reserve,entry.trading_fee_units);
}
function scenario(size,entry,exit){
  const buy=getBuy(size,entry);
  if(!buy||!validReserve(exit))return null;
  const sell=estimateAmmSell(buy.amountOut,exit.pool_token_reserve,
    exit.pool_xrp_reserve,exit.trading_fee_units);
  if(!sell)return null;
  const proceeds=sell.amountOut*(1-0.003);
  const cost=size*(1+0.003);
  return {
    sizeXRP:size,pnlXRP:proceeds-cost,returnPct:(proceeds/cost-1)*100,
    buyImpactPct:buy.priceImpactPct,sellImpactPct:sell.priceImpactPct,
  };
}
function entryGate(entry) {
  // Minimal comparator-only AMM safety gate, NOT the deployed TDE.
  if(!validReserve(entry)||entry.pool_xrp_reserve<500)
    return {ok:false,reason:'reserve_under_500_or_invalid'};
  const buy=getBuy(5,entry);
  if(!buy||buy.priceImpactPct>4)
    return {ok:false,reason:'entry_impact_over_4_or_invalid'};
  const after={
    pool_xrp_reserve:entry.pool_xrp_reserve+5,
    pool_token_reserve:entry.pool_token_reserve-buy.amountOut,
    trading_fee_units:entry.trading_fee_units,source:'amm'
  };
  const sell=estimateAmmSell(buy.amountOut,after.pool_token_reserve,
    after.pool_xrp_reserve,after.trading_fee_units);
  if(!sell)return {ok:false,reason:'round_trip_unquotable'};
  const immediateLoss=100*(1-(sell.amountOut*(1-0.003))/(5*(1+0.003)));
  if(immediateLoss>12)return {ok:false,reason:'round_trip_over_12'};
  return {ok:true,reason:'proxy_gate_only'};
}
function featureDecision(s) {
  // Predeclared research heuristic, not trained/optimized on future outcomes.
  if(!s)return {ok:false,reason:'missing_pre_entry_features'};
  const values=[
    s.price_change_5m,s.price_change_15m,
    s.buy_count_5m,s.unique_buyers_5m,
    s.buy_volume_5m,s.sell_volume_5m
  ];
  if(values.some(v=>typeof v!=='number'||!Number.isFinite(v)) ||
     s.buy_count_5m<0 || s.unique_buyers_5m<0 ||
     s.buy_volume_5m<0 || s.sell_volume_5m<0)
    return {ok:false,reason:'missing_pre_entry_features'};
  if(s.price_change_5m<1 || s.price_change_5m>20 ||
     s.price_change_15m<0 || s.price_change_15m>60)
    return {ok:false,reason:'weak_or_late_5m_momentum'};
  if(s.buy_count_5m<3||s.unique_buyers_5m<3||
     s.buy_volume_5m<5||s.buy_volume_5m<1.5*Math.max(1,s.sell_volume_5m))
    return {ok:false,reason:'insufficient_breadth_or_buy_pressure'};
  return {ok:true,reason:'confirmed_breadth_plus_momentum'};
}
function adaptiveSize(entry,s) {
  const buys=s.buy_volume_5m, sells=Math.max(1,s.sell_volume_5m);
  if(entry.pool_xrp_reserve>=3000 && s.unique_buyers_5m>=5 &&
    s.buy_count_5m>=6 && buys/sells>=2.5 && s.price_change_5m<=12)
    return 5;
  if(entry.pool_xrp_reserve>=900 && s.unique_buyers_5m>=3)
    return 2;
  return 1;
}
function taggedBefore(db,raw,issuer,time){
  return Boolean(db.prepare(
    "SELECT 1 FROM paper_opportunity_events WHERE raw_currency=? AND token_issuer=? "+
    "AND event_type='meme_evidence_refreshed' AND observed_at BETWEEN ? AND ? "+
    "ORDER BY observed_at DESC LIMIT 1"
  ).get(raw,issuer,time-TAG_TTL_MS,time));
}
function makeCandidates(db,options,now=Date.now()){
  const counters={};
  const bump=x=>{counters[x]=(counters[x]||0)+1;};
  const requirements=['paper_amm_reserve_evidence','market_snapshots','paper_opportunity_events'];
  for(const t of requirements)if(!availableTable(db,t))
    return {candidates:[],counters:{['missing_table_'+t]:1},fatal:true};
  const hasTokens=availableTable(db,'tokens');
  const since=now-options.hours*3600000;
  const samples=options.cohort==='scans'
    ?db.prepare('SELECT raw_currency,token_issuer,token_currency,observed_at FROM paper_amm_reserve_evidence WHERE observed_at>=? ORDER BY observed_at ASC LIMIT ?').all(since,options.limit)
    :db.prepare(
      "SELECT raw_currency,token_issuer,token_currency,observed_at,event_type "+
      "FROM paper_opportunity_events WHERE event_type IN ('burst_seen','momentum_seen') "+
      "AND observed_at>=? ORDER BY observed_at ASC LIMIT ?"
    ).all(since,options.limit);
  const prior=new Map(),aliasesCache=new Map(),candidates=[];
  const reserveBefore=db.prepare('SELECT * FROM paper_amm_reserve_evidence '+
     'WHERE raw_currency=? AND token_issuer=? AND observed_at<=? AND observed_at>=? '+
     'ORDER BY observed_at DESC LIMIT 1');
  const reserveExactly=db.prepare('SELECT * FROM paper_amm_reserve_evidence '+
     'WHERE raw_currency=? AND token_issuer=? AND observed_at=? LIMIT 1');
  for(const sample of samples){
    bump('observed_anchors');
    const raw=sample.raw_currency,issuer=sample.token_issuer;
    if(!raw||!issuer){bump('invalid_identity');continue;}
    const key=raw+':'+issuer;
    if(prior.has(key)&&sample.observed_at-prior.get(key)<COOLDOWN_MS){
      bump('cooldown_duplicate');continue;
    }
    const quote=options.cohort==='scans'
      ?reserveExactly.get(raw,issuer,sample.observed_at)
      :reserveBefore.get(raw,issuer,sample.observed_at,
         sample.observed_at-RESERVE_MAX_AGE_MS);
    if(!validReserve(quote)){bump('no_contemporaneous_full_reserve');continue;}
    const aliasKey=key;
    if(!aliasesCache.has(aliasKey))
      aliasesCache.set(aliasKey,safeAliases(db,raw,issuer,hasTokens));
    const aliases=aliasesCache.get(aliasKey);
    const snap=selectFeature(db,aliases,issuer,sample.observed_at,
      options.cohort,quote.observed_at);
    if(!snap){bump('no_contemporaneous_issuer_verified_features');continue;}
    const anchor=options.cohort==='scans'?snap.timestamp:sample.observed_at;
    if(quote.observed_at>anchor ||
       anchor-quote.observed_at>RESERVE_MAX_AGE_MS){
      bump('quote_stale_or_future');continue;
    }
    if(options.cohort==='signals'&&snap.timestamp>anchor){
      bump('future_feature_rejected');continue;
    }
    const tagged=taggedBefore(db,raw,issuer,anchor);
    if(!tagged&&!options.includeUntagged){
      bump('no_recent_positive_meme_tag');continue;
    }
    if(!tagged)bump('untagged_research_only');
    const gate=entryGate(quote);
    if(!gate.ok){bump(gate.reason);continue;}
    const confirm=featureDecision(snap);
    if(!confirm.ok)bump('B_'+confirm.reason);
    prior.set(key,sample.observed_at);
    const result={
      raw,issuer,label:printable(raw,sample.token_currency),
      source:sample.event_type || 'scanner_price_sample',
      time:anchor,quote,features:snap,tagged,eligibleA:true,
      eligibleB:confirm.ok,
      sizeC:confirm.ok?adaptiveSize(quote,snap):0,
    };
    candidates.push(result);bump('A_proxy_candidates');
  }
  return {candidates,counters,anchors:samples.length,fatal:false};
}
function outcomeForCandidate(db,c,horizon,now){
  const target=c.time+horizon*60000;
  if(target+EXIT_WINDOW_MS>now)return {status:'not_mature'};
  const exit=db.prepare('SELECT * FROM paper_amm_reserve_evidence '+
    'WHERE raw_currency=? AND token_issuer=? AND observed_at>=? AND observed_at<=? '+
    'ORDER BY observed_at ASC LIMIT 1'
  ).get(c.raw,c.issuer,target,target+EXIT_WINDOW_MS);
  if(!validReserve(exit))return {status:'no_future_full_reserve'};
  const A=scenario(5,c.quote,exit);
  const B=c.eligibleB?scenario(5,c.quote,exit):null;
  const C=c.eligibleB?scenario(c.sizeC,c.quote,exit):null;
  if(!A ||(c.eligibleB&&(!B||!C)))return {status:'unquotable'};
  return {status:'complete',A,B,C,exit};
}
function metrics(records,arm){
  let pnl=0,grossProfit=0,grossLoss=0,wins=0,number=0,peak=0,maxDrawdown=0;
  for(const r of records){
    const x=r[arm];if(!x)continue;
    number++;pnl+=x.pnlXRP;
    if(x.pnlXRP>0){wins++;grossProfit+=x.pnlXRP;}
    else if(x.pnlXRP<0)grossLoss+=-x.pnlXRP;
    peak=Math.max(peak,pnl);
    maxDrawdown=Math.max(maxDrawdown,peak-pnl);
  }
  return {number,netXRP:pnl,winRate:number?wins/number*100:null,
    meanPerEntry:number?pnl/number:null,
    profitFactor:grossLoss?grossProfit/grossLoss:null,
    maxDrawdown};
}
function audit(db,opts,now=Date.now()){
  const data=makeCandidates(db,opts,now);
  if(data.fatal)return {data,arms:{}};
  const arms={};
  for(const horizon of HORIZONS){
    const status={},completed=[];
    for(const c of data.candidates){
      const out=outcomeForCandidate(db,c,horizon,now);
      status[out.status]=(status[out.status]||0)+1;
      if(out.status==='complete')completed.push({...out,candidate:c});
    }
    arms[horizon]={status,completed,A:metrics(completed,'A'),
      B:metrics(completed,'B'),C:metrics(completed,'C')};
  }
  return {data,arms};
}
function metricText(m){
  const fmt=x=>Number.isFinite(x)?x.toFixed(4):'n/a';
  return 'entries='+m.number+
    ' net='+fmt(m.netXRP)+' XRP'+
    ' mean='+fmt(m.meanPerEntry)+' XRP'+
    ' win_rate='+fmt(m.winRate)+'%'+
    ' PF='+fmt(m.profitFactor)+
    ' peak_to_trough='+fmt(m.maxDrawdown)+' XRP';
}
function cli(opts,now=Date.now()){
  if(!fs.existsSync(opts.path)||!fs.statSync(opts.path).isFile())
    throw Error('Expected existing SQLite PAPER DB');
  const db=new Database(opts.path,{readonly:true,fileMustExist:true,timeout:15000});
  try{
    db.pragma('query_only = ON');
    const result=audit(db,opts,now);
    console.log('=== HUNTERIX A/B/C SHADOW EDGE STUDY (READ ONLY) ===');
    console.log('Cohort:',opts.cohort,'hours:',opts.hours,'limit:',opts.limit);
    console.log('Meme policy:',opts.includeUntagged?
      'EXPLORATORY including unverified issues (NOT trade eligible)':
      'positive issuer-exact meme-tag evidence within previous 45m required');
    console.log('A = 5 XRP AMM/depth-only reference PROXY, NOT deployed TDE or PAPER fills');
    console.log('B = same A candidates, 5 XRP with pre-entry buyer breadth + 5m momentum');
    console.log('C = same B candidates, adaptive 1/2/5 XRP sizes using ONLY pre-entry information');
    console.log('A, B and C are hypotheses, not tested profitable strategies. AMM routes/transfer fees not verified.');
    console.log('Anchors:',result.data.anchors||0,'A proxy samples:',result.data.candidates.length);
    console.log('Evidence/selection counters:',JSON.stringify(result.data.counters));
    if(result.data.fatal){
      console.log('MISSING TABLES: no speculative result inferred.');return result;
    }
    for(const horizon of HORIZONS){
      const h=result.arms[horizon];
      console.log('\nHorizon +'+horizon+'m: complete comparable quotes='+
        h.completed.length+' | missing/maturing='+JSON.stringify(h.status));
      console.log('  A ',metricText(h.A));
      console.log('  B ',metricText(h.B));
      console.log('  C ',metricText(h.C));
      if(h.completed.length<30)
        console.log('  INSUFFICIENT SAMPLE: fewer than 30 complete observations; no edge or profitability inference.');
      for(const p of h.completed.slice(0,SAMPLE_DISPLAY_LIMIT)){
        const c=p.candidate;
        console.log('   '+new Date(c.time).toISOString()+' '+c.label+' '+c.raw+':'+c.issuer+
          ' source='+c.source+' B='+(c.eligibleB?'pass':'reject')+
          ' A='+p.A.pnlXRP.toFixed(4)+' XRP'+
          (p.C?' C('+c.sizeC+'XRP)='+p.C.pnlXRP.toFixed(4)+' XRP':''));
      }
    }
    console.log('\nCAUSALITY / POLICY: no lookahead in selection; future reserves only evaluated AFTER selection.');
    console.log('Only samples with complete future reserve quotes enter compared P&L denominators.');
    console.log('The sample is not a randomized strategy test; overlapping hypothetical fills,');
    console.log('provider classification/blacklist/issuer details and live transaction execution');
    console.log('are NOT established. Positive modeled P&L does NOT authorize trades.');
    console.log('No PM2, freezes, trades, providers or database writes touched.');
    return result;
  }finally{db.close();}
}
if(require.main===module){
  try{cli(readOptions(process.argv.slice(2)));}
  catch(e){console.error('ABC RESEARCH BLOCKED:',e.message);process.exitCode=2;}
}
module.exports={readOptions,featureDecision,adaptiveSize,entryGate,scenario,safeAliases,selectFeature,makeCandidates,outcomeForCandidate,audit,cli};
