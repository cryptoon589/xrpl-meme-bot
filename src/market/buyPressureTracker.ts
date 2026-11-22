/**
 * Real-time Buy Pressure Tracker
 *
 * Tracks buy/sell activity per token from the live XRPL transaction stream.
 * Uses a sliding 5-minute window to calculate:
 *   - buy count, sell count
 *   - buy volume (XRP), sell volume (XRP)
 *   - unique buyer wallets, unique seller wallets
 *   - NEW wallet detection (accounts that never traded this token before)
 *
 * "New wallets buying" is the strongest signal for an incoming pump —
 * it means fresh capital is entering, not just existing holders churning.
 */

export interface BuyPressureSnapshot {
  buyCount: number;
  sellCount: number;
  buyVolumeXRP: number;
  sellVolumeXRP: number;
  uniqueBuyers: number;
  uniqueSellers: number;
  newWalletBuys: number;      // wallets buying this token for the FIRST TIME
  newWalletPercent: number;   // what % of buyers are new wallets (0-100)
  buyerWallets: string[];     // addresses of unique buyers in window (for whale tracking)
  buySellRatio: number;       // buyCount / (buyCount + sellCount), 0.5 = neutral
  volumeRatio: number;        // buyVolumeXRP / (buyVolumeXRP + sellVolumeXRP)
  lastActivityMs: number;     // ms since last trade
}

interface TradeEvent {
  wallet: string;
  side: 'buy' | 'sell';
  volumeXRP: number;
  timestamp: number;
  /** True only for an initially unseen buyer while durable per-token wallet history has capacity. */
  firstSeenAsBuy: boolean;
}

export class BuyPressureTracker {
  // Per-token event window: "currency:issuer" -> recent trades
  private events: Map<string, TradeEvent[]> = new Map();
  // Per-token: all wallets that have EVER traded this token
  private knownWallets: Map<string, Set<string>> = new Map();
  // Per-token: last trade timestamp
  private lastTrade: Map<string, number> = new Map();
  // Per-token: last time onMomentumDetected was fired (cooldown)
  private momentumCooldown: Map<string, number> = new Map();

  /** Fired when a token crosses the momentum threshold in real-time */
  public onMomentumDetected?: (currency: string, issuer: string, snapshot: BuyPressureSnapshot) => void;

  private readonly WINDOW_MS = 5 * 60 * 1000;  // 5-minute window (was 15min — too laggy for meme pumps)
  private readonly MAX_KNOWN_WALLETS = 500;      // cap per token to prevent memory leak
  private readonly MAX_TOKENS_TRACKED = 300;     // prune least-active tokens above this

  /**
   * Process a transaction from the live stream.
   * Extracts buy/sell info for OfferCreate and Payment transactions.
   */
  processTransaction(tx: any): void {
    const t = tx.tx_json || tx.tx || tx.transaction;
    const meta = tx.meta;
    if (!t || !meta) return;

    const txType = t.TransactionType;

    if (txType === 'OfferCreate') {
      this.processOffer(t, meta);
    } else if (txType === 'Payment') {
      this.processPayment(t, meta);
    }
    // Liquidity deposits/withdrawals are not organic purchases and cannot
    // boost early buyer momentum; handle them separately in AMM risk monitors.
  }

  private processOffer(t: any, meta: any): void {
    // Look at affected nodes to find actual token transfers
    const nodes: any[] = meta.AffectedNodes || [];

    for (const node of nodes) {
      const modified = node.ModifiedNode || node.CreatedNode || node.DeletedNode;
      if (!modified) continue;

      // Look for RippleState changes (token balance changes)
      if (modified.LedgerEntryType !== 'RippleState') continue;

      const prev = modified.PreviousFields;
      const curr = modified.FinalFields;
      if (!prev?.Balance || !curr?.Balance) continue;

      const currency = curr.Balance?.currency || curr.LowLimit?.currency;
      const issuer = curr.LowLimit?.issuer || curr.HighLimit?.issuer;
      if (!currency || currency === 'XRP') continue;

      // Determine direction from balance change
      const prevVal = parseFloat(prev.Balance.value || prev.Balance || '0');
      const currVal = parseFloat(curr.Balance.value || curr.Balance || '0');
      const delta = currVal - prevVal;

      if (delta === 0) continue;

      // Estimate XRP value from TakerPays/TakerGets
      const xrpValue = this.estimateXRPFromOffer(t, Math.abs(delta));

      const wallet = t.Account;
      const side: 'buy' | 'sell' = delta > 0 ? 'buy' : 'sell';

      this.recordTrade(`${currency}:${issuer}`, wallet, side, xrpValue);
    }
  }

