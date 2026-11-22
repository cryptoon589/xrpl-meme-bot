#!/usr/bin/env node
/** Offline bounded AMM pressure shadow regression; no provider or trades. */
'use strict';
const assert=require('node:assert/strict');
const {AmmPressureEvidence}=require('../dist/diagnostics/ammPressureEvidence');
const model=new AmmPressureEvidence();
const now=1800000000000;
const flow=(hash,side='xrp_inflow',issuer='rIssuerOne',volumeXRP=12)=>({
 rawCurrency:'5445535400000000000000000000000000000000',
 issuer,side,volumeXRP,txHash:hash
});
const H=n=>n.toString(16).padStart(64,'0').toUpperCase();
assert.equal(model.observe(flow(H(1)),now),true);
assert.equal(model.observe(flow(H(1)),now),false,'repeated validated TX hash ignored');
assert.equal(model.observe(flow(H(2),'xrp_outflow','rIssuerOne',7),now+1000),true);
assert.equal(model.observe(flow(H(3),'xrp_inflow','rIssuerOther'),now+1000),true);
assert.equal(model.observe({...flow(H(4)),txHash:undefined},now),false,
  'unverifiable missing hash not silently counted as independent flow');
assert.equal(model.observe(flow(H(5),'xrp_inflow','rIssuerOne',NaN),now),false);
const one=model.snapshot(flow(H(1)).rawCurrency,'rIssuerOne',now+1000);
assert.equal(one.inflows,1);
assert.equal(one.outflows,1);
assert.equal(one.inflowXRP,12);
assert.equal(one.outflowXRP,7);
assert.equal(one.inflowFraction,0.5);
const other=model.snapshot(flow(H(1)).rawCurrency,'rIssuerOther',now+1000);
assert.equal(other.inflows,1);
assert.equal(other.outflows,0);
const expired=model.snapshot(flow(H(1)).rawCurrency,'rIssuerOne',now+5*60*1000+1001);
assert.equal(expired.inflows,0);
assert.equal(expired.outflows,0);
assert.equal(expired.inflowFraction,0.5);
assert.equal(model.observe(flow(H(1)),now+6*60*1000),true,
  'old hash beyond five-minute window cannot block future observations');
assert.equal(model.snapshot(flow(H(1)).rawCurrency,'rIssuerOne',now+6*60*1000).inflows,1);
console.log('PASS 5m bounded AMM shadow: issuer separation, dedup, expiry, volume and hash fail-closed');
