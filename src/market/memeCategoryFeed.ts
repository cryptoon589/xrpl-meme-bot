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
  canonicalIssue, dynamicMemeUniverse, DynamicMemeUniverse, TaggedMemeToken, MemeIssue
} from '../risk/dynamicMemeUniverse';

type FetchLike = typeof fetch;
type CandidateCallback = (token:MemeIssue)=>void;
export type ObservedMemeGainer = {currency:string;issuer:string;display:string;
  observedAt:number;change24hPct:number;volume24hXRP:number;priceXRP?:number};
const API='https://api.xrpl.to/v1';
const USER_AGENT='HUNTERIX-Meme-PAPER-Classifier/0.1 (+https://github.com/cryptoon589/xrpl-meme-bot)';
const FETCH_TIMEOUT_MS=8000;
const REFRESH_MS=15*60*1000;
const REQUEST_WINDOW_MS=15*60*1000;
const MAX_ANON_REQUESTS_PER_WINDOW=3; // <=288/day, below documented 333/day
const MIN_REQUEST_GAP_MS=60*1000; // conservative spacing across list + exact lookup
const DEFAULT_429_BACKOFF_MS=30*60*1000;
const MAX_BACKOFF_MS=48*60*60*1000;

export class MemeCategoryFeed {
  /** Observation only: a 24h gainer already moved; NOT a historical early-buy signal. */
  public onGainerObserved?: (item:ObservedMemeGainer)=>void;
  private busy=false;
  private rotation=0;
  private nextAllowedFetch=0;
  private globalCooldownUntil=0;
  private requestWindowStarted=0;
  private requestsInWindow=0;
  private lastRequestAt=0;
  private lastLookup=new Map<string,number>();
  private pendingLookups=new Map<string,Promise<boolean>>();
  private lastRefreshAt=0;
  private interval:NodeJS.Timeout|null=null;

  constructor(
    private readonly onCandidate:CandidateCallback,
    private readonly fetcher:FetchLike=fetch,
    private readonly now:()=>number=Date.now
  ) {}

  private available(now=this.now()):boolean {
    if(now < this.globalCooldownUntil || now < this.nextAllowedFetch) return false;
    if(now-this.requestWindowStarted>=REQUEST_WINDOW_MS) {
      this.requestWindowStarted=now;
      this.requestsInWindow=0;
    }
    return this.requestsInWindow<MAX_ANON_REQUESTS_PER_WINDOW &&
      (!this.lastRequestAt || now-this.lastRequestAt>=MIN_REQUEST_GAP_MS);
  }

  private retryMs(res:Response,now:number):number {
    const raw=res.headers.get('retry-after');
    let ms=Number(raw)*1000;
    if(!raw || !Number.isFinite(ms) || ms<0) {
      const date=raw ? Date.parse(raw) : NaN;
      ms=Number.isFinite(date) ? Math.max(0,date-now) : DEFAULT_429_BACKOFF_MS;
    }
    const reset=Number(res.headers.get('x-ratelimit-reset')||0);
    if(Number.isFinite(reset) && reset>0 && reset<=48*3600)
      ms=Math.max(ms,reset*1000);
    return Math.min(MAX_BACKOFF_MS,Math.max(15*60*1000,ms));
  }

