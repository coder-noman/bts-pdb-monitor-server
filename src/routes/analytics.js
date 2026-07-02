// src/routes/analytics.js
// Analytics APIs: per-BTS summary, all-BTS summary, daily breakdown,
// Excel report, daily summary runner, and /ask endpoint.

const express  = require('express');
const router   = express.Router();
const ExcelJS  = require('exceljs');
const { query } = require('../db');
const { formatDuration } = require('../utils');

function serverError(res, err) {
  console.error('[ANALYTICS]', err.message);
  return res.status(500).json({ success: false, error: err.message });
}
function notFound(res, ip) {
  return res.status(404).json({ success: false, error: `Router '${ip}' not found` });
}
function periodToDays(period) {
  if (period === '7d')  return 7;
  if (period === '30d') return 30;
  return 1;
}
function periodLabel(days) {
  if (days === 30) return 'last 30 days';
  if (days === 7)  return 'last 7 days';
  return 'last 24 hours';
}

// ══════════════════════════════════════════════════════════
//  CORE STATS — used by all analytics endpoints
//  Formula:
//    uptime_pct   = (up_seconds   / monitored_seconds) * 100
//    downtime_pct = (down_seconds / monitored_seconds) * 100
//  Note: uses monitored_seconds (not full period_seconds)
//  so gaps from server downtime don't skew percentages.
// ══════════════════════════════════════════════════════════
async function computeStats(ip, days) {
  const statsSQL = `
    SELECT
      COALESCE(SUM(CASE WHEN status = 'Up'   THEN 30 ELSE 0 END), 0) AS up_seconds,
      COALESCE(SUM(CASE WHEN status = 'Down' THEN 30 ELSE 0 END), 0) AS down_seconds
    FROM ping_history
    WHERE ip_address = $1
      AND checked_at >= NOW() - ($2 || ' days')::interval
  `;
  const incidentSQL = `
    WITH d AS (
      SELECT status,
        LAG(status) OVER (ORDER BY checked_at) AS prev_status
      FROM ping_history
      WHERE ip_address = $1
        AND checked_at >= NOW() - ($2 || ' days')::interval
    )
    SELECT COUNT(*) AS cnt
    FROM d
    WHERE status = 'Down' AND prev_status = 'Up'
  `;

  const [statsRes, incidentRes] = await Promise.all([
    query(statsSQL,    [ip, days.toString()]),
    query(incidentSQL, [ip, days.toString()]),
  ]);

  const up_seconds      = parseInt(statsRes.rows[0].up_seconds)   || 0;
  const down_seconds    = parseInt(statsRes.rows[0].down_seconds) || 0;
  const monitored_seconds = up_seconds + down_seconds;
  const down_incidents  = parseInt(incidentRes.rows[0].cnt)       || 0;
  const period_seconds  = days * 86400;

  // ── NEW formula: divide by monitored_seconds not period_seconds ──
  const uptime_pct   = monitored_seconds > 0
    ? Math.round((up_seconds   / monitored_seconds) * 10000) / 100
    : 0;
  const downtime_pct = monitored_seconds > 0
    ? Math.round((down_seconds / monitored_seconds) * 10000) / 100
    : 0;

  return {
    period_days:        days,
    period_seconds,
    up_seconds,
    down_seconds,
    monitored_seconds,
    uptime_pct,
    downtime_pct,
    down_incidents,
  };
}

// ── Same as above but for ALL routers in ONE batch query ─────────────────────
async function computeStatsAllRouters(days) {
  const statsSQL = `
    SELECT
      ip_address,
      COALESCE(SUM(CASE WHEN status = 'Up'   THEN 30 ELSE 0 END), 0) AS up_seconds,
      COALESCE(SUM(CASE WHEN status = 'Down' THEN 30 ELSE 0 END), 0) AS down_seconds
    FROM ping_history
    WHERE checked_at >= NOW() - ($1 || ' days')::interval
    GROUP BY ip_address
  `;
  const incidentSQL = `
    WITH d AS (
      SELECT ip_address, status,
        LAG(status) OVER (PARTITION BY ip_address ORDER BY checked_at) AS prev_status
      FROM ping_history
      WHERE checked_at >= NOW() - ($1 || ' days')::interval
    )
    SELECT ip_address, COUNT(*) AS cnt
    FROM d
    WHERE status = 'Down' AND prev_status = 'Up'
    GROUP BY ip_address
  `;

  const [statsRes, incidentRes] = await Promise.all([
    query(statsSQL,    [days.toString()]),
    query(incidentSQL, [days.toString()]),
  ]);

  const incidentMap = new Map();
  for (const row of incidentRes.rows) {
    incidentMap.set(row.ip_address, parseInt(row.cnt) || 0);
  }

  const period_seconds = days * 86400;
  return statsRes.rows.map(row => {
    const up_seconds      = parseInt(row.up_seconds)   || 0;
    const down_seconds    = parseInt(row.down_seconds) || 0;
    const monitored_seconds = up_seconds + down_seconds;
    const down_incidents  = incidentMap.get(row.ip_address) || 0;

    const uptime_pct   = monitored_seconds > 0
      ? Math.round((up_seconds   / monitored_seconds) * 10000) / 100
      : 0;
    const downtime_pct = monitored_seconds > 0
      ? Math.round((down_seconds / monitored_seconds) * 10000) / 100
      : 0;

    return {
      ip_address: row.ip_address,
      period_days: days,
      period_seconds,
      up_seconds,
      down_seconds,
      monitored_seconds,
      uptime_pct,
      downtime_pct,
      down_incidents,
    };
  });
}

// ══════════════════════════════════════════════════════════
//  1. GET /api/analytics/summary/:ip?period=1d|7d|30d
//  Single BTS analytics
// ══════════════════════════════════════════════════════════
router.get('/analytics/summary/:ip', async (req, res) => {
  const ip   = req.params.ip;
  const days = periodToDays(req.query.period);
  try {
    const check = await query('SELECT bts_name FROM routers WHERE ip_address = $1', [ip]);
    if (check.rowCount === 0) return notFound(res, ip);

    const stats = await computeStats(ip, days);
    res.json({
      success: true,
      bts_name:  check.rows[0].bts_name,
      ip_address: ip,
      ...stats,
      up_time_human:   formatDuration(stats.up_seconds),
      down_time_human: formatDuration(stats.down_seconds),
    });
  } catch (err) { serverError(res, err); }
});

