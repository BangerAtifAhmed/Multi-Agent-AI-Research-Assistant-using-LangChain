import config from '../config/index.js';
import sessionModel from '../models/sessionModel.js';
import ApiError from '../utils/ApiError.js';

/**
 * Resolves the session cookie into `req.user`.
 *
 * The user's identity always comes from the signed cookie and the sessions
 * table - never from a body or query parameter. Anything a client sends about
 * "who they are" is ignored.
 */
async function loadSession(req) {
  const token = req.cookies?.[config.auth.cookieName];
  if (!token) return null;

  const sessionId = sessionModel.parseToken(token);
  if (!sessionId) return null;

  return sessionModel.resolveSession(sessionId);
}

/** Populates req.user when a valid session exists; never rejects. */
export async function attachUser(req, res, next) {
  try {
    const session = await loadSession(req);
    if (session) {
      req.user = session.user;
      req.sessionId = session.sessionId;
    }
  } catch {
    /* an unreadable session is simply an anonymous request */
  }
  next();
}

/** Rejects the request unless a valid session is present. */
export async function requireAuth(req, res, next) {
  try {
    if (!req.user) {
      const session = await loadSession(req);
      if (!session) {
        // Clear a stale cookie so the browser stops sending it.
        res.clearCookie(config.auth.cookieName, { path: '/' });
        throw ApiError.unauthorized('You must be signed in to do that.', 'NOT_AUTHENTICATED');
      }
      req.user = session.user;
      req.sessionId = session.sessionId;
    }
    next();
  } catch (error) {
    next(error);
  }
}

export default { attachUser, requireAuth };
