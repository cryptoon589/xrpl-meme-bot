/**
 * Burst Detector
 *
 * Fires EARLY alerts by detecting buy-velocity acceleration on ANY token —
 * including established tokens the main scorer hasn't picked up yet (like PERCY).
 *
 * The main scanner's weakness: it only alerts tokens it has scored, and scoring
 * requires being discovered first. A token that already exists but hasn't been
 * seen by this bot session is invisible — until it starts moving.
 *
 * This module watches EVERY OfferCreate and Payment in the live stream.
 * When it sees a BURST (multiple distinct wallets buying the same token
 * within a tight time window), it fires an early alert BEFORE price moves.
 *
 * Why this catches the move early:
 *   - AMM price only moves after buys execute (lagging)
 *   - Wallet accumulation precedes price acceleration by 1-5 minutes
 *   - Detecting 3+ unique wallets buying in 60s == early FOMO signal
 *
 * Thresholds (tuned conservatively to avoid spam):
 *   - BURST_WINDOW_MS: 90 seconds (rolling window for buy clustering)
 *   - MIN_UNIQUE_WALLETS: 3 distinct buyers in window
 *   - MIN_BUY_VOLUME_XRP: 50 XRP total in window (filters micro-dust)
 *   - ALERT_COOLDOWN_MS: 20 minutes per token
 *   - MIN_POOL_XRP: 500 XRP (ignore illiquid tokens)
 *   - MAX_TRACKED_TOKENS: 1000 (memory bound)
 */

import { XRPLClient } from '../xrpl/client';
import { TelegramAlerter } from '../telegram/alerts';
import { Database } from '../db/database';
import { info, warn, debug } from '../utils/logger';

// ─────────────────────────────────────────────
// Tuning knobs — adjust via env or constructor
// ─────────────────────────────────────────────
const BURST_WINDOW_MS      = 90_000;     // rolling window to cluster buys
const MIN_UNIQUE_WALLETS   = 3;          // distinct buyers needed to fire
const MIN_BUY_VOLUME_XRP   = 50;         // total XRP bought in window
const ALERT_COOLDOWN_MS    = 20 * 60_000; // 20 min per token
const MIN_POOL_XRP         = 500;        // ignore pools below this TVL
const MAX_TRACKED_TOKENS   = 1000;       // memory safety cap
const PRICE_FETCH_DELAY_MS = 2_000;      // wait 2s before fetching AMM price

interface BuyEvent {
  wallet: string;
  xrpAmount: number;
  ts: number;
}

interface TokenState {
  rawCurrency: string;
  issuer: string;
  displayName: string;
  buys: BuyEvent[];            // sliding window
  lastAlertTs: number;
  poolXRP: number | null;      // last known XRP side of AMM pool
  baselinePrice: number | null; // price at first burst alert
  lastTrade: number;
}

// Currency codes that are NOT meme tokens
const STABLECOINS = new Set([
  // ASCII codes
  'USD', 'EUR', 'BTC', 'ETH', 'USDT', 'USDC', 'RLUSD', 'CNY', 'GBP', 'JPY', 'SOLO',
  'XRP', 'XAH', 'XLM', 'SGB', 'FLR', 'EVR', 'CSC', 'DRO',
  // Hex-encoded (40-char)
  '524C555344000000000000000000000000000000', // RLUSD
  '5553440000000000000000000000000000000000', // USD
  '5553444300000000000000000000000000000000', // USDC (fixed)
  '5553445400000000000000000000000000000000', // USDT
  '4555520000000000000000000000000000000000', // EUR
  '4254430000000000000000000000000000000000', // BTC
  '4554480000000000000000000000000000000000', // ETH
  '5841480000000000000000000000000000000000', // XAH
  '584C4D0000000000000000000000000000000000', // XLM
  '5347420000000000000000000000000000000000', // SGB
  '464C520000000000000000000000000000000000', // FLR
  '534F4C4F00000000000000000000000000000000', // SOLO
  '4556520000000000000000000000000000000000', // EVR
  '4353430000000000000000000000000000000000', // CSC
  '44524F0000000000000000000000000000000000', // DRO
]);

