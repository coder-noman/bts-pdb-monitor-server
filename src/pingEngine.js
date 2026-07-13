// src/pingEngine.js — Production ICMP ping engine
// Windows ICMP ping | 40 routers per batch | countdown-based down detection
// | batched DB writes (2 queries per cycle, regardless of router count)

require('dotenv').config();
const ping = require('ping');
const { query } = require('./db');

const PING_INTERVAL_MS     = parseInt(process.env.PING_INTERVAL_MS)     || 30000;
const BATCH_SIZE           = parseInt(process.env.PING_BATCH_SIZE)      || 40;
const COUNTDOWN_THRESHOLD  = parseInt(process.env.COUNTDOWN_THRESHOLD)  || 10;
const PING_TIMEOUT_S       = Math.floor((parseInt(process.env.PING_TIMEOUT_MS) || 3000) / 1000);

// In-memory state per router (keyed by ip_address)
// { upTime, downTime, status, countdown }
const routerState = {};

// ─── Ping a single IP with Windows ICMP (single attempt, no retry) ──────────
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

// ─── Ping a batch of routers concurrently (1 attempt each) ──────────────────
async function pingBatch(routers) {
  return Promise.all(
    routers.map(async (router) => {
      const alive = await pingOne(router.ip_address);
      return { bts_name: router.bts_name, ip_address: router.ip_address, alive };
    })
  );
}

// ─── Update in-memory state using countdown logic ───────────────────────────
//
//  alive=true:
//    countdown = 0, status = 'Up', up_time += 30, down_time = 0
//
//  alive=false:
//    countdown += 1 (capped at COUNTDOWN_THRESHOLD)
//    countdown 1..(THRESHOLD-1) → still reported 'Up' (grace period),
//                                  up_time keeps growing normally
//    countdown == THRESHOLD     → status = 'Down' (confirmed),
//                                  down_time starts fresh at 30 and
//                                  grows normally (+30) each cycle
//                                  it stays down, up_time = 0
//
function updateState(ip, alive) {
  if (!routerState[ip]) {
    routerState[ip] = { upTime: 0, downTime: 0, status: 'Unknown', countdown: 0 };
  }
  const s = routerState[ip];

  if (alive) {
    s.countdown = 0;
    s.status    = 'Up';
    s.upTime   += 30;
    s.downTime  = 0;
  } else {
    if (s.countdown < COUNTDOWN_THRESHOLD) s.countdown += 1;

    if (s.countdown < COUNTDOWN_THRESHOLD) {
      // still in grace period — reported as Up
      s.status    = 'Up';
      s.upTime   += 30;
      s.downTime  = 0;
    } else {
      // confirmed down — down_time grows normally from here
      s.status    = 'Down';
      s.downTime += 30;
      s.upTime    = 0;
    }
  }
  return s;
}

// ─── Get 24h up/down sums for ALL routers in ONE query ──────────────────────
async function get24hSumsForAll() {
  const sql = `
    SELECT
      ip_address,
      COALESCE(SUM(CASE WHEN status = 'Up'   THEN 30 ELSE 0 END), 0) AS up24,
      COALESCE(SUM(CASE WHEN status = 'Down' THEN 30 ELSE 0 END), 0) AS down24
    FROM ping_history
    WHERE checked_at >= NOW() - INTERVAL '24 hours'
    GROUP BY ip_address
  `;
  const res = await query(sql);
  const map = new Map();
  for (const row of res.rows) {
    map.set(row.ip_address, {
      up24:   parseInt(row.up24),
      down24: parseInt(row.down24),
    });
  }
  return map;
}

// ─── Build one multi-row UPSERT for router_status ────────────────────────────
function buildBatchUpsertStatus(rows) {
  const cols = [
    'bts_name', 'ip_address', 'up_time', 'down_time',
    'up_time_last_24h', 'down_time_last_24h', 'status', 'countdown',
  ];
  const valuesSql = [];
  const params = [];

  rows.forEach((row, i) => {
    const base = i * cols.length;
    const placeholders = cols.map((_, j) => `$${base + j + 1}`);
    valuesSql.push(`(${placeholders.join(',')}, NOW())`);
    cols.forEach(c => params.push(row[c]));
  });

  const sql = `
    INSERT INTO router_status (${cols.join(',')}, updated_at)
    VALUES ${valuesSql.join(',')}
    ON CONFLICT (ip_address) DO UPDATE SET
      bts_name           = EXCLUDED.bts_name,
      up_time            = EXCLUDED.up_time,
      down_time          = EXCLUDED.down_time,
      up_time_last_24h   = EXCLUDED.up_time_last_24h,
      down_time_last_24h = EXCLUDED.down_time_last_24h,
      status             = EXCLUDED.status,
      countdown          = EXCLUDED.countdown,
      updated_at         = NOW()
  `;
  return { sql, params };
}

