#!/usr/bin/env node
/**
 * Read-only auditor for current PAPER holdings versus issuer provenance.
 * Does NOT trade, fetch outside data, reconnect XRPL, or modify SQLite.
 */
'use strict';
const path=require('node:path');
const Database=require('better-sqlite3');
const {decideVerifiedProjectIssuer,REVIEWED_PROJECT_ISSUERS}=
  require('../dist/risk/verifiedProjectIssuers');
const {findOpenTickerCollision}=require('../dist/risk/openTickerCollision');

function auditRows(rows){
  const positions=rows.map(r=>({
    tokenCurrency:r.token_currency,
    tokenIssuer:r.token_issuer,
    rawCurrency:r.raw_currency||r.token_currency,
    remainingPosition:r.remaining_position,
  }));
  return rows.map(row=>{
    const decision=decideVerifiedProjectIssuer(
      row.token_currency,row.token_issuer,row.raw_currency
    );
    const sameTicker=findOpenTickerCollision({
      currency:row.token_currency,
      issuer:row.token_issuer,
      rawCurrency:row.raw_currency,
    },positions.filter(p=>p.tokenIssuer!==row.token_issuer));
    // This legacy report field is explicitly OTHER-issuer only; same-issue
    // alternate display aliases are audited separately by issuer forensic.
    return {
      id:row.id,
      name:row.token_currency,
      issuer:row.token_issuer,
      status:row.status,
      remainingPercent:Number(row.remaining_position),
      profile:row.trade_profile,
      provenance:decision.status,
      expectedIssuer:decision.allowed?undefined:decision.expectedIssuer,
      source:decision.allowed?undefined:decision.source,
      sameTickerOtherIssuer:sameTicker?.tokenIssuer||null,
    };
  });
}

function run(){
  const dbPath=path.resolve(process.argv[2] ||
    'data/meme_bot.paper-epoch-20261116-vnext.db');
  const db=new Database(dbPath,{readonly:true,fileMustExist:true});
  try{
    db.pragma('query_only=ON');
    if(db.pragma('quick_check',{simple:true})!=='ok')
      throw Error('SQLite integrity check failed');
    const rows=db.prepare(
      "SELECT id,token_currency,token_issuer,raw_currency,status,remaining_position,trade_profile FROM paper_trades "+
      "WHERE status IN ('open','partial') ORDER BY id"
    ).all();
    const results=auditRows(rows);
    console.log('=== READ-ONLY XRPL PROJECT ISSUER PROVENANCE AUDIT ===');
    console.log('Protected official projects:',REVIEWED_PROJECT_ISSUERS.map(p=>
      p.ticker+' issuer='+p.issuer).join('; '));
    console.log('Currently open/partial positions:',results.length);
    let warnings=0;
    for(const result of results){
      const hasConcern=result.provenance==='issuer_mismatch' ||
        !!result.sameTickerOtherIssuer;
      if(hasConcern)warnings++;
      console.log(
        '#'+result.id+' '+result.name+
        ' '+result.status+' left='+result.remainingPercent+'%'+
        ' issuer='+result.issuer+
        ' provenance='+result.provenance+
        (result.sameTickerOtherIssuer
          ? ' SAME-TICKER-OTHER-ISSUER='+result.sameTickerOtherIssuer : '')
      );
      if(result.expectedIssuer)console.log(
        '   REVIEW: project-published issuer='+result.expectedIssuer+
        ' source='+result.source
      );
    }
    console.log('Identity/concentration alerts:',warnings);
    console.log('No sales, changes to running bot, or issuer blacklist updates performed.');
    return results;
  }finally{db.close()}
}
if(require.main===module){
  try{run()}catch(error){console.error('AUDIT ERROR:',error.message);process.exitCode=1}
}
module.exports={auditRows};
