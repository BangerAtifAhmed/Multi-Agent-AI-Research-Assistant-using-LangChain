import conversationService from '../services/conversationService.js';

export async function create(req, res) {
  const conversation = await conversationService.createConversation(req.user.id, req.body ?? {});
  res.status(201).json({ conversation });
}

export async function list(req, res) {
  res.json({ conversations: await conversationService.listConversations(req.user.id) });
}

/** GET /api/conversations/search?q=... - the caller's own conversations only. */
export async function search(req, res) {
  const term = typeof req.query.q === 'string' ? req.query.q : '';
  res.json({
    query: term,
    conversations: await conversationService.searchConversations(req.user.id, term),
  });
}

/** PATCH /api/conversations/:id/pin  { pinned: true } */
export async function pin(req, res) {
  res.json({
    conversation: await conversationService.setPinned(
      req.user.id,
      req.params.id,
      req.body?.pinned,
    ),
  });
}

export async function getOne(req, res) {
  res.json({
    conversation: await conversationService.getConversationOrFail(req.user.id, req.params.id),
  });
}

export async function messages(req, res) {
  res.json({ messages: await conversationService.getMessages(req.user.id, req.params.id) });
}

export async function update(req, res) {
  res.json({
    conversation: await conversationService.updateConversation(
      req.user.id,
      req.params.id,
      req.body ?? {},
    ),
  });
}

export async function remove(req, res) {
  res.json(await conversationService.deleteConversation(req.user.id, req.params.id));
}

export async function clear(req, res) {
  res.json(await conversationService.clearMessages(req.user.id, req.params.id));
}

export default { create, list, search, pin, getOne, messages, update, remove, clear };
