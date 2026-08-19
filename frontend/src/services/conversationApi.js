import { request } from './apiClient.js';

export const listConversations = () =>
  request('/conversations').then((data) => data.conversations ?? []);

export const createConversation = (payload = {}) =>
  request('/conversations', { method: 'POST', body: payload }).then((data) => data.conversation);

export const getConversation = (id) =>
  request(`/conversations/${id}`).then((data) => data.conversation);

export const getMessages = (id) =>
  request(`/conversations/${id}/messages`).then((data) => data.messages ?? []);

export const renameConversation = (id, title) =>
  request(`/conversations/${id}`, { method: 'PATCH', body: { title } }).then(
    (data) => data.conversation,
  );

export const updateConversation = (id, patch) =>
  request(`/conversations/${id}`, { method: 'PATCH', body: patch }).then(
    (data) => data.conversation,
  );

/** Server-side search over the caller's own conversations. */
export const searchConversations = (term, signal) =>
  request(`/conversations/search?q=${encodeURIComponent(term)}`, { signal }).then(
    (data) => data.conversations ?? [],
  );

export const setPinned = (id, pinned) =>
  request(`/conversations/${id}/pin`, { method: 'PATCH', body: { pinned } }).then(
    (data) => data.conversation,
  );

export const deleteConversation = (id) => request(`/conversations/${id}`, { method: 'DELETE' });

export const clearMessages = (id) =>
  request(`/conversations/${id}/messages`, { method: 'DELETE' });

export default {
  listConversations,
  searchConversations,
  setPinned,
  createConversation,
  getConversation,
  getMessages,
  renameConversation,
  updateConversation,
  deleteConversation,
  clearMessages,
};
