-- Ingestion now reports each stage of the pipeline instead of a single
-- "processing" state, so the Library can show what is actually happening:
--
--   uploading -> extracting -> [ocr] -> chunking -> embedding -> ready
--                                                             \-> failed
--
-- 'pending' and 'processing' are kept so rows written by the previous version
-- remain valid.
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_status_check;

ALTER TABLE documents
  ADD CONSTRAINT documents_status_check
  CHECK (status IN (
    'pending',
    'uploading',
    'extracting',
    'ocr',
    'chunking',
    'embedding',
    'processing',
    'ready',
    'failed'
  ));

-- Machine-readable failure reason alongside the human-readable error_message,
-- so the UI can special-case things like a missing OCR engine.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS error_code TEXT;

-- Extraction facts worth keeping: page/slide counts, whether OCR ran, etc.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS extraction_info JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Lets the Library poll only documents that are still in flight.
CREATE INDEX IF NOT EXISTS documents_pending_idx
  ON documents (user_id)
  WHERE status NOT IN ('ready', 'failed');
