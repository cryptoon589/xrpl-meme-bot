#!/usr/bin/env node
/**
 * Read-only 1/2/5 XRP AMM micro-size observation comparisons.
 * ONLY stored, timestamped actual AMM reserves (no price-only/liquidity/2
 * substitutions). ZERO executed PAPER trades, no liquidity authorizations,
 * no network requests or lookahead, no database mutation.
 *
 * Future reserve observations belong to the WORLD WITHOUT our hypothetical
 * entry. Therefore these are indicative counterfactual scenarios, NOT
 * executable fills, returns available to a real trader, or trading advice.
 */
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const sqlite=require('better-sqlite3');
const {estimateAmmBuy,estimateAmmSell}=require('../dist/paper/ammExecutionQuote');
const {decodeIssuedCurrencyName}=require('../dist/xrpl/currencyCode');

function args(argv){
  if(!argv[0])throw Error('Usage: node scripts/audit_micro_amm_shadow.js DB [--focus=BLACKSWN,5090] [--limit=12] [--hours=72]');
  let limit=12,hours=72,focus=[];
  for(const a of argv.slice(1)){
    if(a.startsWith('--limit='))limit=Number(a.slice(8));
    else if(a.startsWith('--hours='))hours=Number(a.slice(8));
    else if(a.startsWith('--focus='))focus=a.slice(8).split(',').map(x=>x.toUpperCase().trim()).filter(Boolean);
    else throw Error('Unknown argument: '+a);
  }
  if(!Number.isInteger(limit)||limit<1||limit>50||
     !Number.isInteger(hours)||hours<2||hours>168)throw Error('limit 1..50, hours 2..168');
  return {dbPath:argv[0],limit,hours,focus};
}
const date=ts=>new Date(ts).toISOString().slice(5,16).replace('T',' ')+' UTC';
function micro(xrpIn,entry,exit){
  if(!Number.isFinite(xrpIn)||xrpIn<=0)return null;
  const buy=estimateAmmBuy(xrpIn,entry.pool_xrp_reserve,
    entry.pool_token_reserve,entry.trading_fee_units);
  if(!buy||buy.amountOut<=0)return null;
  const sell=estimateAmmSell(buy.amountOut,exit.pool_token_reserve,
    exit.pool_xrp_reserve,exit.trading_fee_units);
  if(!sell)return null;
  // Same additional nominal PAPER leg overhead as reservePaperExecution.
  const netSell=sell.amountOut*(1-0.003),cost=xrpIn*(1+0.003);
  return {netXRP:netSell-cost,entryImpact:buy.priceImpactPct,
    exitImpact:sell.priceImpactPct};
}
function main(argv=process.argv.slice(2)){
  const options=args(argv);
  if(!fs.statSync(options.dbPath).isFile())throw Error('Expected existing SQLite database');
  const db=new sqlite(options.dbPath,{readonly:true,fileMustExist:true});
  try{
    db.pragma('query_only = ON');
    const table=db.prepare("SELECT 1 found FROM sqlite_master WHERE type='table' AND name='paper_amm_reserve_evidence'").get();
    if(!table){console.log('NO RESERVE EVIDENCE TABLE: historical snapshots do not preserve both AMM reserves. No micro P&L inferred.');return;}
    const since=Date.now()-options.hours*3600000;
    const groups=db.prepare(
      'SELECT raw_currency,token_issuer,MAX(token_currency) display,MIN(observed_at) first_at,COUNT(*) samples '+
      'FROM paper_amm_reserve_evidence WHERE observed_at>=? '+
      'GROUP BY raw_currency,token_issuer ORDER BY first_at DESC'
    ).all(since);
    const selected=groups.filter(g=>{
      const label=(decodeIssuedCurrencyName(g.raw_currency)||g.display||'').toUpperCase();
      return !options.focus.length || options.focus.includes(label);
    }).slice(0,options.limit);
    console.log('=== HUNTERIX OBSERVATION-ONLY AMM MICRO-SIZE RESEARCH ===');
    console.log('Data: real stored XRP/token AMM reserves; estimated constant-product quotes; NO actual fills');
    console.log('Sizes: 1, 2, 5 XRP; AMM fee units per snapshot and 0.3% additional overhead per leg');
    console.log('Entry reference is FIRST saved reserve in selected period, not a qualifying buy signal.');
    console.log('Samples are hypothetical: future reserves do NOT include the modeled entry trade.');
    console.log('Issues:',selected.length,'of',groups.length,'with reserves in last',options.hours,'hours');
    const entrySql=db.prepare('SELECT * FROM paper_amm_reserve_evidence WHERE raw_currency=? AND token_issuer=? AND observed_at>=? ORDER BY observed_at LIMIT 1');
    const exitSql=db.prepare('SELECT * FROM paper_amm_reserve_evidence WHERE raw_currency=? AND token_issuer=? AND observed_at>=? AND observed_at<=? ORDER BY observed_at LIMIT 1');
    for(const g of selected){
      const entry=entrySql.get(g.raw_currency,g.token_issuer,since);
      if(!entry)continue;
      const label=decodeIssuedCurrencyName(g.raw_currency)||g.display;
      console.log('\n'+label+' | '+g.raw_currency+':'+g.token_issuer);
      console.log('  initial',date(entry.observed_at),'| poolXRP=',entry.pool_xrp_reserve.toFixed(2),
        '| AMM fee units=',entry.trading_fee_units,'| samples=',g.samples);
      for(const mins of [10,30,60]){
        const at=entry.observed_at+mins*60000;
        const exit=exitSql.get(g.raw_currency,g.token_issuer,at,at+5*60000);
        if(!exit){console.log('  +'+mins+'m: NO RESERVE COVERAGE in [target, target+5m]');continue;}
        const outcomes=[1,2,5].map(size=>{
          const q=micro(size,entry,exit);
          if(!q)return size+' XRP: unquotable';
          return size+' XRP: '+(q.netXRP>=0?'+':'')+q.netXRP.toFixed(4)+
            ' XRP net (buy impact '+q.entryImpact.toFixed(1)+'%, sell '+q.exitImpact.toFixed(1)+'%)';
        });
        console.log('  +'+mins+'m observed',date(exit.observed_at),
          'exit poolXRP='+exit.pool_xrp_reserve.toFixed(2));
        for(const x of outcomes)console.log('    '+x);
      }
    }
    console.log('\nINTERPRETATION: unrealized, counterfactual AMM scenarios only. No'
      +' historical executable routes, real slippage, trustline restrictions,'
      +' counterparty transfer fees or rival ordering validated.');
  }finally{db.close();}
}
if(require.main===module)try{main();}catch(e){console.error('MICRO OBSERVATION BLOCKED:',e.message);process.exitCode=2;}
module.exports={micro,main};
