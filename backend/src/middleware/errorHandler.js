import multer from 'multer';

import ApiError from '../utils/ApiError.js';
import logger from '../utils/logger.js';

export function notFound(req, res) {
  res.status(404).json({
    error: { message: `No route for ${req.method} ${req.originalUrl}`, code: 'ROUTE_NOT_FOUND' },
  });
}

/**
 * Single exit point for errors. Only whitelisted, human-readable messages are
 * sent to the client - stack traces, driver errors and secrets stay in the log.
 */
export function errorHandler(error, req, res, next) {
  if (res.headersSent) {
    // An SSE stream is already open; the controller has reported the failure.
    return next(error);
  }

  let status = 500;
  let payload = { message: 'Something went wrong. Please try again.', code: 'INTERNAL_ERROR' };

  if (error instanceof ApiError) {
    status = error.status;
    payload = { message: error.message, code: error.code || 'ERROR' };
  } else if (error instanceof multer.MulterError) {
    status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    payload = {
      message:
        error.code === 'LIMIT_FILE_SIZE'
          ? 'That file is too large to upload.'
          : 'The upload could not be processed.',
      code: error.code,
    };
  } else if (error?.type === 'entity.too.large') {
    status = 413;
    payload = { message: 'Request body is too large.', code: 'PAYLOAD_TOO_LARGE' };
  } else if (error?.type === 'entity.parse.failed') {
    status = 400;
    payload = { message: 'Request body must be valid JSON.', code: 'INVALID_JSON' };
  } else if (error?.message === 'CORS_NOT_ALLOWED') {
    status = 403;
    payload = { message: 'Origin not allowed.', code: 'CORS_NOT_ALLOWED' };
  }

  if (status >= 500) logger.error(`${req.method} ${req.originalUrl}`, error);

  res.status(status).json({ error: payload });
}

export default { notFound, errorHandler };
