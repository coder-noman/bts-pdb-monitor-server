// src/routes/analytics.js — Daily summaries, live stats, and "ask" endpoint

const express = require('express');
const router  = express.Router();
const { query } = require('../db');
const { formatDuration } = require('../utils');

function serverError(res, err) {
  console.error('[ANALYTICS]', err.message);
  return res.status(500).json({ success: false, error: err.message });
}
function notFound(res, ip) {
  return res.status(404).json({ success: false, error: `Router '${ip}' not found` });
}

// Map period string -> number of days
function periodToDays(period) {
  if (period === '7d')  return 7;
  if (period === '30d') return 30;
  return 1; // default '1d'
}

// ══════════════════════════════════════════════════════════
//  Core stats calculator — used by /summary and /ask
//  Computes LIVE from ping_history, sliding window of `days`.
// ══════════════════════════════════════════════════════════
async function computeStats(ip, days) {
  const sql = `
    SELECT
      COALESCE(SUM(CASE WHEN status = 'Up'   THEN 30 ELSE 0 END), 0) AS up_seconds,
      COALESCE(SUM(CASE WHEN status = 'Down' THEN 30 ELSE 0 END), 0) AS down_seconds
    FROM ping_history
    WHERE ip_address = $1
      AND checked_at >= NOW() - ($2 || ' days')::interval
  `;
  const incidentSQL = `
    WITH d AS (
      SELECT status, checked_at,
        LAG(status) OVER (ORDER BY checked_at) AS prev_status
      FROM ping_history
      WHERE ip_address = $1
        AND checked_at >= NOW() - ($2 || ' days')::interval
    )
    SELECT COUNT(*) AS cnt FROM d WHERE status = 'Down' AND prev_status = 'Up'
  `;

  const [statsRes, incidentRes] = await Promise.all([
    query(sql, [ip, days.toString()]),
    query(incidentSQL, [ip, days.toString()]),
  ]);

  const up_seconds   = parseInt(statsRes.rows[0].up_seconds)   || 0;
  const down_seconds = parseInt(statsRes.rows[0].down_seconds) || 0;
  const down_incidents = parseInt(incidentRes.rows[0].cnt) || 0;

  const period_seconds = days * 86400;
  const uptime_pct   = period_seconds > 0 ? (up_seconds   / period_seconds) * 100 : 0;
  const downtime_pct = period_seconds > 0 ? (down_seconds / period_seconds) * 100 : 0;

  return {
    period_days: days,
    period_seconds,
    up_seconds,
    down_seconds,
    monitored_seconds: up_seconds + down_seconds,
    uptime_pct:   Math.round(uptime_pct   * 100) / 100,
    downtime_pct: Math.round(downtime_pct * 100) / 100,
    down_incidents,
  };
}

// ══════════════════════════════════════════════════════════
//  GET /api/analytics/summary/:ip?period=1d|7d|30d
//  Live uptime/downtime % + down incidents for a single router
// ══════════════════════════════════════════════════════════
router.get('/analytics/summary/:ip', async (req, res) => {
  const ip = req.params.ip;
  const days = periodToDays(req.query.period);
  try {
    const check = await query('SELECT bts_name FROM routers WHERE ip_address = $1', [ip]);
    if (check.rowCount === 0) return notFound(res, ip);

    const stats = await computeStats(ip, days);

    res.json({
      success: true,
      bts_name: check.rows[0].bts_name,
      ip_address: ip,
      ...stats,
      up_time_human:   formatDuration(stats.up_seconds),
      down_time_human: formatDuration(stats.down_seconds),
    });
  } catch (err) { serverError(res, err); }
});

// ══════════════════════════════════════════════════════════
//  GET /api/analytics/daily-breakdown/:ip?days=7|30
//  Returns daily_summary rows (requires run-daily-summary to
//  have been called for those dates)
// ══════════════════════════════════════════════════════════
router.get('/analytics/daily-breakdown/:ip', async (req, res) => {
  const ip = req.params.ip;
  const days = parseInt(req.query.days) || 7;
  try {
    const check = await query('SELECT bts_name FROM routers WHERE ip_address = $1', [ip]);
    if (check.rowCount === 0) return notFound(res, ip);

    const sql = `
      SELECT summary_date, bts_name, ip_address,
        up_seconds, down_seconds, down_incidents,
        uptime_pct, downtime_pct
      FROM daily_summary
      WHERE ip_address = $1
      ORDER BY summary_date DESC
      LIMIT $2
    `;
    const result = await query(sql, [ip, days]);

    res.json({
      success: true,
      bts_name: check.rows[0].bts_name,
      ip_address: ip,
      count: result.rowCount,
      days: result.rows,
    });
  } catch (err) { serverError(res, err); }
});

