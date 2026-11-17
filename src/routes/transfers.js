'use strict';

const { Router } = require('express');
const { authenticate } = require('../middlewares/auth.middleware');
const { requireMpin } = require('../middlewares/mpin.middleware');
const { idempotencyMiddleware } = require('../middlewares/idempotency');
const { executeJournalTransfer } = require('../modules/ledger-core/ledger.service');

const router = Router();

// POST /api/v1/ledger/transfer
// Middleware order: authenticate -> requireMpin -> idempotencyMiddleware -> handler
router.post(
  '/',
  authenticate,
  requireMpin,
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
        amountPaise,
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
