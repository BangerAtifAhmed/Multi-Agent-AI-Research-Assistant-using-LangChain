import config from '../config/index.js';
import { query } from '../config/database.js';

/**
 * pgvector similarity search.
 *
 * The ownership filter (`user_id = $2`) is part of the same statement as the
 * vector search, so retrieval physically cannot reach another user's chunks.
 * There is no post-filtering step that could be skipped.
 */

/** pgvector's text input format for a vector literal. */
const toVectorLiteral = (embedding) => `[${embedding.join(',')}]`;

export async function searchChunks({
  userId,
  embedding,
  embeddingModel = null,
  limit = config.retrieval.k,
  fetchLimit = config.retrieval.fetchK,
  documentIds = null,
  maxDistance = config.retrieval.maxDistance,
}) {
  const vector = toVectorLiteral(embedding);
  const params = [vector, userId, Math.max(limit, fetchLimit)];

  let documentFilter = '';
  if (Array.isArray(documentIds) && documentIds.length) {
    params.push(documentIds);
    documentFilter = `AND c.document_id = ANY($${params.length}::uuid[])`;
  }

  // Vectors are only comparable within one embedding space, so a query
  // embedded by model A must never be matched against chunks written by
  // model B - even when both are 768-dimensional.
  let modelFilter = '';
  if (embeddingModel) {
    params.push(embeddingModel);
    modelFilter = `AND c.embedding_model = $${params.length}`;
  }

  const { rows } = await query(
    `SELECT c.id,
            c.document_id,
            c.chunk_index,
            c.content,
            c.metadata,
            -- The filename the user recognises, not the stripped display name.
            d.original_filename AS document_name,
            c.embedding <=> $1::vector AS distance
     FROM document_chunks c
     JOIN documents d ON d.id = c.document_id
     WHERE c.user_id = $2
       AND d.status = 'ready'
       ${documentFilter}
       ${modelFilter}
     ORDER BY c.embedding <=> $1::vector
     LIMIT $3`,
    params,
  );

  const relevant = rows.filter((row) => Number(row.distance) <= maxDistance);
  // Never return nothing purely because of the threshold: fall back to the best
  // matches so the model still gets context to work with.
  const kept = (relevant.length ? relevant : rows).slice(0, limit);

  return kept.map((row, index) => {
    const metadata = row.metadata ?? {};
    const distance = Number(row.distance);
    const name = metadata.documentName || row.document_name;

    return {
      index: index + 1,
      type: 'document',
      chunkId: row.id,
      documentId: row.document_id,
      documentName: name,
      title: name,
      // Per-format locators. Only the ones the extractor actually produced are
      // included, so a citation never shows an invented page or slide.
      ...(metadata.page != null ? { page: metadata.page } : {}),
      ...(metadata.slide != null ? { slide: metadata.slide } : {}),
      ...(metadata.paragraph != null ? { paragraph: metadata.paragraph } : {}),
      ...(metadata.line != null ? { line: metadata.line } : {}),
      ...(metadata.table != null ? { table: metadata.table } : {}),
      ...(metadata.section ? { section: metadata.section } : {}),
      ...(metadata.title ? { slideTitle: metadata.title } : {}),
      chunkIndex: row.chunk_index,
      content: row.content,
      snippet: row.content.slice(0, 600),
      // Cosine distance -> similarity, for normalised embeddings.
      score: Number((1 - distance).toFixed(4)),
      distance: Number(distance.toFixed(4)),
    };
  });
}

export async function countChunks(userId) {
  const { rows } = await query(
    'SELECT COUNT(*)::int AS total FROM document_chunks WHERE user_id = $1',
    [userId],
  );
  return rows[0]?.total ?? 0;
}

export default { searchChunks, countChunks, toVectorLiteral };
