/**
 * Shared HTTP plumbing. Components never call fetch directly.
 *
 * `credentials: 'include'` on every call is what carries the HttpOnly session
 * cookie. No token is ever read or stored by JavaScript.
 */

export const API_BASE_URL = (
  import.meta.env.VITE_API_URL ||
  import.meta.env.VITE_API_BASE_URL ||
  'http://localhost:3000/api'
).replace(/\/+$/, '');

export class ApiRequestError extends Error {
  constructor(message, { status, code, retryAfter } = {}) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }

  get isAuthError() {
    return this.status === 401;
  }

  get isRateLimited() {
    return this.status === 429;
  }
}

const NETWORK_MESSAGE = `Cannot reach the server. Make sure the backend is running at ${API_BASE_URL}.`;

/** Notified whenever the API reports the session is gone. */
const unauthorizedListeners = new Set();
export const onUnauthorized = (listener) => {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
};

async function parseError(response) {
  let message = `Request failed (${response.status})`;
  let code;
  try {
    const body = await response.json();
    if (body?.error?.message) {
      message = body.error.message;
      code = body.error.code;
    }
  } catch {
    /* non-JSON error body */
  }

  const error = new ApiRequestError(message, {
    status: response.status,
    code,
    retryAfter: Number(response.headers.get('Retry-After')) || undefined,
  });

  if (response.status === 401) {
    for (const listener of unauthorizedListeners) listener(error);
  }

  return error;
}

export async function request(path, { method = 'GET', body, signal, headers } = {}) {
  let response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      signal,
      credentials: 'include',
      headers: {
        ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new ApiRequestError(NETWORK_MESSAGE, { code: 'NETWORK_ERROR' });
  }

  if (!response.ok) throw await parseError(response);
  if (response.status === 204) return null;

  return response.json();
}

/** POST that returns a raw streaming response (used for SSE). */
export async function streamRequest(path, { body, signal } = {}) {
  let response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new ApiRequestError(NETWORK_MESSAGE, { code: 'NETWORK_ERROR' });
  }

  if (!response.ok) throw await parseError(response);
  if (!response.body) {
    throw new ApiRequestError('The server returned an empty stream.', { code: 'EMPTY_STREAM' });
  }

  return response;
}

export default { request, streamRequest, API_BASE_URL, ApiRequestError, onUnauthorized };
