import config from '../config/index.js';

/**
 * Context-window strategy for chat history.
 *
 * Unbounded history would grow the prompt without limit, so the window is
 * capped three ways: number of messages, characters per message, and total
 * characters. The most recent turns are always the ones that survive.
 */
export function buildHistoryWindow(messages, options = {}) {
  const maxMessages = options.maxMessages ?? config.history.maxMessages;
  const maxChars = options.maxChars ?? config.history.maxChars;
  const maxCharsPerMessage = options.maxCharsPerMessage ?? config.history.maxCharsPerMessage;

  const recent = messages
    .filter((message) => message.content && message.content.trim())
    .slice(-maxMessages)
    .map((message) => ({
      role: message.role,
      content:
        message.content.length > maxCharsPerMessage
          ? `${message.content.slice(0, maxCharsPerMessage)} ...`
          : message.content,
    }));

  // Drop from the front until the whole window fits the character budget.
  let total = recent.reduce((sum, message) => sum + message.content.length, 0);
  while (recent.length > 1 && total > maxChars) {
    total -= recent.shift().content.length;
  }

  return recent;
}

export default { buildHistoryWindow };
