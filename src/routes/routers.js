// src/routes/routers.js — Core router CRUD + status APIs

const express = require('express');
const router  = express.Router();
const { query } = require('../db');

function notFound(res, ip) {
  return res.status(404).json({ success: false, error: `Router '${ip}' not found` });
}
function serverError(res, err) {
  console.error('[API]', err.message);
  return res.status(500).json({ success: false, error: err.message });
}

// 1. GET /api/routers/status/down
router.get('/status/down', async (req, res) => {
  try {
    const sql = `
      SELECT r.bts_name, r.ip_address,
        s.up_time, s.down_time,
        s.up_time_last_24h, s.down_time_last_24h,
        s.status, s.countdown, s.updated_at
      FROM routers r
      JOIN router_status s ON r.ip_address = s.ip_address
      WHERE s.status = 'Down'
      ORDER BY s.down_time DESC
    `;
    const result = await query(sql);
    res.json({ success: true, count: result.rowCount, data: result.rows });
  } catch (err) { serverError(res, err); }
});

// 2. GET /api/routers/status/up
router.get('/status/up', async (req, res) => {
  try {
    const sql = `
      SELECT r.bts_name, r.ip_address,
        s.up_time, s.down_time,
        s.up_time_last_24h, s.down_time_last_24h,
        s.status, s.countdown, s.updated_at
      FROM routers r
      JOIN router_status s ON r.ip_address = s.ip_address
      WHERE s.status = 'Up'
      ORDER BY s.up_time DESC
    `;
    const result = await query(sql);
    res.json({ success: true, count: result.rowCount, data: result.rows });
  } catch (err) { serverError(res, err); }
});

// 3. GET /api/routers — All routers
router.get('/', async (req, res) => {
  try {
    const sql = `
      SELECT r.bts_name, r.ip_address,
        COALESCE(s.up_time,            0) AS up_time,
        COALESCE(s.down_time,          0) AS down_time,
        COALESCE(s.up_time_last_24h,   0) AS up_time_last_24h,
        COALESCE(s.down_time_last_24h, 0) AS down_time_last_24h,
        COALESCE(s.status,       'Unknown') AS status,
        COALESCE(s.countdown,          0) AS countdown,
        s.updated_at
      FROM routers r
      LEFT JOIN router_status s ON r.ip_address = s.ip_address
      ORDER BY r.bts_name
    `;
    const result = await query(sql);
    res.json({ success: true, count: result.rowCount, data: result.rows });
  } catch (err) { serverError(res, err); }
});

// 4. POST /api/routers — Add router
router.post('/', async (req, res) => {
  const { bts_name, ip_address } = req.body;
  if (!bts_name || !ip_address)
    return res.status(400).json({ success: false, error: 'bts_name and ip_address are required' });
  const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
  if (!ipRegex.test(ip_address))
    return res.status(400).json({ success: false, error: 'Invalid IP address format' });
  try {
    const sql = `
      INSERT INTO routers (bts_name, ip_address) VALUES ($1, $2)
      ON CONFLICT (ip_address) DO NOTHING RETURNING *
    `;
    const result = await query(sql, [bts_name.trim(), ip_address.trim()]);
    if (result.rowCount === 0)
      return res.status(409).json({ success: false, error: `IP ${ip_address} already exists` });
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) { serverError(res, err); }
});

// 5. GET /api/routers/:ip/history
router.get('/:ip/history', async (req, res) => {
  const ip     = req.params.ip;
  const limit  = parseInt(req.query.limit) || 1000;
  const page   = parseInt(req.query.page)  || 1;
  const offset = (page - 1) * limit;
  try {
    const check = await query('SELECT bts_name FROM routers WHERE ip_address = $1', [ip]);
    if (check.rowCount === 0) return notFound(res, ip);
    const countRes = await query('SELECT COUNT(*) AS total FROM ping_history WHERE ip_address = $1', [ip]);
    const total = parseInt(countRes.rows[0].total);
    const sql = `
      SELECT bts_name, ip_address, up_time, down_time,
        up_time_last_24h, down_time_last_24h,
        status, countdown, checked_at
      FROM ping_history
      WHERE ip_address = $1
      ORDER BY checked_at DESC
      LIMIT $2 OFFSET $3
    `;
    const result = await query(sql, [ip, limit, offset]);
    res.json({
      success: true,
      bts_name: check.rows[0].bts_name,
      ip_address: ip,
      total, page, limit,
      pages: Math.ceil(total / limit),
      data: result.rows,
    });
  } catch (err) { serverError(res, err); }
});

