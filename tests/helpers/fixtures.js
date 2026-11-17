'use strict';

// ADAPT THIS FILE to your schema. It is the only place tests touch table columns.
const crypto = require('crypto');
const { query } = require('../../src/config/db');

async function createUser(id = crypto.randomUUID()) {
  // ADAPT: add every NOT NULL column your users table needs (phone, name, ...).
  await query('INSERT INTO users (id) VALUES ($1)', [id]);
  return id;
}

async function createAccount({ type = 'USER_SAVINGS', balance = 0n, status = 'ACTIVE', userId } = {}) {
  const owner = userId || (await createUser());
  const id = crypto.randomUUID();
  // ADAPT: if only ONE vault may exist, reuse the seeded vault instead of creating a new one.
  await query(
    `INSERT INTO accounts (id, user_id, type, cached_balance_paise, status) VALUES ($1, $2, $3, $4, $5)`,
    [id, owner, type, balance.toString(), status]
  );
  return { id, userId: owner };
}

async function createIdempotencyKeyRow(userId) {
  const r = await query(
    `INSERT INTO idempotency_keys (user_id, key, request_hash, status)
     VALUES ($1, $2, $3, 'IN_PROGRESS') RETURNING id`,
    [userId, crypto.randomUUID(), 'a'.repeat(64)]
  );
  return r.rows[0].id;
}

module.exports = { createUser, createAccount, createIdempotencyKeyRow };
