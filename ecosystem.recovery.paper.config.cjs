// PAPER-only deployment. Never put a wallet seed in this file.
// PM2 runs the guarded entrypoint on every restart.
const path = require('path');
const root = __dirname;
module.exports = {
  apps: [{
    name: 'hunterix-paper',
    cwd: root,
    script: path.join(root, 'scripts', 'recovery_paper_entrypoint.sh'),
    interpreter: '/bin/bash',
    exec_mode: 'fork',
    instances: 1,
    watch: false,
    min_uptime: 60000,
    max_restarts: 5,
    exp_backoff_restart_delay: 10000,
    max_memory_restart: '550M',
    kill_timeout: 15000,
    env: {
      MODE: 'PAPER',
      LIVE_TRADING: 'false',
      TRADING_WALLET_SEED: '',
      BOT_DB_PATH: path.join(root, 'data', 'meme_bot.recovery.db'),
      BOT_ENABLE_STARTUP_PRUNE: '0',
      BOT_ENABLE_OBSERVATION_RETENTION: '1',
      BOT_ENABLE_RECOVERY_DISK_GUARD: '1',
      XRPL_SEPARATE_STREAM: '1',
      XRPL_BOOK_CACHE_MS: '2000',
      XRPL_DIAG_METRICS: '1',
      XRPL_DIAG_LEDGER_ONLY: '0',
      SCAN_BATCH_SIZE: '10',
      NODE_ENV: 'production'
    }
  }]
};