export class BurstDetector {
  private tokens: Map<string, TokenState> = new Map(); // key = "rawCurrency:issuer"
  /** ammAccount → key (rawCurrency:issuer) — populated lazily */
  private ammToToken: Map<string, string> = new Map();
  private xrplClient: XRPLClient;
  private alerter: TelegramAlerter;
  private db: Database;
  /** Optional callback fired after a confirmed burst — used to open burst paper trades */
  public onBurst?: (currency: string, issuer: string, rawCurrency: string, poolXRP: number, priceXRP: number) => void;

  constructor(xrplClient: XRPLClient, alerter: TelegramAlerter, db: Database) {
    this.xrplClient = xrplClient;
    this.alerter   = alerter;
    this.db        = db;
  }

  // ─────────────────────────────────────────
  // Main entry — call this from the tx stream
  // ─────────────────────────────────────────
  processTransaction(tx: any): void {
    const t    = tx.tx_json || tx.tx || tx.transaction;
    const meta = tx.meta;
    if (!t || !meta || meta.TransactionResult !== 'tesSUCCESS') return;

    // PRIMARY: scan metadata for XRP flowing INTO any known AMM pool account.
    // This catches OfferCreate, Payment, AMMDeposit, and any future tx types.
    this.scanAmmFlows(t, meta);

    // SECONDARY: detect tokens on first encounter via tx fields, then register
    // their AMM account so future txs are caught by scanAmmFlows.
    const txType = t.TransactionType;
    if (txType === 'OfferCreate') this.discoverTokenFromOffer(t, meta);
    else if (txType === 'Payment')  this.discoverTokenFromPayment(t, meta);
  }

  // ─────────────────────────────────────────
  // Universal AMM pool watcher
  // Scans AffectedNodes for any known AMM account gaining XRP.
  // An AMM account gaining XRP == someone bought the token.
  // ─────────────────────────────────────────
  private scanAmmFlows(t: any, meta: any): void {
    const nodes: any[] = meta?.AffectedNodes || [];
    for (const node of nodes) {
      const n = node.ModifiedNode;
      if (!n || n.LedgerEntryType !== 'AccountRoot') continue;

      const acct    = n.FinalFields?.Account || n.FinalFields?.AMMID ? n.FinalFields?.Account : null;
      if (!acct) continue;

      const key = this.ammToToken.get(acct);
      if (!key) continue; // not a tracked AMM account

      // XRP gained by AMM account = token sold into AMM = buyer paid XRP
      const prevBal = parseInt(n.PreviousFields?.Balance ?? '0', 10);
      const currBal = parseInt(n.FinalFields?.Balance  ?? '0', 10);
      const xrpGained = (currBal - prevBal) / 1_000_000;
      if (xrpGained < 0.001) continue; // ignore dust / sells

      const state = this.tokens.get(key);
      if (!state) continue;

      // Attribute the buy to the tx initiator
      const buyer = t.Account || 'unknown';
      debug(`AMM flow: ${state.displayName} gained ${xrpGained.toFixed(4)} XRP from ${buyer}`);
      this.recordBuy(state.rawCurrency, state.issuer, buyer, xrpGained);
    }
  }

  // ─────────────────────────────────────────
  // Token discovery from OfferCreate
  // Extracts currency/issuer so we can look up the AMM account.
  // ─────────────────────────────────────────
  private discoverTokenFromOffer(t: any, meta: any): void {
    const pays = t.TakerPays;
    const gets = t.TakerGets;
    if (!pays || !gets) return;

    // Determine which side is the token
    let rawCurrency: string | null = null;
    let issuer: string | null = null;

    if (typeof pays === 'object' && pays.currency && pays.currency !== 'XRP') {
      rawCurrency = pays.currency; issuer = pays.issuer;
    } else if (typeof gets === 'object' && gets.currency && gets.currency !== 'XRP') {
      rawCurrency = gets.currency; issuer = gets.issuer;
    } else {
      // Try metadata fallback
      const fill = this.extractFillFromMeta(meta);
      if (fill) { rawCurrency = fill.tokenCurrency; issuer = fill.issuer; }
    }

    if (!rawCurrency || !issuer) return;
    if (STABLECOINS.has(rawCurrency) || rawCurrency === 'XRP') return;
    this.ensureAmmRegistered(rawCurrency, issuer);
  }

