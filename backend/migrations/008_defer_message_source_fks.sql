-- Deleting a user cascades down two paths at once:
--
--   users -> conversations -> messages -> message_sources   (ON DELETE CASCADE)
--   users -> documents     -> document_chunks               (ON DELETE CASCADE)
--                                     \-> message_sources.chunk_id = NULL
--                                                           (ON DELETE SET NULL)
--
-- The SET NULL branch issues an UPDATE on message_sources, and that UPDATE
-- re-validates the row's other foreign keys. If the parent message was already
-- removed by the first branch, the immediate check fails with
-- "message_id is not present in table messages" and the whole delete aborts.
--
-- Deferring these checks to COMMIT fixes it: by then the message_sources rows
-- have been cascade-deleted, so there is nothing left to violate. Ordinary
-- inserts are unaffected apart from reporting a violation at commit time.

ALTER TABLE message_sources
  DROP CONSTRAINT IF EXISTS message_sources_message_id_fkey;

ALTER TABLE message_sources
  ADD CONSTRAINT message_sources_message_id_fkey
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE message_sources
  DROP CONSTRAINT IF EXISTS message_sources_document_id_fkey;

ALTER TABLE message_sources
  ADD CONSTRAINT message_sources_document_id_fkey
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE SET NULL
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE message_sources
  DROP CONSTRAINT IF EXISTS message_sources_chunk_id_fkey;

ALTER TABLE message_sources
  ADD CONSTRAINT message_sources_chunk_id_fkey
  FOREIGN KEY (chunk_id) REFERENCES document_chunks(id) ON DELETE SET NULL
  DEFERRABLE INITIALLY DEFERRED;
