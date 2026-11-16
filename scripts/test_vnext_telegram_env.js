#!/usr/bin/env node
/** CI ONLY: synthetic Telegram credentials, no real bot calls or secrets. */
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const cp=require('node:child_process');
if(process.env.CI!=='true')throw Error('CI-only synthetic Telegram configuration test');
const stage=path.resolve(__dirname,'..'),target=path.join(stage,'.env');
if(fs.existsSync(target))throw Error('Refusing to touch an existing staged .env');
const t=fs.mkdtempSync(path.join(os.tmpdir(),'hunterix-telegram-env-ci-'));
const old=path.join(t,'legacy');fs.mkdirSync(old);
const fakeToken='123456:'+('T'.repeat(35));
const oldEnv=path.join(old,'.env');
fs.writeFileSync(oldEnv,[
  'TELEGRAM_BOT_TOKEN='+fakeToken,
  'TELEGRAM_CHAT_ID=-1001234567890',
  'TRADING_WALLET_SEED=THIS_IS_SYNTHETIC_AND_MUST_NEVER_COPY',
  'EXTRA_SECRET=FAKE_CI_SECRET',
  'XRPL_WS_URL=wss://example.invalid',
  ''
].join('\r\n'),{mode:0o600});
const helper=path.join(stage,'scripts/prepare_vnext_telegram_env.js');
const run=(...args)=>cp.spawnSync(process.execPath,[helper,...args],
  {encoding:'utf8',timeout:10000});
try {
  const plan=run(old);
  assert.equal(plan.status,0);
  assert.ok(!fs.existsSync(target),'plan must not create file');
  assert.ok(!plan.stdout.includes(fakeToken));
  assert.ok(!plan.stdout.includes('THIS_IS_SYNTHETIC'));
  const created=run('--create',old);
  assert.equal(created.status,0,created.stderr);
  assert.ok(fs.existsSync(target));
  const data=fs.readFileSync(target,'utf8');
  assert.equal(data,'TELEGRAM_BOT_TOKEN='+fakeToken+'\nTELEGRAM_CHAT_ID=-1001234567890\n');
  assert.equal(fs.statSync(target).mode & 0o077,0);
  assert.ok(!data.includes('TRADING_WALLET_SEED'));
  assert.ok(!data.includes('EXTRA_SECRET'));
  assert.ok(!data.includes('XRPL_WS_URL'));
  assert.equal(run('--create',old).status,2,'never overwrite existing staged credentials');
  console.log('PASS Telegram-only .env creation, owner-only permissions, explicit mode, no secrets logged, no wallet/env copying, no overwrite');
} finally {
  fs.rmSync(target,{force:true});  // created by this CI fixture only
  fs.rmSync(t,{recursive:true,force:true});
}
