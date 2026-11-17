'use strict';

// Integration tests: need a REAL Postgres (use a test database!).
// Run: NODE_ENV=test npx jest tests/idempotency.test.js --runInBand
const request = require('supertest');
const express = require('express');
const crypto = require('crypto');
const { pool, query } = require('../src/config/db');
const { idempotencyMiddleware, computeRequestHash } = require('../src/middlewares/idempotency');
const { createUser } = require('./helpers/fixtures');

const TEST_USER = crypto.randomUUID(); // throwaway user for this file; every test uses a unique key
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const newKey = () => crypto.randomUUID();

function buildApp(handler) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: TEST_USER }; next(); });
  app.post('/t', idempotencyMiddleware, handler);
  // Mimics a global error handler: unhandled errors become 500s.
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(500).json({ error: { code: 'INTERNAL' } }));
  return app;
}

const post = (app, key, body = { amount: 1 }) =>
  request(app).post('/t').set('Idempotency-Key', key).send(body);

beforeAll(async () => { await createUser(TEST_USER); });

afterAll(async () => { await pool.end(); });

describe('header validation', () => {
  const app = buildApp((_req, res) => res.status(201).json({ ok: true }));

  test('missing key -> 400', async () => {
    const res = await request(app).post('/t').send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MISSING_IDEMPOTENCY_KEY');
  });

  test('too-short key -> 400', async () => {
    const res = await post(app, 'abc');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_IDEMPOTENCY_KEY');
  });
});

describe('core behaviour', () => {
  test('same key in parallel: one executes, the other gets 409; later retry replays', async () => {
    let calls = 0;
    const app = buildApp(async (_req, res) => { calls++; await sleep(300); res.status(201).json({ ok: true }); });
    const key = newKey();

    const results = await Promise.all([post(app, key), post(app, key)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(calls).toBe(1);

    const replay = await post(app, key);
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual({ ok: true });
    expect(replay.headers['x-idempotent-replayed']).toBe('true');
    expect(calls).toBe(1);
  });

  test('handler returns 500 -> retry with same key re-runs', async () => {
    let calls = 0;
    const app = buildApp((_req, res) => {
      calls++;
      if (calls === 1) return res.status(500).json({ error: { code: 'BOOM' } });
      return res.status(201).json({ ok: true });
    });
    const key = newKey();

    expect((await post(app, key)).status).toBe(500);
    const retry = await post(app, key);
    expect(retry.status).toBe(201);
    expect(calls).toBe(2);
  });

  test('empty-body 404 is cached: retry replays 404 without re-running', async () => {
    let calls = 0;
    const app = buildApp((_req, res) => { calls++; res.status(404).end(); });
    const key = newKey();

    expect((await post(app, key)).status).toBe(404);
    const retry = await post(app, key);
    expect(retry.status).toBe(404);
    expect(retry.headers['x-idempotent-replayed']).toBe('true');
    expect(calls).toBe(1);
  });

  test('204 is replayed as 204 (not 409)', async () => {
    let calls = 0;
    const app = buildApp((_req, res) => { calls++; res.status(204).end(); });
    const key = newKey();

    expect((await post(app, key)).status).toBe(204);
    const retry = await post(app, key);
    expect(retry.status).toBe(204);
    expect(calls).toBe(1);
  });

  test('429 is not cached: retry re-runs', async () => {
    let calls = 0;
    const app = buildApp((_req, res) => {
      calls++;
      return calls === 1 ? res.status(429).json({ error: { code: 'SLOW_DOWN' } }) : res.status(201).json({ ok: true });
    });
    const key = newKey();

    expect((await post(app, key)).status).toBe(429);
    expect((await post(app, key)).status).toBe(201);
    expect(calls).toBe(2);
  });

  test('same key + different body -> 422 and handler not run', async () => {
    let calls = 0;
    const app = buildApp((_req, res) => { calls++; res.status(201).json({ ok: true }); });
    const key = newKey();

    expect((await post(app, key, { amount: 1 })).status).toBe(201);
    const res = await post(app, key, { amount: 2 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSE');
    expect(calls).toBe(1);
  });

  test('key order in the body does not matter', async () => {
    let calls = 0;
    const app = buildApp((_req, res) => { calls++; res.status(201).json({ ok: true }); });
    const key = newKey();

    await post(app, key, { a: 1, b: 2 });
    const res = await post(app, key, { b: 2, a: 1 });
    expect(res.status).toBe(201);
    expect(res.headers['x-idempotent-replayed']).toBe('true');
    expect(calls).toBe(1);
  });

  test('mpin is ignored in the hash (re-typed MPIN replays, not 422)', async () => {
    let calls = 0;
    const app = buildApp((_req, res) => { calls++; res.status(201).json({ ok: true }); });
    const key = newKey();

    await post(app, key, { amount: 5, mpin: '1234' });
    const res = await post(app, key, { amount: 5, mpin: '9999' });
    expect(res.status).toBe(201);
    expect(calls).toBe(1);
  });
});

describe('stale-lock recovery', () => {
  async function insertInProgress(key, body, ageSeconds) {
    const hash = computeRequestHash('POST', '/t', body);
    await query(
      `INSERT INTO idempotency_keys (user_id, key, request_hash, status, locked_at)
       VALUES ($1, $2, $3, 'IN_PROGRESS', now() - ($4 * interval '1 second'))`,
      [TEST_USER, key, hash, ageSeconds]
    );
  }

  test('fresh IN_PROGRESS row -> 409, handler not run', async () => {
    let calls = 0;
    const app = buildApp((_req, res) => { calls++; res.status(201).json({ ok: true }); });
    const key = newKey();
    const body = { amount: 1 };
    await insertInProgress(key, body, 10);

    expect((await post(app, key, body)).status).toBe(409);
    expect(calls).toBe(0);
  });

  test('IN_PROGRESS older than 5 minutes is taken over exactly once', async () => {
    let calls = 0;
    const app = buildApp(async (_req, res) => { calls++; await sleep(300); res.status(201).json({ ok: true }); });
    const key = newKey();
    const body = { amount: 1 };
    await insertInProgress(key, body, 10 * 60);

    const results = await Promise.all([post(app, key, body), post(app, key, body)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(calls).toBe(1);

    const row = (await query('SELECT attempt, status FROM idempotency_keys WHERE user_id=$1 AND key=$2', [TEST_USER, key])).rows[0];
    expect(row.attempt).toBe(2);
    expect(row.status).toBe('COMPLETED');
  });
});
