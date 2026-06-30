// src/scheduler.js — Automatic nightly daily-summary job
//
// Runs runDailyJob() for "yesterday" every night at 1:00 AM,
// and also self-heals on every server start by checking for
// any recent missed dates and backfilling them automatically.
//
// No manual API call needed — this is fully automatic as long
// as the server process is running.

const cron = require('node-cron');
const { query } = require('./db');
const { runDailyJob } = require('./routes/analytics');

// How many days back to check for gaps on startup.
// 35 covers a missed week+ comfortably without being wasteful.
const BACKFILL_LOOKBACK_DAYS = 35;

function yesterday() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function dateNDaysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

// ── Find any dates in the last N days that have ping_history ──
// ── data but NO daily_summary row yet, and backfill them. ──────
async function backfillMissingDays() {
  console.log('[SCHEDULER] Checking for missed days to backfill...');

  const sql = `
    WITH date_series AS (
      SELECT generate_series(
        ($1)::date,
        ($2)::date,
        INTERVAL '1 day'
      )::date AS d
    ),
    has_ping_data AS (
      SELECT DISTINCT checked_at::date AS d
      FROM ping_history
      WHERE checked_at >= $1::date AND checked_at < ($2::date + INTERVAL '1 day')
    ),
    has_summary AS (
      SELECT DISTINCT summary_date AS d
      FROM daily_summary
      WHERE summary_date >= $1::date AND summary_date <= $2::date
    )
    SELECT ds.d AS missing_date
    FROM date_series ds
    JOIN has_ping_data hp ON hp.d = ds.d
    LEFT JOIN has_summary hs ON hs.d = ds.d
    WHERE hs.d IS NULL
    ORDER BY ds.d ASC
  `;

  const lookbackStart = dateNDaysAgo(BACKFILL_LOOKBACK_DAYS);
  const lookbackEnd   = yesterday(); // never touch "today" — it's not finished yet

  try {
    const result = await query(sql, [lookbackStart, lookbackEnd]);

    if (result.rowCount === 0) {
      console.log('[SCHEDULER] No missed days found. All caught up.');
      return;
    }

    console.log(`[SCHEDULER] Found ${result.rowCount} missed day(s). Backfilling...`);

    for (const row of result.rows) {
      const dateStr = row.missing_date.toISOString().slice(0, 10);
      try {
        const res2 = await runDailyJob(dateStr);
        console.log(`[SCHEDULER] Backfilled ${dateStr} — ${res2.routers_processed} routers, ${res2.events_stored} events`);
      } catch (err) {
        console.error(`[SCHEDULER] Failed to backfill ${dateStr}:`, err.message);
      }
    }

    console.log('[SCHEDULER] Backfill complete.');
  } catch (err) {
    console.error('[SCHEDULER] Backfill check failed:', err.message);
  }
}

// ── Run the job for "yesterday" — the normal nightly run ──────
async function runNightlyJob() {
  const targetDate = yesterday();
  console.log(`[SCHEDULER] Running nightly job for ${targetDate}...`);
  try {
    const result = await runDailyJob(targetDate);
    console.log(`[SCHEDULER] Nightly job done — ${result.routers_processed} routers, ${result.events_stored} events stored for ${targetDate}`);
  } catch (err) {
    console.error('[SCHEDULER] Nightly job failed:', err.message);
  }
}

// ── Start the scheduler ────────────────────────────────────────
function start() {
  // Cron format: minute hour day month weekday
  // '0 1 * * *' = every day at 01:00 (server local time)
  cron.schedule('0 1 * * *', () => {
    runNightlyJob();
  });

  console.log('[SCHEDULER] Nightly daily-summary job scheduled for 01:00 every day.');

  // Self-heal: check for gaps every time the server starts
  backfillMissingDays();
}

module.exports = { start, runNightlyJob, backfillMissingDays };
