/**
 * TradeDecisionEngine
 *
 * Single authoritative gate for ALL trade entry decisions.
 * Used by paper, dry-run, and live paths.
 *
 * Responsibilities:
 *   1. Select profile (BURST_SCALP / MOMENTUM_RUNNER / LOW_LIQ_PROBE / WAKEUP_TRADE)
 *   2. Run preflight checks (blocklist, slippage, round-trip loss, daily loss, etc.)
 *   3. Calculate dynamic size
 *   4. Return a DecisionResult — callers never bypass these checks
 *
 * Live-only checks (trustline, wallet balance, AMM source confirmation) are
 * enforced here when mode=LIVE and surfaced as REJECTED reasons otherwise.
 */

import * as xrpl from 'xrpl';
import { BotConfig } from '../config';
import { MarketSnapshot } from '../types';
import { info, warn, debug } from '../utils/logger';
import {
  TradeProfile,
  TradeProfileName,
  PROFILES,
  calcProfileSize,
  estimateRoundTripLossPct,
} from './tradeProfiles';

export type DecisionOutcome = 'APPROVED' | 'REJECTED' | 'DRY_RUN';

export interface DecisionResult {
  outcome: DecisionOutcome;
  profile: TradeProfile;
  sizeXRP: number;
  slippage: number;
  roundTripLossPct: number;
  rejectReason?: string;
  /** Populated only for live mode after trustline check */
  trustlineReady?: boolean;
}

export interface DecisionInput {
  currency: string;
  issuer: string;
  rawCurrency?: string;
  /** Snapshot including poolXrpReserve (XRP side of AMM, not TVL) */
  snapshot: MarketSnapshot & { poolXrpReserve?: number };
  signalType: 'burst' | 'scored' | 'stream' | 'wakeup' | 'whale_burst' | 'whale_stream';
  signalScore: number;
  /** Current bankroll available */
  bankrollXRP: number;
  /** Open position count */
  openPositions: number;
  /** Daily P&L (negative = loss) */
  dailyPnL: number;
  /** Set of open position keys "currency:issuer" */
  openPositionKeys: Set<string>;
  /** Blocklisted currencies */
  blocklist: Set<string>;
  /** For live mode only */
  walletAddress?: string;
  walletXrpBalance?: number;
  wsUrl?: string;
  walletSeed?: string;
}

export class TradeDecisionEngine {
  private config: BotConfig;

  constructor(config: BotConfig) {
    this.config = config;
  }

