#!/usr/bin/env node
/**
 * Explicit, one-time preparation of vNext's TELEGRAM-ONLY .env in its separate
 * checkout. Copies NO wallet seed, exchange API credentials, full .env, or
 * other tokens. Does not run a bot or contact Telegram.
 *
 * To create (only after operator review):
 *   node scripts/prepare_vnext_telegram_env.js --create /root/xrpl-meme-bot
 * Without --create: read-only plan with no secrets.
 */
'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const dotenv=require('dotenv');
const stage=path.resolve(__dirname,'..');
const argv=process.argv.slice(2);
const create=argv[0]==='--create';
const old=path.resolve(create?(argv[1]||'/root/xrpl-meme-bot'):(argv[0]||'/root/xrpl-meme-bot'));
const target=path.join(stage,'.env');
if(stage===old || stage.startsWith(old+path.sep)) {
  console.error('ERROR: Telegram configuration must be staged in a separate checkout');
  process.exit(2);
}
const original=path.join(old,'.env');
try {
  const st=fs.lstatSync(original);
  if(!st.isFile()||st.isSymbolicLink())throw Error('source not a regular file');
  if(fs.existsSync(target))throw Error('staged .env exists; no automatic overwrite');
  const parsed=dotenv.parse(fs.readFileSync(original));
  const token=parsed.TELEGRAM_BOT_TOKEN||'';
  const chat=parsed.TELEGRAM_CHAT_ID||'';
  if(!/^\d+:[A-Za-z0-9_-]{35,}$/.test(token)||!/^-?\d+$/.test(chat)) {
    throw Error('Telegram token/chat missing or structurally invalid');
  }
  console.log('vNext Telegram-only configuration: source credentials structurally valid');
  console.log('Target: separate staged .env (0600); token/chat never printed');
  console.log('Wallet seed and all other original .env fields: NOT COPIED');
  if(!create) {
    console.log('PLAN ONLY: no file created. Add --create only after review.');
    process.exit(0);
  }
  // Atomic no-overwrite: open exclusive file with owner-only permissions.
  const fd=fs.openSync(target,'wx',0o600);
  try{
    fs.writeFileSync(fd,'TELEGRAM_BOT_TOKEN='+token+'\nTELEGRAM_CHAT_ID='+chat+'\n',
      {encoding:'utf8'});
    fs.fsyncSync(fd);
  }catch(err){fs.closeSync(fd);fs.unlinkSync(target);throw err;}
  fs.closeSync(fd);
  console.log('CREATED separate staged Telegram-only .env safely. Bot not started.');
}catch(err){
  console.error('BLOCKED: '+String(err.message||err).replace(/(\d+:[A-Za-z0-9_-]{35,})/g,'[REDACTED]'));
  process.exit(2);
}
