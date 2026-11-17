'use strict';

// DEV-ONLY verifyMpin stub — Role 2 will replace this with real bcrypt + lockout.
// Checks req.body.mpin against DEV_MPIN env var (default '1234').
// Gated on NODE_ENV === 'development'. No bcrypt, no failure counting, no lockout.

const DEV_MPIN = process.env.DEV_MPIN || '1234';

async function verifyMpin(req, res, next) {
  if (process.env.NODE_ENV !== 'development') {
    return res.status(401).json({
      error: { code: 'AUTH_REQUIRED', message: 'MPIN verification is not available outside development mode.' },
    });
  }

  const mpin = req.body?.mpin;
  if (!mpin || String(mpin) !== DEV_MPIN) {
    return res.status(403).json({
      error: { code: 'INVALID_MPIN', message: 'Incorrect MPIN.' },
    });
  }

  return next();
}

module.exports = { verifyMpin };
