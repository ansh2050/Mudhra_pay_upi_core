'use strict';

// Integration tests against the TEST database (rebuilt by tests/globalSetup.js).
// Fixtures live in tests/helpers/fixtures.js: adapt them there, not here.
// Run: npx jest tests/ledger.test.js --runInBand
const crypto = require('crypto');
const { pool, query } = require('../src/config/db');
const {
  executeJournalTransfer,
  DAILY_UPI_LIMIT_PAISE,
} = require('../src/modules/ledger-core/ledger.service');
const { createUser, createAccount, createIdempotencyKeyRow } = require('./helpers/fixtures');

const uuid = () => crypto.randomUUID();

async function balanceOf(accountId) {
  const r = await query('SELECT cached_balance_paise FROM accounts WHERE id = $1', [accountId]);
  return r.rows[0].cached_balance_paise;
}

const p2p = (from, to, amountPaise, extra = {}) =>
  executeJournalTransfer({
    debitAccountId: from.id,
    creditAccountId: to.id,
    amountPaise,
    journalType: 'P2P_TRANSFER',
    createdByUserId: from.userId,
    ...extra,
  });

afterAll(async () => { await pool.end(); });

// ---------------------------------------------------------------------------
describe('types and serialization', () => {
  test('BIGINT columns come back as BigInt (pg type parser is active)', async () => {
    const a = await createAccount({ balance: 500n });
    expect(typeof (await balanceOf(a.id))).toBe('bigint');
  });

  test('result is JSON-serializable and money fields are strings', async () => {
    const from = await createAccount({ balance: 1000n });
    const to = await createAccount();
    const result = await p2p(from, to, 250n);

    expect(() => JSON.stringify(result)).not.toThrow();
    expect(result.amountPaise).toBe('250');
    expect(result.senderClosingBalancePaise).toBe('750');
    expect(result.receiverClosingBalancePaise).toBe('250');
  });
});

describe('amount validation (no DB access needed)', () => {
  test.each([['0x10'], [true], [1.5], [1e21], ['-5'], [0], [0n], [''], [null], ['12345678901234567890']])(
    'rejects %p',
    async (bad) => {
      await expect(
        executeJournalTransfer({
          debitAccountId: uuid(),
          creditAccountId: uuid(),
          amountPaise: bad,
          journalType: 'P2P_TRANSFER',
          createdByUserId: uuid(),
        })
      ).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
    }
  );
});

describe('concurrency', () => {
  test('two concurrent transfers, balance covers one: exactly one succeeds', async () => {
    const from = await createAccount({ balance: 100n });
    const r1 = await createAccount();
    const r2 = await createAccount();

    const results = await Promise.allSettled([p2p(from, r1, 100n), p2p(from, r2, 100n)]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');

    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].reason.code).toBe('INSUFFICIENT_FUNDS');
    expect(await balanceOf(from.id)).toBe(0n);
  });
});

describe('daily limit and deposits', () => {
  test('exactly the daily limit is allowed, one more paisa is rejected', async () => {
    const from = await createAccount({ balance: 50_000_000n });
    const to = await createAccount();

    await p2p(from, to, 4_000_000n);
    await p2p(from, to, 4_000_000n);
    await p2p(from, to, 2_000_000n); // total == DAILY_UPI_LIMIT_PAISE
    expect(DAILY_UPI_LIMIT_PAISE).toBe(10_000_000n);

    await expect(p2p(from, to, 1n)).rejects.toMatchObject({ code: 'DAILY_LIMIT_EXCEEDED' });
  });

  test('₹5,00,000 vault deposit is NOT blocked by the UPI daily limit', async () => {
    const vault = await createAccount({ type: 'SYSTEM_SETTLEMENT_VAULT', balance: 100_000_000n });
    const user = await createAccount();
    const admin = await createUser();

    const result = await executeJournalTransfer({
      debitAccountId: vault.id,
      creditAccountId: user.id,
      amountPaise: 50_000_000n,
      journalType: 'DEPOSIT',
      createdByUserId: admin,
    });
    expect(result.status).toBe('COMPLETED');
    expect(await balanceOf(user.id)).toBe(50_000_000n);
  });
});

