'use strict';

const { LedgerError } = require('../modules/ledger-core/ledger.service');

// Must be registered LAST in app.js. Responding through res.json lets the idempotency
// wrapper cache deterministic 4xx and release 5xx.
// eslint-disable-next-line no-unused-vars
module.exports = (err, req, res, next) => {
  if (err instanceof LedgerError) {
    return res.status(err.httpStatus).json({ error: { code: err.code, message: err.message } });
  }
  console.error(err);
  return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong.' } });
};