  private processPayment(t: any, meta: any): void {
    const amount = t.Amount;
    if (!amount || typeof amount === 'string') return; // XRP payment, skip

    const currency = amount.currency;
    const issuer = amount.issuer;
    if (!currency || currency === 'XRP') return;

    const xrpValue = this.estimateXRPFromMeta(meta);
    const wallet = t.Account;

    // Payment sender is selling, destination is buying
    this.recordTrade(`${currency}:${issuer}`, wallet, 'sell', xrpValue);
    if (t.Destination) {
      this.recordTrade(`${currency}:${issuer}`, t.Destination, 'buy', xrpValue);
    }
  }

  private recordTrade(
    key: string,
    wallet: string,
    side: 'buy' | 'sell',
    volumeXRP: number
  ): void {
    const now = Date.now();

    if (!this.events.has(key)) this.events.set(key, []);
    if (!this.knownWallets.has(key)) this.knownWallets.set(key, new Set());

    // Record first-time status BEFORE registering the wallet. Previously the
    // snapshot searched for events older than the 5m window after those events
    // were already pruned, so every buyer was repeatedly labelled "new".
    // If lifetime history has reached its cap, unknown wallets are unverified,
    // NOT fresh buyers; never inflate novelty on a capped history.
    const known = this.knownWallets.get(key)!;
    const firstSeenAsBuy = side === 'buy' && !known.has(wallet) &&
      known.size < this.MAX_KNOWN_WALLETS;
    if (known.size < this.MAX_KNOWN_WALLETS) known.add(wallet);
    this.events.get(key)!.push({ wallet, side, volumeXRP,
      timestamp: now, firstSeenAsBuy });
    this.lastTrade.set(key, now);

    // Prune old events beyond window
    this.pruneOldEvents(key, now);

    // Real-time momentum detection — fire callback when signals cross threshold
    if (side === 'buy' && this.onMomentumDetected) {
      const colonIdx = key.indexOf(':');
      const currency = key.substring(0, colonIdx);
      const issuer   = key.substring(colonIdx + 1);
      const lastFire = this.momentumCooldown.get(key) ?? 0;
      if (Date.now() - lastFire > 5 * 60 * 1000) { // 5 min cooldown per token
        const snap = this.getSnapshot(currency, issuer);
        // Lowered: 100 XRP fired too late (move already over). 40 XRP catches early legs.
        // uniqueBuyers 3→2: 2 distinct wallets is sufficient signal for meme pumps.
        if (snap.uniqueBuyers >= 2 && snap.buySellRatio >= 0.65 && snap.buyVolumeXRP >= 40) {
          this.momentumCooldown.set(key, Date.now());
          this.onMomentumDetected(currency, issuer, snap);
        }
      }
    }

    // Prune least-active tokens if we're tracking too many
    if (this.events.size > this.MAX_TOKENS_TRACKED) {
      this.pruneLeastActiveTokens();
    }
  }

  private pruneOldEvents(key: string, now: number): void {
    const events = this.events.get(key);
    if (!events) return;
    const cutoff = now - this.WINDOW_MS;
    const pruned = events.filter(e => e.timestamp >= cutoff);
    this.events.set(key, pruned);
  }

