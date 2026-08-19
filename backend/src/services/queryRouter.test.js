/**
 * Routing tests.
 *
 *   npm test        (node --test)
 *
 * The rule these exist to protect: a question whose answer changes from week to
 * week must reach a live search. Answering "what is the box office collection
 * of X" from training data produces a confident, wrong number, which is exactly
 * the failure these cases were written for.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ROUTES,
  applyAvailability,
  classifyDeterministic,
  needsFreshData,
  routeQuery,
  routeToPipelineMode,
} from './queryRouter.js';

/** Routing with the LLM classifier disabled, so results are deterministic. */
const route = (message, options = {}) =>
  routeQuery({ message, webSearchEnabled: true, allowLlmFallback: false, ...options });

describe('current-information questions reach the web', () => {
  const mustSearch = [
    // The exact queries from the production report.
    'The new movie of spider man brand new day collection',
    'What is the latest box office collection of Spider-Man: Brand New Day?',
    'What is the worldwide collection of Spider-Man: Brand New Day?',
    'What are the latest news updates about Spider-Man: Brand New Day?',
    // The vocabulary that must always force a search.
    'box office collection of Avatar 3',
    'what is the current price of bitcoin',
    'todays weather in Karachi',
    'latest news on the election',
    'recent developments in fusion power',
    'what is the opening weekend gross of Dune 3',
    'lifetime collection of Pushpa 2',
    'how much has the movie grossed',
    'total earnings of the film so far',
    'current exchange rate for the pound',
    'what is the score right now',
  ];

  for (const message of mustSearch) {
    it(`"${message.slice(0, 52)}" -> web`, async () => {
      const decision = await route(message);
      assert.equal(decision.route, ROUTES.WEB, `got ${decision.route} (${decision.reason})`);
    });
  }

  it('still reaches the web when the user has documents', async () => {
    // The regression: an unrelated library used to swallow these questions.
    const decision = await route('What is the worldwide collection of Spider-Man: Brand New Day?', {
      hasDocuments: true,
    });
    assert.equal(decision.route, ROUTES.WEB);
  });

  it('marks these questions as requiring live data', async () => {
    const decision = await route('latest box office collection of Spider-Man');
    assert.equal(decision.requiresFreshData, true);
  });
});

describe('the general-knowledge shortcut cannot swallow a fresh-data question', () => {
  it('"What is the ..." phrasing does not force the llm route', () => {
    // "What is X" matches the general-knowledge pattern, but the subject makes
    // it a live-data question, and that has to win.
    const decision = classifyDeterministic('What is the worldwide collection of Spider-Man?');
    assert.equal(decision.route, ROUTES.WEB);
  });

  it('genuine general knowledge still answers without retrieval', () => {
    assert.equal(classifyDeterministic('What is a transformer model?').route, ROUTES.LLM);
    assert.equal(classifyDeterministic('Explain gradient descent').route, ROUTES.LLM);
    assert.equal(classifyDeterministic('Write a function that reverses a string').route, ROUTES.LLM);
  });

  it('does not treat greetings as searchable', () => {
    assert.equal(classifyDeterministic('hello').route, ROUTES.LLM);
    assert.equal(classifyDeterministic('thanks!').route, ROUTES.LLM);
  });
});

describe('the override is a safety net over every path', () => {
  it('upgrades a documents decision to hybrid when live data is needed', async () => {
    const decision = await route('what do my notes say about the latest box office collection', {
      hasDocuments: true,
    });
    assert.ok([ROUTES.HYBRID, ROUTES.WEB].includes(decision.route), decision.route);
  });

  it('does not override when no search provider is configured', async () => {
    const decision = await route('latest box office collection of Spider-Man', {
      webSearchEnabled: false,
    });
    // Nothing to search with, so it degrades - but the caller is still told the
    // question needed live data, so the answer can say so.
    assert.equal(decision.route, ROUTES.LLM);
    assert.equal(decision.requiresFreshData, true);
  });
});

