/**
 * XRPL Meme Bot - Main Entry Point v1.3.0
 *
 * Modes:
 * - WATCH: Scan and alert only
 * - PAPER: Simulate trades with tracked PnL
 * - AUTO: Stub only (not implemented for safety)
 *
 * v1.3.0 Improvements:
 * - Parallel token scanning (batches of 10)
 * - Batched database writes in transactions
 * - HTTP health endpoint for monitoring
 */

import { loadConfig } from './config';
import { getLogger, info, warn, error, debug } from './utils/logger';
import http from 'http';
import { XRPLClient } from './xrpl/client';
import { TokenDiscovery } from './scanner/tokenDiscovery';
import { AMMScanner } from './scanner/ammEvents';
import { MarketDataCollector } from './market/marketData';
import { VolumeTracker } from './market/volumeTracker';
import { HolderCounter } from './market/holderCounter';
import { RiskFilter } from './risk/riskFilters';
import { TokenScorer } from './scoring/tokenScorer';
import { IssuerReputation } from './scoring/issuerReputation';
import { MultiTimeframeScorer } from './scoring/multiTimeframeScorer';
import { PaperTrader } from './paper/paperTrader';
import { TelegramAlerter } from './telegram/alerts';
import { Database } from './db/database';
import { AlertPayload } from './types';
import { PositionSizer } from './paper/positionSizer';
import { CorrelationDetector } from './scoring/correlationDetector';
import { ActiveDiscovery } from './scanner/activeDiscovery';
import { BurstDetector } from './scanner/burstDetector';
import { AMMPriceFetcher } from './market/ammPriceFetcher';
import { BuyPressureTracker } from './market/buyPressureTracker';
import { TradeExecutor } from './execution/tradeExecutor';
import { WhaleTracker } from './scoring/whaleTracker';
import { SocialDetector } from './scoring/socialDetector';
import { LiveValidator } from './execution/liveValidator';
import { TradeAnalyzer } from './analysis/tradeAnalyzer';

// Global state
let isRunning = false;
let scanInterval: NodeJS.Timeout | null = null;
let healthCheckInterval: NodeJS.Timeout | null = null;

// Per-token trade lock: prevents duplicate paper/live trades from parallel batch workers
const tradeLocks = new Set<string>();
let healthServer: http.Server | null = null;
let xrplClientRef: XRPLClient | null = null; // module-level ref for hourly timer

// Transaction queue for rate limiting
const MAX_TX_QUEUE_SIZE = parseInt(process.env.MAX_TX_QUEUE_SIZE || '500', 10);
const MAX_TX_PER_BATCH = 20;
let txQueue: any[] = [];
let txProcessingTimer: NodeJS.Timeout | null = null;
let droppedTxCount = 0;
let lastDropLogTime = 0;
let txProcessedCount = 0;      // transactions actually queued (passed filter)
let txIgnoredCount = 0;        // transactions filtered at intake (XRPLClient)
let newTokenDetections = 0;   // new trustline tokens discovered
let hourlySummaryTimer: NodeJS.Timeout | null = null;
let tokensScored = 0;          // number of unique tokens scored this hour
let tokensScoredSet = new Set<string>(); // deduplicate across scan cycles
let topTokens: { currency: string; issuer: string; score: number; liquidity: number; change1h: number | null }[] = [];


