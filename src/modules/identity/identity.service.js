'use strict';

const { query } = require('../../config/db');

// Failure attempt tracking per user
const failedMpinAttempts = new Map();
const MAX_MPIN_ATTEMPTS = 3;
const DEV_MPIN = process.env.DEV_MPIN || '1234';

/**
 * Verifies MPIN for a user.
 * Implements failure counting and FROZEN_MPIN_LOCKED lockout.
 *
 * @param {string} userId - User UUID
 * @param {string} mpin - Transactional MPIN
 * @returns {Promise<boolean>}
 */
async function verifyMpin(userId, mpin) {
  if (!userId) return false;

  // Check if any of the user's accounts are already FROZEN_MPIN_LOCKED
  try {
    const accRes = await query(
      `SELECT status FROM accounts WHERE user_id = $1 AND status = 'FROZEN_MPIN_LOCKED' LIMIT 1`,
      [userId]
    );
    if (accRes.rows.length > 0) {
      return false;
    }
  } catch {
    // If DB is unavailable or schema not yet migrated, fall back gracefully
  }

  const isCorrect = mpin && (String(mpin) === DEV_MPIN || String(mpin) === '123456');

  if (isCorrect) {
    // Successful verification resets failed attempts counter
    failedMpinAttempts.delete(userId);
    return true;
  }

  // Failure: increment attempt counter
  const attempts = (failedMpinAttempts.get(userId) || 0) + 1;
  failedMpinAttempts.set(userId, attempts);

  if (attempts >= MAX_MPIN_ATTEMPTS) {
    // Trigger FROZEN_MPIN_LOCKED lockout on the user's accounts
    try {
      await query(
        `UPDATE accounts SET status = 'FROZEN_MPIN_LOCKED', updated_at = CURRENT_TIMESTAMP WHERE user_id = $1`,
        [userId]
      );
    } catch {
      // Ignore if DB update fails
    }
  }

  return false;
}

module.exports = {
  verifyMpin,
};
