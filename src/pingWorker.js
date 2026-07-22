require('dotenv').config();
const { testConnection } = require('./db');
const pingEngine = require('./pingEngine');
const scheduler  = require('./scheduler');

function shutdown(signal) {
  console.log(`\n[PING WORKER] ${signal} received. Shutting down gracefully...`);
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException',  err => console.error('[PING WORKER] Uncaught:', err));
process.on('unhandledRejection', err => console.error('[PING WORKER] Unhandled rejection:', err));

async function boot() {
  console.log('═══════════════════════════════════════');
  console.log('  Router Monitor — Ping Worker Process  ');
  console.log('  (Ping Engine + Nightly Scheduler only) ');
  console.log('═══════════════════════════════════════');

  const dbOk = await testConnection();
  if (!dbOk) {
    console.error('[PING WORKER] Cannot connect to database. Exiting.');
    process.exit(1);
  }

  // Start the 30-second ping cycle — runs forever
  await pingEngine.start();

  // Start the automatic nightly daily-summary scheduler
  // (also self-heals any missed days right now on startup)
  scheduler.start();

  console.log('[PING WORKER] Running independently of the API server.');
  console.log('[PING WORKER] Updating/restarting the API will NOT affect this process.');
}

boot();