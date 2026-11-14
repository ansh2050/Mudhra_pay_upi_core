'use strict';

const fs = require('fs');
const path = require('path');
const { pool, closePool } = require('../src/config/db');

async function runMigration() {
  console.log('🚀 Starting Mudhra_pay database migration...');

  // 1. Resolve and verify migration file path explicitly
  const sqlPath = path.join(__dirname, '..', 'migrations', '001_initial_schema.sql');
  
  if (!fs.existsSync(sqlPath)) {
    console.error(`❌ FATAL: Migration file not found at expected path: ${sqlPath}`);
    process.exit(1);
  }

  const sql = fs.readFileSync(sqlPath, 'utf8');
  console.log(`⏳ Applying migration: ${path.basename(sqlPath)}...`);

  try {
    // 2. Execute SQL migration against Docker PostgreSQL
    await pool.query(sql);
    console.log('✅ Migration 001_initial_schema.sql applied successfully!');
  } catch (err) {
    // PostgreSQL error codes for duplicate objects/tables
    if (err.code === '42710' || err.code === '42P07') {
      console.log('ℹ️ Schema objects already exist in database. (To reset cleanly, run: docker compose down -v && docker compose up -d)');
    } else {
      console.error('❌ Migration failed with PostgreSQL error:', err.code, '-', err.message);
      process.exitCode = 1;
    }
  } finally {
    // 3. Guarantee pool cleanup
    await closePool();
  }
}

// Global async catch boundary to ensure it never exits silently
runMigration().catch((err) => {
  console.error('❌ Unhandled fatal error during migration:', err);
  process.exit(1);
});