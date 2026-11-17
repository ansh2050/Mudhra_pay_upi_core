'use strict';

// MPIN verification middleware.
// MPIN failure counting / FROZEN_MPIN_LOCKED lockout lives inside identityService.verifyMpin.
const identityService = require('../modules/identity/identity.service');

// Runs BEFORE the idempotency middleware so a wrong MPIN is never cached under a key.
exports.requireMpin = async (req, res, next) => {
  try {
    const ok = await identityService.verifyMpin(req.user?.id, req.body?.mpin);
    if (!ok) {
      return res.status(403).json({ error: { code: 'INVALID_MPIN', message: 'Incorrect MPIN.' } });
    }
    return next();
  } catch (err) {
    return next(err);
  }
};
