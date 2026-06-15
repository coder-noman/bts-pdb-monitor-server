-- ============================================================
--  MIGRATION V2 — Countdown system + Daily Analytics
--  Run this in pgAdmin4 against your existing database.
--  Safe to run even if columns/tables already partly exist.
-- ============================================================

-- ── 1. router_status: remove retries, add countdown ────────
ALTER TABLE router_status DROP COLUMN IF EXISTS retries;
ALTER TABLE router_status ADD COLUMN IF NOT EXISTS countdown SMALLINT NOT NULL DEFAULT 0;

-- ── 2. ping_history: remove retries, add countdown ──────────
ALTER TABLE ping_history DROP COLUMN IF EXISTS retries;
ALTER TABLE ping_history ADD COLUMN IF NOT EXISTS countdown SMALLINT NOT NULL DEFAULT 0;

-- ── 3. daily_summary — one row per router per calendar day ──
CREATE TABLE IF NOT EXISTS daily_summary (
    summary_date   DATE        NOT NULL,
    bts_name       TEXT        NOT NULL,
    ip_address     TEXT        NOT NULL,
    up_seconds     INTEGER     NOT NULL DEFAULT 0,
    down_seconds   INTEGER     NOT NULL DEFAULT 0,
    down_incidents INTEGER     NOT NULL DEFAULT 0,
    uptime_pct     NUMERIC(5,2),
    downtime_pct   NUMERIC(5,2),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (summary_date, ip_address)
);

CREATE INDEX IF NOT EXISTS idx_daily_summary_ip
    ON daily_summary (ip_address, summary_date DESC);

-- ============================================================
--  VERIFY
-- ============================================================
-- SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_name = 'router_status';
-- SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_name = 'ping_history';
-- SELECT * FROM daily_summary LIMIT 5;