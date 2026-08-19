import config from '../config/index.js';
import sessionModel from '../models/sessionModel.js';
import userModel, { toPublicUser } from '../models/userModel.js';
import authService from '../services/authService.js';
import googleOAuth from '../services/googleOAuthService.js';
import ApiError from '../utils/ApiError.js';
import logger from '../utils/logger.js';

/** Issues a session and sets the HttpOnly cookie. */
async function establishSession(req, res, user) {
  const session = await authService.createUserSession(user.id, {
    userAgent: req.headers['user-agent'],
    ip: req.ip,
  });
  res.cookie(config.auth.cookieName, session.token, authService.cookieOptions(session.expiresAt));
  return session;
}

export async function signup(req, res) {
  const { name, email, password, confirmPassword } = req.body ?? {};
  const user = await authService.signup({ name, email, password, confirmPassword });
  await establishSession(req, res, user);
  res.status(201).json({ user });
}

export async function login(req, res) {
  const { email, password } = req.body ?? {};
  const user = await authService.login({ email, password });
  await establishSession(req, res, user);
  res.json({ user });
}

export async function logout(req, res) {
  if (req.sessionId) await sessionModel.destroySession(req.sessionId);
  res.clearCookie(config.auth.cookieName, { path: '/', domain: config.auth.cookieDomain });
  res.json({ success: true });
}

export async function me(req, res) {
  const user = await userModel.findById(req.user.id);
  if (!user) throw ApiError.unauthorized();
  res.json({ user: toPublicUser(user) });
}

/** Step 1: redirect the browser to Google's consent screen. */
export async function googleStart(req, res) {
  googleOAuth.assertGoogleConfigured();
  const { url } = await googleOAuth.createAuthorizationUrl({
    redirectTo: typeof req.query.redirectTo === 'string' ? req.query.redirectTo : null,
  });
  res.redirect(url);
}

/**
 * Step 2: Google redirects back here. Verify state, exchange the code, then
 * find-or-create the user and hand the browser back to the frontend.
 */
export async function googleCallback(req, res) {
  const failureUrl = (reason) =>
    `${config.frontendUrl}/login?error=${encodeURIComponent(reason)}`;

  // The user declined consent.
  if (req.query.error) {
    return res.redirect(failureUrl('google_cancelled'));
  }

  try {
    const { profile, redirectTo } = await googleOAuth.handleCallback({
      code: req.query.code,
      state: req.query.state,
    });

    const { user, created, linked } = await authService.findOrCreateGoogleUser(profile);
    await establishSession(req, res, user);

    if (created) logger.info(`new user via Google: ${user.id}`);
    if (linked) logger.info(`linked Google identity to existing user: ${user.id}`);

    const target = new URL(redirectTo || '/', config.frontendUrl);
    // Only ever redirect back to our own frontend.
    if (target.origin !== new URL(config.frontendUrl).origin) {
      return res.redirect(config.frontendUrl);
    }
    return res.redirect(target.toString());
  } catch (error) {
    if (error instanceof ApiError) {
      logger.warn(`google oauth failed: ${error.code} ${error.details?.detail ?? ''}`);
      return res.redirect(failureUrl(error.code || 'google_failed'));
    }
    logger.error('google oauth failed:', error);
    return res.redirect(failureUrl('google_failed'));
  }
}

/** Lets the frontend show or hide the "Continue with Google" button. */
export function authConfig(req, res) {
  res.json({ google: config.google.enabled });
}

export default { signup, login, logout, me, googleStart, googleCallback, authConfig };
