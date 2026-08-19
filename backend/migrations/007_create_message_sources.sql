-- Citations attached to an assistant message.
-- document_id / chunk_id are NULL for web results; metadata carries whatever the
-- pipeline actually produced (page, url, title, similarity score, snippet).
CREATE TABLE IF NOT EXISTS message_sources (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id  UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
  chunk_id    UUID REFERENCES document_chunks(id) ON DELETE SET NULL,
  position    INTEGER NOT NULL DEFAULT 0,
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS message_sources_message_idx ON message_sources (message_id, position);
