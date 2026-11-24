#!/usr/bin/env node
/** Synthetic timestamped A/B/C edge experiment. No trading, RPC, or production DB. */
'use strict';
const assert=require('node:assert/strict');
const os=require('node:os'),path=require('node:path'),fs=require('node:fs');
const cp=require('node:child_process');
const SQLite=require('better-sqlite3');
const study=require('./audit_abc_shadow_edge');
const now=Date.now(),start=now-9*3600000;
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hunterix-abc-shadow-'));
const file=path.join(dir,'synthetic.paper.db');
const encode=x=>Buffer.from(x,'ascii').toString('hex').toUpperCase().padEnd(40,'0');
const e=(m)=>start+m*60000;
let db;
function put(label,issuer,atMinute,{reserve=1500,tokens=100000,kind='burst_seen',
  tagged=true,momentum=4,trend=8,buys=6,unique=4,buyVolume=30,sellVolume=10,
  closing=true,exitXrp=1700,exitTokens=98000}={}){
  const raw=encode(label),at=e(atMinute),q=at-30000,feature=at-20000;
  db.prepare('INSERT INTO tokens VALUES(?,?,?)').run(label,issuer,raw);
  db.prepare('INSERT INTO paper_opportunity_events VALUES(?,?,?,?,?)').run(raw,issuer,label,at,kind);
  if(tagged)db.prepare('INSERT INTO paper_opportunity_events VALUES(?,?,?,?,?)').run(raw,issuer,label,at-120000,'meme_evidence_refreshed');
  db.prepare('INSERT INTO paper_amm_reserve_evidence VALUES(?,?,?,?,?,?,?,?)').run(raw,issuer,label,q,reserve,tokens,100,'amm');
  db.prepare('INSERT INTO market_snapshots VALUES(?,?,?,?,?,?,?,?,?,?)').run(label,issuer,feature,
    momentum,trend,buys,unique,buyVolume,sellVolume,0.01);
  if(closing){
    for(const mins of [11,31,61]){
      db.prepare('INSERT INTO paper_amm_reserve_evidence VALUES(?,?,?,?,?,?,?,?)').run(raw,issuer,label,at+mins*60000,
        exitXrp,exitTokens,100,'amm');
    }
  }
}
try{
  db=new SQLite(file);
  db.exec(
    'CREATE TABLE tokens(currency TEXT,issuer TEXT,raw_currency TEXT);'+
    'CREATE TABLE paper_amm_reserve_evidence(raw_currency TEXT,token_issuer TEXT,'+
      'token_currency TEXT,observed_at INTEGER,pool_xrp_reserve REAL,'+
      'pool_token_reserve REAL,trading_fee_units INTEGER,source TEXT);'+
    'CREATE TABLE market_snapshots(token_currency TEXT,token_issuer TEXT,'+
      'timestamp INTEGER,price_change_5m REAL,price_change_15m REAL,'+
      'buy_count_5m INTEGER,unique_buyers_5m INTEGER,buy_volume_5m REAL,'+
      'sell_volume_5m REAL,price_xrp REAL);'+
    'CREATE TABLE paper_opportunity_events(raw_currency TEXT,token_issuer TEXT,'+
      'token_currency TEXT,observed_at INTEGER,event_type TEXT);'
  );
  put('STRONG','rIssuerOne',0,{reserve:3500,tokens:200000,
    buys:8,unique:6,buyVolume:80,sellVolume:20,
    exitXrp:4900,exitTokens:190000});
  put('WEAK','rIssuerTwo',80,{reserve:1100,buys:1,unique:1,
    momentum:-3,trend:-5,buyVolume:1,sellVolume:35,
    exitXrp:750,exitTokens:145000});
  // Post-event high pressure MUST NOT change pre-entry weak classification.
  db.prepare('INSERT INTO market_snapshots VALUES(?,?,?,?,?,?,?,?,?,?)').run(
    'WEAK','rIssuerTwo',e(80)+20000,12,30,99,30,500,0,0.01);
  put('MEDIUM','rIssuerThree',160,{reserve:1500,
    buys:4,unique:3,buyVolume:40,sellVolume:10,exitXrp:1750});
  put('LOW2','rIssuerFour',240,{reserve:600,
    buys:4,unique:3,buyVolume:25,sellVolume:8,exitXrp:650});
  put('UNTAGGED','rIssuerFive',320,{reserve:1500,tagged:false});
  put('SHALLOW','rIssuerSix',380,{reserve:130});
  put('NOCLOSE','rIssuerSeven',420,{reserve:1500,closing:false});
  // Same ticker and raw currency, DIFFERENT issuer with no AMM evidence.
  db.prepare('INSERT INTO paper_opportunity_events VALUES(?,?,?,?,?)').run(
    encode('STRONG'),'rWrongIssuer','STRONG',e(460),'burst_seen');
  // A distinct issue with only a FUTURE reserve quote must be ignored.
  db.prepare('INSERT INTO tokens VALUES(?,?,?)').run('FUTURE','rIssuerEight',encode('FUTURE'));
  db.prepare('INSERT INTO paper_opportunity_events VALUES(?,?,?,?,?)').run(
    encode('FUTURE'),'rIssuerEight','FUTURE',e(480),'burst_seen');
  db.prepare('INSERT INTO paper_amm_reserve_evidence VALUES(?,?,?,?,?,?,?,?)').run(
    encode('FUTURE'),'rIssuerEight','FUTURE',e(480)+1000,1500,100000,100,'amm');
  db.prepare('INSERT INTO market_snapshots VALUES(?,?,?,?,?,?,?,?,?,?)').run(
    'FUTURE','rIssuerEight',e(480)-20000,3,8,5,3,50,10,0.01);
  const opts={path:file,limit:1000,hours:12,cohort:'signals',includeUntagged:false};
  const study1=study.audit(db,opts,now);
  const cs=study1.data.candidates;
  assert.equal(cs.length,5,'STRONG/WEAK/MEDIUM/LOW2/NOCLOSE should be A candidates');
  assert.deepEqual(cs.map(c=>c.label),['STRONG','WEAK','MEDIUM','LOW2','NOCLOSE']);
  assert.equal(cs.filter(x=>x.eligibleB).length,4);
  assert.equal(cs.find(c=>c.label==='WEAK').eligibleB,false,'post-event features excluded');
  assert.equal(cs.find(c=>c.label==='STRONG').sizeC,5);
  assert.equal(cs.find(c=>c.label==='MEDIUM').sizeC,2);
  assert.equal(cs.find(c=>c.label==='LOW2').sizeC,1);
  assert.equal(study1.data.counters.no_recent_positive_meme_tag,1);
  assert.equal(study1.data.counters.reserve_under_500_or_invalid,1);
  assert(study1.data.counters.no_contemporaneous_full_reserve>=2);
  for(const window of [10,30,60]){
    const a=study1.arms[window];
    assert.equal(a.completed.length,4,'complete 4-case same opportunity denominator');
    assert.equal(a.A.number,4);
    assert.equal(a.B.number,3);
    assert.equal(a.C.number,3);
    assert(a.A.netXRP<a.B.netXRP,
      'B excludes a deliberately loss-making weak signal in synthetic fixture');
    assert.equal(a.status.no_future_full_reserve,1);
    assert.equal(a.completed.find(x=>x.candidate.label==='LOW2').C.sizeXRP,1);
    assert.equal(a.completed.find(x=>x.candidate.label==='MEDIUM').C.sizeXRP,2);
  }
  assert.equal(study.featureDecision({
    price_change_5m:-3,price_change_15m:1,
    buy_count_5m:5,unique_buyers_5m:5,buy_volume_5m:40,sell_volume_5m:5
  }).reason,'weak_or_late_5m_momentum');
  assert.equal(study.featureDecision({
    price_change_5m:4,price_change_15m:null,
    buy_count_5m:5,unique_buyers_5m:5,buy_volume_5m:40,sell_volume_5m:5
  }).reason,'missing_pre_entry_features');
  const loose=study.audit(db,{...opts,includeUntagged:true},now);
  assert.equal(loose.data.candidates.length,6);
  assert.equal(loose.data.counters.untagged_research_only,1);
  const scans=study.audit(db,{...opts,cohort:'scans'},now);
  assert(scans.data.anchors>0,'scanner cohort is observational, not signal-only');
  db.close();db=null;
  const original=fs.readFileSync(file);
  const log=cp.execFileSync(process.execPath,
    [path.join(__dirname,'audit_abc_shadow_edge.js'),file,
      '--hours=12','--limit=1000','--cohort=signals'],
    {encoding:'utf8',cwd:dir});
  assert(log.includes('A/B/C SHADOW EDGE STUDY')&&log.includes('same A candidates'),log);
  assert(log.includes('complete comparable quotes=4'),log);
  assert(log.includes('A proxy samples: 5'),log);
  assert(log.includes('No PM2, freezes, trades, providers or database writes touched.'));
  assert.deepEqual(fs.readFileSync(file),original,'read-only CLI must not change SQLite file');
  console.log('PASS A/B/C issuer-exact, pre-event features, signals vs scans, missing reserves, tag gate, adaptive 1/2/5, future quotes, read-only SQLite');
}finally{
  if(db)db.close();
  fs.rmSync(dir,{recursive:true,force:true});
}
