#!/usr/bin/env node
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {WhaleTracker}=require('../dist/scoring/whaleTracker');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'hunterix-whales-'));
const original=process.cwd();
process.chdir(tmp);
fs.mkdirSync('state');
const addr='rajQGCYdTV5wBEaDcCk1YAtLQNnyXKGFhU';
const addr2='raw7oFXXMSQHPEZqtc5EoH6kqWzrRy41WB';
const file=path.join(tmp,'state','top_traders_import.json');
const t=new WhaleTracker();
function write(importedAt){
 fs.writeFileSync(file,JSON.stringify({importedAt,source:'firstledger_radar_top20',
   traders:[{address:addr,winRatePct:95,volumeXrp:637630},
            {address:addr2,winRatePct:81,volumeXrp:218150}]}));
}
try{
 t.recordWinner('SYNTH','rIssuer',[addr,'rOtherInternal'],50);
 assert.equal(t.getWhaleScore('SYNTH','rIssuer',[addr,'rOtherInternal']),0,
   'bot PAPER trade profit does not prove wallets profitable');
 write(Date.now()-8*24*3600000);
 assert.equal(t.loadTopTradersFromFile(),0);
 assert.equal(t.getBestWhaleWinRate([addr]),0,'old firstledger snapshot must not lower trade thresholds');
 assert.equal(t.isWhale(addr),true,'historical whale identity preserved');
 write(Date.now()-2*3600000);
 assert.equal(t.loadTopTradersFromFile(),2);
 assert.equal(t.getBestWhaleWinRate([addr]),95);
 assert.equal(t.getWhaleScore('SYNTH','rIssuer',[addr,addr]),10,'duplicate wallet cannot fake 2 confirmations');
 assert.equal(t.getWhaleScore('SYNTH','rIssuer',[addr,addr2]),17);
 write(Date.now()-8*24*3600000);
 assert.equal(t.loadTopTradersFromFile(),0);
 assert.equal(t.getBestWhaleWinRate([addr]),0,'expired external claims revoked after reload');
 assert.equal(t.isWhale(addr2),true,'historical wallet records never deleted');
 console.log('PASS user whale addresses retained; old performance data advisory, fresh externally sourced wins boost, no deduped inflation');
}finally{process.chdir(original);fs.rmSync(tmp,{recursive:true,force:true});}
