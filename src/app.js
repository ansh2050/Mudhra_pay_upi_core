'use strict';

const express = require('express');
const { getPoolMetrics } = require('./config/db');
const errorHandler = require('./middlewares/error.middleware');

const app = express();

app.use(express.json());

// ---------------------------------------------------------------------------
// BigInt → string serialization for JSON responses (placed after express.json())
// ---------------------------------------------------------------------------
app.set('json replacer', (k, v) => (typeof v === 'bigint' ? v.toString() : v));

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ---------------------------------------------------------------------------
// Admin metrics
// ---------------------------------------------------------------------------
app.get('/admin/metrics', (_req, res) => {
  res.json({ pool: getPoolMetrics() });
});

// ---------------------------------------------------------------------------
// Ledger transfer route (Role 1)
// ---------------------------------------------------------------------------
app.use('/api/v1/ledger/transfer', require('./routes/transfers'));

// ---------------------------------------------------------------------------
// 404 catch-all
// ---------------------------------------------------------------------------
app.use((_req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found.' } });
});

// ---------------------------------------------------------------------------
// Global error handler (must be last)
// ---------------------------------------------------------------------------
app.use(errorHandler);

module.exports = app;
