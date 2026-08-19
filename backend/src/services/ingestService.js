import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import config from '../config/index.js';
import { withTransaction } from '../config/database.js';
import documentModel from '../models/documentModel.js';
import ragClient from '../rag/ragClient.js';
import ApiError from '../utils/ApiError.js';
import { validateFileContent } from '../utils/fileType.js';
import logger from '../utils/logger.js';
import cacheService from './cacheService.js';
import storageService from './storageService.js';

/**
 * Document ingestion.
 *
 *   validate -> store original -> create record
 *     -> extracting -> [ocr] -> chunking -> embedding -> ready
 *                                                     \-> failed
 *
 * Processing runs in the background after the upload response is sent, so a
 * large PDF or a slow OCR pass does not hold an HTTP request open for minutes.
 * The Library polls GET /api/documents and shows whichever stage is current.
 */

/** Extension + declared MIME + actual magic bytes must all agree. */
export async function validateUpload(file) {
  if (!file) throw ApiError.badRequest('No file was uploaded.', 'NO_FILE');

  const extension = path.extname(file.originalname || '').toLowerCase();

  if (!config.uploads.allowedExtensions.includes(extension)) {
    throw ApiError.unsupportedMediaType(
      `Unsupported file type "${extension || 'unknown'}". Supported: ${config.uploads.allowedExtensions
        .map((value) => value.slice(1).toUpperCase())
        .join(', ')}.`,
      'UNSUPPORTED_FILE_TYPE',
    );
  }

  if (file.size > config.uploads.maxSizeBytes) {
    throw ApiError.payloadTooLarge(
      `File is too large. Maximum size is ${Math.round(
        config.uploads.maxSizeBytes / (1024 * 1024),
      )} MB.`,
      'FILE_TOO_LARGE',
    );
  }

  const mime = (file.mimetype || '').toLowerCase();
  const mimeAllowed =
    config.uploads.allowedMimeTypes.includes(mime) ||
    mime === 'application/octet-stream' ||
    mime.startsWith('text/');

  if (!mimeAllowed) {
    throw ApiError.unsupportedMediaType(
      `Unsupported content type "${mime}".`,
      'UNSUPPORTED_MIME_TYPE',
    );
  }

  // The authoritative check: what the bytes actually are.
  const content = await validateFileContent(
    file.path,
    file.originalname,
    config.uploads.allowedExtensions,
  );
  if (!content.ok) {
    throw content.code === 'DANGEROUS_FILE'
      ? ApiError.badRequest(content.message, content.code)
      : ApiError.unsupportedMediaType(content.message, content.code);
  }

  return { extension, mime, detected: content.detected };
}

const hashFile = (filePath) =>
  new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });

/**
 * Accepts an upload: validates, stores the file, creates the record, and
 * kicks off processing. Returns as soon as the document row exists.
 */
export async function ingestUpload({ userId, file, wait = false }) {
  await validateUpload(file);

  const contentHash = await hashFile(file.path);

  const existing = await documentModel.findByContentHash(userId, contentHash);
  if (existing && existing.status === 'ready') {
    await fs.promises.unlink(file.path).catch(() => {});
    return { document: existing, alreadyIndexed: true };
  }
  if (existing && existing.status !== 'failed') {
    await fs.promises.unlink(file.path).catch(() => {});
    throw ApiError.conflict(
      'That document is already being processed.',
      'DOCUMENT_ALREADY_UPLOADING',
    );
  }
  if (existing) {
    // A previous attempt failed; replace it rather than blocking the re-upload.
    await deleteDocument({ userId, documentId: existing.id }).catch(() => {});
  }

  const storageKey = storageService.buildStorageKey(userId, file.originalname);
  await storageService.putObject(storageKey, file.path);

  const document = await documentModel.createDocument({
    userId,
    name:
      path.basename(file.originalname, path.extname(file.originalname)).slice(0, 120) ||
      file.originalname,
    originalFilename: file.originalname,
    mimeType: file.mimetype || 'application/octet-stream',
    fileSize: file.size,
    storageKey,
    contentHash,
  });

  await documentModel.updateStatus(document.id, 'uploading');

  const processing = processDocument({ userId, document, storageKey }).catch((error) =>
    handleProcessingFailure({ userId, document, storageKey, error }),
  );

  // Tests and scripts can opt into synchronous behaviour.
  if (wait) {
    await processing;
    return { document: await documentModel.getDocument(userId, document.id), alreadyIndexed: false };
  }

  return {
    document: await documentModel.getDocument(userId, document.id),
    alreadyIndexed: false,
    processing,
  };
}

/**
 * The user can delete a document while it is still being processed. Every stage
 * checks this so the pipeline stops quietly instead of failing on a missing file
 * or trying to insert chunks for a row that no longer exists.
 */
async function stillExists(userId, documentId) {
  return Boolean(await documentModel.getDocument(userId, documentId));
}

class DocumentRemoved extends Error {}

