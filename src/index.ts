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
import { PaperTrader } from './paper/paperTrader';
import { TelegramAlerter } from './telegram/alerts';
import { Database } from './db/database';
import { AlertPayload } from './types';
// PositionSizer used internally by PaperTrader — not needed here
import { CorrelationDetector } from './scoring/correlationDetector';
import { ActiveDiscovery } from './scanner/activeDiscovery';
import { TrendingSeeder } from './scanner/trendingSeeder';
import { BurstDetector } from './scanner/burstDetector';
import { AMMPriceFetcher } from './market/ammPriceFetcher';
import { BuyPressureTracker } from './market/buyPressureTracker';
import { TradeExecutor } from './execution/tradeExecutor';
import { WhaleTracker } from './scoring/whaleTracker';
import { SocialDetector } from './scoring/socialDetector';
import { LiveValidator } from './execution/liveValidator';
import { TradeAnalyzer } from './analysis/tradeAnalyzer';
import { RuntimeLearning } from './analysis/runtimeLearning';
import { MultiTimeframeScorer } from './scoring/multiTimeframeScorer';
import { TradeDecisionEngine } from './execution/tradeDecisionEngine';
import { MissedOpportunityTracker } from './market/missedOpportunityTracker';
import { diagnostics } from './diagnostics/diagnostics';

// Global state
let isRunning = false;
let scanInterval: NodeJS.Timeout | null = null;
let healthCheckInterval: NodeJS.Timeout | null = null;

// Per-token trade lock: prevents duplicate paper/live trades from parallel batch workers
const tradeLocks = new Set<string>();
// Tokens force-closed for no-price \u2014 don't re-enter for 6h
const noPriceCooldowns = new Map<string, number>();
const NO_PRICE_COOLDOWN_MS = 30 * 60 * 1000; // 30 min — 6h was causing post-restart dormancy
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
let hourlySummaryTimer: NodeJS.Timeout | null = null;