  async decide(input: DecisionInput): Promise<DecisionResult> {
    const profile = this.selectProfile(input);

    // ── 1. Blocklist checks ────────────────────────────────────────────────
    const decodedCurrency = this.decodeCurrency(input.rawCurrency || input.currency);
    if (input.blocklist.has(input.currency) || input.blocklist.has(decodedCurrency)) {
      return this.reject(profile, 0, 0, `Token blocklisted: ${input.currency}`);
    }

    // ── 2. Duplicate trade guard ───────────────────────────────────────────
    const posKey = `${input.currency}:${input.issuer}`;
    if (input.openPositionKeys.has(posKey)) {
      return this.reject(profile, 0, 0, `Already have open position: ${posKey}`);
    }

    // ── 3. Open position cap ───────────────────────────────────────────────
    if (input.openPositions >= this.config.maxOpenTrades) {
      return this.reject(profile, 0, 0, `Max open trades (${this.config.maxOpenTrades}) reached`);
    }

    // ── 4. Daily loss limit ────────────────────────────────────────────────
    if (input.dailyPnL <= -this.config.maxDailyLossXRP) {
      return this.reject(profile, 0, 0, `Daily loss limit hit (${input.dailyPnL.toFixed(2)} XRP)`);
    }

    // ── 5. Price / liquidity sanity ────────────────────────────────────────
    const priceXRP = input.snapshot.priceXRP;
    if (!priceXRP || priceXRP <= 0) {
      return this.reject(profile, 0, 0, 'No valid price');
    }
    // Reject tokens with suspiciously round/extreme prices that indicate a
    // misconfigured or USDC-denominated pool — these cause force_close_no_price.
    // A real meme token at exactly 0.00000000 XRP is a dead pool.
    const priceStr = priceXRP.toFixed(8);
    if (priceStr === '0.00000000') {
      return this.reject(profile, 0, 0, 'Zero-price token (dead/misconfigured pool)');
    }

    const poolXrpReserve = input.snapshot.poolXrpReserve
      ?? (input.snapshot.liquidityXRP ? input.snapshot.liquidityXRP / 2 : 0);

    // Whale signals get a relaxed min-pool threshold — a 90%+ WR whale buying a
    // 300 XRP pool is more informative than a 0% WR signal on a 1000 XRP pool.
    const isWhaleSignal = input.signalType === 'whale_burst' || input.signalType === 'whale_stream';
    const whaleWR       = (input.snapshot as any).whaleWinRate ?? 0;
    const effectiveMinPool = isWhaleSignal
      ? Math.max(300, profile.minPoolXrpReserve * (whaleWR >= 85 ? 0.4 : 0.6))
      : profile.minPoolXrpReserve;

    if (poolXrpReserve < effectiveMinPool) {
      return this.reject(profile, 0, 0,
        `Pool too shallow: ${poolXrpReserve.toFixed(0)} XRP < ${effectiveMinPool.toFixed(0)} XRP`);
    }

    // ── 6. Dynamic sizing ──────────────────────────────────────────────────
    const sizeXRP = calcProfileSize(profile, poolXrpReserve, input.bankrollXRP);

    if (sizeXRP < this.config.minTradeXRP) {
      return this.reject(profile, sizeXRP, 0,
        `Size too small: ${sizeXRP.toFixed(2)} XRP < minTradeXRP ${this.config.minTradeXRP}`);
    }

    if (input.bankrollXRP < sizeXRP) {
      return this.reject(profile, sizeXRP, 0,
        `Insufficient bankroll: ${input.bankrollXRP.toFixed(2)} XRP < ${sizeXRP.toFixed(2)} XRP`);
    }

    // ── 7. Slippage check (uses poolXrpReserve, not TVL) ──────────────────
    const slippage = sizeXRP / (poolXrpReserve + sizeXRP); // CPMM formula
    if (slippage > profile.maxSlippage) {
      return this.reject(profile, sizeXRP, slippage,
        `Slippage too high: ${(slippage * 100).toFixed(2)}% > ${(profile.maxSlippage * 100).toFixed(1)}%`);
    }

    // ── 8. Round-trip loss check ───────────────────────────────────────────
    const roundTripLossPct = estimateRoundTripLossPct(slippage);
    if (roundTripLossPct > profile.maxRoundTripLossPct) {
      return this.reject(profile, sizeXRP, slippage,
        `Round-trip loss too high: ${roundTripLossPct.toFixed(2)}% > ${profile.maxRoundTripLossPct}%`);
    }

    // ── 9. Dry-run mode: all checks passed but no real tx ─────────────────
    const isLiveMode = this.config.mode === ('LIVE' as any) || false;
    const liveEnabled = this.config.liveTrading;
    const seedSet = !!process.env.TRADING_WALLET_SEED;

    if (!isLiveMode || !liveEnabled || !seedSet) {
      debug(`[TDE] DRY_RUN approved: ${posKey} profile=${profile.name} size=${sizeXRP.toFixed(2)} slip=${(slippage*100).toFixed(2)}%`);
      return { outcome: 'DRY_RUN', profile, sizeXRP, slippage, roundTripLossPct };
    }

    // ── 10. LIVE preflight ─────────────────────────────────────────────────
    const liveChecks = await this.runLivePreflight(input, sizeXRP, slippage);
    if (!liveChecks.ok) {
      return this.reject(profile, sizeXRP, slippage, `Live preflight failed: ${liveChecks.reason}`);
    }

    info(`[TDE] APPROVED LIVE: ${posKey} profile=${profile.name} size=${sizeXRP.toFixed(2)} slip=${(slippage*100).toFixed(2)}%`);
    return {
      outcome: 'APPROVED',
      profile,
      sizeXRP,
      slippage,
      roundTripLossPct,
      trustlineReady: liveChecks.trustlineReady,
    };
  }

