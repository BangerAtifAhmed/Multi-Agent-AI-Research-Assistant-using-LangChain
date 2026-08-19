import { query } from '../config/database.js';

/**
 * Conversations. Every statement carries user_id, so a conversation id that
 * belongs to another user simply does not match.
 */

const toConversation = (row) =>
  row && {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    mode: row.mode,
    pinned: row.pinned ?? false,
    pinnedAt: row.pinned_at ?? null,
    documentId: row.document_id ?? null,
    documentName: row.document_name ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messageCount: row.message_count !== undefined ? Number(row.message_count) : undefined,
    ...(row.snippet !== undefined ? { snippet: row.snippet } : {}),
    ...(row.match_source !== undefined ? { matchedIn: row.match_source } : {}),
  };

const SELECT_WITH_COUNTS = `
  SELECT c.*,
         d.name AS document_name,
         (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
  FROM conversations c
  LEFT JOIN documents d ON d.id = c.document_id AND d.user_id = c.user_id
`;

export async function createConversation({
  userId,
  title = 'New chat',
  mode = 'document',
  documentId = null,
}) {
  const { rows } = await query(
    `INSERT INTO conversations (user_id, title, mode, document_id)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [userId, title, mode, documentId],
  );
  return getConversation(userId, rows[0].id);
}

export async function listConversations(userId) {
  // Pinned first, then most recently updated.
  const { rows } = await query(
    `${SELECT_WITH_COUNTS}
     WHERE c.user_id = $1
     ORDER BY c.pinned DESC, c.pinned_at DESC NULLS LAST, c.updated_at DESC`,
    [userId],
  );
  return rows.map(toConversation);
}

/**
 * Full-text-ish search across the caller's own conversations.
 *
 * Matches the title and the body of any message in the conversation. The
 * `user_id = $1` predicate is part of every branch, so one user's search can
 * never reach another user's conversations or messages.
 */
export async function searchConversations(userId, term, limit = 30) {
  const pattern = `%${term}%`;

  const { rows } = await query(
    `WITH matches AS (
       SELECT c.id,
              -- A title hit outranks a message hit.
              MAX(CASE WHEN c.title ILIKE $2 THEN 2 ELSE 1 END) AS rank,
              MAX(CASE WHEN c.title ILIKE $2 THEN 'title' ELSE 'message' END) AS match_source,
              (ARRAY_AGG(m.content ORDER BY m.created_at DESC)
                 FILTER (WHERE m.content ILIKE $2))[1] AS snippet
       FROM conversations c
       LEFT JOIN messages m ON m.conversation_id = c.id
       WHERE c.user_id = $1
         AND (c.title ILIKE $2 OR m.content ILIKE $2)
       GROUP BY c.id
     )
     SELECT c.*,
            d.name AS document_name,
            (SELECT COUNT(*) FROM messages m2 WHERE m2.conversation_id = c.id) AS message_count,
            matches.match_source,
            matches.snippet
     FROM matches
     JOIN conversations c ON c.id = matches.id
     LEFT JOIN documents d ON d.id = c.document_id AND d.user_id = c.user_id
     WHERE c.user_id = $1
     ORDER BY c.pinned DESC, matches.rank DESC, c.updated_at DESC
     LIMIT $3`,
    [userId, pattern, limit],
  );

  return rows.map((row) => {
    const conversation = toConversation(row);
    // Trim the matching message down to a short preview around the term.
    if (conversation.snippet) {
      const text = conversation.snippet;
      const index = text.toLowerCase().indexOf(term.toLowerCase());
      const start = Math.max(0, index - 40);
      conversation.snippet =
        (start > 0 ? '…' : '') + text.slice(start, start + 160).trim() +
        (start + 160 < text.length ? '…' : '');
    }
    return conversation;
  });
}

/** Pins or unpins a conversation the caller owns. */
export async function setPinned(userId, conversationId, pinned) {
  const { rows } = await query(
    `UPDATE conversations
     SET pinned = $3,
         pinned_at = CASE WHEN $3 THEN now() ELSE NULL END
     WHERE id = $1 AND user_id = $2
     RETURNING id`,
    [conversationId, userId, pinned],
  );
  if (!rows.length) return null;
  return getConversation(userId, conversationId);
}

export async function getConversation(userId, conversationId) {
  const { rows } = await query(`${SELECT_WITH_COUNTS} WHERE c.id = $1 AND c.user_id = $2`, [
    conversationId,
    userId,
  ]);
  return toConversation(rows[0]);
}

export async function updateConversation(userId, conversationId, patch = {}) {
  const { rows } = await query(
    `UPDATE conversations
     SET title       = COALESCE($3, title),
         mode        = COALESCE($4, mode),
         document_id = CASE WHEN $5::boolean THEN $6::uuid ELSE document_id END,
         updated_at  = now()
     WHERE id = $1 AND user_id = $2
     RETURNING id`,
    [
      conversationId,
      userId,
      patch.title ?? null,
      patch.mode ?? null,
      Object.prototype.hasOwnProperty.call(patch, 'documentId'),
      patch.documentId ?? null,
    ],
  );
  if (!rows.length) return null;
  return getConversation(userId, conversationId);
}

export async function touchConversation(userId, conversationId) {
  await query('UPDATE conversations SET updated_at = now() WHERE id = $1 AND user_id = $2', [
    conversationId,
    userId,
  ]);
}

export async function deleteConversation(userId, conversationId) {
  const { rowCount } = await query('DELETE FROM conversations WHERE id = $1 AND user_id = $2', [
    conversationId,
    userId,
  ]);
  return rowCount > 0;
}

export default {
  createConversation,
  listConversations,
  searchConversations,
  setPinned,
  getConversation,
  updateConversation,
  touchConversation,
  deleteConversation,
};
