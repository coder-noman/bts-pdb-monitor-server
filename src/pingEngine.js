// src/pingEngine.js — Production-grade ICMP ping engine
// Windows ICMP ping | 40 routers per batch | 3 retries | 30s interval

require('dotenv').config();
const ping = require('ping');
const { query } = require('./db');

const PING_INTERVAL_MS = parseInt(process.env.PING_INTERVAL_MS) || 30000;
const BATCH_SIZE       = parseInt(process.env.PING_BATCH_SIZE)  || 40;
const MAX_RETRIES      = parseInt(process.env.PING_MAX_RETRIES) || 3;
const PING_TIMEOUT_S   = Math.floor((parseInt(process.env.PING_TIMEOUT_MS) || 3000) / 1000);

// In-memory state for each router (keyed by ip_address)
// { upTime, downTime, status, retries, lastCycleUp }
const routerState = {};

// ─── Ping a single IP with Windows ICMP ─────────────────────────────────────
async function pingOne(ip) {
  try {
    const res = await ping.promise.probe(ip, {
      timeout: PING_TIMEOUT_S,
      extra:   ['-n', '1'],   // Windows: -n 1 (send 1 packet)
    });
    return res.alive;
  } catch {
    return false;
  }
}

// ─── Ping with up to MAX_RETRIES attempts ────────────────────────────────────
async function pingWithRetry(ip) {
  // First attempt
  const firstTry = await pingOne(ip);
  if (firstTry) return { alive: true, retries: 0 };

  // Up to MAX_RETRIES-1 more attempts (total = MAX_RETRIES)
  for (let attempt = 1; attempt < MAX_RETRIES; attempt++) {
    const result = await pingOne(ip);
    if (result) return { alive: true, retries: attempt };
  }
  return { alive: false, retries: MAX_RETRIES };
}

// ─── Ping a batch of routers concurrently ───────────────────────────────────
async function pingBatch(routers) {
  return Promise.all(
    routers.map(async (router) => {
      const { alive, retries } = await pingWithRetry(router.ip_address);
      return { ...router, alive, retries };
    })
  );
}

// ─── Calculate 24h uptime / downtime ────────────────────────────────────────
async function getUpTimeLast24h(ip) {
  const sql = `
    SELECT COALESCE(SUM(
      CASE WHEN status = 'Up' THEN 30 ELSE 0 END
    ), 0) AS total_up
    FROM ping_history
    WHERE ip_address = $1
      AND checked_at >= NOW() - INTERVAL '24 hours'
  `;
  const res = await query(sql, [ip]);
  return parseInt(res.rows[0].total_up) || 0;
}

async function getDownTimeLast24h(ip) {
  const sql = `
    SELECT COALESCE(SUM(
      CASE WHEN status = 'Down' THEN 30 ELSE 0 END
    ), 0) AS total_down
    FROM ping_history
    WHERE ip_address = $1
      AND checked_at >= NOW() - INTERVAL '24 hours'
  `;
  const res = await query(sql, [ip]);
  return parseInt(res.rows[0].total_down) || 0;
}

