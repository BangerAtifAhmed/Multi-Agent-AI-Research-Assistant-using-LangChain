import { request } from './apiClient.js';

export const listDocuments = () => request('/documents').then((data) => data.documents ?? []);

/** Which formats this deployment accepts and can actually process. */
export const getFormats = () => request('/documents/formats');

export const uploadDocument = (file) => {
  const form = new FormData();
  form.append('file', file);
  // Returns 202: the document row exists, processing continues in background.
  return request('/documents', { method: 'POST', body: form }).then((data) => data.document);
};

export const deleteDocument = (id) => request(`/documents/${id}`, { method: 'DELETE' });

export const getHealth = () => request('/health');

export default { listDocuments, getFormats, uploadDocument, deleteDocument, getHealth };
