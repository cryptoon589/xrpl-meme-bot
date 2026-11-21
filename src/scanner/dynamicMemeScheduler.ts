/**
 * Bounded rotation over an unbounded discovered meme-token catalog.
 * This is an RPC-work budget, NOT the eligible token universe.
 * Never starve existing PAPER inventory of price/risk checks.
 */
import type { TrackedToken } from '../types';
import { canonicalIssue } from '../risk/dynamicMemeUniverse';

function rotation<T>(items:T[],slot:number,take:number):T[] {
  if(!items.length || take<=0)return [];
  const start=((slot*47)%items.length+items.length)%items.length;
  const n=Math.min(take,items.length);
  return Array.from({length:n},(_,i)=>items[(start+i)%items.length]);
}

export function selectDynamicScanTokens(
  catalog:TrackedToken[],
  allowedIssues:Set<string>,
  openPositionIssues:Set<string>,
  cycle:number,
  maxTokens=300,
  now=Date.now()
):TrackedToken[] {
  const max=Math.max(1,Math.min(300,Math.floor(maxTokens)));
  const result:TrackedToken[]=[];
  const seen=new Set<string>();
  const add=(tokens:TrackedToken[],cap:number)=>{
    let added=0;
    for(const token of tokens){
      if(added>=cap || result.length>=max)break;
      const key=canonicalIssue(token.rawCurrency||token.currency,token.issuer);
      if(!key || seen.has(key))continue;
      if(!allowedIssues.has(key) && !openPositionIssues.has(key))continue;
      seen.add(key);result.push(token);added++;
    }
  };
  const eligible=catalog.filter(t=>{
    const key=canonicalIssue(t.rawCurrency||t.currency,t.issuer);
    return !!key&&(allowedIssues.has(key)||openPositionIssues.has(key));
  });
  // Full open position inventory first regardless of classification expiry.
  add(eligible.filter(t=>openPositionIssues.has(canonicalIssue(t.rawCurrency||t.currency,t.issuer)!)),max);
  if(result.length>=max)return result;
  const remaining=max-result.length;
  // This mix keeps new launches and old revivals in play even when hot memes
  // dominate. The final rotating pool provides fairness among all eligible.
  const newly=eligible.filter(t=>now-t.firstSeen<7*24*3600000)
    .sort((a,b)=>b.firstSeen-a.firstSeen);
  const hot=eligible.slice().sort((a,b)=>b.lastUpdated-a.lastUpdated);
  const dormant=eligible.filter(t=>now-t.firstSeen>=7*24*3600000)
    .sort((a,b)=>a.lastUpdated-b.lastUpdated);
  add(newly,Math.ceil(remaining*.25));
  add(hot,Math.ceil(remaining*.35));
  add(rotation(dormant,cycle,Math.ceil(remaining*.20)),Math.ceil(remaining*.20));
  add(rotation(eligible,cycle,remaining),remaining);
  // Fill only when needed; scan work can be <300 if few confirmed memes.
  return result;
}