  // ── Profile selection ──────────────────────────────────────────────────────

  private selectProfile(input: DecisionInput): TradeProfile {
    const pool = input.snapshot.poolXrpReserve
      ?? (input.snapshot.liquidityXRP ? input.snapshot.liquidityXRP / 2 : 0);

    if (input.signalType === 'burst') {
      return pool < 500 ? PROFILES.LOW_LIQ_PROBE : PROFILES.BURST_SCALP;
    }

    if (input.signalType === 'wakeup') {
      return PROFILES.WAKEUP_TRADE;
    }

    // scored / stream
    if (pool < 500) return PROFILES.LOW_LIQ_PROBE;
    if (pool >= 2000) return PROFILES.MOMENTUM_RUNNER;
    return PROFILES.BURST_SCALP;
  }

  // ── Live preflight ─────────────────────────────────────────────────────────

  private async runLivePreflight(
    input: DecisionInput,
    sizeXRP: number,
    slippage: number
  ): Promise<{ ok: boolean; reason?: string; trustlineReady?: boolean }> {

    if (!input.wsUrl || !input.walletSeed || !input.walletAddress) {
      return { ok: false, reason: 'Missing wallet config for live trading' };
    }

    // Wallet XRP balance sufficient (entry + reserve buffer)
    const RESERVE_BUFFER = 10; // keep 10 XRP for reserves/fees
    if ((input.walletXrpBalance ?? 0) < sizeXRP + RESERVE_BUFFER) {
      return {
        ok: false,
        reason: `Wallet balance too low: ${(input.walletXrpBalance ?? 0).toFixed(2)} XRP (need ${(sizeXRP + RESERVE_BUFFER).toFixed(2)})`,
      };
    }

    // Trustline check and create if missing
    const trustlineOk = await this.ensureTrustline(
      input.wsUrl, input.walletSeed, input.walletAddress,
      input.currency, input.rawCurrency || input.currency, input.issuer
    );
    if (!trustlineOk) {
      return { ok: false, reason: `Trustline not established for ${input.currency}:${input.issuer}` };
    }

    return { ok: true, trustlineReady: true };
  }

  // ── Trustline helpers ──────────────────────────────────────────────────────

  /**
   * Check if the trading wallet has a trustline to the given token issuer.
   * If missing, submit a TrustSet and wait for validation.
   * Returns true if trustline is confirmed (existing or newly created).
   */
  async ensureTrustline(
    wsUrl: string,
    seed: string,
    walletAddress: string,
    currency: string,
    rawCurrency: string,
    issuer: string
  ): Promise<boolean> {
    const client = new xrpl.Client(wsUrl);
    try {
      await client.connect();

      // Check existing trustlines
      const accountLines = await client.request({
        command: 'account_lines',
        account: walletAddress,
        peer: issuer,
        ledger_index: 'validated',
      });

      const lines = (accountLines.result as any).lines ?? [];
      const existing = lines.find(
        (l: any) => l.currency === rawCurrency && l.account === issuer
      );
      if (existing) {
        debug(`[TDE] Trustline exists for ${currency}:${issuer}`);
        return true;
      }

      // Trustline missing — create it
      info(`[TDE] Creating trustline for ${currency}:${issuer}...`);
      const wallet = xrpl.Wallet.fromSeed(seed);

      const trustSet: xrpl.TrustSet = {
        TransactionType: 'TrustSet',
        Account: walletAddress,
        LimitAmount: {
          currency: rawCurrency,
          issuer,
          value: '1000000000', // very high limit — we're the buyer
        },
        Flags: 0,
      };

      const prepared = await client.autofill(trustSet);
      const signed = wallet.sign(prepared);
      const result = await client.submitAndWait(signed.tx_blob);

      const txResult = typeof result.result.meta === 'object'
        ? (result.result.meta as any).TransactionResult
        : 'unknown';

      if (txResult === 'tesSUCCESS') {
        info(`[TDE] Trustline created for ${currency}:${issuer} — hash: ${signed.hash}`);
        return true;
      }

      warn(`[TDE] TrustSet failed for ${currency}:${issuer}: ${txResult}`);
      return false;

    } catch (err: any) {
      warn(`[TDE] Trustline check/create error: ${err?.message}`);
      return false;
    } finally {
      await client.disconnect().catch(() => {});
    }
  }

