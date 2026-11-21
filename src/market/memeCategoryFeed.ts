/**
 * Bounded, opt-in public metadata poller for XRPL meme candidates.
 * Only documented XRPL.to API endpoints are used, never scraped UI pages.
 * Source: https://xrpl.to/docs/tokens
 * Data by xrpl.to: https://xrpl.to
 *
 * The API's category flag is positive identity evidence, NOT a buy signal.
 * Network errors never broaden the eligible universe or mutate databases.
 */
import { info, warn } from '../utils/logger';
import {
  canonicalIssue, dynamicMemeUniverse, TaggedMemeToken, MemeIssue
} from '../risk/dynamicMemeUniverse';

type FetchLike = typeof fetch;
type CandidateCallback = (token:MemeIssue)=>void;
const API='https://api.xrpl.to/v1';
const USER_AGENT='HUNTERIX-Meme-PAPER-Classifier/0.1 (+https://github.com/cryptoon589/xrpl-meme-bot)';
const FETCH_TIMEOUT_MS=8000;
const REFRESH_MS=15*60*1000;

export class MemeCategoryFeed {
  private busy=false;
  private rotation=0;
  private nextAllowedFetch=0;
  private lastLookup=new Map<string,number>();
  private pendingLookups=new Map<string,Promise<boolean>>();
  private lastRefreshAt=0;
  private interval:NodeJS.Timeout|null=null;

  constructor(
    private readonly onCandidate:CandidateCallback,
    private readonly fetcher:FetchLike=fetch,
    private readonly now:()=>number=Date.now
  ) {}

  private async getJSON(url:string):Promise<any> {
    if (!url.startsWith(API+'/')) throw Error('Unexpected metadata provider URL');
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),FETCH_TIMEOUT_MS);
    try {
      const res=await this.fetcher(url,{
        headers:{'Accept':'application/json','User-Agent':USER_AGENT},
        signal:controller.signal,
        redirect:'error'
      });
      if (!res.ok) throw new Error('metadata HTTP '+res.status);
      const length=Number(res.headers.get('content-length') || 0);
      if (length>500000)throw new Error('metadata response exceeds size budget');
      const body=await res.text();
      if (body.length>500000) throw new Error('metadata response too large');
      return JSON.parse(body);
    } finally {
      clearTimeout(timer);
    }
  }

  private acceptPage(tokens:unknown):number {
    const now=this.now();
    const result=dynamicMemeUniverse.acceptTaggedPage(tokens,now);
    // Only send accepted exact issuer/currency combinations to TokenDiscovery.
    for (const t of tokens as TaggedMemeToken[]) {
      if (!t || typeof t!=='object')continue;
      const key=canonicalIssue(t.currency,t.issuer);
      if (!key || !dynamicMemeUniverse.hasIssue(t.currency as string,t.issuer as string,undefined,now))
        continue;
      const issue=dynamicMemeUniverse.eligibleIssues(now).find(x=>
        canonicalIssue(x.currency,x.issuer)===key);
      if(issue)this.onCandidate(issue);
    }
    return result.accepted;
  }

  /** At most three sequential tagged pages/15m, no parallel API flood. */
  async refresh():Promise<void> {
    if(this.busy)return;
    this.busy=true;
    try {
      // Top activity, fresh listings, and one circulating older page.
      const pages=[
        {sort:'vol24hxrp',offset:0},
        {sort:'dateon',offset:0},
        {sort:'vol24hxrp',offset:50+(this.rotation%16)*50}
      ];
      let accepted=0;
      for(const page of pages) {
        const u=new URL(API+'/tokens');
        for(const [key,value] of Object.entries({
          tag:'Memes',tags:'yes',
          sort:page.sort,order:'desc',limit:'50',
          offset:String(page.offset),lightweight:'true',skip_metrics:'true'
        }))u.searchParams.set(key,value);
        try {
          const body=await this.getJSON(u.toString());
          if(body?.success!==true || body.tagName?.toLowerCase()!=='memes' ||
             !Array.isArray(body.tokens) || body.tokens.length>50)
            throw Error('metadata category response invalid');
          accepted+=this.acceptPage(body.tokens);
        }catch(e) {
          warn('[MemeDiscovery] documented metadata page unavailable; entries remain fail-closed ('+
            String((e as Error).message).slice(0,95)+')');
          break; // provider backoff, no flood after 429/403/5xx
        }
      }
      this.rotation++;
      this.lastRefreshAt=this.now();
      const st=dynamicMemeUniverse.stats(this.now());
      info('[MemeDiscovery] accepted '+accepted+' tagged issues; '+st.eligible+
        ' current issuer-exact entries (Data by xrpl.to https://xrpl.to)');
    } finally {
      this.busy=false;
    }
  }

  /** Bounded on-demand lookup for newly seen / dormant meme signals.
   * Only the *exact* ledger issuer+raw currency is requested. A 15-second
   * global minimum and 15-minute negative-cache prevent metadata API floods.
   */
  async ensureIssue(currency:string,issuer:string,rawCurrency?:string):Promise<boolean> {
    const code=rawCurrency||currency;
    const key=canonicalIssue(code,issuer);
    if(!key)return false;
    if(dynamicMemeUniverse.hasIssue(currency,issuer,rawCurrency,this.now()))return true;
    const outstanding=this.pendingLookups.get(key);
    if(outstanding)return outstanding;
    const now=this.now();
    if(now<this.nextAllowedFetch || now-(this.lastLookup.get(key)||0)<15*60*1000)
      return false;
    this.nextAllowedFetch=now+15000;
    this.lastLookup.set(key,now);
    const job=(async()=>{
      try {
        const url=API+'/token/'+encodeURIComponent(issuer+'-'+code);
        const body=await this.getJSON(url);
        if(body?.success!==true || !body?.token ||
           canonicalIssue(body.token.currency,body.token.issuer)!==key)
          return false;
        this.acceptPage([body.token]);
        return dynamicMemeUniverse.hasIssue(currency,issuer,rawCurrency,this.now());
      } catch {
        return false;
      }
    })();
    this.pendingLookups.set(key,job);
    try{return await job;}
    finally{this.pendingLookups.delete(key);}
  }

  start():void {
    if(this.interval)return;
    void this.refresh().catch(e=>warn('[MemeDiscovery] refresh failed: '+String(e).slice(0,90)));
    this.interval=setInterval(()=>{
      void this.refresh().catch(e=>warn('[MemeDiscovery] refresh failed: '+String(e).slice(0,90)));
    },REFRESH_MS);
    this.interval.unref();
  }

  stop():void {
    if(this.interval)clearInterval(this.interval);
    this.interval=null;
  }

  stats():{eligible:number;successfulPages:number;lastSuccessAgeMs:number|null;lastRefreshAgeMs:number|null} {
    const s=dynamicMemeUniverse.stats(this.now());
    return {...s,lastRefreshAgeMs:this.lastRefreshAt ? Math.max(0,this.now()-this.lastRefreshAt):null};
  }
}

/** A shared lookup provider for the current process, initialized at startup. */
let activeFeed:MemeCategoryFeed|null=null;
export function setActiveMemeCategoryFeed(feed:MemeCategoryFeed|null):void {activeFeed=feed;}
export async function ensureTaggedMemeIssue(currency:string,issuer:string,rawCurrency?:string):Promise<boolean> {
  return activeFeed ? activeFeed.ensureIssue(currency,issuer,rawCurrency) : false;
}
