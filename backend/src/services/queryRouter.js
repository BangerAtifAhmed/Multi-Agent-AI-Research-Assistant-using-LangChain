import config from '../config/index.js';
import ragClient from '../rag/ragClient.js';
import logger from '../utils/logger.js';

/**
 * Automatic query routing.
 *
 * Decides, per message, whether to answer from the model alone, from the user's
 * documents, from live web search, or from both. The user never picks a mode.
 *
 * Design: deterministic rules first, LLM classification only as a fallback.
 * Most messages are decided by pattern matching in microseconds; the extra LLM
 * call happens only when the wording is genuinely ambiguous, which keeps the
 * common case free.
 *
 * The result is always constrained by what is actually available: no document
 * route without ready documents, no web route without a search provider. The
 * caller enforces this route - it is never taken from the client.
 */

export const ROUTES = Object.freeze({
  LLM: 'llm',
  DOCUMENTS: 'documents',
  WEB: 'web',
  HYBRID: 'hybrid',
});

// --- Signals ---------------------------------------------------------------

/** Explicitly about the user's own material. */
const DOCUMENT_PATTERNS = [
  /\b(my|our|the|this|that|attached|uploaded)\s+(document|doc|file|pdf|paper|report|slides?|presentation|deck|contract|notes?|manual|book|spreadsheet)s?\b/i,
  /\b(in|from|according to|based on)\s+(the|my|this|that)\s+(document|doc|file|pdf|paper|report|slides?|attachment)s?\b/i,
  /\bi\s+(uploaded|attached|shared|added)\b/i,
  /\b(summar[iy]|summarise|summarize)\s+(the|my|this)\s+(document|doc|file|pdf|paper|report|slides?)\b/i,
  /\bwhat does (it|the (document|pdf|file|paper|report)) say\b/i,
  /\b(page|chapter|section|slide)\s+\d+\b/i,
];

