import config from '../config/index.js';
import documentModel from '../models/documentModel.js';
import ragClient from '../rag/ragClient.js';
import ingestService from '../services/ingestService.js';

export async function list(req, res) {
  res.json({ documents: await documentModel.listDocuments(req.user.id) });
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

export default { list, upload, remove, formats };
