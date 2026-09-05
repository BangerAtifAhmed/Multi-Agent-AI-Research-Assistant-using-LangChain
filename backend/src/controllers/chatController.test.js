/**
 * SSE lifecycle tests for POST /api/chat.
 *
 *   npm test        (node --test, no extra tooling)
 *
 * The browser keeps the composer in its generating state - Stop button and all
 * - until this response closes. So the property under test is not what the
 * stream says but that it *ends*: on success, on a reported LLM failure, on a
 * thrown error, when the user stops, and even when nothing downstream ever
 * returns. A turn that leaves the response open is a turn the user can never
 * retry, which is exactly the bug these guard.
 *
 * The chat service is stubbed; nothing here touches PostgreSQL, Redis or the
 * RAG service.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';

import express from 'express';

// The controller only reads config at call time, so these are enough to import
// the module graph without a database or a session secret.
process.env.DATABASE_URL ??= 'postgres://test/test';
process.env.SESSION_SECRET ??= 'test-secret-not-used-by-these-tests';

const { default: config } = await import('../config/index.js');
const { default: chatService } = await import('../services/chatService.js');
const { default: chatController } = await import('./chatController.js');

const realRunChatTurn = chatService.runChatTurn;
const realTurnTimeout = config.limits.chatTurnTimeoutMs;

/** Set by each test; the controller calls whatever is here. */
let runTurn = null;
/** Stands in for what the daily-limit middleware attaches to the request. */
let pendingQuota = null;

let server;
let baseUrl;

before(async () => {
  const app = express();
  app.use(express.json());
  app.post('/chat', (req, res, next) => {
    req.user = { id: 'user-1' };
    if (pendingQuota) req.chatQuota = { ...pendingQuota, commit() {} };
    Promise.resolve(chatController.chat(req, res)).catch(next);
  });
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    res.status(error.status ?? 500).json({ error: { message: error.message } });
  });

  chatService.runChatTurn = (...args) => runTurn(...args);

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  chatService.runChatTurn = realRunChatTurn;
  config.limits.chatTurnTimeoutMs = realTurnTimeout;
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  config.limits.chatTurnTimeoutMs = realTurnTimeout;
});

/**
 * Reads the whole SSE response, failing rather than hanging if it never ends.
 * `closed` is the assertion that matters: it is what releases the UI.
 */
