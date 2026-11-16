#!/usr/bin/env node
/** One-shot offline XRPL 1008 reconnect timing check; no sockets opened. */
const assert=require('node:assert/strict');
const {XRPLClient}=require('../dist/xrpl/client');

async function main(){
  const rate=new XRPLClient('wss://example.invalid');
  rate.scheduleReconnect(true);
  assert.ok(rate.reconnectTimer,'RPC reconnect timer must be installed');
  assert.ok(rate.reconnectTimer._idleTimeout>=120000,
    '1008 rate limit must never trigger a 5-second reconnect storm');
  await rate.disconnect();
  assert.equal(rate.reconnectTimer,null);

  const ordinary=new XRPLClient('wss://example.invalid');
  ordinary.scheduleReconnect(false);
  assert.ok(ordinary.reconnectTimer._idleTimeout<100000,
    'ordinary disconnect keeps bounded exponential backoff');
  await ordinary.disconnect();

  const stream=new XRPLClient('wss://example.invalid');
  stream.scheduleStreamReconnect(true);
  assert.ok(stream.streamReconnectTimer._idleTimeout>=120000);
  await stream.disconnect();
  assert.equal(stream.streamReconnectTimer,null);

  const normalStream=new XRPLClient('wss://example.invalid');
  normalStream.scheduleStreamReconnect(false);
  assert.ok(normalStream.streamReconnectTimer._idleTimeout<=5000);
  await normalStream.disconnect();

  console.log('PASS XRPL 1008 rate-limited RPC and transaction stream use >=120s backoff; no socket opened');
}
main().catch(e=>{console.error(e);process.exitCode=1});
