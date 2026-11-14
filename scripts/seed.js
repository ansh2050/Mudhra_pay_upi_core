'use strict';

const { pool, closePool } = require('../src/config/db');
const { executeJournalTransfer } = require('../src/modules/ledger-core/ledger.service');

// ============================================================================
// FIXED DETERMINISTIC UUIDs FOR DEVELOPMENT & TESTING
// ============================================================================
const SEED_IDS = {
  SYSTEM_USER_ID: '00000000-0000-4000-8000-000000000001',
  VAULT_ACCOUNT_ID: '00000000-0000-4000-8000-000000000010',

  ANSH_USER_ID: '11111111-1111-4111-8111-111111111111',
  ANSH_ACCOUNT_ID: '11111111-1111-4111-8111-111111111112',

  RAHUL_USER_ID: '22222222-2222-4222-8222-222222222221',
  RAHUL_ACCOUNT_ID: '22222222-2222-4222-8222-222222222222',
};

const TARGET_INITIAL_BALANCE_PAISE = 10_000_00n; // ₹10,000.00 in paise
const VAULT_RESERVE_PAISE = 100_000_000_00n;     // ₹100 Crore in paise (10,000,000,000n)

async function runSeed() {
  console.log('🌱 Seeding Mudhra_pay System Vault & Test Accounts...\n');

  try {
    // 1a. Insert the SYSTEM_SETTLEMENT_VAULT with ₹100 Crore reserve
    //     ON CONFLICT DO NOTHING — NEVER overwrite cached_balance_paise outside
    //     executeJournalTransfer! DO UPDATE would create reconciliation drift
    //     (cache modified without a matching ledger entry). With ₹100 Crore,
    //     the vault funds 100,000 test runs without needing a reset.
    await pool.query(
      `INSERT INTO accounts (id, user_id, type, cached_balance_paise, status)
       VALUES ($1, $2, 'SYSTEM_SETTLEMENT_VAULT', $3, 'ACTIVE')
       ON CONFLICT (id) DO NOTHING`,
      [SEED_IDS.VAULT_ACCOUNT_ID, SEED_IDS.SYSTEM_USER_ID, VAULT_RESERVE_PAISE.toString()]
    );

    // 1b. Insert Ansh & Rahul accounts — ON CONFLICT DO NOTHING preserves existing balances
    //     from prior test runs. The top-up logic below handles getting them to baseline.
    await pool.query(
      `INSERT INTO accounts (id, user_id, type, cached_balance_paise, status)
       VALUES 
         ($1, $2, 'USER_SAVINGS', 0, 'ACTIVE'),
         ($3, $4, 'USER_SAVINGS', 0, 'ACTIVE')
       ON CONFLICT (id) DO NOTHING`,
      [
        SEED_IDS.ANSH_ACCOUNT_ID,
        SEED_IDS.ANSH_USER_ID,
        SEED_IDS.RAHUL_ACCOUNT_ID,
        SEED_IDS.RAHUL_USER_ID,
      ]
    );

    // 2. Check both Ansh and Rahul independently and top up to ₹10,000 baseline
    const balancesRes = await pool.query(
      `SELECT id, cached_balance_paise
       FROM accounts
       WHERE id IN ($1, $2)
       ORDER BY id ASC`,
      [SEED_IDS.ANSH_ACCOUNT_ID, SEED_IDS.RAHUL_ACCOUNT_ID]
    );

    for (const row of balancesRes.rows) {
      const accountId = row.id.toLowerCase();
      const isAnsh = accountId === SEED_IDS.ANSH_ACCOUNT_ID;
      const label = isAnsh ? 'Ansh' : 'Rahul';

      const currentBalance = row.cached_balance_paise;
      const topUpAmount = TARGET_INITIAL_BALANCE_PAISE - currentBalance;

      if (topUpAmount > 0n) {
        await executeJournalTransfer({
          debitAccountId: SEED_IDS.VAULT_ACCOUNT_ID,
          creditAccountId: accountId,
          amountPaise: topUpAmount,
          journalType: 'DEPOSIT',
          createdByUserId: SEED_IDS.SYSTEM_USER_ID,
          referenceNote: `Seed top-up to baseline for ${label} (+${topUpAmount.toString()} paise)`,
          enforceDailyLimit: false,
        });
        console.log(`✅ Funded ${label}: +${topUpAmount.toString()} paise → baseline ₹10,000.00 reached`);
      } else {
        console.log(`ℹ️ ${label} already at/above baseline: ${currentBalance.toString()} paise (₹${(currentBalance / 100n).toString()})`);
      }
    }

    // 3. Print live account state table
    const finalState = await pool.query(
      `SELECT id, type, cached_balance_paise, status
       FROM accounts
       WHERE id IN ($1, $2, $3)
       ORDER BY id ASC`,
      [SEED_IDS.VAULT_ACCOUNT_ID, SEED_IDS.ANSH_ACCOUNT_ID, SEED_IDS.RAHUL_ACCOUNT_ID]
    );

    console.log('\n📊 Final Account State:');
    console.table(
      finalState.rows.map((r) => ({
        AccountID: r.id,
        Type: r.type,
        BalancePaise: r.cached_balance_paise.toString(),
        BalanceRupees: (r.cached_balance_paise / 100n).toString(),
        Status: r.status,
      }))
    );
  } catch (err) {
    console.error('\n❌ Seed failed:', err.code || '', err.message);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}

if (require.main === module) {
  runSeed();
}

module.exports = { SEED_IDS };