async function handleProcessingFailure({ userId, document, storageKey, error }) {
  // Deleted mid-flight: nothing to report, the row and file are already gone.
  if (error instanceof DocumentRemoved || !(await stillExists(userId, document.id))) {
    logger.debug(`ingestion cancelled: document ${document.id} was deleted`);
    return null;
  }

  const isApiError = error instanceof ApiError;
  logger.error(`ingestion failed for document ${document.id}: ${error.message}`);

  // Ingestion writes chunks batch by batch, so a failure half way through leaves
  // part of the document indexed. Drop those before marking it failed: a failed
  // document must never contribute results to a search.
  const removed = await documentModel
    .deleteChunks(userId, document.id)
    .catch((cleanupError) => {
      logger.warn(`could not clean partial chunks for ${document.id}: ${cleanupError.message}`);
      return 0;
    });
  if (removed) logger.info(`removed ${removed} partial chunks from failed document ${document.id}`);

  // Always reached, whatever stage failed, so a document can never be left
  // sitting in extracting/chunking/embedding forever.
  await documentModel.updateStatus(document.id, 'failed', {
    errorMessage: isApiError
      ? error.message
      : 'Could not extract readable text from this document.',
    errorCode: (isApiError && error.code) || 'EXTRACTION_FAILED',
    chunkCount: 0,
    // Stale counters would otherwise keep a failed document looking busy.
    progress: { stage: 'failed' },
  });

  // The original file is kept so the user can see what failed and retry.
  await cacheService.invalidateUserDocumentCaches(userId).catch(() => {});
  return null;
}

/**
 * Rate-limits progress writes.
 *
 * A 1000-page PDF reports progress about a hundred times; without this each one
 * would be a database round trip on the ingestion's critical path. Writes are
 * spaced out, and callers `mark()` when they have just written the row for
 * another reason so the next tick is measured from that point.
 */
function progressWriter(documentId, intervalMs = config.retrieval.progressIntervalMs) {
  let lastWrite = 0;
  let inFlight = false;

  return {
    mark() {
      lastWrite = Date.now();
    },
    async maybeWrite(progress) {
      if (inFlight || Date.now() - lastWrite < intervalMs) return false;
      inFlight = true;
      try {
        await documentModel.updateProgress(documentId, { ...progress, updatedAt: new Date().toISOString() });
        lastWrite = Date.now();
        return true;
      } catch (error) {
        // Progress is cosmetic; never let it fail an ingestion.
        logger.debug(`could not write progress for ${documentId}: ${error.message}`);
        return false;
      } finally {
        inFlight = false;
      }
    },
  };
}

/** Maps one extracted chunk onto a database row, keeping only real metadata. */
function toChunkRow(chunk, fallbackIndex, document) {
  const meta = chunk.metadata ?? {};
  return {
    chunkIndex: meta.chunk_index ?? fallbackIndex,
    content: chunk.content,
    // Only carry through the fields that were actually produced, so a
    // citation never shows an invented page or slide number.
    metadata: {
      documentName: meta.document_name ?? document.originalFilename,
      ...(meta.page != null ? { page: meta.page } : {}),
      ...(meta.slide != null ? { slide: meta.slide } : {}),
      ...(meta.paragraph != null ? { paragraph: meta.paragraph } : {}),
      ...(meta.line != null ? { line: meta.line } : {}),
      ...(meta.section ? { section: meta.section } : {}),
      ...(meta.title ? { title: meta.title } : {}),
      ...(meta.table != null ? { table: meta.table } : {}),
    },
    embedding: null,
  };
}

/**
 * Embeds one batch and writes it straight to pgvector.
 *
 * Nothing from a batch outlives this call: the texts, the vectors and the rows
 * are released once the transaction commits, which is what keeps peak memory
 * flat regardless of document size.
 */
async function embedAndInsertBatch({ userId, document, batch, offset }) {
  const rows = batch.map((chunk, index) => toChunkRow(chunk, offset + index, document));

  const { embeddings, model: embeddingModel } = await ragClient.embedPassages(
    rows.map((row) => row.content),
  );

  if (embeddings.length !== rows.length) {
    throw ApiError.internal('Embedding count did not match chunk count.', 'EMBEDDING_MISMATCH');
  }
  for (let index = 0; index < rows.length; index += 1) rows[index].embedding = embeddings[index];

  await withTransaction(async (client) => {
    // Re-check inside the transaction and lock the row, so a delete committed
    // mid-ingestion cannot orphan chunks.
    const { rowCount } = await client.query(
      'SELECT 1 FROM documents WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [document.id, userId],
    );
    if (!rowCount) throw new DocumentRemoved();

    await documentModel.insertChunks(client, {
      documentId: document.id,
      userId,
      chunks: rows,
      // Pins these vectors to the model that produced them.
      embeddingModel,
    });
  });

  return { written: rows.length, embeddingModel };
}

