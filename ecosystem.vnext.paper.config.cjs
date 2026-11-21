// vNext PAPER deployment candidate. Does not launch the legacy bot.
// The operator must approve the exact manual token list by SHA256 before
// enabling this config. Env values are not embedded in source control.
const path=require('path');
const root=__dirname;
const epoch=process.env.HUNTERIX_VNEXT_EPOCH_ID || '';
if(!/^meme_bot[.]paper-epoch-[0-9]{8}(?:-[a-z0-9]+)?$/.test(epoch)){
  throw new Error('vNext epoch ID absent/invalid: set HUNTERIX_VNEXT_EPOCH_ID first');
}
if(!process.env.HUNTERIX_LEGACY_SOURCE_DB_PATH ||
    !path.isAbsolute(process.env.HUNTERIX_LEGACY_SOURCE_DB_PATH)){
  throw new Error('Absolute path to original legacy recovery database required');
}
if(!/^[0-9a-f]{64}$/i.test(process.env.HUNTERIX_OPERATOR_BLACKLIST_APPROVED_SHA256 || '')){
  throw new Error('Approved operator-manifest SHA256 required before staging PM2');
}
if(!/^[0-9a-f]{64}$/i.test(process.env.HUNTERIX_OPERATOR_MEME_ALLOWLIST_APPROVED_SHA256 || '')){
  throw new Error('Reviewed exact-meme issue allowlist SHA256 required');
}
const endpoint=process.env.HUNTERIX_VNEXT_XRPL_WS_URL || '';
let parsedEndpoint;
try { parsedEndpoint=new URL(endpoint); }
catch { throw new Error('Explicit vNext XRPL WebSocket URL required (not old fallback)'); }
if (parsedEndpoint.protocol!=='wss:' || parsedEndpoint.username || parsedEndpoint.password) {
  throw new Error('vNext XRPL endpoint must be an encrypted, credential-free wss:// URL');
}
module.exports={
  apps:[{
    name:'hunterix-vnext-paper',
    cwd:root,
    script:path.join(root,'scripts/vnext_paper_entrypoint.sh'),
    interpreter:'/bin/bash',
    instances:1,exec_mode:'fork',watch:false,
    min_uptime:60000,max_restarts:3,exp_backoff_restart_delay:10000,
    max_memory_restart:'550M',kill_timeout:15000,
    env:{
      MODE:'PAPER',LIVE_TRADING:'false',TRADING_WALLET_SEED:'',
      XRPL_WS_URL:endpoint,
      HUNTERIX_VNEXT_XRPL_WS_URL:endpoint,
      BOT_DB_PATH:path.join(root,'data',epoch+'.db'),
      BOT_PAPER_EPOCH_ID:epoch,
      HUNTERIX_MANUAL_BLOCKLIST_FILE:path.join(root,'state','manual_token_blacklist.json'),
      HUNTERIX_LEGACY_SOURCE_DB_PATH:process.env.HUNTERIX_LEGACY_SOURCE_DB_PATH,
      HUNTERIX_OPERATOR_BLACKLIST_APPROVED_SHA256:process.env.HUNTERIX_OPERATOR_BLACKLIST_APPROVED_SHA256,
      BOT_PAPER_MEME_ONLY:'1',
      HUNTERIX_MEME_ENTRY_ALLOWLIST_FILE:path.join(root,'state','paper_meme_entry_allowlist.json'),
      HUNTERIX_OPERATOR_MEME_ALLOWLIST_APPROVED_SHA256:process.env.HUNTERIX_OPERATOR_MEME_ALLOWLIST_APPROVED_SHA256,
      BOT_USE_RESERVE_QUOTES:'1',
      BOT_ENABLE_LIQUIDITY_LOSS_GUARD:'1',
      BOT_ENABLE_SMALL_LAUNCH_PROBES:'0',
      BOT_ENABLE_VALIDATED_LEARNING:'0',
      BOT_ENABLE_STARTUP_PRUNE:'0',
      BOT_ENABLE_OBSERVATION_RETENTION:'1',
      BOT_ENABLE_RECOVERY_DISK_GUARD:'1',
      XRPL_SEPARATE_STREAM:'1',
      // Public XRPL services may close WebSockets with 1008 / threshold exceeded.
      // Conservative per-process request pacing; tune from diagnostic evidence.
      XRPL_RPC_MAX_INFLIGHT:'2',
      XRPL_RPC_MAX_PER_SEC:'3',
      XRPL_BOOK_CACHE_MS:'2000',
      XRPL_DIAG_METRICS:'1',
      SCAN_BATCH_SIZE:'10',
      NODE_ENV:'production'
    }
  }]
};
