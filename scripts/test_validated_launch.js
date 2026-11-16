#!/usr/bin/env node
/** Verify no proposed/failed AMMCreate can impersonate a newly launched pool. */
const assert = require('node:assert/strict');
const { ActiveDiscovery } = require('../dist/scanner/activeDiscovery');
const token = {
  TransactionType:'AMMCreate',Account:'rSyntheticIssuer',
  Amount:'350000000',
  Amount2:{currency:'4E45574C41554E434800000000000000000000',issuer:'rKfcfA5bLsELJfbkjKRqc5kAzrd22esfy',value:'100000000'}
};
function make(){
 return new ActiveDiscovery({getClient:()=>null}, {});
}
function event(validated, result='tesSUCCESS'){
 return {validated,tx_json:token,meta:result?{TransactionResult:result}:undefined,engine_result:result};
}
for(const [name,e] of [
  ['proposed no validation flag',event(undefined)],
  ['explicitly unvalidated',event(false)],
  ['missing metadata',event(true,null)],
  ['failed validated',event(true,'tecUNFUNDED_AMM')],
]){
 const a=make();
 assert.equal(a.processLiveTx(e),null,name+' must not become new-launch signal');
 assert.equal(a.getKnownTokenCount(),0,name+' cannot register discovered launch');
}
const a=make();
const t=a.processLiveTx(event(true));
assert.ok(t && t.source==='amm_pool','validated AMMCreate must register new pool');
assert.equal(a.getKnownTokenCount(),1);
assert.equal(a.processLiveTx(event(true)),null,'same AMMCreate replay must not duplicate');
console.log('PASS only explicit validated tesSUCCESS AMMCreate is a launch; failed and proposed events rejected');
