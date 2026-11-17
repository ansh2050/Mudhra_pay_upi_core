'use strict';

// Rebuilds the TEST database from scratch before the suites run.
// Why not TRUNCATE ... CASCADE: statement-level TRUNCATE triggers DO fire, so your
// immutability guards on ledger_entries / journal_transactions would block it.
//
// Setup:
//   1. .env / CI:  TEST_DATABASE_URL=postgres://user:pass@localhost:5432/mudhra_test
//   2. package.json:  "jest": { "globalSetup": "./tests/globalSetup.js", "setupFiles": ["./tests/setupEnv.js"] }
//   3. tests/setupEnv.js (one line):  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
//   4. Make sure scripts/migrate.js reads the DB from DATABASE_URL (adapt the env name below if not).
require('dotenv').config();

if (!process.env.TEST_DATABASE_URL) {
  throw new Error(
    'FATAL: TEST_DATABASE_URL is not set. ' +
    'Create a .env with TEST_DATABASE_URL=postgres://user:pass@localhost:5432/mudhra_test'
  );
}

const { Client } = require('pg');
const { execSync } = require('child_process');
const path = require('path');

module.exports = async () => {
  const testUrl = new URL(process.env.TEST_DATABASE_URL);
  const dbName = testUrl.pathname.slice(1);

  // Safety: never drop anything that isn't obviously a test database.
  if (!/test/i.test(dbName)) {
    throw new Error(`Refusing to drop database "${dbName}": its name must contain "test".`);
  }

  const adminUrl = new URL(testUrl.toString());
  adminUrl.pathname = '/postgres'; // maintenance DB, so we can drop the test one
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`); // FORCE needs Postgres 13+
    await admin.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end();
  }

  execSync('node scripts/migrate.js', {
    stdio: 'inherit',
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL },
  });
};