// ══════════════════════════════════════════════════════════
//  2. GET /api/analytics/all?period=1d|7d|30d
//  ALL BTS analytics in one response
// ══════════════════════════════════════════════════════════
router.get('/analytics/all', async (req, res) => {
  const days = periodToDays(req.query.period);
  try {
    // Get all routers
    const routersRes = await query('SELECT bts_name, ip_address FROM routers ORDER BY bts_name');
    if (routersRes.rowCount === 0) {
      return res.json({ success: true, period_days: days, count: 0, data: [] });
    }

    // Get stats for all in batch
    const statsRows = await computeStatsAllRouters(days);
    const statsMap  = new Map(statsRows.map(r => [r.ip_address, r]));

    const data = routersRes.rows.map(r => {
      const stats = statsMap.get(r.ip_address) || {
        period_days: days, period_seconds: days * 86400,
        up_seconds: 0, down_seconds: 0, monitored_seconds: 0,
        uptime_pct: 0, downtime_pct: 0, down_incidents: 0,
      };
      return {
        bts_name:           r.bts_name,
        ip_address:         r.ip_address,
        period_days:        stats.period_days,
        period_seconds:     stats.period_seconds,
        up_seconds:         stats.up_seconds,
        down_seconds:       stats.down_seconds,
        monitored_seconds:  stats.monitored_seconds,
        uptime_pct:         stats.uptime_pct,
        downtime_pct:       stats.downtime_pct,
        down_incidents:     stats.down_incidents,
      };
    });

    res.json({
      success:      true,
      period_days:  days,
      period_label: periodLabel(days),
      count:        data.length,
      data,
    });
  } catch (err) { serverError(res, err); }
});

// ══════════════════════════════════════════════════════════
//  3. GET /api/analytics/report/excel?period=1d|7d|30d
//  Download Excel report for ALL BTS
//  Contains 3 sheets: 1 Day, 7 Days, 30 Days
//  Header: Link3 Technologies LTD / BTS and Power Department
// ══════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════
//  formatDurationHM — "2h 30min" style for Excel cells
// ══════════════════════════════════════════════════════════
function formatDurationHM(seconds) {
  seconds = Math.max(0, Math.round(seconds));
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}min`;
  if (h > 0) return `${h}h ${m}min`;
  if (m > 0) return `${m}min`;
  return `${seconds}s`;
}

// ══════════════════════════════════════════════════════════
//  EXCEL HELPER — builds one single-sheet workbook and
//  streams it to the response.
// ══════════════════════════════════════════════════════════
async function buildAndSendExcel(res, days, routersRes) {
  const statsRows = await computeStatsAllRouters(days);
  const statsMap  = new Map(statsRows.map(r => [r.ip_address, r]));

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Link3 Technologies LTD';
  workbook.created = new Date();

  const reportDate     = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
  const periodLabelStr = days === 1 ? '1 Day' : days === 7 ? '7 Days' : '30 Days';

  // ── Styles ──────────────────────────────────────────────
  const COMPANY_FONT = { name: 'Arial', size: 14, bold: true, color: { argb: 'FFFFFFFF' } };
  const DEPT_FONT    = { name: 'Arial', size: 12, bold: true, color: { argb: 'FFFFFFFF' } };
  const DATE_FONT    = { name: 'Arial', size: 10, italic: true, color: { argb: 'FF333333' } };
  const HEADER_FONT  = { name: 'Arial', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
  const CELL_FONT    = { name: 'Arial', size: 10 };
  const BLUE_FILL    = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1565C0' } };
  const TEAL_FILL    = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF00695C' } };
  const COL_FILL     = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D47A1' } };
  const ODD_FILL     = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F5F5' } };
  const EVEN_FILL    = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } };
  const UP_FILL      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F5E9' } };
  const DOWN_FILL    = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCE4EC' } };
  const CENTER       = { horizontal: 'center', vertical: 'middle' };
  const LEFT         = { horizontal: 'left',   vertical: 'middle' };
  const BORDER       = {
    top:    { style: 'thin', color: { argb: 'FFBDBDBD' } },
    left:   { style: 'thin', color: { argb: 'FFBDBDBD' } },
    bottom: { style: 'thin', color: { argb: 'FFBDBDBD' } },
    right:  { style: 'thin', color: { argb: 'FFBDBDBD' } },
  };

  // ── Column definitions — time shown as "2h 30min" ───────
  const COL_DEFS = [
    { header: '#',              key: 'sl',             width: 5  },
    { header: 'BTS Name',       key: 'bts_name',       width: 42 },
    { header: 'IP Address',     key: 'ip_address',     width: 18 },
    { header: 'Up Time',        key: 'up_time_fmt',    width: 16 },
    { header: 'Down Time',      key: 'down_time_fmt',  width: 16 },
    { header: 'Monitored Time', key: 'monitored_fmt',  width: 18 },
    { header: 'Uptime %',       key: 'uptime_pct',     width: 12 },
    { header: 'Downtime %',     key: 'downtime_pct',   width: 13 },
    { header: 'Down Incidents', key: 'down_incidents', width: 17 },
  ];

  const ws = workbook.addWorksheet(periodLabelStr, {
    pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true },
  });
  ws.columns = COL_DEFS.map(c => ({ key: c.key, width: c.width }));

  // Row 1 — Company name
  ws.mergeCells('A1:I1');
  const r1 = ws.getCell('A1');
  r1.value = 'Link3 Technologies LTD';
  r1.font = COMPANY_FONT; r1.fill = BLUE_FILL; r1.alignment = CENTER;
  ws.getRow(1).height = 28;

  // Row 2 — Department
  ws.mergeCells('A2:I2');
  const r2 = ws.getCell('A2');
  r2.value = 'BTS and Power Department';
  r2.font = DEPT_FONT; r2.fill = TEAL_FILL; r2.alignment = CENTER;
  ws.getRow(2).height = 22;

  // Row 3 — Report info
  ws.mergeCells('A3:I3');
  const r3 = ws.getCell('A3');
  r3.value = `Analytics Report — ${periodLabelStr} Period  |  Generated: ${reportDate}`;
  r3.font = DATE_FONT; r3.alignment = CENTER;
  r3.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE3F2FD' } };
  ws.getRow(3).height = 18;

  // Row 4 — spacer
  ws.getRow(4).height = 6;

  // Row 5 — Column headers
  const headerRow = ws.getRow(5);
  COL_DEFS.forEach((col, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = col.header;
    cell.font = HEADER_FONT; cell.fill = COL_FILL;
    cell.alignment = CENTER; cell.border = BORDER;
  });
  headerRow.height = 20;

  // Rows 6+ — Data rows
  routersRes.rows.forEach((router, idx) => {
    const stats  = statsMap.get(router.ip_address) || {
      up_seconds: 0, down_seconds: 0, monitored_seconds: 0,
      uptime_pct: 0, downtime_pct: 0, down_incidents: 0,
    };
    const isOdd   = idx % 2 === 0;
    const dataRow = ws.getRow(6 + idx);

    const values = {
      sl:             idx + 1,
      bts_name:       router.bts_name,
      ip_address:     router.ip_address,
      up_time_fmt:    formatDurationHM(stats.up_seconds),
      down_time_fmt:  formatDurationHM(stats.down_seconds),
      monitored_fmt:  formatDurationHM(stats.monitored_seconds),
      uptime_pct:     stats.uptime_pct,
      downtime_pct:   stats.downtime_pct,
      down_incidents: stats.down_incidents,
    };

    COL_DEFS.forEach((col, i) => {
      const cell     = dataRow.getCell(i + 1);
      cell.value     = values[col.key];
      cell.font      = { ...CELL_FONT };
      cell.border    = BORDER;
      cell.alignment = (col.key === 'bts_name') ? LEFT : CENTER;

      if (col.key === 'uptime_pct') {
        cell.fill = UP_FILL;
        cell.font = { ...CELL_FONT, color: { argb: 'FF1B5E20' }, bold: true };
      } else if (col.key === 'downtime_pct') {
        cell.fill = DOWN_FILL;
        cell.font = { ...CELL_FONT, color: { argb: 'FFB71C1C' }, bold: true };
      } else {
        cell.fill = isOdd ? ODD_FILL : EVEN_FILL;
      }
    });
    dataRow.height = 18;
  });

  // Summary row
  const sumRowNum = 6 + routersRes.rowCount;
  ws.mergeCells(`A${sumRowNum}:I${sumRowNum}`);
  const sumCell = ws.getCell(`A${sumRowNum}`);
  sumCell.value     = `Total BTS: ${routersRes.rowCount}`;
  sumCell.font      = { name: 'Arial', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
  sumCell.fill      = TEAL_FILL;
  sumCell.alignment = LEFT;
  ws.getRow(sumRowNum).height = 18;

  // Stream to client
  const filename = `BTS_Analytics_${periodLabelStr.replace(' ', '_')}_${new Date().toISOString().slice(0, 10)}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await workbook.xlsx.write(res);
  res.end();
}

