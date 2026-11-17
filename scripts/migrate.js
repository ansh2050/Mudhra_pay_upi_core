'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config();

async function runMigrations() {
  console.log('🚀 Starting Mudhra_pay database migration...');

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('❌ FATAL: DATABASE_URL environment variable is required.');
    process.exit(1);
  }

  const pool = new Pool({ connectionString });

  try {
    // Read all .sql files in migrations/, sorted alphabetically (000, 001, 002, 003, ...).
    const migrationsDir = path.join(__dirname, '..', 'migrations');
    const files = fs.readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    if (files.length === 0) {
      console.error('❌ No .sql migration files found in', migrationsDir);
      process.exit(1);
    }

    for (const file of files) {
      const sqlPath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(sqlPath, 'utf8');
      console.log(`⏳ Applying migration: ${file}...`);

      try {
        // Each .sql as ONE query() call. Never split on ';' (breaks $$ blocks).
        // No BEGIN/COMMIT of our own — PostgreSQL wraps a single query() in an
        // implicit transaction already.
        await pool.query(sql);
        console.log(`✅ ${file} applied successfully.`);
      } catch (err) {
        // PostgreSQL error codes for duplicate objects/tables — idempotent re-runs
        if (err.code === '42710' || err.code === '42P07') {
          console.log(`ℹ️  ${file}: schema objects already exist (skipped).`);
        } else {
          console.error(`❌ ${file} failed:`, err.code, '-', err.message);
          process.exitCode = 1;
          return; // stop on first real error
        }
      }
    }

    console.log('🎉 All migrations applied.');
  } finally {
    await pool.end();
  }
}

runMigrations().catch((err) => {
  console.error('❌ Unhandled fatal error during migration:', err);
  process.exit(1);
});
