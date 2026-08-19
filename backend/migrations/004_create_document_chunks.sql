-- vector(768) matches the existing embedding model exactly:
-- sentence-transformers/all-mpnet-base-v2 produces 768-dimensional,
-- L2-normalised vectors (verified against the running model, not assumed).
CREATE TABLE IF NOT EXISTS document_chunks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  -- user_id is denormalised on purpose: every similarity search filters on it,
  -- so ownership is enforced in the same query that does the vector search.
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  content     TEXT NOT NULL,
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
  embedding   vector(768) NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS document_chunks_document_idx ON document_chunks (document_id);
CREATE INDEX IF NOT EXISTS document_chunks_user_idx ON document_chunks (user_id);

-- Cosine distance (<=>) is the right operator for normalised embeddings.
CREATE INDEX IF NOT EXISTS document_chunks_embedding_idx
  ON document_chunks USING hnsw (embedding vector_cosine_ops);
