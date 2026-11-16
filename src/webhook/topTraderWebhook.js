/**
 * Hunterix operator-authenticated top-trader review webhook.
 *
 * SECURITY / SIGNAL PROVENANCE:
 * - An HTTP upload is NOT independently verified FirstLedger performance.
 * - It NEVER rewrites the historical operator wallet file.
 * - Only explicit operator approval with a recent observation timestamp
 *   enables these statistics to be considered for PAPER scoring.
 * - Off by default: a strong secret is required to start.
 *
 * Environment:
 *   WEBHOOK_SECRET=<random 32+ character secret> (required)
 *   WEBHOOK_HOST=127.0.0.1 (default, loopback only)
 *   WEBHOOK_ALLOW_PUBLIC=1 (required to bind to non-loopback host)
 *   WEBHOOK_PORT=3456 (default)
 *   WEBHOOK_STATE_FILE=<absolute dedicated JSON path> (optional for tests)
 */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SECRET = process.env.WEBHOOK_SECRET || '';
const HOST = process.env.WEBHOOK_HOST || '127.0.0.1';
const PORT = Number(process.env.WEBHOOK_PORT || '3456');
const STATE_FILE = process.env.WEBHOOK_STATE_FILE
  ? path.resolve(process.env.WEBHOOK_STATE_FILE)
  : path.join(__dirname, '../../state/top_traders_webhook.json');
const MAX_BYTES = 64 * 1024;
const MAX_TRADERS = 100;
const MAX_OBSERVATION_AGE = 7 * 24 * 3600 * 1000;
const XRPL_ADDRESS = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;

function hasValidAuthorization(authHeader) {
  if (!SECRET || typeof authHeader !== 'string') return false;
  const m = /^Bearer ([\x21-\x7e]+)$/.exec(authHeader);
  if (!m) return false;
  const supplied = Buffer.from(m[1], 'utf8');
  const expected = Buffer.from(SECRET, 'utf8');
  if (supplied.length !== expected.length) return false;
  return crypto.timingSafeEqual(supplied, expected);
}

function json(res, status, obj) {
  res.writeHead(status, {
    'Content-Type':'application/json; charset=utf-8',
    'Cache-Control':'no-store',
    'X-Content-Type-Options':'nosniff'
  });
  res.end(JSON.stringify(obj));
}

function validateUpload(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 'JSON object required';
  if (!Array.isArray(data.traders) || data.traders.length < 1 ||
      data.traders.length > MAX_TRADERS) return 'traders must contain 1-100 wallets';
  const seen = new Set();
  for (const t of data.traders) {
    if (!t || !XRPL_ADDRESS.test(t.address || '') ||
        !Number.isFinite(t.winRatePct) || t.winRatePct < 0 || t.winRatePct > 100 ||
        !Number.isFinite(t.volumeXrp) || t.volumeXrp < 0 ||
        (t.positionsOpen !== undefined &&
          (!Number.isSafeInteger(t.positionsOpen) || t.positionsOpen < 0))) {
      return 'invalid trader address, win rate, volume, or position count';
    }
    if (seen.has(t.address)) return 'duplicate trader address';
    seen.add(t.address);
  }
  if (data.approvedForSignals !== undefined &&
      typeof data.approvedForSignals !== 'boolean')
    return 'approvedForSignals must be boolean';
  if (data.approvedForSignals === true) {
    if (!Number.isSafeInteger(data.observedAt) ||
        data.observedAt > Date.now() + 60_000 ||
        Date.now() - data.observedAt > MAX_OBSERVATION_AGE) {
      return 'approved signals require a recent real performance observedAt timestamp (milliseconds)';
    }
  }
  return null;
}

function writeApprovedImport(data) {
  const payload = {
    source:'operator_reviewed_webhook', // do not falsely claim FirstLedger verification
    importedAt:Date.now(),
    observedAt:Number.isSafeInteger(data.observedAt) ? data.observedAt : null,
    approvedForSignals:data.approvedForSignals === true,
    traders:data.traders.map(t => ({
      address:t.address, winRatePct:t.winRatePct,
      volumeXrp:t.volumeXrp, positionsOpen:t.positionsOpen || 0
    }))
  };
  fs.mkdirSync(path.dirname(STATE_FILE), {recursive:true,mode:0o700});
  const tempPath=STATE_FILE+'.tmp-'+crypto.randomBytes(8).toString('hex');
  try {
    const fd=fs.openSync(tempPath,'wx',0o600);
    try {
      fs.writeFileSync(fd,JSON.stringify(payload,null,2),{encoding:'utf8'});
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tempPath,STATE_FILE);
  } catch(err) {
    try { fs.unlinkSync(tempPath); } catch {}
    throw err;
  }
  return payload;
}

function handler(req,res) {
  if (req.method === 'GET' && req.url === '/health')
    return json(res,200,{status:'ok',authRequired:true,bindHost:HOST});
  if (req.method !== 'POST' || req.url !== '/webhook/top-traders')
    return json(res,404,{error:'Not found'});
  if (!hasValidAuthorization(req.headers.authorization))
    return json(res,401,{error:'Unauthorized'});
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || ''))
    return json(res,415,{error:'Content-Type application/json required'});
  let chunks=[];
  let size=0;
  let rejected=false;
  req.on('data',chunk=>{
    if (rejected) return;
    size+=chunk.length;
    if (size>MAX_BYTES) {
      rejected=true;chunks=[];
      json(res,413,{error:'Payload too large'});
      return;
    }
    chunks.push(chunk);
  });
  req.on('end',()=>{
    if (rejected) return;
    let data;
    try { data=JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { return json(res,400,{error:'Invalid JSON'}); }
    const error=validateUpload(data);
    if (error) return json(res,422,{error});
    try {
      const result=writeApprovedImport(data);
      json(res,200,{
        success:true,imported:result.traders.length,
        tradingSignalApproved:result.approvedForSignals,
        source:result.source
      });
    } catch(err) {
      console.error('[TopTraderWebhook] Atomic state write failed:',err.code || 'IO_ERROR');
      json(res,500,{error:'State write failed'});
    }
  });
  req.on('error',()=>{if(!rejected && !res.writableEnded)json(res,400,{error:'Read error'});});
}

if (SECRET.length < 32 ||
    !Number.isSafeInteger(PORT) || PORT < 0 || PORT > 65535 ||
    (!['127.0.0.1','::1','localhost'].includes(HOST) &&
      process.env.WEBHOOK_ALLOW_PUBLIC !== '1')) {
  console.error('[TopTraderWebhook] Refusing to listen: 32+ character WEBHOOK_SECRET, valid port and loopback bind required (public requires explicit opt-in).');
  process.exitCode=1;
} else {
  const server=http.createServer(handler);
  server.listen(PORT,HOST,()=>{
    const bound=server.address();
    console.log('[TopTraderWebhook] Authenticated operator import listening on '+HOST+':'+bound.port+
      ' (not a verified FirstLedger feed)');
  });
}
