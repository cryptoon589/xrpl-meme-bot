#!/usr/bin/env node
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {OperatorBlacklist}=require('../dist/risk/operatorBlacklist');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'hunterix-manual-blacklist-'));
try {
  const file=path.join(tmp,'operator.json');
  assert.throws(()=>OperatorBlacklist.load(file),/missing/);
  const manifest={
    format:'hunterix-manual-blacklist-v1',
    managedBy:'operator',
    tokens:[
      {currency:'USERONLY'},
      {currency:'ISSUERONLY',issuer:'rKfcfA5bLsELJfbkjKRqc5kAzrd22esfy'}
    ]
  };
  fs.writeFileSync(file,JSON.stringify(manifest));
  const original=fs.readFileSync(file,'utf8');
  const list=OperatorBlacklist.load(file);
  assert.equal(list.list().length,2);
  assert.equal(list.isBlocked('USERONLY','rAnIssuer'),true);
  assert.equal(list.isBlocked('ISSUERONLY','rKfcfA5bLsELJfbkjKRqc5kAzrd22esfy'),true);
  assert.equal(list.isBlocked('ISSUERONLY','rDifferent'),false);
  assert.equal(list.isBlocked('CORE','rAny'),false);
  assert.equal(list.isBlocked('RLUSD','rAny'),false);
  assert.equal(list.isBlocked('OCT','rAny'),false);
  assert.equal(list.isBlocked('BANK','rAny'),false);
  assert.ok(list.asDecisionSet().has('ISSUERONLY:rKfcfA5bLsELJfbkjKRqc5kAzrd22esfy'));
  assert.ok(!list.asDecisionSet().has('CORE'));
  assert.equal(fs.readFileSync(file,'utf8'),original,'load cannot rewrite operator file');
  fs.writeFileSync(file,JSON.stringify({...manifest,managedBy:'automatic'}));
  assert.throws(()=>OperatorBlacklist.load(file),/schema/);
  fs.writeFileSync(file,JSON.stringify({...manifest,tokens:[manifest.tokens[0],manifest.tokens[0]]}));
  assert.throws(()=>OperatorBlacklist.load(file),/Duplicate/);
  fs.writeFileSync(file,JSON.stringify({...manifest,tokens:[]}));
  const empty=OperatorBlacklist.load(file);
  assert.deepEqual(empty.list(),[]);
  assert.equal(empty.isBlocked('LOX','rAny'),false);
  console.log('PASS missing manifest fails closed, exactly operator entries, issuer scoping, zero hidden token/brand bans, file never mutated');
}finally{fs.rmSync(tmp,{recursive:true,force:true});}