// 9. GET /api/routers/:ip/last-events
// Returns a list of every cycle (continuous Up streak or Down streak)
// with started_at and ended_at (ended_at is null for the ongoing cycle).
router.get('/:ip/last-events', async (req, res) => {
  const ip   = req.params.ip;
  const limit  = parseInt(req.query.limit) || 300;
  const page   = parseInt(req.query.page)  || 1;
  const offset = (page - 1) * limit;

  try {
    const check = await query('SELECT bts_name FROM routers WHERE ip_address = $1', [ip]);
    if (check.rowCount === 0) return notFound(res, ip);
    const bts_name = check.rows[0].bts_name;

    // ── Count total cycles ──────────────────────────────
    // A "cycle" starts wherever the status differs from the
    // previous row (or it's the very first row ever).
    const countSQL = `
      WITH ranked AS (
        SELECT status,
          LAG(status) OVER (ORDER BY checked_at ASC) AS prev_status
        FROM ping_history
        WHERE ip_address = $1
      )
      SELECT COUNT(*) AS total
      FROM ranked
      WHERE prev_status IS NULL OR prev_status <> status
    `;
    const countRes = await query(countSQL, [ip]);
    const total = parseInt(countRes.rows[0].total);

    // ── Group every consecutive same-status streak into one ──
    // ── cycle (the "gaps and islands" technique) — this is a ──
    // ── single self-contained calculation, so every cycle ─────
    // ── (first or last, Up or Down) is always captured ────────
    // ── correctly, with no separate lists that could ever ─────
    // ── fall out of sync with each other. ──────────────────────
    const sql = `
      WITH ranked AS (
        SELECT bts_name, ip_address, up_time, down_time,
          up_time_last_24h, down_time_last_24h,
          status, countdown, checked_at,
          LAG(status) OVER (ORDER BY checked_at ASC) AS prev_status
        FROM ping_history
        WHERE ip_address = $1
      ),
      grouped AS (
        SELECT *,
          SUM(CASE WHEN prev_status IS NULL OR prev_status <> status THEN 1 ELSE 0 END)
            OVER (ORDER BY checked_at ASC) AS grp
        FROM ranked
      ),
      cycles AS (
        SELECT
          bts_name, ip_address, status, grp,
          MIN(checked_at) AS started_at,
          MAX(checked_at) AS last_seen_at,
          (ARRAY_AGG(up_time            ORDER BY checked_at DESC))[1] AS up_time,
          (ARRAY_AGG(down_time          ORDER BY checked_at DESC))[1] AS down_time,
          (ARRAY_AGG(up_time_last_24h   ORDER BY checked_at DESC))[1] AS up_time_last_24h,
          (ARRAY_AGG(down_time_last_24h ORDER BY checked_at DESC))[1] AS down_time_last_24h,
          (ARRAY_AGG(countdown          ORDER BY checked_at DESC))[1] AS countdown
        FROM grouped
        GROUP BY bts_name, ip_address, status, grp
      )
      SELECT
        bts_name, ip_address, up_time, down_time,
        up_time_last_24h, down_time_last_24h, status, countdown,
        started_at,
        CASE WHEN grp = MAX(grp) OVER () THEN NULL ELSE last_seen_at END AS ended_at
      FROM cycles
      ORDER BY grp DESC
      LIMIT $2 OFFSET $3
    `;
    const result = await query(sql, [ip, limit, offset]);

    // ── Build final cycle objects ────────────────────────
    const cycles = result.rows.map(row => ({
      bts_name:           row.bts_name,
      ip_address:         row.ip_address,
      up_time:            row.up_time,
      down_time:          row.down_time,
      up_time_last_24h:   row.up_time_last_24h,
      down_time_last_24h: row.down_time_last_24h,
      status:             row.status,
      countdown:          row.countdown,
      started_at:         row.started_at,
      ended_at:           row.ended_at,
    }));

    res.json({
      success: true,
      bts_name,
      ip_address: ip,
      total, page, limit,
      pages: Math.ceil(total / limit),
      cycles,
    });
  } catch (err) { serverError(res, err); }
});

// 6. GET /api/routers/:ip — Single router
router.get('/:ip', async (req, res) => {
  const ip = req.params.ip;
  try {
    const sql = `
      SELECT r.bts_name, r.ip_address,
        COALESCE(s.up_time,            0) AS up_time,
        COALESCE(s.down_time,          0) AS down_time,
        COALESCE(s.up_time_last_24h,   0) AS up_time_last_24h,
        COALESCE(s.down_time_last_24h, 0) AS down_time_last_24h,
        COALESCE(s.status,       'Unknown') AS status,
        COALESCE(s.countdown,          0) AS countdown,
        s.updated_at
      FROM routers r
      LEFT JOIN router_status s ON r.ip_address = s.ip_address
      WHERE r.ip_address = $1
    `;
    const result = await query(sql, [ip]);
    if (result.rowCount === 0) return notFound(res, ip);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { serverError(res, err); }
});

// 7. PUT /api/routers/:ip — Update router
router.put('/:ip', async (req, res) => {
  const ip = req.params.ip;
  const { bts_name, ip_address: newIp } = req.body;
  if (!bts_name && !newIp)
    return res.status(400).json({ success: false, error: 'Provide bts_name or ip_address to update' });
  try {
    const check = await query('SELECT id FROM routers WHERE ip_address = $1', [ip]);
    if (check.rowCount === 0) return notFound(res, ip);
    const updates = [];
    const vals    = [];
    let idx = 1;
    if (bts_name) { updates.push(`bts_name = $${idx++}`);   vals.push(bts_name.trim()); }
    if (newIp)    { updates.push(`ip_address = $${idx++}`); vals.push(newIp.trim()); }
    vals.push(ip);
    const sql = `UPDATE routers SET ${updates.join(', ')} WHERE ip_address = $${idx} RETURNING *`;
    const result = await query(sql, vals);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { serverError(res, err); }
});

// 8. DELETE /api/routers/:ip — Delete router + history
router.delete('/:ip', async (req, res) => {
  const ip = req.params.ip;
  try {
    const check = await query('SELECT id FROM routers WHERE ip_address = $1', [ip]);
    if (check.rowCount === 0) return notFound(res, ip);
    await query('DELETE FROM ping_history  WHERE ip_address = $1', [ip]);
    await query('DELETE FROM router_status WHERE ip_address = $1', [ip]);
    await query('DELETE FROM routers       WHERE ip_address = $1', [ip]);
    await query('DELETE FROM daily_summary WHERE ip_address = $1', [ip]);
    res.json({ success: true, message: `Router ${ip} and all its history deleted` });
  } catch (err) { serverError(res, err); }
});

module.exports = router;