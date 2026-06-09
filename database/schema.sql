-- ============================================================
--  Router Monitor — TimescaleDB Schema
--  Run this once in pgAdmin4 against your database
-- ============================================================

-- 1. ROUTERS — master list (import your 160 here)
CREATE TABLE IF NOT EXISTS routers (
    id         SERIAL PRIMARY KEY,
    bts_name   VARCHAR(100) NOT NULL,
    ip_address VARCHAR(45)  NOT NULL UNIQUE,
    created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- 2. ROUTER_STATUS — live / current state (one row per router)
CREATE TABLE IF NOT EXISTS router_status (
    ip_address         VARCHAR(45)  PRIMARY KEY,
    bts_name           VARCHAR(100) NOT NULL,
    up_time            INTEGER      NOT NULL DEFAULT 0,   -- seconds
    down_time          INTEGER      NOT NULL DEFAULT 0,   -- seconds
    up_time_last_24h   INTEGER      NOT NULL DEFAULT 0,   -- seconds
    down_time_last_24h INTEGER      NOT NULL DEFAULT 0,   -- seconds
    status             VARCHAR(10)  NOT NULL DEFAULT 'Unknown',
    retries            SMALLINT     NOT NULL DEFAULT 0,
    updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- 3. PING_HISTORY — TimescaleDB hypertable (every 30s record)
CREATE TABLE IF NOT EXISTS ping_history (
    id                 BIGSERIAL,
    bts_name           VARCHAR(100) NOT NULL,
    ip_address         VARCHAR(45)  NOT NULL,
    up_time            INTEGER      NOT NULL DEFAULT 0,
    down_time          INTEGER      NOT NULL DEFAULT 0,
    up_time_last_24h   INTEGER      NOT NULL DEFAULT 0,
    down_time_last_24h INTEGER      NOT NULL DEFAULT 0,
    status             VARCHAR(10)  NOT NULL,
    retries            SMALLINT     NOT NULL DEFAULT 0,
    checked_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Convert ping_history to TimescaleDB hypertable
-- (chunk by 1 day — efficient for time-series queries)
SELECT create_hypertable(
    'ping_history', 'checked_at',
    chunk_time_interval => INTERVAL '1 day',
    if_not_exists => TRUE
);

-- ── Indexes ────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_ping_history_ip
    ON ping_history (ip_address, checked_at DESC);

CREATE INDEX IF NOT EXISTS idx_ping_history_status
    ON ping_history (status, checked_at DESC);

CREATE INDEX IF NOT EXISTS idx_router_status_status
    ON router_status (status);

-- ============================================================
--  IMPORT YOUR 160 ROUTERS HERE
--  Format: (bts_name, ip_address)
--  Example:
-- ============================================================
/*
INSERT INTO routers (bts_name, ip_address) VALUES
  ('BTS_DHAKA_001',   '192.168.1.1'),
  ('BTS_DHAKA_002',   '192.168.1.2'),
  ('BTS_CHITTAGONG_001', '10.0.0.1'),
  -- ... add all 160 routers
  ('BTS_SYLHET_160',  '172.16.0.160')
ON CONFLICT (ip_address) DO NOTHING;
*/

-- ============================================================
--  USEFUL QUERIES FOR MONITORING / TESTING
-- ============================================================

-- See all live router statuses
-- SELECT * FROM router_status ORDER BY status, bts_name;

-- Count up vs down right now
-- SELECT status, COUNT(*) FROM router_status GROUP BY status;

-- See last 10 ping records for a specific router
-- SELECT * FROM ping_history WHERE ip_address = '192.168.1.1' ORDER BY checked_at DESC LIMIT 10;

-- Average uptime % per router last 24h
-- SELECT
--   ip_address, bts_name,
--   ROUND(up_time_last_24h::numeric / 86400 * 100, 2) AS uptime_pct_24h
-- FROM router_status
-- ORDER BY uptime_pct_24h ASC;

-- Routers currently down with how long they've been down
-- SELECT bts_name, ip_address, down_time, updated_at
-- FROM router_status
-- WHERE status = 'Down'
-- ORDER BY down_time DESC;

-- Full history row count per router
-- SELECT ip_address, bts_name, COUNT(*) AS total_pings
-- FROM ping_history
-- GROUP BY ip_address, bts_name
-- ORDER BY bts_name;

-- History for a router between two dates
-- SELECT * FROM ping_history
-- WHERE ip_address = '192.168.1.1'
--   AND checked_at BETWEEN '2024-01-01' AND '2024-01-02'
-- ORDER BY checked_at DESC;