// ─── Build one multi-row INSERT for ping_history ─────────────────────────────
function buildBatchInsertHistory(rows, timestamp) {
  const cols = [
    'bts_name', 'ip_address', 'up_time', 'down_time',
    'up_time_last_24h', 'down_time_last_24h', 'status', 'countdown', 'checked_at',
  ];
  const valuesSql = [];
  const params = [];

  rows.forEach((row, i) => {
    const base = i * cols.length;
    const placeholders = cols.map((_, j) => `$${base + j + 1}`);
    valuesSql.push(`(${placeholders.join(',')})`);
    cols.forEach(c => {
      params.push(c === 'checked_at' ? timestamp : row[c]);
    });
  });

  const sql = `INSERT INTO ping_history (${cols.join(',')}) VALUES ${valuesSql.join(',')}`;
  return { sql, params };
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

  const cycleTimestamp = new Date();
  console.log(`\n[PING ENGINE] ── Cycle start | ${routers.length} routers | ${cycleTimestamp.toISOString()}`);

  // ── Ping all routers in batches of BATCH_SIZE ──
  const allResults = [];
  for (let i = 0; i < routers.length; i += BATCH_SIZE) {
    const batch = routers.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(routers.length / BATCH_SIZE);
    console.log(`[PING ENGINE] Batch ${batchNum}/${totalBatches} | ${batch.length} routers`);
    const results = await pingBatch(batch);
    allResults.push(...results);
  }

  // ── Get 24h sums for all routers in ONE query ──
  let sums;
  try {
    sums = await get24hSumsForAll();
  } catch (err) {
    console.error('[PING ENGINE] Failed to get 24h sums:', err.message);
    sums = new Map();
  }

  // ── Update in-memory state + build row objects ──
  const rows = allResults.map(r => {
    const state = updateState(r.ip_address, r.alive);
    const sum = sums.get(r.ip_address) || { up24: 0, down24: 0 };
    const up24h   = sum.up24   + (state.status === 'Up'   ? 30 : 0);
    const down24h = sum.down24 + (state.status === 'Down' ? 30 : 0);

    const symbol = r.alive ? '✔' : '✘';
    console.log(`[PING] ${symbol} ${r.bts_name} (${r.ip_address}) | status=${state.status} | up=${state.upTime}s | down=${state.downTime}s | countdown=${state.countdown}`);

    return {
      bts_name:           r.bts_name,
      ip_address:         r.ip_address,
      up_time:            state.upTime,
      down_time:          state.downTime,
      up_time_last_24h:   up24h,
      down_time_last_24h: down24h,
      status:             state.status,
      countdown:          state.countdown,
    };
  });

  // ── ONE batch write to router_status ──
  try {
    const { sql, params } = buildBatchUpsertStatus(rows);
    await query(sql, params);
  } catch (err) {
    console.error('[PING ENGINE] Batch upsert (router_status) failed:', err.message);
  }

  // ── ONE batch write to ping_history ──
  try {
    const { sql, params } = buildBatchInsertHistory(rows, cycleTimestamp);
    await query(sql, params);
  } catch (err) {
    console.error('[PING ENGINE] Batch insert (ping_history) failed:', err.message);
  }

  const elapsed = ((Date.now() - cycleStart) / 1000).toFixed(1);
  console.log(`[PING ENGINE] ── Cycle done in ${elapsed}s (2 DB writes total)\n`);
}

// ─── Start the engine ────────────────────────────────────────────────────────
async function start() {
  console.log('[PING ENGINE] Starting...');
  console.log(`  Interval           : ${PING_INTERVAL_MS / 1000}s`);
  console.log(`  Batch size         : ${BATCH_SIZE} routers`);
  console.log(`  Countdown threshold: ${COUNTDOWN_THRESHOLD} cycles (= ${(COUNTDOWN_THRESHOLD * PING_INTERVAL_MS) / 1000}s to confirm Down)`);
  console.log(`  Ping timeout       : ${PING_TIMEOUT_S}s per ping`);

  await runPingCycle();

  setInterval(async () => {
    try {
      await runPingCycle();
    } catch (err) {
      console.error('[PING ENGINE] Cycle error:', err.message);
    }
  }, PING_INTERVAL_MS);
}

module.exports = { start };

if (require.main === module) {
  const { testConnection } = require('./db');
  testConnection().then(ok => {
    if (!ok) process.exit(1);
    start();
  });
}