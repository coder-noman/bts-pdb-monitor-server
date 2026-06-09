# Router Monitor — Production System
**Node.js + Express + TimescaleDB | ICMP Ping Engine | 160 Routers**

---

## SYSTEM OVERVIEW

```
┌─────────────────────────────────────────────────────┐
│                  PING ENGINE                        │
│  Every 30s → Loads 160 routers from DB             │
│  → Splits into batches of 40                       │
│  → Pings each (1st try) → Up? Store it             │
│  → Not responding? Retry up to 3 times            │
│  → Still no response? Mark Down                   │
│  → Writes to router_status + ping_history         │
└─────────────────────────────────────────────────────┘
          ↓ writes every 30s
┌─────────────────────────────────────────────────────┐
│              TimescaleDB                           │
│  routers         — master list of 160 routers      │
│  router_status   — live current state (1 row/router)│
│  ping_history    — full time-series history        │
└─────────────────────────────────────────────────────┘
          ↑ reads
┌─────────────────────────────────────────────────────┐
│              Express REST API                      │
│  Port 3000 — all endpoints below                  │
└─────────────────────────────────────────────────────┘
```

---

## STEP 1 — PREREQUISITES

Make sure you have:
- Node.js 18+ installed
- PostgreSQL with TimescaleDB extension installed
- pgAdmin4 (already installed)
- npm (already installed)

---

## STEP 2 — SETUP DATABASE

1. Open **pgAdmin4**
2. Create a new database named `router_monitor`
3. Open the Query Tool for that database
4. Run the entire file: `database/schema.sql`
5. After schema is created, add your 160 routers:

```sql
INSERT INTO routers (bts_name, ip_address) VALUES
  ('BTS_DHAKA_001',   '192.168.1.1'),
  ('BTS_DHAKA_002',   '192.168.1.2'),
  ('BTS_DHAKA_003',   '192.168.1.3'),
  -- ... all 160 routers ...
  ('BTS_SITE_160',    '10.0.0.160')
ON CONFLICT (ip_address) DO NOTHING;
```

Verify:
```sql
SELECT COUNT(*) FROM routers;  -- should return 160
```

---

## STEP 3 — CONFIGURE ENVIRONMENT

Edit `.env` file in the project root:

```env
DB_HOST=localhost
DB_PORT=5432
DB_NAME=router_monitor
DB_USER=postgres
DB_PASSWORD=YOUR_ACTUAL_PASSWORD

PORT=3000
NODE_ENV=production

PING_INTERVAL_MS=30000
PING_BATCH_SIZE=40
PING_MAX_RETRIES=3
PING_TIMEOUT_MS=3000
```

---

## STEP 4 — INSTALL DEPENDENCIES

Open Command Prompt in the project folder:

```cmd
cd router-monitor
npm install
```

---

## STEP 5 — RUN THE SERVER

```cmd
node src/server.js
```

You will see:
```
═══════════════════════════════════════
  Router Monitor — Production Server
═══════════════════════════════════════
[DB] Connected to TimescaleDB at 2024-...
[SERVER] API listening on http://localhost:3000
[PING ENGINE] Starting...
  Interval : 30s
  Batch    : 40 routers
  Retries  : 3
  Timeout  : 3s per ping
[PING ENGINE] ── Cycle start | 160 routers | ...
[PING ENGINE] Batch 1/4 | 40 routers
✔ BTS_DHAKA_001 (192.168.1.1) | status=Up | up=30s | down=0s | retries=0
✘ BTS_DHAKA_002 (192.168.1.2) | status=Down | up=0s | down=30s | retries=3
...
[PING ENGINE] ── Cycle done in 4.2s
```

---

## STEP 6 — RUN AS BACKGROUND SERVICE (Windows, Production)

Install PM2 globally:
```cmd
npm install -g pm2
pm2 start src/server.js --name router-monitor
pm2 startup   ← auto-start on Windows boot
pm2 save
```

Useful PM2 commands:
```cmd
pm2 status              ← check if running
pm2 logs router-monitor ← live logs
pm2 restart router-monitor
pm2 stop router-monitor
```

---

## API REFERENCE

Base URL: `http://localhost:3000`

### All data fields returned:
| Field | Description |
|-------|-------------|
| `bts_name` | Tower/router name |
| `ip_address` | Router IP |
| `up_time` | Cumulative uptime in current streak (seconds) |
| `down_time` | Cumulative downtime in current streak (seconds) |
| `up_time_last_24h` | Total up seconds in last 24 hours |
| `down_time_last_24h` | Total down seconds in last 24 hours |
| `status` | `Up` or `Down` |
| `retries` | Ping retry count (0–3) in last cycle |

---

