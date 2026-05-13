import { info, debug } from '../utils/logger';

export type SignalSource = 'burst' | 'stream' | 'scored' | 'sweep' | 'trending' | 'unknown';

export interface TokenDiagnostic {
  token: string;
  issuer: string;
  source: SignalSource;
  reason: string;
  poolXrpReserve?: number | null;
  buyVolumeXRP?: number | null;
  uniqueBuyers?: number | null;
}

interface SeenToken extends TokenDiagnostic {
  rawCurrency?: string;
  firstSeenAt: number;
  priceAtSignal: number;
  openedTrade: boolean;
  lastRejectReason?: string;
  thresholdsHit: Set<number>;
}

interface MissedMoverExample {
  token: string;
  issuer: string;
  movePct: number;
  openedTrade: boolean;
  lastRejectReason?: string;
  poolXrpReserve?: number | null;
  buyVolumeXRP?: number | null;
  uniqueBuyers?: number | null;
  source: SignalSource;
}

const HOUR_MS = 60 * 60 * 1000;
const DETAIL_CAP = 20;
const TELEGRAM_EXAMPLE_CAP = 5;
const MOVE_THRESHOLDS = [10, 25, 50, 100];

function emptyCounters(): Record<string, number> {
  return {
    xrplTxReceived: 0,
    xrplRelevantTxReceived: 0,
    offerCreateTx: 0,
    paymentTx: 0,
    ammTx: 0,
    queueDroppedTx: 0,
    reconnects: 0,
    ammPoolsDiscovered: 0,
    burstCandidatesSeen: 0,
    burstRejectedNoAmm: 0,
    burstRejectedPoolTooSmall: 0,
    burstRejectedCooldown: 0,
    burstApproved: 0,
    burstTradesOpened: 0,
    streamMomentumCandidatesSeen: 0,
    streamRejectedPoolTooSmall: 0,
    streamRejectedSlippage: 0,
    streamRejectedMaxOpenTrades: 0,
    streamRejectedBankroll: 0,
    streamRejectedDailyLossLimit: 0,
    streamApproved: 0,
    streamTradesOpened: 0,
  };
}

export class DiagnosticsService {
  private windowStartedAt = Date.now();
  private counters: Record<string, number> = emptyCounters();
  private tdeRejectReasons = new Map<string, number>();
  private detailLogCount = 0;
  private seen = new Map<string, SeenToken>();
  private missedMovers: MissedMoverExample[] = [];

  recordRawTx(): void {
    this.counters.xrplTxReceived++;
  }

  recordTx(tx: any): void {
    this.counters.xrplRelevantTxReceived++;
    const t = tx?.tx_json || tx?.tx || tx?.transaction || tx;
    const txType = t?.TransactionType;
    if (txType === 'OfferCreate') this.counters.offerCreateTx++;
    else if (txType === 'Payment') this.counters.paymentTx++;
    else if (typeof txType === 'string' && txType.startsWith('AMM')) this.counters.ammTx++;
  }

  increment(name: string, by = 1): void {
    this.counters[name] = (this.counters[name] || 0) + by;
  }

  recordDetailedToken(diag: TokenDiagnostic): void {
    const debugMode = (process.env.LOG_LEVEL || '').toLowerCase() === 'debug';
    if (!debugMode && this.detailLogCount >= DETAIL_CAP) return;
    this.detailLogCount++;
    const line = `[DiagToken] ${diag.source} ${diag.token}:${diag.issuer} reason=${diag.reason} pool=${diag.poolXrpReserve ?? 'n/a'} vol=${diag.buyVolumeXRP ?? 'n/a'} buyers=${diag.uniqueBuyers ?? 'n/a'}`;
    if (debugMode) debug(line);
    else info(line);
  }

  recordSignal(signal: Omit<SeenToken, 'firstSeenAt' | 'openedTrade' | 'thresholdsHit'>): void {
    if (!signal.priceAtSignal || signal.priceAtSignal <= 0) return;
    const key = `${signal.token}:${signal.issuer}`;
    const existing = this.seen.get(key);
    if (existing) {
      existing.lastRejectReason = signal.lastRejectReason ?? existing.lastRejectReason;
      existing.poolXrpReserve = signal.poolXrpReserve ?? existing.poolXrpReserve;
      existing.buyVolumeXRP = signal.buyVolumeXRP ?? existing.buyVolumeXRP;
      existing.uniqueBuyers = signal.uniqueBuyers ?? existing.uniqueBuyers;
      return;
    }
    this.seen.set(key, {
      ...signal,
      firstSeenAt: Date.now(),
      openedTrade: false,
      thresholdsHit: new Set<number>(),
    });
  }

  markTradeOpened(token: string, issuer: string, source: SignalSource): void {
    const key = `${token}:${issuer}`;
    const existing = this.seen.get(key);
    if (existing) existing.openedTrade = true;
    if (source === 'burst') this.increment('burstTradesOpened');
    if (source === 'stream') this.increment('streamTradesOpened');
  }

  recordTdeReject(reason: string | undefined, signalType?: string): void {
    const category = this.categorizeReject(reason);
    this.tdeRejectReasons.set(category, (this.tdeRejectReasons.get(category) || 0) + 1);
    if (signalType === 'stream' || signalType === 'whale_stream') {
      if (category === 'pool too shallow') this.increment('streamRejectedPoolTooSmall');
      else if (category === 'slippage too high') this.increment('streamRejectedSlippage');
      else if (category === 'max open trades') this.increment('streamRejectedMaxOpenTrades');
      else if (category === 'insufficient bankroll') this.increment('streamRejectedBankroll');
      else if (category === 'daily loss limit') this.increment('streamRejectedDailyLossLimit');
    }
  }

