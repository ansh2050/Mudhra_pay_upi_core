'use strict';

const request = require('supertest');
const crypto = require('crypto');
const app = require('../src/app');
const { pool, query } = require('../src/config/db');
const { createUser, createAccount } = require('./helpers/fixtures');

const uuid = () => crypto.randomUUID();

afterAll(async () => {
  await pool.end();
});

describe('E2E Payment Flow (/api/v1/ledger/transfer)', () => {
  let senderUser;
  let receiverUser;
  let senderAccount;
  let receiverAccount;

  beforeEach(async () => {
    senderUser = await createUser();
    receiverUser = await createUser();

    senderAccount = await createAccount({
      userId: senderUser,
      balance: 10_000n, // 100.00 INR
    });
    receiverAccount = await createAccount({
      userId: receiverUser,
      balance: 0n,
    });
  });

  test('401 when authentication is missing', async () => {
    const res = await request(app)
      .post('/api/v1/ledger/transfer')
      .send({
        debitAccountId: senderAccount.id,
        creditAccountId: receiverAccount.id,
        amountPaise: '500',
        journalType: 'P2P_TRANSFER',
        mpin: '1234',
      });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  test('403 when MPIN is missing or incorrect', async () => {
    // Missing MPIN
    const resNoMpin = await request(app)
      .post('/api/v1/ledger/transfer')
      .set('x-user-id', senderUser)
      .send({
        debitAccountId: senderAccount.id,
        creditAccountId: receiverAccount.id,
        amountPaise: '500',
        journalType: 'P2P_TRANSFER',
      });

    expect(resNoMpin.status).toBe(403);
    expect(resNoMpin.body.error.code).toBe('INVALID_MPIN');

    // Wrong MPIN
    const resWrongMpin = await request(app)
      .post('/api/v1/ledger/transfer')
      .set('x-user-id', senderUser)
      .send({
        debitAccountId: senderAccount.id,
        creditAccountId: receiverAccount.id,
        amountPaise: '500',
        journalType: 'P2P_TRANSFER',
        mpin: '9999',
      });

    expect(resWrongMpin.status).toBe(403);
    expect(resWrongMpin.body.error.code).toBe('INVALID_MPIN');
  });

  test('400 when Idempotency-Key header is missing', async () => {
    const res = await request(app)
      .post('/api/v1/ledger/transfer')
      .set('x-user-id', senderUser)
      .send({
        debitAccountId: senderAccount.id,
        creditAccountId: receiverAccount.id,
        amountPaise: '500',
        journalType: 'P2P_TRANSFER',
        mpin: '1234',
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MISSING_IDEMPOTENCY_KEY');
  });

  test('successful transfer: funds moved, 201 returned with BigInt strings', async () => {
    const key = uuid();
    const res = await request(app)
      .post('/api/v1/ledger/transfer')
      .set('x-user-id', senderUser)
      .set('Idempotency-Key', key)
      .send({
        debitAccountId: senderAccount.id,
        creditAccountId: receiverAccount.id,
        amountPaise: '2500',
        journalType: 'P2P_TRANSFER',
        referenceNote: 'Dinner split',
        mpin: '1234',
      });

    expect(res.status).toBe(201);
    expect(res.body.journalId).toBeDefined();
    expect(res.body.status).toBe('COMPLETED');
    expect(res.body.amountPaise).toBe('2500');
    expect(res.body.senderClosingBalancePaise).toBe('7500');
    expect(res.body.receiverClosingBalancePaise).toBe('2500');

    // Verify DB balances
    const senderDb = await query('SELECT cached_balance_paise FROM accounts WHERE id = $1', [senderAccount.id]);
    const receiverDb = await query('SELECT cached_balance_paise FROM accounts WHERE id = $1', [receiverAccount.id]);
    expect(senderDb.rows[0].cached_balance_paise).toBe(7500n);
    expect(receiverDb.rows[0].cached_balance_paise).toBe(2500n);
  });

  test('idempotent replay: second call with same key returns cached result without double charging', async () => {
    const key = uuid();
    const payload = {
      debitAccountId: senderAccount.id,
      creditAccountId: receiverAccount.id,
      amountPaise: '1000',
      journalType: 'P2P_TRANSFER',
      mpin: '1234',
    };

    const first = await request(app)
      .post('/api/v1/ledger/transfer')
      .set('x-user-id', senderUser)
      .set('Idempotency-Key', key)
      .send(payload);

    expect(first.status).toBe(201);
    expect(first.headers['x-idempotent-replayed']).toBeUndefined();

    const second = await request(app)
      .post('/api/v1/ledger/transfer')
      .set('x-user-id', senderUser)
      .set('Idempotency-Key', key)
      .send(payload);

    expect(second.status).toBe(201);
    expect(second.headers['x-idempotent-replayed']).toBe('true');
    expect(second.body.journalId).toBe(first.body.journalId);
    expect(second.body.senderClosingBalancePaise).toBe('9000');

    // Verify balance only decremented once
    const senderDb = await query('SELECT cached_balance_paise FROM accounts WHERE id = $1', [senderAccount.id]);
    expect(senderDb.rows[0].cached_balance_paise).toBe(9000n);
  });

  test('same idempotency key with different payload returns 422 IDEMPOTENCY_KEY_REUSE', async () => {
    const key = uuid();

    const first = await request(app)
      .post('/api/v1/ledger/transfer')
      .set('x-user-id', senderUser)
      .set('Idempotency-Key', key)
      .send({
        debitAccountId: senderAccount.id,
        creditAccountId: receiverAccount.id,
        amountPaise: '1000',
        journalType: 'P2P_TRANSFER',
        mpin: '1234',
      });

    expect(first.status).toBe(201);

    const second = await request(app)
      .post('/api/v1/ledger/transfer')
      .set('x-user-id', senderUser)
      .set('Idempotency-Key', key)
      .send({
        debitAccountId: senderAccount.id,
        creditAccountId: receiverAccount.id,
        amountPaise: '2000',
        journalType: 'P2P_TRANSFER',
        mpin: '1234',
      });

    expect(second.status).toBe(422);
    expect(second.body.error.code).toBe('IDEMPOTENCY_KEY_REUSE');
  });

  test('3 consecutive failed MPIN attempts triggers FROZEN_MPIN_LOCKED lockout', async () => {
    const userToLock = await createUser();
    const accToLock = await createAccount({ userId: userToLock, balance: 5000n });

    for (let i = 0; i < 3; i++) {
      const res = await request(app)
        .post('/api/v1/ledger/transfer')
        .set('x-user-id', userToLock)
        .set('Idempotency-Key', uuid())
        .send({
          debitAccountId: accToLock.id,
          creditAccountId: receiverAccount.id,
          amountPaise: '500',
          journalType: 'P2P_TRANSFER',
          mpin: '9999',
        });
      expect(res.status).toBe(403);
    }

    // Account should now be FROZEN_MPIN_LOCKED in the database
    const dbAcc = await query('SELECT status FROM accounts WHERE id = $1', [accToLock.id]);
    expect(dbAcc.rows[0].status).toBe('FROZEN_MPIN_LOCKED');

    // Subsequent transfer with correct MPIN should still fail because account is frozen
    const resFrozen = await request(app)
      .post('/api/v1/ledger/transfer')
      .set('x-user-id', userToLock)
      .set('Idempotency-Key', uuid())
      .send({
        debitAccountId: accToLock.id,
        creditAccountId: receiverAccount.id,
        amountPaise: '500',
        journalType: 'P2P_TRANSFER',
        mpin: '1234',
      });

    // mpin verification fails because account is FROZEN_MPIN_LOCKED
    expect(resFrozen.status).toBe(403);
  });
});
