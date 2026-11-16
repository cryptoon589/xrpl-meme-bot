#!/usr/bin/env node
/**
 * VPS-only read-only ARMY/XRP AMM diagnostic through the SAME XRPL_WS_URL
 * setting as the existing legacy bot. Reads *only* XRPL_WS_URL from original
 * .env using dotenv.parse; never sources a shell, prints credentials/URL,
 * copies .env, edits a database, uses wallet keys or starts PM2.
 *
 * After separate stage npm ci + npm run build:
 *   node scripts/diagnose_army_using_legacy_endpoint.js /root/xrpl-meme-bot
 */
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const cp=require('node:child_process');
const dotenv=require('dotenv');

const stage=path.resolve(__dirname,'..');
const old=path.resolve(process.argv[2] || '/root/xrpl-meme-bot');
if (old===stage || stage.startsWith(old+path.sep)) {
  console.error('Refusing to operate in the original live checkout');
  process.exit(2);
}
if (!fs.existsSync(path.join(stage,'dist/index.js'))) {
  console.error('Staged build is missing. Run npm ci and npm run build only in separate vNext stage.');
  process.exit(2);
}
const envPath=path.join(old,'.env');
if (!fs.existsSync(envPath) || fs.lstatSync(envPath).isSymbolicLink()) {
  console.error('Original .env file missing/symlink: cannot verify effective VPS endpoint');
  process.exit(2);
}
let originalEnv;
try { originalEnv=dotenv.parse(fs.readFileSync(envPath)); }
catch { console.error('Original .env cannot be parsed; no credentials disclosed'); process.exit(2); }
// Match the original loadConfig() default exactly when .env has no XRPL_WS_URL.
const endpoint=originalEnv.XRPL_WS_URL || 'wss://rpc.xrplclaw.com/ws';
let parsed;
try { parsed=new URL(endpoint); }
catch { console.error('Configured XRP Ledger endpoint URL invalid');process.exit(2); }
if (parsed.protocol!=='wss:' || parsed.username || parsed.password) {
  console.error('Refusing to connect to unencrypted or credential-bearing XRPL endpoint');
  process.exit(2);
}
console.log('Checking ARMY on exact same XRPL_WS_URL configuration as old bot.');
console.log('Endpoint URL, all secrets and other .env values intentionally hidden.');
const test=cp.spawnSync(process.execPath,[path.join(stage,'scripts/diagnose_army_price.js')],{
  cwd:stage,
  env:{
    PATH:process.env.PATH || '',
    HOME:process.env.HOME || '',
    NODE_ENV:'production',
    MODE:'PAPER',
    LIVE_TRADING:'false',
    TRADING_WALLET_SEED:'',
    XRPL_WS_URL:endpoint,
  },
  stdio:'inherit',
  timeout:35000,
});
if (test.error) {
  console.error('ARMY RPC diagnostic could not finish (no transactions sent):',test.error.code || 'UNKNOWN');
  process.exit(2);
}
if(test.status===3) {
  console.error('The original configured provider appears rate-limited. Do not repeatedly probe it; test an independent endpoint instead.');
}
process.exit(test.status===0?0:(test.status===3?3:2));
