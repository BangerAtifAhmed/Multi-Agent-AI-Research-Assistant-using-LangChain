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

  await documentModel.updateStatus(document.id, 'failed', {
    errorMessage: isApiError
      ? error.message
      : 'Could not extract readable text from this document.',
    errorCode: (isApiError && error.code) || 'EXTRACTION_FAILED',
  });

  // Keep the original file so the user can see what failed and retry, but drop
  // any partial chunks that may have been written.
  await cacheService.invalidateUserDocumentCaches(userId).catch(() => {});
  return null;
}

async function processDocument({ userId, document, storageKey }) {
  const filePath = await storageService.getObjectPath(storageKey);

  // --- extraction (streams status: extracting -> ocr) ----------------------
  let chunks = [];
  let info = {};

  await documentModel.updateStatus(document.id, 'extracting');

  for await (const event of ragClient.extractChunksStream(filePath, document.originalFilename)) {
    if (event.type === 'status') {
      // 'ocr' only appears for scanned pages, so the UI can say so honestly.
      await documentModel.updateStatus(document.id, event.stage === 'ocr' ? 'ocr' : 'extracting');
    } else if (event.type === 'result') {
      chunks = event.chunks ?? [];
      info = event.info ?? {};
    } else if (event.type === 'error') {
      throw new ApiError(422, event.message, event.code || 'EXTRACTION_FAILED');
    }
  }

  if (!chunks.length) {
    throw new ApiError(
      422,
      'Could not extract readable text from this document.',
      'NO_TEXT_EXTRACTED',
    );
  }

  if (!(await stillExists(userId, document.id))) throw new DocumentRemoved();

  // --- chunking is done inside extraction; record the stage for the UI -----
  await documentModel.updateStatus(document.id, 'chunking', { extractionInfo: info });

  // --- embedding -----------------------------------------------------------
  await documentModel.updateStatus(document.id, 'embedding');

  const { embeddings, model: embeddingModel } = await ragClient.embedPassages(
    chunks.map((chunk) => chunk.content),
  );
  if (embeddings.length !== chunks.length) {
    throw ApiError.internal('Embedding count did not match chunk count.', 'EMBEDDING_MISMATCH');
  }

  const rows = chunks.map((chunk, index) => {
    const meta = chunk.metadata ?? {};
    return {
      chunkIndex: meta.chunk_index ?? index,
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
      embedding: embeddings[index],
    };
  });

  // Last check before writing: the delete may have landed during embedding.
  if (!(await stillExists(userId, document.id))) throw new DocumentRemoved();

  await withTransaction(async (client) => {
    // Re-check inside the transaction and lock the row, so a delete committed
    // between the check above and this insert cannot orphan chunks.
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

  const ready = await documentModel.updateStatus(document.id, 'ready', {
    chunkCount: rows.length,
    extractionInfo: { ...info, embeddingModel },
  });

  await cacheService.invalidateUserDocumentCaches(userId);
  logger.info(
    `indexed document ${document.id}: ${rows.length} chunks${info.usedOcr ? ' (OCR used)' : ''}`,
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