  // ─────────────────────────────────────────
  // Token discovery from Payment
  // ─────────────────────────────────────────
  private discoverTokenFromPayment(t: any, meta: any): void {
    // Token received by destination = XRP→token payment
    const delivered = meta?.DeliveredAmount || meta?.delivered_amount;
    if (delivered && typeof delivered === 'object' && delivered.currency !== 'XRP') {
      const { currency, issuer } = delivered;
      if (!STABLECOINS.has(currency)) this.ensureAmmRegistered(currency, issuer);
      return;
    }
    // Token in SendMax = token→XRP payment (seller side)
    const sendMax = t.SendMax;
    if (sendMax && typeof sendMax === 'object' && sendMax.currency !== 'XRP') {
      const { currency, issuer } = sendMax;
      if (!STABLECOINS.has(currency)) this.ensureAmmRegistered(currency, issuer);
    }
  }

  // ─────────────────────────────────────────
  // Lazily fetch and cache AMM account for a token
  // ─────────────────────────────────────────
  private ensureAmmRegistered(rawCurrency: string, issuer: string): void {
    const key = `${rawCurrency}:${issuer}`;
    // Already tracking via AMM account
    if (this.tokens.has(key)) return;

    // Init token state
    if (this.tokens.size >= MAX_TRACKED_TOKENS) this.evictOldest();
    const displayName = this.decodeCurrency(rawCurrency);
    this.tokens.set(key, {
      rawCurrency, issuer, displayName,
      buys: [], lastAlertTs: 0, poolXRP: null, baselinePrice: null,
      lastTrade: Date.now(),
    });

    // Async: fetch AMM pool account and register it
    this.fetchAMMAccount(rawCurrency, issuer).then(ammAccount => {
      if (ammAccount) {
        this.ammToToken.set(ammAccount, key);
        debug(`Registered AMM account ${ammAccount} for ${displayName}`);
      }
    }).catch(() => {});
  }

  // ─────────────────────────────────────────
  // Fetch the AMM pool account address for a token
  // ─────────────────────────────────────────
  private async fetchAMMAccount(rawCurrency: string, issuer: string): Promise<string | null> {
    try {
      const client = this.xrplClient.getClient();
      if (!client) return null;
      const res: any = await client.request({
        command: 'amm_info',
        asset:  { currency: 'XRP' },
        asset2: { currency: rawCurrency, issuer },
      });
      return res?.result?.amm?.account ?? null;
    } catch {
      return null;
    }
  }

  // ─────────────────────────────────────────
  // Core: record a buy event and check burst
  // ─────────────────────────────────────────
  private recordBuy(rawCurrency: string, issuer: string, wallet: string, xrpAmount: number): void {
    const key = `${rawCurrency}:${issuer}`;
    const now = Date.now();

    // Token state is always pre-initialised by ensureAmmRegistered or scanAmmFlows
    // but guard anyway
    if (!this.tokens.has(key)) return;

    const state = this.tokens.get(key)!;
    state.lastTrade = now;

    // Add buy event
    state.buys.push({ wallet, xrpAmount, ts: now });

    // Prune events outside the burst window
    const cutoff = now - BURST_WINDOW_MS;
    state.buys = state.buys.filter(e => e.ts >= cutoff);

    // Check if we're in alert cooldown
    if (now - state.lastAlertTs < ALERT_COOLDOWN_MS) return;

    // Evaluate burst
    const uniqueWallets = new Set(state.buys.map(e => e.wallet));
    const totalXRP      = state.buys.reduce((s, e) => s + e.xrpAmount, 0);

    if (uniqueWallets.size >= MIN_UNIQUE_WALLETS && totalXRP >= MIN_BUY_VOLUME_XRP) {
      // Burst detected — fetch AMM price and fire alert asynchronously
      state.lastAlertTs = now; // Set cooldown immediately to prevent duplicate fires
      setTimeout(() => this.onBurstDetected(key, state, uniqueWallets.size, totalXRP), PRICE_FETCH_DELAY_MS);
    }
  }

