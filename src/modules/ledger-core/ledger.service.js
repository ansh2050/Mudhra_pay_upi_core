'use strict';

const { withTransaction } = require('../../config/db');

// ============================================================================
// CUSTOM DOMAIN ERROR FOR STRUCTURED API RESPONSES
// ============================================================================
class LedgerError extends Error {
  /**
   * @param {string} code - Machine-readable error code (e.g., 'INSUFFICIENT_FUNDS')
   * @param {string} message - Human-readable explanation
   * @param {number} [httpStatus=400] - Recommended HTTP status code
   */
  constructor(code, message, httpStatus = 400) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

// ============================================================================
// CONSTANTS & BUSINESS LIMITS
// ============================================================================
const DAILY_UPI_LIMIT_PAISE = 100_000_00n; // ₹1,00,000.00 in paise (10,000,000n)
const DAILY_UPI_TX_COUNT_LIMIT = 20n;      // Max 20 UPI outgoing transfers per day (IST)
const MAX_NOTE_LENGTH = 500;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const VALID_JOURNAL_TYPES = new Set([
  'P2P_TRANSFER',
  'QR_MERCHANT_PAY',
  'COLLECT_TRANSFER',
  'DEPOSIT',
  'WITHDRAWAL',
  'REVERSAL',
]);

/**
 * Executes an atomic, double-entry money transfer between two accounts.
 *
 * ⚠️ ARCHITECTURAL CONTRACT FOR CALLERS (Role 2 & Role 3):
 * 1. MPIN Verification MUST happen BEFORE calling this function (Edge Case C6).
 *    Never run slow bcrypt hashing (~100ms) inside this database lock window!
 * 2. OWNERSHIP VERIFICATION: Role 2's RBAC middleware MUST verify that the
 *    authenticated user actually owns the `debitAccountId` before calling
 *    this function. This function does NOT check ownership — it trusts the
 *    caller. Role 2 is the gatekeeper.
 * 3. DEPOSIT type can ONLY be initiated by SYSTEM_SETTLEMENT_VAULT accounts.
 *    This is enforced inside the transaction (Step 4) after the sender's
 *    account type is read from the database.
 * 4. Returned BigInt fields serialize to strings in JSON/JSONB; convert back
 *    with BigInt() if doing math.
 *
 * @param {Object} params
 * @param {string} params.debitAccountId - Sender account UUID (money leaves here)
 * @param {string} params.creditAccountId - Receiver account UUID (money arrives here)
 * @param {bigint|number|string} params.amountPaise - Transfer amount in integer paise (> 0)
 * @param {string} params.journalType - One of: 'P2P_TRANSFER' | 'QR_MERCHANT_PAY' | 'COLLECT_TRANSFER' | 'DEPOSIT' | 'WITHDRAWAL' | 'REVERSAL'
 * @param {string} params.createdByUserId - UUID of the authenticated user initiating the transfer
 * @param {string|null} [params.idempotencyKeyId=null] - UUID from `idempotency_keys.id`
 * @param {string|null} [params.referenceNote=null] - Optional payment note (max 500 chars)
 * @param {string|null} [params.reversalOfId=null] - If journalType === 'REVERSAL', original journal UUID
 * @param {boolean} [params.enforceDailyLimit=true] - Whether to check ₹1L / 20-tx daily UPI velocity limit
 */
async function executeJournalTransfer({
  debitAccountId,
  creditAccountId,
  amountPaise,
  journalType,
  createdByUserId,
  idempotencyKeyId = null,
  referenceNote = null,
  reversalOfId = null,
  enforceDailyLimit = true,
}) {
  // --------------------------------------------------------------------------
  // STEP 1: Strict Input & UUID Validation (Zero DB I/O)
  // --------------------------------------------------------------------------
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
    throw new LedgerError(
      'INVALID_JOURNAL_TYPE',
      `journalType must be one of: ${Array.from(VALID_JOURNAL_TYPES).join(', ')}`,
      400
    );
  }
  if (journalType === 'REVERSAL' && !reversalOfId) {
    throw new LedgerError('MISSING_REVERSAL_ID', 'reversalOfId is required when journalType is REVERSAL.', 400);
  }
  if (journalType !== 'REVERSAL' && reversalOfId) {
    throw new LedgerError('INVALID_REVERSAL_PARAM', 'reversalOfId can only be set when journalType is REVERSAL.', 400);
  }

  // NEW: Validate referenceNote type and length
  if (referenceNote !== null) {
    if (typeof referenceNote !== 'string') {
      throw new LedgerError('INVALID_NOTE', 'referenceNote must be a string or null.', 400);
    }
    if (referenceNote.length > MAX_NOTE_LENGTH) {
      throw new LedgerError(
        'NOTE_TOO_LONG',
        `referenceNote must be ${MAX_NOTE_LENGTH} characters or fewer (received ${referenceNote.length}).`,
        400
      );
    }
  }

