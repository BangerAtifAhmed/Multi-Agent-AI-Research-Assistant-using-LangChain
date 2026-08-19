/**
 * Shared HTTP plumbing. Components never call fetch directly.
 *
 * `credentials: 'include'` on every call is what carries the HttpOnly session
 * cookie. No token is ever read or stored by JavaScript.
 */

/**
 * Normalises the configured API URL so it always ends with the `/api` mount
 * point the Express server uses.
 *
 * Both spellings are accepted, because either is a reasonable thing to put in
 * an environment variable:
 *
 *   https://api.example.com       -> https://api.example.com/api
 *   https://api.example.com/api   -> https://api.example.com/api
 *   http://localhost:3000/api     -> http://localhost:3000/api
 *   /api                          -> /api          (same-origin deployments)
 *
 * Getting this wrong is not a silent failure: every request lands on a path
 * without the `/api` prefix and the server answers ROUTE_NOT_FOUND.
 */
export function normaliseApiBaseUrl(value) {
  const raw = String(value ?? '').trim().replace(/\/+$/, '');
  if (!raw) return '/api';
  // Already mounted at /api (or a path ending in it): leave it alone.
  if (/\/api$/i.test(raw)) return raw;
  return `${raw}/api`;
}

export const API_BASE_URL = normaliseApiBaseUrl(
  import.meta.env.VITE_API_URL ||
    import.meta.env.VITE_API_BASE_URL ||
    'http://localhost:3000/api',
);

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

export async function request(path, { method = 'GET', body, signal, headers, timeoutMs } = {}) {
  // Without a deadline a stalled request never settles, and any spinner it
  // drives spins forever. Callers that can take a while (uploads) pass a
  // generous timeoutMs; everything else inherits the default.
  const timeoutSignal = timeoutMs ? AbortSignal.timeout(timeoutMs) : null;
  const effectiveSignal =
    signal && timeoutSignal
      ? AbortSignal.any([signal, timeoutSignal])
      : signal || timeoutSignal || undefined;

  let response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      signal: effectiveSignal,
      credentials: 'include',
      headers: {
        ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    // A timeout surfaces as TimeoutError; distinguish it from a user-initiated
    // abort so the UI can say something accurate.
    if (error?.name === 'TimeoutError' || (timeoutSignal?.aborted && !signal?.aborted)) {
      throw new ApiRequestError(
        'The server took too long to respond. It may be busy or restarting - please try again.',
        { code: 'TIMEOUT' },
      );
    }
    if (error?.name === 'AbortError') throw error;
    throw new ApiRequestError(NETWORK_MESSAGE, { code: 'NETWORK_ERROR' });
  }

  if (!response.ok) throw await parseError(response);
  if (response.status === 204) return null;

  // A restarting or proxied server can answer with an HTML error page; treating
  // that as JSON would throw an opaque SyntaxError.
  try {
    return await response.json();
  } catch {
    throw new ApiRequestError(
      'The server returned an unexpected response. It may be restarting - please try again.',
      { code: 'INVALID_RESPONSE', status: response.status },
    );
  }
}

/**
 * Upload that reports how many bytes have actually been sent.
 *
 * `fetch` gives no visibility into request upload progress, so this one call
 * uses XMLHttpRequest. The percentage comes from the browser's own count of
 * bytes on the wire - it is a real measurement, not a timer.
 */
export function uploadRequest(path, { body, onProgress, timeoutMs, signal } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE_URL}${path}`);
    xhr.withCredentials = true;
    if (timeoutMs) xhr.timeout = timeoutMs;

    if (onProgress) {
      xhr.upload.addEventListener('progress', (event) => {
        // Not every browser/proxy reports a total; without one there is no
        // honest percentage, so the caller is told so explicitly.
        onProgress(event.lengthComputable ? (event.loaded / event.total) * 100 : null);
      });
    }

    const fail = (message, code, status) =>
      reject(new ApiRequestError(message, { code, status }));

    xhr.addEventListener('load', () => {
      let payload = null;
      try {
        payload = JSON.parse(xhr.responseText);
      } catch {
        if (xhr.status >= 200 && xhr.status < 300) {
          fail('The server returned an unexpected response. It may be restarting - please try again.',
            'INVALID_RESPONSE', xhr.status);
          return;
        }
      }

      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(payload);
        return;
      }
      const error = new ApiRequestError(
        payload?.error?.message ?? `Request failed with status ${xhr.status}.`,
        { status: xhr.status, code: payload?.error?.code, retryAfter: payload?.error?.retryAfter },
      );
      // Same session-expiry signal the fetch path emits, so the app reacts
      // identically whichever transport was used.
      if (xhr.status === 401) {
        for (const listener of unauthorizedListeners) listener(error);
      }
      reject(error);
    });

    xhr.addEventListener('error', () => fail(NETWORK_MESSAGE, 'NETWORK_ERROR'));
    xhr.addEventListener('timeout', () =>
      fail('The upload took too long. The server may be busy - please try again.', 'TIMEOUT'));
    xhr.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));

    if (signal) {
      if (signal.aborted) { xhr.abort(); return; }
      signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }

    xhr.send(body);
  });
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

export default {
  request,
  streamRequest,
  uploadRequest,
  API_BASE_URL,
  ApiRequestError,
  onUnauthorized,
};
