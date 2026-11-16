#!/usr/bin/env node
/**
 * Isolated accounting reproducibility audit. Uses disposable /tmp SQLite DB.
 * NEVER reads the real bot DB, wallet, or submits any transactions.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Database } = require('../dist/db/database');
const { PaperTrader } = require('../dist/paper/paperTrader');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hunterix-audit-'));
const dbPath = path.join(tmp, 'paper-audit.db');
const cfg = {
  mode: 'PAPER', startingBankrollXRP: 100, minTradeXRP: 5,
  maxTradeXRP: 25, maxOpenTrades: 5, maxDailyLossXRP: 30
};
const snap = {
  tokenCurrency: 'AUDIT', tokenIssuer: 'rDisposableTestIssuer',
  priceXRP: 1, poolXrpReserve: 5000, liquidityXRP: 10000,
  buyCount5m: 5, sellCount5m: 1, uniqueBuyers5m: 4,
  timestamp: Date.now()
};
function closeEnough(a, b) { return Math.abs(a - b) < 1e-8; }
function main() {
  const db = new Database(dbPath);
  try {
    const paper = new PaperTrader(cfg, db);
    const t = paper.tryOpenBurstTrade(
      { currency: 'AUDIT', issuer: snap.tokenIssuer, rawCurrency: '4155444954000000000000000000000000000000', firstSeen: Date.now(), lastUpdated: Date.now() },
      snap, 'ACCOUNTING_AUDIT', undefined, 5
    );
    if (!t) throw Error('Failed to create isolated PAPER trade');
    const key = 'AUDIT:' + snap.tokenIssuer;
    const originalTokens = paper.openPositions.get(key).tokensHeld;
    paper.partialClose(key, 1.20, 40, 'take_profit_1', { ...snap, priceXRP: 1.20 });
    const originalRemaining = paper.openPositions.get(key).tokensHeld;
    const recordedPercent = t.remainingPosition;
    console.log('\nBEFORE RESTART');
    console.log('Original tokens: ' + originalTokens.toFixed(6));
    console.log('After 40% sale, physically remaining tokens: ' + originalRemaining.toFixed(6));
    console.log('Remaining percent: ' + recordedPercent);
    const reopened = new PaperTrader(cfg, db);
    const reopenedTokens = reopened.openPositions.get(key).tokensHeld;
    console.log('\nAFTER SIMULATED RESTART');
    console.log('Reconstructed tokens: ' + reopenedTokens.toFixed(6));
    console.log('Actual remaining: ' + originalRemaining.toFixed(6));
    console.log('Token inventory restored correctly: ' + closeEnough(reopenedTokens, originalRemaining));
    console.log('Reconstructed available bankroll: ' + reopened.getState().bankrollXRP);
    console.log('Pre-restart bankroll after partial proceeds: ' + paper.getState().bankrollXRP);
    console.log('Cash state restored correctly: ' +
      closeEnough(reopened.getState().bankrollXRP, paper.getState().bankrollXRP));
    console.log('\nFINAL SELL WITHOUT RESTART');
    // Confirm inconsistent remaining-percent multiplication on the original object.
    // The current closePosition implementation scales already-reduced tokensHeld AGAIN.
    const tokensActuallySoldByCode = originalRemaining * recordedPercent / 100;
    console.log('Sellable remaining tokens: ' + originalRemaining.toFixed(6));
    console.log('Tokens used by current final-close formula: ' + tokensActuallySoldByCode.toFixed(6));
    console.log('Final sale uses full remaining inventory: ' +
      closeEnough(tokensActuallySoldByCode, originalRemaining));
    console.log('\nAUDIT ONLY: reproduced against disposable DB; real trades unchanged.');
  } finally {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
main();
