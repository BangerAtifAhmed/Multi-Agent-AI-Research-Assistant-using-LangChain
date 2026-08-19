import config from '../config/index.js';
import ApiError from '../utils/ApiError.js';
import documentModel from '../models/documentModel.js';
import ragClient from '../rag/ragClient.js';
import ingestService from '../services/ingestService.js';

export async function list(req, res) {
  res.json({ documents: await documentModel.listDocuments(req.user.id) });
}

/**
 * One document, for following its processing progress.
 *
 * The upload UI polls this rather than the full list: while a document is being
 * indexed the client wants one row, and sending the whole library every 1.5
 * seconds is wasteful for a user with many documents.
 */
export async function get(req, res) {
  const document = await documentModel.getDocument(req.user.id, req.params.id);
  if (!document) throw ApiError.notFound('Document not found.', 'DOCUMENT_NOT_FOUND');
  res.json({ document });
}

export async function upload(req, res) {
  const { document, alreadyIndexed } = await ingestService.ingestUpload({
    userId: req.user.id,
    file: req.file,
  });

  // 202: the document row exists and processing continues in the background.
  // The Library polls GET /api/documents to follow the status.
  res.status(alreadyIndexed ? 200 : 202).json({ document, alreadyIndexed });
}

export async function remove(req, res) {
  res.json(
    await ingestService.deleteDocument({ userId: req.user.id, documentId: req.params.id }),
  );
}

/**
 * What this deployment can actually ingest. The UI uses it to list supported
 * formats honestly rather than advertising a format the server cannot read.
 */
export async function formats(req, res) {
  const capabilities = await ragClient.ragCapabilities();

  res.json({
    // Extensions the API will accept for upload.
    accepted: config.uploads.allowedExtensions,
    maxSizeBytes: config.uploads.maxSizeBytes,
    // Extensions the extraction engine can genuinely process right now.
    supported: capabilities?.supportedExtensions ?? null,
    ocr: capabilities?.ocr ?? false,
    libreOffice: capabilities?.libreOffice ?? false,
    details: capabilities?.formats ?? null,
  });
}

export default { list, get, upload, remove, formats };
