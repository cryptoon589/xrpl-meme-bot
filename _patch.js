const fs = require('fs');
let s = fs.readFileSync('src/index.ts', 'utf8');

const replacement = `  scanTokens();
  scanInterval = setInterval(scanTokens, 60000);

  // Hourly summary + hot token leaderboard (every 60 min)
  hourlySummaryTimer = setInterval(async () => {
    const rawStats = xrplClient.getTxStats();
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
      message: lines.join('\n'),
    });
  }, 3600000);
}

async function sendHighScoreAlert(`;

const marker = '  scanTokens();\n  scanInterval = setInterval(scanTokens, 60000);\n}\n\nasync function sendHighScoreAlert';

if (!s.includes(marker)) {
  console.log('Marker not found');
  process.exit(1);
}

s = s.replace(marker, replacement);
fs.writeFileSync('src/index.ts', s);
console.log('done');