/** Needs information newer than the model's training data. */
const WEB_PATTERNS = [
  /\b(latest|newest|recent|recently|current|currently|today|todays|tonight|yesterday|this (week|month|year)|right now|as of now|up to date|up-to-date)\b/i,
  /\b(news|headlines|announcement|released?|launch(ed)?|update[ds]?)\b/i,
  /\b(price|stock|share price|exchange rate|weather|forecast|score|standings|election|who won)\b/i,
  // Figures that change constantly and are never reliable from training data.
  // A model asked for a box-office total will happily invent one, so these must
  // reach a search even when the sentence has no "latest"/"current" wording.
  /\b(box[- ]?office|collections?|gross(ed|ing)?|earnings|revenue|takings|ticket sales)\b/i,
  /\b(opening (day|weekend|night)|first (day|weekend)|footfalls?)\b/i,
  /\b(worldwide|domestic|overseas|lifetime)\s+(gross|collection|total|earnings|box[- ]?office)\b/i,
  /\b(in|since|during)\s+20(2[4-9]|[3-9]\d)\b/,
  /\b(state of the art|sota)\b/i,
  /\bwhat('s| is) (happening|new|going on)\b/i,
  /\b(search|google|look ?up)\s+(the\s+)?(web|online|internet)\b/i,
];

/**
 * Facts that are worthless unless they are current. When one of these appears,
 * a search is required rather than merely preferred: answering from training
 * data would produce a confident, wrong number.
 */
const REQUIRES_FRESH_DATA = [
  /\b(box[- ]?office|collections?|gross(ed|ing)?|earnings|revenue|ticket sales)\b/i,
  /\b(latest|current|currently|today|todays|recent|recently|right now|as of now)\b/i,
  /\b(news|headlines|price|stock|share price|exchange rate|weather|forecast|score|standings)\b/i,
];

/** True when the message asks for something that must come from a live source. */
export const needsFreshData = (message) => countMatches(REQUIRES_FRESH_DATA, message || '') > 0;

/** Asks to relate the user's material to the outside world. */
const HYBRID_PATTERNS = [
  /\bcompare\b[\s\S]{0,60}\b(with|to|against|versus|vs\.?)\b/i,
  /\b(how does|how do)\b[\s\S]{0,40}\bcompare\b/i,
  /\b(my|our|the|this)\s+\w*\s*(document|doc|file|pdf|paper|report|research|work|approach|method)\b[\s\S]{0,60}\b(latest|current|recent|modern|today|state of the art|industry|others?)\b/i,
  /\b(latest|current|recent)\b[\s\S]{0,60}\b(my|our|the attached|the uploaded)\s+(document|doc|file|pdf|paper|report|research)\b/i,
];

/** General knowledge the model can answer unaided. */
const GENERAL_KNOWLEDGE_PATTERNS = [
  /^\s*(what|who|when|where|why|how)\s+(is|are|was|were|does|do|did|can|could|should)\b/i,
  /^\s*(explain|define|describe|tell me about|teach me|give me an example)\b/i,
  /\b(what is|define|meaning of)\s+\w+/i,
  /\b(write|generate|create|draft|refactor|debug|fix|translate|rewrite)\b/i,
];

/** Conversational filler that never needs retrieval. */
const TRIVIAL_PATTERNS = [
  /^\s*(hi|hey|hello|yo|thanks?|thank you|ok(ay)?|cool|nice|great|got it|sure|bye|good (morning|evening|night))\b[\s!.?]*$/i,
  /^\s*(who are you|what can you do|help)\b[\s?]*$/i,
];

const countMatches = (patterns, text) =>
  patterns.reduce((total, pattern) => total + (pattern.test(text) ? 1 : 0), 0);

/**
 * Rule-based classification. Returns null when the signals are too weak to be
 * confident, which is the only case that reaches the LLM classifier.
 */
export function classifyDeterministic(message) {
  const text = (message || '').trim();
  if (!text) return { route: ROUTES.LLM, confidence: 1, reason: 'empty message' };

  if (countMatches(TRIVIAL_PATTERNS, text)) {
    return { route: ROUTES.LLM, confidence: 0.99, reason: 'conversational message' };
  }

  const documentHits = countMatches(DOCUMENT_PATTERNS, text);
  const webHits = countMatches(WEB_PATTERNS, text);
  const hybridHits = countMatches(HYBRID_PATTERNS, text);

  // "Compare my paper with recent work" - explicit both-sides request.
  if (hybridHits > 0 || (documentHits > 0 && webHits > 0)) {
    return {
      route: ROUTES.HYBRID,
      confidence: hybridHits > 0 ? 0.9 : 0.75,
      reason: 'refers to the user documents and to current information',
    };
  }

  if (documentHits > 0 && webHits === 0) {
    return {
      route: ROUTES.DOCUMENTS,
      confidence: documentHits > 1 ? 0.95 : 0.85,
      reason: 'refers to the user documents',
    };
  }

  if (webHits > 0 && documentHits === 0) {
    return {
      route: ROUTES.WEB,
      confidence: webHits > 1 ? 0.95 : 0.8,
      reason: 'asks for current information',
    };
  }

  // No retrieval signal at all, but clearly a general question or a task.
  if (countMatches(GENERAL_KNOWLEDGE_PATTERNS, text)) {
    return { route: ROUTES.LLM, confidence: 0.7, reason: 'general knowledge question' };
  }

  return null;
}

const CLASSIFIER_PROMPT = `You route a user's question to the right information source.

Reply with exactly one word:
llm        - general knowledge, reasoning, writing or coding help
documents  - about the user's own uploaded files
web        - needs current or very recent information
hybrid     - needs both the user's files and current information

Question: `;

/** Cheap single-word LLM classification, used only for ambiguous messages. */
async function classifyWithLlm(message) {
  try {
    const answer = await ragClient.classifyRoute(`${CLASSIFIER_PROMPT}${message}`);
    const route = String(answer || '').trim().toLowerCase().match(/llm|documents|web|hybrid/)?.[0];
    if (route) {
      return { route, confidence: 0.7, reason: 'classified by the language model' };
    }
  } catch (error) {
    logger.debug(`router: LLM classification failed (${error.message})`);
  }
  return null;
}

/**
 * Routes one message.
 *
 * @param {object} options
 * @param {string} options.message            the user's text
 * @param {boolean} options.hasDocuments      user has at least one ready document
 * @param {boolean} options.hasAttachment     a document was attached to this turn
 * @param {boolean} options.webSearchEnabled  a search provider is configured
 * @param {boolean} options.allowLlmFallback  permit the extra classification call
 * @param {boolean} options.forceWeb          the user asked for a web search explicitly
 * @returns {Promise<{route: string, confidence: number, reason: string}>}
 */
export async function routeQuery({
  message,
  hasDocuments = false,
  hasAttachment = false,
  webSearchEnabled = true,
  allowLlmFallback = true,
  forceWeb = false,
}) {
  // The user turned the web-search toggle on for this message. It is a request,
  // not a route: the server still refuses if no provider is configured, and
  // still pairs it with the documents when one is attached to this turn.
  if (forceWeb && webSearchEnabled) {
    return {
      route: hasAttachment ? ROUTES.HYBRID : ROUTES.WEB,
      confidence: 1,
      reason: 'the user asked for a web search',
      requiresFreshData: true,
    };
  }
  // A file attached to this very message is an unambiguous instruction to use
  // it, so no classification is needed unless the user also asks for fresh
  // information.
  if (hasAttachment) {
    const wantsWeb = countMatches(WEB_PATTERNS, message) > 0 ||
      countMatches(HYBRID_PATTERNS, message) > 0;
    const route = wantsWeb && webSearchEnabled ? ROUTES.HYBRID : ROUTES.DOCUMENTS;
    return { route, confidence: 0.99, reason: 'a document was attached to this message' };
  }

  let decision = classifyDeterministic(message);

  if (!decision && allowLlmFallback) {
    decision = await classifyWithLlm(message);
  }

  if (!decision) {
    // Unclassifiable: prefer the user's own material when they have any.
    decision = hasDocuments
      ? { route: ROUTES.DOCUMENTS, confidence: 0.4, reason: 'defaulting to the user documents' }
      : { route: ROUTES.LLM, confidence: 0.5, reason: 'no retrieval signal detected' };
  }

  // Safety net over every path above, including the LLM classifier: a question
  // about a figure that changes daily is never answered from memory while a
  // search provider is available.
  if (webSearchEnabled && needsFreshData(message)
      && decision.route !== ROUTES.WEB && decision.route !== ROUTES.HYBRID) {
    decision = {
      route: decision.route === ROUTES.DOCUMENTS && hasDocuments ? ROUTES.HYBRID : ROUTES.WEB,
      confidence: Math.max(decision.confidence, 0.9),
      reason: `${decision.reason}; overridden - needs current information`,
    };
  }

  const routed = applyAvailability(decision, { hasDocuments, webSearchEnabled });
  // The caller needs to know when an answer *must* be grounded in a live
  // source, so it can refuse to present training-data numbers as fact.
  return { ...routed, requiresFreshData: needsFreshData(message) };
}

/** Downgrades a route the deployment cannot actually serve. */
export function applyAvailability(decision, { hasDocuments, webSearchEnabled }) {
  let { route, confidence, reason } = decision;

  if ((route === ROUTES.DOCUMENTS || route === ROUTES.HYBRID) && !hasDocuments) {
    if (route === ROUTES.HYBRID && webSearchEnabled) {
      return { route: ROUTES.WEB, confidence, reason: `${reason}; no documents available` };
    }
    return webSearchEnabled && route === ROUTES.HYBRID
      ? { route: ROUTES.WEB, confidence, reason: `${reason}; no documents available` }
      : { route: ROUTES.LLM, confidence, reason: `${reason}; no documents available` };
  }

  if ((route === ROUTES.WEB || route === ROUTES.HYBRID) && !webSearchEnabled) {
    if (route === ROUTES.HYBRID && hasDocuments) {
      return { route: ROUTES.DOCUMENTS, confidence, reason: `${reason}; web search unavailable` };
    }
    return { route: ROUTES.LLM, confidence, reason: `${reason}; web search unavailable` };
  }

  return { route, confidence, reason };
}

/** Maps a route onto the retrieval mode the RAG pipeline understands. */
export function routeToPipelineMode(route) {
  switch (route) {
    case ROUTES.DOCUMENTS:
      return 'document';
    case ROUTES.WEB:
      return 'web';
    case ROUTES.HYBRID:
      return 'hybrid';
    default:
      // No retrieval: the generation step still runs, with empty context.
      return 'llm';
  }
}

export default {
  routeQuery,
  classifyDeterministic,
  applyAvailability,
  routeToPipelineMode,
  needsFreshData,
  ROUTES,
};
