// src/server.js — Production Express server + Ping Engine bootstrap

require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const morgan     = require('morgan');
const rateLimit  = require('express-rate-limit');
const { testConnection } = require('./db');
const routerRoutes = require('./routes/routers');
const pingEngine   = require('./pingEngine');

const app  = express();
const PORT = parseInt(process.env.PORT) || 3000;

// ── Middleware ────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// Rate limiter: max 200 requests / 1 minute per IP
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests, slow down.' },
});
app.use('/api', limiter);

// ── Routes ────────────────────────────────────
app.use('/api/routers', routerRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ success: true, uptime: process.uptime(), timestamp: new Date() });
});

// 404 fallback
app.use((req, res) => {
  res.status(404).json({ success: false, error: `Route ${req.method} ${req.path} not found` });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('[SERVER] Unhandled error:', err);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

// ── Graceful shutdown ─────────────────────────
function shutdown(signal) {
  console.log(`\n[SERVER] ${signal} received. Shutting down gracefully...`);
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException',  err => console.error('[SERVER] Uncaught:', err));
process.on('unhandledRejection', err => console.error('[SERVER] Unhandled rejection:', err));

// ── Boot ──────────────────────────────────────
async function boot() {
  console.log('═══════════════════════════════════════');
  console.log('  Router Monitor — Production Server   ');
  console.log('═══════════════════════════════════════');

  const dbOk = await testConnection();
  if (!dbOk) {
    console.error('[SERVER] Cannot connect to database. Exiting.');
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`[SERVER] API listening on http://localhost:${PORT}`);
    console.log(`[SERVER] Environment: ${process.env.NODE_ENV}`);
  });

  // Start ping engine in same process
  await pingEngine.start();
}

boot();