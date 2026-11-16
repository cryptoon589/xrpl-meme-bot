#!/usr/bin/env node
/** Local-loopback fake-webhook regression: no XRPL or Telegram network calls. */
const assert = require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn,spawnSync}=require('node:child_process');
const {WhaleTracker}=require('../dist/scoring/whaleTracker');

const script=path.resolve('src/webhook/topTraderWebhook.js');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'hunterix-webhook-sec-'));
const state=path.join(tmp,'state','top_traders_webhook.json');
const originalCwd=process.cwd();
const secret='review-only-secret-for-test-'.padEnd(44,'X');
const baseEnv={...process.env,WEBHOOK_SECRET:secret,WEBHOOK_PORT:'0',WEBHOOK_HOST:'127.0.0.1',
  WEBHOOK_STATE_FILE:state,WEBHOOK_ALLOW_PUBLIC:''};
const addr='rajQGCYdTV5wBEaDcCk1YAtLQNnyXKGFhU';
let child;
async function start(){
 return new Promise((resolve,reject)=>{
  child=spawn(process.execPath,[script],{env:baseEnv,stdio:['ignore','pipe','pipe']});
  let out='';
  const timeout=setTimeout(()=>reject(new Error('Webhook did not bind')),3000);
  child.stdout.on('data',b=>{
    out+=b.toString();
    const m=/127\.0\.0\.1:(\d+)/.exec(out);
    if(m){clearTimeout(timeout);resolve(Number(m[1]));}
  });
  child.on('exit',(code)=>{clearTimeout(timeout);reject(new Error('Webhook exited code '+code));});
  child.on('error',err=>{clearTimeout(timeout);reject(err);});
 });
}
async function post(port,body,auth=secret){
 return fetch('http://127.0.0.1:'+port+'/webhook/top-traders',{
  method:'POST',headers:{
    'Content-Type':'application/json',
    ...(auth?{Authorization:'Bearer '+auth}:{})
  },body:JSON.stringify(body)
 });
}
(async()=>{try{
 fs.mkdirSync(path.join(tmp,'state'));
 fs.writeFileSync(path.join(tmp,'state','top_traders_import.json'),
  JSON.stringify({importedAt:1746808320000,source:'firstledger_radar_top20',
    traders:[{address:addr,winRatePct:95,volumeXrp:637630}]}));
 const original=fs.readFileSync(path.join(tmp,'state','top_traders_import.json'),'utf8');
 const missing=spawnSync(process.execPath,[script],{
  env:{...baseEnv,WEBHOOK_SECRET:''},encoding:'utf8',timeout:2000});
 assert.equal(missing.status,1,'missing/weak secret must refuse to listen');
 const exposed=spawnSync(process.execPath,[script],{
  env:{...baseEnv,WEBHOOK_HOST:'0.0.0.0'},encoding:'utf8',timeout:2000});
 assert.equal(exposed.status,1,'public bind must require explicit deliberate opt-in');
 const port=await start();
 const wallet={address:addr,winRatePct:95,volumeXrp:637630};
 const payload={traders:[wallet],observedAt:Date.now(),approvedForSignals:true};
 assert.equal((await post(port,payload,null)).status,401);
 assert.equal((await post(port,payload,'wrong')).status,401);
 assert.equal((await post(port,{...payload,observedAt:Date.now()-8*86400_000})).status,422);
 assert.equal((await post(port,{...payload,traders:[wallet,wallet]})).status,422);
 assert.equal((await post(port,{...payload,traders:[{...wallet,winRatePct:Infinity}]})).status,422);
 assert.equal((await post(port,{...payload,traders:Array(101).fill(wallet)})).status,422);
 const tooLarge={...payload,extra:'a'.repeat(66*1024)};
 assert.equal((await post(port,tooLarge)).status,413);
 assert.equal(fs.existsSync(state),false,'invalid/malicious uploads must not create state');

 // Non-approved imports preserve watchlist data but never grant trade boosts.
 const unapproved={traders:[wallet],approvedForSignals:false};
 assert.equal((await post(port,unapproved)).status,200);
 process.chdir(tmp);
 const tracker=new WhaleTracker();
 assert.equal(tracker.loadTopTradersFromFile(),0);
 assert.equal(tracker.getBestWhaleWinRate([addr]),0);
 assert.equal((await post(port,payload)).status,200);
 const saved=JSON.parse(fs.readFileSync(state,'utf8'));
 assert.equal(saved.source,'operator_reviewed_webhook');
 assert.equal(saved.observedAt,payload.observedAt);
 assert.equal(saved.approvedForSignals,true);
 assert.equal(tracker.loadTopTradersFromFile(),1);
 assert.equal(tracker.getBestWhaleWinRate([addr]),95);
 assert.equal(fs.readFileSync(path.join(tmp,'state','top_traders_import.json'),'utf8'),
  original,'webhook may not rewrite original whale-address list');

 // Upload time cannot launder old underlying wallet statistics into a fresh score.
 fs.writeFileSync(state,JSON.stringify({...saved,importedAt:Date.now(),
   observedAt:Date.now()-8*86400_000}));
 assert.equal(tracker.loadTopTradersFromFile(),0);
 assert.equal(tracker.getBestWhaleWinRate([addr]),0);
 assert.equal(tracker.isWhale(addr),true,'retain historic wallet identity');
 console.log('PASS required secret, loopback-only bind, unauthorized/invalid payload refusal, bounded input');
 console.log('PASS separate atomic webhook file, manual whale list preserved, operator approval and observation timestamp enforced');
 console.log('PASS old performance cannot be refreshed by reuploading it as recent');
} catch(err) {console.error(err);process.exitCode=1;
} finally {
 process.chdir(originalCwd);
 if(child)child.kill('SIGTERM');
 fs.rmSync(tmp,{recursive:true,force:true});
}})();