/**
 * Streaming ingestion.
 *
 *   extract a batch -> embed it -> insert it -> discard -> repeat
 *
 * Peak memory is one batch, not one document, so a 20 MB PDF with ~1100 chunks
 * costs about the same as a one-page file. A failure part-way through removes
 * the chunks already written, so a document never stays half-indexed.
 */
async function processDocument({ userId, document, storageKey }) {
  const filePath = await storageService.getObjectPath(storageKey);

  await documentModel.updateStatus(document.id, 'extracting', { progress: { stage: 'extracting' } });

  let info = {};
  let total = 0;
  let embeddingModel = null;
  let announcedEmbedding = false;
  let stage = 'extracting';

  // Live counters, all of them measured rather than estimated. Fields stay
  // absent until the work that produces them has actually happened, so the UI
  // can tell "nothing to report yet" from "zero".
  const progress = { stage };
  const writer = progressWriter(document.id);

  for await (const event of ragClient.extractChunksStream(
    filePath,
    document.originalFilename,
    config.retrieval.ingestBatchSize,
  )) {
    if (event.type === 'status') {
      // 'ocr' only appears for scanned pages, so the UI can say so honestly.
      const nextStage = event.stage === 'ocr' ? 'ocr' : stage;

      // Carry through whatever the extractor measured for this event.
      for (const field of ['page', 'pages', 'ocrPages', 'block', 'blocks']) {
        if (typeof event[field] === 'number') progress[field] = event[field];
      }

      if (nextStage !== stage) {
        stage = nextStage;
        progress.stage = stage;
        // A stage change is worth a write immediately; the UI labels on it.
        await documentModel.updateStatus(document.id, stage, { progress });
        writer.mark();
      } else {
        await writer.maybeWrite(progress);
      }
      continue;
    }

    if (event.type === 'error') {
      throw new ApiError(422, event.message, event.code || 'EXTRACTION_FAILED');
    }

    if (event.type === 'chunks') {
      if (!(await stillExists(userId, document.id))) throw new DocumentRemoved();

      if (!announcedEmbedding) {
        // The first batch existing *is* the end of chunking, so both stages are
        // recorded rather than the intermediate one being skipped.
        progress.stage = 'chunking';
        await documentModel.updateStatus(document.id, 'chunking', { progress });
        stage = 'embedding';
        progress.stage = stage;
        await documentModel.updateStatus(document.id, 'embedding', { progress });
        writer.mark();
        announcedEmbedding = true;
      }

      const result = await embedAndInsertBatch({
        userId,
        document,
        batch: event.chunks ?? [],
        offset: total,
      });

      total += result.written;
      embeddingModel = result.embeddingModel;
      progress.batches = event.index ?? (progress.batches ?? 0) + 1;
      progress.chunks = total;

      // Keeps the running count visible while a long document is indexed. The
      // chunk count is on the document itself, the batch counters on progress.
      await documentModel.updateStatus(document.id, 'embedding', {
        chunkCount: total,
        progress,
      });
      writer.mark();
      continue;
    }

    if (event.type === 'result') {
      info = event.info ?? {};
      // Only now is the total known: extraction and embedding are interleaved,
      // so until the stream ends there is no honest denominator to show.
      if (typeof event.batches === 'number') progress.batchesTotal = event.batches;
      if (typeof event.count === 'number') progress.chunksTotal = event.count;
    }
  }
  if (!total) {
    throw new ApiError(
      422,
      'Could not extract readable text from this document.',
      'NO_TEXT_EXTRACTED',
    );
  }

  const ready = await documentModel.updateStatus(document.id, 'ready', {
    chunkCount: total,
    extractionInfo: { ...info, embeddingModel },
    // Final counters, so a finished document shows what it actually did rather
    // than whatever the last mid-flight tick happened to say.
    progress: {
      stage: 'ready',
      chunks: total,
      chunksTotal: total,
      batches: progress.batchesTotal ?? progress.batches,
      batchesTotal: progress.batchesTotal ?? progress.batches,
      ...(progress.pages ? { page: progress.pages, pages: progress.pages } : {}),
      ...(info.ocrPages ? { ocrPages: info.ocrPages } : {}),
    },
  });

  await cacheService.invalidateUserDocumentCaches(userId);
  logger.info(
    `indexed document ${document.id}: ${total} chunks${info.usedOcr ? ' (OCR used)' : ''}`,
  );

  return ready;
}

/** Deletes a document, its chunks/embeddings and the stored original. */
export async function deleteDocument({ userId, documentId }) {
  const result = await documentModel.deleteDocument(userId, documentId);
  if (!result) {
    throw ApiError.notFound('Document not found.', 'DOCUMENT_NOT_FOUND');
  }

  await storageService.deleteObject(result.storageKey);
  await cacheService.invalidateUserDocumentCaches(userId);

  return { id: documentId, deleted: true, deletedChunks: result.deletedChunks };
}

export default { ingestUpload, deleteDocument, validateUpload };
