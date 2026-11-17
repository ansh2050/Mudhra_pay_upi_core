'use strict';

// Deletes expired, finalized idempotency keys in small batches.
// Run from a scheduler (OS cron / Kubernetes CronJob / pg_cron), e.g. every 15 min:
//   node scripts/cleanup-idempotency.js
// Load env the same way scripts/migrate.js does (dotenv line below if you use it).
require('dotenv').config();
const { pool } = require('../src/config/db');

const BATCH = Number(process.env.CLEANUP_BATCH || 1000);
const LOCK_KEY = 727001; // arbitrary constant: only one cleanup runs at a time across all instances

async function runCleanup() {
  const client = await pool.connect(); // advisory locks are per-session, so use one dedicated client
  let total = 0;
  try {
    const lock = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_KEY]);
    if (!lock.rows[0].ok) {
      console.log('[cleanup] another run holds the lock, skipping');
      return 0;
    }
    try {
      for (;;) {
        // Skips IN_PROGRESS rows and keys that produced a journal (see note below).
        const r = await client.query(
          `DELETE FROM idempotency_keys
            WHERE id IN (
              SELECT k.id FROM idempotency_keys k
               WHERE k.status <> 'IN_PROGRESS'
                 AND k.expires_at < now()
                 AND NOT EXISTS (SELECT 1 FROM journal_transactions jt WHERE jt.idempotency_key_id = k.id)
               ORDER BY k.expires_at
               LIMIT $1
               FOR UPDATE SKIP LOCKED
            )`,
          [BATCH]
        );
        total += r.rowCount;
        if (r.rowCount < BATCH) break;
      }

      // Visibility: IN_PROGRESS rows are never deleted, so watch for orphans.
      const orphans = await client.query(
        `SELECT COUNT(*)::int AS n FROM idempotency_keys
          WHERE status = 'IN_PROGRESS' AND locked_at < now() - interval '1 hour'`
      );
      if (orphans.rows[0].n > 0) {
        console.warn(`[cleanup] ${orphans.rows[0].n} IN_PROGRESS keys older than 1h (stuck or never retried)`);
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
    }
  } finally {
    client.release();
  }
  return total;
}

module.exports = { runCleanup };

if (require.main === module) {
  runCleanup()
    .then((n) => console.log(`[cleanup] deleted ${n} expired idempotency keys`))
    .catch((err) => { console.error('[cleanup] failed:', err); process.exitCode = 1; })
    .finally(() => pool.end());
}
