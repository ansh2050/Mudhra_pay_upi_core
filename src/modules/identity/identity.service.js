'use strict';

// DEV-ONLY verifyMpin stub — Role 2 will replace this with real bcrypt + lockout.
// Checks mpin against DEV_MPIN env var (default '1234').
// Gated on NODE_ENV === 'development' || NODE_ENV === 'test'. No bcrypt, no lockout (Role 2).

const DEV_MPIN = process.env.DEV_MPIN || '1234';

async function verifyMpin(userId, mpin) {
  if (process.env.NODE_ENV !== 'development' && process.env.NODE_ENV !== 'test') {
    return false;
  }
  return Boolean(mpin && String(mpin) === DEV_MPIN);
}

module.exports = { verifyMpin };
