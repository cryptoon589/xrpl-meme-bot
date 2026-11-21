/**
 * Dynamic issuer-exact meme classification from documented, externally tagged
 * XRPL tokens. Market momentum is a separate TDE gate, never classification.
 *
 * This is a volatile read-only evidence index; no DB edits or token blacklist
 * mutations. Provider errors and evidence expiry fail closed for NEW entries.
 */
import { normalizeIssuedCurrency } from '../xrpl/currencyCode';

export interface TaggedMemeToken {
  currency?: unknown;
  issuer?: unknown;
  name?: unknown;
  tags?: unknown;
  tokenType?: unknown;
  dateon?: unknown;
}

export interface MemeIssue {
  currency: string; // original XRPL 3-character or 40-character hex code
  issuer: string;
  display: string;
  observedAt: number;
  source: 'xrpl.to:Memes';
  dateon?: number;
}

const XRPL_ISSUER = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
const HEX = /^[A-Fa-f0-9]{40}$/;
const TTL_MS = 45 * 60 * 1000;
const MAX_ISSUES = 3500;
const NEGATIVE_TAGS = new Set([
  'STABLECOIN','STABLECOINS','REAL WORLD ASSETS','RWA','WRAPPED','BRIDGED',
  'UTILITY','DEFI','PAYMENT','PAYMENTS','GATEWAY','FIAT','FIAT CURRENCY',
  'INFRASTRUCTURE'
]);

export function canonicalIssue(currency: unknown, issuer: unknown): string | null {
  if (typeof currency !== 'string' || typeof issuer !== 'string' ||
      !XRPL_ISSUER.test(issuer)) return null;
  // Never infer ledger identity from an off-chain display name.
  if (!HEX.test(currency) && !/^[A-Za-z0-9?!@#$%^&*<>(){}\[\]|]{3}$/.test(currency))
    return null;
  const norm = normalizeIssuedCurrency(currency);
  return norm ? norm+':'+issuer : null;
}

export function displayIssuedCurrency(code: string): string {
  if (!HEX.test(code)) return code;
  const bytes=Buffer.from(code,'hex');
  const nullAt=bytes.indexOf(0);
  const label=bytes.subarray(0,nullAt<0?bytes.length:nullAt).toString('ascii');
  return /^[\x21-\x7E]{1,20}$/.test(label) ? label : code;
}

export class DynamicMemeUniverse {
  private issues = new Map<string, MemeIssue>();
  private successfulPages = 0;
  private lastSuccessAt = 0;

  acceptTaggedPage(tokens: unknown, now = Date.now()): {accepted:number;rejected:number} {
    if (!Array.isArray(tokens) || tokens.length>100)
      throw new Error('Unexpected meme category page; refused');
    if (!Number.isFinite(now) || now<=0) throw new Error('Invalid observation time');
    let accepted=0;
    let rejected=0;
    for (const candidate of tokens as TaggedMemeToken[]) {
      if (!candidate || typeof candidate!=='object') { rejected++; continue; }
      const key=canonicalIssue(candidate.currency,candidate.issuer);
      const tags=Array.isArray(candidate.tags) ? candidate.tags : [];
      const tagNames=tags.filter((x):x is string=>typeof x==='string').map(x=>x.toUpperCase().trim());
      const typ=candidate.tokenType;
      // Source must explicitly assert meme classification and not contradict it.
      if (!key || !tagNames.includes('MEMES') ||
          tagNames.some(x=>NEGATIVE_TAGS.has(x)) ||
          (typeof typ==='string' && !['trustline','nonstandard','xls14'].includes(typ.toLowerCase()))) {
        rejected++;
        continue;
      }
      // Reuse the same identity the provider actually sent; avoid ticker aliases.
      const code=candidate.currency as string;
      const issuer=candidate.issuer as string;
      this.issues.delete(key);
      this.issues.set(key,{
        currency:code,
        issuer,
        display:displayIssuedCurrency(code),
        observedAt:now,
        source:'xrpl.to:Memes',
        ...(typeof candidate.dateon==='number' && Number.isFinite(candidate.dateon)
          ? {dateon:candidate.dateon} : {})
      });
      accepted++;
    }
    this.successfulPages++;
    this.lastSuccessAt=now;
    this.expire(now);
    while(this.issues.size>MAX_ISSUES) {
      const oldest=this.issues.keys().next().value;
      if (oldest===undefined)break;
      this.issues.delete(oldest);
    }
    return {accepted,rejected};
  }

  hasIssue(currency:string,issuer:string,rawCurrency?:string,now=Date.now()):boolean {
    const key=canonicalIssue(rawCurrency||currency,issuer);
    if (!key)return false;
    const issue=this.issues.get(key);
    return !!issue && now>=issue.observedAt && now-issue.observedAt<=TTL_MS;
  }

  eligibleIssues(now=Date.now()):MemeIssue[] {
    this.expire(now);
    return [...this.issues.values()];
  }

  stats(now=Date.now()): {eligible:number;successfulPages:number;lastSuccessAgeMs:number|null} {
    this.expire(now);
    return {eligible:this.issues.size,successfulPages:this.successfulPages,
      lastSuccessAgeMs:this.lastSuccessAt ? Math.max(0,now-this.lastSuccessAt):null};
  }

  private expire(now:number):void {
    for(const [key,value] of this.issues) {
      if(now<value.observedAt || now-value.observedAt>TTL_MS)
        this.issues.delete(key);
    }
  }
}

/** Shared in-process read-only index for every TDE and direct PAPER entry path. */
export const dynamicMemeUniverse=new DynamicMemeUniverse();
