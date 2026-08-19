import { query, withTransaction } from '../config/database.js';

/**
 * Messages and their citations.
 *
 * Reads join through conversations so that user ownership is enforced by the
 * query itself, not by a separate check the caller could forget.
 */

const toMessage = (row) => ({
  id: row.id,
  conversationId: row.conversation_id,
  role: row.role,
  content: row.content,
  metadata: row.metadata ?? {},
  sources: row.sources ?? [],
  createdAt: row.created_at,
});

const SELECT_MESSAGES = `
  SELECT m.*,
         COALESCE(
           (SELECT json_agg(s.metadata ORDER BY s.position)
            FROM message_sources s
            WHERE s.message_id = m.id),
           '[]'::json
         ) AS sources
  FROM messages m
  JOIN conversations c ON c.id = m.conversation_id
`;

export async function listMessages(userId, conversationId) {
  const { rows } = await query(
    `${SELECT_MESSAGES}
     WHERE m.conversation_id = $1 AND c.user_id = $2
     ORDER BY m.created_at ASC, m.id ASC`,
    [conversationId, userId],
  );
  return rows.map(toMessage);
}

export async function createMessage({
  conversationId,
  role,
  content,
  metadata = {},
  sources = [],
}) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO messages (conversation_id, role, content, metadata)
       VALUES ($1, $2, $3, $4::jsonb)
       RETURNING *`,
      [conversationId, role, content, JSON.stringify(metadata ?? {})],
    );
    const message = rows[0];

    if (sources.length) {
      const values = [];
      const params = [];
      let index = 1;

      for (const [position, source] of sources.entries()) {
        values.push(`($${index++}, $${index++}, $${index++}, $${index++}, $${index++}::jsonb)`);
        params.push(
          message.id,
          source.documentId ?? null,
          source.chunkId ?? null,
          position,
          JSON.stringify(source),
        );
      }

      await client.query(
        `INSERT INTO message_sources (message_id, document_id, chunk_id, position, metadata)
         VALUES ${values.join(', ')}`,
        params,
      );
    }

    return toMessage({ ...message, sources });
  });
}

export async function deleteMessages(userId, conversationId) {
  const { rowCount } = await query(
    `DELETE FROM messages m
     USING conversations c
     WHERE m.conversation_id = c.id AND c.id = $1 AND c.user_id = $2`,
    [conversationId, userId],
  );
  return rowCount;
}

export async function countMessages(userId, conversationId) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS total
     FROM messages m JOIN conversations c ON c.id = m.conversation_id
     WHERE m.conversation_id = $1 AND c.user_id = $2`,
    [conversationId, userId],
  );
  return rows[0]?.total ?? 0;
}

export default { listMessages, createMessage, deleteMessages, countMessages };
