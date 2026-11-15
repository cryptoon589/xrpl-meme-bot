#!/usr/bin/env node
// Isolate XRPL endpoint throughput from Hunterix processing, no DB/trading.
const { Client } = require('xrpl');
const url = process.env.XRPL_WS_URL || 'wss://rpc.xrplclaw.com/ws';
const durationMs = 45000;
const client = new Client(url, {timeout:20000,connectionTimeout:10000});
let total=0, disconnects=0, maxDelay=0, lastTick=Date.now();
const interval=setInterval(()=>{const now=Date.now();maxDelay=Math.max(maxDelay,now-lastTick-1000);lastTick=now;},1000);
async function run(){
 try {
  client.on('disconnected',code=>{disconnects++;console.log('DISCONNECTED code='+code);});
  client.on('transaction',()=>{total++;});
  await client.connect();
  await client.request({command:'subscribe',streams:['transactions']});
  console.log('Subscribed to raw transactions; NO token processing, DB writes, or trades.');
  await new Promise(resolve=>setTimeout(resolve,durationMs));
 } catch(e){console.log('ERROR:',String(e));process.exitCode=1;}
 finally {
  clearInterval(interval);
  console.log(JSON.stringify({endpoint:url,durationSeconds:45,transactionsReceived:total,disconnects,maxEventLoopDelayMs:maxDelay}));
  try{await client.disconnect();}catch{}
 }
}
run();
