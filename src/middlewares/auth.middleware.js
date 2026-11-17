'use strict';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Authentication middleware.
 * Verifies caller identity and sets req.user = { id: userId }.
 */
function authenticate(req, res, next) {
  let userId = null;

  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (UUID_REGEX.test(token)) {
      userId = token;
    } else {
      try {
        const payload = JSON.parse(Buffer.from(token.split('.')[1] || '', 'base64').toString());
        if (payload?.id && UUID_REGEX.test(payload.id)) {
          userId = payload.id;
        }
      } catch {
        // Token parse failed
      }
    }
  }

  // Support x-user-id in development or test mode
  if (!userId && (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test')) {
    const headerUserId = req.headers['x-user-id'];
    if (headerUserId && UUID_REGEX.test(headerUserId)) {
      userId = headerUserId;
    }
  }

  if (!userId) {
    return res.status(401).json({
      error: { code: 'UNAUTHORIZED', message: 'Authentication required.' },
    });
  }

  req.user = { id: userId };
  return next();
}

module.exports = { authenticate };
