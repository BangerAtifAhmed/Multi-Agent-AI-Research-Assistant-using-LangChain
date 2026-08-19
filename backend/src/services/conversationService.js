import config from '../config/index.js';
import conversationModel from '../models/conversationModel.js';
import documentModel from '../models/documentModel.js';
import messageModel from '../models/messageModel.js';
import ApiError from '../utils/ApiError.js';

const VALID_MODES = new Set(['document', 'web', 'hybrid']);

export function assertValidMode(mode) {
  if (mode && !VALID_MODES.has(mode)) {
    throw ApiError.badRequest(
      `Unknown mode "${mode}". Use one of: ${[...VALID_MODES].join(', ')}.`,
      'INVALID_MODE',
    );
  }
  return mode;
}

/** Rejects a document id the caller does not own. */
async function assertOwnedDocument(userId, documentId) {
  if (!documentId) return null;
  const document = await documentModel.getDocument(userId, documentId);
  if (!document) throw ApiError.notFound('Document not found', 'DOCUMENT_NOT_FOUND');
  return document;
}

export async function createConversation(userId, { title, mode, documentId } = {}) {
  assertValidMode(mode);
  await assertOwnedDocument(userId, documentId);

  const cleanTitle = String(title ?? '').trim().slice(0, config.limits.maxTitleLength);
  return conversationModel.createConversation({
    userId,
    title: cleanTitle || 'New chat',
    mode: mode || 'document',
    documentId: documentId || null,
  });
}

export function listConversations(userId) {
  return conversationModel.listConversations(userId);
}

/** Searches only the caller's own conversations. */
export async function searchConversations(userId, term) {
  const clean = String(term ?? '').trim();
  if (clean.length < 2) return [];
  // Cap the term so a huge string cannot turn into an expensive scan.
  return conversationModel.searchConversations(userId, clean.slice(0, 100));
}

/** Pins or unpins a conversation, verifying ownership first. */
export async function setPinned(userId, conversationId, pinned) {
  if (typeof pinned !== 'boolean') {
    throw ApiError.badRequest('"pinned" must be true or false.', 'INVALID_PINNED');
  }
  const conversation = await conversationModel.setPinned(userId, conversationId, pinned);
  if (!conversation) {
    // Same response whether it does not exist or belongs to someone else.
    throw ApiError.notFound('Conversation not found', 'CONVERSATION_NOT_FOUND');
  }
  return conversation;
}

export async function getConversationOrFail(userId, conversationId) {
  const conversation = await conversationModel.getConversation(userId, conversationId);
  if (!conversation) {
    throw ApiError.notFound('Conversation not found', 'CONVERSATION_NOT_FOUND');
  }
  return conversation;
}

export async function getMessages(userId, conversationId) {
  await getConversationOrFail(userId, conversationId);
  return messageModel.listMessages(userId, conversationId);
}

export async function updateConversation(userId, conversationId, patch) {
  await getConversationOrFail(userId, conversationId);
  assertValidMode(patch.mode);

  const clean = {};
  if (patch.title !== undefined) {
    const title = String(patch.title || '').trim();
    if (!title) throw ApiError.badRequest('Title must not be empty', 'INVALID_TITLE');
    clean.title = title.slice(0, config.limits.maxTitleLength);
  }
  if (patch.mode !== undefined) clean.mode = patch.mode;
  if (patch.documentId !== undefined) {
    await assertOwnedDocument(userId, patch.documentId);
    clean.documentId = patch.documentId || null;
  }

  return conversationModel.updateConversation(userId, conversationId, clean);
}

export async function deleteConversation(userId, conversationId) {
  await getConversationOrFail(userId, conversationId);
  await conversationModel.deleteConversation(userId, conversationId);
  return { id: conversationId, deleted: true };
}

export async function clearMessages(userId, conversationId) {
  await getConversationOrFail(userId, conversationId);
  const deleted = await messageModel.deleteMessages(userId, conversationId);
  await conversationModel.touchConversation(userId, conversationId);
  return { id: conversationId, deleted };
}

export default {
  createConversation,
  listConversations,
  searchConversations,
  setPinned,
  getConversationOrFail,
  getMessages,
  updateConversation,
  deleteConversation,
  clearMessages,
  assertValidMode,
};