### 1. GET all routers with live status
```
GET /api/routers
```
**Response:**
```json
{
  "success": true,
  "count": 160,
  "data": [
    {
      "bts_name": "BTS_DHAKA_001",
      "ip_address": "192.168.1.1",
      "up_time": 3600,
      "down_time": 0,
      "up_time_last_24h": 82800,
      "down_time_last_24h": 3600,
      "status": "Up",
      "retries": 0,
      "updated_at": "2024-01-15T10:30:00Z"
    }
  ]
}
```

---

### 2. POST add a new router
```
POST /api/routers
Content-Type: application/json

{
  "bts_name": "BTS_NEW_SITE",
  "ip_address": "192.168.5.50"
}
```

---

### 3. GET specific router
```
GET /api/routers/192.168.1.1
```

---

### 4. PUT update a router
```
PUT /api/routers/192.168.1.1
Content-Type: application/json

{
  "bts_name": "BTS_DHAKA_001_UPDATED"
}
```

---

### 5. DELETE a router
```
DELETE /api/routers/192.168.1.1
```
Deletes the router AND all its history from ping_history.

---

### 6. GET full history of one router (paginated)
```
GET /api/routers/192.168.1.1/history
GET /api/routers/192.168.1.1/history?limit=500&page=2
```
**Response includes:** total records, pages, current page.
Default: 1000 records per page.

---

### 7. GET current DOWN list
```
GET /api/routers/status/down
```
Returns all routers currently with status = Down, sorted by longest downtime first.

---

### 8. GET current UP list
```
GET /api/routers/status/up
```
Returns all routers currently with status = Up, sorted by longest uptime first.

---

### 9. Health check
```
GET /health
```
```json
{ "success": true, "uptime": 3600.5, "timestamp": "..." }
```

---

## LOGIC EXPLAINED

### upTime / downTime (cumulative streak)
- Every 30s cycle: if **Up** → `upTime += 30`, `downTime = 0`
- Every 30s cycle: if **Down** → `downTime += 30`, `upTime = 0`
- Example: 5 consecutive Up pings → upTime = 150s
- Then 1 Down ping → upTime = 0, downTime = 30s

### up_time_last_24h / down_time_last_24h
- Calculated from `ping_history` table
- Queries all records in last 24 hours for that IP
- Sums: each "Up" record = 30s, each "Down" record = 30s
- Resets naturally as old records fall out of the 24h window

### Status = Down (when?)
- Only marked Down after ALL 3 retries fail
- If 1st or 2nd retry succeeds → marked Up, retries stored

### retries field
- 0 = responded on first ping
- 1 = responded on 2nd attempt
- 2 = responded on 3rd attempt
- 3 = all failed → Down

---

## USEFUL SQL QUERIES (run in pgAdmin4)

```sql
-- Live overview: how many up vs down right now
SELECT status, COUNT(*) as count FROM router_status GROUP BY status;

-- Top 10 routers with most downtime today
SELECT bts_name, ip_address, down_time_last_24h
FROM router_status
ORDER BY down_time_last_24h DESC
LIMIT 10;

-- Uptime % per router in last 24h
SELECT bts_name, ip_address,
  ROUND(up_time_last_24h::numeric / 86400 * 100, 2) AS uptime_pct
FROM router_status ORDER BY uptime_pct ASC;

-- Total ping records stored
SELECT COUNT(*) FROM ping_history;

-- Ping records for last 1 hour for one router
SELECT status, retries, checked_at
FROM ping_history
WHERE ip_address = '192.168.1.1'
  AND checked_at >= NOW() - INTERVAL '1 hour'
ORDER BY checked_at DESC;

-- Find routers that have been down more than 5 minutes
SELECT bts_name, ip_address, down_time
FROM router_status
WHERE status = 'Down' AND down_time >= 300
ORDER BY down_time DESC;
```

---

## TROUBLESHOOTING

| Problem | Fix |
|---------|-----|
| `Cannot connect to database` | Check .env credentials, ensure Postgres is running |
| `ping: not found` | Run `npm install` again |
| All routers showing Down | Check Windows Firewall — ICMP may be blocked |
| API not responding | Check PORT in .env, check if server started |
| `EACCES` error on ping | Run Command Prompt as Administrator |

---

## PROJECT STRUCTURE

```
router-monitor/
├── src/
│   ├── server.js          ← Express server + boots ping engine
│   ├── db.js              ← DB connection pool
│   ├── pingEngine.js      ← Core ping logic
│   └── routes/
│       └── routers.js     ← All API endpoints
├── database/
│   └── schema.sql         ← Run this in pgAdmin4 first
├── .env                   ← Your config (edit this)
├── package.json
└── README.md
```
