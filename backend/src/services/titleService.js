import config from '../config/index.js';

/**
 * Derives a short conversation title from the first user message.
 *
 * Deliberately deterministic: no extra LLM round-trip (and therefore no extra
 * cost or latency) just to name a chat.
 */

const LEADING_PATTERNS = [
  /^(please\s+)?(can|could|would)\s+you\s+(please\s+)?/i,
  /^(please\s+)?(tell|teach)\s+me\s+(about|how|why|what)?\s*/i,
  /^(please\s+)?(explain|describe|summarise|summarize|compare|list|define)\s+(me\s+)?(the\s+|a\s+|an\s+)?/i,
  /^(what|which)\s+(is|are|was|were|does|do|did)\s+(the\s+|a\s+|an\s+)?/i,
  /^how\s+(does|do|did|can|could|would|is|are)\s+(the\s+|a\s+|an\s+)?/i,
  /^(why|when|where|who)\s+(is|are|was|were|does|do|did|should)\s+(the\s+|a\s+|an\s+)?/i,
  /^i\s+(want|need|would like)\s+to\s+(know|understand)\s+(about\s+)?/i,
  /^give\s+me\s+(a\s+|an\s+)?/i,
];

// Trailing verbs that survive the stripping above but add nothing to a title.
const TRAILING_NOISE = new Set([
  'work',
  'works',
  'working',
  'do',
  'does',
  'mean',
  'means',
  'used',
  'use',
  'about',
  'for',
  'in',
  'of',
  'the',
  'a',
  'an',
  'and',
  'or',
  'to',
  'is',
  'are',
]);

const MAX_WORDS = 6;

const titleCase = (word) =>
  word.length > 3 || /^[A-Z]/.test(word)
    ? word.charAt(0).toUpperCase() + word.slice(1)
    : word;

export function generateTitle(message, fallback = 'New chat') {
  if (typeof message !== 'string') return fallback;

  // First line only, and drop Markdown noise / code fences.
  let text = message
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#*_`>~|]/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  if (!text) return fallback;

  text = text.split(/(?<=[.?!])\s/)[0];

  for (const pattern of LEADING_PATTERNS) {
    const stripped = text.replace(pattern, '');
    if (stripped !== text && stripped.trim()) {
      text = stripped;
      break;
    }
  }

  let words = text
    .replace(/[?!.,;:]+$/g, '')
    .split(/\s+/)
    .filter(Boolean);

  while (words.length > 1 && TRAILING_NOISE.has(words.at(-1).toLowerCase())) {
    words.pop();
  }

  if (!words.length) {
    words = message.trim().split(/\s+/).filter(Boolean);
  }
  if (!words.length) return fallback;

  let title = words.slice(0, MAX_WORDS).map(titleCase).join(' ');

  if (title.length > config.limits.maxTitleLength) {
    title = `${title.slice(0, config.limits.maxTitleLength - 1).trimEnd()}…`;
  }

  return title.charAt(0).toUpperCase() + title.slice(1);
}

export default { generateTitle };
