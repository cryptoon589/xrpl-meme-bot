const fs = require('fs');
let src = fs.readFileSync('src/index.ts', 'utf8');

// 1. Increment newTokenDetections when new token found
const old1 = '  const newToken = await tokenDiscovery.processTransaction(tx);\n  if (newToken) {';
const repl1 = '  const newToken = await tokenDiscovery.processTransaction(tx);\n  if (newToken) {\n    newTokenDetections++;';
src = src.replace(old1, repl1);

// 2. Track top tokens after scoring
const old2 = '            totalProcessed++;\n\n            // Hysteresis: only alert on upward threshold cross';
const repl2 = '            totalProcessed++;\n              tokensScored++;\n\n              // Track top tokens for leaderboard\n              if (snapshot && score) {\n                topTokens.push({\n                  currency: token.currency,\n                  issuer: token.issuer,\n                  score: score.totalScore,\n                  liquidity: snapshot.liquidity || 0,\n                  change1h: snapshot.priceChange1h || 0,\n                });\n              }\n\n            // Hysteresis: only alert on upward threshold cross';
src = src.replace(old2, repl2);

fs.writeFileSync('src/index.ts', src);
console.log('Step 2 done');