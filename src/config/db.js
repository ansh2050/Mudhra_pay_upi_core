'use strict';

require('./pgTypes');
require('dotenv').config();
const { Pool, types } = require('pg');

// ============================================================================
// 1. BIGINT TYPE PARSER
// ============================================================================
types.setTypeParser(types.builtins.INT8, (val) => (val === null ? null : BigInt(val)));

if (typeof BigInt.prototype.toJSON !== 'function') {
  BigInt.prototype.toJSON = function () {
    return this.toString();
  };
}

// ============================================================================
// 2. PRODUCTION SAFETY — fail fast if DATABASE_URL is missing
// ============================================================================
if (process.env.NODE_ENV === 'production' && !process.env.DATABASE_URL) {
  throw new Error('FATAL: DATABASE_URL environment variable is required in production.');
}

// ============================================================================
// 3. CONNECTION POOL
// ============================================================================
const connectionString =
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/mudhra_pay_db';

const pool = new Pool({
  connectionString,
  max: Number(process.env.DB_POOL_MAX) || 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  maxUses: 1000,
});

pool.on('error', (err) => {
  console.error('[CRITICAL] Unexpected error on idle PostgreSQL pool client:', err.message);
});

// ============================================================================
// 4. TRANSACTION WRAPPER
// ============================================================================
async function withTransaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '3000ms'");
    await client.query("SET LOCAL statement_timeout = '15000ms'");
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('[CRITICAL] Failed to ROLLBACK:', rollbackError.message);
    }
    throw error;
  } finally {
    client.release();
  }
}

// ============================================================================
// 5. SIMPLE QUERY HELPER
// ============================================================================
async function query(text, params) {
  return pool.query(text, params);
}

// ============================================================================
// 6. POOL METRICS
// ============================================================================
function getPoolMetrics() {
  return {
    totalConnections: pool.totalCount,
    idleConnections: pool.idleCount,
    waitingRequests: pool.waitingCount,
  };
}

// ============================================================================
// 7. GRACEFUL SHUTDOWN (idempotent — safe to call multiple times)
// ============================================================================
let isPoolClosed = false;

async function closePool() {
  if (!isPoolClosed) {
    isPoolClosed = true;
    await pool.end();
  }
}

// ============================================================================
// EXPORTS
// ============================================================================
module.exports = {
  pool,
  query,
  withTransaction,
  getPoolMetrics,
  closePool,
};