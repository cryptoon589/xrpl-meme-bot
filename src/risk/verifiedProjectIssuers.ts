/**
 * Reviewed issuer provenance for recognizable XRPL projects.
 *
 * PURPOSE: fail closed on name impersonation of a source-confirmed project
 * while allowing completely unrelated, not-yet-reviewed meme names to be
 * independently classified by the dynamic meme feed.
 *
 * This is NOT a broad meme-token allowlist and does not trade/close tokens.
 * Each protected name needs a first-party public issuer statement and a
 * reviewed raw 160-bit currency code. Changes require code review + CI.
 *
 * Never use third-party category tags, logo or ticker alone as issuer proof.
 */
import { normalizeIssuedCurrency } from '../xrpl/currencyCode';

export interface ProjectProvenanceEntry {
  readonly ticker: string;
  readonly currency: string;
  readonly issuer: string;
  readonly issuerSource: string;
  readonly verifiedAtUtc: string;
}

export const REVIEWED_PROJECT_ISSUERS: readonly ProjectProvenanceEntry[] =
  Object.freeze([
    Object.freeze({
      ticker:'PHNIX',
      currency:'50484E4958000000000000000000000000000000',
      issuer:'rDFXbW2ZZCG5WgPtqwNiA2xZokLMm9ivmN',
      // Official project site states issuer in the token purchase section.
      issuerSource:'https://phnix.io/',
      verifiedAtUtc:'2026-11-21',
    }),
  ]);

export type ProvenanceDecision =
  | {allowed:true; status:'not_protected'|'issuer_confirmed'}
  | {allowed:false; status:'issuer_mismatch'; ticker:string;
     expectedIssuer:string; suppliedIssuer:string; source:string};

function decodeLedgerTicker(input:string):string|null {
  const currency=normalizeIssuedCurrency(input);
  if(!currency)return null;
  if(/^[0-9A-F]{40}$/.test(currency)){
    const bytes=Buffer.from(currency,'hex');
    const nullAt=bytes.indexOf(0);
    const raw=bytes.subarray(0,nullAt<0?20:nullAt);
    const name=raw.toString('ascii');
    if(!/^[\x21-\x7E]{1,20}$/.test(name))return null;
    return name.toUpperCase();
  }
  return currency.toUpperCase();
}

/**
 * Provenance is an ENTRY-ONLY restriction. Never mutate existing inventory.
 * Known official project names are protected across all issuers, regardless
 * of whether a third-party token metadata feed tags an imitation "Memes".
 */
export function decideVerifiedProjectIssuer(
  currency:string,issuer:string,rawCurrency?:string|null
):ProvenanceDecision {
  const display=new Set<string>();
  if(currency){
    const name=decodeLedgerTicker(currency);
    if(name)display.add(name);
  }
  if(rawCurrency){
    const rawName=decodeLedgerTicker(rawCurrency);
    if(rawName)display.add(rawName);
  }
  for(const project of REVIEWED_PROJECT_ISSUERS){
    if(!display.has(project.ticker.toUpperCase()))continue;
    const ledgerRaw=rawCurrency?normalizeIssuedCurrency(rawCurrency):
      normalizeIssuedCurrency(currency);
    if(issuer===project.issuer && ledgerRaw===project.currency){
      return {allowed:true,status:'issuer_confirmed'};
    }
    return {
      allowed:false,status:'issuer_mismatch',ticker:project.ticker,
      expectedIssuer:project.issuer,suppliedIssuer:issuer,source:project.issuerSource,
    };
  }
  return {allowed:true,status:'not_protected'};
}
