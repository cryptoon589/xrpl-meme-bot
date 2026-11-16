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
      BOT_DB_PATH:path.join(root,'data',epoch+'.db'),
      BOT_PAPER_EPOCH_ID:epoch,
      HUNTERIX_MANUAL_BLOCKLIST_FILE:path.join(root,'state','manual_token_blacklist.json'),
      HUNTERIX_LEGACY_SOURCE_DB_PATH:process.env.HUNTERIX_LEGACY_SOURCE_DB_PATH,
      HUNTERIX_OPERATOR_BLACKLIST_APPROVED_SHA256:process.env.HUNTERIX_OPERATOR_BLACKLIST_APPROVED_SHA256,
      BOT_USE_RESERVE_QUOTES:'1',
      BOT_ENABLE_LIQUIDITY_LOSS_GUARD:'1',
      BOT_ENABLE_SMALL_LAUNCH_PROBES:'0',
      BOT_ENABLE_VALIDATED_LEARNING:'0',
      BOT_ENABLE_STARTUP_PRUNE:'0',
      BOT_ENABLE_OBSERVATION_RETENTION:'1',
      BOT_ENABLE_RECOVERY_DISK_GUARD:'1',
      XRPL_SEPARATE_STREAM:'1',
      XRPL_BOOK_CACHE_MS:'2000',
      XRPL_DIAG_METRICS:'1',
      SCAN_BATCH_SIZE:'10',
      NODE_ENV:'production'
    }
  }]
};
