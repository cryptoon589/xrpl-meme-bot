#!/usr/bin/env node
/** Offline historical entry quality study; synthetic PAPER history only. */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs');
const os=require('node:os'),path=require('node:path'),cp=require('node:child_process');
const SQLite=require('better-sqlite3');
const {report}=require('./audit_abc_historical_quality');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hunterix-historical-abc-'));
const file=path.join(dir,'synthetic.paper.db');
const raw=s=>Buffer.from(s).toString('hex').toUpperCase().padEnd(40,'0');
let db;
try{
  db=new SQLite(file);
  db.exec(
    'CREATE TABLE tokens(currency TEXT,issuer TEXT,raw_currency TEXT);'+
    'CREATE TABLE market_snapshots(token_currency TEXT,token_issuer TEXT,timestamp INTEGER,'+
       'price_change_5m REAL,price_change_15m REAL,buy_count_5m INTEGER,'+
       'unique_buyers_5m INTEGER,buy_volume_5m REAL,sell_volume_5m REAL);'+
    'CREATE TABLE paper_trades(id INTEGER,token_currency TEXT,raw_currency TEXT,'+
       'token_issuer TEXT,entry_timestamp INTEGER,trade_source TEXT,'+
       'pnl_xrp REAL,status TEXT,exit_reason TEXT);'
  );
  const at=Date.now()-10000000;
  const add=(id,name,issuer,pnl,snapshot=true,features=[5,7,6,4,35,10],late=false)=>{
    const code=raw(name);
    db.prepare('INSERT INTO tokens VALUES(?,?,?)').run(name,issuer,code);
    db.prepare('INSERT INTO paper_trades VALUES(?,?,?,?,?,?,?,?,?)').run(
      id,name,code,issuer,at+id*200000,'burst',pnl,'closed',
      pnl>0?'trailing_stop_profit':'kill_no_followthrough');
    if(snapshot){
      db.prepare('INSERT INTO market_snapshots VALUES(?,?,?,?,?,?,?,?,?)').run(
        name,issuer,at+id*200000+(late?1000:-30000),...features);
    }
  };
  add(101,'STRONG','rIssuerA',2);
  add(102,'WEAK','rIssuerB',-1.4,true,[-3,-2,1,1,1,25]);
  add(103,'NOSNAP','rIssuerC',-0.3,false);
  add(104,'PHNIX','rIssuerD',0.8,true,[3,4,5,3,22,2]);
  // Same named currency on another issuer is NOT the issuer with the sample.
  add(105,'STRONG','rIssuerE',-0.5,false);
  add(106,'LATE','rIssuerF',0.5,true,[8,10,8,5,50,5],true);
  const r=report(db,{fromId:100,limit:200});
  assert.equal(r.all.n,6);
  assert.equal(r.covered.n,3);
  assert.equal(r.yes.n,2);
  assert.equal(r.no.n,1);
  assert.equal(r.unknown.length,3);
  assert.equal(r.covered.wins,2);
  assert.equal(r.yes.wins,2);
  assert(Math.abs(r.all.pnl-1.1)<1e-9);
  assert(Math.abs(r.yes.pnl-2.8)<1e-9);
  assert.equal(r.counters.weak_or_late_5m_momentum,1);
  assert(r.unknown.some(x=>x.id===106),'post-entry snapshot is lookahead');
  assert(r.unknown.some(x=>x.id===105),'same ticker issuer cannot borrow another');
  db.close();db=null;
  const before=fs.readFileSync(file);
  const printed=cp.execFileSync(process.execPath,[
    path.join(__dirname,'audit_abc_historical_quality.js'),file,
    '--from-id=100','--limit=200'
  ],{encoding:'utf8',cwd:dir});
  assert(printed.includes('B would retain (within covered): n=2'),printed);
  assert(printed.includes('No safely joinable prior features: 3'),printed);
  assert(printed.includes('Do NOT change trading thresholds or lift the PAPER freeze'),printed);
  assert.deepEqual(fs.readFileSync(file),before,'read-only report modified SQLite');
  console.log('PASS historical issuer-specific pre-entry quality and win-retention, late-snapshot rejection, cash PnL and immutable SQLite');
}finally{if(db)db.close();fs.rmSync(dir,{force:true,recursive:true});}