// ── 3a. GET /api/analytics/report/excel/1d ──────────────
router.get('/analytics/report/excel/1d', async (req, res) => {
  try {
    const routersRes = await query('SELECT bts_name, ip_address FROM routers ORDER BY bts_name');
    if (routersRes.rowCount === 0)
      return res.status(404).json({ success: false, error: 'No routers found' });
    await buildAndSendExcel(res, 1, routersRes);
  } catch (err) { serverError(res, err); }
});

// ── 3b. GET /api/analytics/report/excel/7d ──────────────
router.get('/analytics/report/excel/7d', async (req, res) => {
  try {
    const routersRes = await query('SELECT bts_name, ip_address FROM routers ORDER BY bts_name');
    if (routersRes.rowCount === 0)
      return res.status(404).json({ success: false, error: 'No routers found' });
    await buildAndSendExcel(res, 7, routersRes);
  } catch (err) { serverError(res, err); }
});

// ── 3c. GET /api/analytics/report/excel/30d ─────────────
router.get('/analytics/report/excel/30d', async (req, res) => {
  try {
    const routersRes = await query('SELECT bts_name, ip_address FROM routers ORDER BY bts_name');
    if (routersRes.rowCount === 0)
      return res.status(404).json({ success: false, error: 'No routers found' });
    await buildAndSendExcel(res, 30, routersRes);
  } catch (err) { serverError(res, err); }
});

