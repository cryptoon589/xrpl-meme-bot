#!/usr/bin/env node
// Diagnostic only: one XRPL connection, transaction stream plus read-only RPC load.
// No Hunterix imports, database access, wallet, or trading.
const { Client } = require('xrpl');
const url = process.env.XRPL_WS_URL || 'wss://rpc.xrplclaw.com/ws';
const durationMs = 60000;
const intervalMs = 250;
const maxInFlight = 5;
const client = new Client(url,{timeout:20000,connectionTimeout:10000});
let tx=0,disconnects=0,requests=0,failures=0,inFlight=0,maxInFlightSeen=0;
let stop=false;
let tick;
let pump;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function main(){
 try{
  client.on('disconnected',code=>{disconnects++;console.log('DISCONNECTED code='+code);});
  client.on('transaction',()=>tx++);
  await client.connect();
  await client.request({command:'subscribe',streams:['transactions']});
  console.log('DIAGNOSTIC: transaction stream + read-only ledger RPC; 60 seconds; no bot/database/trades');
  tick=setInterval(()=>{
   if(stop||inFlight>=maxInFlight)return;
   inFlight++;maxInFlightSeen=Math.max(maxInFlightSeen,inFlight);
   client.request({command:'ledger',ledger_index:'validated',transactions:false,expand:false})
    .then(()=>requests++)
    .catch(e=>{failures++;if(failures<=3)console.log('RPC_ERROR',String(e).slice(0,160));})
    .finally(()=>inFlight--);
  },intervalMs);
  await sleep(durationMs);
 }catch(e){console.log('ERROR',String(e));process.exitCode=1;}
 finally{
  stop=true;clearInterval(tick);clearInterval(pump);
  await sleep(1500);
  console.log(JSON.stringify({endpoint:url,seconds:60,tx,disconnects,requests,failures,maxInFlightSeen}));
  try{await client.disconnect();}catch{}
 }
}
main();
