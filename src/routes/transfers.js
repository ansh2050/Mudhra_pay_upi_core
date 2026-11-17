'use strict';

const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const { verifyMpin } = require('../services/auth/mpin');
const { idempotencyMiddleware } = require('../middlewares/idempotency');
const { executeJournalTransfer, LedgerError } = require('../modules/ledger-core/ledger.service');

const router = Router();

// POST /api/v1/ledger/transfer
// Pipeline: authenticate → verifyMpin → idempotencyMiddleware → handler
router.post(
  '/',
  authenticate,
  verifyMpin,
  idempotencyMiddleware,
  async (req, res, next) => {
    try {
      const {
        debitAccountId,
        creditAccountId,
        amountPaise,
        journalType,
        referenceNote,
        reversalOfId,
      } = req.body;

      const result = await executeJournalTransfer({
        debitAccountId,
        creditAccountId,
        amountPaise: typeof amountPaise === 'string' ? amountPaise : amountPaise,
        journalType,
        createdByUserId: req.user.id,
        idempotencyKeyId: req.idempotencyKeyId || null,
        referenceNote: referenceNote || null,
        reversalOfId: reversalOfId || null,
      });

      return res.status(201).json(result);
    } catch (err) {
      return next(err);
    }
  }
);

module.exports = router;
