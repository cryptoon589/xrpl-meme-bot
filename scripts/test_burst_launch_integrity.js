#!/usr/bin/env node
const assert=require('node:assert/strict');
const {BurstDetector}=require('../dist/scanner/burstDetector');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const alerts=[];
const detector=new BurstDetector(
  {getClient:()=>null},
  {sendAlert:async(payload)=>{alerts.push(payload);return true;}},
  {getTrackedTokens:()=>[]}
);
const issuer='rKfcfA5bLsELJfbkjKRqc5kAzrd22esfy';
const raw='5445535400000000000000000000000000000000';
const key=raw+':'+issuer;
detector.fetchAMMAccount=async()=>null;
let price=0.00001;
detector.fetchAMMInfo=async()=>({priceXRP:price,poolXRP:1000,tradingFee:0});
const confirmations=[];
detector.onBurst=(...args)=>confirmations.push(args);
async function trigger(){
  detector.recordBuy(raw,issuer,'rajQGCYdTV5wBEaDcCk1YAtLQNnyXKGFhU',18,false);
  detector.recordBuy(raw,issuer,'raw7oFXXMSQHPEZqtc5EoH6kqWzrRy41WB',18,false);
  await sleep(20);
}
(async()=>{
  detector.ensureAmmRegistered(raw,issuer);
  await trigger();
  assert.equal(confirmations.length,1);
  assert.equal(confirmations[0][5],Infinity,
    'first discovery is NOT proof of newly created AMM');
  assert.equal(confirmations[0][6],null,'first burst baseline should be null');
  detector.tokens.get(key).lastAlertTs=0;
  price=0.000025;
  await trigger();
  assert.equal(confirmations.length,2);
  assert.ok(Math.abs(confirmations[1][6]-0.00001)<1e-12,
    'second burst must retain first burst baseline for pump detection');

  detector.tokens.get(key).lastAlertTs=0;
  detector.registerNewLaunch(raw,issuer,'TEST');
  price=0.00003;
  await trigger();
  assert.equal(confirmations.length,3);
  assert.ok(confirmations[2][5]<60000,
    'verified AMMCreate is required to classify genuinely new launch');

  detector.isManuallyBlocked=()=>true;
  detector.tokens.get(key).lastAlertTs=0;
  await trigger();
  assert.equal(confirmations.length,3,'operator blacklist blocks even new burst');
  detector.isManuallyBlocked=()=>false;

  const before=confirmations.length;
  detector.ammToToken.set('rAMMSyntheticAccount',key);
  // LP deposit could change XRP pool balance but must not count as buyer activity.
  detector.processTransaction({
    tx:{TransactionType:'AMMDeposit',Account:'rajQGCYdTV5wBEaDcCk1YAtLQNnyXKGFhU'},
    engine_result:'tesSUCCESS',
    meta:{TransactionResult:'tesSUCCESS',AffectedNodes:[
      {ModifiedNode:{LedgerEntryType:'AccountRoot',
       FinalFields:{Account:'rAMMSyntheticAccount',Balance:'2000000000'},
       PreviousFields:{Balance:'1900000000'}}}
    ]}
  });
  await sleep(20);
  assert.equal(confirmations.length,before,'AMM LP deposits are not organic trades');
  console.log('PASS first-seen not first-launched, baseline preserved, confirmed new AMM signals, manual blacklist, no LP fake burst');
})().catch(e=>{console.error(e);process.exitCode=1});
