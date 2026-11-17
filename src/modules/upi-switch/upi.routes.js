'use strict';

const { Router } = require('express');
const { authenticate } = require('../../middlewares/auth.middleware');
const { requireMpin } = require('../../middlewares/mpin.middleware');
const { idempotencyMiddleware } = require('../../middlewares/idempotency.middleware');
const { transfer } = require('./upi.controller');

const router = Router();

// Order: authenticate -> requireMpin -> idempotencyMiddleware -> controller
router.post('/', authenticate, requireMpin, idempotencyMiddleware, transfer);

module.exports = router;