async function main() {
  const config = loadConfig();
  getLogger(config.logLevel);

  info('🚀 Starting XRPL Meme Bot v1.3.0...');
  info(`Mode: ${config.mode}`);

  if (config.mode === 'AUTO') {
    warn('⚠️  AUTO mode is not implemented! Falling back to WATCH mode for safety.');
  }

  // Initialize components
  const db = new Database();
  const xrplClient = new XRPLClient(config.xrplWsUrl);
  xrplClientRef = xrplClient;

  try {
    await xrplClient.connect();
    info('✅ XRPL connection established');
  } catch (err) {
    error(`❌ Failed to connect to XRPL: ${err}`);
    process.exit(1);
  }

  const tokenDiscovery = new TokenDiscovery(xrplClient, db);
  const ammScanner = new AMMScanner(xrplClient, db);
  const activeDiscovery = new ActiveDiscovery(xrplClient, db);
  const ammPriceFetcher = new AMMPriceFetcher(xrplClient);
  const buyPressureTracker = new BuyPressureTracker();
  const marketData = new MarketDataCollector(xrplClient, db);
  const volumeTracker = new VolumeTracker();
  const holderCounter = new HolderCounter(xrplClient);
  const riskFilter = new RiskFilter(config);
  const tokenScorer = new TokenScorer(config);
  const whaleTracker = new WhaleTracker();
  const socialDetector = new SocialDetector(config.xrplWsUrl);
  const liveValidator = new LiveValidator(db);

  // Load whale data from DB and wire into scorer
  whaleTracker.load(db);
  tokenScorer.setWhaleTracker(whaleTracker);
  tokenScorer.setSocialDetector(socialDetector);

  const issuerReputation = new IssuerReputation();
  const multiTimeframeScorer = new MultiTimeframeScorer(config);
  const positionSizer = new PositionSizer();
  const correlationDetector = new CorrelationDetector();
  const paperTrader = config.mode === 'PAPER' ? new PaperTrader(config, db) : null;
  const telegramAlerter = new TelegramAlerter(config);
  const burstDetector = new BurstDetector(xrplClient, telegramAlerter, db);

  // Tokens that should never be burst-traded (native chain tokens, stablecoins, etc.)
  const BURST_TRADE_BLOCKLIST = new Set([
    'XAH', 'XLM', 'SGB', 'FLR', 'EVR', 'CSC', 'DRO', 'SOLO',
    'USDT', 'USDC', 'RLUSD', 'USD', 'BTC', 'ETH', 'XRP',
  ]);

  // Hook burst detector into paper trader — opens a burst trade on every confirmed burst
  if (paperTrader) {
    burstDetector.onBurst = (currency, issuer, rawCurrency, poolXRP, priceXRP) => {
      if (BURST_TRADE_BLOCKLIST.has(currency)) {
        debug(`Burst trade skipped — blocklisted token: ${currency}`);
        return;
      }
      const token = { currency, issuer, rawCurrency, lastUpdated: Date.now() } as any;
      const snapshot = {
        tokenCurrency: currency,
        tokenIssuer: issuer,
        priceXRP,
        liquidityXRP: poolXRP,
        buyCount5m: 0,
        sellCount5m: 0,
      } as any;
      const trade = paperTrader.tryOpenBurstTrade(
        token,
        snapshot,
        `Buy burst — pool: ${poolXRP.toFixed(0)} XRP`
      );
      if (trade) {
        // Notify Telegram about the burst paper entry
        setTimeout(() => sendAlert(telegramAlerter, db, {
          type: 'paper_trade_opened',
          tokenCurrency: currency,
          tokenIssuer: issuer,
          paperTrade: trade,
          message: `🚀 Burst entry: ${currency} @ ${priceXRP.toFixed(8)} XRP`,
        }, config), 0);
      }
    };
  }

  // On startup: force-close any positions in blocklisted tokens
  // (opened before the blocklist was added, e.g. XAH, 666, LOX)
  if (paperTrader) {
    for (const token of BURST_TRADE_BLOCKLIST) {
      const closed = paperTrader.forceCloseByToken(token, 'blocklisted_token_cleanup');
      if (closed) {
        warn(`Startup cleanup: force-closed blocklisted position ${token}`);
      }
    }
    // Also force-close any position open for more than 2 hours with no recent
    // scan activity (catches tokens pruned before orphan checker was added)
    const openPositions = paperTrader.getOpenPositions();
    for (const pos of openPositions) {
      const ageMs = Date.now() - (pos.entryTimestamp || 0);
      if (ageMs > 2 * 60 * 60 * 1000) {
        warn(`Startup cleanup: force-closing stale position ${pos.tokenCurrency} (age: ${(ageMs/3600000).toFixed(1)}h)`);
        paperTrader.forceCloseByToken(pos.tokenCurrency, 'stale_position_cleanup');
      }
    }
  }

  // Trade executor — dry-run unless LIVE_TRADING=true in .env
  let tradeExecutor: TradeExecutor | null = null;
  if (process.env.TRADING_WALLET_SEED) {
    const dryRun = !config.liveTrading;
    tradeExecutor = new TradeExecutor(config, telegramAlerter, dryRun);
    info(`Trade executor: ${dryRun ? 'DRY-RUN mode (set LIVE_TRADING=true to go live)' : '🔴 LIVE TRADING ENABLED'}`);
    tradeExecutor.startMonitor(async (currency, issuer) => {
      const p = await ammPriceFetcher.getPrice(currency, issuer);
      return p?.priceXRP ?? null;
    });
  } else {
    info('TRADING_WALLET_SEED not set — auto-execution disabled');
  }

  await tokenDiscovery.initialize();
  await ammScanner.initialize();
  await telegramAlerter.sendTestMessage();

  // Subscribe to live tx stream — activeDiscovery handles token extraction
  await xrplClient.subscribeTransactions((tx) => {
    // Real-time buy pressure tracking (runs on every tx, no queue)
    buyPressureTracker.processTransaction(tx);

    // Burst detection — fires early alerts on buy-velocity spikes
    // Watches ALL tokens including ones not yet in the main tracked list
    burstDetector.processTransaction(tx);

    // Token discovery
    const discovered = activeDiscovery.processLiveTx(tx);
    if (discovered) {
      newTokenDetections++;
      const tracked = activeDiscovery.toTrackedToken(discovered);
      tokenDiscovery.addTrackedToken(tracked);
    }

    // Queue for scoring/volume tracking
    if (txQueue.length < MAX_TX_QUEUE_SIZE) {
      txQueue.push(tx);
    } else {
      const dropCount = Math.floor(MAX_TX_QUEUE_SIZE * 0.1);
      txQueue.splice(0, dropCount);
      txQueue.push(tx);
      droppedTxCount++;
      const now = Date.now();
      if (now - lastDropLogTime > 60000) {
        warn(`Transaction queue full: dropped ${droppedTxCount} tx in last minute`);
        droppedTxCount = 0;
        lastDropLogTime = now;
      }
    }
  });

  // Immediate AMM sweep on startup — finds all existing pools right away
  info('🔍 Running initial AMM pool sweep...');
  const sweepResults = await activeDiscovery.sweepAMMPools();
  sweepResults.forEach(dt => tokenDiscovery.addTrackedToken(activeDiscovery.toTrackedToken(dt)));
  info(`Initial sweep complete: ${sweepResults.length} new tokens from AMM pools`);

  startTransactionProcessor(tokenDiscovery, ammScanner, volumeTracker, issuerReputation, correlationDetector, telegramAlerter, db);

  // Periodic AMM sweep every 10 minutes to catch newly created pools
  setInterval(async () => {
    const results = await activeDiscovery.sweepAMMPools();
    results.forEach(dt => tokenDiscovery.addTrackedToken(activeDiscovery.toTrackedToken(dt)));
    if (results.length > 0) info(`AMM sweep: ${results.length} new tokens added`);
  }, 10 * 60 * 1000);

  // Start periodic scanning with parallel batches
  isRunning = true;
  startPeriodicScan(
    tokenDiscovery, ammScanner, marketData, volumeTracker, holderCounter,
    issuerReputation, multiTimeframeScorer, correlationDetector,
    riskFilter, tokenScorer, paperTrader, telegramAlerter, db, config,
    ammPriceFetcher, buyPressureTracker, tradeExecutor,
    whaleTracker, liveValidator, socialDetector
  );

  startHealthCheck(xrplClient);
  startHealthEndpoint(tokenDiscovery, paperTrader, xrplClient, liveValidator);
  setupGracefulShutdown(xrplClient, db);

  info('✅ XRPL Meme Bot is running!');
  info(`Tracking ${tokenDiscovery.getTokenCount()} tokens`);
  info(`Monitoring ${ammScanner.getPoolCount()} AMM pools`);
}