  // ─────────────────────────────────────────
  // Burst confirmed — fetch price, alert
  // ─────────────────────────────────────────
  private async onBurstDetected(
    key: string,
    state: TokenState,
    uniqueWallets: number,
    totalXRP: number
  ): Promise<void> {
    try {
      const ammInfo = await this.fetchAMMInfo(state.rawCurrency, state.issuer);

      // Skip if no AMM pool found at all — can't price the token
      if (!ammInfo) {
        debug(`Burst on ${state.displayName} suppressed — no AMM pool or price unavailable`);
        return;
      }

      // Skip illiquid pools
      if (ammInfo.poolXRP < MIN_POOL_XRP) {
        debug(`Burst on ${state.displayName} ignored — pool too small (${ammInfo.poolXRP.toFixed(0)} XRP < ${MIN_POOL_XRP})`);
        return;
      }

      if (ammInfo) {
        state.poolXRP      = ammInfo.poolXRP;
        state.baselinePrice = ammInfo.priceXRP;
      }

      const poolXRP   = ammInfo?.poolXRP   ?? null;
      const priceXRP  = ammInfo?.priceXRP  ?? null;
      const tradingFee = ammInfo?.tradingFee ?? null;

      // Build explorer links
      const encodedCurrency = encodeURIComponent(state.rawCurrency);
      const flLink   = `https://firstledger.net/token-v2/${state.issuer}/${state.rawCurrency}`;
      const xrplLink = `https://xrpl.org/explorer/#${state.issuer}`;

      // Classify burst intensity
      const intensity = uniqueWallets >= 8 ? '🚨 HOT'
                      : uniqueWallets >= 5 ? '🔥 STRONG'
                      : '⚡ EARLY';

      const priceStr  = priceXRP ? `${priceXRP.toFixed(8)} XRP` : 'fetching…';
      const poolStr   = poolXRP  ? `${poolXRP.toFixed(0)} XRP` : 'unknown';
      const feeStr    = tradingFee != null ? `${tradingFee.toFixed(2)}%` : '?';

      const message =
        `${intensity} BUY BURST — <b>${state.displayName}</b>\n\n` +
        `👥 Unique buyers (90s): <b>${uniqueWallets}</b>\n` +
        `💰 Volume in window: <b>${totalXRP.toFixed(1)} XRP</b>\n` +
        `💧 Pool liquidity: <b>${poolStr}</b>\n` +
        `📈 Price: <b>${priceStr}</b>\n` +
        `🔧 AMM fee: ${feeStr}\n\n` +
        `🔗 <a href="${flLink}">FirstLedger</a> | <a href="${xrplLink}">XRPL Explorer</a>\n\n` +
        `<i>⚠️ Early signal — not yet scored. DYOR.</i>`;

      info(`🚨 Buy burst: ${state.displayName} | ${uniqueWallets} wallets | ${totalXRP.toFixed(1)} XRP | pool: ${poolStr}`);

      await this.alerter.sendAlert({
        type: 'buy_burst',
        tokenCurrency: state.displayName,
        tokenIssuer: state.issuer,
        liquidity: poolXRP,
        price: priceXRP,
        message,
      });

      // Fire callback so index.ts can open a burst paper trade
      if (this.onBurst && poolXRP && priceXRP) {
        this.onBurst(state.displayName, state.issuer, state.rawCurrency, poolXRP, priceXRP);
      }

    } catch (err) {
      warn(`BurstDetector alert error for ${state.displayName}: ${err}`);
    }
  }