// ══════════════════════════════════════════════════════════
//  POST /api/analytics/run-daily-summary?date=YYYY-MM-DD
//  Computes and stores daily_summary for ALL routers for a
//  given calendar date (UTC). Defaults to yesterday.
//  Trigger this manually (e.g. once a day, or whenever needed).
// ══════════════════════════════════════════════════════════
router.post('/analytics/run-daily-summary', async (req, res) => {
  try {
    let targetDate = req.query.date;
    if (!targetDate) {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - 1);
      targetDate = d.toISOString().slice(0, 10); // YYYY-MM-DD
    }
    // Validate format
    if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
      return res.status(400).json({ success: false, error: 'date must be YYYY-MM-DD' });
    }

    const startTs = `${targetDate}T00:00:00.000Z`;
    const endTs   = `${targetDate}T23:59:59.999Z`;

    // ── up/down seconds per router for the date ──
    const statsSQL = `
      SELECT ip_address, bts_name,
        COALESCE(SUM(CASE WHEN status = 'Up'   THEN 30 ELSE 0 END), 0) AS up_seconds,
        COALESCE(SUM(CASE WHEN status = 'Down' THEN 30 ELSE 0 END), 0) AS down_seconds
      FROM ping_history
      WHERE checked_at >= $1 AND checked_at <= $2
      GROUP BY ip_address, bts_name
    `;

    // ── down incidents (Up -> Down transitions) per router for the date ──
    const incidentSQL = `
      WITH d AS (
        SELECT ip_address, status, checked_at,
          LAG(status) OVER (PARTITION BY ip_address ORDER BY checked_at) AS prev_status
        FROM ping_history
        WHERE checked_at >= $1 AND checked_at <= $2
      )
      SELECT ip_address, COUNT(*) AS down_incidents
      FROM d
      WHERE status = 'Down' AND prev_status = 'Up'
      GROUP BY ip_address
    `;

    const [statsRes, incidentRes] = await Promise.all([
      query(statsSQL,    [startTs, endTs]),
      query(incidentSQL, [startTs, endTs]),
    ]);

    if (statsRes.rowCount === 0) {
      return res.json({
        success: true,
        date: targetDate,
        message: 'No ping_history data found for this date. Nothing to summarize.',
        routers_processed: 0,
      });
    }

    const incidentMap = new Map();
    for (const row of incidentRes.rows) {
      incidentMap.set(row.ip_address, parseInt(row.down_incidents));
    }

    const PERIOD_SECONDS = 86400;
    const cols = [
      'summary_date', 'bts_name', 'ip_address',
      'up_seconds', 'down_seconds', 'down_incidents',
      'uptime_pct', 'downtime_pct',
    ];
    const valuesSql = [];
    const params = [];

    statsRes.rows.forEach((row, i) => {
      const up_seconds   = parseInt(row.up_seconds);
      const down_seconds = parseInt(row.down_seconds);
      const down_incidents = incidentMap.get(row.ip_address) || 0;
      const uptime_pct   = Math.round((up_seconds   / PERIOD_SECONDS) * 10000) / 100;
      const downtime_pct = Math.round((down_seconds / PERIOD_SECONDS) * 10000) / 100;

      const rowVals = [
        targetDate, row.bts_name, row.ip_address,
        up_seconds, down_seconds, down_incidents,
        uptime_pct, downtime_pct,
      ];
      const base = i * cols.length;
      const placeholders = cols.map((_, j) => `$${base + j + 1}`);
      valuesSql.push(`(${placeholders.join(',')})`);
      params.push(...rowVals);
    });

    const upsertSQL = `
      INSERT INTO daily_summary (${cols.join(',')})
      VALUES ${valuesSql.join(',')}
      ON CONFLICT (summary_date, ip_address) DO UPDATE SET
        bts_name       = EXCLUDED.bts_name,
        up_seconds     = EXCLUDED.up_seconds,
        down_seconds   = EXCLUDED.down_seconds,
        down_incidents = EXCLUDED.down_incidents,
        uptime_pct     = EXCLUDED.uptime_pct,
        downtime_pct   = EXCLUDED.downtime_pct
    `;
    await query(upsertSQL, params);

    res.json({
      success: true,
      date: targetDate,
      routers_processed: statsRes.rowCount,
      message: `Daily summary computed and stored for ${targetDate}`,
    });

  } catch (err) { serverError(res, err); }
});

// ══════════════════════════════════════════════════════════
//  POST /api/ask
//  Rule-based natural-language query interface.
//  Body: { "question": "..." }
// ══════════════════════════════════════════════════════════

