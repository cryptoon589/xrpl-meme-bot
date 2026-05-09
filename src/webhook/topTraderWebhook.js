/**
 * Top Trader Webhook Server
 *
 * Lightweight HTTP server that receives top trader data from FirstLedger
 * and writes it to state/top_traders_import.json for the bot to ingest.
 *
 * Run standalone:  node dist/webhook/topTraderWebhook.js
 * Or with PM2:     node dist/webhook/topTraderWebhook.js
 *
 * Environment:
 *   WEBHOOK_PORT=3456   Port for the HTTP server (default 3456)
 *   WEBHOOK_SECRET=x    Bearer token auth (optional, recommended)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '../../state/top_traders_import.json');
const PORT = parseInt(process.env.WEBHOOK_PORT || '3456', 10);
const SECRET = process.env.WEBHOOK_SECRET || null;

function authMiddleware(authHeader) {
  if (!SECRET) return true;
  if (!authHeader) return false;
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  return token === SECRET;
}

function writeTradersToState(traders) {
  const payload = {
    importedAt: Date.now(),
    source: 'firstledger_radar',
    traders,
  };
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(payload, null, 2));
  return payload;
}

const server = http.createServer((req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS' });
    res.end();
    return;
  }

  // Health check
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  // Main webhook
  if (req.url === '/webhook/top-traders' && req.method === 'POST') {
    if (!authMiddleware(req.headers.authorization)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let data;
      try {
        data = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }

      const { traders } = data;
      if (!Array.isArray(traders) || traders.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'traders must be a non-empty array' }));
        return;
      }

      for (const t of traders) {
        if (!t.address || typeof t.winRatePct !== 'number' || typeof t.volumeXrp !== 'number') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Each trader needs address, winRatePct, volumeXrp' }));
          return;
        }
      }

      try {
        writeTradersToState(traders);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, imported: traders.length, file: STATE_FILE }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to write state file' }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`[TopTraderWebhook] Server listening on port ${PORT}`);
});
