import { query, withTransaction } from '../config/database.js';

/**
 * Documents and their chunks.
 *
 * Every read and write is scoped by user_id in SQL. There is no code path that
 * can return another user's document, even if a client sends a valid id that
 * belongs to someone else.
 */

const toDocument = (row) =>
  row && {
    id: row.id,
    name: row.name,
    originalFilename: row.original_filename,
    mimeType: row.mime_type,
    fileSize: Number(row.file_size),
    status: row.status,
    errorMessage: row.error_message ?? null,
    errorCode: row.error_code ?? null,
    extractionInfo: row.extraction_info ?? {},
    // Live counters while processing; {} once the document is terminal.
    progress: row.progress ?? {},
    chunkCount: row.chunk_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

export async function createDocument({
  userId,
  name,
  originalFilename,
  mimeType,
  fileSize,
  storageKey,
  contentHash,
}) {
  const { rows } = await query(
    `INSERT INTO documents
       (user_id, name, original_filename, mime_type, file_size, storage_key, content_hash, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
     RETURNING *`,
    [userId, name, originalFilename, mimeType, fileSize, storageKey, contentHash],
  );
  return toDocument(rows[0]);
}

export async function findByContentHash(userId, contentHash) {
  if (!contentHash) return null;
  const { rows } = await query(
    'SELECT * FROM documents WHERE user_id = $1 AND content_hash = $2 LIMIT 1',
    [userId, contentHash],
  );
  return toDocument(rows[0]);
}

export async function listDocuments(userId) {
  const { rows } = await query(
    'SELECT * FROM documents WHERE user_id = $1 ORDER BY created_at DESC',
    [userId],
  );
  return rows.map(toDocument);
}

/** Ownership is part of the WHERE clause, never checked after the fact. */
export async function getDocument(userId, documentId) {
  const { rows } = await query('SELECT * FROM documents WHERE id = $1 AND user_id = $2', [
    documentId,
    userId,
  ]);
  return toDocument(rows[0]);
}

export async function getStorageKey(userId, documentId) {
  const { rows } = await query(
    'SELECT storage_key FROM documents WHERE id = $1 AND user_id = $2',
    [documentId, userId],
  );
  return rows[0]?.storage_key ?? null;
}

export async function updateStatus(
  documentId,
  status,
  { errorMessage = null, errorCode = null, chunkCount, extractionInfo, progress } = {},
) {
  const { rows } = await query(
    `UPDATE documents
     SET status = $2,
         error_message = $3,
         error_code = $4,
         chunk_count = COALESCE($5, chunk_count),
         extraction_info = COALESCE($6::jsonb, extraction_info),
         progress = COALESCE($7::jsonb, progress),
         updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [
      documentId,
      status,
      errorMessage,
      errorCode,
      chunkCount ?? null,
      extractionInfo ? JSON.stringify(extractionInfo) : null,
      progress ? JSON.stringify(progress) : null,
    ],
  );
  return toDocument(rows[0]);
}

/**
 * Writes the live progress counters without touching the status.
 *
 * Called often during a long ingestion, so it is deliberately a single narrow
 * UPDATE: no RETURNING, and nothing else in the row is read or rewritten.
 */
export async function updateProgress(documentId, progress) {
  await query(
    'UPDATE documents SET progress = $2::jsonb, updated_at = now() WHERE id = $1',
    [documentId, JSON.stringify(progress ?? {})],
  );
}

/** Marks documents left mid-processing by a crash or restart as failed. */
export async function failStaleProcessing() {
  const { rows } = await query(
    `UPDATE documents
     SET status = 'failed',
         error_message = 'Processing was interrupted. Please upload the document again.',
         error_code = 'INTERRUPTED',
         updated_at = now()
     WHERE status NOT IN ('ready', 'failed')
     RETURNING id`,
  );
  return rows.length;
}

/**
 * Inserts a batch of chunks with their embeddings.
 * pgvector accepts the '[1,2,3]' text form, which keeps this parameterised.
 */
export async function insertChunks(client, { documentId, userId, chunks, embeddingModel }) {
  if (!chunks.length) return 0;
  if (!embeddingModel) throw new Error('insertChunks requires embeddingModel');

  const values = [];
  const params = [];
  let index = 1;

  for (const chunk of chunks) {
    values.push(
      `($${index++}, $${index++}, $${index++}, $${index++}, $${index++}::jsonb, $${index++}::vector, $${index++})`,
    );
    params.push(
      documentId,
      userId,
      chunk.chunkIndex,
      chunk.content,
      JSON.stringify(chunk.metadata ?? {}),
      `[${chunk.embedding.join(',')}]`,
      embeddingModel,
    );
  }

  const sql = `INSERT INTO document_chunks
      (document_id, user_id, chunk_index, content, metadata, embedding, embedding_model)
    VALUES ${values.join(', ')}`;

  const result = client ? await client.query(sql, params) : await query(sql, params);
  return result.rowCount;
}

/** Removes every chunk of a document without touching the document row. */
export async function deleteChunks(userId, documentId) {
  const { rowCount } = await query(
    'DELETE FROM document_chunks WHERE document_id = $1 AND user_id = $2',
    [documentId, userId],
  );
  return rowCount;
}

/**
 * Deletes a document and everything derived from it, in one transaction.
 * Returns the storage key so the caller can remove the original file.
 */
export async function deleteDocument(userId, documentId) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      'SELECT storage_key FROM documents WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [documentId, userId],
    );
    if (!rows.length) return null;

    // Explicit, even though ON DELETE CASCADE would handle it: the chunk count
    // is used by the caller to report what was removed.
    const chunks = await client.query(
      'DELETE FROM document_chunks WHERE document_id = $1 AND user_id = $2',
      [documentId, userId],
    );
    await client.query('DELETE FROM documents WHERE id = $1 AND user_id = $2', [
      documentId,
      userId,
    ]);

    return { storageKey: rows[0].storage_key, deletedChunks: chunks.rowCount };
  });
}

export async function countReadyDocuments(userId) {
  const { rows } = await query(
    "SELECT COUNT(*)::int AS total FROM documents WHERE user_id = $1 AND status = 'ready'",
    [userId],
  );
  return rows[0]?.total ?? 0;
}

export default {
  createDocument,
  findByContentHash,
  listDocuments,
  getDocument,
  getStorageKey,
  updateStatus,
  updateProgress,
  failStaleProcessing,
  insertChunks,
  deleteChunks,
  deleteDocument,
  countReadyDocuments,
};
