import { request, uploadRequest } from './apiClient.js';

export const listDocuments = () => request('/documents').then((data) => data.documents ?? []);

/**
 * One document, including its live `progress` counters.
 *
 * Polling this while a document is processing is much cheaper than re-fetching
 * the whole library every second and a half.
 */
export const getDocument = (id) => request(`/documents/${id}`).then((data) => data.document);

/** Which formats this deployment accepts and can actually process. */
export const getFormats = () => request('/documents/formats');

/** Upload can be slow for a large file on a cold server, but never unbounded. */
export const UPLOAD_TIMEOUT_MS = 120_000;

/**
 * @param {File} file
 * @param {(percent: number|null) => void} [onProgress]  real bytes-sent percentage,
 *        or null when the browser cannot determine the total.
 */
export const uploadDocument = (file, onProgress) => {
  const form = new FormData();
  form.append('file', file);
  // Returns 202: the document row exists, processing continues in background.
  return uploadRequest('/documents', {
    body: form,
    onProgress,
    timeoutMs: UPLOAD_TIMEOUT_MS,
  }).then((data) => data.document);
};

export const deleteDocument = (id) => request(`/documents/${id}`, { method: 'DELETE' });

export const getHealth = () => request('/health');

export default {
  listDocuments,
  getDocument,
  getFormats,
  uploadDocument,
  deleteDocument,
  getHealth,
};
