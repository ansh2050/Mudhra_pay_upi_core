'use strict';

const { pool, closePool } = require('../src/config/db');
const { executeJournalTransfer, LedgerError } = require('../src/modules/ledger-core/ledger.service');
const { SEED_IDS } = require('./seed');

// ============================================================================
// HELPER: Asserts SUM(Credits) - SUM(Debits) === 0 across the entire ledger
// ============================================================================
async function assertZeroSum(stepName) {
  const res = await pool.query(`
    SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount_paise ELSE -amount_paise END), 0)::BIGINT AS net_sum
    FROM ledger_entries
  `);
  const netSum = res.rows[0].net_sum;
  if (netSum !== 0n) {
    throw new Error(`CRITICAL ZERO-SUM VIOLATION after [${stepName}]: net_sum = ${netSum.toString()}`);
  }
}

// ============================================================================
// HELPER: Asserts that a specific error code is thrown
// ============================================================================
async function expectError(testName, expectedCode, fn) {
  try {
    await fn();
    throw new Error(`${testName}: Expected error ${expectedCode} but no error was thrown!`);
  } catch (err) {
    if (err instanceof LedgerError && err.code === expectedCode) {
      console.log(`  ✅ ${testName}: correctly blocked with ${expectedCode}`);
    } else if (err.code === expectedCode) {
      console.log(`  ✅ ${testName}: correctly blocked with ${expectedCode}`);
    } else {
      throw new Error(`${testName}: Expected ${expectedCode} but got ${err.code || 'UNKNOWN'}: ${err.message}`);
    }
  }
}

