/**
 * Dynamic PAPER ticker-collision exposure guard.
 *
 * The XRPL permits different issuers to reuse the exact same currency code,
 * e.g. PHNIX issued by both a known project and an unrelated issuer. Issuer-
 * exact position checks are still required, but they do not limit correlated
 * name/branding and impersonation exposure.
 *
 * A ticker collision is an ambiguity/risk signal, NOT proof of fraud and NOT
 * an operator permanent exclusion. Existing inventory and exits are untouched.
 */
import { normalizeIssuedCurrency } from '../xrpl/currencyCode';

export interface TickerIssue {
  currency: string;
  issuer: string;
  rawCurrency?: string | null;
}
export interface OpenTickerIssue {
  tokenCurrency: string;
  tokenIssuer: string;
  rawCurrency?: string | null;
  remainingPosition?: number | null;
}

function displayTicker(rawOrName: string): string {
  if (/^[0-9A-Fa-f]{40}$/.test(rawOrName)) {
    const bytes=Buffer.from(rawOrName, 'hex');
    const n=bytes.indexOf(0);
    const text=bytes.subarray(0,n<0?20:n).toString('ascii');
    if (/^[\x21-\x7E]{1,20}$/.test(text))return text.toUpperCase();
    return rawOrName.toUpperCase();
  }
  return rawOrName.trim().toUpperCase();
}

/** Returns the conflicting existing token if a different issuer already has
 * open inventory under the same display ticker. No ticker-only trade approval.
 */
export function findOpenTickerCollision(
  candidate:TickerIssue,
  positions:Iterable<OpenTickerIssue>
):OpenTickerIssue|null {
  if(!candidate.issuer || !candidate.currency)return null;
  const candidateCode=normalizeIssuedCurrency(candidate.rawCurrency||candidate.currency);
  if(!candidateCode)return null;
  const ticker=displayTicker(candidateCode);
  if(!ticker)return null;
  for(const position of positions){
    if(position.tokenIssuer===candidate.issuer)continue;
    if(position.remainingPosition!=null && position.remainingPosition<=0)continue;
    const existing=normalizeIssuedCurrency(position.rawCurrency||position.tokenCurrency);
    if(!existing)continue;
    if(displayTicker(existing)===ticker)return position;
  }
  return null;
}
