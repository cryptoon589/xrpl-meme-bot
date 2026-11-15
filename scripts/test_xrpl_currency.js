#!/usr/bin/env node
// Offline: no XRPL network access, trades, or databases are opened.
const assert = require('node:assert/strict');
const { normalizeIssuedCurrency: normalize } = require('../dist/xrpl/currencyCode');
const { AMMPriceFetcher } = require('../dist/market/ammPriceFetcher');
const { BurstDetector } = require('../dist/scanner/burstDetector');

const hex = text => Buffer.from(text, 'ascii').toString('hex').toUpperCase().padEnd(40, '0');
assert.equal(normalize('PHNIX'), hex('PHNIX'));
assert.equal(normalize('XRPNOMICS'), hex('XRPNOMICS'));
assert.equal(normalize('wNOC'), hex('wNOC'));
assert.equal(normalize('ARMY'), hex('ARMY'));
assert.equal(normalize('USD'), 'USD');
assert.equal(normalize('usd'), 'usd'); // case-sensitive
assert.equal(normalize('LOX'), 'LOX');
assert.equal(normalize(hex('PHNIX').toLowerCase()), hex('PHNIX'));
assert.equal(normalize('XRP'), null);
assert.equal(normalize('X'.repeat(21)), null);
assert.equal(normalize('bad\ncode'), null);

async function main() {
  const requests = [];
  const bookCalls = [];
  const mockClient = {
    getClient() {
      return {
        request: async request => {
          requests.push(request);
          // No pool, but a correctly formatted request reaches the node.
          return { result: {} };
        }
      };
    },
    getBookOffers: async (...args) => { bookCalls.push(args); return null; }
  };

  const fetcher = new AMMPriceFetcher(mockClient);
  await fetcher.getPrice('PHNIX', 'rIssuer1');
  assert.equal(requests.length, 1, 'No redundant invalid-name AMM request');
  assert.equal(requests[0].asset2.currency, hex('PHNIX'));
  assert.equal(bookCalls.length, 2);
  assert.equal(bookCalls[0][1].currency, hex('PHNIX'));
  assert.equal(bookCalls[1][0].currency, hex('PHNIX'));
  requests.length = 0;
  bookCalls.length = 0;
  await fetcher.getPrice('USD', 'rIssuer2');
  assert.deepEqual(requests.map(r => r.asset2.currency), ['USD', hex('USD')],
    'Ambiguous standard 3-char code preserves legacy hex fallback');
  requests.length = 0;

  const db = { getTrackedTokens: () => [
    { currency: 'PHNIX', issuer: 'rIssuer1', firstSeen: Date.now(), lastUpdated: Date.now() },
    { currency: 'ARMY', rawCurrency: hex('ARMY'), issuer: 'rIssuer2', firstSeen: Date.now(), lastUpdated: Date.now() },
    { currency: 'Z'.repeat(21), issuer: 'rIssuer3', firstSeen: Date.now(), lastUpdated: Date.now() }
  ] };
  const detector = new BurstDetector(mockClient, null, db);
  await detector.preloadAMMs();
  assert.deepEqual(requests.map(r => r.asset2.currency), [hex('PHNIX'), hex('ARMY')]);
  console.log('XRPL CURRENCY TEST PASS: valid AMM requests, original hex preserved, unsupported names rejected');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
