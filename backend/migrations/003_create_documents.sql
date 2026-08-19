CREATE TABLE IF NOT EXISTS documents (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  mime_type         TEXT NOT NULL,
  file_size         BIGINT NOT NULL,
  storage_key       TEXT NOT NULL,
  content_hash      TEXT,
  status            TEXT NOT NULL DEFAULT 'pending',
  error_message     TEXT,
  chunk_count       INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT documents_status_check
    CHECK (status IN ('pending', 'processing', 'ready', 'failed'))
);

CREATE INDEX IF NOT EXISTS documents_user_idx ON documents (user_id, created_at DESC);

-- The same file uploaded twice by one user is one document (per-user, so two
-- users uploading the same PDF still get separate private copies).
CREATE UNIQUE INDEX IF NOT EXISTS documents_user_content_key
  ON documents (user_id, content_hash)
  WHERE content_hash IS NOT NULL;