describe('the composer web-search toggle', () => {
  it('forces a web search for a question that would not have triggered one', async () => {
    // Without the toggle this is a plain general-knowledge question.
    assert.equal((await route('explain how photosynthesis works')).route, ROUTES.LLM);
    const forced = await route('explain how photosynthesis works', { forceWeb: true });
    assert.equal(forced.route, ROUTES.WEB);
    assert.equal(forced.reason, 'the user asked for a web search');
  });

  it('pairs the search with the documents when one is attached', async () => {
    const decision = await route('what does this say about the topic', {
      forceWeb: true,
      hasAttachment: true,
      hasDocuments: true,
    });
    assert.equal(decision.route, ROUTES.HYBRID);
  });

  it('does not let the toggle conjure a provider that is not configured', async () => {
    // The client can ask; the server still refuses when there is nothing to
    // search with, rather than emitting an empty "web" turn.
    const decision = await route('latest news', { forceWeb: true, webSearchEnabled: false });
    assert.equal(decision.route, ROUTES.LLM);
  });

  it('leaves routing untouched when the toggle is off', async () => {
    const off = await route('summarize my document', { hasDocuments: true, forceWeb: false });
    assert.equal(off.route, ROUTES.DOCUMENTS);
  });
});

describe('document questions still route to documents', () => {
  const documentQueries = [
    'summarize my document',
    'what does the PDF say about attention',
    'according to the report, what was the conclusion',
    'what is on page 4',
  ];

  for (const message of documentQueries) {
    it(`"${message}" -> documents`, async () => {
      const decision = await route(message, { hasDocuments: true });
      assert.equal(decision.route, ROUTES.DOCUMENTS, `got ${decision.route}`);
    });
  }

  it('an attachment on this turn wins', async () => {
    const decision = await route('summarise this', { hasDocuments: true, hasAttachment: true });
    assert.equal(decision.route, ROUTES.DOCUMENTS);
  });

  it('an attachment plus a current-information request becomes hybrid', async () => {
    const decision = await route('compare this with the latest research', {
      hasDocuments: true,
      hasAttachment: true,
    });
    assert.equal(decision.route, ROUTES.HYBRID);
  });
});

describe('availability constraints', () => {
  it('never routes to documents when the user has none', () => {
    const decision = applyAvailability(
      { route: ROUTES.DOCUMENTS, confidence: 0.9, reason: 'test' },
      { hasDocuments: false, webSearchEnabled: true },
    );
    assert.notEqual(decision.route, ROUTES.DOCUMENTS);
  });

  it('never routes to web when search is unavailable', () => {
    const decision = applyAvailability(
      { route: ROUTES.WEB, confidence: 0.9, reason: 'test' },
      { hasDocuments: false, webSearchEnabled: false },
    );
    assert.equal(decision.route, ROUTES.LLM);
  });

  it('hybrid degrades to whichever half is available', () => {
    assert.equal(
      applyAvailability({ route: ROUTES.HYBRID, confidence: 1, reason: '' },
        { hasDocuments: false, webSearchEnabled: true }).route,
      ROUTES.WEB,
    );
    assert.equal(
      applyAvailability({ route: ROUTES.HYBRID, confidence: 1, reason: '' },
        { hasDocuments: true, webSearchEnabled: false }).route,
      ROUTES.DOCUMENTS,
    );
  });
});

describe('needsFreshData', () => {
  it('recognises the vocabulary that must not be answered from memory', () => {
    for (const message of [
      'latest news', 'current price', 'box office collection', 'todays weather',
      'recent updates', 'what is the score', 'total revenue this year',
    ]) {
      assert.equal(needsFreshData(message), true, message);
    }
  });

  it('leaves timeless questions alone', () => {
    for (const message of [
      'explain how HNSW indexing works', 'write a haiku about autumn',
      'what is a vector database', 'summarize my document',
    ]) {
      assert.equal(needsFreshData(message), false, message);
    }
  });
});

describe('pipeline mode mapping', () => {
  it('maps each route to the mode the pipeline understands', () => {
    assert.equal(routeToPipelineMode(ROUTES.DOCUMENTS), 'document');
    assert.equal(routeToPipelineMode(ROUTES.WEB), 'web');
    assert.equal(routeToPipelineMode(ROUTES.HYBRID), 'hybrid');
    assert.equal(routeToPipelineMode(ROUTES.LLM), 'llm');
  });
});