// ══════════════════════════════════════════════════════════
//  CORE DAILY JOB — runs automatically every night (see
//  src/scheduler.js) and can still be triggered manually.
//
//  For ONE calendar date, computes and stores:
//    1. daily_summary  — one row per router: totals + %
//    2. daily_events    — one row per Up/Down cycle that
//                          happened on that date (transition
//                          records, same idea as /last-events
//                          but pre-computed & permanent)
//
//  Re-running for the same date is always safe — both tables
//  use ON CONFLICT / DELETE+INSERT so old data is overwritten,
//  never duplicated.
// ══════════════════════════════════════════════════════════
async function runDailyJob(targetDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
    throw new Error('date must be YYYY-MM-DD');
  }

  const startTs = `${targetDate}T00:00:00.000Z`;
  const endTs   = `${targetDate}T23:59:59.999Z`;

  // ── PART A — daily_summary (totals per router) ─────────
  const statsSQL = `
    SELECT ip_address, bts_name,
      COALESCE(SUM(CASE WHEN status = 'Up'   THEN 30 ELSE 0 END), 0) AS up_seconds,
      COALESCE(SUM(CASE WHEN status = 'Down' THEN 30 ELSE 0 END), 0) AS down_seconds
    FROM ping_history
    WHERE checked_at >= $1 AND checked_at <= $2
    GROUP BY ip_address, bts_name
  `;
  const incidentSQL = `
    WITH d AS (
      SELECT ip_address, status,
        LAG(status) OVER (PARTITION BY ip_address ORDER BY checked_at) AS prev_status
      FROM ping_history
      WHERE checked_at >= $1 AND checked_at <= $2
    )
    SELECT ip_address, COUNT(*) AS down_incidents
    FROM d WHERE status = 'Down' AND prev_status = 'Up'
    GROUP BY ip_address
  `;

  const [statsRes, incidentRes] = await Promise.all([
    query(statsSQL,    [startTs, endTs]),
    query(incidentSQL, [startTs, endTs]),
  ]);

  if (statsRes.rowCount === 0) {
    return { date: targetDate, routers_processed: 0, events_stored: 0, message: 'No ping_history data for this date.' };
  }

  const incidentMap = new Map();
  for (const row of incidentRes.rows)
    incidentMap.set(row.ip_address, parseInt(row.down_incidents));

  const sumCols = [
    'summary_date','bts_name','ip_address',
    'up_seconds','down_seconds','down_incidents',
    'uptime_pct','downtime_pct',
  ];
  const sumValuesSql = [];
  const sumParams    = [];

  statsRes.rows.forEach((row, i) => {
    const up_seconds     = parseInt(row.up_seconds);
    const down_seconds   = parseInt(row.down_seconds);
    const monitored      = up_seconds + down_seconds;
    const down_incidents = incidentMap.get(row.ip_address) || 0;
    const uptime_pct     = monitored > 0 ? Math.round((up_seconds   / monitored) * 10000) / 100 : 0;
    const downtime_pct   = monitored > 0 ? Math.round((down_seconds / monitored) * 10000) / 100 : 0;

    const base = i * sumCols.length;
    const placeholders = sumCols.map((_, j) => `$${base + j + 1}`);
    sumValuesSql.push(`(${placeholders.join(',')})`);
    sumParams.push(
      targetDate, row.bts_name, row.ip_address,
      up_seconds, down_seconds, down_incidents,
      uptime_pct, downtime_pct,
    );
  });

  const sumUpsertSQL = `
    INSERT INTO daily_summary (${sumCols.join(',')})
    VALUES ${sumValuesSql.join(',')}
    ON CONFLICT (summary_date, ip_address) DO UPDATE SET
      bts_name       = EXCLUDED.bts_name,
      up_seconds     = EXCLUDED.up_seconds,
      down_seconds   = EXCLUDED.down_seconds,
      down_incidents = EXCLUDED.down_incidents,
      uptime_pct     = EXCLUDED.uptime_pct,
      downtime_pct   = EXCLUDED.downtime_pct
  `;
  await query(sumUpsertSQL, sumParams);

  // ── PART B — daily_events (Up/Down transition cycles) ──
  // Pull the day's raw rows plus 1 row of context before/after
  // so cycles that span midnight still get correct started_at/
  // ended_at. We detect cycle starts (prev status differs) and
  // cycle ends (next status differs), pair them by row order,
  // then keep only cycles that overlap this calendar date.
  const eventsSQL = `
    WITH window_rows AS (
      SELECT bts_name, ip_address, up_time, down_time,
        up_time_last_24h, down_time_last_24h,
        status, countdown, checked_at
      FROM ping_history
      WHERE checked_at >= $1::timestamptz - INTERVAL '1 day'
        AND checked_at <= $2::timestamptz + INTERVAL '1 day'
    ),
    ranked AS (
      SELECT *,
        LAG(status)  OVER (PARTITION BY ip_address ORDER BY checked_at) AS prev_status,
        LEAD(status) OVER (PARTITION BY ip_address ORDER BY checked_at) AS next_status
      FROM window_rows
    ),
    cycle_starts AS (
      SELECT ip_address, checked_at AS started_at,
        ROW_NUMBER() OVER (PARTITION BY ip_address ORDER BY checked_at ASC) AS rn
      FROM ranked
      WHERE prev_status IS NULL OR prev_status <> status
    ),
    cycle_ends AS (
      SELECT bts_name, ip_address, up_time, down_time,
        up_time_last_24h, down_time_last_24h,
        status, countdown, checked_at AS ended_at, next_status,
        ROW_NUMBER() OVER (PARTITION BY ip_address ORDER BY checked_at ASC) AS rn
      FROM ranked
      WHERE next_status IS NULL OR next_status <> status
    )
    SELECT
      ce.bts_name, ce.ip_address,
      ce.up_time, ce.down_time,
      ce.up_time_last_24h, ce.down_time_last_24h,
      ce.status, ce.countdown,
      cs.started_at,
      CASE WHEN ce.next_status IS NULL THEN NULL ELSE ce.ended_at END AS ended_at
    FROM cycle_ends ce
    JOIN cycle_starts cs ON cs.ip_address = ce.ip_address AND cs.rn = ce.rn
    WHERE cs.started_at <= $2::timestamptz
      AND (ce.ended_at IS NULL OR ce.ended_at >= $1::timestamptz)
      AND (ce.next_status IS NOT NULL OR cs.started_at >= $1::timestamptz - INTERVAL '1 day')
    ORDER BY ce.ip_address, cs.started_at ASC
  `;
  const eventsRes = await query(eventsSQL, [startTs, endTs]);

  // Clear old events for this date first (safe re-run), then insert fresh
  await query('DELETE FROM daily_events WHERE event_date = $1', [targetDate]);

  let eventsStored = 0;
  if (eventsRes.rowCount > 0) {
    const evCols = [
      'event_date','bts_name','ip_address',
      'up_time','down_time','up_time_last_24h','down_time_last_24h',
      'status','countdown','started_at','ended_at',
    ];
    const evValuesSql = [];
    const evParams    = [];

    eventsRes.rows.forEach((row, i) => {
      const base = i * evCols.length;
      const placeholders = evCols.map((_, j) => `$${base + j + 1}`);
      evValuesSql.push(`(${placeholders.join(',')})`);
      evParams.push(
        targetDate, row.bts_name, row.ip_address,
        row.up_time, row.down_time, row.up_time_last_24h, row.down_time_last_24h,
        row.status, row.countdown, row.started_at, row.ended_at,
      );
    });

    const evInsertSQL = `INSERT INTO daily_events (${evCols.join(',')}) VALUES ${evValuesSql.join(',')}`;
    await query(evInsertSQL, evParams);
    eventsStored = eventsRes.rowCount;
  }

  return {
    date: targetDate,
    routers_processed: statsRes.rowCount,
    events_stored: eventsStored,
    message: `Daily summary + events computed for ${targetDate}`,
  };
}

