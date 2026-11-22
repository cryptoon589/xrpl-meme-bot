/**
 * Bounded, observation-only 5-minute AMM exchange-flow tracker.
 *
 * The directions refer to the AMM's XRP reserve; this is NOT organic buyer
 * attribution. Only separately validated, exact-issuer, opposite-reserve
 * transactions with identifiable hashes may populate these counters.
 * It never feeds legacy BuyPressureTracker, TDE, BURST, execution or cash.
 */
import { ValidatedAmmFlow } from './xrplAmmFlowEvidence';

type FlowRecord = {
  hash: string;
  at: number;
  side: 'xrp_inflow' | 'xrp_outflow';
  xrp: number;
};
export type AmmPressureSnapshot = {
  inflows: number; outflows: number;
  inflowXRP: number; outflowXRP: number;
  inflowFraction: number;
};

const WINDOW_MS = 5 * 60_000;
const MAX_ISSUES = 300;
const MAX_EVENTS_PER_ISSUE = 300;

export class AmmPressureEvidence {
  private readonly byIssue = new Map<string, FlowRecord[]>();

  observe(flow: ValidatedAmmFlow, at = Date.now()): boolean {
    if (!flow.rawCurrency || !flow.issuer ||
        (flow.side !== 'xrp_inflow' && flow.side !== 'xrp_outflow') ||
        !Number.isFinite(flow.volumeXRP) || flow.volumeXRP <= 0 ||
        !Number.isFinite(at) || at <= 0 ||
        !flow.txHash || !/^[A-Fa-f0-9]{64}$/.test(flow.txHash)) return false;
    const key = flow.rawCurrency + ':' + flow.issuer;
    const hash = flow.txHash.toUpperCase();
    // Maps are bounded; oldest issue is dropped under pressure, not promoted.
    const prev = this.byIssue.get(key) ?? [];
    const fresh = prev.filter(x => x.at > at - WINDOW_MS && x.at <= at);
    if (fresh.some(x => x.hash === hash)) return false;
    fresh.push({hash, at, side: flow.side, xrp: flow.volumeXRP});
    if (fresh.length > MAX_EVENTS_PER_ISSUE) fresh.shift();
    this.byIssue.delete(key);
    this.byIssue.set(key, fresh);
    if (this.byIssue.size > MAX_ISSUES) {
      const oldest=this.byIssue.keys().next().value;
      if (oldest !== undefined) this.byIssue.delete(oldest);
    }
    return true;
  }

  snapshot(rawCurrency: string, issuer: string, at = Date.now()): AmmPressureSnapshot {
    const key = rawCurrency + ':' + issuer;
    const events=(this.byIssue.get(key) ?? [])
      .filter(x => x.at > at - WINDOW_MS && x.at <= at);
    if(this.byIssue.has(key))this.byIssue.set(key, events);
    let inflows=0,outflows=0,inflowXRP=0,outflowXRP=0;
    for(const e of events){
      if(e.side==='xrp_inflow'){inflows++;inflowXRP+=e.xrp;}
      else{outflows++;outflowXRP+=e.xrp;}
    }
    const count=inflows+outflows;
    return {
      inflows,outflows,inflowXRP,outflowXRP,
      inflowFraction:count?inflows/count:0.5
    };
  }
}
