#!/usr/bin/env node
/** Offline stub: no Telegram or network calls. */
const assert = require('node:assert/strict');
const { TelegramAlerter } = require('../dist/telegram/alerts');

const config={telegramBotToken:'123456:'+'x'.repeat(36),telegramChatId:'111111'};
const a=new TelegramAlerter(config);
const sent=[];
a.bot={sendMessage:async(chat,message,opts)=>{
  sent.push({chat,message,opts});
  return {message_id:sent.length};
}};

async function main(){
  assert.equal(await a.sendAlert({type:'open_positions_update',message:'OPEN POSITIONS'}),true);
  assert.equal(await a.sendAlert({type:'hourly_diagnostics',message:'DIAGNOSTICS'}),true);
  assert.equal(sent.length,2,'diagnostics must use separate cooldown');
  assert.equal(sent[1].message,'DIAGNOSTICS');
  assert.equal(await a.sendAlert({type:'hourly_diagnostics',message:'DIAGNOSTICS AGAIN'}),false);
  assert.equal(sent.length,2,'duplicate same-hour diagnostics must be throttled');
  console.log('PASS positions and diagnostic messages both delivered through independent cooldowns');

  const f=new TelegramAlerter({telegramBotToken:config.telegramBotToken,telegramChatId:'222222'});
  f.bot={sendMessage:async()=>{throw new Error('SIMULATED_OFFLINE_TRANSPORT_FAIL')}};
  assert.equal(await f.sendAlert({type:'hourly_diagnostics',message:'RETRYABLE'}),false);
  const retry=[];
  f.bot={sendMessage:async(_chat,message)=>{retry.push(message);return {message_id:1};}};
  assert.equal(await f.sendAlert({type:'hourly_diagnostics',message:'RETRYABLE'}),true);
  assert.deepEqual(retry,['RETRYABLE']);
  console.log('PASS Telegram failure returns false and allows next-attempt delivery');

  const trade={
    tokenCurrency:'AUDIT',tokenIssuer:'rOffline',entryPriceXRP:1,
    entryAmountXRP:5,entryTimestamp:Date.now()-60000,entryScore:55,
    entryReason:'[BURST] synthetic',exitPriceXRP:1.01,exitTimestamp:Date.now(),
    exitScore:null,exitReason:'time_stop_profit',status:'closed',
    pnlXRP:-0.015,pnlPercent:-0.3,xrpReturned:5,slippageEstimate:0,
    feesPaid:0.03,tp1Hit:false,tp2Hit:false,
    trailingStopActive:false,remainingPosition:0,
  };
  const formatted=a.format({type:'paper_trade_closed',paperTrade:trade,message:''});
  assert.ok(formatted.includes('TRADE CLOSED — LOSS') && formatted.includes('<b>P&L:</b>') && formatted.includes('-0.01 XRP'),
    'trade-close alert must classify fee-adjusted negative net as loss despite gross proceeds equaling principal');
  console.log('PASS close alert uses corrected net P&L rather than gross returned-principal');
  const phnixRaw='50484E4958000000000000000000000000000000';
  const dropRaw='44524F5000000000000000000000000000000000';
  const bchampRaw='424348414D500000000000000000000000000000';
  const names=[
    ['DRO',dropRaw,'DROP'],
    ['BCHA',bchampRaw,'BCHAMP'],
    [phnixRaw,phnixRaw,'PHNIX']
  ];
  for(const [stored,raw,expected] of names){
    const fixture={...trade,tokenCurrency:stored,rawCurrency:raw,
      tokenIssuer:'rOnlyOfflineFixture'};
    const opened=a.format({type:'paper_trade_opened',paperTrade:fixture,message:''});
    const closed=a.format({type:'paper_trade_closed',paperTrade:fixture,message:''});
    assert(opened.includes('<code>'+expected+'</code>'),
      'open alert must print full raw ticker '+expected);
    assert(closed.includes('<code>'+expected+'</code>'),
      'close alert must print full raw ticker '+expected);
    assert(opened.includes(encodeURIComponent(raw)),
      'FirstLedger link must use actual raw currency issue');
  }
  console.log('PASS DRO/BCHA/PHNIX Telegram names and issuer-exact FirstLedger links');


  // Regression: TP1 sold 60% of 5 XRP original for 3.58 XRP returned.
  // Realized profit on the SOLD inventory is ~0.57 XRP, but 40% is
  // still exposed; this must never be announced as a CLOSED winning trade.
  const partial={
    ...trade,tokenCurrency:'PUNX',status:'partial',
    entryPriceXRP:0.003237,exitPriceXRP:null,exitTimestamp:null,
    exitReason:null,entryAmountXRP:5,
    tp1Hit:true,tp2Hit:false,remainingPosition:40,
    xrpReturned:3.58,pnlXRP:0.571,pnlPercent:11.42,
    lastPartialSoldPercent:60,lastPartialXrpReturned:3.58,
    lastPartialPnlXRP:0.571,lastPartialPnlPercent:18.98,
    lastPartialExitPriceXRP:0.00365,
    lastPartialReason:'tp1_+15pct'
  };
  const wrongRouted=a.format({type:'paper_trade_closed',paperTrade:partial,message:''});
  assert.ok(wrongRouted.includes('PARTIAL CLOSE') &&
    wrongRouted.includes('40% still open') &&
    wrongRouted.includes('Leg P&amp;L:')===false &&
    wrongRouted.includes('Leg P&L:') &&
    !wrongRouted.includes('TRADE CLOSED'),
    'even wrong-routed TP1 event cannot be shown as completed winning trade');
  const correctlyRouted=a.format({type:'paper_trade_partial_close',paperTrade:partial,message:''});
  assert.equal(wrongRouted,correctlyRouted,
    'partial exit formatting must be consistent across notification entry points');
  const fullLoss={
    ...partial,status:'closed',remainingPosition:0,
    exitPriceXRP:0.0029,exitTimestamp:Date.now(),
    exitReason:'stop_loss',pnlXRP:-1.435,pnlPercent:-28.7
  };
  const fullMessage=a.format({type:'paper_trade_closed',paperTrade:fullLoss,message:''});
  assert.ok(fullMessage.includes('TRADE CLOSED — LOSS') &&
    !fullMessage.includes('PARTIAL CLOSE'),
    'a fully sold trade returning 3.58 XRP on 5 XRP stake must be a loss');
  console.log('PASS partial TP1 gain never labeled closed win, true full 3.58 XRP close is a loss');

  console.log('TELEGRAM ACCOUNTING/DIAGNOSTICS REGRESSION PASSED (OFFLINE)');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