// ══════════════════════════════════════════════════════════
//  5. POST /api/analytics/run-daily-summary?date=YYYY-MM-DD
//  Still available for manual use, but no longer required —
//  the scheduler (src/scheduler.js) runs this automatically
//  every night and self-heals missed days on server startup.
// ══════════════════════════════════════════════════════════
router.post('/analytics/run-daily-summary', async (req, res) => {
  try {
    let targetDate = req.query.date;
    if (!targetDate) {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - 1);
      targetDate = d.toISOString().slice(0, 10);
    }
    const result = await runDailyJob(targetDate);
    res.json({ success: true, ...result });
  } catch (err) { serverError(res, err); }
});

// ══════════════════════════════════════════════════════════
//  6. GET /api/analytics/date/:date
//  ALL BTS summary for ONE specific calendar date.
//  Example: GET /api/analytics/date/2026-03-25
// ══════════════════════════════════════════════════════════
router.get('/analytics/date/:date', async (req, res) => {
  const targetDate = req.params.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
    return res.status(400).json({ success: false, error: 'date must be YYYY-MM-DD' });
  }
  try {
    const sql = `
      SELECT bts_name, ip_address,
        up_seconds, down_seconds, down_incidents,
        uptime_pct, downtime_pct
      FROM daily_summary
      WHERE summary_date = $1
      ORDER BY bts_name
    `;
    const result = await query(sql, [targetDate]);

    res.json({
      success: true,
      date:    targetDate,
      count:   result.rowCount,
      data:    result.rows,
    });
  } catch (err) { serverError(res, err); }
});
router.get('/analytics/date/:date/excel', async (req, res) => {
  const targetDate = req.params.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
    return res.status(400).json({ success: false, error: 'date must be YYYY-MM-DD' });
  }
  try {
    const sql = `
      SELECT bts_name, ip_address,
        up_seconds, down_seconds,
        (up_seconds + down_seconds) AS monitored_seconds,
        down_incidents, uptime_pct, downtime_pct
      FROM daily_summary
      WHERE summary_date = $1
      ORDER BY bts_name
    `;
    const result = await query(sql, [targetDate]);
    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, error: `No data for ${targetDate}. Run daily summary first.` });
    }

    const workbook   = new ExcelJS.Workbook();
    workbook.creator = 'Link3 Technologies LTD';
    workbook.created = new Date();

    const reportDate = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
    const dataDate   = new Date(targetDate).toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });

    const COMPANY_FONT = { name: 'Arial', size: 14, bold: true, color: { argb: 'FFFFFFFF' } };
    const DEPT_FONT    = { name: 'Arial', size: 12, bold: true, color: { argb: 'FFFFFFFF' } };
    const DATE_FONT    = { name: 'Arial', size: 10, italic: true, color: { argb: 'FF333333' } };
    const HEADER_FONT  = { name: 'Arial', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
    const CELL_FONT    = { name: 'Arial', size: 10 };
    const BLUE_FILL    = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1565C0' } };
    const TEAL_FILL    = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF00695C' } };
    const COL_FILL     = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D47A1' } };
    const ODD_FILL     = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F5F5' } };
    const EVEN_FILL    = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } };
    const UP_FILL      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F5E9' } };
    const DOWN_FILL    = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCE4EC' } };
    const CENTER = { horizontal: 'center', vertical: 'middle' };
    const LEFT   = { horizontal: 'left',   vertical: 'middle' };
    const BORDER = {
      top:    { style: 'thin', color: { argb: 'FFBDBDBD' } },
      left:   { style: 'thin', color: { argb: 'FFBDBDBD' } },
      bottom: { style: 'thin', color: { argb: 'FFBDBDBD' } },
      right:  { style: 'thin', color: { argb: 'FFBDBDBD' } },
    };

    const COL_DEFS = [
      { header: '#',              key: 'sl',             width: 5  },
      { header: 'BTS Name',       key: 'bts_name',       width: 42 },
      { header: 'IP Address',     key: 'ip_address',     width: 18 },
      { header: 'Up Time',        key: 'up_time_fmt',    width: 16 },
      { header: 'Down Time',      key: 'down_time_fmt',  width: 16 },
      { header: 'Monitored Time', key: 'monitored_fmt',  width: 18 },
      { header: 'Uptime %',       key: 'uptime_pct',     width: 12 },
      { header: 'Downtime %',     key: 'downtime_pct',   width: 13 },
      { header: 'Down Incidents', key: 'down_incidents', width: 17 },
    ];

    const ws = workbook.addWorksheet('Daily Report', {
      pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true },
    });
    ws.columns = COL_DEFS.map(c => ({ key: c.key, width: c.width }));

    ws.mergeCells('A1:I1');
    Object.assign(ws.getCell('A1'), { value: 'Link3 Technologies LTD', font: COMPANY_FONT, fill: BLUE_FILL, alignment: CENTER });
    ws.getRow(1).height = 28;

    ws.mergeCells('A2:I2');
    Object.assign(ws.getCell('A2'), { value: 'BTS and Power Department', font: DEPT_FONT, fill: TEAL_FILL, alignment: CENTER });
    ws.getRow(2).height = 22;

    ws.mergeCells('A3:I3');
    Object.assign(ws.getCell('A3'), {
      value: `Daily Analytics Report  |  Date: ${dataDate}  |  Generated: ${reportDate}`,
      font: DATE_FONT, alignment: CENTER,
      fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE3F2FD' } },
    });
    ws.getRow(3).height = 18;
    ws.getRow(4).height = 6;

    const headerRow = ws.getRow(5);
    COL_DEFS.forEach((col, i) => {
      const cell = headerRow.getCell(i + 1);
      cell.value = col.header;
      cell.font = HEADER_FONT; cell.fill = COL_FILL;
      cell.alignment = CENTER; cell.border = BORDER;
    });
    headerRow.height = 20;

    result.rows.forEach((row, idx) => {
      const isOdd   = idx % 2 === 0;
      const dataRow = ws.getRow(6 + idx);
      const values  = {
        sl:             idx + 1,
        bts_name:       row.bts_name,
        ip_address:     row.ip_address,
        up_time_fmt:    formatDurationHM(parseInt(row.up_seconds)),
        down_time_fmt:  formatDurationHM(parseInt(row.down_seconds)),
        monitored_fmt:  formatDurationHM(parseInt(row.monitored_seconds)),
        uptime_pct:     row.uptime_pct,
        downtime_pct:   row.downtime_pct,
        down_incidents: row.down_incidents,
      };
      COL_DEFS.forEach((col, i) => {
        const cell = dataRow.getCell(i + 1);
        cell.value = values[col.key];
        cell.font = { ...CELL_FONT };
        cell.border = BORDER;
        cell.alignment = (col.key === 'bts_name') ? LEFT : CENTER;
        if (col.key === 'uptime_pct') {
          cell.fill = UP_FILL;
          cell.font = { ...CELL_FONT, color: { argb: 'FF1B5E20' }, bold: true };
        } else if (col.key === 'downtime_pct') {
          cell.fill = DOWN_FILL;
          cell.font = { ...CELL_FONT, color: { argb: 'FFB71C1C' }, bold: true };
        } else {
          cell.fill = isOdd ? ODD_FILL : EVEN_FILL;
        }
      });
      dataRow.height = 18;
    });

    const sumRowNum = 6 + result.rowCount;
    ws.mergeCells(`A${sumRowNum}:I${sumRowNum}`);
    Object.assign(ws.getCell(`A${sumRowNum}`), {
      value: `Total BTS: ${result.rowCount}  |  Date: ${dataDate}`,
      font: { name: 'Arial', size: 10, bold: true, color: { argb: 'FFFFFFFF' } },
      fill: TEAL_FILL, alignment: LEFT,
    });
    ws.getRow(sumRowNum).height = 18;

    const filename = `BTS_Daily_Report_${targetDate}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    await workbook.xlsx.write(res);
    res.end();

  } catch (err) { serverError(res, err); }
});

// ══════════════════════════════════════════════════════════
//  9b. GET /api/analytics/date/:date/:ip/excel
//  Excel report — ONE BTS on a specific date.
//  Shows summary block first, then all events below.
// ══════════════════════════════════════════════════════════
router.get('/analytics/date/:date/:ip/excel', async (req, res) => {
  const targetDate = req.params.date;
  const ip         = req.params.ip;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
    return res.status(400).json({ success: false, error: 'date must be YYYY-MM-DD' });
  }
  try {
    const check = await query('SELECT bts_name FROM routers WHERE ip_address = $1', [ip]);
    if (check.rowCount === 0) return notFound(res, ip);
    const bts_name = check.rows[0].bts_name;

    const summarySQL = `
      SELECT up_seconds, down_seconds, down_incidents, uptime_pct, downtime_pct,
        (up_seconds + down_seconds) AS monitored_seconds
      FROM daily_summary WHERE summary_date = $1 AND ip_address = $2
    `;
    const eventsSQL = `
      SELECT status, countdown, started_at, ended_at,
        up_time, down_time, up_time_last_24h, down_time_last_24h
      FROM daily_events WHERE event_date = $1 AND ip_address = $2
      ORDER BY started_at ASC
    `;
    const [summaryRes, eventsRes] = await Promise.all([
      query(summarySQL, [targetDate, ip]),
      query(eventsSQL,  [targetDate, ip]),
    ]);
    if (summaryRes.rowCount === 0 && eventsRes.rowCount === 0) {
      return res.status(404).json({ success: false, error: `No data for ${ip} on ${targetDate}. Run daily summary first.` });
    }

    const workbook   = new ExcelJS.Workbook();
    workbook.creator = 'Link3 Technologies LTD';
    workbook.created = new Date();

    const reportDate = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
    const dataDate   = new Date(targetDate).toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });

    const COMPANY_FONT  = { name: 'Arial', size: 14, bold: true, color: { argb: 'FFFFFFFF' } };
    const DEPT_FONT     = { name: 'Arial', size: 12, bold: true, color: { argb: 'FFFFFFFF' } };
    const DATE_FONT     = { name: 'Arial', size: 10, italic: true, color: { argb: 'FF333333' } };
    const HEADER_FONT   = { name: 'Arial', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
    const LABEL_FONT    = { name: 'Arial', size: 10, bold: true, color: { argb: 'FF333333' } };
    const VALUE_FONT    = { name: 'Arial', size: 10 };
    const CELL_FONT     = { name: 'Arial', size: 10 };
    const BLUE_FILL     = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1565C0' } };
    const TEAL_FILL     = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF00695C' } };
    const COL_FILL      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D47A1' } };
    const SUMMARY_FILL  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EAF6' } };
    const EVEN_FILL     = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } };
    const UP_ROW_FILL   = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F5E9' } };
    const DOWN_ROW_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCE4EC' } };
    const CENTER = { horizontal: 'center', vertical: 'middle' };
    const LEFT   = { horizontal: 'left',   vertical: 'middle' };
    const BORDER = {
      top:    { style: 'thin', color: { argb: 'FFBDBDBD' } },
      left:   { style: 'thin', color: { argb: 'FFBDBDBD' } },
      bottom: { style: 'thin', color: { argb: 'FFBDBDBD' } },
      right:  { style: 'thin', color: { argb: 'FFBDBDBD' } },
    };

    const ws = workbook.addWorksheet('BTS Daily Report', {
      pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true },
    });
    ws.columns = [
      { width: 5  }, { width: 22 }, { width: 22 },
      { width: 16 }, { width: 16 }, { width: 16 },
      { width: 12 }, { width: 13 }, { width: 17 },
    ];

    // ── Header rows ──
    ws.mergeCells('A1:I1');
    Object.assign(ws.getCell('A1'), { value: 'Link3 Technologies LTD', font: COMPANY_FONT, fill: BLUE_FILL, alignment: CENTER });
    ws.getRow(1).height = 28;

    ws.mergeCells('A2:I2');
    Object.assign(ws.getCell('A2'), { value: 'BTS and Power Department', font: DEPT_FONT, fill: TEAL_FILL, alignment: CENTER });
    ws.getRow(2).height = 22;

    ws.mergeCells('A3:I3');
    Object.assign(ws.getCell('A3'), {
      value: `BTS Daily Report  |  IP: ${ip}  |  Date: ${dataDate}  |  Generated: ${reportDate}`,
      font: DATE_FONT, alignment: CENTER,
      fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE3F2FD' } },
    });
    ws.getRow(3).height = 18;
    ws.getRow(4).height = 6;

    // ── Summary block (rows 5–11) ──
    ws.mergeCells('A5:I5');
    Object.assign(ws.getCell('A5'), {
      value: `BTS: ${bts_name}`,
      font: { name: 'Arial', size: 11, bold: true, color: { argb: 'FFFFFFFF' } },
      fill: TEAL_FILL, alignment: LEFT,
    });
    ws.getRow(5).height = 20;

    const summary = summaryRes.rowCount > 0 ? summaryRes.rows[0] : null;
    const summaryFields = [
      ['Up Time',        summary ? formatDurationHM(parseInt(summary.up_seconds))        : 'N/A'],
      ['Down Time',      summary ? formatDurationHM(parseInt(summary.down_seconds))      : 'N/A'],
      ['Monitored Time', summary ? formatDurationHM(parseInt(summary.monitored_seconds)) : 'N/A'],
      ['Uptime %',       summary ? `${summary.uptime_pct}%`   : 'N/A'],
      ['Downtime %',     summary ? `${summary.downtime_pct}%` : 'N/A'],
      ['Down Incidents', summary ? summary.down_incidents      : 'N/A'],
    ];
    summaryFields.forEach(([label, value], i) => {
      const rowNum = 6 + i;
      ws.mergeCells(`A${rowNum}:D${rowNum}`);
      ws.mergeCells(`E${rowNum}:I${rowNum}`);
      Object.assign(ws.getCell(`A${rowNum}`), { value: label, font: LABEL_FONT, fill: SUMMARY_FILL, alignment: LEFT, border: BORDER });
      Object.assign(ws.getCell(`E${rowNum}`), { value, font: VALUE_FONT, fill: EVEN_FILL, alignment: LEFT, border: BORDER });
      ws.getRow(rowNum).height = 18;
    });

    // Row 12 — spacer between summary and events
    ws.mergeCells('A12:I12');
    ws.getRow(12).height = 10;

    // Row 13 — Events section header
    ws.mergeCells('A13:I13');
    Object.assign(ws.getCell('A13'), {
      value: `Up / Down Events  —  ${dataDate}`,
      font: { name: 'Arial', size: 11, bold: true, color: { argb: 'FFFFFFFF' } },
      fill: TEAL_FILL, alignment: LEFT,
    });
    ws.getRow(13).height = 20;

    // Row 14 — Events column headers
    const evHeaders = ['#', 'Status', 'Started At', 'Ended At', 'Up Time', 'Down Time', 'Up 24h', 'Down 24h', 'Countdown'];
    const evHeaderRow = ws.getRow(14);
    evHeaders.forEach((h, i) => {
      const cell = evHeaderRow.getCell(i + 1);
      cell.value = h;
      cell.font = HEADER_FONT; cell.fill = COL_FILL;
      cell.alignment = CENTER; cell.border = BORDER;
    });
    evHeaderRow.height = 20;

    // Rows 15+ — Event data rows
    if (eventsRes.rowCount === 0) {
      ws.mergeCells('A15:I15');
      Object.assign(ws.getCell('A15'), {
        value: 'No events recorded for this date.',
        font: { name: 'Arial', size: 10, italic: true, color: { argb: 'FF757575' } },
        alignment: CENTER,
      });
      ws.getRow(15).height = 18;
    } else {
      eventsRes.rows.forEach((ev, idx) => {
        const dataRow = ws.getRow(15 + idx);
        const rowFill = ev.status === 'Up' ? UP_ROW_FILL : DOWN_ROW_FILL;
        const evVals  = [
          idx + 1,
          ev.status,
          ev.started_at ? new Date(ev.started_at).toISOString().replace('T', ' ').slice(0, 19) : '',
          ev.ended_at   ? new Date(ev.ended_at).toISOString().replace('T', ' ').slice(0, 19)   : 'Ongoing',
          formatDurationHM(parseInt(ev.up_time)              || 0),
          formatDurationHM(parseInt(ev.down_time)            || 0),
          formatDurationHM(parseInt(ev.up_time_last_24h)     || 0),
          formatDurationHM(parseInt(ev.down_time_last_24h)   || 0),
          ev.countdown,
        ];
        evVals.forEach((val, i) => {
          const cell = dataRow.getCell(i + 1);
          cell.value = val; cell.font = { ...CELL_FONT };
          cell.fill = rowFill; cell.border = BORDER; cell.alignment = CENTER;
        });
        dataRow.height = 18;
      });
    }

    const filename = `BTS_Report_${ip}_${targetDate}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    await workbook.xlsx.write(res);
    res.end();

  } catch (err) { serverError(res, err); }
});
router.get('/analytics/date/:date/:ip', async (req, res) => {
  const targetDate = req.params.date;
  const ip = req.params.ip;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
    return res.status(400).json({ success: false, error: 'date must be YYYY-MM-DD' });
  }
  try {
    const check = await query('SELECT bts_name FROM routers WHERE ip_address = $1', [ip]);
    if (check.rowCount === 0) return notFound(res, ip);

    const summarySQL = `
      SELECT up_seconds, down_seconds, down_incidents, uptime_pct, downtime_pct
      FROM daily_summary
      WHERE summary_date = $1 AND ip_address = $2
    `;
    const eventsSQL = `
      SELECT bts_name, ip_address,
        up_time, down_time, up_time_last_24h, down_time_last_24h,
        status, countdown, started_at, ended_at
      FROM daily_events
      WHERE event_date = $1 AND ip_address = $2
      ORDER BY started_at ASC
    `;

    const [summaryRes, eventsRes] = await Promise.all([
      query(summarySQL, [targetDate, ip]),
      query(eventsSQL,  [targetDate, ip]),
    ]);

    res.json({
      success:    true,
      bts_name:   check.rows[0].bts_name,
      ip_address: ip,
      date:       targetDate,
      summary:    summaryRes.rowCount > 0 ? summaryRes.rows[0] : null,
      events:     eventsRes.rows,
    });
  } catch (err) { serverError(res, err); }
});

