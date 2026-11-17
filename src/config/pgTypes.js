'use strict';

// node-postgres returns BIGINT (int8, OID 20) as a STRING by default.
// The ledger does BigInt math and comparisons, so parse it as BigInt.
// Require this file once at startup (the ledger service already does).
const { types } = require('pg');

types.setTypeParser(20, (value) => BigInt(value));

module.exports = {};
