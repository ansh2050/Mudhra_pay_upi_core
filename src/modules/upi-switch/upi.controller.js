'use strict';

const { executeJournalTransfer, LedgerError } = require('../ledger-core/ledger.service');

const ALLOWED_CLIENT_JOURNAL_TYPES = new Set(['P2P_TRANSFER', 'QR_MERCHANT_PAY']);

async function transfer(req, res, next) {
  try {
    const {
      debitAccountId,
      creditAccountId,
      amountPaise,
      journalType,
      referenceNote,
    } = req.body || {};

    if (!ALLOWED_CLIENT_JOURNAL_TYPES.has(journalType)) {
      throw new LedgerError(
        'INVALID_JOURNAL_TYPE',
        `Client transfers only allow: ${Array.from(ALLOWED_CLIENT_JOURNAL_TYPES).join(', ')}`,
        400
      );
    }

    const result = await executeJournalTransfer({
      debitAccountId,
      creditAccountId,
      amountPaise,
      journalType,
      createdByUserId: req.user.id,
      idempotencyKeyId: req.idempotencyKeyId || null,
      referenceNote: referenceNote || null,
    });

    return res.status(201).json(result);
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  transfer,
};
