/**
 * Token Discovery Module
 * Detects new tokens, trustlines, and early DEX activity
 */

import { XRPLClient } from '../xrpl/client';
import { TrackedToken, TxEvent } from '../types';
import { info, debug, warn } from '../utils/logger';
import { Database } from '../db/database';


// Discovery has no automatic permanent blacklist. XRP itself is the native
// balance and is not an issued token, but *issued* tokens with similar labels
// are evaluated on live liquidity/market conditions.

export class TokenDiscovery {
  private xrplClient: XRPLClient;
  private db: Database;
  private trackedTokens: Map<string, TrackedToken> = new Map();
  private knownIssuers: Set<string> = new Set();

  // FIX #12: Simple issuer reputation tracking
  private issuerTrustSetCounts: Map<string, number> = new Map(); // How many tokens an issuer has created
  private readonly SPAM_THRESHOLD = 50; // Flag issuers with 50+ tokens as potential spammers

  constructor(xrplClient: XRPLClient, db: Database) {
    this.xrplClient = xrplClient;
    this.db = db;
  }

  /**
   * Initialize by loading existing tracked tokens from DB
   */
  async initialize(): Promise<void> {
    const existingTokens = this.db.getTrackedTokens();
    for (const token of existingTokens) {
      const key = `${token.currency}:${token.issuer}`;
      this.trackedTokens.set(key, token);
      this.knownIssuers.add(token.issuer);
    }
    info(`Loaded ${this.trackedTokens.size} tracked tokens from database`);
  }

  /**
   * Process a transaction event to detect new tokens
   * FIX #5: Only detect TrustSet transactions, NOT Payment transactions.
   * Payment transactions cause massive false positives from normal token transfers.
   */
  async processTransaction(tx: any): Promise<TrackedToken | null> {
    try {
      const txType = (tx.tx_json || tx.tx || tx.transaction)?.TransactionType;

      if (!txType) return null;

      // Only detect TrustSet transactions (new token trustlines)
      // Removed Payment detection to avoid false positives from established token transfers
      if (txType === 'TrustSet') {
        return await this.handleTrustSet(tx);
      }

      return null;
    } catch (err) {
      warn(`Error processing transaction: ${err}`);
      return null;
    }
  }

  /**
   * Handle TrustSet transaction - detects new token relationships
   */
  private async handleTrustSet(tx: any): Promise<TrackedToken | null> {
    const transaction = tx.tx_json || tx.tx || tx.transaction;
    if (!transaction) return null;

    const limitAmount = transaction.LimitAmount;
    if (!limitAmount || typeof limitAmount !== 'object') return null;

    const currency = limitAmount.currency;
    const issuer = limitAmount.issuer;
    const account = transaction.Account;

    // Skip XRP and blocklisted currencies (stablecoins, non-memes)
    if (currency === 'XRP') return null;
    // Only non-issued native XRP is excluded above; no ecosystem/ticker bans.

    // Skip if issuer is the same as account (self-trustline, rare but possible)
    if (issuer === account) return null;

    const key = `${currency}:${issuer}`;

    // Check if we're already tracking this token
    if (this.trackedTokens.has(key)) {
      // Update last seen timestamp
      const token = this.trackedTokens.get(key)!;
      token.lastUpdated = Date.now();
      this.trackedTokens.set(key, token);
      return null; // Already known
    }

    // FIX #12: Track issuer reputation
    const currentCount = this.issuerTrustSetCounts.get(issuer) || 0;
    this.issuerTrustSetCounts.set(issuer, currentCount + 1);

    const isSpamIssuer = currentCount + 1 >= this.SPAM_THRESHOLD;

    if (isSpamIssuer) {
      warn(`⚠️ Issuer ${issuer} has created ${currentCount + 1} tokens - possible spam`);
    }

    // New token detected!
    const newToken: TrackedToken = {
      currency,
      issuer,
      firstSeen: Date.now(),
      lastUpdated: Date.now(),
    };

    this.trackedTokens.set(key, newToken);
    this.knownIssuers.add(issuer);

    // Save to database
    this.db.saveToken(newToken);

    if (isSpamIssuer) {
      info(`🆕 New token detected (SPAM ISSUER): ${currency} issued by ${issuer}`);
    } else {
      info(`🆕 New token detected: ${currency} issued by ${issuer}`);
    }
    debug(`TrustSet from ${account} for ${currency}.${issuer}`);

    return newToken;
  }

  /**
   * Handle Payment transaction - REMOVED
   * FIX #5: This method caused massive false positives.
   * Every normal transfer of an established token triggered "new token" alerts.
   * Token discovery now relies solely on TrustSet transactions.
   */
  // private async handlePayment(tx: any): Promise<TrackedToken | null> { ... }

  /**
   * Get all currently tracked tokens
   */
  getTrackedTokens(): TrackedToken[] {
    return Array.from(this.trackedTokens.values());
  }

  /**
   * Check if a token is being tracked
   */
  isTracking(currency: string, issuer: string): boolean {
    const key = `${currency}:${issuer}`;
    return this.trackedTokens.has(key);
  }

  /**
   * Manually add a token to tracking (for whitelisting)
   */
  addToken(currency: string, issuer: string): TrackedToken {
    const key = `${currency}:${issuer}`;

    if (this.trackedTokens.has(key)) {
      return this.trackedTokens.get(key)!;
    }

    const token: TrackedToken = {
      currency,
      issuer,
      firstSeen: Date.now(),
      lastUpdated: Date.now(),
    };

    this.trackedTokens.set(key, token);
    this.knownIssuers.add(issuer);
    this.db.saveToken(token);

    info(`Manually added token: ${currency}:${issuer}`);
    return token;
  }

  /**
   * Add a token discovered externally (e.g. from ActiveDiscovery AMM sweep)
   */
  addTrackedToken(token: TrackedToken): boolean {
    const key = `${token.currency}:${token.issuer}`;
    const existing = this.trackedTokens.get(key);
    if (existing) {
      // Older snapshots, manual entries and trending feeds sometimes stored
      // only display "ARMY" (not 40-hex code). Repair THAT missing raw identity
      // when an exact 160-bit currency+issuer has subsequently been supplied.
      // Never replace one valid 160-bit currency with a different token.
      const nextRaw=token.rawCurrency;
      const previousRaw=existing.rawCurrency;
      if (nextRaw && /^[A-Fa-f0-9]{40}$/.test(nextRaw) &&
          (!previousRaw || !/^[A-Fa-f0-9]{40}$/.test(previousRaw))) {
        existing.rawCurrency=nextRaw.toUpperCase();
        existing.lastUpdated=Date.now();
        this.db.saveToken(existing);
        info(`[Discovery] Restored exact raw XRPL issue code for ${token.currency} issuer ${token.issuer.slice(0,11)}…`);
      }
      return false;
    }
    this.trackedTokens.set(key, token);
    this.db.saveToken(token);
    return true;
  }

  /**
   * Get token count
   */
  getTokenCount(): number {
    return this.trackedTokens.size;
  }

  /**
   * FIX #12: Check if an issuer is flagged as spam
   */
  isSpamIssuer(issuer: string): boolean {
    const count = this.issuerTrustSetCounts.get(issuer) || 0;
    return count >= this.SPAM_THRESHOLD;
  }

  /**
   * FIX #12: Get issuer trust set count
   */
  getIssuerTokenCount(issuer: string): number {
    return this.issuerTrustSetCounts.get(issuer) || 0;
  }
}
