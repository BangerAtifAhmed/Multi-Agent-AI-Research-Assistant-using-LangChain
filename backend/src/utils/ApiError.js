/**
 * Error type carrying an HTTP status and a message that is safe to show a user.
 * Anything thrown that is not an ApiError is reported as a generic 500, so
 * stack traces, API keys and database details never reach the client.
 *
 * `details` is for the server log only and is never serialised to a response.
 */
export class ApiError extends Error {
  constructor(status, message, code = undefined, details = undefined) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = true;
  }

  static badRequest(message, code = 'BAD_REQUEST', details) {
    return new ApiError(400, message, code, details);
  }

  static unauthorized(message = 'Not authenticated', code = 'UNAUTHENTICATED', details) {
    return new ApiError(401, message, code, details);
  }

  static forbidden(message = 'You do not have access to that.', code = 'FORBIDDEN', details) {
    return new ApiError(403, message, code, details);
  }

  static notFound(message = 'Not found', code = 'NOT_FOUND', details) {
    return new ApiError(404, message, code, details);
  }

  static conflict(message, code = 'CONFLICT', details) {
    return new ApiError(409, message, code, details);
  }

  static payloadTooLarge(message, code = 'PAYLOAD_TOO_LARGE', details) {
    return new ApiError(413, message, code, details);
  }

  static unsupportedMediaType(message, code = 'UNSUPPORTED_MEDIA_TYPE', details) {
    return new ApiError(415, message, code, details);
  }

  static tooManyRequests(message, code = 'RATE_LIMITED', details) {
    return new ApiError(429, message, code, details);
  }

  static internal(message = 'Something went wrong', code = 'INTERNAL_ERROR', details) {
    return new ApiError(500, message, code, details);
  }

  static serviceUnavailable(message, code = 'SERVICE_UNAVAILABLE', details) {
    return new ApiError(503, message, code, details);
  }
}

export default ApiError;
