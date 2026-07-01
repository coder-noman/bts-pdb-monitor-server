Router CRUD & Status
GET     http://localhost:3000/api/routers
POST    http://localhost:3000/api/routers
GET     http://localhost:3000/api/routers/10.200.205.162
PUT     http://localhost:3000/api/routers/10.200.205.162
DELETE  http://localhost:3000/api/routers/10.200.205.162
GET     http://localhost:3000/api/routers/status/down
GET     http://localhost:3000/api/routers/status/up
GET     http://localhost:3000/api/routers/10.200.205.162/history
GET     http://localhost:3000/api/routers/10.200.205.162/history?limit=500&page=2
GET     http://localhost:3000/api/routers/10.200.205.162/last-events
GET     http://localhost:3000/api/routers/10.200.205.162/last-events?limit=50&page=1

For Excel Report 
GET     http://localhost:3000/api/analytics/report/excel/1d
GET     http://localhost:3000/api/analytics/report/excel/7d
GET     http://localhost:3000/api/analytics/report/excel/30d

Analytics & Reporting
GET     http://localhost:3000/api/analytics/all?period=1d
GET     http://localhost:3000/api/analytics/all?period=7d
GET     http://localhost:3000/api/analytics/all?period=30d

GET     http://localhost:3000/api/analytics/summary/10.200.205.162?period=1d
GET     http://localhost:3000/api/analytics/summary/10.200.205.162?period=7d
GET     http://localhost:3000/api/analytics/summary/10.200.205.162?period=30d

POST    http://localhost:3000/api/analytics/run-daily-summary
POST    http://localhost:3000/api/analytics/run-daily-summary?date=2026-06-08

GET     http://localhost:3000/api/analytics/daily-breakdown/10.200.205.162?days=7
GET     http://localhost:3000/api/analytics/daily-breakdown/10.200.205.162?days=30


Date Wise Analytics
http://localhost:3000/api/analytics/date/2026-06-16
http://localhost:3000/api/analytics/date/2026-06-16/10.200.205.2
http://localhost:3000/api/analytics/range/10.200.205.2?start=2026-06-15&end=2026-06-16

Natural Language Query
POST    http://localhost:3000/api/ask
Body (JSON): { "question": "how many BTS are down right now?" }
System
GET     http://localhost:3000/health

POST Examples (request body)
Add a router:
POST http://localhost:3000/api/routers
Content-Type: application/json

{
  "bts_name": "Dhaka-Banani-BTS-Ahmed Tower (L3)",
  "ip_address": "10.200.205.62"
}
Ask a question:
POST http://localhost:3000/api/ask
Content-Type: application/json

{
  "question": "uptime percentage for Ahmed Tower last 7 days"
}
Run daily summary:
POST http://localhost:3000/api/analytics/run-daily-summary?date=2026-06-08
(No body needed)





















TRUNCATE TABLE ping_history, router_status, daily_summary;