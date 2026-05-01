/**
 * AMM Events Scanner
 * Detects AMMCreate, AMMDeposit, AMMWithdraw events
 */

import { XRPLClient } from '../xrpl/client';
import { AMMPool, TxEvent } from '../types';
import { info, debug, warn } from '../utils/logger';
import { Database } from '../db/database';

export class AMMScanner {
  private xrplClient: XRPLClient;
  private db: Database;
  private trackedPools: Map<string, AMMPool> = new Map();

  constructor(xrplClient: XRPLClient, db: Database) {
    this.xrplClient = xrplClient;
    this.db = db;
  }

  /**
   * Initialize by loading existing pools from DB
   */
  async initialize(): Promise<void> {
    const existingPools = this.db.getAMMPools();
    for (const pool of existingPools) {
      this.trackedPools.set(pool.poolId, pool);
    }
    info(`Loaded ${this.trackedPools.size} AMM pools from database`);
  }

  /**
   * Process a transaction to detect AMM events
   */
  async processTransaction(tx: any): Promise<{ type: string; pool?: AMMPool } | null> {
    try {
      const txType = tx.tx?.TransactionType || tx.transaction?.TransactionType;
      if (!txType) return null;

      switch (txType) {
        case 'AMMCreate':
          return await this.handleAMMCreate(tx);
        case 'AMMDeposit':
          return await this.handleAMMDeposit(tx);
        case 'AMMWithdraw':
          return await this.handleAMMWithdraw(tx);
        case 'AMMTrade':
          return await this.handleAMMTrade(tx);
        case 'AMMVote':
          return await this.handleAMMVote(tx);
        default:
          return null;
      }
    } catch (err) {
      warn(`Error processing AMM transaction: ${err}`);
      return null;
    }
  }

  /**
   * Handle AMMCreate - new liquidity pool
   */
  private async handleAMMCreate(tx: any): Promise<{ type: string; pool?: AMMPool } | null> {
    const transaction = tx.tx_json || tx.tx || tx.transaction;
    if (!transaction) return null;

    const asset = transaction.Asset;
    const asset2 = transaction.Asset2;

    if (!asset || !asset2) return null;

    // Build pool ID from the two assets
    const poolId = this.buildPoolId(asset, asset2);

    // Check if already tracked
    if (this.trackedPools.has(poolId)) {
      return { type: 'existing_pool' };
    }

    // Get initial amounts from Amount and Amount2 fields
    const amount1 = transaction.Amount || '0';
    const amount2 = transaction.Amount2 || '0';

    const pool: AMMPool = {
      asset1: this.normalizeAsset(asset),
      asset2: this.normalizeAsset(asset2),
      amount1: typeof amount1 === 'string' ? amount1 : JSON.stringify(amount1),
      amount2: typeof amount2 === 'string' ? amount2 : JSON.stringify(amount2),
      lpBalance: '0', // Will be updated from AMM info
      tradingFee: transaction.TradingFee || 0,
      poolId,
      createdAt: Date.now(),
      lastUpdated: Date.now(),
    };

    this.trackedPools.set(poolId, pool);
    this.db.saveAMMPool(pool);

    info(`🏊 New AMM pool created: ${poolId}`);
    debug(`AMMCreate: Asset1=${JSON.stringify(asset)}, Asset2=${JSON.stringify(asset2)}`);

    return { type: 'new_pool', pool };
  }

  /**
   * Handle AMMDeposit - liquidity added
   */
  private async handleAMMDeposit(tx: any): Promise<{ type: string; pool?: AMMPool } | null> {
    const transaction = tx.tx_json || tx.tx || tx.transaction;
    if (!transaction) return null;

    const asset = transaction.Asset;
    const asset2 = transaction.Asset2;

    if (!asset || !asset2) return null;

    const poolId = this.buildPoolId(asset, asset2);
    const existingPool = this.trackedPools.get(poolId);

    if (existingPool) {
      existingPool.lastUpdated = Date.now();
      this.trackedPools.set(poolId, existingPool);
      this.db.updateAMMPool(existingPool);
      return { type: 'liquidity_added', pool: existingPool };
    }

    // Pool not tracked yet - fetch full info
    const ammInfo = await this.xrplClient.getAMMInfo(
      this.normalizeAsset(asset),
      this.normalizeAsset(asset2)
    );

    if (ammInfo) {
      const pool = this.parseAMMInfo(ammInfo, asset, asset2);
      this.trackedPools.set(poolId, pool);
      this.db.saveAMMPool(pool);
      return { type: 'liquidity_added', pool };
    }

    return { type: 'liquidity_added_unknown' };
  }

