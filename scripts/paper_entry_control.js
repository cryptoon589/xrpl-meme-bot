#!/usr/bin/env node
/**
 * Operator control for PAPER entry-only freeze once deployed.
 *
 * freeze: creates a durable root-owned sentinel immediately; subsequent
 * entry checks reject before the TDE/provider or order paths, without PM2
 * restart. Exits, TP legs and trailing stops run normally.
 *
 * unfreeze: explicit two-argument confirmation; never done during deploy.
 * This script does NOT touch the PAPER trade database or manage PM2.
 */
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {paperEntryFreezePath,readPaperEntryFreeze}=
  require('../dist/risk/paperEntryFreeze');

const cmd=process.argv[2];
if(!['freeze','status','unfreeze'].includes(cmd)){
  console.error('Usage: node scripts/paper_entry_control.js freeze|status|unfreeze --confirm-resume-paper');
  process.exit(2);
}
const p=paperEntryFreezePath();
const dir=path.dirname(p);

function report(){
  const state=readPaperEntryFreeze();
  console.log(JSON.stringify({
    paperEntryFrozen:state.frozen,
    reason:state.reason,
    sentinel:p,
    note:'Only affects a running release with the entry-freeze check installed; existing PAPER exits continue.'
  },null,2));
  return state;
}

if(cmd==='freeze'){
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  try{
    const fd=fs.openSync(p,'wx',0o600);
    try{fs.writeSync(fd,'Operator requested PAPER exit-only mode.\n');
      fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    console.log('PAPER exit-only freeze created; no PM2 restart or DB mutation.');
  }catch(e){
    if(e?.code!=='EEXIST')throw e;
    console.log('PAPER entry freeze already present.');
  }
  const state=report();
  if(!state.frozen)process.exitCode=1;
}else if(cmd==='unfreeze'){
  if(process.argv[3]!=='--confirm-resume-paper'){
    console.error('UNFREEZE BLOCKED: explicit --confirm-resume-paper required.');
    process.exit(2);
  }
  try{fs.unlinkSync(p);}
  catch(e){if(e?.code!=='ENOENT')throw e;}
  const state=report();
  if(state.frozen)process.exitCode=1;
}else report();
