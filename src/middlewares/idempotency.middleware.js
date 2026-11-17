'use strict';

const crypto = require('crypto');
const { query } = require('../config/db');

const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
const REPLAYED_HEADER = 'x-idempotent-replayed';
const MAX_KEY_LENGTH = 255;
const MIN_KEY_LENGTH = 8;
const STALE_THRESHOLD_MS = 5 * 60 * 1000;

// Fields that must not affect the request hash (e.g. a retry with the same
// payment but a re-typed MPIN is still the same request).
const HASH_IGNORED_FIELDS = new Set(['mpin']);

// ---------------------------------------------------------------------------
// What gets cached (replayed forever) vs. released (retry re-runs the handler)
//   cached  : 2xx and deterministic 4xx
//   released: 3xx, 408, 429, 5xx
// ---------------------------------------------------------------------------
function isCacheable(status) {
  if (status >= 200 && status < 300) return true;
  if (status >= 400 && status < 500) return status !== 408 && status !== 429;
  return false;
}

function stableStringify(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(stableStringify).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

function stripIgnored(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body || {};
  const copy = {};
  for (const k of Object.keys(body)) if (!HASH_IGNORED_FIELDS.has(k)) copy[k] = body[k];
  return copy;
}

function computeRequestHash(method, originalUrl, body) {
  const canonical = [method.toUpperCase(), originalUrl, stableStringify(stripIgnored(body))].join('\n');
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

// x-user-id is a DEV-ONLY convenience. Anything other than exactly
// NODE_ENV=development is treated as production.
function getUserId(req) {
  if (req.user?.id) return req.user.id;
  if (process.env.NODE_ENV === 'development') return req.headers['x-user-id'] || null;
  return null;
}

// ---------------------------------------------------------------------------
// Persistence helpers (never throw)
// ---------------------------------------------------------------------------
async function finalizeKey(id, attempt, statusCode, payload) {
  try {
    const finalStatus = statusCode >= 400 ? 'FAILED' : 'COMPLETED';
    await query(
      `UPDATE idempotency_keys
          SET status = $2, status_code = $3, response_payload = $4
        WHERE id = $1 AND attempt = $5 AND status = 'IN_PROGRESS'`,
      [id, finalStatus, statusCode, payload != null ? JSON.stringify(payload) : null, attempt]
    );
  } catch (err) {
    console.error(`[CRITICAL] Failed to finalize idempotency key ${id}:`, err.message);
  }
}

// "Released" = FAILED with status_code NULL. This is the marker that tells a
// released row (retry allowed) apart from a finished empty-body 4xx (replay).
async function releaseKey(id, attempt) {
  try {
    await query(
      `UPDATE idempotency_keys
          SET status = 'FAILED', status_code = NULL, response_payload = NULL
        WHERE id = $1 AND attempt = $2 AND status = 'IN_PROGRESS'`,
      [id, attempt]
    );
  } catch (err) {
    console.error(`[CRITICAL] Failed to release idempotency key ${id}:`, err.message);
  }
}

// ---------------------------------------------------------------------------
// Wrap res.send / res.end. The result is saved BEFORE the client receives the
// response, so an immediate retry can never see a stale IN_PROGRESS row.
// No 'close' handler on purpose: Node does not cancel the handler when the
// client disconnects, so releasing the key there would allow double execution.
// ---------------------------------------------------------------------------
function trackResponse(req, res, id, attempt) {
  req.idempotencyKeyId = id;

  const originalSend = res.send.bind(res);
  const originalEnd = res.end.bind(res);
  let captured = false;

  res.send = function (body) {
    if (captured) return originalSend(body);
    captured = true;

    const status = res.statusCode;
    const cacheable = isCacheable(status) && !Buffer.isBuffer(body);

    let payload = body;
    if (typeof body === 'string') {
      try { payload = JSON.parse(body); } catch { /* keep string */ }
    }

    const done = cacheable ? finalizeKey(id, attempt, status, payload) : releaseKey(id, attempt);
    done.finally(() => originalSend(body));
    return res;
  };

  res.end = function (chunk, encoding, callback) {
    if (captured) return originalEnd(chunk, encoding, callback);
    captured = true;

    const status = res.statusCode;
    const hasBody = chunk && typeof chunk !== 'function';
    const cacheable = isCacheable(status) && !hasBody; // can't replay an unseen body

    const done = cacheable ? finalizeKey(id, attempt, status, null) : releaseKey(id, attempt);
    done.finally(() => originalEnd(chunk, encoding, callback));
    return res;
  };
}

function replay(res, status, payload) {
  res.setHeader(REPLAYED_HEADER, 'true');
  return payload != null ? res.status(status).json(payload) : res.status(status).end();
}

const INSERT_SQL = `
  INSERT INTO idempotency_keys (user_id, key, request_hash, status)
  VALUES ($1, $2, $3, 'IN_PROGRESS')
  ON CONFLICT (user_id, key) DO NOTHING
  RETURNING id, attempt`;

const inProgress409 = (res) =>
  res.status(409).json({
    error: { code: 'IDEMPOTENCY_IN_PROGRESS', message: 'Request is being processed. Retry shortly.' },
  });

// ---------------------------------------------------------------------------
async function idempotencyMiddleware(req, res, next) {
  try {
    const key = req.headers[IDEMPOTENCY_KEY_HEADER];

    if (!key) {
      return res.status(400).json({
        error: { code: 'MISSING_IDEMPOTENCY_KEY', message: `The '${IDEMPOTENCY_KEY_HEADER}' header is required.` },
      });
    }
    if (typeof key !== 'string' || key.length < MIN_KEY_LENGTH || key.length > MAX_KEY_LENGTH) {
      return res.status(400).json({
        error: { code: 'INVALID_IDEMPOTENCY_KEY', message: `Key must be ${MIN_KEY_LENGTH}-${MAX_KEY_LENGTH} characters.` },
      });
    }

    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required.' } });
    }

    const requestHash = computeRequestHash(req.method, req.originalUrl, req.body);

    // A) Brand-new key: atomically claim it.
    let claimed = (await query(INSERT_SQL, [userId, key, requestHash])).rows[0];
    if (claimed) {
      trackResponse(req, res, claimed.id, claimed.attempt);
      return next();
    }

    // B) Key exists.
    let existing = (
      await query(
        `SELECT id, status, request_hash, response_payload, status_code, attempt
           FROM idempotency_keys WHERE user_id = $1 AND key = $2`,
        [userId, key]
      )
    ).rows[0];

    // Row deleted by cleanup between INSERT and SELECT: try to claim again.
    if (!existing) {
      claimed = (await query(INSERT_SQL, [userId, key, requestHash])).rows[0];
      if (claimed) {
        trackResponse(req, res, claimed.id, claimed.attempt);
        return next();
      }
      return inProgress409(res);
    }

    // Same key, different request.
    if (existing.request_hash !== requestHash) {
      return res.status(422).json({
        error: { code: 'IDEMPOTENCY_KEY_REUSE', message: 'Key was used with a different request. Generate a new key.' },
      });
    }

    // IN_PROGRESS: only take over if the lock is stale (age checked in SQL, so
    // app/DB clock skew is irrelevant). Only one concurrent caller can win.
    if (existing.status === 'IN_PROGRESS') {
      const takeover = (
        await query(
          `UPDATE idempotency_keys
              SET locked_at = CURRENT_TIMESTAMP, attempt = attempt + 1
            WHERE id = $1
              AND status = 'IN_PROGRESS'
              AND locked_at < CURRENT_TIMESTAMP - ($2 * INTERVAL '1 millisecond')
            RETURNING id, attempt`,
          [existing.id, STALE_THRESHOLD_MS]
        )
      ).rows[0];

      if (takeover) {
        trackResponse(req, res, takeover.id, takeover.attempt);
        return next();
      }
      return inProgress409(res);
    }

    // COMPLETED: never re-run. Replay status (+ body if there was one).
    if (existing.status === 'COMPLETED') {
      return replay(res, existing.status_code || 200, existing.response_payload);
    }

    // FAILED
    if (existing.status === 'FAILED') {
      // Released (5xx / 429 / etc.): status_code is NULL -> retry is allowed.
      if (existing.status_code == null) {
        const takeover = (
          await query(
            `UPDATE idempotency_keys
                SET locked_at = CURRENT_TIMESTAMP, attempt = attempt + 1, status = 'IN_PROGRESS'
              WHERE id = $1 AND attempt = $2 AND status = 'FAILED' AND status_code IS NULL
              RETURNING id, attempt`,
            [existing.id, existing.attempt]
          )
        ).rows[0];

        if (takeover) {
          trackResponse(req, res, takeover.id, takeover.attempt);
          return next();
        }
        return inProgress409(res);
      }

      // Finished deterministic 4xx (with or without a body): replay it.
      return replay(res, existing.status_code, existing.response_payload);
    }

    return res.status(500).json({
      error: { code: 'IDEMPOTENCY_UNKNOWN_STATE', message: `Unknown status: ${existing.status}` },
    });
  } catch (err) {
    console.error('[CRITICAL] Idempotency middleware error:', err.message);
    return next(err);
  }
}

module.exports = { idempotencyMiddleware, computeRequestHash, stableStringify };
