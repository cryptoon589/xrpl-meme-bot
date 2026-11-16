/**
 * Authoritative operator-only manual blacklist. No automatic discoveries,
 * risk assessments, popularity heuristics or wallet outcomes may add entries.
 *
 * Deliberately NO built-in token entries. Missing/invalid file fails closed
 * BEFORE PAPER entry routes are installed. An empty list is allowed only if
 * the operator creates the manifest explicitly.
 *
 * This module never writes to the file or changes runtime configuration.
 */
import fs from 'fs';
import path from 'path';
import { normalizeIssuedCurrency } from '../xrpl/currencyCode';

export interface ManualTokenEntry {
  currency: string;          // display currency or raw XRPL code
  issuer?: string;           // optional: exact issuer match only
  reason?: string;           // informational, never an eligibility heuristic
}

interface ManualTokenManifest {
  format: 'hunterix-manual-blacklist-v1';
  managedBy: 'operator';
  tokens: ManualTokenEntry[];
}

function decoded(raw: string): string {
  if (!/^[0-9a-fA-F]{40}$/.test(raw)) return raw;
  const bytes=Buffer.from(raw,'hex');
  const stripped=bytes.toString('utf8').replace(/\x00+$/g,'');
  return /^[\x20-\x7E]+$/.test(stripped) && stripped.length>0 ? stripped : raw;
}

function aliases(raw: string): Set<string> {
  const val=raw.trim();
  if (!val) return new Set();
  const aliases=new Set([val.toUpperCase(), decoded(val).toUpperCase()]);
  const norm=normalizeIssuedCurrency(val);
  if (norm) aliases.add(norm.toUpperCase());
  return aliases;
}

export class OperatorBlacklist {
  private readonly entries: ReadonlyArray<ManualTokenEntry>;

  private constructor(entries: ManualTokenEntry[]) {
    this.entries=entries.map(e=>Object.freeze({...e}));
  }

  static load(manifestPath?: string): OperatorBlacklist {
    const p=path.resolve(manifestPath ||
      process.env.HUNTERIX_MANUAL_BLOCKLIST_FILE ||
      path.join(process.cwd(),'state','manual_token_blacklist.json'));
    if (!fs.existsSync(p))
      throw new Error('Operator blacklist manifest missing: '+p+
        '. No user entries were guessed or copied from built-in exclusion lists.');
    const st=fs.lstatSync(p);
    if (!st.isFile() || st.isSymbolicLink())
      throw new Error('Manual blacklist must be a regular operator-managed file');
    const value=JSON.parse(fs.readFileSync(p,'utf8')) as ManualTokenManifest;
    if (value?.format !== 'hunterix-manual-blacklist-v1' ||
        value?.managedBy !== 'operator' || !Array.isArray(value?.tokens))
      throw new Error('Manual blacklist schema invalid or not operator-managed');
    if (value.tokens.length > 5000) throw new Error('Manual blacklist exceeds safe limit');
    const entries: ManualTokenEntry[]=[];
    const seen=new Set<string>();
    for (const t of value.tokens) {
      if (!t || typeof t.currency!=='string' ||
          t.currency.trim().length===0 || t.currency.length>100 ||
          (t.issuer!==undefined && (typeof t.issuer!=='string' || !/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(t.issuer))) ||
          (t.reason!==undefined && (typeof t.reason!=='string' || t.reason.length>300)))
        throw new Error('Invalid manual blacklist entry; no automatic corrections made');
      const c=t.currency.trim();
      if (!normalizeIssuedCurrency(c) && !/^[\x20-\x7E]{1,100}$/.test(c))
        throw new Error('Invalid currency identifier in manual blacklist');
      const key=c.toUpperCase()+':'+(t.issuer||'');
      if (seen.has(key)) throw new Error('Duplicate manual blacklist entry: '+key);
      seen.add(key);
      entries.push({currency:c,issuer:t.issuer,reason:t.reason});
    }
    return new OperatorBlacklist(entries);
  }

  isBlocked(currency: string, issuer: string, rawCurrency?: string): boolean {
    if (!currency || !issuer) return false;
    const names=new Set([...aliases(currency),...aliases(rawCurrency||'')]);
    return this.entries.some(e =>
      (!e.issuer || e.issuer===issuer) &&
      [...aliases(e.currency)].some(c=>names.has(c))
    );
  }

  /** For the TradeDecisionEngine legacy Set route: includes exact token+issuer keys. */
  asDecisionSet(): Set<string> {
    const entries=new Set<string>();
    for (const e of this.entries) {
      for (const alias of aliases(e.currency))
        entries.add(e.issuer ? alias+':'+e.issuer : alias);
    }
    return entries;
  }

  list(): ReadonlyArray<ManualTokenEntry> {
    return this.entries.map(e=>({...e}));
  }
}
