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
  /** Optional validated ledger transaction hash for bounded duplicate suppression. */
  txHash?: string;
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
  let ammTokenDelta: number | null = null;
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
      // RippleState balance is from the LOW account's perspective.
      // Derive what the AMM itself gained or lost, independent of
      // whether the AMM is the low or the high trustline account.
      const ammIsLow=ff.LowLimit.issuer===ammAccount && ff.HighLimit.issuer===issuer;
      const ammIsHigh=ff.HighLimit.issuer===ammAccount && ff.LowLimit.issuer===issuer;
      if(!ammIsLow && !ammIsHigh)continue;
      const now=Number(ff.Balance.value),old=Number(pf.Balance.value);
      if(!Number.isFinite(now)||!Number.isFinite(old)||now===old)continue;
      if(ammTokenDelta!==null)return null; // Ambiguous duplicate trustline deltas
      ammTokenDelta=(now-old)*(ammIsLow?1:-1);
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
  if(ammTokenDelta===null || !Number.isFinite(ammTokenDelta) ||
      ammTokenDelta===0 || !Number.isFinite(deltaXRP) ||
      Math.abs(deltaXRP)<0.001)return null;
  // An exchange-like swap must move XRP and the issued asset in OPPOSITE
  // directions in the known AMM. Transfers or liquidity-like same-side
  // movements cannot contribute to validated exchange-flow evidence.
  if(Math.sign(ammTokenDelta)===Math.sign(deltaXRP))return null;
  const hash=tx.hash ?? t.hash;
  const txHash=typeof hash==='string' && /^[A-Fa-f0-9]{64}$/.test(hash)
    ? hash.toUpperCase() : undefined;
  return {rawCurrency,issuer,
    side:deltaXRP>0?'xrp_inflow':'xrp_outflow',
    volumeXRP:Math.abs(deltaXRP),...(txHash ? {txHash}: {})};
}
