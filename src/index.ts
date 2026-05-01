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

// Global state
let isRunning = false;
let scanInterval: NodeJS.Timeout | null = null;
let healthCheckInterval: NodeJS.Timeout | null = null;
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
let tokensScored = 0;          // number of score calculations this hour
let topTokens: { currency: string; issuer: string; score: number; liquidity: number; change1h: number }[] = [];


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
  const marketData = new MarketDataCollector(xrplClient, db);
  const volumeTracker = new VolumeTracker();
  const holderCounter = new HolderCounter(xrplClient);
  const riskFilter = new RiskFilter(config);
  const tokenScorer = new TokenScorer(config);
  const issuerReputation = new IssuerReputation();
  const multiTimeframeScorer = new MultiTimeframeScorer(config);
  const positionSizer = new PositionSizer();
  const correlationDetector = new CorrelationDetector();
  const paperTrader = config.mode === 'PAPER' ? new PaperTrader(config, db) : null;
  const telegramAlerter = new TelegramAlerter(config);

  await tokenDiscovery.initialize();
  await ammScanner.initialize();
  await telegramAlerter.sendTestMessage();

  // Filtering happens inside xrplClient.subscribeTransactions — only relevant tx types reach here
  await xrplClient.subscribeTransactions((tx) => {
    if (txQueue.length < MAX_TX_QUEUE_SIZE) {
      txQueue.push(tx);
    } else {
      // Drop oldest 10% when full
      const dropCount = Math.floor(MAX_TX_QUEUE_SIZE * 0.1);
      txQueue.splice(0, dropCount);
      txQueue.push(tx);

      // Log drop rate (max once per minute)
      droppedTxCount++;
      const now = Date.now();
      if (now - lastDropLogTime > 60000) {
        warn(`Transaction queue full: dropped ${droppedTxCount} tx in last minute (queue size: ${MAX_TX_QUEUE_SIZE})`);
        droppedTxCount = 0;
        lastDropLogTime = now;
      }
    }
  });

  startTransactionProcessor(tokenDiscovery, ammScanner, volumeTracker, issuerReputation, correlationDetector, telegramAlerter, db);

  // Start periodic scanning with parallel batches
  isRunning = true;
  startPeriodicScan(
    tokenDiscovery, ammScanner, marketData, volumeTracker, holderCounter,
    issuerReputation, multiTimeframeScorer, correlationDetector,
    riskFilter, tokenScorer, paperTrader, telegramAlerter, db, config
  );

  startHealthCheck(xrplClient);
  startHealthEndpoint(tokenDiscovery, paperTrader, xrplClient);
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
    newTokenDetections++;
    // Track issuer reputation
    issuerReputation.registerTokenLaunch(newToken.issuer, newToken.currency);

    await sendAlert(telegramAlerter, db, {
      type: 'new_token',
      tokenCurrency: newToken.currency,
      tokenIssuer: newToken.issuer,
      message: `New token detected: ${newToken.currency} issued by ${newToken.issuer}`,
      explorerLinks: {
        token: `https://livenet.xrpl.org/accounts/${newToken.issuer}`,
        issuer: `https://livenet.xrpl.org/accounts/${newToken.issuer}`,
      },
    }, {} as any);
  }

  const ammEvent = await ammScanner.processTransaction(tx);
  if (ammEvent?.type === 'new_pool' && ammEvent.pool) {
    // Track AMM creation for issuer reputation
    issuerReputation.registerAMMPool(
      ammEvent.pool.asset1.issuer || '',
      ammEvent.pool.asset1.currency,
      0 // Will be calculated from pool data
    );

    await sendAlert(telegramAlerter, db, {
      type: 'amm_pool',
      tokenCurrency: ammEvent.pool.asset1.currency,
      tokenIssuer: ammEvent.pool.asset1.issuer,
      message: `New AMM pool: ${ammEvent.pool.poolId}`,
    }, {} as any);
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
  const PRUNE_AGE_MS = 48 * 60 * 60 * 1000; // 48 hours
  const MIN_SCORE_TO_KEEP = 50;
  const now = Date.now();

  return tokens.filter(token => {
    // Keep recently active tokens
    if (now - token.lastUpdated < PRUNE_AGE_MS) return true;

    // Keep tokens with AMM pools
    const pool = ammScanner.findPoolByToken(token.currency, token.issuer);
    if (pool) return true;

    // Check last score
    const lastScore = db.getLatestScore(token.currency, token.issuer);
    if (lastScore && lastScore.totalScore >= MIN_SCORE_TO_KEEP) return true;

    // Prune this token
    debug(`Pruning inactive token: ${token.currency}:${token.issuer}`);
    return false;
  });
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
  config: any
): void {
  const MAX_TRACKED_TOKENS = 500;
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
        holderCounter.batchUpdateHolders(tokens).catch(err => {
          warn(`Holder batch update failed: ${err}`);
        });
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

              // Get real volume data
              const vol = volumeTracker.getVolume(token.currency, token.issuer);

              // Get holder count (cached)
              const holders = await holderCounter.getHolderCount(token.currency, token.issuer);

              const snapshot = await marketData.collectMarketDataWithExtras(token, pool, vol, holders);
              if (!snapshot) return { token, snapshot: null };

              const risks = riskFilter.evaluate(token, snapshot, pool);
              const baseScore = tokenScorer.score(token, snapshot, pool, risks);

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
              tokensScored++;

              // Track top tokens for leaderboard
              if (snapshot && score) {
                topTokens.push({ currency: token.currency, issuer: token.issuer, score: score.totalScore, liquidity: snapshot.liquidityXRP || 0, change1h: snapshot.priceChange1h || 0 });
              }

            // Hysteresis: only alert on upward threshold cross
            const lastScore = db.getLatestScore(token.currency, token.issuer);
            const shouldAlert = score.totalScore >= config.minScoreAlert &&
              (!lastScore || lastScore.totalScore < config.minScoreAlert);

            // Require multi-timeframe consensus for alerts
            const hasConsensus = result.value.tfScores?.trend === 'bullish' ||
              (result.value.tfScores?.score5m > 60 && result.value.tfScores?.score15m > 55);

            if (shouldAlert && hasConsensus) {
              setTimeout(() => sendHighScoreAlert(
                telegramAlerter, db, token, snapshot, risks, score, result.value.tfScores, config
              ), 0);
              totalAlerts++;
            }

            // Paper trade entry - require higher consensus
            if (paperTrader && score.totalScore >= config.minScorePaperTrade &&
                riskFilter.isSafe(risks) && hasConsensus) {
              const trade = paperTrader.tryOpenTrade(
                token, snapshot, score.totalScore,
                `Score: ${score.totalScore}, Liquidity: ${snapshot.liquidityXRP?.toFixed(0)} XRP`
              );

              if (trade) {
                setTimeout(() => sendAlert(telegramAlerter, db, {
                  type: 'paper_trade_opened',
                  tokenCurrency: token.currency,
                  tokenIssuer: token.issuer,
                  paperTrade: trade,
                  message: `Opened paper trade for ${token.currency}`,
                }, config), 0);
                totalTrades++;
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

    const top5 = topTokens
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
        const sign = t.change1h >= 0 ? '+' : '';
        lines.push('  ' + emoji + ' #' + (i+1) + ' ' + t.currency + ' | Score: ' + t.score + ' | Liq: ' + t.liquidity.toFixed(0) + ' XRP | 1h: ' + sign + t.change1h.toFixed(1) + '%');
      });
    }

    newTokenDetections = 0;
    tokensScored = 0;

    await telegramAlerter.sendAlert({
      type: 'hourly_summary',
      message: lines.join("\n"),
    });
  }, 3600000);
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
  const action = score.totalScore >= config.minScorePaperTrade
    ? 'HIGH SCORE - Eligible for paper trading'
    : 'Strong signal - monitoring';

  const tfInfo = tfScores ? ` | 5m:${tfScores.score5m} 15m:${tfScores.score15m} 1h:${tfScores.score1h} (${tfScores.trend})` : '';

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
    buyPressure: `${snapshot.buyCount5m} buys / ${snapshot.sellCount5m} sells`,
    riskFlags: risks.flags,
    action,
    explorerLinks: {
      token: `https://livenet.xrpl.org/accounts/${token.issuer}`,
      issuer: `https://livenet.xrpl.org/accounts/${token.issuer}`,
    },
    message: `Score: ${score.totalScore}/100${tfInfo}`,
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
  xrplClient: XRPLClient
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