// ─── Update router state and write to DB ────────────────────────────────────
async function processResult(router, alive, retries) {
  const ip  = router.ip_address;
  const bts = router.bts_name;

  // Initialise state if first time seen
  if (!routerState[ip]) {
    routerState[ip] = { upTime: 0, downTime: 0, status: 'Unknown', retries: 0 };
  }
  const state = routerState[ip];

  // ── Update upTime / downTime accumulators ──
  if (alive) {
    state.upTime   += 30;   // grows by 30s each ping cycle
    state.downTime  = 0;    // reset when back up
    state.status    = 'Up';
  } else {
    state.downTime += 30;   // grows by 30s each failed cycle
    state.upTime    = 0;    // reset when down
    state.status    = 'Down';
  }
  state.retries = retries;

  // ── Compute 24h totals ──
  const [upLast24h, downLast24h] = await Promise.all([
    getUpTimeLast24h(ip),
    getDownTimeLast24h(ip),
  ]);

  // Add this cycle's contribution to 24h totals
  const upTime24h   = upLast24h   + (alive ? 30 : 0);
  const downTime24h = downLast24h + (alive ? 0 : 30);

  // ── Upsert router_status (live table) ──
  const upsertSQL = `
    INSERT INTO router_status
      (bts_name, ip_address, up_time, down_time,
       up_time_last_24h, down_time_last_24h, status, retries, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
    ON CONFLICT (ip_address) DO UPDATE SET
      bts_name           = EXCLUDED.bts_name,
      up_time            = EXCLUDED.up_time,
      down_time          = EXCLUDED.down_time,
      up_time_last_24h   = EXCLUDED.up_time_last_24h,
      down_time_last_24h = EXCLUDED.down_time_last_24h,
      status             = EXCLUDED.status,
      retries            = EXCLUDED.retries,
      updated_at         = NOW()
  `;
  await query(upsertSQL, [
    bts, ip,
    state.upTime, state.downTime,
    upTime24h, downTime24h,
    state.status, state.retries
  ]);

  // ── Insert into ping_history (TimescaleDB hypertable) ──
  const histSQL = `
    INSERT INTO ping_history
      (bts_name, ip_address, up_time, down_time,
       up_time_last_24h, down_time_last_24h, status, retries, checked_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
  `;
  await query(histSQL, [
    bts, ip,
    state.upTime, state.downTime,
    upTime24h, downTime24h,
    state.status, state.retries
  ]);

  const symbol = alive ? '✔' : '✘';
  console.log(`[PING] ${symbol} ${bts} (${ip}) | status=${state.status} | up=${state.upTime}s | down=${state.downTime}s | retries=${retries}`);
}

// ─── Load all routers from DB ────────────────────────────────────────────────
async function loadRouters() {
  const res = await query('SELECT bts_name, ip_address FROM routers ORDER BY id');
  return res.rows;
}

// ─── Main ping cycle ─────────────────────────────────────────────────────────
async function runPingCycle() {
  const cycleStart = Date.now();
  let routers;

  try {
    routers = await loadRouters();
  } catch (err) {
    console.error('[PING ENGINE] Failed to load routers:', err.message);
    return;
  }

  if (routers.length === 0) {
    console.log('[PING ENGINE] No routers found in DB. Waiting...');
    return;
  }

  console.log(`\n[PING ENGINE] ── Cycle start | ${routers.length} routers | ${new Date().toISOString()}`);

  // Split into batches of BATCH_SIZE
  const batches = [];
  for (let i = 0; i < routers.length; i += BATCH_SIZE) {
    batches.push(routers.slice(i, i + BATCH_SIZE));
  }

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    console.log(`[PING ENGINE] Batch ${b + 1}/${batches.length} | ${batch.length} routers`);
    const results = await pingBatch(batch);
    // Process DB writes concurrently within the batch
    await Promise.all(results.map(r => processResult(r, r.alive, r.retries)));
  }

  const elapsed = ((Date.now() - cycleStart) / 1000).toFixed(1);
  console.log(`[PING ENGINE] ── Cycle done in ${elapsed}s\n`);
}

// ─── Start the engine ────────────────────────────────────────────────────────
async function start() {
  console.log('[PING ENGINE] Starting...');
  console.log(`  Interval : ${PING_INTERVAL_MS / 1000}s`);
  console.log(`  Batch    : ${BATCH_SIZE} routers`);
  console.log(`  Retries  : ${MAX_RETRIES}`);
  console.log(`  Timeout  : ${PING_TIMEOUT_S}s per ping`);

  // Run immediately on start
  await runPingCycle();

  // Then repeat every PING_INTERVAL_MS
  setInterval(async () => {
    try {
      await runPingCycle();
    } catch (err) {
      console.error('[PING ENGINE] Cycle error:', err.message);
    }
  }, PING_INTERVAL_MS);
}

module.exports = { start };

// Allow running standalone: node src/pingEngine.js
if (require.main === module) {
  const { testConnection } = require('./db');
  testConnection().then(ok => {
    if (!ok) process.exit(1);
    start();
  });
}