  // ─────────────────────────────────────────
  // AMM pool info fetch
  // ─────────────────────────────────────────
  private async fetchAMMInfo(
    rawCurrency: string,
    issuer: string
  ): Promise<{ priceXRP: number; poolXRP: number; tradingFee: number } | null> {
    // Try up to 3 times with 1s delay between attempts (WebSocket may be reconnecting)
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const client = this.xrplClient.getClient();
        if (!client) {
          if (attempt < 3) await new Promise(r => setTimeout(r, 1000));
          continue;
        }

        const res: any = await client.request({
          command: 'amm_info',
          asset:  { currency: 'XRP' },
          asset2: { currency: rawCurrency, issuer },
        });

        const amm = res.result?.amm;
        if (!amm) return null; // token has no AMM pool — don't retry

        // XRP side is always a string (drops), token side is always an object
        let xrpDrops: number;
        let tokenValue: number;
        if (typeof amm.amount === 'string' && typeof amm.amount2 === 'object') {
          // Normal: amount=XRP drops, amount2=token object
          xrpDrops   = parseInt(amm.amount, 10);
          tokenValue = parseFloat(amm.amount2?.value || '0');
        } else if (typeof amm.amount2 === 'string' && typeof amm.amount === 'object') {
          // Reversed: amount2=XRP drops, amount=token object
          xrpDrops   = parseInt(amm.amount2, 10);
          tokenValue = parseFloat(amm.amount?.value || '0');
        } else {
          return null; // unexpected shape
        }

        if (!xrpDrops || !tokenValue) return null;

        const poolXRP    = xrpDrops / 1_000_000;
        const priceXRP   = poolXRP / tokenValue;
        const tradingFee = (amm.trading_fee || 0) / 1000;

        return { priceXRP, poolXRP, tradingFee };
      } catch (err: any) {
        if (attempt < 3) {
          debug(`fetchAMMInfo attempt ${attempt} failed for ${rawCurrency}: ${err?.message} — retrying`);
          await new Promise(r => setTimeout(r, 1000 * attempt));
        } else {
          debug(`fetchAMMInfo failed after 3 attempts for ${rawCurrency}: ${err?.message}`);
        }
      }
    }
    return null;
  }

  // ─────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────
  private extractFillFromMeta(meta: any): {
    tokenCurrency: string; issuer: string; xrpAmount: number;
  } | null {
    const nodes: any[] = meta?.AffectedNodes || [];
    for (const node of nodes) {
      const n = node.ModifiedNode || node.DeletedNode;
      if (!n || n.LedgerEntryType !== 'RippleState') continue;
      const ff  = n.FinalFields;
      const pf  = n.PreviousFields;
      if (!ff || !pf) continue;
      const currency = ff.Balance?.currency || ff.LowLimit?.currency;
      const issuer   = ff.LowLimit?.issuer || ff.HighLimit?.issuer;
      if (!currency || currency === 'XRP' || !issuer) continue;
      // Look for companion XRP AccountRoot change to estimate XRP
      for (const n2 of nodes) {
        const ar = n2.ModifiedNode;
        if (!ar || ar.LedgerEntryType !== 'AccountRoot') continue;
        const prevBal = ar.PreviousFields?.Balance;
        const currBal = ar.FinalFields?.Balance;
        if (prevBal && currBal) {
          const delta = parseInt(prevBal, 10) - parseInt(currBal, 10);
          if (delta > 1000) return { tokenCurrency: currency, issuer, xrpAmount: delta / 1_000_000 };
        }
      }
    }
    return null;
  }

  private decodeCurrency(currency: string): string {
    if (currency.length !== 40) return currency;
    try {
      const stripped = currency.replace(/00+$/, '');
      const decoded  = Buffer.from(stripped, 'hex').toString('ascii').replace(/\x00/g, '');
      if (/^[\x20-\x7E]+$/.test(decoded) && decoded.length > 0) return decoded;
    } catch {}
    return currency.slice(0, 8) + '…';
  }

  private evictOldest(): void {
    // Remove the token with the oldest lastTrade
    let oldest: string | null = null;
    let oldestTs = Infinity;
    for (const [key, state] of this.tokens.entries()) {
      if (state.lastTrade < oldestTs) { oldest = key; oldestTs = state.lastTrade; }
    }
    if (oldest) this.tokens.delete(oldest);
  }

  getTrackedCount(): number { return this.tokens.size; }
}
