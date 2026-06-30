-- ============================================================
--  MIGRATION V3 — daily_events table
--  Run this in pgAdmin4 against your existing database.
--  This stores pre-computed Up/Down cycle events per calendar
--  date, so the "click a BTS on a date" API is instant instead
--  of scanning raw ping_history.
-- ============================================================

CREATE TABLE IF NOT EXISTS daily_events (
    id                  BIGSERIAL    PRIMARY KEY,
    event_date          DATE         NOT NULL,
    bts_name            TEXT         NOT NULL,
    ip_address          TEXT         NOT NULL,
    up_time             INTEGER      NOT NULL DEFAULT 0,
    down_time           INTEGER      NOT NULL DEFAULT 0,
    up_time_last_24h    INTEGER      NOT NULL DEFAULT 0,
    down_time_last_24h  INTEGER      NOT NULL DEFAULT 0,
    status              TEXT         NOT NULL,
    countdown           SMALLINT     NOT NULL DEFAULT 0,
    started_at          TIMESTAMPTZ  NOT NULL,
    ended_at            TIMESTAMPTZ,           -- NULL only possible for events
                                                 -- still ongoing at time of computation
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_daily_events_date_ip
    ON daily_events (event_date, ip_address);

CREATE INDEX IF NOT EXISTS idx_daily_events_ip
    ON daily_events (ip_address, event_date DESC);

-- ============================================================
--  VERIFY
-- ============================================================
-- SELECT COUNT(*) FROM daily_events;
-- SELECT * FROM daily_events WHERE event_date = '2026-03-25' LIMIT 10;
