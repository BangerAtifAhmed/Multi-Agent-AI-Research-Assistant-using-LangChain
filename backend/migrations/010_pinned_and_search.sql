-- Pinned conversations, conversation search, and automatic query routing.

-- 1. Pinning ---------------------------------------------------------------
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ;

-- Pinned conversations are listed first and stay pinned as new chats appear.
CREATE INDEX IF NOT EXISTS conversations_pinned_idx
  ON conversations (user_id, pinned_at DESC)
  WHERE pinned;

-- 2. Automatic routing -----------------------------------------------------
-- The user no longer picks Documents/Web/Hybrid; the backend router decides per
-- message. 'auto' becomes the stored default, and each assistant message records
-- in its metadata which route was actually taken.
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_mode_check;

ALTER TABLE conversations
  ADD CONSTRAINT conversations_mode_check
  CHECK (mode IN ('auto', 'document', 'web', 'hybrid'));

ALTER TABLE conversations ALTER COLUMN mode SET DEFAULT 'auto';

-- 3. Conversation search ---------------------------------------------------
-- Trigram indexes make case-insensitive substring search over titles and message
-- bodies fast enough to run in PostgreSQL instead of shipping every
-- conversation to the browser.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS conversations_title_trgm_idx
  ON conversations USING gin (title gin_trgm_ops);

CREATE INDEX IF NOT EXISTS messages_content_trgm_idx
  ON messages USING gin (content gin_trgm_ops);
