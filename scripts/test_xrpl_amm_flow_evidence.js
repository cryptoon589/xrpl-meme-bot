#!/usr/bin/env node
/** Evidence classifier fixture; no network, wallet, DB mutation or trades. */
'use strict';
const assert=require('node:assert/strict');
const {classifyValidatedAmmFlow}=require('../dist/diagnostics/xrplAmmFlowEvidence');
const {BuyPressureTracker}=require('../dist/market/buyPressureTracker');
const amm='rAMMSyntheticPool',issuer='rSyntheticIssuer',currency='TEST';
const sender='rSyntheticSender',recipient='rSyntheticRecipient';
const tx=(kind='Payment',delta=12000000,opts={})=>{
  const changed=String(100000000+delta);
  return {
    validated:true,engine_result:'tesSUCCESS',
    tx_json:{TransactionType:kind,Account:sender,Destination:recipient,
      Amount:{currency,issuer,value:'20'}},
    meta:{TransactionResult:'tesSUCCESS',AffectedNodes:[
      {ModifiedNode:{LedgerEntryType:'AccountRoot',
        FinalFields:{Account:amm,Balance:changed},
        PreviousFields:{Balance:'100000000'}}},
      {ModifiedNode:{LedgerEntryType:'RippleState',
        FinalFields:{Balance:{currency,value:'120'},
          LowLimit:{issuer:amm},HighLimit:{issuer}},
        PreviousFields:{Balance:{currency,value:'100'}}}}
    ]},...opts
  };
};
const judge=(packet,am=amm,code=currency,is=issuer)=>
  classifyValidatedAmmFlow(packet,am,code,is);
assert.deepEqual(judge(tx()),{
  rawCurrency:currency,issuer,side:'xrp_inflow',volumeXRP:12});
assert.equal(judge(tx('OfferCreate',-7000000)).side,'xrp_outflow');
assert.equal(judge(tx('AMMDeposit')),null,'LP adds liquidity, not organic flow');
assert.equal(judge(tx('AMMWithdraw',-7000000)),null);
assert.equal(judge(tx('Payment',12000000,{validated:false})),null);
const failed=tx();failed.meta.TransactionResult='tecUNFUNDED_PAYMENT';
failed.engine_result='tecUNFUNDED_PAYMENT';
assert.equal(judge(failed),null);
const noTrust=tx();noTrust.meta.AffectedNodes.pop();
assert.equal(judge(noTrust),null,'XRP only transfer is not proof of a trade');
assert.equal(judge(tx(),amm,currency,'rOtherIssuer'),null,
  'the token trustline must match issuer exact');
const noAmm=tx();noAmm.meta.AffectedNodes[0].ModifiedNode.FinalFields.Account='rOtherAMM';
assert.equal(judge(noAmm),null,'unmapped AMM XRP balance cannot authorize');
const noBalanceChange=tx();
noBalanceChange.meta.AffectedNodes[1].ModifiedNode.PreviousFields.Balance.value='120';
assert.equal(judge(noBalanceChange),null,'token balance must actually change');
// The legacy tracker counts a simple issued-token Payment as a buy AND a sell.
// New classification must never turn that unrelated transfer into a real buy.
const tracker=new BuyPressureTracker();
const plain={tx_json:{TransactionType:'Payment',Account:sender,Destination:recipient,
  Amount:{currency,issuer,value:'100'}},meta:{AffectedNodes:[]}};
tracker.processTransaction(plain);
assert.equal(tracker.getSnapshot(currency,issuer).buySellRatio,0.5);
assert.equal(judge({...plain,validated:true,engine_result:'tesSUCCESS',
  meta:{TransactionResult:'tesSUCCESS',AffectedNodes:[]}}),null);
// End-to-end scanner hook: observational evidence must not replace the
// legacy burst recorder, and a plain/failed/LP transaction produces none.
const {BurstDetector}=require('../dist/scanner/burstDetector');
const det=new BurstDetector({getClient:()=>null},
  {sendAlert:async()=>true},{getTrackedTokens:()=>[]});
let legacyFlowCalls=0;
det.recordBuy=()=>{legacyFlowCalls++;};
det.tokens.set(currency+':'+issuer,{
  rawCurrency:currency,issuer,displayName:currency,buys:[],
  lastAlertTs:0,poolXRP:null,baselinePrice:null,
  lastTrade:Date.now(),firstSeenAt:Date.now(),
});
det.ammToToken.set(amm,currency+':'+issuer);
const observations=[];
det.onValidatedAmmFlow=flow=>observations.push(flow);
det.processTransaction(tx());
assert.equal(observations.length,1,'exact validated AMM flow emitted');
assert.equal(legacyFlowCalls,1,'legacy burst flow path preserved');
det.processTransaction(tx('AMMDeposit'));
assert.equal(observations.length,1);
det.processTransaction(tx('Payment',12000000,{validated:false}));
assert.equal(observations.length,1,'unvalidated TX cannot create evidence');
assert.equal(legacyFlowCalls,2,'legacy callback path untouched');

console.log('PASS observed exact AMM balance/trustline flows; plain transfers, LP, unvalidated, failed, wrong issuer rejected; legacy trading path untouched');