  const senderId = debitAccountId.toLowerCase();
  const receiverId = creditAccountId.toLowerCase();

  if (senderId === receiverId) {
    throw new LedgerError('SELF_TRANSFER_NOT_ALLOWED', 'Sender and receiver accounts cannot be the same.', 422);
  }

  let transferAmount;
  try {
    if (typeof amountPaise === 'number' && !Number.isInteger(amountPaise)) {
      throw new Error('Floating point numbers are forbidden');
    }
    transferAmount = BigInt(amountPaise);
  } catch {
    throw new LedgerError('INVALID_AMOUNT', 'Amount must be a strict integer in paise.', 400);
  }

  if (transferAmount <= 0n) {
    throw new LedgerError('INVALID_AMOUNT', 'Transfer amount must be greater than 0 paise.', 400);
  }

  // --------------------------------------------------------------------------
  // STEP 2: Enter ACID Transaction & Canonical Lock Ordering
  // --------------------------------------------------------------------------
  return withTransaction(async (client) => {
    const sortedAccountIds = [senderId, receiverId].sort();

    const lockResult = await client.query(
      `SELECT id, user_id, type, cached_balance_paise, status
       FROM accounts
       WHERE id IN ($1, $2)
       ORDER BY id ASC
       FOR NO KEY UPDATE`,
      [sortedAccountIds[0], sortedAccountIds[1]]
    );

    if (lockResult.rows.length !== 2) {
      throw new LedgerError('ACCOUNT_NOT_FOUND', 'One or both accounts do not exist.', 404);
    }

    const senderAccount = lockResult.rows.find((row) => row.id.toLowerCase() === senderId);
    const receiverAccount = lockResult.rows.find((row) => row.id.toLowerCase() === receiverId);

    // ------------------------------------------------------------------------
    // STEP 3: Reversal Validation (Edge Cases J1–J7)
    // ------------------------------------------------------------------------
    if (journalType === 'REVERSAL') {
      const origJournalRes = await client.query(
        `SELECT id, status
         FROM journal_transactions
         WHERE id = $1
         FOR NO KEY UPDATE`,
        [reversalOfId]
      );

      if (origJournalRes.rows.length === 0) {
        throw new LedgerError('ORIGINAL_JOURNAL_NOT_FOUND', 'Original transaction to reverse does not exist.', 404);
      }

      const origJournal = origJournalRes.rows[0];
      if (origJournal.status === 'REVERSED') {
        throw new LedgerError('ALREADY_REVERSED', 'This transaction has already been reversed.', 409);
      }
      if (origJournal.status !== 'COMPLETED') {
        throw new LedgerError(
          'CANNOT_REVERSE_NON_COMPLETED',
          `Cannot reverse a transaction with status ${origJournal.status}.`,
          422
        );
      }

      const origEntriesRes = await client.query(
        `SELECT account_id, direction, amount_paise
         FROM ledger_entries
         WHERE journal_id = $1`,
        [reversalOfId]
      );

      const origDebit = origEntriesRes.rows.find((e) => e.direction === 'DEBIT');
      const origCredit = origEntriesRes.rows.find((e) => e.direction === 'CREDIT');

      if (
        !origDebit ||
        !origCredit ||
        origDebit.account_id.toLowerCase() !== receiverId ||
        origCredit.account_id.toLowerCase() !== senderId
      ) {
        throw new LedgerError(
          'REVERSAL_ACCOUNT_MISMATCH',
          'Reversal debit/credit accounts must be the exact inverse of the original transaction.',
          422
        );
      }

      if (origDebit.amount_paise !== transferAmount) {
        throw new LedgerError(
          'REVERSAL_AMOUNT_MISMATCH',
          'Partial or excess refunds are not supported in V1; reversal amount must equal original amount.',
          422
        );
      }
    }

    // ------------------------------------------------------------------------
    // STEP 4: Post-Lock Status, DEPOSIT Authorization & Balance Validation
    // ------------------------------------------------------------------------
    if (senderAccount.status !== 'ACTIVE') {
      throw new LedgerError('ACCOUNT_FROZEN', `Sender account is not active (${senderAccount.status}).`, 403);
    }
    if (receiverAccount.status !== 'ACTIVE') {
      throw new LedgerError('ACCOUNT_FROZEN', `Receiver account is not active (${receiverAccount.status}).`, 403);
    }

    // NEW: Only SYSTEM_SETTLEMENT_VAULT can initiate DEPOSIT transactions
    if (journalType === 'DEPOSIT' && senderAccount.type !== 'SYSTEM_SETTLEMENT_VAULT') {
      throw new LedgerError(
        'INVALID_DEPOSIT_SENDER',
        'Only SYSTEM_SETTLEMENT_VAULT accounts can initiate DEPOSIT transactions.',
        403
      );
    }

    // Uniform balance check for ALL accounts (including vault — ADR #15)
    if (senderAccount.cached_balance_paise < transferAmount) {
      throw new LedgerError('INSUFFICIENT_FUNDS', 'Insufficient account balance to complete this transfer.', 422);
    }

    // ------------------------------------------------------------------------
    // STEP 5: IST Daily Velocity Check Inside Lock (Edge Cases G1–G5)
    // ------------------------------------------------------------------------
    if (enforceDailyLimit && journalType !== 'REVERSAL') {
      if (transferAmount > DAILY_UPI_LIMIT_PAISE) {
        throw new LedgerError('DAILY_LIMIT_EXCEEDED', 'Single transaction exceeds ₹1,00,000 daily UPI limit.', 422);
      }

      const velocityResult = await client.query(
        `SELECT 
           COALESCE(SUM(le.amount_paise), 0)::BIGINT AS daily_spent_paise,
           COUNT(*)::BIGINT AS daily_tx_count
         FROM ledger_entries le
         INNER JOIN journal_transactions jt ON jt.id = le.journal_id
         WHERE le.account_id = $1
           AND le.direction = 'DEBIT'
           AND jt.status = 'COMPLETED'
           AND jt.type IN ('P2P_TRANSFER', 'QR_MERCHANT_PAY', 'COLLECT_TRANSFER')
           AND le.created_at >= date_trunc('day', CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'`,
        [senderId]
      );

      const { daily_spent_paise, daily_tx_count } = velocityResult.rows[0];

      if (daily_tx_count >= DAILY_UPI_TX_COUNT_LIMIT) {
        throw new LedgerError('TX_COUNT_LIMIT_EXCEEDED', 'Maximum 20 UPI transfers per day reached.', 422);
      }

      if (daily_spent_paise + transferAmount > DAILY_UPI_LIMIT_PAISE) {
        throw new LedgerError('DAILY_LIMIT_EXCEEDED', 'Transfer would exceed your ₹1,00,000 daily UPI limit.', 422);
      }
    }

    // ------------------------------------------------------------------------
    // STEP 6: Compute Running Balances & Write Double-Entry Rows
    // ------------------------------------------------------------------------
    const newSenderBalance = senderAccount.cached_balance_paise - transferAmount;
    const newReceiverBalance = receiverAccount.cached_balance_paise + transferAmount;

    const journalInsert = await client.query(
      `INSERT INTO journal_transactions (
         idempotency_key_id,
         type,
         status,
         reversal_of_id,
         created_by_user_id,
         reference_note
       )
       VALUES ($1, $2, 'COMPLETED', $3, $4, $5)
       RETURNING id, type, status, created_at`,
      [idempotencyKeyId, journalType, reversalOfId, createdByUserId, referenceNote]
    );

    const journal = journalInsert.rows[0];

    if (journalType === 'REVERSAL') {
      await client.query(
        `UPDATE journal_transactions SET status = 'REVERSED' WHERE id = $1`,
        [reversalOfId]
      );
    }

    await client.query(
      `INSERT INTO ledger_entries (
         journal_id,
         account_id,
         direction,
         amount_paise,
         running_balance_paise
       )
       VALUES
         ($1, $2, 'DEBIT',  $3, $4),
         ($1, $5, 'CREDIT', $3, $6)`,
      [
        journal.id,
        senderId,
        transferAmount,
        newSenderBalance,
        receiverId,
        newReceiverBalance,
      ]
    );

    await client.query(
      `UPDATE accounts
       SET cached_balance_paise = CASE
         WHEN id = $1 THEN $3::BIGINT
         WHEN id = $2 THEN $4::BIGINT
       END
       WHERE id IN ($1, $2)`,
      [senderId, receiverId, newSenderBalance, newReceiverBalance]
    );

    return {
      journalId: journal.id,
      type: journal.type,
      status: journal.status,
      debitAccountId: senderId,
      creditAccountId: receiverId,
      amountPaise: transferAmount,
      senderClosingBalancePaise: newSenderBalance,
      receiverClosingBalancePaise: newReceiverBalance,
      referenceNote,
      reversalOfId,
      createdAt: journal.created_at,
    };
  });
}

module.exports = {
  LedgerError,
  executeJournalTransfer,
  // Export constants for testing
  DAILY_UPI_LIMIT_PAISE,
  DAILY_UPI_TX_COUNT_LIMIT,
  MAX_NOTE_LENGTH,
};