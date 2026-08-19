import { randomBytes, createHash } from 'node:crypto';

import config from '../config/index.js';
import { withRedis, isRedisReady } from '../config/redis.js';
import ApiError from '../utils/ApiError.js';

/**
 * Google OAuth 2.0 (authorization code flow), handled entirely on the server.
 *
 * The client secret never leaves the backend, the browser only ever sees a
 * redirect, and the `state` parameter is a single-use CSRF token stored
 * server-side. Only the scopes needed to identify the user are requested.
 */

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';

const SCOPES = ['openid', 'email', 'profile'];
const STATE_TTL_SECONDS = 600;

// Fallback store for when Redis is unavailable, so local development still works.
const memoryStates = new Map();

const stateKey = (state) => `oauth:state:${state}`;

export function assertGoogleConfigured() {
  if (!config.google.enabled) {
    throw ApiError.serviceUnavailable(
      'Google sign-in is not configured on this server.',
      'GOOGLE_NOT_CONFIGURED',
    );
  }
}

async function storeState(state, payload) {
  const serialized = JSON.stringify(payload);
  const stored = await withRedis(
    (redis) => redis.set(stateKey(state), serialized, STATE_TTL_SECONDS),
    null,
  );

  if (!stored) {
    memoryStates.set(state, { payload, expiresAt: Date.now() + STATE_TTL_SECONDS * 1000 });
    // Keep the fallback map from growing without bound.
    for (const [key, value] of memoryStates) {
      if (value.expiresAt < Date.now()) memoryStates.delete(key);
    }
  }
}

/** Consumes the state token: a replayed callback finds nothing and is rejected. */
async function consumeState(state) {
  if (!state) return null;

  if (isRedisReady()) {
    const raw = await withRedis(async (redis) => {
      const value = await redis.get(stateKey(state));
      if (value) await redis.del(stateKey(state));
      return value;
    });
    if (raw) {
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    }
  }

  const entry = memoryStates.get(state);
  memoryStates.delete(state);
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry.payload;
}

/** Builds the Google consent URL and the state token that protects it. */
export async function createAuthorizationUrl({ redirectTo } = {}) {
  assertGoogleConfigured();

  const state = randomBytes(32).toString('base64url');
  const nonce = createHash('sha256').update(randomBytes(32)).digest('base64url');

  await storeState(state, { nonce, redirectTo: redirectTo || null, createdAt: Date.now() });

  const params = new URLSearchParams({
    client_id: config.google.clientId,
    redirect_uri: config.google.callbackUrl,
    response_type: 'code',
    scope: SCOPES.join(' '),
    state,
    nonce,
    access_type: 'online',
    prompt: 'select_account',
    include_granted_scopes: 'true',
  });

  return { url: `${AUTH_ENDPOINT}?${params.toString()}`, state };
}

async function exchangeCodeForTokens(code) {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      redirect_uri: config.google.callbackUrl,
      grant_type: 'authorization_code',
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    // The body can echo request parameters; it is logged, never returned.
    const detail = await response.text().catch(() => '');
    throw ApiError.unauthorized(
      'Google sign-in failed. Please try again.',
      'GOOGLE_TOKEN_EXCHANGE_FAILED',
      { detail: detail.slice(0, 300) },
    );
  }

  return response.json();
}

async function fetchProfile(accessToken) {
  const response = await fetch(USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw ApiError.unauthorized(
      'Could not read your Google profile. Please try again.',
      'GOOGLE_PROFILE_FAILED',
    );
  }

  return response.json();
}

/**
 * Validates the callback and returns the verified Google profile.
 * Throws if the state token is missing, unknown, or already used.
 */
export async function handleCallback({ code, state }) {
  assertGoogleConfigured();

  const stored = await consumeState(state);
  if (!stored) {
    throw ApiError.badRequest(
      'This sign-in link is no longer valid. Please try again.',
      'INVALID_OAUTH_STATE',
    );
  }

  if (!code) {
    throw ApiError.badRequest('Google did not return an authorization code.', 'MISSING_CODE');
  }

  const tokens = await exchangeCodeForTokens(code);
  const profile = await fetchProfile(tokens.access_token);

  return {
    profile: {
      sub: profile.sub,
      email: profile.email,
      email_verified: profile.email_verified === true || profile.email_verified === 'true',
      name: profile.name,
      picture: profile.picture,
    },
    redirectTo: stored.redirectTo,
  };
}

export default { createAuthorizationUrl, handleCallback, assertGoogleConfigured };