// ============================================================================
// MAIN VERIFICATION SUITE — 8 TEST GROUPS, 16 SUB-TESTS
// ============================================================================
async function verifyLedger() {
  console.log('\n🔍 Mudhra_pay Core Ledger 10/10 Verification Suite');
  console.log('   8 test groups · 16 sub-tests · zero-sum after every step\n');

  try {
    // ------------------------------------------------------------------------
    // PRE-TEST: Check daily transaction count and warn if approaching limit
    // ------------------------------------------------------------------------
    const dailyCountRes = await pool.query(
      `SELECT COUNT(*)::BIGINT AS count
       FROM ledger_entries le
       INNER JOIN journal_transactions jt ON jt.id = le.journal_id
       WHERE le.account_id = $1
         AND le.direction = 'DEBIT'
         AND jt.status = 'COMPLETED'
         AND jt.type IN ('P2P_TRANSFER', 'QR_MERCHANT_PAY', 'COLLECT_TRANSFER')
         AND le.created_at >= date_trunc('day', CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'`,
      [SEED_IDS.ANSH_ACCOUNT_ID]
    );
    const anshDailyCount = dailyCountRes.rows[0].count;
    if (anshDailyCount >= 15n) {
      console.log(`⚠️  WARNING: Ansh already has ${anshDailyCount} debits today (limit: 20).`);
      console.log(`   Test 1 uses enforceDailyLimit: true. If close to limit, tests may fail.`);
      console.log(`   To reset: docker compose down -v && docker compose up -d && node scripts/migrate.js && node scripts/seed.js\n`);
    } else {
      console.log(`ℹ️  Ansh has ${anshDailyCount} debits today. Safe to run tests.\n`);
    }

    // ========================================================================
    // TEST 1: Valid P2P Transfer (Ansh → Rahul ₹500)
    // ========================================================================
    console.log('▶ Test 1: P2P Transfer');
    const tx = await executeJournalTransfer({
      debitAccountId: SEED_IDS.ANSH_ACCOUNT_ID,
      creditAccountId: SEED_IDS.RAHUL_ACCOUNT_ID,
      amountPaise: 500_00n,
      journalType: 'P2P_TRANSFER',
      createdByUserId: SEED_IDS.ANSH_USER_ID,
      referenceNote: 'Smoke test P2P lunch split',
    });
    await assertZeroSum('Test 1: P2P Transfer');
    console.log(`  ✅ P2P ₹500 succeeded — journal: ${tx.journalId}`);
    console.log(`     Ansh: ${tx.senderClosingBalancePaise.toString()} paise | Rahul: ${tx.receiverClosingBalancePaise.toString()} paise\n`);

    // ========================================================================
    // TEST 2: Full Atomic Reversal / Refund (Rahul → Ansh ₹500)
    // ========================================================================
    console.log('▶ Test 2: Atomic Reversal');
    const rev = await executeJournalTransfer({
      debitAccountId: SEED_IDS.RAHUL_ACCOUNT_ID,
      creditAccountId: SEED_IDS.ANSH_ACCOUNT_ID,
      amountPaise: 500_00n,
      journalType: 'REVERSAL',
      reversalOfId: tx.journalId,
      createdByUserId: SEED_IDS.RAHUL_USER_ID,
      referenceNote: 'Full refund of smoke test transfer',
    });
    await assertZeroSum('Test 2: Reversal');
    console.log(`  ✅ Reversal ₹500 succeeded — journal: ${rev.journalId}`);
    console.log(`     Original journal ${tx.journalId} now marked REVERSED\n`);

    // ========================================================================
    // TEST 3: Overdraft Rejection (Edge Case D1 & A4)
    // ========================================================================
    console.log('▶ Test 3: Overdraft Rejection');
    await expectError('3a: Overdraft blocked', 'INSUFFICIENT_FUNDS', () =>
      executeJournalTransfer({
        debitAccountId: SEED_IDS.ANSH_ACCOUNT_ID,
        creditAccountId: SEED_IDS.RAHUL_ACCOUNT_ID,
        amountPaise: 999_999_00n,
        journalType: 'P2P_TRANSFER',
        createdByUserId: SEED_IDS.ANSH_USER_ID,
        referenceNote: 'Should fail - overdraft',
      })
    );
    await assertZeroSum('Test 3: Overdraft Rejection');
    console.log('');

    // ========================================================================
    // TEST 4: Self-Transfer Rejection (Edge Case A6)
    // ========================================================================
    console.log('▶ Test 4: Self-Transfer Rejection');
    await expectError('4a: Self-transfer blocked', 'SELF_TRANSFER_NOT_ALLOWED', () =>
      executeJournalTransfer({
        debitAccountId: SEED_IDS.ANSH_ACCOUNT_ID,
        creditAccountId: SEED_IDS.ANSH_ACCOUNT_ID,
        amountPaise: 100_00n,
        journalType: 'P2P_TRANSFER',
        createdByUserId: SEED_IDS.ANSH_USER_ID,
        referenceNote: 'Should fail - self transfer',
      })
    );
    await assertZeroSum('Test 4: Self-Transfer Rejection');
    console.log('');

    // ========================================================================
    // TEST 5: Bidirectional Concurrent Transfers (Edge Case A3)
    // Uses enforceDailyLimit: false — testing concurrency, not velocity
    // ========================================================================
    console.log('▶ Test 5: Bidirectional Concurrency (6 simultaneous transfers)');
    const concurrentPromises = [];
    for (let i = 0; i < 6; i++) {
      const isAnshToRahul = i % 2 === 0;
      concurrentPromises.push(
        executeJournalTransfer({
          debitAccountId: isAnshToRahul ? SEED_IDS.ANSH_ACCOUNT_ID : SEED_IDS.RAHUL_ACCOUNT_ID,
          creditAccountId: isAnshToRahul ? SEED_IDS.RAHUL_ACCOUNT_ID : SEED_IDS.ANSH_ACCOUNT_ID,
          amountPaise: 100_00n,
          journalType: 'P2P_TRANSFER',
          createdByUserId: isAnshToRahul ? SEED_IDS.ANSH_USER_ID : SEED_IDS.RAHUL_USER_ID,
          referenceNote: `Concurrency test #${i + 1}`,
          enforceDailyLimit: false, // ← Don't increment daily count (testing deadlocks, not velocity)
        })
      );
    }

    const results = await Promise.allSettled(concurrentPromises);
    const successes = results.filter((r) => r.status === 'fulfilled').length;
    const failures = results.filter((r) => r.status === 'rejected');

    if (failures.length > 0) {
      console.error(`  ⚠️  ${failures.length} concurrent transfers failed:`);
      failures.forEach((f) => console.error(`     - ${f.reason?.code || 'ERR'}: ${f.reason?.message}`));
    }

    if (successes !== 6) {
      throw new Error(`Test 5: Only ${successes}/6 concurrent transfers succeeded`);
    }

    await assertZeroSum('Test 5: Bidirectional Concurrency');
    console.log(`  ✅ 6/6 simultaneous A↔B transfers succeeded — 0 deadlocks\n`);

    // ========================================================================
    // TEST 6: Immutability Trigger Enforcement (DELETE + UPDATE + TRUNCATE)
    // ========================================================================
    console.log('▶ Test 6: Immutability Triggers (3 operations blocked)');

    // 6a: DELETE blocked
    try {
      await pool.query('DELETE FROM ledger_entries WHERE journal_id = $1', [tx.journalId]);
      throw new Error('DELETE was allowed!');
    } catch (err) {
      if (!err.message.includes('Ledger immutability')) {
        throw new Error(`6a: Expected immutability violation but got: ${err.message}`);
      }
      console.log('  ✅ 6a: DELETE blocked by trigger');
    }

    // 6b: UPDATE blocked
    try {
      await pool.query('UPDATE ledger_entries SET amount_paise = 999999 WHERE journal_id = $1', [tx.journalId]);
      throw new Error('UPDATE was allowed!');
    } catch (err) {
      if (!err.message.includes('Ledger immutability')) {
        throw new Error(`6b: Expected immutability violation but got: ${err.message}`);
      }
      console.log('  ✅ 6b: UPDATE blocked by trigger');
    }

    // 6c: TRUNCATE blocked (statement-level trigger)
    try {
      await pool.query('TRUNCATE ledger_entries');
      throw new Error('TRUNCATE was allowed!');
    } catch (err) {
      if (!err.message.includes('Ledger immutability')) {
        throw new Error(`6c: Expected immutability violation but got: ${err.message}`);
      }
      console.log('  ✅ 6c: TRUNCATE blocked by trigger');
    }

    await assertZeroSum('Test 6: Immutability Triggers');
    console.log('');

    // ========================================================================
    // TEST 7: Input Validation (6 sub-tests — all fail before any DB write)
    // ========================================================================
    console.log('▶ Test 7: Input Validation (6 sub-tests)');

    // 7a: Invalid UUID
    await expectError('7a: Invalid UUID', 'INVALID_ACCOUNT_ID', () =>
      executeJournalTransfer({
        debitAccountId: 'not-a-uuid',
        creditAccountId: SEED_IDS.RAHUL_ACCOUNT_ID,
        amountPaise: 100_00n,
        journalType: 'P2P_TRANSFER',
        createdByUserId: SEED_IDS.ANSH_USER_ID,
      })
    );

    // 7b: Invalid journalType
    await expectError('7b: Invalid journalType', 'INVALID_JOURNAL_TYPE', () =>
      executeJournalTransfer({
        debitAccountId: SEED_IDS.ANSH_ACCOUNT_ID,
        creditAccountId: SEED_IDS.RAHUL_ACCOUNT_ID,
        amountPaise: 100_00n,
        journalType: 'HACK',
        createdByUserId: SEED_IDS.ANSH_USER_ID,
      })
    );

    // 7c: Zero amount
    await expectError('7c: Zero amount', 'INVALID_AMOUNT', () =>
      executeJournalTransfer({
        debitAccountId: SEED_IDS.ANSH_ACCOUNT_ID,
        creditAccountId: SEED_IDS.RAHUL_ACCOUNT_ID,
        amountPaise: 0n,
        journalType: 'P2P_TRANSFER',
        createdByUserId: SEED_IDS.ANSH_USER_ID,
      })
    );

    // 7d: Float amount
    await expectError('7d: Float amount', 'INVALID_AMOUNT', () =>
      executeJournalTransfer({
        debitAccountId: SEED_IDS.ANSH_ACCOUNT_ID,
        creditAccountId: SEED_IDS.RAHUL_ACCOUNT_ID,
        amountPaise: 10.999,
        journalType: 'P2P_TRANSFER',
        createdByUserId: SEED_IDS.ANSH_USER_ID,
      })
    );

    // 7e: Too-long reference note (> 500 chars)
    await expectError('7e: Note too long', 'NOTE_TOO_LONG', () =>
      executeJournalTransfer({
        debitAccountId: SEED_IDS.ANSH_ACCOUNT_ID,
        creditAccountId: SEED_IDS.RAHUL_ACCOUNT_ID,
        amountPaise: 100_00n,
        journalType: 'P2P_TRANSFER',
        createdByUserId: SEED_IDS.ANSH_USER_ID,
        referenceNote: 'x'.repeat(501),
      })
    );

    // 7f: Non-vault account trying to send DEPOSIT
    await expectError('7f: Non-vault DEPOSIT', 'INVALID_DEPOSIT_SENDER', () =>
      executeJournalTransfer({
        debitAccountId: SEED_IDS.ANSH_ACCOUNT_ID,
        creditAccountId: SEED_IDS.RAHUL_ACCOUNT_ID,
        amountPaise: 100_00n,
        journalType: 'DEPOSIT',
        createdByUserId: SEED_IDS.ANSH_USER_ID,
      })
    );

    await assertZeroSum('Test 7: Input Validation');
    console.log('');

    // ========================================================================
    // TEST 8: Reversal Validation Edge Cases (4 sub-tests)
    // ========================================================================
    console.log('▶ Test 8: Reversal Edge Cases (4 sub-tests)');

    // Create a fresh transfer specifically for reversal edge case testing
    const edgeTx = await executeJournalTransfer({
      debitAccountId: SEED_IDS.ANSH_ACCOUNT_ID,
      creditAccountId: SEED_IDS.RAHUL_ACCOUNT_ID,
      amountPaise: 100_00n,
      journalType: 'P2P_TRANSFER',
      createdByUserId: SEED_IDS.ANSH_USER_ID,
      referenceNote: 'Reversal edge case base transfer',
      enforceDailyLimit: false,
    });
    console.log(`  ℹ️  Created edge-case test transfer: ${edgeTx.journalId}`);

    // 8a: Reversal with WRONG accounts (same direction as original, not flipped)
    await expectError('8a: Wrong accounts', 'REVERSAL_ACCOUNT_MISMATCH', () =>
      executeJournalTransfer({
        debitAccountId: SEED_IDS.ANSH_ACCOUNT_ID,     // Should be Rahul (original receiver)
        creditAccountId: SEED_IDS.RAHUL_ACCOUNT_ID,  // Should be Ansh (original sender)
        amountPaise: 100_00n,
        journalType: 'REVERSAL',
        reversalOfId: edgeTx.journalId,
        createdByUserId: SEED_IDS.ANSH_USER_ID,
      })
    );

    // 8b: Reversal with WRONG amount (partial refund)
    await expectError('8b: Wrong amount', 'REVERSAL_AMOUNT_MISMATCH', () =>
      executeJournalTransfer({
        debitAccountId: SEED_IDS.RAHUL_ACCOUNT_ID,
        creditAccountId: SEED_IDS.ANSH_ACCOUNT_ID,
        amountPaise: 50_00n,  // Should be 100_00n
        journalType: 'REVERSAL',
        reversalOfId: edgeTx.journalId,
        createdByUserId: SEED_IDS.RAHUL_USER_ID,
      })
    );

    // 8c: Valid reversal (so we can test double-reversal next)
    const edgeRev = await executeJournalTransfer({
      debitAccountId: SEED_IDS.RAHUL_ACCOUNT_ID,
      creditAccountId: SEED_IDS.ANSH_ACCOUNT_ID,
      amountPaise: 100_00n,
      journalType: 'REVERSAL',
      reversalOfId: edgeTx.journalId,
      createdByUserId: SEED_IDS.RAHUL_USER_ID,
      enforceDailyLimit: false,
    });
    console.log(`  ✅ 8c: Valid reversal succeeded: ${edgeRev.journalId}`);

    // 8d: Try to reverse the SAME transaction again (should get ALREADY_REVERSED)
    await expectError('8d: Double reversal', 'ALREADY_REVERSED', () =>
      executeJournalTransfer({
        debitAccountId: SEED_IDS.RAHUL_ACCOUNT_ID,
        creditAccountId: SEED_IDS.ANSH_ACCOUNT_ID,
        amountPaise: 100_00n,
        journalType: 'REVERSAL',
        reversalOfId: edgeTx.journalId,
        createdByUserId: SEED_IDS.RAHUL_USER_ID,
      })
    );

    await assertZeroSum('Test 8: Reversal Edge Cases');
    console.log('');

    // ========================================================================
    // FINAL SUMMARY
    // ========================================================================
    console.log('═══════════════════════════════════════════════════════════');
    console.log('🎉 ALL 8 TEST GROUPS (16 SUB-TESTS) PASSED!');
    console.log('   ✅ P2P Transfer + Zero-Sum');
    console.log('   ✅ Atomic Reversal + Zero-Sum');
    console.log('   ✅ Overdraft Rejection');
    console.log('   ✅ Self-Transfer Rejection');
    console.log('   ✅ Bidirectional Concurrency (0 deadlocks)');
    console.log('   ✅ Immutability Triggers (DELETE + UPDATE + TRUNCATE blocked)');
    console.log('   ✅ Input Validation (6 sub-tests)');
    console.log('   ✅ Reversal Edge Cases (4 sub-tests)');
    console.log('   ✅ Global Zero-Sum = 0 maintained throughout');
    console.log('═══════════════════════════════════════════════════════════\n');
  } catch (err) {
    console.error('\n❌ Verification FAILED:', err.code || '', err.message);
    if (err.stack) {
      console.error('\nStack trace:', err.stack.split('\n').slice(0, 5).join('\n'));
    }
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}

verifyLedger();
