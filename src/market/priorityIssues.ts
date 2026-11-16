/**
 * Explicitly selected high-priority EXISTING XRPL tokens to monitor.
 * A tracking preference is not a buy signal, risk exemption or blacklist.
 * The full issue (currency+issuer) must match; there are many impostor tickers.
 *
 * XRP ARMY contract: verified against publicly linked XRPL.to market record
 * (not against a live validated ledger in this build).
 */
import type { TrackedToken } from '../types';

export const XRP_ARMY = Object.freeze({
  currency: 'ARMY',
  rawCurrency: '41524D5900000000000000000000000000000000',
  issuer: 'rGG3wQ4kUzd7Jnmk1n5NWPZjjut62kCBfC',
});

export const PRIORITY_MONITORED_ISSUES = Object.freeze([XRP_ARMY]);

export function priorityTrackedToken(issue: typeof XRP_ARMY, now: number = Date.now()): TrackedToken {
  return {currency:issue.currency,rawCurrency:issue.rawCurrency,issuer:issue.issuer,
    firstSeen:now,lastUpdated:now};
}
