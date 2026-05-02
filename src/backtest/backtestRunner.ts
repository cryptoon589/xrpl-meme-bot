/**
 * Backtest Runner — standalone script
 *
 * Usage: node dist/backtest/backtestRunner.js
 *
 * Environment variables (all optional):
 *   BACKTEST_DAYS       — days back from now to start backtest (default: 7)
 *   BACKTEST_MIN_SCORE  — minimum score threshold (default: 65)
 *   BACKTEST_SL         — stop loss % (default: 15)
 *   BACKTEST_TP         — take profit % (default: 50)
 *   BACKTEST_TRADE_SIZE — XRP per simulated trade (default: 10)
 *   BACKTEST_MAX_TRADES — max concurrent open trades (default: 5)
 */

import 'dotenv/config';
import path from 'path';
import { Database } from '../db/database';
import { BacktestEngine, BacktestConfig } from './backtestEngine';

function fmt(n: number, decimals = 2): string {
  return n.toFixed(decimals);
}

async function main(): Promise<void> {
  const daysBack    = parseInt(process.env.BACKTEST_DAYS       || '7',  10);
  const minScore    = parseInt(process.env.BACKTEST_MIN_SCORE  || '65', 10);
  const stopLoss    = parseFloat(process.env.BACKTEST_SL        || '15');
  const takeProfit  = parseFloat(process.env.BACKTEST_TP        || '50');
  const tradeSize   = parseFloat(process.env.BACKTEST_TRADE_SIZE || '10');
  const maxTrades   = parseInt(process.env.BACKTEST_MAX_TRADES  || '5',  10);

  const endDate   = new Date();
  const startDate = new Date(endDate.getTime() - daysBack * 24 * 60 * 60 * 1000);

  const dbPath = path.join(process.cwd(), 'data', 'meme_bot.db');
  const db = new Database(dbPath);

  const config: BacktestConfig = {
    startDate,
    endDate,
    minScore,
    stopLossPercent: stopLoss,
    takeProfitPercent: takeProfit,
    tradeSize,
    maxOpenTrades: maxTrades,
  };

  const engine = new BacktestEngine(db);
  const result = await engine.run(config);

  // ─── Print Report ───────────────────────────────────────────────────────────

  console.log('\n' + '═'.repeat(60));
  console.log('  XRPL MEME BOT — BACKTEST REPORT');
  console.log('═'.repeat(60));
  console.log(`  Period:       ${startDate.toDateString()} → ${endDate.toDateString()}`);
  console.log(`  Min Score:    ${minScore}`);
  console.log(`  Stop Loss:    -${stopLoss}%`);
  console.log(`  Take Profit:  +${takeProfit}%`);
  console.log(`  Trade Size:   ${tradeSize} XRP`);
  console.log(`  Max Trades:   ${maxTrades}`);
  console.log('─'.repeat(60));
  console.log(`  Total Trades:   ${result.totalTrades}`);
  console.log(`  Win Rate:       ${fmt(result.winRate * 100)}%`);
  console.log(`  Total PnL:      ${result.totalPnLXRP >= 0 ? '+' : ''}${fmt(result.totalPnLXRP)} XRP`);
  console.log(`  Avg PnL/Trade:  ${result.avgPnLPercent >= 0 ? '+' : ''}${fmt(result.avgPnLPercent)}%`);
  console.log(`  Max Drawdown:   ${fmt(result.maxDrawdown)} XRP`);

  if (result.bestTrade) {
    console.log(`  Best Trade:     ${result.bestTrade.tokenCurrency} +${fmt(result.bestTrade.pnlPercent)}% (score ${result.bestTrade.entryScore})`);
  }
  if (result.worstTrade) {
    console.log(`  Worst Trade:    ${result.worstTrade.tokenCurrency} ${fmt(result.worstTrade.pnlPercent)}% (score ${result.worstTrade.entryScore})`);
  }

  if (result.byScoreBucket.length > 0) {
    console.log('\n  ── BY SCORE BUCKET ──');
    for (const bucket of result.byScoreBucket) {
      if (bucket.tradeCount === 0) continue;
      console.log(
        `  [${bucket.bucket.padEnd(6)}]  trades=${bucket.tradeCount}  ` +
        `win=${fmt(bucket.winRate * 100)}%  ` +
        `avgPnL=${bucket.avgPnLPercent >= 0 ? '+' : ''}${fmt(bucket.avgPnLPercent)}%  ` +
        `pnl=${bucket.totalPnLXRP >= 0 ? '+' : ''}${fmt(bucket.totalPnLXRP)} XRP`
      );
    }
  }

  // Exit reason breakdown
  if (result.trades.length > 0) {
    const tpCount  = result.trades.filter(t => t.exitReason === 'take_profit').length;
    const slCount  = result.trades.filter(t => t.exitReason === 'stop_loss').length;
    const toCount  = result.trades.filter(t => t.exitReason === 'timeout').length;
    console.log('\n  ── EXIT REASONS ──');
    console.log(`  Take Profit: ${tpCount} (${fmt((tpCount / result.totalTrades) * 100)}%)`);
    console.log(`  Stop Loss:   ${slCount} (${fmt((slCount / result.totalTrades) * 100)}%)`);
    console.log(`  Timeout:     ${toCount} (${fmt((toCount / result.totalTrades) * 100)}%)`);
  }

  console.log('═'.repeat(60) + '\n');

  db.close();
  process.exit(0);
}

main().catch(err => {
  console.error('Backtest failed:', err);
  process.exit(1);
});
