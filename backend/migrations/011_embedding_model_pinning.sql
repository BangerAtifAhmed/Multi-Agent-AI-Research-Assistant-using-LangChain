-- Records which embedding model produced each chunk.
--
-- Vector similarity is only meaningful within one embedding space. Two models
-- can both output 768 dimensions and still be completely incomparable, so
-- retrieval filters on this column: a query embedded by model A can never match
-- a chunk embedded by model B. Mixing becomes impossible by construction rather
-- than by configuration discipline.
--
-- The default backfills every existing row with the model that actually wrote
-- them (the local all-mpnet-base-v2). The Hugging Face API serving that same
-- model returns identical vectors, so it shares this identifier and existing
-- vectors remain usable after switching to EMBEDDING_PROVIDER=api.
ALTER TABLE document_chunks
  ADD COLUMN IF NOT EXISTS embedding_model TEXT NOT NULL
  DEFAULT 'sentence-transformers/all-mpnet-base-v2';

-- Retrieval always filters by (user_id, embedding_model).
CREATE INDEX IF NOT EXISTS document_chunks_user_model_idx
  ON document_chunks (user_id, embedding_model);
