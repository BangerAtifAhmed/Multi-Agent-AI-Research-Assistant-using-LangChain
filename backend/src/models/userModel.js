import { query } from '../config/database.js';

/**
 * Users. Every query is parameterised; email is always compared lower-cased so
 * the unique index and the lookups agree.
 */

const PUBLIC_COLUMNS = 'id, name, email, google_id, avatar_url, created_at, updated_at';

export const toPublicUser = (row) =>
  row && {
    id: row.id,
    name: row.name,
    email: row.email,
    avatarUrl: row.avatar_url ?? null,
    hasPassword: row.password_hash ? true : undefined,
    hasGoogle: row.google_id ? true : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

export async function findByEmail(email) {
  const { rows } = await query(
    `SELECT id, name, email, password_hash, google_id, avatar_url, created_at, updated_at
     FROM users WHERE lower(email) = lower($1) LIMIT 1`,
    [email],
  );
  return rows[0] ?? null;
}

export async function findByGoogleId(googleId) {
  const { rows } = await query(
    `SELECT id, name, email, password_hash, google_id, avatar_url, created_at, updated_at
     FROM users WHERE google_id = $1 LIMIT 1`,
    [googleId],
  );
  return rows[0] ?? null;
}

export async function findById(id) {
  const { rows } = await query(
    `SELECT id, name, email, password_hash, google_id, avatar_url, created_at, updated_at
     FROM users WHERE id = $1 LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function createUser({ name, email, passwordHash = null, googleId = null, avatarUrl = null }) {
  const { rows } = await query(
    `INSERT INTO users (name, email, password_hash, google_id, avatar_url)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${PUBLIC_COLUMNS}, password_hash`,
    [name, email.toLowerCase(), passwordHash, googleId, avatarUrl],
  );
  return rows[0];
}

/** Links a Google identity onto an existing (email/password) account. */
export async function linkGoogleAccount(userId, { googleId, avatarUrl, name }) {
  const { rows } = await query(
    `UPDATE users
     SET google_id = $2,
         avatar_url = COALESCE(avatar_url, $3),
         name = COALESCE(NULLIF(name, ''), $4),
         updated_at = now()
     WHERE id = $1
     RETURNING ${PUBLIC_COLUMNS}, password_hash`,
    [userId, googleId, avatarUrl, name],
  );
  return rows[0];
}

export async function updateProfile(userId, { name, avatarUrl }) {
  const { rows } = await query(
    `UPDATE users
     SET name = COALESCE($2, name),
         avatar_url = COALESCE($3, avatar_url),
         updated_at = now()
     WHERE id = $1
     RETURNING ${PUBLIC_COLUMNS}, password_hash`,
    [userId, name ?? null, avatarUrl ?? null],
  );
  return rows[0] ?? null;
}

export async function setPassword(userId, passwordHash) {
  const { rows } = await query(
    `UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1
     RETURNING ${PUBLIC_COLUMNS}, password_hash`,
    [userId, passwordHash],
  );
  return rows[0] ?? null;
}

export async function getUsageStats(userId) {
  const { rows } = await query(
    `SELECT
       (SELECT COUNT(*) FROM conversations WHERE user_id = $1)                    AS conversations,
       (SELECT COUNT(*) FROM documents WHERE user_id = $1)                        AS documents,
       (SELECT COUNT(*) FROM document_chunks WHERE user_id = $1)                  AS chunks,
       (SELECT COUNT(*) FROM messages m
          JOIN conversations c ON c.id = m.conversation_id
        WHERE c.user_id = $1)                                                     AS messages`,
    [userId],
  );
  const row = rows[0] ?? {};
  return {
    conversations: Number(row.conversations ?? 0),
    documents: Number(row.documents ?? 0),
    chunks: Number(row.chunks ?? 0),
    messages: Number(row.messages ?? 0),
  };
}

export default {
  findByEmail,
  findByGoogleId,
  findById,
  createUser,
  linkGoogleAccount,
  updateProfile,
  setPassword,
  getUsageStats,
  toPublicUser,
};