async function main() {
  const config = loadConfig();
  getLogger(config.logLevel);

  info('🚀 Starting XRPL Meme Bot v1.3.0...');
  info(`Mode: ${config.mode}`);

  // Startup profile summary
  (() => {
    const { PROFILES } = require('./execution/tradeProfiles');
    info('\n🎨 TRADE PROFILES ENABLED:');
    for (const [name, p] of Object.entries(PROFILES) as any[]) {
      info(`  ${name}: pool≥${p.minPoolXrpReserve}XRP | size ${p.baseSizeXRP}–${p.maxSizeXRP}XRP | ` +
        `stop-${p.stopLossPct}% | TP1+${p.tp1Pct}%(sell${p.tp1SellPct}%) TP2+${p.tp2Pct}%(sell${p.tp2SellPct}%) | ` +
        `trail@+${p.trailActivationPct}%/${p.trailDistancePct}% | ` +
        `slip≤${(p.maxSlippage*100).toFixed(0)}% | timeStop ${p.timeStopMs>0 ? p.timeStopMs/60000+'min' : 'off'}`);
    }
    info('');
  })();

  if (config.mode === 'AUTO') {
    warn('⚠️  AUTO mode is not implemented! Falling back to WATCH mode for safety.');
  }

  // Initialize components
  const db = new Database();

  // Prune stale tokens at startup to keep the tracked list lean.
  // 4000+ tokens causes preloadAMMs to take 5-15 min and slows every scan.
  const pruned = db.pruneStaleTokens();
  if (pruned > 0) info(`Startup: pruned ${pruned} stale tokens from DB`);

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
  const multiTimeframeScorer = new MultiTimeframeScorer(config);
  const tradeDecisionEngine = new TradeDecisionEngine(config);
  const missedOpportunityTracker = new MissedOpportunityTracker(db, ammPriceFetcher);

  // Load whale data from DB and wire into scorer
  whaleTracker.load(db);
  whaleTracker.loadTopTradersFromFile();
  tokenScorer.setWhaleTracker(whaleTracker);
  tokenScorer.setSocialDetector(socialDetector);

  // Runtime learning: time-of-day gate, entry pullback, learned TP targets
  const runtimeLearning = new RuntimeLearning();



  const issuerReputation = new IssuerReputation();
  const correlationDetector = new CorrelationDetector();
  const paperTrader = config.mode === 'PAPER' ? new PaperTrader(config, db) : null;
  const telegramAlerter = new TelegramAlerter(config);
  const burstDetector = new BurstDetector(xrplClient, telegramAlerter, db);

  // Tokens that should never be burst-traded (native chain tokens, stablecoins, etc.)
  // Includes both ASCII names AND hex-encoded equivalents
  const BURST_TRADE_BLOCKLIST = new Set([
    // ASCII names
    'XAH', 'XLM', 'SGB', 'FLR', 'EVR', 'CSC', 'DRO', 'SOLO',

    'USDT', 'USDC', 'RLUSD', 'USD', 'BTC', 'ETH', 'XRP', 'EUR',
    // Hex-encoded equivalents (40-char, right-padded with 00s)
    '524C555344000000000000000000000000000000', // RLUSD
    '5553440000000000000000000000000000000000', // USD
    '5553444300000000000000000000000000000000', // USDC
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

  // Helper: decode 40-char hex currency to ASCII (for blocklist checks)
  const decodeCurrency = (raw: string): string => {
    if (raw.length !== 40) return raw;
    try {
      const stripped = raw.replace(/00+$/, '');
      const decoded = Buffer.from(stripped, 'hex').toString('ascii').replace(/\x00/g, '');
      return /^[\x20-\x7E]+$/.test(decoded) && decoded.length > 0 ? decoded : raw;
    } catch { return raw; }
  };

  const isBlocklistedToken = (currency: string): boolean =>
    BURST_TRADE_BLOCKLIST.has(currency) || BURST_TRADE_BLOCKLIST.has(decodeCurrency(currency));

  // Hook burst detector into paper trader — routes through TradeDecisionEngine
  if (paperTrader) {
    burstDetector.onBurst = (currency, issuer, rawCurrency, poolTVL, priceXRP, tokenAgeMs, baselinePrice) => {
      diagnostics.increment('burstCandidatesSeen');
      diagnostics.recordSignal({ token: decodeCurrency(rawCurrency || currency), issuer, source: 'burst', reason: 'burst_detected', priceAtSignal: priceXRP, poolXrpReserve: poolTVL / 2, rawCurrency });
      // burstDetector passes poolXRP * 2 as 4th arg (TVL), not the XRP side reserve
      const poolXrpReserve = poolTVL / 2;
      if (isBlocklistedToken(currency)) { debug(`Burst skipped — blocklisted: ${currency}`); return; }
      const burstKey = `${currency}:${issuer}`;
      // Skip tokens that were recently force-closed for no-price
      const noPriceCooldownTs = noPriceCooldowns.get(burstKey);
      if (noPriceCooldownTs && Date.now() - noPriceCooldownTs < NO_PRICE_COOLDOWN_MS) {
        debug(`Burst skipped — no-price cooldown active: ${currency}`);
        diagnostics.increment('burstRejectedCooldown');
        return;
      }
      if (tradeLocks.has(burstKey)) { debug(`Burst skipped — lock held: ${burstKey}`); return; }
      if (paperTrader.hasOpenPosition(currency, issuer)) { debug(`Burst skipped — open position: ${burstKey}`); return; }
      // Belt-and-suspenders: also check tradeExecutor positions (real trades) to prevent cross-path duplicates
      if (tradeExecutor && tradeExecutor.hasOpenPosition(currency, issuer)) { debug(`Burst skipped — real position open: ${burstKey}`); return; }

      // FIX #28: Pump check — skip if price already 3× above baseline (late FOMO entry).
      // baselinePrice is null on the FIRST burst (no comparison possible yet).
      // On subsequent bursts, if price has already 3×’d from first detection, skip.
      if (baselinePrice !== null && priceXRP > baselinePrice * 3) {
        info(`[PumpCheck] Skipping ${currency} — price ${priceXRP.toFixed(8)} already ${(priceXRP/baselinePrice).toFixed(1)}x from baseline ${baselinePrice.toFixed(8)}`);
        diagnostics.increment('burstRejectedPumped');
        return;
      }

      tradeLocks.add(burstKey);

      // FIX #28: New launch detection — token < 1h old gets NEW_LAUNCH profile
      const isNewLaunch = tokenAgeMs < 60 * 60 * 1000;
      if (isNewLaunch) info(`[NewLaunch] ${currency} is ${(tokenAgeMs/60000).toFixed(1)}min old — using NEW_LAUNCH profile`);

      // Check if any known high-confidence whale is in the burst's buyer list
      const burstBuyers = buyPressureTracker.getSnapshot(rawCurrency, issuer).buyerWallets ?? [];
      const bestWhaleWR = whaleTracker.getBestWhaleWinRate(burstBuyers);
      const hasWhale    = bestWhaleWR >= 70;
      if (hasWhale) info(`[Whale] High-confidence whale in burst (WR=${bestWhaleWR}%): ${currency}`);


            const snapshot: any = {
        tokenCurrency: currency, tokenIssuer: issuer,
        priceXRP, liquidityXRP: poolTVL,
        poolXrpReserve,
        buyCount5m: 0, sellCount5m: 0,
        whaleWinRate: bestWhaleWR,   // passed into TDE for threshold lowering
        isNewLaunch,                 // hint for TDE profile selection
        tokenAgeMs,
      };
      const token = { currency, issuer, rawCurrency, lastUpdated: Date.now() } as any;

      // Select signal type: new launch > whale > burst
      const signalType = isNewLaunch ? 'burst' : (hasWhale ? 'whale_burst' : 'burst');

      tradeDecisionEngine.decide({
        currency, issuer, rawCurrency, snapshot,
        signalType,
        signalScore: hasWhale ? Math.round(bestWhaleWR) : 0,
        bankrollXRP: paperTrader.getState().bankrollXRP,
        openPositions: paperTrader.getOpenPositionsSummary().length,
        dailyPnL: paperTrader.getState().dailyPnL,
        openPositionKeys: new Set(paperTrader.getOpenPositionsSummary().map(p => `${p.tokenCurrency}:${p.tokenIssuer}`)),
        blocklist: BURST_TRADE_BLOCKLIST,
      }).then(decision => {
        if (decision.outcome === 'REJECTED') {
          info(`[TDE] Burst rejected: ${decision.rejectReason}`);
          diagnostics.recordTdeReject(decision.rejectReason, 'burst');
          if (decision.rejectReason?.includes('shallow')) diagnostics.increment('burstRejectedPoolTooSmall');
          // FIX #33: shadow backtest — track what this rejected signal does next
          if (priceXRP > 0) {
            db.recordShadowTrade({
              currency, issuer, rawCurrency: token.rawCurrency,
              signalType: 'burst', rejectReason: decision.rejectReason ?? 'unknown',
              priceAtSignal: priceXRP, poolXrpReserve,
              signalScore: 0, skippedAt: Date.now(),
            });
          }
          tradeLocks.delete(burstKey);
          return;
        }
        diagnostics.increment('burstApproved');
        const burstTp = runtimeLearning.getTpTargets('burst');
        // Use the price burstDetector already fetched — it's fresh from the ledger.
        // The previous second ammPriceFetcher.getPrice() call here added 100-300ms
        // of latency at the worst moment (entry), by which point the price had moved
        // further against us. Trust the detector's price; it just came off the AMM.
        (() => {
          // FIX #28: override profile to NEW_LAUNCH for fresh tokens
          const effectiveProfile = isNewLaunch ? 'NEW_LAUNCH' : decision.profile.name;
          const validatedSnapshot = { ...snapshot, priceXRP: priceXRP };
          // FIX #33: pass TDE-calculated sizeXRP so alert size == actual size
          const trade = paperTrader.tryOpenBurstTrade(
            token, validatedSnapshot,
            `[BURST] pool: ${poolXrpReserve.toFixed(0)} XRP reserve | profile: ${effectiveProfile}`,
            burstTp,
            decision.sizeXRP
          );
          tradeLocks.delete(burstKey);
          if (trade) {
            trade.tradeProfile = effectiveProfile;
            trade.tradeSource  = 'burst';
            db.updatePaperTrade(trade);
            // FIX #28: sync profileName on in-memory position for correct exit logic
            paperTrader.setPositionProfile(currency, issuer, effectiveProfile as any);
            diagnostics.markTradeOpened(trade.tokenCurrency, trade.tokenIssuer, 'burst');
            setTimeout(() => sendAlert(telegramAlerter, db, {
              type: 'paper_trade_opened',
              tokenCurrency: currency, tokenIssuer: issuer,
              paperTrade: trade,
              tradeProfileName: effectiveProfile,
              tradeSource: 'burst',
              poolXrpReserve: poolXrpReserve,
              slippage: decision.slippage,
              decisionSizeXRP: decision.sizeXRP,
              message: isNewLaunch ? `🆕 New launch entry: ${currency}` : `Burst entry: ${currency}`,
            }, config), 0);
          }
        })();
      });
    };
  }

  // Stream-driven momentum entry — routes through TradeDecisionEngine
  if (paperTrader) {
    paperTrader.setBuyPressureTracker(buyPressureTracker);
    paperTrader.setAMMPriceFetcher(ammPriceFetcher);

    // FIX #36: Runner re-entry — when TP1 hits with confirmed momentum,
    // open a small follow-on position to ride the rest of the move.
    // Uses NEW_LAUNCH profile (wide stop, no time stop after TP1).
    paperTrader.onTP1Hit = async (currency, issuer, rawCurrency, currentPrice, poolXRP) => {
      const reKey = `runner:${currency}:${issuer}`;
      if (tradeLocks.has(reKey)) return;
      if (paperTrader.hasOpenPosition(currency, issuer)) return; // still in original position
      // Only re-enter if buy pressure is still strong
      const pressure = buyPressureTracker.getSnapshot(rawCurrency, issuer);
      const totalTx = pressure.buyCount + pressure.sellCount;
      const buyRatio = totalTx > 0 ? pressure.buyCount / totalTx : 0;
      if (buyRatio < 0.65 || pressure.buyVolumeXRP < 20) {
        debug(`[RunnerRe] Skipping ${currency} re-entry — momentum fading (buyRatio=${buyRatio.toFixed(2)} vol=${pressure.buyVolumeXRP.toFixed(0)} XRP)`);
        return;
      }
      // Verify pool still alive with live price
      const livePrice = await ammPriceFetcher.getPrice(rawCurrency, issuer, rawCurrency, true).catch(() => null);
      if (!livePrice || livePrice.priceXRP <= 0 || livePrice.poolXRP < 300) return;
      // Don't re-enter if price already 2x from our TP1 exit — too late
      if (livePrice.priceXRP > currentPrice * 2) {
        debug(`[RunnerRe] Skipping ${currency} — price already 2x from TP1 exit`);
        return;
      }
      tradeLocks.add(reKey);
      info(`[RunnerRe] TP1 hit — attempting runner re-entry on ${currency} @ ${livePrice.priceXRP.toFixed(8)} XRP`);
      const reSnapshot: any = {
        tokenCurrency: currency, tokenIssuer: issuer,
        priceXRP: livePrice.priceXRP, liquidityXRP: livePrice.liquidityXRP,
        poolXrpReserve: livePrice.poolXRP,
        buyCount5m: pressure.buyCount, sellCount5m: pressure.sellCount,
        isNewLaunch: false,
      };
      const reToken = { currency, issuer, rawCurrency, lastUpdated: Date.now() } as any;
      const reTp = runtimeLearning.getTpTargets('burst');
      tradeDecisionEngine.decide({
        currency, issuer, rawCurrency, snapshot: reSnapshot,
        signalType: 'burst', signalScore: 0,
        bankrollXRP: paperTrader.getState().bankrollXRP,
        openPositions: paperTrader.getOpenPositionsSummary().length,
        dailyPnL: paperTrader.getState().dailyPnL,
        openPositionKeys: new Set(paperTrader.getOpenPositionsSummary().map(p => `${p.tokenCurrency}:${p.tokenIssuer}`)),
        blocklist: BURST_TRADE_BLOCKLIST,
      }).then(decision => {
        tradeLocks.delete(reKey);
        if (decision.outcome === 'REJECTED') {
          debug(`[RunnerRe] TDE rejected ${currency}: ${decision.rejectReason}`);
          return;
        }
        const reTrade = paperTrader.tryOpenBurstTrade(
          reToken, reSnapshot,
          `[RUNNER_REENTRY] post-TP1 momentum confirmed buyRatio=${buyRatio.toFixed(2)}`,
          reTp, Math.min(decision.sizeXRP, 5) // cap re-entry at 5 XRP
        );
        if (reTrade) {
          reTrade.tradeProfile = 'NEW_LAUNCH';
          reTrade.tradeSource = 'burst';
          db.updatePaperTrade(reTrade);
          paperTrader.setPositionProfile(currency, issuer, 'NEW_LAUNCH' as any);
          diagnostics.markTradeOpened(reTrade.tokenCurrency, reTrade.tokenIssuer, 'burst');
          info(`[RunnerRe] ✅ Re-entry opened on ${currency} — riding the runner`);
          setTimeout(() => sendAlert(telegramAlerter, db, {
            type: 'paper_trade_opened',
            tokenCurrency: currency, tokenIssuer: issuer,
            paperTrade: reTrade, tradeProfileName: 'NEW_LAUNCH', tradeSource: 'burst',
            poolXrpReserve: livePrice.poolXRP, slippage: decision.slippage,
            decisionSizeXRP: decision.sizeXRP,
            message: `🔄 Runner re-entry: ${currency} (post-TP1)`,
          }, config), 0);
        }
      }).catch(err => { warn(`[RunnerRe] TDE error: ${err}`); tradeLocks.delete(reKey); });
    };

    buyPressureTracker.onMomentumDetected = (currency, issuer, snap) => {
      // Decode hex currency immediately — all downstream keys use decoded form
      const displayCurrency = decodeCurrency(currency);
      const momentumKey = `${displayCurrency}:${issuer}`;
      if (isBlocklistedToken(currency)) return;
      // noPriceCooldown check (was missing from stream path — burst+scored had it)
      const npStreamTs = noPriceCooldowns.get(momentumKey);
      if (npStreamTs && Date.now() - npStreamTs < NO_PRICE_COOLDOWN_MS) {
        debug(`Stream skipped — no-price cooldown: ${displayCurrency}`);
        return;
      }
      // Use decoded key for position checks to match how tryOpenTrade stores positions
      if (paperTrader!.hasOpenPosition(displayCurrency, issuer)) return;
      // Belt-and-suspenders: also check tradeExecutor positions (real trades) to prevent cross-path duplicates
      if (tradeExecutor && tradeExecutor.hasOpenPosition(displayCurrency, issuer)) return;
      if (tradeLocks.has(momentumKey)) return;
      tradeLocks.add(momentumKey);

      diagnostics.increment('streamMomentumCandidatesSeen');
      diagnostics.recordSignal({ token: displayCurrency, issuer, source: 'stream', reason: 'momentum_detected', priceAtSignal: snap.buyVolumeXRP, poolXrpReserve: null, buyVolumeXRP: snap.buyVolumeXRP, uniqueBuyers: snap.uniqueBuyers });
      ammPriceFetcher.getPrice(currency, issuer).then(async ammPrice => {
        if (!ammPrice?.priceXRP) { tradeLocks.delete(momentumKey); return; }

        // Check whale presence in stream buyers
        const streamBestWR = whaleTracker.getBestWhaleWinRate(snap.buyerWallets ?? []);
        const streamHasWhale = streamBestWR >= 70;
        if (streamHasWhale) info(`[Whale] High-confidence whale in stream (WR=${streamBestWR}%): ${displayCurrency}`);

        const streamSnapshot: any = {
          tokenCurrency: currency, tokenIssuer: issuer,
          priceXRP: ammPrice.priceXRP, liquidityXRP: ammPrice.liquidityXRP,
          poolXrpReserve: ammPrice.poolXRP,
          buyCount5m: snap.buyCount, sellCount5m: snap.sellCount,
          uniqueBuyers5m: snap.uniqueBuyers, buySellRatio: snap.buySellRatio,
          newWalletBuys: snap.newWalletBuys, buyVolumeXRP: snap.buyVolumeXRP,
          whaleWinRate: streamBestWR,
        };

        // Guard: skip if price is 0 or missing
        if (!ammPrice.priceXRP || ammPrice.priceXRP <= 0) {
          debug(`[Stream] Skipping ${displayCurrency} — no valid price from AMM`);
          tradeLocks.delete(momentumKey);
          return;
        }

        const decision = await tradeDecisionEngine.decide({
          currency, issuer, snapshot: streamSnapshot,
          signalType: streamHasWhale ? 'whale_stream' : 'stream',
          signalScore: streamHasWhale ? Math.max(75, Math.round(streamBestWR)) : 75,
          bankrollXRP: paperTrader!.getState().bankrollXRP,
          openPositions: paperTrader!.getOpenPositionsSummary().length,
          dailyPnL: paperTrader!.getState().dailyPnL,
          openPositionKeys: new Set(paperTrader!.getOpenPositionsSummary().map(p => `${p.tokenCurrency}:${p.tokenIssuer}`)),
          blocklist: BURST_TRADE_BLOCKLIST,
        });
        if (decision.outcome === 'REJECTED') {
          info(`[TDE] Stream rejected (${displayCurrency}): ${decision.rejectReason}`);
          diagnostics.recordTdeReject(decision.rejectReason, 'stream');
          tradeLocks.delete(momentumKey);
          return;
        }
        diagnostics.increment('streamApproved');

        // Use decoded name for token.currency so DB and logs show human-readable name
        const token = { currency: displayCurrency, issuer, rawCurrency: currency, lastUpdated: Date.now() } as any;
        const scoredTp = runtimeLearning.getTpTargets('scored');
        const trade = paperTrader!.tryOpenTrade(
          token, streamSnapshot, 75,
          `[STREAM] ${snap.uniqueBuyers} buyers ${(snap.buySellRatio*100).toFixed(0)}% buys ${snap.buyVolumeXRP.toFixed(0)} XRP | profile: ${decision.profile.name}`,
          scoredTp
        );
        tradeLocks.delete(momentumKey);
        if (trade) {
          trade.tradeProfile = decision.profile.name;
          trade.tradeSource  = 'stream';
          db.updatePaperTrade(trade);
          diagnostics.markTradeOpened(trade.tokenCurrency, trade.tokenIssuer, 'stream');
          setTimeout(() => sendAlert(telegramAlerter, db, {
            type: 'paper_trade_opened',
            tokenCurrency: displayCurrency, tokenIssuer: issuer,
            paperTrade: trade,
            tradeProfileName: decision.profile.name,
            tradeSource: 'stream',
            poolXrpReserve: ammPrice.poolXRP,
            slippage: decision.slippage,
            decisionSizeXRP: decision.sizeXRP,
            message: `Stream entry: ${displayCurrency}`,
          }, config), 0);
        }
      }).catch(() => tradeLocks.delete(momentumKey));
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
    // Log open positions restored from DB — do NOT force-close them.
    // The 2h force-close here was silently wiping active positions on every restart.
    // The orphan checker (checkAllOpenExits) handles exits with live prices each scan cycle.
    const startupOpenPositions = paperTrader.getOpenPositionsSummary();
    if (startupOpenPositions.length > 0) {
      info(`Startup: ${startupOpenPositions.length} open position(s) restored from DB:`);
      for (const pos of startupOpenPositions) {
        const ageMs = Date.now() - (pos.entryTimestamp || 0);
        info(`  ${pos.tokenCurrency} | age: ${(ageMs / 3600000).toFixed(1)}h | remaining: ${pos.remainingPosition}%`);
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

  // Pre-load AMM accounts in the background — don't block startup.
  // With 4000+ tracked tokens this can take 5-15 min if awaited; the bot
  // would miss all trades during that window. Lazy registration still catches
  // tokens on their second buy; preload just closes the first-buy gap.
  burstDetector.preloadAMMs().catch(err =>
    warn(`[preloadAMMs] Non-fatal error during startup preload: ${err}`)
  );

  // Subscribe to live tx stream — activeDiscovery handles token extraction
  await xrplClient.subscribeTransactions((tx) => {
    // Stamp each incoming tx as proof the WS stream is alive
    xrplClient.recordLedger();
    // Real-time buy pressure tracking (runs on every tx, no queue)
    buyPressureTracker.processTransaction(tx);

    // Burst detection — fires early alerts on buy-velocity spikes
    // Watches ALL tokens including ones not yet in the main tracked list
    burstDetector.processTransaction(tx);

    // Token discovery
    const discovered = activeDiscovery.processLiveTx(tx);
    if (discovered) {
      const tracked = activeDiscovery.toTrackedToken(discovered);
      tokenDiscovery.addTrackedToken(tracked);
      // FIX #35: AMMCreate → immediate burst attempt.
      // New pool detected live — register with burstDetector immediately
      // so it tracks buys from tx #1, then attempt a burst entry if pool
      // has enough XRP. This catches launches at second 0, not scan minute.
      if (discovered.source === 'amm_pool' && paperTrader && ammPriceFetcher) {
        const liq = discovered.liquidityXRP ?? 0;
        const poolXRP = liq / 2;
        if (poolXRP >= 300) {
          // Register with burstDetector so it watches buys immediately
          burstDetector.registerNewLaunch(discovered.rawCurrency, discovered.issuer, discovered.currency);
          // Attempt burst entry after short delay — give amm_info time to propagate
          setTimeout(async () => {
            try {
              const livePrice = await ammPriceFetcher.getPrice(
                discovered.rawCurrency, discovered.issuer, discovered.rawCurrency, true
              );
              if (!livePrice || livePrice.priceXRP <= 0 || livePrice.poolXRP < 300) return;
              const launchKey = `${discovered.currency}:${discovered.issuer}`;
              if (paperTrader.hasOpenPosition(discovered.currency, discovered.issuer)) return;
              if (tradeLocks.has(launchKey)) return;
              tradeLocks.add(launchKey);
              info(`[NewLaunch] AMMCreate detected: ${discovered.currency} pool=${livePrice.poolXRP.toFixed(0)} XRP — attempting entry`);
              const launchSnapshot: any = {
                tokenCurrency: discovered.currency, tokenIssuer: discovered.issuer,
                priceXRP: livePrice.priceXRP, liquidityXRP: livePrice.liquidityXRP,
                poolXrpReserve: livePrice.poolXRP,
                buyCount5m: 0, sellCount5m: 0, isNewLaunch: true, tokenAgeMs: 0,
              };
              const launchToken = { currency: discovered.currency, issuer: discovered.issuer, rawCurrency: discovered.rawCurrency, lastUpdated: Date.now() } as any;
              const launchTp = runtimeLearning.getTpTargets('burst');
              tradeDecisionEngine.decide({
                currency: discovered.currency, issuer: discovered.issuer, rawCurrency: discovered.rawCurrency,
                snapshot: launchSnapshot, signalType: 'burst', signalScore: 0,
                bankrollXRP: paperTrader.getState().bankrollXRP,
                openPositions: paperTrader.getOpenPositionsSummary().length,
                dailyPnL: paperTrader.getState().dailyPnL,
                openPositionKeys: new Set(paperTrader.getOpenPositionsSummary().map(p => `${p.tokenCurrency}:${p.tokenIssuer}`)),
                blocklist: BURST_TRADE_BLOCKLIST,
              }).then(decision => {
                tradeLocks.delete(launchKey);
                if (decision.outcome === 'REJECTED') {
                  debug(`[NewLaunch] TDE rejected ${discovered.currency}: ${decision.rejectReason}`);
                  return;
                }
                const trade = paperTrader.tryOpenBurstTrade(
                  launchToken, launchSnapshot,
                  `[NEW_LAUNCH] AMMCreate pool=${livePrice.poolXRP.toFixed(0)} XRP`,
                  launchTp, decision.sizeXRP
                );
                if (trade) {
                  trade.tradeProfile = 'NEW_LAUNCH';
                  trade.tradeSource = 'burst';
                  db.updatePaperTrade(trade);
                  paperTrader.setPositionProfile(discovered.currency, discovered.issuer, 'NEW_LAUNCH' as any);
                  diagnostics.markTradeOpened(trade.tokenCurrency, trade.tokenIssuer, 'burst');
                  setTimeout(() => sendAlert(telegramAlerter, db, {
                    type: 'paper_trade_opened',
                    tokenCurrency: discovered.currency, tokenIssuer: discovered.issuer,
                    paperTrade: trade, tradeProfileName: 'NEW_LAUNCH', tradeSource: 'burst',
                    poolXrpReserve: livePrice.poolXRP, slippage: decision.slippage,
                    decisionSizeXRP: decision.sizeXRP,
                    message: `🆕 New launch entry (AMMCreate): ${discovered.currency}`,
                  }, config), 0);
                }
              }).catch(err => { warn(`[NewLaunch] TDE error: ${err}`); tradeLocks.delete(launchKey); });
            } catch (err) { warn(`[NewLaunch] entry error: ${err}`); }
          }, 3000); // 3s delay for amm_info to propagate
        }
      }
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

  // Periodic AMM sweep every 5 minutes to catch newly created pools
  setInterval(async () => {
    const results = await activeDiscovery.sweepAMMPools();
    results.forEach(dt => tokenDiscovery.addTrackedToken(activeDiscovery.toTrackedToken(dt)));
    if (results.length > 0) info(`AMM sweep: ${results.length} new tokens added`);
  }, 5 * 60 * 1000);

  // Trending seeder — polls xrplmeta.org every 15 min for tokens with high recent
  // trading activity (exchanges_24h, takers_24h, volume_24h). Seeds them into tracking
  // so the scoring engine has time to accumulate live buy-pressure data.
  const trendingSeeder = new TrendingSeeder((trending) => {
    let added = 0;
    for (const t of trending) {
      const tracked = {
        currency: t.currency,
        rawCurrency: t.currency,
        issuer: t.issuer,
        firstSeen: Date.now(),
        lastUpdated: Date.now(),
      };
      const isNew = tokenDiscovery.addTrackedToken(tracked);
      if (isNew) added++;
    }
    if (added > 0) info(`[TrendingSeeder] Seeded ${added} new tokens into tracking`);
  });
  trendingSeeder.start();

  // Background holder refresh — rate-limited to 1 token per 5s.
  // Avoids WS flooding. Prioritises tokens with no cached value.
  setInterval(async () => {
    const tokens = tokenDiscovery.getTrackedTokens();
    const uncached = tokens.filter(t => holderCounter.getCached(t.currency, t.issuer) === null);
    const target = uncached.length > 0 ? uncached[0] : tokens[Math.floor(Math.random() * tokens.length)];
    if (target) {
      holderCounter.getHolderCount(target.currency, target.issuer, target.rawCurrency).catch(() => {});
    }
  }, 5000); // 1 holder fetch per 5s = 12/min, won't flood WS

  // Start periodic scanning with parallel batches
  isRunning = true;
  startPeriodicScan(
    tokenDiscovery, ammScanner, marketData, volumeTracker, holderCounter,
    issuerReputation, correlationDetector,
    riskFilter, tokenScorer, paperTrader, telegramAlerter, db, config,
    ammPriceFetcher, buyPressureTracker, tradeExecutor,
    whaleTracker, liveValidator, socialDetector, runtimeLearning, multiTimeframeScorer,
    missedOpportunityTracker, tradeDecisionEngine, BURST_TRADE_BLOCKLIST
  );

  startHealthCheck(xrplClient, buyPressureTracker, paperTrader);
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
  // If ammScanner has very few pools loaded (e.g. right after startup), skip
  // pool-based pruning entirely — pools load lazily and we'd prune everything.
  const ammPoolsLoaded = ammScanner.getPoolCount();
  const skipPoolPrune = ammPoolsLoaded < 50;

  let kept = tokens.filter(token => {
    // Always keep tokens with open paper positions
    // (checked by currency only since issuer may differ)
    // Keep recently updated tokens
    if (now - token.lastUpdated < PRUNE_AGE_MS) return true;

    // Keep tokens with AMM pools AND a decent score
    // Skip pool check if ammScanner hasn't loaded pools yet
    const pool = ammScanner.findPoolByToken(token.currency, token.issuer);
    if (!pool && !skipPoolPrune) {
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
  socialDetector: SocialDetector,
  runtimeLearning: RuntimeLearning,
  multiTimeframeScorer: MultiTimeframeScorer,
  missedOpportunityTracker: import('./market/missedOpportunityTracker').MissedOpportunityTracker,
  tradeDecisionEngine: import('./execution/tradeDecisionEngine').TradeDecisionEngine,
  BURST_TRADE_BLOCKLIST: Set<string>
): void {
  const MAX_TRACKED_TOKENS = 300; // hard ceiling matches smartPruneTokens HARD_CAP
  const BATCH_SIZE = 10; // Process 10 tokens concurrently
  const HOLDER_SCAN_INTERVAL = 24; // Scan holders every 24th cycle (~6 minutes)
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
              // Use rawCurrency for pressure lookup — tracker records events using the raw hex
              // from RippleState nodes, not the decoded display name.
              const pressureKey = token.rawCurrency || token.currency;
              const pressure = buyPressureTracker.getSnapshot(pressureKey, token.issuer);

              // Merge buy pressure into volume data
              const vol = {
                buyVolume: pressure.buyVolumeXRP,
                sellVolume: pressure.sellVolumeXRP,
                buyCount: pressure.buyCount,
                sellCount: pressure.sellCount,
                uniqueBuyers: pressure.uniqueBuyers,
                uniqueSellers: pressure.uniqueSellers,
              };

              // Holder count: NEVER block the scan on account_lines — use cached value only.
              // Background refresh happens via a separate low-rate queue (see below).
              // This prevents WS flooding when 100+ tokens all need a holder fetch.
              const holders = holderCounter.getCached(token.currency, token.issuer) ?? 0;

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

              // Get buyer wallets for whale detection (now properly exposed by BuyPressureTracker)
              const buyerWallets: string[] = pressure.buyerWallets ?? [];

              // Whale score (synchronous from in-memory registry)
              const whaleBoost = whaleTracker.getWhaleScore(token.currency, token.issuer, buyerWallets);

              // Social score (async, cached 15min via shared WS client)
              const socialBoost = await socialDetector.getSocialScore(token.currency, token.issuer);

              const baseScore = tokenScorer.score(token, snapshot, pool, risks, whaleBoost, socialBoost);

              // Multi-timeframe consensus — adjusts score based on 5m/15m/1h momentum alignment
              const mtf = multiTimeframeScorer.calculate(snapshot, baseScore.totalScore);
              // Only use MTF consensus if trend is bullish — neutral/bearish keeps base score
              const mtfAdjusted = mtf.trend === 'bullish' ? mtf.consensus : baseScore.totalScore;

              // Apply issuer reputation boost/penalty
              const issuerTrust = issuerReputation.getTrustScore(token.issuer);
              const adjustedTotalScore = Math.round(
                mtfAdjusted * 0.8 + issuerTrust * 0.2
              );
              const score = { ...baseScore, totalScore: adjustedTotalScore };

              return { token, snapshot, risks, score };
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
            // Multi-signal gate: require 3+ signals firing together
            const pressure = buyPressureTracker.getSnapshot(token.rawCurrency || token.currency, token.issuer);
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

            // Decode hex currency to its ASCII name for blocklist checks.
            // token.currency may be raw hex (e.g. 524C5553440000...) or decoded name (e.g. RLUSD).
            // Normalising here means one blocklist entry covers both forms.
            const decodedAlertCurrency = (() => {
              if (token.currency.length !== 40) return token.currency;
              try {
                const stripped = token.currency.replace(/00+$/, '');
                const decoded = Buffer.from(stripped, 'hex').toString('ascii').replace(/\x00/g, '');
                return /^[\x20-\x7E]+$/.test(decoded) && decoded.length > 0 ? decoded : token.currency;
              } catch { return token.currency; }
            })();

            // Established/stablecoin tokens — never alert regardless of score or momentum
            const ALERT_BLOCKLIST = new Set([
              // Fiat / stablecoins
              'USD', 'USDC', 'USDT', 'RLUSD', 'EUR', 'BTC', 'ETH', 'CNY', 'GBP', 'JPY', 'AUD', 'CAD',
              // L1 / ecosystem tokens
              'XAH', 'XLM', 'SGB', 'FLR', 'EVR', 'CSC', 'DRO', 'SOLO',
              // Confirmed established XRPL projects (operator-verified)
              'OCT', 'SHX', 'MXI', 'CORE',
            ]);
            // Also filter brand-impersonation hex tokens (e.g. "ARK Invest XRP ETF", "Deutsche Bank")
            const BRAND_KEYWORDS = [
              'invest', 'etf', 'bank', 'financial', 'finance', 'capital', 'fund', 'asset',
              'deutsche', 'blackrock', 'vanguard', 'fidelity', 'grayscale', 'nasdaq', 'nyse',
              'federal', 'reserve', 'treasury', 'sec ', 'cftc', 'imf', 'swift',
              'coinbase', 'binance', 'kraken', 'bitfinex', 'robinhood',
            ];
            const isBrandImpersonation = (() => {
              const lower = decodedAlertCurrency.toLowerCase();
              return BRAND_KEYWORDS.some(kw => lower.includes(kw));
            })();
            const isBlocklisted = ALERT_BLOCKLIST.has(decodedAlertCurrency) || isBrandImpersonation;

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

            // Auto-execute live trade if tradeExecutor is configured (live mode only)
            if (shouldAlert && alertCooldown && riskFilter.isSafe(risks) && tradeExecutor && snapshot.priceXRP) {
              db.setLastAlertTime(token.currency, token.issuer, Date.now());
              // Route live auto-trade through TDE too
              tradeDecisionEngine.decide({
                currency: token.currency, issuer: token.issuer, rawCurrency: token.rawCurrency,
                snapshot: { ...snapshot } as any,
                signalType: 'scored', signalScore: score.totalScore,
                bankrollXRP: config.startingBankrollXRP,
                openPositions: tradeExecutor.getPositionCount(),
                dailyPnL: tradeExecutor.getDailyPnL(),
                openPositionKeys: new Set(tradeExecutor.getOpenPositions().map(p => `${p.currency}:${p.issuer}`)),
                blocklist: BURST_TRADE_BLOCKLIST,
                walletAddress: tradeExecutor.getWalletAddress(),
                walletXrpBalance: undefined,
                wsUrl: config.xrplWsUrl,
                walletSeed: process.env.TRADING_WALLET_SEED,
              }).then(decision => {
                if (decision.outcome === 'REJECTED') { warn(`[TDE] Live auto-trade rejected: ${decision.rejectReason}`); return; }
                tradeExecutor!.openTrade(token.currency, token.issuer, decision.sizeXRP, snapshot.priceXRP!, score.totalScore)
                  .then(r => r.success
                    ? info(`✅ Live trade [${decision.profile.name}]: ${token.currency} | ${decision.sizeXRP.toFixed(2)} XRP | tx: ${r.txHash}`)
                    : warn(`⚠️ Live trade skipped [${decision.profile.name}]: ${token.currency} | ${r.error}`))
                  .catch(err => warn(`Live trade error: ${err}`));
              }).catch(err => warn(`[TDE] Live decision error: ${err}`));
              totalAlerts++;
            }

            // Paper trade entry - require higher consensus
            // tradeLocks prevents parallel batch workers opening duplicate positions
            const tradeKey = `${token.currency}:${token.issuer}`;

            // ── PURE MOMENTUM ENTRY GATE ────────────────────────────────────
            // No score threshold. Enter when momentum signals align directly.
            // This catches moves the score system misses due to data lag.

            const correlationWarning = correlationDetector.getCorrelationWarning(token.currency, token.issuer);
            if (correlationWarning) debug(`Correlation gate: ${correlationWarning}`);

            const priceUp5m    = (snapshot.priceChange5m  ?? 0) >= 5;   // price moving up 5%+
            const priceUp15m   = (snapshot.priceChange15m ?? 0) >= 3;   // confirmed over 15m
            const buyDominated = pressure.buySellRatio >= 0.60 && pressure.buyCount >= 2;
            const volumeSpike  = pressure.buyVolumeXRP >= 50;            // 50+ XRP bought in window
            const newMoneyIn   = pressure.newWalletBuys >= 1;            // fresh wallets entering
            const liquidOk     = (snapshot.liquidityXRP ?? 0) >= config.minLiquidityXRP;

            // For tokens with no price history yet (< 2 scans), priceChange5m/15m will be null/0.
            // Fall back to live buy pressure signals so new tokens aren't blocked by missing history.
            const hasNoPriceHistory = snapshot.priceChange5m == null && snapshot.priceChange15m == null;
            // Volume-only entry: strong live pressure with no history = likely a new token pumping
            const volumeOnlyEntry   = hasNoPriceHistory
              && pressure.buyVolumeXRP >= 60
              && pressure.buySellRatio >= 0.65
              && pressure.uniqueBuyers >= 2
              && liquidOk;

            // Need at least 2 of the 4 momentum signals + buys dominating + liquidity ok
            const momentumSignals = [priceUp5m, priceUp15m, volumeSpike, newMoneyIn].filter(Boolean).length;
            const momentumEntry = (momentumSignals >= 2 && buyDominated && liquidOk) || volumeOnlyEntry;

            // Track near-miss signals for missed opportunity analysis
            if (!momentumEntry && (momentumSignals >= 1 || hasNoPriceHistory) && snapshot.priceXRP && snapshot.liquidityXRP) {
              missedOpportunityTracker.record({
                currency: token.currency,
                issuer: token.issuer,
                rawCurrency: token.rawCurrency,
                skippedAt: Date.now(),
                skipReason: !liquidOk ? 'low_liquidity'
                  : !buyDominated ? 'buy_not_dominant'
                  : `signals_${momentumSignals}_of_4`,
                priceAtSkip: snapshot.priceXRP,
                poolXrpReserve: snapshot.poolXrpReserve ?? snapshot.liquidityXRP / 2,
              });
            }

            // Skip if this token was recently force-closed for no-price
            const noPriceCooldownActive = noPriceCooldowns.has(tradeKey) &&
              Date.now() - (noPriceCooldowns.get(tradeKey) ?? 0) < NO_PRICE_COOLDOWN_MS;
            if (noPriceCooldownActive) {
              debug(`[Scored] No-price cooldown active for ${token.currency} — skipping entry`);
            }

            if (paperTrader && momentumEntry &&
                riskFilter.isSafe(risks) && !isBlocklisted && !tradeLocks.has(tradeKey) && !correlationWarning && !noPriceCooldownActive) {
              tradeLocks.add(tradeKey);
              const entryReason = [
                priceUp5m  ? `+${snapshot.priceChange5m?.toFixed(1)}% 5m` : null,
                priceUp15m ? `+${snapshot.priceChange15m?.toFixed(1)}% 15m` : null,
                buyDominated ? `buys ${(pressure.buySellRatio*100).toFixed(0)}%` : null,
                volumeSpike ? `vol ${pressure.buyVolumeXRP.toFixed(0)} XRP` : null,
                newMoneyIn  ? `${pressure.newWalletBuys} new wallets` : null,
              ].filter(Boolean).join(' | ');

              // Route through TradeDecisionEngine
              tradeDecisionEngine.decide({
                currency: token.currency, issuer: token.issuer, rawCurrency: token.rawCurrency,
                snapshot: { ...snapshot, poolXrpReserve: snapshot.poolXrpReserve } as any,
                signalType: 'scored', signalScore: score.totalScore,
                bankrollXRP: paperTrader.getState().bankrollXRP,
                openPositions: paperTrader.getOpenPositionsSummary().length,
                dailyPnL: paperTrader.getState().dailyPnL,
                openPositionKeys: new Set(paperTrader.getOpenPositionsSummary().map(p => `${p.tokenCurrency}:${p.tokenIssuer}`)),
                blocklist: BURST_TRADE_BLOCKLIST,
              }).then(async decision => {
                if (decision.outcome === 'REJECTED') {
                  info(`[TDE] Scored rejected: ${decision.rejectReason}`);
                  diagnostics.recordTdeReject(decision.rejectReason, 'scored');
                  tradeLocks.delete(tradeKey);
                  return;
                }
        const scoredTp = runtimeLearning.getTpTargets('scored');
        // FIX #34: Pre-entry live AMM check — snapshot up to 90s stale.
        // Abort if AMM gone or pool drained >60% since scan.
        const _live = await ammPriceFetcher.getPrice(
          token.rawCurrency || token.currency, token.issuer, token.rawCurrency, true
        );
        if (!_live || _live.priceXRP <= 0) {
          warn(`[PreEntry] ${token.currency} — no live AMM price, aborting scored entry`);
          noPriceCooldowns.set(tradeKey, Date.now());
          tradeLocks.delete(tradeKey);
          return;
        }
        const _snapPool = snapshot.poolXrpReserve ?? (snapshot.liquidityXRP ? snapshot.liquidityXRP / 2 : 0);
        if (_snapPool > 200 && _live.poolXRP < _snapPool * 0.4) {
          warn(`[PreEntry] ${token.currency} — pool drained ${_live.poolXRP.toFixed(0)} vs ${_snapPool.toFixed(0)} XRP, aborting`);
          tradeLocks.delete(tradeKey);
          return;
        }
        const trade = paperTrader.tryOpenTrade(
          token,
          { ...snapshot, priceXRP: _live.priceXRP, poolXrpReserve: _live.poolXRP },
          score.totalScore,
          `[SCORED] ${entryReason} | profile: ${decision.profile.name}`,
          scoredTp
        );
                tradeLocks.delete(tradeKey);
                if (trade) {
                  trade.tradeProfile = decision.profile.name;
                  trade.tradeSource  = 'scored';
                  db.updatePaperTrade(trade);
                  diagnostics.markTradeOpened(trade.tokenCurrency, trade.tokenIssuer, 'scored');
                  setTimeout(() => sendAlert(telegramAlerter, db, {
                    type: 'paper_trade_opened',
                    tokenCurrency: token.currency, tokenIssuer: token.issuer,
                    paperTrade: trade,
                    tradeProfileName: decision.profile.name,
                    tradeSource: 'scored',
                    poolXrpReserve: snapshot.poolXrpReserve,
                    slippage: decision.slippage,
                    decisionSizeXRP: decision.sizeXRP,
                    message: `Opened scored trade for ${token.currency}`,
                  }, config), 0);
                  totalTrades++;
                  if (process.env.TRADING_WALLET_SEED && snapshot.priceXRP) {
                    liveValidator.recordIntended(token.currency, token.issuer, snapshot.priceXRP, trade.entryAmountXRP);
                  }
                }
              }).catch(err => { warn(`[TDE] Scored decision error: ${err}`); tradeLocks.delete(tradeKey); });
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

                // Record whale wallets after a winning trade (>15% PnL) — lowered from 50%
                // Now uses real buyerWallets exposed by BuyPressureTracker
                if (ct.status === 'closed' && ct.pnlPercent !== null && ct.pnlPercent > 15) {
                  const pressure = buyPressureTracker.getSnapshot(ct.tokenCurrency, ct.tokenIssuer);
                  const earlyBuyers: string[] = pressure.buyerWallets ?? [];
                  if (earlyBuyers.length > 0) {
                    whaleTracker.recordWinner(
                      ct.tokenCurrency,
                      ct.tokenIssuer,
                      earlyBuyers,
                      ct.pnlXRP ?? 0
                    );
                    whaleTracker.save(db);
                    info(`[WhaleTracker] Recorded ${earlyBuyers.length} early buyers from winning trade ${ct.tokenCurrency} (+${ct.pnlPercent.toFixed(1)}%)`);
                  }
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
        const orphanClosed = await paperTrader.checkAllOpenExits(async (currency, issuer, rawCurrency) => {
          const p = await ammPriceFetcher.getPrice(currency, issuer, rawCurrency);
          return p?.priceXRP ?? null;
        });
        for (const ct of orphanClosed) {
          totalTrades++;
          // Suppress ghost-close alerts (no-price / force-close at entry) — just log them
          if (ct.exitReason === 'force_close_no_price') {
            info(`Ghost close (no price): ${ct.tokenCurrency} — position voided, bankroll returned`);
            // Add to no-price cooldown — don't re-enter this token for 6h
            const cooldownKey = `${ct.tokenCurrency}:${ct.tokenIssuer}`;
            noPriceCooldowns.set(cooldownKey, Date.now());
            info(`[NoPriceCooldown] ${ct.tokenCurrency} blocked for 6h after force_close_no_price`);

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
  scanInterval = setInterval(scanTokens, 15000);

  // Hourly summary + hot token leaderboard
  hourlySummaryTimer = setInterval(async () => {
    // ── Hourly open positions update ────────────────────────────────
    // Only report on what the bot is actually trading.
    // No trending tokens, no scanner noise — just the open positions.

    const fmtP = (xrp: number | null | undefined): string => {
      if (xrp == null || isNaN(xrp)) return 'N/A';
      if (xrp >= 1) return xrp.toFixed(4) + ' XRP';
      if (xrp >= 0.0001) return xrp.toFixed(6) + ' XRP';
      return xrp.toFixed(8) + ' XRP';
    };
    const decodeCurrencyLocal = (raw: string): string => {
      if (!raw || raw.length !== 40) return raw || 'UNKNOWN';
      try {
        const stripped = raw.replace(/00+$/, '');
        const decoded = Buffer.from(stripped, 'hex').toString('ascii').replace(/\x00/g, '').trim();
        if (/^[ -~]+$/.test(decoded) && decoded.length > 0) return decoded;
      } catch {}
      return raw.slice(0, 8) + '…';
    };

    if (!paperTrader) return;

    const state = paperTrader.getState();
    const now   = Date.now();

    // Cross-check in-memory vs DB — DB is the source of truth.
    // If a position is open/partial in DB but absent from memory (e.g. after a
    // code path mismatch), reload it so the hourly report is always accurate.
    const dbOpenTrades = db.getOpenTrades();
    const memPositions = paperTrader.getOpenPositionsSummary();
    const memKeys      = new Set(memPositions.map((p: any) => `${p.tokenCurrency}:${p.tokenIssuer}`));
    for (const t of dbOpenTrades) {
      const k = `${t.tokenCurrency}:${t.tokenIssuer}`;
      if (!memKeys.has(k)) {
        warn(`Hourly: DB position ${k} missing from memory — reloading`);
        paperTrader.hasOpenPosition(t.tokenCurrency, t.tokenIssuer); // triggers loadOpenPositionFromDB
      }
    }

    // Re-read after potential reload
    const openPositions = paperTrader.getOpenPositionsSummary();

    // Fetch live prices for all open positions in parallel
    const livePriceResults = await Promise.allSettled(
      openPositions.map((pos: any) =>
        ammPriceFetcher.getPrice(pos.tokenCurrency, pos.tokenIssuer)
          .then((r: any) => ({ key: `${pos.tokenCurrency}:${pos.tokenIssuer}`, price: r?.priceXRP ?? null }))
          .catch(() => ({ key: `${pos.tokenCurrency}:${pos.tokenIssuer}`, price: null }))
      )
    );
    const priceMap = new Map<string, number | null>();
    for (const r of livePriceResults) {
      if (r.status === 'fulfilled') priceMap.set(r.value.key, r.value.price);
    }

    const lines: string[] = [
      `💼 <b>OPEN POSITIONS</b>`,
      `<i>${new Date().toUTCString()}</i>`,
      ``,
      `<b>Bankroll:</b>  ${state.bankrollXRP.toFixed(2)} XRP`,
      `<b>Daily P&L:</b> ${state.dailyPnL >= 0 ? '+' : ''}${state.dailyPnL.toFixed(2)} XRP`,
      `<b>Open:</b>      ${db.getOpenPositionCount()} open | ${db.getPartialPositionCount()} partial${openPositions.length !== 1 ? 's' : ''}`,
    ];
    lines.push('');
    const closed6h = db.getClosedTradeCountSince(6*3600*1000);
    const totalClosed = db.getTotalClosedTradeCount();
    lines.push(`Closed:  ${closed6h} in last 6h / ${totalClosed} all-time`);
    const win6h = db.getWinningTradeCountSince(6*3600*1000);
    lines.push(`Win rate: ${closed6h > 0 ? ((win6h/closed6h)*100).toFixed(1) : 'N/A'}% (6h window)`);

    if (openPositions.length === 0) {
      lines.push('', '<i>No open positions.</i>');
    } else {
      lines.push('');
      for (const pos of openPositions) {
        const ticker    = decodeCurrencyLocal(pos.tokenCurrency);
        const ageMs     = now - (pos.entryTimestamp || now);
        const ageStr    = ageMs >= 3600000
          ? `${Math.floor(ageMs / 3600000)}h ${Math.round((ageMs % 3600000) / 60000)}m`
          : `${Math.round(ageMs / 60000)}m`;

        // Use fresh AMM price for P&L; fall back to in-memory best
        const posKey    = `${pos.tokenCurrency}:${pos.tokenIssuer}`;
        const livePrice = priceMap.get(posKey) ?? null;
        const livePct   = livePrice != null && pos.entryPriceXRP > 0
          ? ((livePrice - pos.entryPriceXRP) / pos.entryPriceXRP) * 100
          : pos.livePnlPct;
        const livePnl   = livePct != null
          ? (livePct / 100) * pos.entryAmountXRP * ((pos.remainingPosition ?? 100) / 100)
          : pos.livePnlXRP;

        const pnlStr    = livePnl != null
          ? `${livePnl >= 0 ? '+' : ''}${livePnl.toFixed(2)} XRP (${livePct != null ? (livePct >= 0 ? '+' : '') + livePct.toFixed(1) + '%' : '?'})`
          : 'pending price';
        const pnlIcon   = (livePnl ?? 0) >= 0 ? '🟢' : '🔴';
        const typeIcon  = pos.isBurst ? '🚀' : '📈';
        const priceTag  = livePrice != null ? ` @ ${fmtP(livePrice)}` : '';

        lines.push(
          `${typeIcon} <b>${ticker}</b>${priceTag}`,
          `  Entry: ${fmtP(pos.entryPriceXRP)} | Size: ${pos.entryAmountXRP.toFixed(2)} XRP`,
          `  Age: ${ageStr} | ${pnlIcon} P&L: ${pnlStr}`,
          `  Remaining: ${pos.remainingPosition ?? 100}% | TP1: ${pos.tp1Hit ? '✅' : '⬜'} TP2: ${pos.tp2Hit ? '✅' : '⬜'}`,
          '',
        );
      }
    }

    await telegramAlerter.sendAlert({
      type: 'open_positions_update',
      message: lines.join('\n'),
    });

    // ── Diagnostics report ──────────────────────────────────────────────
    try {
      await diagnostics.refreshMissedMovers(async (token) => {
        const p = await ammPriceFetcher.getPrice(
          token.rawCurrency || token.token, token.issuer, token.rawCurrency
        ).catch(() => null);
        return p?.priceXRP ?? null;
      });
    } catch { /* non-critical */ }
    const diagMsg = diagnostics.formatHourlySummary();
    diagnostics.resetHourly();
    sendAlert(telegramAlerter, db, { type: 'open_positions_update', message: diagMsg }, config);
  }, 3600000);

  // FIX #33: shadow backtest resolver — runs every hour, resolves shadow trades >4h old
  setInterval(() => {
    db.resolveShadowTrades(async (currency, issuer, rawCurrency) => {
      return ammPriceFetcher.getPrice(currency, issuer, rawCurrency ?? undefined)
        .then(p => p?.priceXRP ?? null);
    });
  }, 60 * 60 * 1000);

  // ── Trade analysis cron: runs every 6h ────────────────────────────
  const tradeAnalyzer = new TradeAnalyzer(db);

  // Also expose manual trigger via a simple check at startup
  const runAnalysis = async () => {
    info('[BotLog] 6h analysis triggered — building bot log...');
    try {
    const recs = tradeAnalyzer.analyze(); // null if < 5 trades
    const state = paperTrader ? paperTrader.getState() : null;

    // ── 6h forwardable bot log ─────────────────────────────────────
    // Load live weights from tokenScorer directly — never from stale recs cache
    const w = tokenScorer.getWeights?.() ?? recs?.scoreWeights;
    const logLines: string[] = [
      `BOT LOG - ${new Date().toUTCString()}`,
      ``,
      `PORTFOLIO`,
      state ? `Bankroll: ${state.bankrollXRP.toFixed(2)} XRP | Daily P&L: ${state.dailyPnL >= 0 ? '+' : ''}${state.dailyPnL.toFixed(2)} XRP | Open: ${state.openPositions}` : 'N/A',
      ``,
      `TRADE HISTORY`,
      (() => { const t = db.getTotalClosedTradeCount(); const w = db.getWinningTradeCountSince(999*24*3600*1000); const wr = t > 0 ? ((w/t)*100).toFixed(1) : 'N/A'; return `Trades: ${t} | Win rate: ${wr}% (all-time, incl ghosts)`; })(),
      (() => { try { const rows = (db as any).db.prepare(`SELECT COUNT(*) as c, ROUND(100.0*SUM(CASE WHEN pnl_xrp>0 THEN 1 ELSE 0 END)/COUNT(*),1) as wr, ROUND(SUM(pnl_xrp),2) as net FROM paper_trades WHERE status='closed' AND exit_reason!='force_close_no_price'`).get() as any; return `Real trades: ${rows.c} | WR: ${rows.wr}% | Net: ${rows.net >= 0 ? '+' : ''}${rows.net} XRP`; } catch { return ''; } })(),
      (() => { try { const rows = (db as any).db.prepare(`SELECT trade_profile, COUNT(*) as c, ROUND(100.0*SUM(CASE WHEN pnl_xrp>0 THEN 1 ELSE 0 END)/COUNT(*),1) as wr, ROUND(SUM(pnl_xrp),2) as net FROM paper_trades WHERE status='closed' AND exit_reason!='force_close_no_price' AND trade_profile IS NOT NULL GROUP BY trade_profile ORDER BY net DESC`).all() as any[]; return rows.map((r: any) => `  ${r.trade_profile}: ${r.c}t WR ${r.wr}% net ${r.net >= 0 ? '+' : ''}${r.net} XRP`).join('\n'); } catch { return ''; } })(),
      ``,
      ...(recs ? [
        `PARAMS`,
        `Min score: ${config.minScorePaperTrade} | Min liq: ${config.minLiquidityXRP ?? 500} XRP`,
        `BURST_SCALP  - Stop: -${(require('./execution/tradeProfiles').PROFILES.BURST_SCALP.stopLossPct ?? '?')}% | TP1: +${(require('./execution/tradeProfiles').PROFILES.BURST_SCALP.tp1Pct ?? '?')}% sell${(require('./execution/tradeProfiles').PROFILES.BURST_SCALP.tp1SellPct ?? '?')}% | TP2: +${(require('./execution/tradeProfiles').PROFILES.BURST_SCALP.tp2Pct ?? '?')}% | trail@+${(require('./execution/tradeProfiles').PROFILES.BURST_SCALP.trailActivationPct ?? '?')}%`,
        `NEW_LAUNCH   - Stop: -${(require('./execution/tradeProfiles').PROFILES.NEW_LAUNCH.stopLossPct ?? '?')}% | TP1: +${(require('./execution/tradeProfiles').PROFILES.NEW_LAUNCH.tp1Pct ?? '?')}% sell${(require('./execution/tradeProfiles').PROFILES.NEW_LAUNCH.tp1SellPct ?? '?')}% | TP2: +${(require('./execution/tradeProfiles').PROFILES.NEW_LAUNCH.tp2Pct ?? '?')}% | trail@+${(require('./execution/tradeProfiles').PROFILES.NEW_LAUNCH.trailActivationPct ?? '?')}% (moonbag)`,
        `LOW_LIQ_PROBE - Stop: -${(require('./execution/tradeProfiles').PROFILES.LOW_LIQ_PROBE.stopLossPct ?? '?')}% | TP1: +${(require('./execution/tradeProfiles').PROFILES.LOW_LIQ_PROBE.tp1Pct ?? '?')}% | TP2: +${(require('./execution/tradeProfiles').PROFILES.LOW_LIQ_PROBE.tp2Pct ?? '?')}%`,
        `Max open trades: ${config.maxOpenTrades} | Max daily loss: ${config.maxDailyLossXRP} XRP | Mode: ${config.mode}`,
        ``,
        `WEIGHTS`,
        `Momentum: ${w?.volumeAccelScore} | Buy pressure: ${w?.buyPressureScore} | New wallets: ${w?.holderGrowthScore} | Vol surge: ${w?.liquidityScore}`,
        ``,
        `INSIGHTS`,
        ...((Date.now() - recs.generatedAt < 12 * 3600 * 1000)
          ? recs.insights.slice(0, 8).map((i: string) => `- ${i}`)
          : ['- Stale data — insights will refresh after next analysis run']),
        ``,
        `RUN LENGTHS`,
        `Median: +${recs.medianRunPct}% | P75: +${recs.p75RunPct}% | Burst: +${recs.burstMedianRunPct}% | Scored: +${recs.scoredMedianRunPct}%`,
        ``,
      ] : []),
      `Forward to review and improve the bot.`,
    ].filter((l): l is string => l !== undefined);

    // Append profile stats (grouped by profile, not old BURST/SCORED labels)
    try {
      const profileStats = db.getProfileStats();
      const profileNames = Object.keys(profileStats);
      if (profileNames.length > 0) {
        logLines.push('', 'PROFILE STATS (by TradeDecisionEngine profile)');
        for (const [pName, ps] of Object.entries(profileStats)) {
          const s = ps as any;
          logLines.push(
            `${pName}: ${s.trades}t | WR ${(s.winRate*100).toFixed(0)}% | ` +
            `avgW +${s.avgWinPct.toFixed(1)}% avgL ${s.avgLossPct.toFixed(1)}% | ` +
            `best +${s.bestRunPct.toFixed(1)}% | hold ${(s.avgHoldMs/60000).toFixed(0)}m | ` +
            `net ${s.netPnlXRP >= 0 ? '+' : ''}${s.netPnlXRP.toFixed(2)} XRP`
          );
        }
      } else {
        logLines.push('', 'PROFILE STATS: no closed trades with profile data yet');
      }
    } catch { /* non-critical */ }

    const logText = logLines.join('\n');
    info(`[BotLog] Sending bot log (${logText.length} chars, ${logLines.length} lines)`);
    // Route through sendAlert wrapper so it's saved to DB and goes through
    // cooldown + chunking logic (bot_log is sent as plain text, not HTML).
    await sendAlert(telegramAlerter, db, {
      type: 'bot_log',
      message: logText,
    }, config);

    // Auto-apply and hot-reload only if we have enough data
    if (recs) {
      if (recs.autoApplyReady) {
        info('TradeAnalyzer: auto-apply threshold met - applying recommendations');
        const configPath = process.env.CONFIG_PATH || './bot-config.json';
        tradeAnalyzer.applyRecommendations(recs, configPath);
      }
      tokenScorer.loadLearnedWeights();
      runtimeLearning.reload();
      info('TradeAnalyzer: scorer weights and runtime learning reloaded');
    }
    info('[BotLog] Bot log sent successfully.');
    } catch (err) {
      error(`[BotLog] runAnalysis failed: ${err}`);
    }
  };

  setInterval(runAnalysis, 6 * 60 * 60 * 1000); // every 6 hours
  // Also run once after 5 min (was 30 min — too long to notice if broken)
  setTimeout(runAnalysis, 5 * 60 * 1000);

  // Fix 9: Reset daily P&L tracking at midnight UTC
  const scheduleMidnightReset = () => {
    const now = new Date();
    const msUntilMidnight = (
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
        .getTime() - Date.now()
    );
    setTimeout(() => {
      if (paperTrader) paperTrader.resetDailyTracking();
      scheduleMidnightReset(); // reschedule for next midnight
    }, msUntilMidnight);
    info(`[DailyReset] Next bankroll reset in ${(msUntilMidnight / 3600000).toFixed(1)}h`);
  };
  scheduleMidnightReset();
}



/**
 * Health check interval
 */
function startHealthCheck(
  xrplClient: XRPLClient,
  buyPressureTracker?: import('./market/buyPressureTracker').BuyPressureTracker,
  paperTrader?: import('./paper/paperTrader').PaperTrader | null
): void {
  const STALE_STREAM_MS = 90_000; // 90s with no tx = stream likely dead
  healthCheckInterval = setInterval(() => {
    const status = xrplClient.getStatus();
    const txStats = xrplClient.getTxStats();
    const streamAgeMs = status.lastLedgerAgeMs;

    if (!status.connected) {
      warn('⚠️  Health: NOT connected to XRPL — waiting for reconnect');
      return;
    }

    // Detect silent stream death (connected flag = true but no data)
    if (streamAgeMs > STALE_STREAM_MS && streamAgeMs !== -1) {
      warn(`⚠️  Health: WS stream STALE — last tx ${Math.round(streamAgeMs/1000)}s ago (threshold: ${STALE_STREAM_MS/1000}s). Forcing reconnect.`);
      // Use forceReconnect() which properly tears down state and re-subscribes
      xrplClient.forceReconnect().catch((e: any) => warn(`forceReconnect error: ${e}`));
      return;
    }

    const state = paperTrader?.getState();
    const streamStatus = streamAgeMs === -1 ? 'no data yet' : `last tx ${Math.round(streamAgeMs/1000)}s ago`;
    info(`💓 Health: connected | stream: ${streamStatus} | raw txs: ${txStats.raw} | bankroll: ${state?.bankrollXRP?.toFixed(2) ?? '?'} XRP | open: ${state?.openPositions ?? 0}`);
  }, 60_000); // check every 60s (was 300s — too slow to catch drops)
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

  healthServer.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') {
      warn(`Port ${PORT} already in use — health endpoint skipped (bot continues normally)`);
    } else {
      warn(`Health server error: ${err.message}`);
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

// Catch unhandled promise rejections — mainly xrpl.js DisconnectedError bubbling
// out of event emitters. Log and continue; the reconnect handler will recover.
process.on('unhandledRejection', (reason: any) => {
  const msg = reason?.message || String(reason);
  const isXrplTransient = (
    msg.includes('DisconnectedError') ||
    msg.includes('websocket was closed') ||
    msg.includes('threshold exceeded') ||
    msg.includes('NotConnectedError') ||
    msg.includes('TimeoutError') ||
    msg.includes('Connection reset') ||
    msg.includes('ECONNRESET')
  );
  if (isXrplTransient) {
    warn(`XRPL transient rejection (handled): ${msg}`);
  } else {
    error(`Unhandled rejection: ${msg}`);
  }
});

// Track recent exits to prevent rapid crash loops
let lastExitAttempt = 0;
process.on('uncaughtException', (err: Error) => {
  const msg = err?.message || String(err);
  const isXrplTransient = (
    msg.includes('DisconnectedError') ||
    msg.includes('websocket was closed') ||
    msg.includes('threshold exceeded') ||
    msg.includes('NotConnectedError') ||
    msg.includes('TimeoutError') ||
    msg.includes('Connection reset') ||
    msg.includes('ECONNRESET')
  );
  if (isXrplTransient) {
    warn(`XRPL transient error (handled, no exit): ${msg}`);
  } else {
    error(`Uncaught exception: ${msg}`);
    // Rate-limit exits: don\'t crash-loop faster than 30s
    const now = Date.now();
    if (now - lastExitAttempt > 30000) {
      lastExitAttempt = now;
      process.exit(1); // only exit on truly unexpected errors
    }
  }
});

main().catch((err) => {
  error(`Fatal startup error: ${err}`);
  process.exit(1);
});
