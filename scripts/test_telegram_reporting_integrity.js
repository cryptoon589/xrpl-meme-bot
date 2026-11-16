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
  assert.ok(formatted.includes('-0.015'),'trade-close alert must display net recorded fee-adjusted P&L');
  console.log('PASS close alert uses corrected net P&L rather than gross returned-principal');

  console.log('TELEGRAM ACCOUNTING/DIAGNOSTICS REGRESSION PASSED (OFFLINE)');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
