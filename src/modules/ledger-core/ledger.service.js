'use strict';

require('../../config/pgTypes'); // BIGINT -> BigInt (must be loaded before any query)
const { withTransaction, query } = require('../../config/db');

class LedgerError extends Error {
  constructor(code, message, httpStatus = 400) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

// ============================================================================
// CONSTANTS
// ============================================================================
const DAILY_UPI_LIMIT_PAISE = 100_000_00n; // ₹1,00,000 = 10,000,000 paise
const DAILY_UPI_TX_COUNT_LIMIT = 20n;
const MAX_NOTE_LENGTH = 500;
const MAX_AMOUNT_DIGITS = 18; // stays inside BIGINT
// Accepts UUID v1-v8 (so v7 works too)
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const VAULT_TYPE = 'SYSTEM_SETTLEMENT_VAULT';
// Must match your accounts.type enum labels exactly.
const ACCOUNT_TYPE_RULES = {
  DEPOSIT:          { sender: [VAULT_TYPE], receiver: ['USER_SAVINGS', 'MERCHANT_CURRENT'] },
  WITHDRAWAL:       { sender: ['USER_SAVINGS', 'MERCHANT_CURRENT'], receiver: [VAULT_TYPE] },
  P2P_TRANSFER:     { sender: ['USER_SAVINGS'], receiver: ['USER_SAVINGS', 'MERCHANT_CURRENT'] },
  QR_MERCHANT_PAY:  { sender: ['USER_SAVINGS'], receiver: ['MERCHANT_CURRENT'] },
  COLLECT_TRANSFER: { sender: ['USER_SAVINGS'], receiver: ['USER_SAVINGS'] },
};
const REVERSAL_CONSTRAINT = 'journal_transactions_reversal_of_id_key';

const VALID_JOURNAL_TYPES = new Set([
  'P2P_TRANSFER', 'QR_MERCHANT_PAY', 'COLLECT_TRANSFER', 'DEPOSIT', 'WITHDRAWAL', 'REVERSAL',
]);
// Daily velocity limits apply ONLY to these. Derived from type, not a caller flag.
const UPI_TYPES = new Set(['P2P_TRANSFER', 'QR_MERCHANT_PAY', 'COLLECT_TRANSFER']);
// Types where the sender account must belong to the creating user (defense in depth).
// COLLECT_TRANSFER is excluded: who "creates" it depends on your collect flow.
const OWNER_CHECKED_TYPES = new Set(['P2P_TRANSFER', 'QR_MERCHANT_PAY', 'WITHDRAWAL']);

// ============================================================================
// AMOUNT PARSING: strict. No hex, no booleans, no floats, no unsafe numbers.
// ============================================================================
function parseAmountPaise(v) {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return Number.isSafeInteger(v) ? BigInt(v) : null;
  if (typeof v === 'string' && new RegExp(`^[0-9]{1,${MAX_AMOUNT_DIGITS}}$`).test(v)) return BigInt(v);
  return null;
}

function formatResult({ journal, senderId, receiverId, amount, senderBalance, receiverBalance, note, reversalOfId }) {
  // BigInt is NOT JSON-serializable, so every money field leaves as a string.
  return {
    journalId: journal.id,
    type: journal.type,
    status: journal.status,
    debitAccountId: senderId,
    creditAccountId: receiverId,
    amountPaise: amount.toString(),
    senderClosingBalancePaise: senderBalance.toString(),
    receiverClosingBalancePaise: receiverBalance.toString(),
    referenceNote: note,
    reversalOfId,
    createdAt: journal.created_at,
  };
}

// ============================================================================
// PUBLIC ENTRY POINT
// Contract for callers:
//  1. Verify MPIN BEFORE calling (no bcrypt inside the DB lock window).
//  2. Role 2's RBAC should still verify account ownership; this function also
//     re-checks it for user-initiated types.
//  3. Money fields in the result are STRINGS.
// ============================================================================
async function executeJournalTransfer(params) {
  const v = validate(params);

  try {
    return await runTransfer(v);
  } catch (err) {
    if (err.code === '23505') {
      // Name-independent: if this key already produced a journal, return it, whichever
      // unique constraint fired. (The failed transaction is rolled back by now, so this
      // lookup runs on a clean connection.)
      if (v.idempotencyKeyId) {
        const existing = await loadJournalByIdempotencyKey(v.idempotencyKeyId);
        if (existing) return existing;
      }
      if (err.constraint === REVERSAL_CONSTRAINT) {
        throw new LedgerError('ALREADY_REVERSED', 'This transaction has already been reversed.', 409);
      }
    }
    throw err;
  }
}

// ============================================================================
// STEP 1: validation (no DB)
// ============================================================================
function validate(p) {
  const {
    debitAccountId, creditAccountId, amountPaise, journalType, createdByUserId,
    idempotencyKeyId = null, referenceNote = null, reversalOfId = null,
  } = p || {};

  if (!debitAccountId || !UUID_REGEX.test(debitAccountId)) {
    throw new LedgerError('INVALID_ACCOUNT_ID', 'debitAccountId must be a valid UUID.', 400);
  }
  if (!creditAccountId || !UUID_REGEX.test(creditAccountId)) {
    throw new LedgerError('INVALID_ACCOUNT_ID', 'creditAccountId must be a valid UUID.', 400);
  }
  if (!createdByUserId || !UUID_REGEX.test(createdByUserId)) {
    throw new LedgerError('INVALID_USER_ID', 'createdByUserId must be a valid UUID.', 400);
  }
  if (idempotencyKeyId !== null && !UUID_REGEX.test(idempotencyKeyId)) {
    throw new LedgerError('INVALID_IDEMPOTENCY_ID', 'idempotencyKeyId must be a valid UUID.', 400);
  }
  if (reversalOfId !== null && !UUID_REGEX.test(reversalOfId)) {
    throw new LedgerError('INVALID_REVERSAL_ID', 'reversalOfId must be a valid UUID.', 400);
  }
  if (!VALID_JOURNAL_TYPES.has(journalType)) {
    throw new LedgerError('INVALID_JOURNAL_TYPE', `journalType must be one of: ${[...VALID_JOURNAL_TYPES].join(', ')}`, 400);
  }
  if (journalType === 'REVERSAL' && !reversalOfId) {
    throw new LedgerError('MISSING_REVERSAL_ID', 'reversalOfId is required when journalType is REVERSAL.', 400);
  }
  if (journalType !== 'REVERSAL' && reversalOfId) {
    throw new LedgerError('INVALID_REVERSAL_PARAM', 'reversalOfId can only be set when journalType is REVERSAL.', 400);
  }
  if (referenceNote !== null) {
    if (typeof referenceNote !== 'string') {
      throw new LedgerError('INVALID_NOTE', 'referenceNote must be a string or null.', 400);
    }
    if (referenceNote.length > MAX_NOTE_LENGTH) {
      throw new LedgerError('NOTE_TOO_LONG', `referenceNote must be ${MAX_NOTE_LENGTH} characters or fewer.`, 400);
    }
  }

  const senderId = debitAccountId.toLowerCase();
  const receiverId = creditAccountId.toLowerCase();
  if (senderId === receiverId) {
    throw new LedgerError('SELF_TRANSFER_NOT_ALLOWED', 'Sender and receiver accounts cannot be the same.', 422);
  }

  const amount = parseAmountPaise(amountPaise);
  if (amount === null || amount <= 0n) {
    throw new LedgerError('INVALID_AMOUNT', 'Amount must be a positive integer in paise.', 400);
  }

  return {
    senderId, receiverId, amount, journalType, createdByUserId,
    idempotencyKeyId, referenceNote, reversalOfId: reversalOfId ? reversalOfId.toLowerCase() : null,
  };
}

// ============================================================================
// STEPS 2-6: the transaction
// ============================================================================
function runTransfer(v) {
  const { senderId, receiverId, amount, journalType, createdByUserId, idempotencyKeyId, referenceNote, reversalOfId } = v;

  return withTransaction(async (client) => {
    // Lock both accounts in a fixed order (prevents deadlocks).
    const lockResult = await client.query(
      `SELECT id, user_id, type, cached_balance_paise, status
         FROM accounts
        WHERE id IN ($1, $2)
        ORDER BY id ASC
        FOR NO KEY UPDATE`,
      [senderId, receiverId]
    );
    if (lockResult.rows.length !== 2) {
      throw new LedgerError('ACCOUNT_NOT_FOUND', 'One or both accounts do not exist.', 404);
    }
    const sender = lockResult.rows.find((r) => r.id.toLowerCase() === senderId);
    const receiver = lockResult.rows.find((r) => r.id.toLowerCase() === receiverId);

    // Idempotent replay: if this key already produced a journal, return it untouched.
    // Must come BEFORE any balance / limit check (the first attempt may have spent the funds).
    // Safe against races: a concurrent duplicate waits on the account locks above, then sees the commit.
    if (idempotencyKeyId) {
      const already = await loadJournalByIdempotencyKey(idempotencyKeyId, client);
      if (already) return already;
    }

    // ---- Reversal validation ------------------------------------------------
    if (journalType === 'REVERSAL') {
      const origRes = await client.query(
        `SELECT id, status, type FROM journal_transactions WHERE id = $1 FOR NO KEY UPDATE`,
        [reversalOfId]
      );
      if (origRes.rows.length === 0) {
        throw new LedgerError('ORIGINAL_JOURNAL_NOT_FOUND', 'Original transaction to reverse does not exist.', 404);
      }
      const orig = origRes.rows[0];
      if (orig.type === 'REVERSAL') {
        throw new LedgerError('CANNOT_REVERSE_REVERSAL', 'A reversal cannot itself be reversed.', 422);
      }
      if (orig.status === 'REVERSED') {
        throw new LedgerError('ALREADY_REVERSED', 'This transaction has already been reversed.', 409);
      }
      if (orig.status !== 'COMPLETED') {
        throw new LedgerError('CANNOT_REVERSE_NON_COMPLETED', `Cannot reverse a transaction with status ${orig.status}.`, 422);
      }

      const entries = await client.query(
        `SELECT account_id, direction, amount_paise FROM ledger_entries WHERE journal_id = $1`,
        [reversalOfId]
      );
      const origDebit = entries.rows.find((e) => e.direction === 'DEBIT');
      const origCredit = entries.rows.find((e) => e.direction === 'CREDIT');

      if (
        !origDebit || !origCredit ||
        origDebit.account_id.toLowerCase() !== receiverId ||
        origCredit.account_id.toLowerCase() !== senderId
      ) {
        throw new LedgerError('REVERSAL_ACCOUNT_MISMATCH', 'Reversal accounts must be the exact inverse of the original.', 422);
      }
      if (BigInt(origDebit.amount_paise) !== amount) {
        throw new LedgerError('REVERSAL_AMOUNT_MISMATCH', 'Reversal amount must equal the original amount.', 422);
      }
    }

    // ---- Account state, ownership, type rules -------------------------------
    // NOTE (product decision): reversals are also blocked for frozen accounts
    // and insufficient balance. Relax here if ops needs to refund frozen accounts.
    if (sender.status !== 'ACTIVE') {
      throw new LedgerError('ACCOUNT_FROZEN', `Sender account is not active (${sender.status}).`, 403);
    }
    if (receiver.status !== 'ACTIVE') {
      // Generic on purpose: don't leak the other party's account state.
      throw new LedgerError('RECEIVER_UNAVAILABLE', 'Receiver cannot accept funds right now.', 422);
    }

    if (OWNER_CHECKED_TYPES.has(journalType) && sender.user_id !== createdByUserId) {
      throw new LedgerError('NOT_ACCOUNT_OWNER', 'You do not own the sending account.', 403);
    }

    // Account-type rules (REVERSAL is exempt: it just inverts the original).
    if (journalType !== 'REVERSAL') {
      const rule = ACCOUNT_TYPE_RULES[journalType];
      if (!rule.sender.includes(sender.type)) {
        throw new LedgerError('INVALID_SENDER_TYPE', `Sender account type is not allowed for ${journalType}.`, 403);
      }
      if (!rule.receiver.includes(receiver.type)) {
        throw new LedgerError('INVALID_RECEIVER_TYPE', `Receiver account type is not allowed for ${journalType}.`, 403);
      }
    }

    // ---- Balance ------------------------------------------------------------
    if (sender.cached_balance_paise < amount) {
      throw new LedgerError('INSUFFICIENT_FUNDS', 'Insufficient account balance to complete this transfer.', 422);
    }

    // ---- Daily velocity (UPI types only), inside the lock -------------------
    if (UPI_TYPES.has(journalType)) {
      if (amount > DAILY_UPI_LIMIT_PAISE) {
        throw new LedgerError('DAILY_LIMIT_EXCEEDED', 'Single transaction exceeds ₹1,00,000 daily UPI limit.', 422);
      }

      const vel = await client.query(
        `SELECT COALESCE(SUM(le.amount_paise), 0)::BIGINT AS daily_spent_paise,
                COUNT(*)::BIGINT AS daily_tx_count
           FROM ledger_entries le
           JOIN journal_transactions jt ON jt.id = le.journal_id
          WHERE le.account_id = $1
            AND le.direction = 'DEBIT'
            AND jt.status = 'COMPLETED'
            AND jt.type IN ('P2P_TRANSFER', 'QR_MERCHANT_PAY', 'COLLECT_TRANSFER')
            AND le.created_at >= date_trunc('day', CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'`,
        [senderId]
      );
      const spent = BigInt(vel.rows[0].daily_spent_paise);
      const count = BigInt(vel.rows[0].daily_tx_count);

      if (count >= DAILY_UPI_TX_COUNT_LIMIT) {
        throw new LedgerError('TX_COUNT_LIMIT_EXCEEDED', 'Maximum 20 UPI transfers per day reached.', 422);
      }
      if (spent + amount > DAILY_UPI_LIMIT_PAISE) {
        throw new LedgerError('DAILY_LIMIT_EXCEEDED', 'Transfer would exceed your ₹1,00,000 daily UPI limit.', 422);
      }
    }

    // ---- Write double-entry rows -------------------------------------------
    const newSenderBalance = BigInt(sender.cached_balance_paise) - amount;
    const newReceiverBalance = BigInt(receiver.cached_balance_paise) + amount;

    const journalInsert = await client.query(
      `INSERT INTO journal_transactions
         (idempotency_key_id, type, status, reversal_of_id, created_by_user_id, reference_note)
       VALUES ($1, $2, 'COMPLETED', $3, $4, $5)
       RETURNING id, type, status, created_at`,
      [idempotencyKeyId, journalType, reversalOfId, createdByUserId, referenceNote]
    );
    const journal = journalInsert.rows[0];

    if (journalType === 'REVERSAL') {
      await client.query(`UPDATE journal_transactions SET status = 'REVERSED' WHERE id = $1`, [reversalOfId]);
    }

    await client.query(
      `INSERT INTO ledger_entries (journal_id, account_id, direction, amount_paise, running_balance_paise)
       VALUES ($1, $2, 'DEBIT',  $3, $4),
              ($1, $5, 'CREDIT', $3, $6)`,
      [journal.id, senderId, amount, newSenderBalance, receiverId, newReceiverBalance]
    );

    await client.query(
      `UPDATE accounts
          SET cached_balance_paise = CASE WHEN id = $1 THEN $3::BIGINT WHEN id = $2 THEN $4::BIGINT END
        WHERE id IN ($1, $2)`,
      [senderId, receiverId, newSenderBalance, newReceiverBalance]
    );

    return formatResult({
      journal, senderId, receiverId, amount,
      senderBalance: newSenderBalance, receiverBalance: newReceiverBalance,
      note: referenceNote, reversalOfId,
    });
  });
}

// ============================================================================
// Rebuild the original result when an idempotency key already has a journal.
// ============================================================================
async function loadJournalByIdempotencyKey(idempotencyKeyId, db = { query }) {
  const j = await db.query(
    `SELECT id, type, status, reversal_of_id, reference_note, created_at
       FROM journal_transactions WHERE idempotency_key_id = $1`,
    [idempotencyKeyId]
  );
  if (j.rows.length === 0) return null;
  const journal = j.rows[0];

  const e = await db.query(
    `SELECT account_id, direction, amount_paise, running_balance_paise
       FROM ledger_entries WHERE journal_id = $1`,
    [journal.id]
  );
  const debit = e.rows.find((r) => r.direction === 'DEBIT');
  const credit = e.rows.find((r) => r.direction === 'CREDIT');
  if (!debit || !credit) return null;

  return formatResult({
    journal,
    senderId: debit.account_id.toLowerCase(),
    receiverId: credit.account_id.toLowerCase(),
    amount: BigInt(debit.amount_paise),
    senderBalance: BigInt(debit.running_balance_paise),
    receiverBalance: BigInt(credit.running_balance_paise),
    note: journal.reference_note,
    reversalOfId: journal.reversal_of_id,
  });
}

module.exports = {
  LedgerError,
  executeJournalTransfer,
  parseAmountPaise,
  DAILY_UPI_LIMIT_PAISE,
  DAILY_UPI_TX_COUNT_LIMIT,
  MAX_NOTE_LENGTH,
};
