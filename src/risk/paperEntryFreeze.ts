/**
 * Persistent, no-restart PAPER entry freeze.
 *
 * An operator-owned sentinel file is checked synchronously on EVERY new
 * entry attempt. A successful lock needs no PM2 restart once this code is
 * deployed; existing exits, partial sales and risk management are unaffected.
 *
 * Sentinel existence is deliberate exit-only mode: its CONTENT is ignored,
 * and a malformed/unreadable sentinel does NOT accidentally unlock entries.
 * This is not a permanent token blacklist.
 */
import fs from 'node:fs';
import path from 'node:path';

export const PAPER_ENTRY_FREEZE_NAME = 'paper-entry-freeze.flag';

export function paperEntryFreezePath(root=process.cwd()): string {
  return path.resolve(root,'state',PAPER_ENTRY_FREEZE_NAME);
}

export type PaperEntryFreezeState = {
  frozen: boolean;
  reason: 'operator_freeze'|'filesystem_unavailable'|'not_frozen';
};

export function readPaperEntryFreeze(root=process.cwd()):PaperEntryFreezeState {
  try {
    fs.statSync(paperEntryFreezePath(root));
    return {frozen:true,reason:'operator_freeze'};
  } catch(e:any) {
    if(e?.code==='ENOENT'){
      // Parent directory is part of the operator-owned bot state. A missing
      // state directory is not a valid unlocked control path.
      try {
        const st=fs.statSync(path.resolve(root,'state'));
        if(st.isDirectory())return {frozen:false,reason:'not_frozen'};
      }catch{ /* fail closed below */ }
    }
    return {frozen:true,reason:'filesystem_unavailable'};
  }
}
