// src/pingEngine.js — Production ICMP ping engine v3
// Windows ICMP ping | 40 routers per batch
// | countdown-based down detection WITH retroactive correction
// | batched DB writes (2 queries per cycle, +1 tiny correction
//   query only on the rare cycle a router gets confirmed Down)

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
//    countdown == THRESHOLD     → CONFIRMED DOWN this cycle.
//                                  The entire grace window (the previous
//                                  THRESHOLD-1 cycles that were stored as
//                                  'Up') is now retroactively wrong — the
//                                  router was actually down that whole time.
//                                  down_time jumps straight to
//                                  THRESHOLD*30 (the full confirmed window),
//                                  and justConfirmed=true is returned so
//                                  runPingCycle() can fix those already-
//                                  written history rows.
//    countdown stays == THRESHOLD on later cycles (still down) →
//                                  down_time keeps growing normally (+30)
//
function updateState(ip, alive) {
  if (!routerState[ip]) {
    routerState[ip] = { upTime: 0, downTime: 0, status: 'Unknown', countdown: 0 };
  }
  const s = routerState[ip];
  let justConfirmed = false;

  if (alive) {
    s.countdown = 0;
    s.status    = 'Up';
    s.upTime   += 30;
    s.downTime  = 0;
  } else {
    const wasBelowThreshold = s.countdown < COUNTDOWN_THRESHOLD;
    if (s.countdown < COUNTDOWN_THRESHOLD) s.countdown += 1;

    if (s.countdown < COUNTDOWN_THRESHOLD) {
      // still in grace period — reported as Up for now
      s.status    = 'Up';
      s.upTime   += 30;
      s.downTime  = 0;
    } else {
      // confirmed down (countdown just hit, or already sitting at, threshold)
      s.status = 'Down';
      s.upTime = 0;

      if (wasBelowThreshold) {
        // this is the exact cycle the countdown reached the threshold —
        // the whole grace window is now retroactively "was actually down"
        justConfirmed = true;
        s.downTime = COUNTDOWN_THRESHOLD * 30;
      } else {
        // already confirmed down previously, still down, keep growing
        s.downTime += 30;
      }
    }
  }
  return { ...s, justConfirmed };
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

// ─── For a router that just got confirmed Down, find the 24h up/down ───────
// ─── sums as they stood right BEFORE its grace period began (i.e. skip ─────
// ─── over the THRESHOLD-1 rows that are about to be corrected) ─────────────
async function getPreGraceSums(ip) {
  const sql = `
    SELECT up_time_last_24h, down_time_last_24h
    FROM ping_history
    WHERE ip_address = $1
    ORDER BY checked_at DESC
    OFFSET $2
    LIMIT 1
  `;
  const res = await query(sql, [ip, COUNTDOWN_THRESHOLD - 1]);
  if (res.rowCount === 0) return { up24: 0, down24: 0 }; // brand-new router, no history yet
  return {
    up24:   parseInt(res.rows[0].up_time_last_24h)   || 0,
    down24: parseInt(res.rows[0].down_time_last_24h) || 0,
  };
}

// ─── Retroactively flip the last (THRESHOLD-1) history rows for this IP ─────
// ─── from Up → Down, now that the router has been confirmed Down. ──────────
// ─── Uses a single UPDATE (window function) — one query per confirming ─────
// ─── router, only on the rare cycle it happens. ─────────────────────────────
async function correctGraceWindow(ip, preGrace) {
  const graceRows = COUNTDOWN_THRESHOLD - 1;
  if (graceRows <= 0) return;

  const sql = `
    WITH grace AS (
      SELECT ctid, ROW_NUMBER() OVER (ORDER BY checked_at DESC) AS rn
      FROM ping_history
      WHERE ip_address = $1
      ORDER BY checked_at DESC
      LIMIT $2
    )
    UPDATE ping_history p
    SET
      status              = 'Down',
      up_time             = 0,
      down_time           = (($2 + 1) - grace.rn) * 30,
      up_time_last_24h    = $3,
      down_time_last_24h  = $4 + (($2 + 1) - grace.rn) * 30
    FROM grace
    WHERE p.ctid = grace.ctid
  `;
  await query(sql, [ip, graceRows, preGrace.up24, preGrace.down24]);
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

  // ── Get 24h sums for all routers in ONE query (used for every router ──
  // ── EXCEPT ones that just got confirmed Down this exact cycle — those ──
  // ── use getPreGraceSums() instead, fetched further below) ──────────────
  let sums;
  try {
    sums = await get24hSumsForAll();
  } catch (err) {
    console.error('[PING ENGINE] Failed to get 24h sums:', err.message);
    sums = new Map();
  }

  // ── Pass 1: update in-memory state for every router, note which ──
  // ── ones just crossed the confirmation threshold this cycle ──────
  const updated = allResults.map(r => {
    const state = updateState(r.ip_address, r.alive);
    return { ...r, state };
  });
  const justConfirmedIps = updated.filter(u => u.state.justConfirmed).map(u => u.ip_address);

  // ── Pass 2: for any just-confirmed router, fetch the 24h sums as ──
  // ── they stood BEFORE its grace period began (small extra query, ──
  // ── only runs on the rare cycle a router flips to confirmed Down) ──
  const preGraceMap = new Map();
  for (const ip of justConfirmedIps) {
    try {
      preGraceMap.set(ip, await getPreGraceSums(ip));
    } catch (err) {
      console.error(`[PING ENGINE] Failed to get pre-grace sums for ${ip}:`, err.message);
      preGraceMap.set(ip, { up24: 0, down24: 0 });
    }
  }

  // ── Build final row objects for this cycle's batch insert ──
  const rows = updated.map(r => {
    const state = r.state;
    let up24h, down24h;

    if (state.justConfirmed) {
      const base = preGraceMap.get(r.ip_address) || { up24: 0, down24: 0 };
      up24h   = base.up24;                              // no Up growth during a down streak
      down24h = base.down24 + COUNTDOWN_THRESHOLD * 30;  // whole confirmed window counted
    } else {
      const sum = sums.get(r.ip_address) || { up24: 0, down24: 0 };
      up24h   = sum.up24   + (state.status === 'Up'   ? 30 : 0);
      down24h = sum.down24 + (state.status === 'Down' ? 30 : 0);
    }

    const symbol = r.alive ? '✔' : '✘';
    const tag = state.justConfirmed ? ' [CONFIRMED DOWN — correcting grace window]' : '';
    console.log(`[PING] ${symbol} ${r.bts_name} (${r.ip_address}) | status=${state.status} | up=${state.upTime}s | down=${state.downTime}s | countdown=${state.countdown}${tag}`);

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

  // ── ONE batch write to ping_history (this cycle's row for every router) ──
  try {
    const { sql, params } = buildBatchInsertHistory(rows, cycleTimestamp);
    await query(sql, params);
  } catch (err) {
    console.error('[PING ENGINE] Batch insert (ping_history) failed:', err.message);
  }

  // ── Retroactive correction — only for routers that just got confirmed ──
  // ── Down this cycle. Rare event, so a small extra query per router is ──
  // ── negligible overhead compared to the 200-router batch above. ────────
  for (const ip of justConfirmedIps) {
    try {
      const preGrace = preGraceMap.get(ip) || { up24: 0, down24: 0 };
      await correctGraceWindow(ip, preGrace);
      console.log(`[PING ENGINE] Corrected grace window for ${ip} — last ${COUNTDOWN_THRESHOLD - 1} rows flipped Up→Down`);
    } catch (err) {
      console.error(`[PING ENGINE] Failed to correct grace window for ${ip}:`, err.message);
    }
  }

  const elapsed = ((Date.now() - cycleStart) / 1000).toFixed(1);
  const extraWrites = justConfirmedIps.length;
  console.log(`[PING ENGINE] ── Cycle done in ${elapsed}s (2 DB writes${extraWrites ? ` + ${extraWrites} correction write(s)` : ''})\n`);
}

// ─── Start the engine ────────────────────────────────────────────────────────
async function start() {
  console.log('[PING ENGINE] Starting...');
  console.log(`  Interval           : ${PING_INTERVAL_MS / 1000}s`);
  console.log(`  Batch size         : ${BATCH_SIZE} routers`);
  console.log(`  Countdown threshold: ${COUNTDOWN_THRESHOLD} cycles (= ${(COUNTDOWN_THRESHOLD * PING_INTERVAL_MS) / 1000}s to confirm Down)`);
  console.log(`  Ping timeout       : ${PING_TIMEOUT_S}s per ping`);
  console.log(`  Retroactive correction: ON — grace window rows get corrected Up→Down when confirmed`);

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