  categorizeReject(reason?: string): string {
    const r = (reason || '').toLowerCase();
    if (r.includes('blocklist')) return 'blocklisted';
    if (r.includes('already have open position')) return 'duplicate position';
    if (r.includes('max open trades')) return 'max open trades';
    if (r.includes('daily loss limit')) return 'daily loss limit';
    if (r.includes('no valid price')) return 'no valid price';
    if (r.includes('zero-price')) return 'zero price';
    if (r.includes('pool too shallow')) return 'pool too shallow';
    if (r.includes('size too small')) return 'size too small';
    if (r.includes('insufficient bankroll')) return 'insufficient bankroll';
    if (r.includes('slippage too high')) return 'slippage too high';
    if (r.includes('round-trip loss too high')) return 'round-trip loss too high';
    if (r.includes('live preflight failed')) return 'live preflight failed';
    return 'unknown';
  }

  async refreshMissedMovers(getPrice: (token: SeenToken) => Promise<number | null>): Promise<void> {
    const now = Date.now();
    const maxAgeMs = 6 * HOUR_MS;
    for (const [key, token] of this.seen.entries()) {
      if (now - token.firstSeenAt > maxAgeMs) {
        this.seen.delete(key);
        continue;
      }
      const price = await getPrice(token).catch(() => null);
      if (!price || price <= token.priceAtSignal) continue;
      const movePct = ((price - token.priceAtSignal) / token.priceAtSignal) * 100;
      for (const threshold of MOVE_THRESHOLDS) {
        if (movePct >= threshold && !token.thresholdsHit.has(threshold)) {
          token.thresholdsHit.add(threshold);
          const example = {
            token: token.token,
            issuer: token.issuer,
            movePct,
            openedTrade: token.openedTrade,
            lastRejectReason: token.lastRejectReason,
            poolXrpReserve: token.poolXrpReserve,
            buyVolumeXRP: token.buyVolumeXRP,
            uniqueBuyers: token.uniqueBuyers,
            source: token.source,
          };
          this.missedMovers.push(example);
          info(`[MissedMover] ${example.token} +${movePct.toFixed(1)}% opened=${example.openedTrade} reject=${example.lastRejectReason || 'n/a'} source=${example.source}`);
        }
      }
    }
  }

  private escapeHtml(value: unknown): string {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  formatHourlySummary(): string {
    const elapsedMin = Math.max(1, Math.round((Date.now() - this.windowStartedAt) / 60000));
    const topReasons = [...this.tdeRejectReasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    const topMovers = this.missedMovers
      .filter(m => !m.openedTrade)
      .sort((a, b) => b.movePct - a.movePct)
      .slice(0, TELEGRAM_EXAMPLE_CAP);

    const lines = [
      `🧭 <b>DIAGNOSTICS (${elapsedMin}m)</b>`,
      `<b>XRPL:</b> raw ${this.counters.xrplTxReceived} | relevant ${this.counters.xrplRelevantTxReceived} | OfferCreate ${this.counters.offerCreateTx} | Payment ${this.counters.paymentTx} | AMM ${this.counters.ammTx}`,
      `<b>Queue:</b> dropped ${this.counters.queueDroppedTx} | reconnects ${this.counters.reconnects}`,
      `<b>Discovery:</b> AMM pools ${this.counters.ammPoolsDiscovered}`,
      `<b>Burst:</b> seen ${this.counters.burstCandidatesSeen} | no AMM ${this.counters.burstRejectedNoAmm} | pool small ${this.counters.burstRejectedPoolTooSmall} | cooldown ${this.counters.burstRejectedCooldown} | approved ${this.counters.burstApproved} | opened ${this.counters.burstTradesOpened}`,
      `<b>Stream:</b> seen ${this.counters.streamMomentumCandidatesSeen} | pool small ${this.counters.streamRejectedPoolTooSmall} | slippage ${this.counters.streamRejectedSlippage} | max open ${this.counters.streamRejectedMaxOpenTrades} | bankroll ${this.counters.streamRejectedBankroll} | daily loss ${this.counters.streamRejectedDailyLossLimit} | approved ${this.counters.streamApproved} | opened ${this.counters.streamTradesOpened}`,
      `<b>TDE rejects:</b> ${topReasons.length ? topReasons.map(([r, c]) => `${r}=${c}`).join(' | ') : 'none'}`,
      `<b>Top missed movers:</b>`,
    ];
    if (topMovers.length === 0) lines.push('none');
    for (const m of topMovers) {
      lines.push(`• ${this.escapeHtml(m.token)} +${m.movePct.toFixed(1)}% (${m.source}) reject=${this.escapeHtml(m.lastRejectReason || 'n/a')} pool=${m.poolXrpReserve?.toFixed?.(0) ?? 'n/a'} XRP vol=${m.buyVolumeXRP?.toFixed?.(0) ?? 'n/a'} buyers=${m.uniqueBuyers ?? 'n/a'}`);
    }
    return lines.join('\n');
  }

  resetHourly(): void {
    this.windowStartedAt = Date.now();
    this.counters = emptyCounters();
    this.tdeRejectReasons.clear();
    this.detailLogCount = 0;
    this.missedMovers = [];
  }
}

export const diagnostics = new DiagnosticsService();
