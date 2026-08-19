import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';

import config from '../config/index.js';
import ApiError from '../utils/ApiError.js';

/**
 * Uploads land in a temp directory first. Only after validation and successful
 * processing does the file move into object storage under a key that is
 * namespaced by user id, so a filename can never collide across accounts or
 * escape its owner's prefix.
 */
const tempDir = path.join(os.tmpdir(), 'ragchat-uploads');
fs.mkdirSync(tempDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, tempDir),
  // A random name: the user-supplied filename never touches the filesystem.
  filename: (req, file, cb) => {
    const extension = path.extname(file.originalname || '').toLowerCase().slice(0, 12);
    cb(null, `${crypto.randomBytes(16).toString('hex')}${extension}`);
  },
});

const multerUpload = multer({
  storage,
  limits: { fileSize: config.uploads.maxSizeBytes, files: 1, fields: 10 },
  fileFilter: (req, file, cb) => {
    const extension = path.extname(file.originalname || '').toLowerCase();
    const allowed = config.uploads.allowedExtensions.includes(extension);
    // Remember why the file was dropped so the handler can explain it; a
    // silently filtered file would otherwise surface as "no file uploaded".
    if (!allowed) req.uploadRejection = extension || 'unknown';
    cb(null, allowed);
  },
}).single('file');

/** Turns a filtered-out file into a clear 415 instead of a confusing 400. */
export function uploadDocument(req, res, next) {
  multerUpload(req, res, (error) => {
    if (error) return next(error);
    if (!req.file && req.uploadRejection) {
      return next(
        ApiError.unsupportedMediaType(
          `Unsupported file type "${req.uploadRejection}". Allowed: ${config.uploads.allowedExtensions.join(', ')}.`,
          'UNSUPPORTED_FILE_TYPE',
        ),
      );
    }
    next();
  });
}

export default uploadDocument;
