import bcrypt from 'bcryptjs';

import config from '../config/index.js';
import userModel, { toPublicUser } from '../models/userModel.js';
import sessionModel from '../models/sessionModel.js';
import ApiError from '../utils/ApiError.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 200;

export function validateSignupInput({ name, email, password, confirmPassword }) {
  const cleanName = String(name ?? '').trim();
  const cleanEmail = String(email ?? '').trim().toLowerCase();

  if (cleanName.length < 2 || cleanName.length > 80) {
    throw ApiError.badRequest('Name must be between 2 and 80 characters.', 'INVALID_NAME');
  }
  if (!EMAIL_PATTERN.test(cleanEmail)) {
    throw ApiError.badRequest('Enter a valid email address.', 'INVALID_EMAIL');
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw ApiError.badRequest(
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
      'WEAK_PASSWORD',
    );
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw ApiError.badRequest('Password is too long.', 'WEAK_PASSWORD');
  }
  if (confirmPassword !== undefined && password !== confirmPassword) {
    throw ApiError.badRequest('Passwords do not match.', 'PASSWORD_MISMATCH');
  }

  return { name: cleanName, email: cleanEmail, password };
}

export async function signup({ name, email, password, confirmPassword }) {
  const clean = validateSignupInput({ name, email, password, confirmPassword });

  const existing = await userModel.findByEmail(clean.email);
  if (existing) {
    // Deliberately explicit: the signup form needs to tell the user what to do,
    // and email existence is already discoverable through this endpoint.
    throw ApiError.conflict(
      existing.google_id && !existing.password_hash
        ? 'That email is already registered with Google. Continue with Google to sign in.'
        : 'An account with that email already exists.',
      'EMAIL_TAKEN',
    );
  }

  const passwordHash = await bcrypt.hash(clean.password, config.auth.bcryptRounds);
  const user = await userModel.createUser({
    name: clean.name,
    email: clean.email,
    passwordHash,
  });

  return toPublicUser(user);
}

export async function login({ email, password }) {
  const cleanEmail = String(email ?? '').trim().toLowerCase();
  const invalid = ApiError.unauthorized('Incorrect email or password.', 'INVALID_CREDENTIALS');

  if (!cleanEmail || typeof password !== 'string' || !password) throw invalid;

  const user = await userModel.findByEmail(cleanEmail);

  // Always run a hash comparison so a missing account and a wrong password take
  // a similar amount of time.
  const hash = user?.password_hash ?? '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin';
  const matches = await bcrypt.compare(password, hash);

  if (!user || !user.password_hash || !matches) {
    if (user && !user.password_hash) {
      throw ApiError.unauthorized(
        'That account uses Google sign-in. Continue with Google instead.',
        'USE_GOOGLE_LOGIN',
      );
    }
    throw invalid;
  }

  return toPublicUser(user);
}

/**
 * Finds or creates the user behind a verified Google profile.
 *
 * Linking rule: an existing email/password account is linked to the Google
 * identity only when Google reports the email as verified. The password is left
 * untouched, so linking never removes an existing authentication method.
 */
export async function findOrCreateGoogleUser(profile) {
  const googleId = String(profile.sub || '').trim();
  const email = String(profile.email || '').trim().toLowerCase();

  if (!googleId) {
    throw ApiError.badRequest('Google did not return an account id.', 'GOOGLE_NO_SUBJECT');
  }

  const byGoogleId = await userModel.findByGoogleId(googleId);
  if (byGoogleId) return { user: toPublicUser(byGoogleId), created: false, linked: false };

  if (!email) {
    throw ApiError.badRequest('Google did not return an email address.', 'GOOGLE_NO_EMAIL');
  }

  const byEmail = await userModel.findByEmail(email);
  if (byEmail) {
    if (!profile.email_verified) {
      throw ApiError.conflict(
        'An account with that email already exists. Sign in with your password first, then link Google.',
        'EMAIL_NOT_VERIFIED',
      );
    }
    const linked = await userModel.linkGoogleAccount(byEmail.id, {
      googleId,
      avatarUrl: profile.picture ?? null,
      name: profile.name ?? byEmail.name,
    });
    return { user: toPublicUser(linked), created: false, linked: true };
  }

  const created = await userModel.createUser({
    name: profile.name || email.split('@')[0],
    email,
    googleId,
    avatarUrl: profile.picture ?? null,
  });

  return { user: toPublicUser(created), created: true, linked: false };
}

export async function createUserSession(userId, { userAgent, ip } = {}) {
  return sessionModel.createSession({ userId, userAgent, ip });
}

export function cookieOptions(expiresAt) {
  return {
    httpOnly: true,
    secure: config.auth.cookieSecure,
    sameSite: config.auth.cookieSameSite,
    domain: config.auth.cookieDomain,
    path: '/',
    expires: expiresAt,
  };
}

export default {
  signup,
  login,
  findOrCreateGoogleUser,
  createUserSession,
  cookieOptions,
  validateSignupInput,
};