async function readStream({ body = { message: 'hi' }, signal, budgetMs = 5000, quota } = {}) {
  pendingQuota = quota ?? null;
  const response = await fetch(`${baseUrl}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let closed = false;

  const drain = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    closed = true;
  })();

  const timer = new Promise((resolve) => setTimeout(resolve, budgetMs).unref());
  await Promise.race([drain.catch(() => {}), timer]);

  const events = [];
  for (const frame of text.split('\n\n')) {
    const name = /^event: (\w+)/m.exec(frame)?.[1];
    const data = /^data: (.*)$/m.exec(frame)?.[1];
    if (name) events.push({ event: name, data: data ? JSON.parse(data) : null });
  }

  return { status: response.status, events, closed, names: events.map((e) => e.event) };
}

const doneEvent = (events) => events.find((entry) => entry.event === 'done')?.data;
const errorEvent = (events) => events.find((entry) => entry.event === 'error')?.data;

describe('POST /chat SSE lifecycle', () => {
  it('closes the stream after a normal answer', async () => {
    runTurn = async ({ emit }) => {
      emit('meta', { conversation: { id: 'c1' }, userMessage: {}, assistantMessageId: 'a1' });
      emit('token', { text: 'Gated recurrent units.' });
      return {
        finishReason: 'stop',
        conversation: { id: 'c1' },
        conversationId: 'c1',
        assistantMessage: { id: 'a1', content: 'Gated recurrent units.' },
        assistantMessageId: 'a1',
      };
    };

    const { closed, names, events } = await readStream();

    assert.equal(closed, true, 'the response must end');
    assert.deepEqual(names, ['meta', 'token', 'done']);
    assert.equal(doneEvent(events).finishReason, 'stop');
  });

  it('closes the stream when the model reports a rate limit', async () => {
    runTurn = async ({ emit }) => {
      emit('meta', { conversation: { id: 'c1' }, userMessage: {}, assistantMessageId: 'a1' });
      return {
        finishReason: 'error',
        conversation: null,
        conversationId: 'c1',
        assistantMessage: null,
        assistantMessageId: 'a1',
        error: {
          message: 'The language model is rate limited right now. Please try again in a moment.',
          code: 'LLM_RATE_LIMITED',
        },
      };
    };

    const { closed, names, events } = await readStream();

    assert.equal(closed, true, 'a rate-limited turn must still end the stream');
    assert.deepEqual(names, ['meta', 'error', 'done']);
    assert.equal(errorEvent(events).code, 'LLM_RATE_LIMITED');
    assert.equal(doneEvent(events).finishReason, 'error');
    // The last frame is `done`, never `error`: that is what the browser waits
    // for before it will accept another prompt.
    assert.equal(names.at(-1), 'done');
  });

  it('closes the stream when the turn throws', async () => {
    runTurn = async () => {
      throw new Error('the pipeline exploded');
    };

    const { closed, names, events } = await readStream();

    assert.equal(closed, true);
    assert.deepEqual(names, ['error', 'done']);
    assert.equal(errorEvent(events).code, 'CHAT_FAILED');
    // The raw failure never reaches the browser.
    assert.doesNotMatch(errorEvent(events).message, /exploded/);
    assert.equal(doneEvent(events).finishReason, 'error');
  });

  it('closes the stream when nothing downstream ever returns', async () => {
    // The regression: a wedged RAG service or LLM left this promise pending,
    // the response stayed open behind its heartbeat, and the UI generated
    // forever.
    config.limits.chatTurnTimeoutMs = 300;

    let release;
    runTurn = () => new Promise((resolve) => {
      release = resolve;
    });

    const { closed, names, events } = await readStream({ budgetMs: 4000 });
    release?.({ finishReason: 'stop' });

    assert.equal(closed, true, 'the deadline must close a turn that never finishes');
    assert.deepEqual(names, ['error', 'done']);
    assert.equal(errorEvent(events).code, 'CHAT_TIMEOUT');
    assert.equal(doneEvent(events).finishReason, 'error');
  });

  it('aborts the turn when the client stops generating', async () => {
    let observed = null;
    let aborted = null;

    runTurn = ({ emit, signal }) => {
      observed = signal;
      emit('meta', { conversation: { id: 'c1' }, userMessage: {}, assistantMessageId: 'a1' });
      emit('token', { text: 'thinking' });
      return new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          resolve({ finishReason: 'aborted', conversation: { id: 'c1' }, conversationId: 'c1' });
        });
      });
    };

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200).unref();

    await readStream({ signal: controller.signal }).catch((error) => {
      assert.equal(error.name, 'AbortError');
    });

    // Give Express its 'close' event.
    await new Promise((resolve) => setTimeout(resolve, 200).unref());

    assert.ok(observed, 'the turn receives an abort signal');
    assert.equal(aborted, true, 'stopping the stream aborts the work behind it');
  });

  it('reports the daily allowance on the stream when the turn is accepted', async () => {
    runTurn = async ({ emit, onAccepted }) => {
      onAccepted?.();
      emit('meta', { conversation: { id: 'c1' }, userMessage: {}, assistantMessageId: 'a1' });
      emit('token', { text: 'hi' });
      return { finishReason: 'stop', conversation: { id: 'c1' }, conversationId: 'c1' };
    };

    const { names, events } = await readStream({
      quota: { used: 7, limit: 10, remaining: 3, resetAt: '2026-09-06T00:00:00.000Z', key: 'k' },
    });

    // Before `meta`, so the indicator updates the moment the chat is spent.
    assert.deepEqual(names, ['quota', 'meta', 'token', 'done']);
    assert.deepEqual(events[0].data, {
      used: 7,
      limit: 10,
      remaining: 3,
      resetAt: '2026-09-06T00:00:00.000Z',
    });
  });

  it('still reports the allowance when the turn then fails', async () => {
    // One user request is one chat: a turn that ran and failed still spent it,
    // and the number the user sees has to say so.
    runTurn = async ({ emit, onAccepted }) => {
      onAccepted?.();
      emit('meta', { conversation: { id: 'c1' }, userMessage: {}, assistantMessageId: 'a1' });
      return {
        finishReason: 'error',
        conversation: null,
        conversationId: 'c1',
        error: { message: 'The language model is rate limited right now.', code: 'LLM_RATE_LIMITED' },
      };
    };

    const { names, events } = await readStream({
      quota: { used: 8, limit: 10, remaining: 2, resetAt: '2026-09-06T00:00:00.000Z' },
    });

    assert.deepEqual(names, ['quota', 'meta', 'error', 'done']);
    assert.equal(events[0].data.remaining, 2);
  });

  it('sends no quota frame when the counter is unavailable', async () => {
    runTurn = async ({ emit, onAccepted }) => {
      onAccepted?.();
      emit('meta', { conversation: { id: 'c1' }, userMessage: {}, assistantMessageId: 'a1' });
      emit('token', { text: 'hi' });
      return { finishReason: 'stop', conversation: { id: 'c1' }, conversationId: 'c1' };
    };

    // Redis down: the limiter attaches nothing, so there is no figure to send
    // and the UI is told nothing rather than something invented.
    const { names } = await readStream();

    assert.deepEqual(names, ['meta', 'token', 'done']);
  });

  it('rejects an empty message as an ordinary HTTP error, not a stream', async () => {
    runTurn = async () => assert.fail('the turn must not start');

    const response = await fetch(`${baseUrl}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '   ' }),
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.match(body.error.message, /must not be empty/);
  });
});
