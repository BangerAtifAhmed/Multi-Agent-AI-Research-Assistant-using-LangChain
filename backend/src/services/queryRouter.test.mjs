/**
 * Query router tests.
 *
 *   node src/services/queryRouter.test.mjs
 *
 * These exercise the deterministic path only - no network, no LLM call - so
 * they run in milliseconds and prove the common cases never need one.
 */
import { classifyDeterministic, applyAvailability, routeQuery, ROUTES } from './queryRouter.js';

let passed = 0;
let failed = 0;

const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`);
  ok ? (passed += 1) : (failed += 1);
};

const expectRoute = async (message, expected, options = {}) => {
  const result = await routeQuery({
    message,
    hasDocuments: true,
    webSearchEnabled: true,
    // Deterministic only: a test must never depend on the LLM classifier.
    allowLlmFallback: false,
    ...options,
  });
  check(
    `"${message.slice(0, 52)}${message.length > 52 ? '…' : ''}" -> ${expected}`,
    result.route === expected,
    result.route === expected ? '' : `got ${result.route} (${result.reason})`,
  );
};

console.log('=== LLM only (general knowledge, reasoning, writing) ===');
await expectRoute('What is RAG?', ROUTES.LLM);
await expectRoute('What is recursion?', ROUTES.LLM);
await expectRoute('Explain how gradient descent works', ROUTES.LLM);
await expectRoute('Write a Python function that reverses a linked list', ROUTES.LLM);
await expectRoute('Define idempotency', ROUTES.LLM);
await expectRoute('hi', ROUTES.LLM);
await expectRoute('thanks!', ROUTES.LLM);

console.log('\n=== Documents ===');
await expectRoute('What does my uploaded PDF say about attention?', ROUTES.DOCUMENTS);
await expectRoute('Summarise the document', ROUTES.DOCUMENTS);
await expectRoute('According to my report, what were the findings?', ROUTES.DOCUMENTS);
await expectRoute('What does the paper say on page 12?', ROUTES.DOCUMENTS);
await expectRoute('I uploaded a contract - what is the notice period?', ROUTES.DOCUMENTS);

console.log('\n=== Web ===');
await expectRoute('What are the latest AI developments?', ROUTES.WEB);
await expectRoute('What is happening in AI today?', ROUTES.WEB);
await expectRoute('Any news about the Mistral release?', ROUTES.WEB);
await expectRoute('What is the current price of Bitcoin?', ROUTES.WEB);
await expectRoute('Who won the election?', ROUTES.WEB);

console.log('\n=== Hybrid ===');
await expectRoute('Compare my uploaded research paper with the latest research.', ROUTES.HYBRID);
await expectRoute('How does my document compare with current best practice?', ROUTES.HYBRID);
await expectRoute('Compare my report with recent industry standards', ROUTES.HYBRID);

console.log('\n=== Attachment forces the document route ===');
{
  const result = await routeQuery({
    message: 'summarise this',
    hasDocuments: true,
    hasAttachment: true,
    allowLlmFallback: false,
  });
  check('attached file -> documents', result.route === ROUTES.DOCUMENTS, result.route);

  const both = await routeQuery({
    message: 'compare this with the latest research',
    hasDocuments: true,
    hasAttachment: true,
    allowLlmFallback: false,
  });
  check('attached file + "latest" -> hybrid', both.route === ROUTES.HYBRID, both.route);
}

console.log('\n=== Availability downgrades ===');
{
  const noDocs = await routeQuery({
    message: 'What does my document say about X?',
    hasDocuments: false,
    allowLlmFallback: false,
  });
  check('documents route without documents -> llm', noDocs.route === ROUTES.LLM, noDocs.route);

  const noWeb = await routeQuery({
    message: 'What are the latest AI developments?',
    hasDocuments: false,
    webSearchEnabled: false,
    allowLlmFallback: false,
  });
  check('web route without a search provider -> llm', noWeb.route === ROUTES.LLM, noWeb.route);

  const hybridNoWeb = applyAvailability(
    { route: ROUTES.HYBRID, confidence: 0.9, reason: 'test' },
    { hasDocuments: true, webSearchEnabled: false },
  );
  check('hybrid without web -> documents', hybridNoWeb.route === ROUTES.DOCUMENTS, hybridNoWeb.route);

  const hybridNoDocs = applyAvailability(
    { route: ROUTES.HYBRID, confidence: 0.9, reason: 'test' },
    { hasDocuments: false, webSearchEnabled: true },
  );
  check('hybrid without documents -> web', hybridNoDocs.route === ROUTES.WEB, hybridNoDocs.route);
}

console.log('\n=== Shape and cost ===');
{
  const result = await routeQuery({ message: 'What is RAG?', allowLlmFallback: false });
  check(
    'returns {route, confidence, reason}',
    typeof result.route === 'string' &&
      typeof result.confidence === 'number' &&
      typeof result.reason === 'string',
    JSON.stringify(result),
  );

  // Everything above resolved without the classifier, which is the whole point
  // of the deterministic-first design.
  const ambiguous = classifyDeterministic('the thing from before');
  check('genuinely ambiguous input defers to the LLM', ambiguous === null, String(ambiguous));

  const started = Date.now();
  for (let i = 0; i < 1000; i += 1) classifyDeterministic('What is RAG?');
  check('1000 classifications are fast', Date.now() - started < 500, `${Date.now() - started}ms`);
}

console.log(`\n${failed === 0 ? 'ALL ROUTER TESTS PASSED' : `${failed} FAILED`} (${passed} passed)`);
process.exit(failed ? 1 : 0);
