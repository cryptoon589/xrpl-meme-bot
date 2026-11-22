/**
 * Conservative, OBSERVATION-ONLY XRPL AMM-flow classification.
 * Does not convert a Payment transfer into a trade. Requires an exact
 * amm_info-resolved AMM account, validated successful OfferCreate/Payment,
 * a balance delta on that AMM AccountRoot, AND a matching token trustline
 * balance delta between the token issuer and the AMM account.
 *
 * An XRP inflow is consistent with a token purchase, but routed activity
 * may have several legs. Therefore this is an AMM FLOW observation, not a
 * proved organic wallet buy or an entry authorization.
 */
import { normalizeIssuedCurrency } from '../xrpl/currencyCode';

export type ValidatedAmmFlow = {
  rawCurrency: string;
  issuer: string;
  side: 'xrp_inflow' | 'xrp_outflow';
  volumeXRP: number;
};

export function classifyValidatedAmmFlow(
  tx: any, ammAccount: string, rawCurrency: string, issuer: string
): ValidatedAmmFlow | null {
  if (!tx || tx.validated !== true ||
      (tx.engine_result ?? tx.meta?.TransactionResult) !== 'tesSUCCESS') return null;
  const t=tx.tx_json ?? tx.tx ?? tx.transaction;
  const meta=tx.meta;
  if (!t || !meta || !['OfferCreate','Payment'].includes(t.TransactionType) ||
      !ammAccount || !issuer) return null;
  const code=normalizeIssuedCurrency(rawCurrency);
  if (!code) return null;
  const nodes=meta.AffectedNodes;
  if (!Array.isArray(nodes) || nodes.length>200) return null;
  let tokenChanged=false;
  let deltaXRP=0;
  for(const item of nodes){
    const node=item?.ModifiedNode;
    if(!node)continue;
    if(node.LedgerEntryType==='RippleState'){
      const ff=node.FinalFields;
      const pf=node.PreviousFields;
      if(!ff?.Balance || !pf?.Balance || !ff.LowLimit || !ff.HighLimit)continue;
      const c=normalizeIssuedCurrency(ff.Balance.currency);
      if(c!==code)continue;
      const ends=new Set([ff.LowLimit.issuer,ff.HighLimit.issuer]);
      if(!ends.has(ammAccount) || !ends.has(issuer))continue;
      const now=Number(ff.Balance.value),old=Number(pf.Balance.value);
      if(Number.isFinite(now)&&Number.isFinite(old)&&now!==old)
        tokenChanged=true;
    }
    if(node.LedgerEntryType==='AccountRoot' &&
        node.FinalFields?.Account===ammAccount){
      const old=node.PreviousFields?.Balance;
      const now=node.FinalFields?.Balance;
      if(typeof old!=='string'||typeof now!=='string' ||
          !/^[0-9]+$/.test(old)||!/^[0-9]+$/.test(now))continue;
      const change=Number(BigInt(now)-BigInt(old))/1e6;
      if(Number.isFinite(change))deltaXRP+=change;
    }
  }
  if(!tokenChanged || !Number.isFinite(deltaXRP) ||
      Math.abs(deltaXRP)<0.001)return null;
  return {rawCurrency,issuer,
    side:deltaXRP>0?'xrp_inflow':'xrp_outflow',
    volumeXRP:Math.abs(deltaXRP)};
}