/**
 * Process queued transactions at controlled rate
 */
function startTransactionProcessor(
  tokenDiscovery: TokenDiscovery,
  ammScanner: AMMScanner,
  volumeTracker: VolumeTracker,
  issuerReputation: IssuerReputation,
  correlationDetector: CorrelationDetector,
  telegramAlerter: TelegramAlerter,
  db: Database
): void {
  let lastProcessTime = 0;
  const MIN_PROCESS_INTERVAL_MS = 500;

  txProcessingTimer = setInterval(async () => {
    if (!isRunning || txQueue.length === 0) return;

    const now = Date.now();
    if (now - lastProcessTime < MIN_PROCESS_INTERVAL_MS) return;

    lastProcessTime = now;
    const batchSize = Math.min(MAX_TX_PER_BATCH, txQueue.length);
    const toProcess = txQueue.splice(0, batchSize);

    for (const tx of toProcess) {
      try {
        // Track volume for all transactions
        volumeTracker.processTransaction(tx);

        // Record price movements for correlation detection
        recordPriceMovementIfRelevant(tx, correlationDetector);

        await processSingleTransaction(tx, tokenDiscovery, ammScanner, issuerReputation, telegramAlerter, db);
      } catch (err) {
        warn(`Error processing transaction: ${err}`);
      }
    }
  }, 100);
}

/**
 * Record significant price movements for correlation detection
 */
function recordPriceMovementIfRelevant(tx: any, correlationDetector: CorrelationDetector): void {
  const txType = tx.tx_json?.TransactionType || tx.tx?.TransactionType || tx.transaction?.TransactionType;
  if (txType !== 'Payment' && txType !== 'AMMTrade') return;

  const transaction = tx.tx || tx.transaction;
  if (!transaction) return;

  const amount = transaction.Amount;
  if (!amount || typeof amount === 'string') return;
  if (!amount.currency || amount.currency === 'XRP') return;

  // Estimate price change from transaction (simplified)
  // In production, would compare to previous price
  const estimatedChange = 0; // Placeholder - would need historical price
  const volume = parseFloat(amount.value || '0');

  if (volume > 100) { // Only track significant transactions
    correlationDetector.recordMovement(
      amount.currency,
      amount.issuer,
      estimatedChange,
      volume
    );
  }
}

async function processSingleTransaction(
  tx: any,
  tokenDiscovery: TokenDiscovery,
  ammScanner: AMMScanner,
  issuerReputation: IssuerReputation,
  telegramAlerter: TelegramAlerter,
  db: Database
): Promise<void> {
  const newToken = await tokenDiscovery.processTransaction(tx);
  if (newToken) {
    // Track issuer reputation
    issuerReputation.registerTokenLaunch(newToken.issuer, newToken.currency);

    // NOTE: new_token alert suppressed — score is always 0/100 at discovery time
    // (token hasn't been through a scan cycle yet). Discovery stats appear in the
    // hourly report instead. High-scoring tokens alert via the main signal gate.
    debug(`New token discovered: ${newToken.currency} | issuer: ${newToken.issuer}`);
  }

  const ammEvent = await ammScanner.processTransaction(tx);
  if (ammEvent?.type === 'new_pool' && ammEvent.pool) {
    // Track AMM creation for issuer reputation
    issuerReputation.registerAMMPool(
      ammEvent.pool.asset1.issuer || '',
      ammEvent.pool.asset1.currency,
      0 // Will be calculated from pool data
    );

    // AMM pool creation logged only — no Telegram alert (score is 0 at this point)
    debug(`New AMM pool: ${ammEvent.pool.poolId}`);
  }
}

/**
 * Smart token pruning: remove inactive tokens with no AMM pool and low score
 */
function smartPruneTokens(
  tokens: any[],
  db: Database,
  ammScanner: AMMScanner,
  tokenScorer: TokenScorer,
  riskFilter: RiskFilter,
  config: any
): any[] {
  const PRUNE_AGE_MS  = 6 * 60 * 60 * 1000;  // 6h (was 48h) — be aggressive
  const HARD_CAP      = 300;                    // never score more than 300 tokens
  const MIN_SCORE_TO_KEEP = 40;
  const now = Date.now();

  let kept = tokens.filter(token => {
    // Always keep tokens with open paper positions
    // (checked by currency only since issuer may differ)
    // Keep recently updated tokens
    if (now - token.lastUpdated < PRUNE_AGE_MS) return true;

    // Keep tokens with AMM pools AND a decent score
    const pool = ammScanner.findPoolByToken(token.currency, token.issuer);
    if (!pool) {
      debug(`Pruning no-pool token: ${token.currency}`);
      return false;
    }

    // Check last score — prune low scorers even with pools
    const lastScore = db.getLatestScore(token.currency, token.issuer);
    if (lastScore && lastScore.totalScore < MIN_SCORE_TO_KEEP) {
      debug(`Pruning low-score token: ${token.currency} (${lastScore.totalScore})`);
      return false;
    }

    return true;
  });

  // Hard cap: if still over limit, drop lowest-scored tokens
  if (kept.length > HARD_CAP) {
    kept = kept
      .map(t => ({ t, score: db.getLatestScore(t.currency, t.issuer)?.totalScore ?? 0 }))
      .sort((a, b) => b.score - a.score)
      .slice(0, HARD_CAP)
      .map(({ t }) => t);
    info(`Token list hard-capped at ${HARD_CAP}`);
  }

  return kept;
}

/**
 * QUICK WIN #1 & #5: Parallel token scanning with batched DB writes
 */