// ══════════════════════════════════════════════════════════
//  8. GET /api/analytics/range/:ip?start=YYYY-MM-DD&end=YYYY-MM-DD
//  ONE BTS's daily summaries across a custom date range.
//  Replaces the old /analytics/daily-breakdown endpoint.
//  Example: /api/analytics/range/10.200.205.162?start=2026-02-12&end=2026-06-28
// ══════════════════════════════════════════════════════════
router.get('/analytics/range/:ip', async (req, res) => {
  const ip = req.params.ip;
  const { start, end } = req.query;

  if (!start || !end ||
      !/^\d{4}-\d{2}-\d{2}$/.test(start) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    return res.status(400).json({
      success: false,
      error: 'Both start and end query params are required, format YYYY-MM-DD',
    });
  }

  try {
    const check = await query('SELECT bts_name FROM routers WHERE ip_address = $1', [ip]);
    if (check.rowCount === 0) return notFound(res, ip);

    const sql = `
      SELECT summary_date,
        up_seconds, down_seconds, down_incidents,
        uptime_pct, downtime_pct
      FROM daily_summary
      WHERE ip_address = $1
        AND summary_date BETWEEN $2 AND $3
      ORDER BY summary_date ASC
    `;
    const result = await query(sql, [ip, start, end]);

    // ── Totals across the whole range ──
    const totalUp   = result.rows.reduce((sum, r) => sum + r.up_seconds, 0);
    const totalDown = result.rows.reduce((sum, r) => sum + r.down_seconds, 0);
    const totalMon  = totalUp + totalDown;
    const totalIncidents = result.rows.reduce((sum, r) => sum + r.down_incidents, 0);

    res.json({
      success:    true,
      bts_name:   check.rows[0].bts_name,
      ip_address: ip,
      start, end,
      days_found: result.rowCount,
      totals: {
        up_seconds:     totalUp,
        down_seconds:   totalDown,
        monitored_seconds: totalMon,
        uptime_pct:     totalMon > 0 ? Math.round((totalUp   / totalMon) * 10000) / 100 : 0,
        downtime_pct:   totalMon > 0 ? Math.round((totalDown / totalMon) * 10000) / 100 : 0,
        down_incidents: totalIncidents,
      },
      days: result.rows,
    });
  } catch (err) { serverError(res, err); }
});

