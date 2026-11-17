'use strict';

// DEV-ONLY authenticate stub — Role 2 will replace this with real JWT auth.
// In development/test, reads x-user-id header as UUID.
// In any non-dev context, returns 401.

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function authenticate(req, res, next) {
  if (process.env.NODE_ENV !== 'development' && process.env.NODE_ENV !== 'test') {
    return res.status(401).json({
      error: { code: 'AUTH_REQUIRED', message: 'Authentication is not available outside development mode.' },
    });
  }

  const userId = req.headers['x-user-id'];
  if (!userId || !UUID_REGEX.test(userId)) {
    return res.status(401).json({
      error: { code: 'UNAUTHORIZED', message: 'x-user-id header must be a valid UUID (dev mode).' },
    });
  }

  req.user = { id: userId };
  return next();
}

module.exports = { authenticate };
