import { relativeDayGroup } from './date.js';

const ORDER = ['Today', 'Yesterday', 'Previous 7 days', 'Previous 30 days', 'Older'];

/** Groups conversations into ChatGPT-style dated sections, newest first. */
export function groupConversations(conversations) {
  const groups = new Map();

  for (const conversation of conversations) {
    const label = relativeDayGroup(conversation.updatedAt || conversation.createdAt);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(conversation);
  }

  return ORDER.filter((label) => groups.has(label)).map((label) => ({
    label,
    items: groups.get(label),
  }));
}

export default groupConversations;
