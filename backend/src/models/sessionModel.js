import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';

import config from '../config/index.js';
import { query } from '../config/database.js';
import { withRedis } from '../config/redis.js';

/**
 * Server-side sessions.
 *
 * Postgres is the source of truth, so logout is a real revocation rather than
 * just dropping a cookie, and a session survives a Redis restart. Redis caches
 * the session -> user lookup so the hot path avoids a database round trip.
 *
 * The cookie value is `<id>.<hmac>`: the HMAC (keyed by SESSION_SECRET) means a
 * forged or tampered id is rejected before any database query happens.
 */

const CACHE_TTL_SECONDS = 600;
const cacheKey = (id) => `session:${id}`;

const sign = (id) =>
  createHmac('sha256', config.auth.sessionSecret).update(id).digest('base64url');

export function serializeToken(id) {
  return `${id}.${sign(id)}`;
}

/** Returns the session id if the token's signature is valid, otherwise null. */
export function parseToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;

  const index = token.lastIndexOf('.');
  const id = token.slice(0, index);
  const signature = token.slice(index + 1);
  if (!id || !signature) return null;

  const expected = sign(id);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  return id;
}

export async function createSession({ userId, userAgent, ip }) {
  const id = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + config.auth.sessionTtlDays * 24 * 60 * 60 * 1000);

  await query(
    `INSERT INTO sessions (id, user_id, user_agent, ip, expires_at) VALUES ($1, $2, $3, $4, $5)`,
    [id, userId, (userAgent || '').slice(0, 400) || null, (ip || '').slice(0, 60) || null, expiresAt],
  );

  return { id, token: serializeToken(id), expiresAt };
}

/** Resolves a session id to its user, via Redis when possible. */
export async function resolveSession(sessionId) {
  const cached = await withRedis((redis) => redis.get(cacheKey(sessionId)));
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (new Date(parsed.expiresAt) > new Date()) return parsed;
    } catch {
      /* fall through to the database */
    }
  }

  const { rows } = await query(
    `SELECT s.id, s.expires_at, u.id AS user_id, u.name, u.email, u.avatar_url
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.id = $1 AND s.expires_at > now()
     LIMIT 1`,
    [sessionId],
  );

  const row = rows[0];
  if (!row) return null;

  const session = {
    sessionId: row.id,
    expiresAt: row.expires_at,
    user: {
      id: row.user_id,
      name: row.name,
      email: row.email,
      avatarUrl: row.avatar_url ?? null,
    },
  };

  await withRedis((redis) =>
    redis.set(cacheKey(sessionId), JSON.stringify(session), CACHE_TTL_SECONDS),
  );

  return session;
}

export async function destroySession(sessionId) {
  await query('DELETE FROM sessions WHERE id = $1', [sessionId]);
  await withRedis((redis) => redis.del(cacheKey(sessionId)));
}

/** Invalidates every session for a user (password change, "log out everywhere"). */
export async function destroyUserSessions(userId) {
  const { rows } = await query('DELETE FROM sessions WHERE user_id = $1 RETURNING id', [userId]);
  await withRedis((redis) =>
    rows.length ? redis.del(...rows.map((row) => cacheKey(row.id))) : null,
  );
  return rows.length;
}

export async function purgeExpiredSessions() {
  const { rowCount } = await query('DELETE FROM sessions WHERE expires_at <= now()');
  return rowCount;
}

export default {
  createSession,
  resolveSession,
  destroySession,
  destroyUserSessions,
  purgeExpiredSessions,
  serializeToken,
  parseToken,
};
