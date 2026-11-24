#!/usr/bin/env node
/**
 * Read-only historical ENTRY feature study on ALREADY EXECUTED PAPER trades.
 *
 * Compare the recorded actual realized P&L of trades with vs without a
 * predeclared quality check using issuer-verified PRE-ENTRY market snapshots.
 * C sizing is deliberately not backcast: source historical reserve pairs
 * are missing. This is in-sample selection analysis, not an executable
 * counterfactual, not a deployment recommendation.
 */
'use strict';
const fs=require('node:fs');
const SQLite=require('better-sqlite3');
const {decodeIssuedCurrencyName}=require('../dist/xrpl/currencyCode');
const {safeAliases,selectFeature,featureDecision}=require('./audit_abc_shadow_edge');

function options(args){
  if(!args[0]||args[0].startsWith('--'))
    throw Error('Usage: node scripts/audit_abc_historical_quality.js <epoch.db> [--from-id=72] [--limit=500]');
  const out={path:args[0],fromId:72,limit:500};
  for(const a of args.slice(1)){
    if(a.startsWith('--from-id='))out.fromId=Number(a.slice(10));
    else if(a.startsWith('--limit='))out.limit=Number(a.slice(8));
    else throw Error('Unknown parameter '+a);
  }
  if(!Number.isInteger(out.fromId)||out.fromId<0||out.fromId>10000000||
     !Number.isInteger(out.limit)||out.limit<1||out.limit>10000)
    throw Error('from-id 0..10000000 and limit 1..10000 required');
  return out;
}
function summary(trades){
  const n=trades.length,pnl=trades.reduce((a,t)=>a+t.pnl_xrp,0);
  const profit=trades.filter(t=>t.pnl_xrp>0).reduce((a,t)=>a+t.pnl_xrp,0);
  const loss=-trades.filter(t=>t.pnl_xrp<0).reduce((a,t)=>a+t.pnl_xrp,0);
  const wins=trades.filter(t=>t.pnl_xrp>0).length;
  return {n,pnl,wins,winRate:n?100*wins/n:null,mean:n?pnl/n:null,
    pf:loss?profit/loss:null,largeLosses:trades.filter(t=>t.pnl_xrp<=-1).length};
}
function report(db,{fromId,limit}){
  const cols=db.prepare("PRAGMA table_info(paper_trades)").all().map(x=>x.name);
  for(const k of ['id','token_currency','raw_currency','token_issuer',
    'entry_timestamp','trade_source','pnl_xrp','status','exit_reason'])
    if(!cols.includes(k))throw Error('Required PAPER table column missing: '+k);
  const rows=db.prepare(
    "SELECT id,token_currency,raw_currency,token_issuer,entry_timestamp,"+
    "trade_source,exit_reason,pnl_xrp FROM paper_trades "+
    "WHERE id>? AND status='closed' AND pnl_xrp IS NOT NULL "+
    "ORDER BY entry_timestamp ASC LIMIT ?"
  ).all(fromId,limit);
  const hasTokens=Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tokens'").get());
  const matched=[],unknown=[];
  for(const trade of rows){
    if(!trade.raw_currency){
      unknown.push({...trade,reason:'no_raw_issue_code'});continue;
    }
    const aliases=safeAliases(db,trade.raw_currency,trade.token_issuer,hasTokens);
    const snap=selectFeature(db,aliases,trade.token_issuer,trade.entry_timestamp,'signals');
    if(!snap){
      unknown.push({...trade,reason:'no_prior_issuer_verified_snapshot'});continue;
    }
    const decision=featureDecision(snap);
    matched.push({...trade,
      qualityAccepted:decision.ok,qualityReason:decision.reason,
      featureTimestamp:snap.timestamp,featureMomentum5:snap.price_change_5m,
      featureBuyers:snap.unique_buyers_5m});
  }
  const selected=matched.filter(x=>x.qualityAccepted);
  const excluded=matched.filter(x=>!x.qualityAccepted);
  const all=summary(rows),m=summary(matched),yes=summary(selected),no=summary(excluded);
  const counters={};
  for(const r of matched){
    if(!r.qualityAccepted)counters[r.qualityReason]=(counters[r.qualityReason]||0)+1;
  }
  return {all,covered:m,yes,no,unknown,counters,matched,rows};
}
function formatted(s){
  const f=v=>Number.isFinite(v)?v.toFixed(3):'n/a';
  return 'n='+s.n+' net='+f(s.pnl)+' XRP mean='+f(s.mean)+
    ' XRP win='+f(s.winRate)+'% PF='+f(s.pf)+
    ' losses<=-1XRP='+s.largeLosses;
}
function main(opt){
  if(!fs.existsSync(opt.path)||!fs.statSync(opt.path).isFile())
    throw Error('Expected existing PAPER SQLite database');
  const db=new SQLite(opt.path,{readonly:true,fileMustExist:true,timeout:15000});
  try{
    db.pragma('query_only = ON');
    const x=report(db,opt);
    console.log('=== HUNTERIX HISTORICAL ENTRY-QUALITY COVERAGE (READ ONLY) ===');
    console.log('This is IN-SAMPLE analysis of already executed trades, NOT a backtest of missed winners.');
    console.log('A = booked historical PAPER actual simulated P&L; B = SELECTED SUBSET if preset pre-entry momentum check passed.');
    console.log('C = NOT CALCULATED from old trade history (missing synchronous AMM XRP/token reserves).');
    console.log('ALL historical closed:',formatted(x.all));
    console.log('With verified PRE-entry features:',formatted(x.covered));
    console.log('B would retain (within covered):',formatted(x.yes));
    console.log('B would exclude (within covered):',formatted(x.no));
    console.log('No safely joinable prior features:',x.unknown.length);
    console.log('Rejection reasons (only among covered):',JSON.stringify(x.counters));
    console.log('Covered historical winning positions retained by B:',
      x.covered.wins ? x.yes.wins+'/'+x.covered.wins : 'n/a');
    for(const id of [105,133,134,140]){
      const t=x.matched.find(t=>t.id===id);
      const un=x.unknown.find(t=>t.id===id);
      if(t)console.log(' Spotlight #'+id+' '+(decodeIssuedCurrencyName(t.raw_currency)||t.token_currency)+
        ' '+t.token_issuer+' B='+(t.qualityAccepted?'pass':t.qualityReason)+
        ' entered='+new Date(t.entry_timestamp).toISOString()+
        ' feature_at='+new Date(t.featureTimestamp).toISOString()+
        ' pnl='+t.pnl_xrp.toFixed(4)+' XRP');
      else if(un)console.log(' Spotlight #'+id+' unavailable: '+un.reason);
    }
    console.log('WARNING: a filtered historical subset does not simulate other entries,');
    console.log('bankroll reuse, simultaneous exposure, alternative exits, or future out-of-sample edge.');
    console.log('Do NOT change trading thresholds or lift the PAPER freeze from this retrospective alone.');
    return x;
  }finally{db.close();}
}
if(require.main===module){
  try{main(options(process.argv.slice(2)));}
  catch(e){console.error('HISTORICAL QUALITY AUDIT BLOCKED:',e.message);process.exitCode=2;}
}
module.exports={options,summary,report,main};
