/**
 * Issuer Reputation Module
 * Tracks issuer behavior patterns to identify trustworthy vs suspicious token creators
 */

import { info, warn } from '../utils/logger';

interface IssuerStats {
  address: string;
  tokensLaunched: number;
  tokensWithAMM: number;
  tokensRugPulled: number; // Liquidity removed within 24h
  tokensSurvived7d: number; // Tokens still active after 7 days
  avgLiquidityXRP: number;
  firstSeen: number;
  lastUpdated: number;
}

export class IssuerReputation {
  private issuers: Map<string, IssuerStats> = new Map();
  private readonly RUG_PULL_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
  private readonly SURVIVAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

  /**
   * Register a new token launch for an issuer
   */
  registerTokenLaunch(issuer: string, currency: string): void {
    const stats = this.getOrCreateIssuer(issuer);
    stats.tokensLaunched++;
    stats.lastUpdated = Date.now();
  }

  /**
   * Register AMM pool creation for a token
   */
  registerAMMPool(issuer: string, currency: string, liquidityXRP: number): void {
    const stats = this.getOrCreateIssuer(issuer);
    stats.tokensWithAMM++;
    stats.avgLiquidityXRP = (stats.avgLiquidityXRP * (stats.tokensWithAMM - 1) + liquidityXRP) / stats.tokensWithAMM;
    stats.lastUpdated = Date.now();
  }

  /**
   * Register rug pull (liquidity removed within 24h of launch)
   */
  registerRugPull(issuer: string, currency: string): void {
    const stats = this.getOrCreateIssuer(issuer);
    stats.tokensRugPulled++;
    stats.lastUpdated = Date.now();
    warn(`🚨 Rug pull detected for issuer ${issuer} token ${currency}`);
  }

  /**
   * Register token survival past 7 days
   */
  registerSurvival(issuer: string, currency: string): void {
    const stats = this.getOrCreateIssuer(issuer);
    stats.tokensSurvived7d++;
    stats.lastUpdated = Date.now();
  }

  /**
   * Get trust score for an issuer (0-100)
   */
  getTrustScore(issuer: string): number {
    const stats = this.issuers.get(issuer);
    if (!stats || stats.tokensLaunched === 0) return 50; // Neutral for unknown issuers

    let score = 50; // Start neutral

    // Factor 1: AMM creation rate (positive)
    const ammRate = stats.tokensLaunched > 0 ? stats.tokensWithAMM / stats.tokensLaunched : 0;
    score += ammRate * 20; // Up to +20 for 100% AMM rate

    // Factor 2: Rug pull rate (negative)
    const rugRate = stats.tokensLaunched > 0 ? stats.tokensRugPulled / stats.tokensLaunched : 0;
    score -= rugRate * 40; // Up to -40 for 100% rug rate

    // Factor 3: Survival rate (positive)
    const survivalRate = stats.tokensLaunched > 0 ? stats.tokensSurvived7d / stats.tokensLaunched : 0;
    score += survivalRate * 20; // Up to +20 for 100% survival

    // Factor 4: Average liquidity (positive)
    if (stats.avgLiquidityXRP > 10000) score += 10;
    else if (stats.avgLiquidityXRP > 5000) score += 5;
    else if (stats.avgLiquidityXRP < 1000) score -= 5;

    // Clamp to 0-100
    return Math.max(0, Math.min(100, Math.round(score)));
  }

  /**
   * Get issuer stats
   */
  getStats(issuer: string): IssuerStats | null {
    return this.issuers.get(issuer) || null;
  }

  /**
   * Check if issuer is flagged as suspicious
   */
  isSuspicious(issuer: string): boolean {
    const score = this.getTrustScore(issuer);
    return score < 30;
  }

  /**
   * Get or create issuer stats
   */
  private getOrCreateIssuer(issuer: string): IssuerStats {
    let stats = this.issuers.get(issuer);
    if (!stats) {
      stats = {
        address: issuer,
        tokensLaunched: 0,
        tokensWithAMM: 0,
        tokensRugPulled: 0,
        tokensSurvived7d: 0,
        avgLiquidityXRP: 0,
        firstSeen: Date.now(),
        lastUpdated: Date.now(),
      };
      this.issuers.set(issuer, stats);
    }
    return stats;
  }

  /**
   * Get total tracked issuers
   */
  getTrackedCount(): number {
    return this.issuers.size;
  }

  /**
   * Get summary of all issuers
   */
  getSummary(): Array<{ address: string; trustScore: number; tokensLaunched: number; rugPulls: number }> {
    return Array.from(this.issuers.values()).map(stats => ({
      address: stats.address,
      trustScore: this.getTrustScore(stats.address),
      tokensLaunched: stats.tokensLaunched,
      rugPulls: stats.tokensRugPulled,
    })).sort((a, b) => a.trustScore - b.trustScore);
  }
}