  /**
   * Get the current 5-minute buy pressure snapshot for a token.
   */
  getSnapshot(currency: string, issuer: string): BuyPressureSnapshot {
    const key = `${currency}:${issuer}`;
    const now = Date.now();
    this.pruneOldEvents(key, now);

    const events = this.events.get(key) || [];
    const lastActivity = this.lastTrade.get(key) || 0;

    const buys = events.filter(e => e.side === 'buy');
    const sells = events.filter(e => e.side === 'sell');

    const buyCount = buys.length;
    const sellCount = sells.length;
    const buyVolumeXRP = buys.reduce((s, e) => s + e.volumeXRP, 0);
    const sellVolumeXRP = sells.reduce((s, e) => s + e.volumeXRP, 0);

    const uniqueBuyerSet = new Set(buys.map(e => e.wallet));
    const uniqueSellerSet = new Set(sells.map(e => e.wallet));

    // Only buyers whose FIRST EVER tracked token event was a buy during this
    // window count as fresh wallets. The per-token lifetime set survives
    // five-minute event pruning. This remains a TRACKER observation, not
    // verified on-ledger proof that a wallet never held the asset previously.
    const newWalletBuys = new Set(
      buys.filter(e => e.firstSeenAsBuy).map(e => e.wallet)
    ).size;

    const newWalletPercent = uniqueBuyerSet.size > 0
      ? (newWalletBuys / uniqueBuyerSet.size) * 100
      : 0;

    const totalCount = buyCount + sellCount;
    const buySellRatio = totalCount > 0 ? buyCount / totalCount : 0.5;
    const totalVolume = buyVolumeXRP + sellVolumeXRP;
    const volumeRatio = totalVolume > 0 ? buyVolumeXRP / totalVolume : 0.5;

    return {
      buyCount,
      sellCount,
      buyVolumeXRP,
      sellVolumeXRP,
      uniqueBuyers: uniqueBuyerSet.size,
      uniqueSellers: uniqueSellerSet.size,
      buyerWallets: Array.from(uniqueBuyerSet), // expose for whale tracking
      newWalletBuys,
      newWalletPercent,
      buySellRatio,
      volumeRatio,
      lastActivityMs: lastActivity > 0 ? now - lastActivity : Infinity,
    };
  }

  private estimateXRPFromOffer(t: any, tokenDelta: number): number {
    // Best effort: use TakerPays if it's XRP
    const pays = t.TakerPays;
    if (typeof pays === 'string') return parseInt(pays) / 1_000_000;
    const gets = t.TakerGets;
    if (typeof gets === 'string') return parseInt(gets) / 1_000_000;
    return 0;
  }

  private estimateXRPFromMeta(meta: any): number {
    // Look for XRP balance changes in affected nodes
    const nodes: any[] = meta?.AffectedNodes || [];
    for (const node of nodes) {
      const modified = node.ModifiedNode;
      if (!modified || modified.LedgerEntryType !== 'AccountRoot') continue;
      const prev = modified.PreviousFields?.Balance;
      const curr = modified.FinalFields?.Balance;
      if (prev && curr) {
        const delta = Math.abs(parseInt(curr) - parseInt(prev));
        if (delta > 1000) return delta / 1_000_000; // > 0.001 XRP
      }
    }
    return 0;
  }

  /**
   * Clear data for a token (e.g. when pruned from tracking)
   */
  clear(currency: string, issuer: string): void {
    const key = `${currency}:${issuer}`;
    this.events.delete(key);
    // Keep knownWallets — it's historical state, useful if token comes back
  }

  getTrackedTokenCount(): number {
    return this.events.size;
  }

  /**
   * Prune the least-recently-active tokens to keep memory bounded.
   * Keeps the most recently traded tokens.
   */
  private pruneLeastActiveTokens(): void {
    // Sort by last trade time, oldest first
    const sorted = Array.from(this.lastTrade.entries())
      .sort((a, b) => a[1] - b[1]);

    // Remove oldest 20% to make room
    const removeCount = Math.floor(this.MAX_TOKENS_TRACKED * 0.2);
    for (let i = 0; i < removeCount && i < sorted.length; i++) {
      const key = sorted[i][0];
      this.events.delete(key);
      this.lastTrade.delete(key);
      // Keep knownWallets for historical "new wallet" detection if token returns
    }
  }
}
