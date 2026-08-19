-- Live progress for a document that is still being processed.
--
-- The status column already says which stage a document is in; this adds the
-- counts within that stage, so the UI can show "OCR: 42 / 180 pages" instead of
-- an indefinite spinner. Every field is a real measurement taken from the work
-- actually done - pages read, pages OCRed, chunks written, batches embedded -
-- so the UI never has to invent a percentage.
--
-- Shape (all keys optional; absent means "not measurable at this point"):
--   { "stage": "ocr", "page": 42, "pages": 180, "ocrPages": 7,
--     "chunks": 512, "batches": 8, "batchesTotal": 32, "updatedAt": "..." }
--
-- Kept separate from extraction_info, which is the final summary of a finished
-- document rather than a live counter.
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS progress JSONB NOT NULL DEFAULT '{}'::jsonb;