// ══════════════════════════════════════════════════════════
//  9a. GET /api/analytics/date/:date/excel
//  Excel report — ALL BTS for one specific date.
//  Same design as analytics page + date shown in header.
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
  return 1;
}
function findRouterMatch(question, routers) {
  const q = question.toLowerCase();
  const ipMatch = q.match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
  if (ipMatch) {
    const found = routers.find(r => r.ip_address === ipMatch[0]);
    if (found) return found;
  }
  let best = null, bestScore = 0;
  for (const r of routers) {
    const tokens = r.bts_name.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 2);
    let score = 0;
    for (const t of tokens) if (q.includes(t)) score++;
    if (score > bestScore) { bestScore = score; best = r; }
  }
  return bestScore > 0 ? best : null;
}

router.post('/ask', async (req, res) => {
  const question = (req.body.question || '').trim();
  if (!question)
    return res.status(400).json({ success: false, error: '"question" field is required' });

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
        const answer = result.rowCount === 0
          ? 'All routers are currently Up. No routers are down.'
          : `${result.rowCount} router(s) are currently Down:\n` +
            result.rows.map(r => `- ${r.bts_name} (${r.ip_address}) — down for ${formatDuration(r.down_time)}`).join('\n');
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
        const answer = result.rowCount === 0
          ? 'No routers are currently Up.'
          : `${result.rowCount} router(s) are currently Up.`;
        return res.json({ success: true, question, intent, answer, data: result.rows });
      }
      case 'uptime_pct':
      case 'downtime_pct':
      case 'down_incidents': {
        const routersRes = await query('SELECT bts_name, ip_address FROM routers');
        const match = findRouterMatch(question, routersRes.rows);
        if (!match) {
          return res.json({
            success: true, question, intent,
            answer: "I couldn't identify which router/BTS you're asking about. Please include the BTS name or IP address.",
            data: null,
          });
        }
        const stats  = await computeStats(match.ip_address, days);
        let answer;
        if (intent === 'uptime_pct')
          answer = `${match.bts_name} had ${stats.uptime_pct}% uptime over the ${periodLabel(days)} (${formatDuration(stats.up_seconds)} up out of ${formatDuration(stats.monitored_seconds)} monitored).`;
        else if (intent === 'downtime_pct')
          answer = `${match.bts_name} had ${stats.downtime_pct}% downtime over the ${periodLabel(days)} (${formatDuration(stats.down_seconds)} down out of ${formatDuration(stats.monitored_seconds)} monitored).`;
        else
          answer = `${match.bts_name} went down ${stats.down_incidents} time(s) in the ${periodLabel(days)}.`;
        return res.json({
          success: true, question, intent,
          bts_name: match.bts_name, ip_address: match.ip_address,
          answer, data: stats,
        });
      }
      default:
        return res.json({
          success: true, question, intent: 'unknown',
          answer: "I couldn't understand the question. Try: 'how many BTS are down', 'uptime % for <name> last 7 days', 'how many times is <name> down today', 'downtime % for <name> last 30 days'.",
        });
    }
  } catch (err) { serverError(res, err); }
});

module.exports = router;
module.exports.runDailyJob = runDailyJob;