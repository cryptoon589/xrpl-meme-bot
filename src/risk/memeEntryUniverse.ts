/**
 * Operator-approved meme-only PAPER entry universe.
 * The XRPL does not provide an authoritative "meme coin" on-ledger flag.
 * Reject all unapproved issues: a ticker or pump is not an eligibility proof.
 * This is NOT the four-entry permanent operator blacklist and NEVER affects exits.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { normalizeIssuedCurrency } from '../xrpl/currencyCode';
import { dynamicMemeUniverse } from './dynamicMemeUniverse';

type Decision = { allowed: boolean; reason: string };
const NON_MEME = new Set([
  'XRP','USD','USDC','USDT','RLUSD','URLSD','USDD','USDS','DAI','TUSD','BUSD',
  'FDUSD','PYUSD','GUSD','EUR','EURC','EURCV','EURS','EURT','GBP','JPY','CHF',
  'BTC','WBTC','XBTC','TBTC','BTCB','ETH','WETH','XETH','STETH','RETH',
  'SOL','WSOL','XSOL','BNB','WBNB','AVAX','WAVAX','ADA','TRX',
  'PAXG','XAUT','FXRP','WBTC','RLUSD','USDY','USDE','SUSDE'
]);
const NON_MEME_KNOWN_ISSUES = new Set([
  'EVR:ra9g3LAJm9xJu8Awe7oWzR6VXFB1mpFtSe',
  '534F4C4F00000000000000000000000000000000:rsoLo2S1kiGeCcn6hCUXVrCpGMWLrRrLZz',
  '5245414C00000000000000000000000000000000:rKVyXn1AhqMTvNA9hS6XkFjQNn2VE8Nz88'
]);
// Known utility/ecosystem issues from the previous PAPER misclassification.
// These are NOT entries in the operator-controlled permanent blacklist.
const ISSUER = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;

function readable(value?: string): string {
  if (!value) return '';
  if (/^[0-9A-Fa-f]{40}$/.test(value)) {
    const raw=Buffer.from(value,'hex');
    const zero=raw.indexOf(0);
    const label=(zero<0 ? raw : raw.subarray(0,zero)).toString('ascii');
    return /^[\x21-\x7E]{1,20}$/.test(label) ? label.toUpperCase() : '';
  }
  return value.trim().toUpperCase();
}
function deniedName(currency: string, rawCurrency?: string): string | null {
  const labels=[readable(currency),readable(rawCurrency)].filter(Boolean);
  return labels.find(s=>NON_MEME.has(s) || /^(?:WRAPPED|BRIDGED|PEGGED)[ _-]?(?:BTC|ETH|SOL|USD)/.test(s)) || null;
}
export function paperMemeEntryDecision(
  currency: string, issuer: string, rawCurrency?: string
): Decision {
  const reject=(reason:string):Decision=>({allowed:false,reason});
  if (!ISSUER.test(issuer||'')) return reject('Invalid XRPL issuer');
  const excluded=deniedName(currency,rawCurrency);
  if (excluded) return reject('Non-meme asset type: '+excluded);
  const identity=normalizeIssuedCurrency(rawCurrency||currency);
  if(identity && NON_MEME_KNOWN_ISSUES.has(identity+':'+issuer))
    return reject('Previously confirmed conventional token issue');
  // Fresh, issuer-exact external meme evidence is an alternative to the
  // operator's initial two-token bootstrap list, not a permanent whitelist.
  if (process.env.BOT_PAPER_MEME_DISCOVERY==='1' &&
      dynamicMemeUniverse.hasIssue(currency,issuer,rawCurrency))
    return {allowed:true,reason:'Fresh issuer-exact external meme evidence'};

  const file=process.env.HUNTERIX_MEME_ENTRY_ALLOWLIST_FILE;
  const approvedHash=process.env.HUNTERIX_OPERATOR_MEME_ALLOWLIST_APPROVED_SHA256;
  if (!file || !path.isAbsolute(file) || !/^[a-f0-9]{64}$/i.test(approvedHash||''))
    return reject('Meme-entry allowlist or operator approval not configured');
  let raw:Buffer;
  let entries:unknown;
  try {
    const st=fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.size>65536)
      return reject('Meme-entry allowlist invalid file');
    raw=fs.readFileSync(file);
    const sha=crypto.createHash('sha256').update(raw).digest('hex');
    if (sha!==approvedHash!.toLowerCase())
      return reject('Meme-entry allowlist checksum not approved');
    const v=JSON.parse(raw.toString('utf8'));
    if (!v || v.format!=='hunterix-paper-meme-allowlist-v1' ||
        v.managedBy!=='operator' || !Array.isArray(v.tokens) || v.tokens.length>3000)
      return reject('Invalid meme-entry allowlist format');
    entries=v.tokens;
  } catch {
    return reject('Meme-entry allowlist unavailable or unreadable');
  }
  const observed=normalizeIssuedCurrency(rawCurrency||currency);
  if (!observed) return reject('Invalid issued token currency');
  const list=entries as Array<{currency?:unknown;issuer?:unknown}>;
  const seen=new Set<string>();
  for (const e of list) {
    if (!e || typeof e.currency!=='string' || typeof e.issuer!=='string' ||
        !ISSUER.test(e.issuer) || deniedName(e.currency))
      return reject('Invalid/non-meme asset in approval file');
    const code=normalizeIssuedCurrency(e.currency);
    if (!code) return reject('Invalid approved issued currency');
    const key=code+':'+e.issuer;
    if (seen.has(key)) return reject('Duplicate approved issue');
    seen.add(key);
  }
  if (seen.has(observed+':'+issuer)) return {allowed:true,reason:'Exact issued meme asset approved'};
  return reject('Unknown/unreviewed token: not approved as XRPL meme coin');
}
