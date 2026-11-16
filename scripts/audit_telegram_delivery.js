#!/usr/bin/env node
/**
 * Regression/reproduction test for Telegram delivery bugs.
 * Does not contact Telegram. Stubbed bot.sendMessage records calls locally.
 * Tests current code flaws; outputs observed behavior for audit.
 */
const assert = require('node:assert/strict');
const { TelegramAlerter } = require('../dist/telegram/alerts');
const { PROFILES } = require('../dist/execution/tradeProfiles');

async function main() {
  const a = new TelegramAlerter({
    telegramBotToken: '123456:' + 'x'.repeat(36),
    telegramChatId: '111111',
  });
  const sent = [];
  a.bot = {
    sendMessage: async (chat, message, opts) => {
      sent.push({ chat, message, opts });
      return { message_id: sent.length };
    }
  };

  await a.sendAlert({type:'open_positions_update',message:'OPEN POSITIONS: 4'});
  await a.sendAlert({type:'open_positions_update',message:'DIAGNOSTICS: dropped=0'});
  assert.equal(sent.length,1);
  assert.equal(sent[0].message,'OPEN POSITIONS: 4');
  console.log('REPRODUCED: hourly diagnostics suppressed by positions cooldown key');

  const verySmall = {
    tokenCurrency: 'AUDIT', tokenIssuer: 'rTestIssuer',
    entryPriceXRP: 1e-10, entryAmountXRP:5, entryTimestamp:Date.now(),
    entryScore:0, entryReason:'[BURST] test', slippageEstimate:0.01,
    remainingPosition:100, tp1Hit:false, tp2Hit:false
  };
  const opening = a.format({
    type:'paper_trade_opened', message:'', paperTrade:verySmall,
    tradeProfileName:'BURST_SCALP',tradeSource:'burst'
  });
  assert.ok(opening.includes('0.00000000 XRP'));
  console.log('REPRODUCED: valid 1e-10 XRP price formats as zero');
  assert.ok(opening.includes('TP1 +' + PROFILES.BURST_SCALP.tp1Pct + '%'));
  console.log('CONFIRMED: alert uses global profile TP1, not position-specific learned TP1');

  // An HTML chunk cannot be safely cut in the middle of an open tag.
  const html = '<b>' + 'X'.repeat(4500) + '</b>';
  const chunks = a.splitMessage(html,4000,false);
  assert.ok(chunks.length > 1);
  assert.ok(chunks[0].startsWith('<b>') && !chunks[0].endsWith('</b>'));
  console.log('REPRODUCED: HTML chunks may contain unclosed markup');

  // sendAlert/sendRaw do not propagate a delivery failure to the caller.
  const failing = new TelegramAlerter({
    telegramBotToken:'123456:' + 'x'.repeat(36),telegramChatId:'222222'
  });
  failing.bot={sendMessage:async()=>{throw Error('AUDIT_STUB_SEND_FAILURE')}};
  const response = await failing.sendAlert({type:'bot_log',message:'6h audit summary'});
  assert.equal(response,undefined);
  console.log('REPRODUCED: Telegram send failure is logged but resolves without delivery status');

  console.log('TELEGRAM AUDIT REPRODUCTIONS PASS (NO NETWORK CALLS)');
}
main().catch(e=>{console.error(e);process.exitCode=1});
