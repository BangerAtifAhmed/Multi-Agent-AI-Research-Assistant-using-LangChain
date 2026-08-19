CREATE TABLE IF NOT EXISTS conversations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL DEFAULT 'New chat',
  -- Retained from the original project: document / web / hybrid research modes.
  mode        TEXT NOT NULL DEFAULT 'document',
  document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT conversations_mode_check CHECK (mode IN ('document', 'web', 'hybrid'))
);

CREATE INDEX IF NOT EXISTS conversations_user_idx ON conversations (user_id, updated_at DESC);