  private async getJSON(url:string):Promise<any> {
    if (!url.startsWith(API+'/')) throw Error('Unexpected metadata provider URL');
    const now=this.now();
    if(!this.available(now))throw Error('metadata request budget/cooldown');
    this.lastRequestAt=now;
    this.requestsInWindow++;
    this.nextAllowedFetch=now+MIN_REQUEST_GAP_MS;
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),FETCH_TIMEOUT_MS);
    try {
      const headers:Record<string,string>={
        'Accept':'application/json','User-Agent':USER_AGENT
      };
      // A user-generated provider key is optional, never in source or logs.
      if(process.env.HUNTERIX_XRPLTO_API_KEY)
        headers['X-Api-Key']=process.env.HUNTERIX_XRPLTO_API_KEY;
      const res=await this.fetcher(url,{headers,signal:controller.signal,redirect:'error'});
      if (res.status===429) {
        const backoff=this.retryMs(res,this.now());
        this.globalCooldownUntil=Math.max(this.globalCooldownUntil,this.now()+backoff);
        warn('[MemeDiscovery] provider 429; all provider lookups suspended for at least '+
          Math.ceil(backoff/60000)+' min (honouring Retry-After)');
        throw new Error('metadata HTTP 429: provider cooldown');
      }
      if([401,402,403].includes(res.status)) {
        this.globalCooldownUntil=Math.max(this.globalCooldownUntil,this.now()+24*3600000);
        throw new Error('metadata HTTP '+res.status+': authorization/credit cooldown');
      }
      if (res.status>=500) {
        this.globalCooldownUntil=Math.max(this.globalCooldownUntil,this.now()+10*60000);
        throw new Error('metadata HTTP '+res.status+': server cooldown');
      }
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

  /** One tagged page per 15m. Rotate volume/new/revival snapshots without
   * burning anonymous quotas or treating a 429 as an invitation to retry.
   */
  async refresh():Promise<void> {
    if(this.busy || !this.available())return;
    this.busy=true;
    try {
      const slot=this.rotation++;
      // Rotate one provider request per 15m across volume/new/revival and
      // 24h gainers. This DOES NOT add requests to the shared anonymous budget.
      const page=slot%4===0
        ? {sort:'vol24hxrp',offset:0,movers:false}
        : slot%4===1
        ? {sort:'dateon',offset:0,movers:false}
        : slot%4===2
        ? {sort:'vol24hxrp',offset:50+(Math.floor(slot/4)%16)*50,movers:false}
        : {sort:'pro24h',offset:0,movers:true};
      const u=new URL(API+'/tokens');
      for(const [key,value] of Object.entries({
        tag:'Memes',tags:'yes',sort:page.sort,order:'desc',
        limit:'50',offset:String(page.offset),lightweight:'true',skip_metrics:'true',
        ...(page.movers ? {min_vol24hxrp:'50'} : {})
      }))u.searchParams.set(key,value);
      try {
        const body=await this.getJSON(u.toString());
        if(body?.success!==true || body.tagName?.toLowerCase()!=='memes' ||
           !Array.isArray(body.tokens) || body.tokens.length>50)
          throw Error('metadata category response invalid');
        // Gainer pages must NOT expand the live eligible discovery universe,
        // populate the token scanner, or influence PAPER entry decisions.
        // Validate prospective candidate category in a disposable evidence
        // index and discard it immediately after recording the comparison.
        const observedAt=this.now();
        const gainerIndex=page.movers ? new DynamicMemeUniverse() : null;
        const accepted=gainerIndex
          ? gainerIndex.acceptTaggedPage(body.tokens,observedAt).accepted
          : this.acceptPage(body.tokens);
        if(page.movers && this.onGainerObserved && gainerIndex){
          const eligible=new Map(gainerIndex.eligibleIssues(observedAt).map(i=>[
            canonicalIssue(i.currency,i.issuer),i
          ]));
          for(const entry of body.tokens as any[]){
            const key=canonicalIssue(entry?.currency,entry?.issuer);
            const matched=key ? eligible.get(key) : null;
            // Provider rank alone does not prove memecoin eligibility;
            // only pass entries explicitly accepted into fresh exact-issue
            // meme classification from the same category response.
            if(!matched)continue;
            const change24hPct=Number(entry?.pro24h);
            const volume24hXRP=Number(entry?.vol24hxrp);
            const px=Number(entry?.exch);
            if(!Number.isFinite(change24hPct) || change24hPct<=0 ||
               !Number.isFinite(volume24hXRP) || volume24hXRP<50)continue;
            try {this.onGainerObserved({currency:matched.currency,issuer:matched.issuer,
              display:matched.display,observedAt,change24hPct,volume24hXRP,
              ...(Number.isFinite(px) && px>0 ? {priceXRP:px}:{})});}
            catch(e){warn('[MemeDiscovery] gainer observation callback failed: '+String(e).slice(0,100));}
          }
        }
        this.lastRefreshAt=this.now();
        const st=dynamicMemeUniverse.stats(this.now());
        info('[MemeDiscovery] category page accepted '+accepted+
          ' issues; '+st.eligible+' unexpired exact issues (Data by xrpl.to https://xrpl.to)');
      }catch(e) {
        warn('[MemeDiscovery] category refresh deferred: '+
          String((e as Error).message).slice(0,100));
      }
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
    if(!this.available(now) || now-(this.lastLookup.get(key)||0)<15*60*1000)
      return false;
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

  stats():{eligible:number;successfulPages:number;lastSuccessAgeMs:number|null;lastRefreshAgeMs:number|null;cooldownRemainingMs:number;budgetUsed:number;budgetAvailable:boolean} {
    const now=this.now();
    const s=dynamicMemeUniverse.stats(now);
    return {...s,lastRefreshAgeMs:this.lastRefreshAt ? Math.max(0,now-this.lastRefreshAt):null,
      cooldownRemainingMs:Math.max(0,this.globalCooldownUntil-now),
      budgetUsed:this.requestsInWindow,
      budgetAvailable:this.available(now)};
  }
}

/** A shared lookup provider for the current process, initialized at startup. */
let activeFeed:MemeCategoryFeed|null=null;
export function setActiveMemeCategoryFeed(feed:MemeCategoryFeed|null):void {activeFeed=feed;}
export async function ensureTaggedMemeIssue(currency:string,issuer:string,rawCurrency?:string):Promise<boolean> {
  return activeFeed ? activeFeed.ensureIssue(currency,issuer,rawCurrency) : false;
}