  // ── Metadata parsing ───────────────────────────────────────────────────────

  /**
   * Parse actual wallet balance changes from transaction metadata.
   * Reliable — reads ledger state directly rather than guessing from offer fields.
   *
   * For a BUY (spending XRP to receive tokens):
   *   - walletAddress AccountRoot balance decreases → xrpSpent
   *   - RippleState where walletAddress is LowLimit.account: balance increases → tokensReceived
   *     (when walletAddress is HighLimit.account the sign is negated — we handle both)
   *
   * For a SELL (spending tokens to receive XRP):
   *   - walletAddress AccountRoot balance increases → xrpReceived
   *   - RippleState balance decreases → tokensSold
   */
  static parseMetadata(
    meta: any,
    walletAddress: string,
    tokenCurrency: string,
    tokenIssuer: string
  ): {
    xrpDelta: number;       // positive = received XRP, negative = spent XRP
    tokenDelta: number;     // positive = received tokens, negative = sold tokens
  } {
    let xrpDelta = 0;
    let tokenDelta = 0;

    const nodes: any[] = meta?.AffectedNodes ?? [];

    for (const node of nodes) {
      const n = node.ModifiedNode ?? node.CreatedNode ?? node.DeletedNode;
      if (!n) continue;

      // ── XRP balance change for our wallet ──────────────────────────────
      if (n.LedgerEntryType === 'AccountRoot') {
        const account = n.FinalFields?.Account ?? n.NewFields?.Account;
        if (account !== walletAddress) continue;

        const prevBal = parseInt(n.PreviousFields?.Balance ?? '0', 10);
        const currBal = parseInt(
          n.FinalFields?.Balance ?? n.NewFields?.Balance ?? '0', 10
        );
        xrpDelta += (currBal - prevBal) / 1_000_000;
      }

      // ── Token balance change via trustline ─────────────────────────────
      if (n.LedgerEntryType === 'RippleState') {
        const fields = n.FinalFields ?? n.NewFields ?? {};
        const prevFields = n.PreviousFields ?? {};

        // RippleState encodes balance from LowLimit account's perspective.
        // Positive balance = LowLimit account holds tokens.
        const lowAccount  = fields.LowLimit?.issuer;
        const highAccount = fields.HighLimit?.issuer;
        const stateIssuer = lowAccount === tokenIssuer ? highAccount : lowAccount;
        const stateCurrency = fields.Balance?.currency
          ?? fields.LowLimit?.currency
          ?? fields.HighLimit?.currency;

        if (stateCurrency !== tokenCurrency && stateCurrency !== (tokenCurrency.padEnd(40, '0'))) continue;
        if (stateIssuer !== tokenIssuer && lowAccount !== tokenIssuer && highAccount !== tokenIssuer) continue;

        const prevVal = parseFloat(prevFields.Balance?.value ?? prevFields.Balance ?? '0');
        const currVal = parseFloat(fields.Balance?.value ?? fields.Balance ?? '0');
        let delta = currVal - prevVal;

        // If walletAddress is the HighLimit account, balance sign is negated
        if (highAccount === walletAddress) delta = -delta;
        else if (lowAccount !== walletAddress) continue; // not our wallet

        tokenDelta += delta;
      }
    }

    return { xrpDelta, tokenDelta };
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private reject(
    profile: TradeProfile,
    sizeXRP: number,
    slippage: number,
    reason: string
  ): DecisionResult {
    debug(`[TDE] REJECTED: ${reason}`);
    return { outcome: 'REJECTED', profile, sizeXRP, slippage, roundTripLossPct: 0, rejectReason: reason };
  }

  private decodeCurrency(raw: string): string {
    if (!raw || raw.length !== 40) return raw || '';
    try {
      const stripped = raw.replace(/00+$/, '');
      const decoded = Buffer.from(stripped, 'hex').toString('ascii').replace(/\x00/g, '');
      return /^[\x20-\x7E]+$/.test(decoded) && decoded.length > 0 ? decoded : raw;
    } catch { return raw; }
  }
}
