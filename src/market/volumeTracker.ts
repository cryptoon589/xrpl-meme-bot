/**
 * Volume Tracker Module
 * Tracks real buy/sell volume from Payment and AMMTrade transactions
 */

import { info, debug } from '../utils/logger';

interface TokenVolume {
  buyVolumeXRP: number;
  sellVolumeXRP: number;
  buyCount: number;
  sellCount: number;
  uniqueBuyers: Set<string>;
  uniqueSellers: Set<string>;
  lastReset: number;
}

export class VolumeTracker {
  private volumes: Map<string, TokenVolume> = new Map();
  private readonly WINDOW_MS = 5 * 60 * 1000; // 5 minute window

  /**
   * Process a transaction and update volume stats
   */
  processTransaction(tx: any): void {
    const txType = tx.tx?.TransactionType || tx.transaction?.TransactionType;
    if (!txType) return;

    if (txType === 'Payment') {
      this.handlePayment(tx);
    } else if (txType === 'AMMTrade') {
      this.handleAMMTrade(tx);
    }
  }

  /**
   * Handle Payment transaction
   */
  private handlePayment(tx: any): void {
    const transaction = tx.tx || tx.transaction;
    if (!transaction) return;

    const amount = transaction.Amount;
    const destination = transaction.Destination;
    const account = transaction.Account;

    // Skip XRP-only payments
    if (typeof amount === 'string') return;
    if (!amount.currency || amount.currency === 'XRP') return;

    const key = `${amount.currency}:${amount.issuer}`;
    const volume = this.getOrCreateVolume(key);

    // Determine if this is a buy or sell based on context
    // Simplified: if destination is the issuer, it's a sell (returning tokens)
    // Otherwise it's a buy (receiving tokens)
    const isSell = destination === amount.issuer;

    // Estimate XRP value (simplified - uses token amount as proxy)
    const tokenAmount = parseFloat(amount.value || '0');

    if (isSell) {
      volume.sellVolumeXRP += tokenAmount;
      volume.sellCount++;
      volume.uniqueSellers.add(account);
    } else {
      volume.buyVolumeXRP += tokenAmount;
      volume.buyCount++;
      volume.uniqueBuyers.add(account);
    }
  }

  /**
   * Handle AMMTrade transaction
   */
  private handleAMMTrade(tx: any): void {
    const transaction = tx.tx || tx.transaction;
    if (!transaction) return;

    const asset = transaction.Asset;
    const asset2 = transaction.Asset2;
    const amount = transaction.Amount;
    const amount2 = transaction.Amount2;

    if (!asset || !asset2 || !amount || !amount2) return;

    // Determine which asset is the token (non-XRP)
    let tokenKey: string | null = null;
    let xrpAmount = 0;

    if (asset.currency !== 'XRP') {
      tokenKey = `${asset.currency}:${asset.issuer}`;
      xrpAmount = this.parseAmount(amount2);
    } else if (asset2.currency !== 'XRP') {
      tokenKey = `${asset2.currency}:${asset2.issuer}`;
      xrpAmount = this.parseAmount(amount);
    }

    if (!tokenKey) return;

    const volume = this.getOrCreateVolume(tokenKey);
    const account = transaction.Account;

    // AMMTrade: user sends XRP, receives tokens = buy
    // Or sends tokens, receives XRP = sell
    // Simplified: assume buys for now (can be enhanced with path analysis)
    volume.buyVolumeXRP += xrpAmount;
    volume.buyCount++;
    volume.uniqueBuyers.add(account);
  }

  /**
   * Get volume stats for a token
   */
  getVolume(currency: string, issuer: string): {
    buyVolume: number;
    sellVolume: number;
    buyCount: number;
    sellCount: number;
    uniqueBuyers: number;
    uniqueSellers: number;
  } {
    const key = `${currency}:${issuer}`;
    const volume = this.volumes.get(key);

    if (!volume) {
      return {
        buyVolume: 0,
        sellVolume: 0,
        buyCount: 0,
        sellCount: 0,
        uniqueBuyers: 0,
        uniqueSellers: 0,
      };
    }

    // Check if window has expired
    this.checkReset(volume);

    return {
      buyVolume: volume.buyVolumeXRP,
      sellVolume: volume.sellVolumeXRP,
      buyCount: volume.buyCount,
      sellCount: volume.sellCount,
      uniqueBuyers: volume.uniqueBuyers.size,
      uniqueSellers: volume.uniqueSellers.size,
    };
  }

  /**
   * Get or create volume tracking for a token
   */
  private getOrCreateVolume(key: string): TokenVolume {
    let volume = this.volumes.get(key);
    if (!volume) {
      volume = {
        buyVolumeXRP: 0,
        sellVolumeXRP: 0,
        buyCount: 0,
        sellCount: 0,
        uniqueBuyers: new Set(),
        uniqueSellers: new Set(),
        lastReset: Date.now(),
      };
      this.volumes.set(key, volume);
    }
    return volume;
  }

  /**
   * Reset volume stats if window has expired
   */
  private checkReset(volume: TokenVolume): void {
    const now = Date.now();
    if (now - volume.lastReset >= this.WINDOW_MS) {
      volume.buyVolumeXRP = 0;
      volume.sellVolumeXRP = 0;
      volume.buyCount = 0;
      volume.sellCount = 0;
      volume.uniqueBuyers.clear();
      volume.uniqueSellers.clear();
      volume.lastReset = now;
    }
  }

  /**
   * Parse amount to number
   */
  private parseAmount(amount: any): number {
    if (typeof amount === 'number') return amount;
    if (typeof amount === 'string') {
      const parsed = parseFloat(amount);
      return isNaN(parsed) ? 0 : parsed;
    }
    if (amount && typeof amount === 'object') {
      return this.parseAmount(amount.value || amount.amount || 0);
    }
    return 0;
  }

  /**
   * Get total tracked tokens
   */
  getTrackedCount(): number {
    return this.volumes.size;
  }
}