function startPeriodicScan(
  tokenDiscovery: TokenDiscovery,
  ammScanner: AMMScanner,
  marketData: MarketDataCollector,
  volumeTracker: VolumeTracker,
  holderCounter: HolderCounter,
  issuerReputation: IssuerReputation,
  multiTimeframeScorer: MultiTimeframeScorer,
  correlationDetector: CorrelationDetector,
  riskFilter: RiskFilter,
  tokenScorer: TokenScorer,
  paperTrader: PaperTrader | null,
  telegramAlerter: TelegramAlerter,
  db: Database,
  config: any,
  ammPriceFetcher: AMMPriceFetcher,
  buyPressureTracker: BuyPressureTracker,
  tradeExecutor: TradeExecutor | null,
  whaleTracker: WhaleTracker,
  liveValidator: LiveValidator,
  socialDetector: SocialDetector
): void {
  const MAX_TRACKED_TOKENS = 300; // hard ceiling matches smartPruneTokens HARD_CAP
  const BATCH_SIZE = 10; // Process 10 tokens concurrently
  const HOLDER_SCAN_INTERVAL = 6; // Scan holders every 6th cycle (~6 minutes)
  let scanCycle = 0;
  let isScanning = false;

  const scanTokens = async () => {
    if (!isRunning || isScanning) {
      if (isScanning) debug('Previous scan still running, skipping');
      return;
    }

    isScanning = true;
    const startTime = Date.now();
    scanCycle++;

    try {
      let tokens = tokenDiscovery.getTrackedTokens();

      // Smart pruning: remove inactive tokens with no pool and low score
      tokens = smartPruneTokens(tokens, db, ammScanner, tokenScorer, riskFilter, config);

      // Hard cap if still over limit
      if (tokens.length > MAX_TRACKED_TOKENS) {
        tokens = tokens.sort((a, b) => b.lastUpdated - a.lastUpdated).slice(0, MAX_TRACKED_TOKENS);
        warn(`Token count exceeds limit after pruning, scanning most recent ${MAX_TRACKED_TOKENS}`);
      }

      // Periodic holder count update
      if (scanCycle % HOLDER_SCAN_INTERVAL === 0 && tokens.length > 0) {
        // batchUpdateHolders removed — per-token fetch in scan loop now handles this
        Promise.resolve();
        holderCounter.pruneCache();
      }

      info(`Starting scan of ${tokens.length} tokens in batches of ${BATCH_SIZE}...`);

      // Create batches
      const batches: typeof tokens[] = [];
      for (let i = 0; i < tokens.length; i += BATCH_SIZE) {
        batches.push(tokens.slice(i, i + BATCH_SIZE));
      }

      let totalProcessed = 0;
      let totalAlerts = 0;
      let totalTrades = 0;

      for (const batch of batches) {
        if (!isRunning) break;

        // Process batch in parallel
        const results = await Promise.allSettled(
          batch.map(async (token) => {
            try {
              if (tokenDiscovery.isSpamIssuer(token.issuer)) {
                return { token, skipped: true };
              }

              const pool = ammScanner.findPoolByToken(token.currency, token.issuer);

              // Fix 1: Get price directly from AMM pool (rawCurrency avoids "Issue is malformed")
              const ammPrice = await ammPriceFetcher.getPrice(token.currency, token.issuer, token.rawCurrency);

              // Fix 2: Get real-time buy pressure
              const pressure = buyPressureTracker.getSnapshot(token.currency, token.issuer);

              // Merge buy pressure into volume data
              const vol = {
                buyVolume: pressure.buyVolumeXRP,
                sellVolume: pressure.sellVolumeXRP,
                buyCount: pressure.buyCount,
                sellCount: pressure.sellCount,
                uniqueBuyers: pressure.uniqueBuyers,
                uniqueSellers: pressure.uniqueSellers,
              };

              // Get holder count only for active tokens — skips the expensive account_lines
              // pagination for dormant tokens (no buys and no price movement).
              // Cache TTL is 30 min so even active tokens rarely trigger a real fetch.
              const hasActivity = pressure.buyCount > 0 || pressure.sellCount > 0
                || Math.abs(ammPrice?.priceXRP ? (ammPrice.priceXRP - (ammPrice.priceXRP * 0.95)) : 0) > 0;
              const cachedHolders = holderCounter.getCached(token.currency, token.issuer);
              const holders = (hasActivity || cachedHolders === null)
                ? await holderCounter.getHolderCount(token.currency, token.issuer, token.rawCurrency)
                : cachedHolders;

              // Fix 5: pass ammPrice into collectMarketDataWithExtras so price history
              // and priceChange calculations use the correct AMM price from the start
              const snapshot = await marketData.collectMarketDataWithExtras(token, pool, vol, holders, ammPrice);
              if (!snapshot) return { token, snapshot: null };

              // Fix 3: Inject new wallet data into snapshot for scorer
              (snapshot as any).newWalletBuys = pressure.newWalletBuys;
              (snapshot as any).newWalletPercent = pressure.newWalletPercent;
              (snapshot as any).buySellRatio = pressure.buySellRatio;
              (snapshot as any).lastActivityMs = pressure.lastActivityMs;

              const risks = riskFilter.evaluate(token, snapshot, pool);

              // Get buyer wallets for whale detection
              const buyerWallets = Array.from(
                new Set((pressure as any).buyerWallets as string[] | undefined ?? [])
              );

              // Whale score (synchronous from in-memory registry)
              const whaleBoost = whaleTracker.getWhaleScore(token.currency, token.issuer, buyerWallets);

              // Social score (async, cached 15min)
              const socialBoost = await socialDetector.getSocialScore(token.currency, token.issuer);

              const baseScore = tokenScorer.score(token, snapshot, pool, risks, whaleBoost, socialBoost);

              // Apply issuer reputation boost/penalty
              const issuerTrust = issuerReputation.getTrustScore(token.issuer);
              const adjustedTotalScore = Math.round(
                baseScore.totalScore * 0.8 + issuerTrust * 0.2
              );
              const score = { ...baseScore, totalScore: adjustedTotalScore };

              // Calculate multi-timeframe scores
              const tfScores = multiTimeframeScorer.calculate(snapshot, score.totalScore);

              return { token, snapshot, risks, score, tfScores };
            } catch (err) {
              warn(`Error processing ${token.currency}:${token.issuer}: ${err}`);
              return { token, error: err };
            }
          })
        );

        // QUICK WIN #5: Batch DB writes in transaction
        db.transaction(() => {
          for (const result of results) {
            if (result.status !== 'fulfilled' || !result.value || result.value.skipped) continue;
            const { token, snapshot, risks, score } = result.value;
            if (!snapshot || !risks || !score) continue;

            // Check correlation/wash trading
            const washTradingDetected = correlationDetector.detectWashTrading(
              snapshot.uniqueBuyers5m || 0,
              snapshot.uniqueSellers5m || 0,
              snapshot.buyVolume5m,
              snapshot.sellVolume5m
            );

            if (washTradingDetected) {
              debug(`Wash trading detected for ${token.currency}:${token.issuer}, skipping`);
              continue;
            }

            db.saveRiskFlags(token.currency, token.issuer, risks);
            db.saveScore(score);
            totalProcessed++;
            // Count unique tokens scored this hour (deduplicated across scan cycles)
            const scoreKey = `${token.currency}:${token.issuer}`;
            if (!tokensScoredSet.has(scoreKey)) {
              tokensScoredSet.add(scoreKey);
              tokensScored++;
            }

              // Track top tokens for leaderboard — keep only the best score per token
              if (snapshot && score) {
                const existingIdx = topTokens.findIndex(
                  t => t.currency === token.currency && t.issuer === token.issuer
                );
                if (existingIdx >= 0) {
                  // Update if this scan produced a better score
                  if (score.totalScore > topTokens[existingIdx].score) {
                    topTokens[existingIdx] = { currency: token.currency, issuer: token.issuer, score: score.totalScore, liquidity: snapshot.liquidityXRP || 0, change1h: snapshot.priceChange1h || 0 };
                  }
                } else {
                  topTokens.push({ currency: token.currency, issuer: token.issuer, score: score.totalScore, liquidity: snapshot.liquidityXRP || 0, change1h: snapshot.priceChange1h || 0 });
                }
              }

            // Fix 4: Multi-signal gate — require 3+ signals firing together
            const pressure = buyPressureTracker.getSnapshot(token.currency, token.issuer);
            // Has the tracker accumulated data yet? (at least 1 event observed)
            const hasLiveData = pressure.buyCount + pressure.sellCount > 0;

            const signals = {
              highScore:     score.totalScore >= config.minScoreAlert,
              buyDominant:   hasLiveData && pressure.buySellRatio >= 0.60 && pressure.buyCount >= 2,
              momentum:      (snapshot.priceChange5m || 0) >= 5,
              newWallets:    pressure.newWalletBuys >= 1,
              volDominant:   hasLiveData && pressure.volumeRatio >= 0.60 && pressure.buyVolumeXRP > 0,
              recentActivity:(pressure.lastActivityMs || Infinity) < 5 * 60 * 1000,
            };
            const signalCount = Object.values(signals).filter(Boolean).length;

            // Established/stablecoin tokens — never alert regardless of score or momentum
            const ALERT_BLOCKLIST = new Set([
              'USD', 'USDC', 'USDT', 'RLUSD', 'EUR', 'BTC', 'ETH', 'CNY', 'GBP', 'JPY',
              'XAH', 'XLM', 'SGB', 'FLR', 'EVR', 'CSC', 'DRO', 'SOLO',
            ]);
            const isBlocklisted = ALERT_BLOCKLIST.has(token.currency);

            // Minimum wallet breadth gate: require at least 2 unique buyers in the
            // live window before alerting. Stops single-wallet manipulation from
            // triggering strongSingle via a large wash trade.
            const hasWalletBreadth = !pressure || pressure.buyCount === 0
              ? true  // no live data yet — don't penalise, let score decide
              : pressure.uniqueBuyers >= 2;

            // Alert conditions (any one sufficient):
            //  A) Score >= 75 with decent liquidity — high conviction, no extra signals needed
            //  B) Score >= threshold + at least 1 other signal firing
            //  C) Momentum spike (20%+) with active buying from 2+ wallets
            //  D) 3+ any signals together
            const highConviction  = score.totalScore >= 75;
            const strongSingle    = (snapshot.priceChange5m || 0) >= 20 && pressure.buyCount >= 3 && hasWalletBreadth;
            const highScorePlusOne = signals.highScore && signalCount >= 2;
            const shouldAlert = (
              highConviction || strongSingle || highScorePlusOne || signalCount >= 3
            ) && (snapshot.liquidityXRP || 0) >= config.minLiquidityXRP
              && !isBlocklisted
              && hasWalletBreadth;

            // Cooldown: 30 min per token
            const lastAlertTime = db.getLastAlertTime(token.currency, token.issuer);
            const alertCooldown = Date.now() - lastAlertTime > 30 * 60 * 1000;

            if (shouldAlert && alertCooldown && riskFilter.isSafe(risks)) {
              db.setLastAlertTime(token.currency, token.issuer, Date.now());

              // Send Telegram signal alert
              setTimeout(() => sendHighScoreAlert(
                telegramAlerter, db, token, snapshot, risks, score, result.value.tfScores, config
              ), 0);
              totalAlerts++;

              // Auto-execute trade if executor is configured
              if (tradeExecutor && snapshot.priceXRP) {
                const tradeSize = Math.min(
                  config.maxTradeXRP,
                  config.startingBankrollXRP * 0.1   // max 10% of bankroll per trade
                );
                tradeExecutor.openTrade(
                  token.currency,
                  token.issuer,
                  tradeSize,
                  snapshot.priceXRP,
                  score.totalScore
                ).then(result => {
                  if (result.success) {
                    info(`✅ Auto-trade opened: ${token.currency} | ${tradeSize} XRP | tx: ${result.txHash}`);
                  } else {
                    warn(`⚠️ Auto-trade skipped: ${token.currency} | ${result.error}`);
                  }
                }).catch(err => warn(`Auto-trade error: ${err}`));
              }
            }

            // Paper trade entry - require higher consensus
            // tradeLocks prevents parallel batch workers opening duplicate positions
            const tradeKey = `${token.currency}:${token.issuer}`;
            if (paperTrader && score.totalScore >= config.minScorePaperTrade &&
                riskFilter.isSafe(risks) && !isBlocklisted && !tradeLocks.has(tradeKey)) {
              tradeLocks.add(tradeKey);
              const trade = paperTrader.tryOpenTrade(
                token, snapshot, score.totalScore,
                `Score: ${score.totalScore}, Liquidity: ${snapshot.liquidityXRP?.toFixed(0)} XRP`
              );
              tradeLocks.delete(tradeKey);

              if (trade) {
                setTimeout(() => sendAlert(telegramAlerter, db, {
                  type: 'paper_trade_opened',
                  tokenCurrency: token.currency,
                  tokenIssuer: token.issuer,
                  paperTrade: trade,
                  message: `Opened paper trade for ${token.currency}`,
                }, config), 0);
                totalTrades++;

                // Feature 4: Record intended price for live validation
                if (process.env.TRADING_WALLET_SEED && snapshot.priceXRP) {
                  liveValidator.recordIntended(
                    token.currency,
                    token.issuer,
                    snapshot.priceXRP,
                    trade.entryAmountXRP
                  );
                }
              }
            }

            // Check exits
            if (paperTrader) {
              const closedTrades = paperTrader.checkExits(snapshot);
              for (const ct of closedTrades) {
                setTimeout(() => sendAlert(telegramAlerter, db, {
                  type: ct.status === 'partial' ? 'paper_trade_partial_close' : 'paper_trade_closed',
                  tokenCurrency: ct.tokenCurrency,
                  tokenIssuer: ct.tokenIssuer,
                  paperTrade: ct,
                  message: `Closed paper trade for ${ct.tokenCurrency}`,
                }, config), 0);

                // Feature 2: Record whale wallets after a winning trade (>50% PnL)
                if (ct.status === 'closed' && ct.pnlPercent !== null && ct.pnlPercent > 50) {
                  const pressure = buyPressureTracker.getSnapshot(ct.tokenCurrency, ct.tokenIssuer);
                  // Collect unique buyers as early buyer list (best effort)
                  const earlyBuyers: string[] = [];
                  // We don't have direct wallet list from BuyPressureTracker snapshot,
                  // but we can use the known buyer count as an approximation marker.
                  // The actual whale detection relies on on-chain data; here we record
                  // the token as a winner so future scans flag it.
                  whaleTracker.recordWinner(
                    ct.tokenCurrency,
                    ct.tokenIssuer,
                    earlyBuyers,
                    ct.pnlXRP ?? 0
                  );
                  // Persist to DB
                  whaleTracker.save(db);
                }
              }
            }

            // Emergency exit check
            if (paperTrader && paperTrader.hasOpenPosition(token.currency, token.issuer)) {
              const emergencyTrade = paperTrader.updateRiskState(
                token.currency, token.issuer, risks.flags, snapshot
              );
              if (emergencyTrade) {
                setTimeout(() => sendAlert(telegramAlerter, db, {
                  type: 'paper_trade_closed',
                  tokenCurrency: emergencyTrade.tokenCurrency,
                  tokenIssuer: emergencyTrade.tokenIssuer,
                  paperTrade: emergencyTrade,
                  message: `Emergency exit: ${risks.flags.join(', ')}`,
                }, config), 0);
              }
            }
          }
        });

        await sleep(50); // Rate limit between batches
      }

      // Check exits for ALL open positions — catches orphaned positions
      // (tokens that got pruned from the scan list but still have open trades)
      if (paperTrader && paperTrader.getOpenPositions().length > 0) {
        const orphanClosed = await paperTrader.checkAllOpenExits(async (currency, issuer) => {
          const p = await ammPriceFetcher.getPrice(currency, issuer);
          return p?.priceXRP ?? null;
        });
        for (const ct of orphanClosed) {
          totalTrades++;
          // Suppress ghost-close alerts (no-price / force-close at entry) — just log them
          if (ct.exitReason === 'force_close_no_price') {
            info(`Ghost close (no price): ${ct.tokenCurrency} — position voided, bankroll returned`);
            continue;
          }
          setTimeout(() => sendAlert(telegramAlerter, db, {
            type: 'paper_trade_closed',
            tokenCurrency: ct.tokenCurrency,
            tokenIssuer: ct.tokenIssuer,
            paperTrade: ct,
            message: `Closed ${ct.tokenCurrency}: ${ct.pnlPercent?.toFixed(1)}% PnL`,
          }, config), 0);
        }
      }

      const elapsed = Date.now() - startTime;
      info(`✅ Scan complete: ${elapsed}ms | Tokens: ${totalProcessed} | Alerts: ${totalAlerts} | Trades: ${totalTrades}`);
    } finally {
      isScanning = false;
    }
  };

  scanTokens();
  scanInterval = setInterval(scanTokens, 60000);

  // Hourly summary + hot token leaderboard
  hourlySummaryTimer = setInterval(async () => {
    const rawStats = xrplClientRef ? xrplClientRef.getTxStats() : { raw: 0, filtered: 0 };
    const processed = rawStats.filtered;
    const ignored = rawStats.raw - rawStats.filtered;
    const total = rawStats.raw;

    // Blocklist for hourly leaderboard — same as alert gate
    const HOURLY_BLOCKLIST = new Set([
      'USD', 'USDC', 'USDT', 'RLUSD', 'EUR', 'BTC', 'ETH', 'CNY', 'GBP', 'JPY',
      'XAH', 'XLM', 'SGB', 'FLR', 'EVR', 'CSC', 'DRO', 'SOLO',
    ]);

    // Helper: decode hex currency codes to human-readable names
    const decodeCurrencyName = (raw: string): string => {
      if (raw.length !== 40) return raw;
      try {
        const stripped = raw.replace(/00+$/, '');
        const decoded = Buffer.from(stripped, 'hex').toString('ascii').replace(/\x00/g, '');
        if (/^[\x20-\x7E]+$/.test(decoded) && decoded.length > 0) return decoded;
      } catch {}
      return raw.slice(0, 8) + '…';
    };

    // Deduplicated top 5 — exclude established/stable tokens, memes only, min 1000 XRP liquidity
    // Also skip non-decodable hex currencies (starts with non-printable byte = likely garbage/test token)
    const top5 = topTokens
      .filter(t => !HOURLY_BLOCKLIST.has(t.currency))
      .filter(t => t.liquidity >= 1000)  // skip micro-pools in leaderboard
      .filter(t => {
        // Skip hex tokens that don't decode to readable ASCII
        if (t.currency.length === 40) {
          try {
            const stripped = t.currency.replace(/00+$/, '');
            const decoded = Buffer.from(stripped, 'hex').toString('ascii').replace(/\x00/g, '');
            return /^[\x20-\x7E]+$/.test(decoded) && decoded.length > 0;
          } catch { return false; }
        }
        return true;
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    topTokens = [];

    const lines = [
      '📊 <b>HOURLY REPORT</b>',
      '',
      '<b>Transactions:</b>',
      '  Processed: ' + processed + ' (queued for scoring)',
      '  Ignored: ' + ignored + ' (spam/NFT/XRP-only)',
      '  Total seen: ' + total,
      '',
      '<b>Discoveries:</b>',
      '  New tokens: ' + newTokenDetections,
      '  Scored: ' + tokensScored + ' tokens',
      '',
      '<b>🔥 TOP 5 HOT TOKENS</b>',
    ];

    if (top5.length === 0) {
      lines.push('  No tokens scored this hour');
    } else {
      top5.forEach((t, i) => {
        const emoji = t.score >= 80 ? '🔥' : t.score >= 60 ? '⚡' : '📈';
        const change1hStr = (t.change1h != null && t.change1h !== 0)
          ? (t.change1h >= 0 ? '+' : '') + t.change1h.toFixed(1) + '%'
          : 'N/A';
        const displayName = decodeCurrencyName(t.currency);
        lines.push('  ' + emoji + ' #' + (i+1) + ' ' + displayName + ' | Score: ' + t.score + ' | Liq: ' + t.liquidity.toFixed(0) + ' XRP | 1h: ' + change1hStr);
      });
    }

    // Paper trading summary
    if (paperTrader) {
      const state = paperTrader.getState();
      const openPositions = paperTrader.getOpenPositions();
      const pnlEmoji = state.dailyPnL >= 0 ? '✅' : '❌';
      lines.push('');
      lines.push('<b>💼 PAPER TRADING</b>');
      lines.push('  Bankroll: ' + state.bankrollXRP.toFixed(2) + ' XRP');
      lines.push('  Open positions: ' + state.openPositions);
      lines.push('  ' + pnlEmoji + ' Daily PnL: ' + (state.dailyPnL >= 0 ? '+' : '') + state.dailyPnL.toFixed(4) + ' XRP');
      if (openPositions.length > 0) {
        lines.push('  Holding: ' + openPositions.map(p => p.tokenCurrency).join(', '));
      }
    }

    newTokenDetections = 0;
    tokensScored = 0;
    tokensScoredSet.clear();

    await telegramAlerter.sendAlert({
      type: 'hourly_summary',
      message: lines.join("\n"),
    });
  }, 3600000);

  // ── Trade analysis cron: runs every 6h ────────────────────────────
  const tradeAnalyzer = new TradeAnalyzer(db);

  // Also expose manual trigger via a simple check at startup
  const runAnalysis = async () => {
    const recs = tradeAnalyzer.analyze();
    if (!recs) return; // Not enough trades yet

    // Format Telegram message
    const w = recs.scoreWeights;
    const lines: string[] = [
      `🧠 <b>TRADE ANALYSIS REPORT</b>`,
      ``,
      `📊 <b>${recs.tradesAnalyzed} trades</b> | Win rate: <b>${recs.overallWinRate}%</b>`,
      ``,
      `<b>Key insights:</b>`,
      ...recs.insights.slice(0, 10).map(i => `• ${i}`),
      ``,
      `<b>Burst params:</b>`,
      `• Min liquidity: ${recs.minLiquidityXRP} XRP | Stop: ${recs.burstStopLossPercent}% | TP1: +${recs.burstTp1Percent}% | Trail: +${recs.burstTrailingActivation}%`,
      ``,
      `<b>Scored params:</b>`,
      `• Min score: ${recs.minScorePaperTrade} | TP1: +${recs.scoredTp1Percent}% | TP2: +${recs.scoredTp2Percent}%`,
      recs.bestScoredSignalCombo !== 'default' ? `• Best signal combo: ${recs.bestScoredSignalCombo}` : '',
      ``,
      `<b>Learned score weights:</b>`,
      `• Liquidity: ${w.liquidityScore} | BuyPressure: ${w.buyPressureScore} | VolAccel: ${w.volumeAccelScore}`,
      `• HolderGrowth: ${w.holderGrowthScore} | DevSafety: ${w.devSafetyScore} | Spread: ${w.spreadScore}`,
      ``,
      recs.autoApplyReady
        ? `✅ Auto-applying now. Full report: <code>state/trade_analysis.md</code>`
        : `⏳ Need ${Math.max(0, 30 - recs.tradesAnalyzed)} more trades + 50% win rate for auto-apply.`,
    ].filter(l => l !== '');

    await telegramAlerter.sendAlert({
      type: 'hourly_summary', // reuse summary type for plain HTML send
      message: lines.join('\n'),
    });

    // Auto-apply if ready and win rate is solid
    if (recs.autoApplyReady) {
      info('TradeAnalyzer: auto-apply threshold met — applying recommendations');
      const configPath = process.env.CONFIG_PATH || './bot-config.json';
      tradeAnalyzer.applyRecommendations(recs, configPath);
    }
  };

  setInterval(runAnalysis, 6 * 60 * 60 * 1000); // every 6 hours
  // Also run once after 30 min (first meaningful data after startup)
  setTimeout(runAnalysis, 30 * 60 * 1000);
}

async function sendHighScoreAlert(
  alerter: TelegramAlerter,
  db: Database,
  token: any,
  snapshot: any,
  risks: any,
  score: any,
  tfScores: any,
  config: any
): Promise<void> {
  // Build fired-signals list for the alert
  const newWallets = (snapshot as any).newWalletBuys || 0;
  const newWalletPct = (snapshot as any).newWalletPercent || 0;
  const buySellRatio = (snapshot as any).buySellRatio || 0;
  const lastActivityMs = (snapshot as any).lastActivityMs || Infinity;

  const signalLines: string[] = [];
  if (score.totalScore >= config.minScoreAlert)   signalLines.push('📊 High score');
  if (buySellRatio >= 0.65)                       signalLines.push('💚 Buy dominant (' + (buySellRatio * 100).toFixed(0) + '% buys)');
  if ((snapshot.priceChange5m || 0) >= 8)         signalLines.push('📈 Momentum +' + (snapshot.priceChange5m || 0).toFixed(1) + '% (5m)');
  if (newWallets >= 2)                            signalLines.push('🆕 ' + newWallets + ' new wallets buying (' + newWalletPct.toFixed(0) + '% of buyers)');
  if (lastActivityMs < 60000)                     signalLines.push('⚡ Active right now');

  const buyPressureStr = `${snapshot.buyCount5m || 0} buys / ${snapshot.sellCount5m || 0} sells` +
    (newWallets > 0 ? ` | ${newWallets} new wallets` : '');

  await sendAlert(alerter, db, {
    type: 'high_score',
    tokenCurrency: token.currency,
    tokenIssuer: token.issuer,
    score: score.totalScore,
    liquidity: snapshot.liquidityXRP,
    price: snapshot.priceXRP,
    change5m: snapshot.priceChange5m,
    change15m: snapshot.priceChange15m,
    change1h: snapshot.priceChange1h,
    holders: snapshot.holderEstimate,
    buyPressure: buyPressureStr,
    riskFlags: risks.flags,
    action: signalLines.join('\n'),
    explorerLinks: {
      token: `https://livenet.xrpl.org/accounts/${token.issuer}`,
      issuer: `https://livenet.xrpl.org/accounts/${token.issuer}`,
    },
    message: `Score: ${score.totalScore}/100`,
  }, config);
}

/**
 * Health check interval
 */
function startHealthCheck(xrplClient: XRPLClient): void {
  healthCheckInterval = setInterval(() => {
    const status = xrplClient.getStatus();
    if (status.connected) {
      info(`💓 Health: Connected to ${status.url}`);
    } else {
      warn('⚠️  Health: NOT connected to XRPL');
    }
  }, 300000);
}

/**
 * QUICK WIN #4: HTTP health endpoint
 */
function startHealthEndpoint(
  tokenDiscovery: TokenDiscovery,
  paperTrader: PaperTrader | null,
  xrplClient: XRPLClient,
  liveValidator: LiveValidator
): void {
  const PORT = parseInt(process.env.HEALTH_PORT || '3000', 10);

  healthServer = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/healthz') {
      const status = {
        status: 'ok',
        uptime: Math.round(process.uptime()),
        tokens: tokenDiscovery.getTokenCount(),
        positions: paperTrader?.getOpenPositions().length || 0,
        xrplConnected: xrplClient.getStatus().connected,
        timestamp: Date.now(),
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status, null, 2));
    } else if (req.url === '/metrics') {
      const state = paperTrader?.getState();
      const metrics = [
        `bot_uptime_seconds ${Math.round(process.uptime())}`,
        `bot_tokens_tracked ${tokenDiscovery.getTokenCount()}`,
        `bot_open_positions ${state?.openPositions || 0}`,
        `bot_bankroll_xrp ${state?.bankrollXRP || 0}`,
        `bot_daily_pnl_xrp ${state?.dailyPnL || 0}`,
        `bot_xrpl_connected ${xrplClient.getStatus().connected ? 1 : 0}`,
      ];
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(metrics.join('\n') + '\n');
    } else if (req.url === '/validation') {
      // Feature 4: Live trading validation — slippage stats
      const stats = liveValidator.getSlippageStats();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(stats, null, 2));
    } else {
      res.writeHead(404);
      res.end('Not found\n');
    }
  });

  healthServer.listen(PORT, () => {
    info(`🩺 Health endpoint on port ${PORT} — GET http://localhost:${PORT}/health`);
  });
}

/**
 * Graceful shutdown
 */
function setupGracefulShutdown(xrplClient: XRPLClient, db: Database): void {
  const shutdown = async (signal: string) => {
    info(`\nReceived ${signal}. Shutting down...`);
    isRunning = false;

    if (scanInterval) clearInterval(scanInterval);
    if (healthCheckInterval) clearInterval(healthCheckInterval);
    if (txProcessingTimer) clearInterval(txProcessingTimer);
    if (healthServer) healthServer.close();
    if (hourlySummaryTimer) clearInterval(hourlySummaryTimer);

    await xrplClient.disconnect();
    db.close();

    info('✅ Shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => error(`Uncaught exception: ${err}`));
  process.on('unhandledRejection', (reason) => error(`Unhandled rejection: ${reason}`));
}

async function sendAlert(
  alerter: TelegramAlerter,
  db: Database,
  payload: AlertPayload,
  config: any
): Promise<void> {
  db.saveAlert(payload);
  await alerter.sendAlert(payload);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch((err) => {
  error(`Fatal error: ${err}`);
  process.exit(1);
});