describe('account-type rules', () => {
  test('DEPOSIT from a normal account is rejected', async () => {
    const a = await createAccount({ balance: 1000n });
    const b = await createAccount();
    await expect(
      executeJournalTransfer({
        debitAccountId: a.id, creditAccountId: b.id, amountPaise: 100n,
        journalType: 'DEPOSIT', createdByUserId: a.userId,
      })
    ).rejects.toMatchObject({ code: 'INVALID_SENDER_TYPE' });
  });

  test('QR_MERCHANT_PAY to a non-merchant receiver is rejected', async () => {
    const a = await createAccount({ balance: 1000n });
    const b = await createAccount(); // USER_SAVINGS
    await expect(
      executeJournalTransfer({
        debitAccountId: a.id, creditAccountId: b.id, amountPaise: 100n,
        journalType: 'QR_MERCHANT_PAY', createdByUserId: a.userId,
      })
    ).rejects.toMatchObject({ code: 'INVALID_RECEIVER_TYPE' });
  });
});

describe('ownership and account state', () => {
  test('cannot send from an account you do not own', async () => {
    const victim = await createAccount({ balance: 1000n });
    const attacker = await createAccount();
    await expect(
      executeJournalTransfer({
        debitAccountId: victim.id, creditAccountId: attacker.id, amountPaise: 100n,
        journalType: 'P2P_TRANSFER', createdByUserId: attacker.userId,
      })
    ).rejects.toMatchObject({ code: 'NOT_ACCOUNT_OWNER' });
  });

  test('frozen receiver gets a generic error (no status leak)', async () => {
    const from = await createAccount({ balance: 1000n });
    const to = await createAccount({ status: 'FROZEN_MPIN_LOCKED' });
    const err = await p2p(from, to, 100n).catch((e) => e);
    expect(err.code).toBe('RECEIVER_UNAVAILABLE');
    expect(err.message).not.toMatch(/FROZEN/);
  });
});

describe('reversals', () => {
  test('reverse once OK; twice -> ALREADY_REVERSED; reversing a reversal -> rejected', async () => {
    const from = await createAccount({ balance: 1000n });
    const to = await createAccount();
    const admin = await createUser();
    const original = await p2p(from, to, 1000n);

    const reverse = (journalId, debit, credit) =>
      executeJournalTransfer({
        debitAccountId: debit.id,
        creditAccountId: credit.id,
        amountPaise: 1000n,
        journalType: 'REVERSAL',
        reversalOfId: journalId,
        createdByUserId: admin,
      });

    const reversal = await reverse(original.journalId, to, from);
    expect(reversal.status).toBe('COMPLETED');
    expect(await balanceOf(from.id)).toBe(1000n);
    expect(await balanceOf(to.id)).toBe(0n);

    await expect(reverse(original.journalId, to, from)).rejects.toMatchObject({ code: 'ALREADY_REVERSED' });
    await expect(reverse(reversal.journalId, from, to)).rejects.toMatchObject({ code: 'CANNOT_REVERSE_REVERSAL' });
  });
});

describe('idempotency safety net (the real double-charge protection)', () => {
  test('same idempotencyKeyId twice: one journal, one debit, same result returned', async () => {
    const from = await createAccount({ balance: 1000n });
    const to = await createAccount();
    const keyId = await createIdempotencyKeyRow(from.userId);

    const first = await p2p(from, to, 300n, { idempotencyKeyId: keyId });
    const second = await p2p(from, to, 300n, { idempotencyKeyId: keyId });

    expect(second.journalId).toBe(first.journalId);
    expect(second.amountPaise).toBe('300');
    expect(await balanceOf(from.id)).toBe(700n);

    const count = await query('SELECT COUNT(*)::int AS n FROM journal_transactions WHERE idempotency_key_id = $1', [keyId]);
    expect(count.rows[0].n).toBe(1);
  });

  test('retry after the balance is FULLY spent returns the original, not INSUFFICIENT_FUNDS', async () => {
    const from = await createAccount({ balance: 300n });
    const to = await createAccount();
    const keyId = await createIdempotencyKeyRow(from.userId);

    const first = await p2p(from, to, 300n, { idempotencyKeyId: keyId });
    expect(await balanceOf(from.id)).toBe(0n);

    const retry = await p2p(from, to, 300n, { idempotencyKeyId: keyId });
    expect(retry.journalId).toBe(first.journalId);
    expect(await balanceOf(from.id)).toBe(0n);
  });

  test('same idempotencyKeyId in parallel: money moves once', async () => {
    const from = await createAccount({ balance: 1000n });
    const to = await createAccount();
    const keyId = await createIdempotencyKeyRow(from.userId);

    const results = await Promise.allSettled([
      p2p(from, to, 300n, { idempotencyKeyId: keyId }),
      p2p(from, to, 300n, { idempotencyKeyId: keyId }),
    ]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(await balanceOf(from.id)).toBe(700n);
  });
});
