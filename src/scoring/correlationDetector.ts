/**
 * Correlation Detector
 * Identifies coordinated pumps and correlated token movements
 */

import { info, warn } from '../utils/logger';

interface TokenMovement {
  currency: string;
  issuer: string;
  priceChange: number;
  timestamp: number;
  volume: number;
}

interface PumpCluster {
  issuer: string;
  tokens: string[];
  startTime: number;
  avgGain: number;
  tokenCount: number;
}

export class CorrelationDetector {
  private recentMovements: TokenMovement[] = [];
  private readonly WINDOW_MS = 60 * 60 * 1000; // 1 hour window
  private readonly MAX_MOVEMENTS = 1000;
  private readonly MIN_CLUSTER_SIZE = 3; // Min tokens from same issuer to flag
  private readonly MIN_GAIN_PERCENT = 20; // Min gain to consider significant

  /**
   * Record a token price movement
   */
  recordMovement(currency: string, issuer: string, priceChange: number, volume: number): void {
    this.recentMovements.push({
      currency,
      issuer,
      priceChange,
      timestamp: Date.now(),
      volume,
    });

    // Prune old movements
    if (this.recentMovements.length > this.MAX_MOVEMENTS) {
      this.recentMovements.splice(0, this.recentMovements.length - this.MAX_MOVEMENTS);
    }

    this.pruneOldMovements();
  }

  /**
   * Check for coordinated pump patterns
   * Returns clusters of tokens from same issuer pumping simultaneously
   */
  detectPumpClusters(): PumpCluster[] {
    const now = Date.now();
    const clusters: Map<string, PumpCluster> = new Map();

    // Group significant gains by issuer
    for (const movement of this.recentMovements) {
      if (movement.priceChange < this.MIN_GAIN_PERCENT) continue;

      let cluster = clusters.get(movement.issuer);
      if (!cluster) {
        cluster = {
          issuer: movement.issuer,
          tokens: [],
          startTime: movement.timestamp,
          avgGain: 0,
          tokenCount: 0,
        };
        clusters.set(movement.issuer, cluster);
      }

      cluster.tokens.push(movement.currency);
      cluster.tokenCount++;
      cluster.avgGain = (cluster.avgGain * (cluster.tokenCount - 1) + movement.priceChange) / cluster.tokenCount;
      cluster.startTime = Math.min(cluster.startTime, movement.timestamp);
    }

    // Filter to only significant clusters
    return Array.from(clusters.values())
      .filter(c => c.tokenCount >= this.MIN_CLUSTER_SIZE && c.avgGain >= this.MIN_GAIN_PERCENT)
      .sort((a, b) => b.avgGain - a.avgGain);
  }

  /**
   * Check if a specific token is part of a suspicious cluster
   */
  isInSuspiciousCluster(currency: string, issuer: string): boolean {
    const clusters = this.detectPumpClusters();
    return clusters.some(c =>
      c.issuer === issuer && c.tokens.includes(currency)
    );
  }

  /**
   * Get correlation warning message for a token
   */
  getCorrelationWarning(currency: string, issuer: string): string | null {
    const clusters = this.detectPumpClusters();
    const matchingCluster = clusters.find(c =>
      c.issuer === issuer && c.tokens.includes(currency)
    );

    if (!matchingCluster) return null;

    return `⚠️ CORRELATED PUMP: ${matchingCluster.tokenCount} tokens from same issuer pumping (avg +${matchingCluster.avgGain.toFixed(0)}%). Possible coordinated manipulation.`;
  }

  /**
   * Detect wash trading patterns (same wallet buying/selling repeatedly)
   */
  detectWashTrading(uniqueBuyers: number, uniqueSellers: number, buyVolume: number, sellVolume: number): boolean {
    // Wash trading indicators:
    // 1. Very few unique participants relative to volume
    // 2. Similar buy/sell volumes (circular trading)
    // 3. Low unique buyer/seller count

    if (uniqueBuyers === 0 && uniqueSellers === 0) return false;

    const totalUnique = uniqueBuyers + uniqueSellers;
    const totalVolume = buyVolume + sellVolume;

    // If volume is high but unique participants is very low, suspicious
    if (totalVolume > 100 && totalUnique <= 2) {
      return true;
    }

    // If buy and sell volumes are very similar (within 10%) and low unique count
    if (totalUnique <= 3 && buyVolume > 0 && sellVolume > 0) {
      const volumeRatio = Math.abs(buyVolume - sellVolume) / Math.max(buyVolume, sellVolume);
      if (volumeRatio < 0.1) {
        return true;
      }
    }

    return false;
  }

  /**
   * Prune movements outside the time window
   */
  private pruneOldMovements(): void {
    const cutoff = Date.now() - this.WINDOW_MS;
    this.recentMovements = this.recentMovements.filter(m => m.timestamp > cutoff);
  }

  /**
   * Get summary of detected correlations
   */
  getSummary(): { clusterCount: number; suspiciousIssuers: string[] } {
    const clusters = this.detectPumpClusters();
    return {
      clusterCount: clusters.length,
      suspiciousIssuers: clusters.map(c => c.issuer),
    };
  }
}