function detectIntent(q) {
  const lower = q.toLowerCase();
  if (/(how many times|number of times|times.*(down|up)|went down|down (event|incident)s?)/.test(lower))
    return 'down_incidents';
  if (/(downtime|down ?time|down percent|down %)/.test(lower))
    return 'downtime_pct';
  if (/(uptime|up ?time|up percent|up %)/.test(lower))
    return 'uptime_pct';
  if (/(down list|currently down|which.*(routers?|bts).*down|how many.*(routers?|bts|pdb).*down|are down)/.test(lower))
    return 'down_list';
  if (/(up list|currently up|which.*(routers?|bts).*up|how many.*(routers?|bts|pdb).*up|are up)/.test(lower))
    return 'up_list';
  return 'unknown';
}

function detectPeriodDays(q) {
  const lower = q.toLowerCase();
  if (/30\s*-?\s*day|month/.test(lower)) return 30;
  if (/7\s*-?\s*day|week/.test(lower))   return 7;
  return 1; // default: today / 1 day / 24 hours
}

function periodLabel(days) {
  if (days === 30) return 'last 30 days';
  if (days === 7)  return 'last 7 days';
  return 'last 24 hours';
}

// Find which router the question is about — by IP first, then by
// fuzzy token-matching against bts_name.
function findRouterMatch(question, routers) {
  const q = question.toLowerCase();

  // 1. IP address match
  const ipMatch = q.match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
  if (ipMatch) {
    const found = routers.find(r => r.ip_address === ipMatch[0]);
    if (found) return found;
  }

  // 2. Fuzzy token match against bts_name
  let best = null;
  let bestScore = 0;
  for (const r of routers) {
    const tokens = r.bts_name.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 2);
    let score = 0;
    for (const t of tokens) {
      if (q.includes(t)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return bestScore > 0 ? best : null;
}

router.post('/ask', async (req, res) => {
  const question = (req.body.question || '').trim();
  if (!question) {
    return res.status(400).json({ success: false, error: '"question" field is required' });
  }

  const intent = detectIntent(question);
  const days   = detectPeriodDays(question);

  try {
    switch (intent) {

      case 'down_list': {
        const sql = `
          SELECT r.bts_name, r.ip_address, s.down_time
          FROM routers r
          JOIN router_status s ON r.ip_address = s.ip_address
          WHERE s.status = 'Down'
          ORDER BY s.down_time DESC
        `;
        const result = await query(sql);
        let answer;
        if (result.rowCount === 0) {
          answer = 'All routers are currently Up. No routers are down.';
        } else {
          answer = `${result.rowCount} router(s) are currently Down:\n` +
            result.rows.map(r => `- ${r.bts_name} (${r.ip_address}) — down for ${formatDuration(r.down_time)}`).join('\n');
        }
        return res.json({ success: true, question, intent, answer, data: result.rows });
      }

      case 'up_list': {
        const sql = `
          SELECT r.bts_name, r.ip_address, s.up_time
          FROM routers r
          JOIN router_status s ON r.ip_address = s.ip_address
          WHERE s.status = 'Up'
          ORDER BY s.up_time DESC
        `;
        const result = await query(sql);
        let answer;
        if (result.rowCount === 0) {
          answer = 'No routers are currently Up.';
        } else {
          answer = `${result.rowCount} router(s) are currently Up.`;
        }
        return res.json({ success: true, question, intent, answer, data: result.rows });
      }

      case 'uptime_pct':
      case 'downtime_pct':
      case 'down_incidents': {
        const routersRes = await query('SELECT bts_name, ip_address FROM routers');
        const match = findRouterMatch(question, routersRes.rows);
        if (!match) {
          return res.json({
            success: true,
            question, intent,
            answer: "I couldn't identify which router/BTS you're asking about. Please include the BTS name or IP address in your question.",
            data: null,
          });
        }

        const stats = await computeStats(match.ip_address, days);
        let answer;

        if (intent === 'uptime_pct') {
          answer = `${match.bts_name} had ${stats.uptime_pct}% uptime over the ${periodLabel(days)} ` +
            `(${formatDuration(stats.up_seconds)} up out of ${formatDuration(stats.period_seconds)}).`;
        } else if (intent === 'downtime_pct') {
          answer = `${match.bts_name} had ${stats.downtime_pct}% downtime over the ${periodLabel(days)} ` +
            `(${formatDuration(stats.down_seconds)} down out of ${formatDuration(stats.period_seconds)}).`;
        } else {
          answer = `${match.bts_name} went down ${stats.down_incidents} time(s) in the ${periodLabel(days)}.`;
        }

        return res.json({
          success: true, question, intent,
          bts_name: match.bts_name,
          ip_address: match.ip_address,
          answer,
          data: stats,
        });
      }

      default:
        return res.json({
          success: true, question, intent: 'unknown',
          answer: "I couldn't understand the question. Try things like: " +
            "'how many BTS are down', 'uptime percentage for <bts name> last 7 days', " +
            "'how many times is <bts name> down today', 'downtime percentage for <bts name> last 30 days'.",
        });
    }
  } catch (err) { serverError(res, err); }
});

module.exports = router;