  /**
   * Handle AMMWithdraw - liquidity removed
   */
  private async handleAMMWithdraw(tx: any): Promise<{ type: string; pool?: AMMPool } | null> {
    const transaction = tx.tx_json || tx.tx || tx.transaction;
    if (!transaction) return null;

    const asset = transaction.Asset;
    const asset2 = transaction.Asset2;

    if (!asset || !asset2) return null;

    const poolId = this.buildPoolId(asset, asset2);
    const existingPool = this.trackedPools.get(poolId);

    // Fetch current state to detect liquidity change
    const ammInfo = await this.xrplClient.getAMMInfo(
      this.normalizeAsset(asset),
      this.normalizeAsset(asset2)
    );

    if (ammInfo && existingPool) {
      const prevLiquidity = parseFloat(existingPool.amount1);
      const newPool = this.parseAMMInfo(ammInfo, asset, asset2);

      // Detect significant liquidity removal (>20%)
      const newLiquidity = parseFloat(newPool.amount1);
      if (prevLiquidity > 0 && newLiquidity < prevLiquidity * 0.8) {
        info(`⚠️ Significant liquidity removed from pool ${poolId}`);
        return { type: 'liquidity_removed', pool: newPool };
      }

      this.trackedPools.set(poolId, newPool);
      this.db.updateAMMPool(newPool);
      return { type: 'liquidity_withdrawn', pool: newPool };
    }

    return { type: 'liquidity_withdrawn_unknown' };
  }

  /**
   * Handle AMMTrade - swap event
   */
  private async handleAMMTrade(tx: any): Promise<{ type: string; pool?: AMMPool } | null> {
    // AMM trades are also captured as Payment transactions
    // This handler is for additional metadata if needed
    return { type: 'amm_trade' };
  }

  /**
   * Handle AMMVote - trading fee vote
   */
  private async handleAMMVote(tx: any): Promise<{ type: string; pool?: AMMPool } | null> {
    return { type: 'amm_vote' };
  }

  /**
   * Build a unique pool ID from two assets
   */
  private buildPoolId(asset1: any, asset2: any): string {
    const a1 = this.normalizeAsset(asset1);
    const a2 = this.normalizeAsset(asset2);

    // Sort to ensure consistent ID regardless of order
    const key1 = `${a1.currency}:${a1.issuer || 'XRP'}`;
    const key2 = `${a2.currency}:${a2.issuer || 'XRP'}`;

    return [key1, key2].sort().join('|');
  }

  /**
   * Normalize asset object
   */
  private normalizeAsset(asset: any): { currency: string; issuer?: string } {
    if (typeof asset === 'string') {
      return { currency: 'XRP' };
    }
    return {
      currency: asset.currency,
      issuer: asset.issuer,
    };
  }

  /**
   * Parse AMM info response into AMMPool
   */
  private parseAMMInfo(ammInfo: any, asset1: any, asset2: any): AMMPool {
    const poolId = this.buildPoolId(asset1, asset2);

    return {
      asset1: this.normalizeAsset(asset1),
      asset2: this.normalizeAsset(asset2),
      amount1: ammInfo.amount?.value || ammInfo.amount || '0',
      amount2: ammInfo.amount2?.value || ammInfo.amount2 || '0',
      lpBalance: ammInfo.lp_balance || '0',
      tradingFee: ammInfo.trading_fee || 0,
      poolId,
      createdAt: Date.now(),
      lastUpdated: Date.now(),
    };
  }

  /**
   * Get all tracked pools
   */
  getTrackedPools(): AMMPool[] {
    return Array.from(this.trackedPools.values());
  }

  /**
   * Get pool count
   */
  getPoolCount(): number {
    return this.trackedPools.size;
  }

  /**
   * Find pool by token
   */
  findPoolByToken(currency: string, issuer: string): AMMPool | null {
    for (const pool of this.trackedPools.values()) {
      if (
        (pool.asset1.currency === currency && pool.asset1.issuer === issuer) ||
        (pool.asset2.currency === currency && pool.asset2.issuer === issuer)
      ) {
        return pool;
      }
    }
    return null;
  }
}
