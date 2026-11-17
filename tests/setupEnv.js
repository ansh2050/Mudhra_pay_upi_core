'use strict';
// Runs inside every Jest worker, before the test files load src/config/db.
try { require('dotenv').config(); } catch { /* dotenv optional */ }
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL; // adapt if db.js reads another variable
