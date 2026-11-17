'use strict';

const request = require('supertest');
const crypto = require('crypto');
const app = require('../src/app');
const { pool, query } = require('../src/config/db');
const { createUser, createAccount } = require('./helpers/fixtures');

const DEV_MPIN = process.env.DEV_MPIN || '1234';
const newKey = () => crypto.randomUUID();

afterAll(async () => {
  await pool.end();
});

describe('E2E HTTP Tests (/api/v1/ledger/transfer)', () => {
  let senderUser;
  let receiverUser;
  let senderAccount;
  let receiverAccount;

  beforeEach(async () => {
    senderUser = await createUser();
    receiverUser = await createUser();
    senderAccount = await createAccount({ userId: senderUser, balance: 10_000n });
    receiverAccount = await createAccount({ userId: receiverUser, balance: 0n });
  });

  // Case 1: missing Idempotency-Key -> 400
  test('1. missing Idempotency-Key -> 400', async () => {
    const res = await request(app)
      .post('/api/v1/ledger/transfer')
      .set('x-user-id', senderUser)
      .send({
        debitAccountId: senderAccount.id,
        creditAccountId: receiverAccount.id,
        amountPaise: 500,
        journalType: 'P2P_TRANSFER',
        mpin: DEV_MPIN,
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MISSING_IDEMPOTENCY_KEY');
  });

  // Case 2: wrong MPIN -> 403, and NO idempotency_keys row exists for that key
  test('2. wrong MPIN -> 403, and NO idempotency_keys row exists for that key', async () => {
    const key = newKey();
    const res = await request(app)
      .post('/api/v1/ledger/transfer')
      .set('x-user-id', senderUser)
      .set('Idempotency-Key', key)
      .send({
        debitAccountId: senderAccount.id,
        creditAccountId: receiverAccount.id,
        amountPaise: 500,
        journalType: 'P2P_TRANSFER',
        mpin: 'wrong_mpin',
      });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('INVALID_MPIN');

    // Confirm NO row exists in idempotency_keys for that key
    const rowRes = await query('SELECT * FROM idempotency_keys WHERE key = $1', [key]);
    expect(rowRes.rows.length).toBe(0);
  });

  // Case 3: valid transfer -> 201, amounts in the JSON are strings, the journal row exists
  test('3. valid transfer -> 201, amounts in the JSON are strings, the journal row exists', async () => {
    const key = newKey();
    const res = await request(app)
      .post('/api/v1/ledger/transfer')
      .set('x-user-id', senderUser)
      .set('Idempotency-Key', key)
      .send({
        debitAccountId: senderAccount.id,
        creditAccountId: receiverAccount.id,
        amountPaise: 2500,
        journalType: 'P2P_TRANSFER',
        mpin: DEV_MPIN,
      });

    expect(res.status).toBe(201);
    expect(typeof res.body.amountPaise).toBe('string');
    expect(res.body.amountPaise).toBe('2500');
    expect(typeof res.body.senderClosingBalancePaise).toBe('string');
    expect(typeof res.body.receiverClosingBalancePaise).toBe('string');

    // Check that the journal row exists
    const jRes = await query('SELECT * FROM journal_transactions WHERE id = $1', [res.body.journalId]);
    expect(jRes.rows.length).toBe(1);
    expect(jRes.rows[0].status).toBe('COMPLETED');
  });

  // Case 4: same key + same body again -> same journalId, header x-idempotent-replayed: true, sender debited once
  test('4. same key + same body again -> same journalId, header x-idempotent-replayed: true, sender debited once', async () => {
    const key = newKey();
    const payload = {
      debitAccountId: senderAccount.id,
      creditAccountId: receiverAccount.id,
      amountPaise: 1000,
      journalType: 'P2P_TRANSFER',
      mpin: DEV_MPIN,
    };

    const res1 = await request(app)
      .post('/api/v1/ledger/transfer')
      .set('x-user-id', senderUser)
      .set('Idempotency-Key', key)
      .send(payload);

    expect(res1.status).toBe(201);
    expect(res1.headers['x-idempotent-replayed']).toBeUndefined();

    const res2 = await request(app)
      .post('/api/v1/ledger/transfer')
      .set('x-user-id', senderUser)
      .set('Idempotency-Key', key)
      .send(payload);

    expect(res2.status).toBe(201);
    expect(res2.headers['x-idempotent-replayed']).toBe('true');
    expect(res2.body.journalId).toBe(res1.body.journalId);

    // Sender debited once (10000 - 1000 = 9000)
    const sRes = await query('SELECT cached_balance_paise FROM accounts WHERE id = $1', [senderAccount.id]);
    expect(sRes.rows[0].cached_balance_paise).toBe(9000n);
  });

  // Case 5: same key + different amount -> 422
  test('5. same key + different amount -> 422', async () => {
    const key = newKey();

    const res1 = await request(app)
      .post('/api/v1/ledger/transfer')
      .set('x-user-id', senderUser)
      .set('Idempotency-Key', key)
      .send({
        debitAccountId: senderAccount.id,
        creditAccountId: receiverAccount.id,
        amountPaise: 1000,
        journalType: 'P2P_TRANSFER',
        mpin: DEV_MPIN,
      });

    expect(res1.status).toBe(201);

    const res2 = await request(app)
      .post('/api/v1/ledger/transfer')
      .set('x-user-id', senderUser)
      .set('Idempotency-Key', key)
      .send({
        debitAccountId: senderAccount.id,
        creditAccountId: receiverAccount.id,
        amountPaise: 2000,
        journalType: 'P2P_TRANSFER',
        mpin: DEV_MPIN,
      });

    expect(res2.status).toBe(422);
    expect(res2.body.error.code).toBe('IDEMPOTENCY_KEY_REUSE');
  });

  // Case 6: two simultaneous requests with the same key -> one 201 and the other 409 or a replay; sender debited once
  test('6. two simultaneous requests with the same key -> one 201 and the other 409 or a replay; sender debited once', async () => {
    const key = newKey();
    const payload = {
      debitAccountId: senderAccount.id,
      creditAccountId: receiverAccount.id,
      amountPaise: 500,
      journalType: 'P2P_TRANSFER',
      mpin: DEV_MPIN,
    };

    const [r1, r2] = await Promise.all([
      request(app)
        .post('/api/v1/ledger/transfer')
        .set('x-user-id', senderUser)
        .set('Idempotency-Key', key)
        .send(payload),
      request(app)
        .post('/api/v1/ledger/transfer')
        .set('x-user-id', senderUser)
        .set('Idempotency-Key', key)
        .send(payload),
    ]);

    const statuses = [r1.status, r2.status].sort();
    expect(statuses[0]).toBe(201);
    expect([201, 409]).toContain(statuses[1]);

    // Sender debited once (10000 - 500 = 9500)
    const sRes = await query('SELECT cached_balance_paise FROM accounts WHERE id = $1', [senderAccount.id]);
    expect(sRes.rows[0].cached_balance_paise).toBe(9500n);
  });

  // Case 7: retry with the same key after the sender's balance was fully spent returns the original result, not INSUFFICIENT_FUNDS
  test('7. retry with the same key after the sender\'s balance was fully spent returns the original result, not INSUFFICIENT_FUNDS', async () => {
    const smallSender = await createAccount({ userId: senderUser, balance: 500n });
    const key = newKey();

    const res1 = await request(app)
      .post('/api/v1/ledger/transfer')
      .set('x-user-id', senderUser)
      .set('Idempotency-Key', key)
      .send({
        debitAccountId: smallSender.id,
        creditAccountId: receiverAccount.id,
        amountPaise: 500,
        journalType: 'P2P_TRANSFER',
        mpin: DEV_MPIN,
      });

    expect(res1.status).toBe(201);

    // Balance is now 0
    const sRes = await query('SELECT cached_balance_paise FROM accounts WHERE id = $1', [smallSender.id]);
    expect(sRes.rows[0].cached_balance_paise).toBe(0n);

    // Retry with same key
    const res2 = await request(app)
      .post('/api/v1/ledger/transfer')
      .set('x-user-id', senderUser)
      .set('Idempotency-Key', key)
      .send({
        debitAccountId: smallSender.id,
        creditAccountId: receiverAccount.id,
        amountPaise: 500,
        journalType: 'P2P_TRANSFER',
        mpin: DEV_MPIN,
      });

    expect(res2.status).toBe(201);
    expect(res2.body.journalId).toBe(res1.body.journalId);
    expect(res2.headers['x-idempotent-replayed']).toBe('true');
  });

  // Case 8: insufficient funds -> 422 INSUFFICIENT_FUNDS, and a retry with the same key replays the same 422
  test('8. insufficient funds -> 422 INSUFFICIENT_FUNDS, and a retry with the same key replays the same 422', async () => {
    const poorSender = await createAccount({ userId: senderUser, balance: 100n });
    const key = newKey();

    const res1 = await request(app)
      .post('/api/v1/ledger/transfer')
      .set('x-user-id', senderUser)
      .set('Idempotency-Key', key)
      .send({
        debitAccountId: poorSender.id,
        creditAccountId: receiverAccount.id,
        amountPaise: 1000,
        journalType: 'P2P_TRANSFER',
        mpin: DEV_MPIN,
      });

    expect(res1.status).toBe(422);
    expect(res1.body.error.code).toBe('INSUFFICIENT_FUNDS');

    // Retry with same key replays the 422
    const res2 = await request(app)
      .post('/api/v1/ledger/transfer')
      .set('x-user-id', senderUser)
      .set('Idempotency-Key', key)
      .send({
        debitAccountId: poorSender.id,
        creditAccountId: receiverAccount.id,
        amountPaise: 1000,
        journalType: 'P2P_TRANSFER',
        mpin: DEV_MPIN,
      });

    expect(res2.status).toBe(422);
    expect(res2.body.error.code).toBe('INSUFFICIENT_FUNDS');
    expect(res2.headers['x-idempotent-replayed']).toBe('true');
  });

  // Case 9: with process.env.NODE_ENV temporarily set to 'production' for one request -> 401 (restore it afterwards)
  test('9. with process.env.NODE_ENV temporarily set to production for one request -> 401', async () => {
    const savedEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';

      const res = await request(app)
        .post('/api/v1/ledger/transfer')
        .set('x-user-id', senderUser)
        .set('Idempotency-Key', newKey())
        .send({
          debitAccountId: senderAccount.id,
          creditAccountId: receiverAccount.id,
          amountPaise: 500,
          journalType: 'P2P_TRANSFER',
          mpin: DEV_MPIN,
        });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTH_REQUIRED');
    } finally {
      process.env.NODE_ENV = savedEnv;
    }
  });
});
