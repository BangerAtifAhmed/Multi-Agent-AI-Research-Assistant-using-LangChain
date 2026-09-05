/**
 * Chat stream lifecycle tests.
 *
 *   npm test        (node --test, no extra tooling)
 *
 * One rule, checked against every way a turn can end: when the turn is over the
 * composer is ready again. "Ready" is exactly what ChatInput means by it - the
 * Stop button is gone and `submit()` will send - because the button is rendered
 * on `isStreaming`, which is `stream.active`, which is what the runner
 * publishes. The bug these guard is a turn that ends without clearing it,
 * leaving Stop on screen and the user unable to ask anything else.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import createChatStreamRunner, { IDLE_STREAM } from './chatStreamRunner.js';

/** An SSE frame, as the backend writes it. */
const frame = (event, data = {}) => ({ event, data });

const META = frame('meta', {
  conversation: { id: 'c1', title: 'New chat' },
  userMessage: { id: 'm1', role: 'user', content: 'hi' },
  assistantMessageId: 'a1',
});

/** Replays frames, then ends - what a healthy backend does. */
const scripted =
  (frames, { failWith = null } = {}) =>
  async function* (payload, signal) {
    for (const item of frames) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      yield item;
    }
    if (failWith) throw failWith;
  };

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The chat surface, modelled on ChatView + ChatInput: `canSend` is false while
 * `stream.active` is true, which is precisely the condition that renders Stop
 * and blocks submit().
 */
function makeSurface(send, listeners = {}) {
  const surface = {
    state: { ...IDLE_STREAM },
    completions: [],
    metas: [],
    // What the indicator under the composer is showing. Only ever set from a
    // server payload - the surface has no counter of its own.
    quota: null,
    get canSend() {
      return !surface.state.active;
    },
    get showsStop() {
      return surface.state.active;
    },
  };

  surface.runner = createChatStreamRunner({
    send,
    onState: (patch) => {
      surface.state = { ...surface.state, ...patch };
    },
    onTokens: (text) => {
      surface.state = { ...surface.state, ...text };
    },
    onMeta: (data) => {
      surface.metas.push(data);
      listeners.onMeta?.(data);
    },
    onQuota: (quota) => {
      surface.quota = quota;
      listeners.onQuota?.(quota);
    },
    onComplete: (summary) => {
      surface.completions.push(summary);
      listeners.onComplete?.(summary);
    },
  });

  /** What ChatInput.submit() does, guard included. */
  surface.submit = (text) => {
    if (!surface.canSend) return null;
    return surface.runner.start({ message: text });
  };

  return surface;
}

/** Every scenario has to end the same way: ready, and able to send again. */
async function assertReadyAndReusable(surface) {
  assert.equal(surface.state.active, false, 'the turn must not still be active');
  assert.equal(surface.showsStop, false, 'the Stop button must be gone');
  assert.equal(surface.canSend, true, 'the composer must accept another prompt');

  const second = surface.submit('a second question');
  assert.ok(second, 'the second prompt must actually be sent');
  await second;
  assert.equal(surface.state.active, false, 'the second turn must end too');
}

describe('a normal stream', () => {
  it('paints the answer and becomes ready', async () => {
    const surface = makeSurface(
      scripted([
        META,
        frame('status', { stage: 'generating', label: 'Generating answer' }),
        frame('sources', { sources: [{ index: 1, title: 'GRU.pdf' }] }),
        frame('token', { text: 'Gated ' }),
        frame('token', { text: 'recurrent units.' }),
        frame('done', { finishReason: 'stop', conversation: { id: 'c1' }, message: { id: 'a1' } }),
      ]),
    );

    await surface.submit('what is a GRU?');

    assert.equal(surface.state.content, 'Gated recurrent units.');
    assert.equal(surface.state.error, null);
    assert.equal(surface.completions[0].finishReason, 'stop');
    assert.equal(surface.completions[0].savedMessage.id, 'a1');
    assert.equal(surface.metas.length, 1);
    await assertReadyAndReusable(surface);
  });
});

describe('Mistral is rate limited and Llama answers instead', () => {
  it('streams the fallback answer and becomes ready', async () => {
    // The failover happens inside the RAG service, so the browser sees an
    // ordinary successful stream. What matters here is that it still ends.
    const surface = makeSurface(
      scripted([
        META,
        frame('status', { stage: 'generating', label: 'Generating answer' }),
        frame('token', { text: 'Gated recurrent units.' }),
        frame('done', { finishReason: 'stop', conversation: { id: 'c1' }, message: { id: 'a1' } }),
      ]),
    );

    await surface.submit('what is a GRU?');

    assert.equal(surface.state.content, 'Gated recurrent units.');
    assert.equal(surface.state.error, null, 'a successful fallback is not an error');
    await assertReadyAndReusable(surface);
  });
});

describe('Mistral and the Llama fallback both fail', () => {
  it('shows the error and becomes ready', async () => {
    const surface = makeSurface(
      scripted([
        META,
        frame('error', {
          message: 'The language model is rate limited right now. Please try again in a moment.',
          code: 'LLM_RATE_LIMITED',
        }),
        frame('done', { finishReason: 'error', removed: true, conversationId: 'c1' }),
      ]),
    );

    await surface.submit('what is a GRU?');

    assert.match(surface.state.error, /rate limited/);
    assert.equal(surface.completions[0].finishReason, 'error');
    assert.equal(surface.completions[0].removedConversationId, 'c1');
    await assertReadyAndReusable(surface);
  });

  it('becomes ready even when the server never sends done', async () => {
    // What the RAG service used to do: report the failure and close, with no
    // terminal frame at all. The UI must not wait for one.
    const surface = makeSurface(
      scripted([META, frame('error', { message: 'rate limited', code: 'LLM_RATE_LIMITED' })]),
    );

    await surface.submit('what is a GRU?');

    assert.equal(surface.state.error, 'rate limited');
    await assertReadyAndReusable(surface);
  });
});

describe('the stream or network fails', () => {
  it('becomes ready when the connection drops mid-answer', async () => {
    const surface = makeSurface(
      scripted([META, frame('token', { text: 'Gated ' })], {
        failWith: new TypeError('Failed to fetch'),
      }),
    );

    await surface.submit('what is a GRU?');

    assert.equal(surface.state.error, 'Failed to fetch');
    assert.equal(surface.completions[0].finishReason, 'error');
    // The partial answer is kept, not discarded.
    assert.equal(surface.completions[0].content, 'Gated ');
    await assertReadyAndReusable(surface);
  });

  it('becomes ready when the request never opens', async () => {
    const surface = makeSurface(async function* () {
      throw new Error('Cannot reach the server.');
    });

    await surface.submit('what is a GRU?');

    assert.equal(surface.state.error, 'Cannot reach the server.');
    await assertReadyAndReusable(surface);
  });

  it('becomes ready when the server refuses with an HTTP error', async () => {
    // A 429 from the burst limiter or the daily chat quota arrives as an
    // ordinary rejected request, before any stream exists to close.
    const surface = makeSurface(async function* () {
      const error = new Error('Daily chat limit reached. You can send more chats tomorrow.');
      error.name = 'ApiRequestError';
      error.status = 429;
      throw error;
    });

    await surface.submit('what is a GRU?');

    assert.match(surface.state.error, /Daily chat limit reached/);
    assert.equal(surface.completions[0].finishReason, 'error');
    await assertReadyAndReusable(surface);
  });

  it('reports a stream that closed without a word', async () => {
    const surface = makeSurface(scripted([META]));

    await surface.submit('what is a GRU?');

    assert.match(surface.state.error, /empty response/);
    assert.equal(surface.completions[0].finishReason, 'error');
    await assertReadyAndReusable(surface);
  });
});

describe('the user presses Stop', () => {
  it('becomes ready and keeps what had streamed so far', async () => {
    // A slow answer: the first token lands, then the model goes quiet long
    // enough for the user to reach for Stop.
    const surface = makeSurface(async function* (payload, signal) {
      yield META;
      yield frame('token', { text: 'Gated ' });
      await tick(50);
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      yield frame('token', { text: 'never sent' });
    });

    const turn = surface.submit('what is a GRU?');
    await tick();
    assert.equal(surface.showsStop, true, 'Stop is on screen while streaming');

    // Stop, as ChatInput's button does.
    surface.runner.stop();
    await turn;

    assert.equal(surface.completions[0].aborted, true);
    assert.equal(surface.completions[0].finishReason, 'aborted');
    assert.equal(surface.state.error, null, 'stopping on purpose is not an error');
    assert.equal(surface.state.content, 'Gated ');
    await assertReadyAndReusable(surface);
  });

  it('is harmless when nothing is in flight', () => {
    const surface = makeSurface(scripted([META]));
    surface.runner.stop();
    assert.equal(surface.canSend, true);
  });
});

describe('whatever the listeners do', () => {
  const answer = [META, frame('token', { text: 'hi' }), frame('done', { finishReason: 'stop' })];
  const boom = () => {
    throw new Error('a bug in the view layer');
  };

  it('stays ready when onComplete throws', async () => {
    const surface = makeSurface(scripted(answer), { onComplete: boom });

    await surface.submit('what is a GRU?');

    assert.equal(surface.state.active, false, 'a throwing listener must not strand the UI');
    await assertReadyAndReusable(surface);
  });

  it('stays ready when onMeta throws', async () => {
    const surface = makeSurface(scripted(answer), { onMeta: boom });

    await surface.submit('what is a GRU?');

    // The turn fails - the view could not be updated - but it still ends.
    assert.match(surface.state.error, /view layer/);
    await assertReadyAndReusable(surface);
  });
});

describe('a superseded turn', () => {
  it('does not clear the state of the turn that replaced it', async () => {
    let releaseFirst;
    const blocked = new Promise((resolve) => {
      releaseFirst = resolve;
    });

    const surface = makeSurface(async function* (payload, signal) {
      if (payload.message === 'first') {
        yield META;
        await blocked;
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        yield frame('token', { text: 'stale' });
        return;
      }
      yield META;
      yield frame('token', { text: 'fresh' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      yield frame('done', { finishReason: 'stop' });
    });

    const first = surface.runner.start({ message: 'first' });
    const second = surface.runner.start({ message: 'second' });
    releaseFirst();

    await Promise.all([first, second]);

    assert.equal(surface.state.content, 'fresh', 'the newer turn owns the state');
    assert.equal(surface.state.active, false);
    assert.equal(surface.canSend, true);
    // The superseded turn stays silent rather than reporting a completion the
    // view would apply to the turn that replaced it.
    assert.equal(surface.completions.length, 1);
    assert.equal(surface.completions[0].content, 'fresh');
  });
});

describe('the daily chat allowance', () => {
  const quotaFrame = (used, remaining) =>
    frame('quota', {
      used,
      limit: 10,
      remaining,
      resetAt: '2026-09-06T00:00:00.000Z',
    });

  it('takes the figures the accepted turn reported', async () => {
    const surface = makeSurface(
      scripted([
        quotaFrame(7, 3),
        META,
        frame('token', { text: 'Gated recurrent units.' }),
        frame('done', { finishReason: 'stop', conversation: { id: 'c1' } }),
      ]),
    );

    await surface.submit('what is a GRU?');

    assert.deepEqual(surface.quota, {
      used: 7,
      limit: 10,
      remaining: 3,
      resetAt: '2026-09-06T00:00:00.000Z',
    });
    assert.equal(surface.completions[0].quota.used, 7);
    await assertReadyAndReusable(surface);
  });

  it('updates again on the next turn, from the server and not by counting', async () => {
    let used = 6;
    const surface = makeSurface(async function* () {
      used += 1;
      yield quotaFrame(used, 10 - used);
      yield META;
      yield frame('token', { text: 'hi' });
      yield frame('done', { finishReason: 'stop' });
    });

    await surface.submit('one');
    assert.equal(surface.quota.used, 7);

    await surface.submit('two');
    assert.equal(surface.quota.used, 8);
    assert.equal(surface.quota.remaining, 2);
  });

  it('still counts the chat when Mistral fails over to Llama', async () => {
    // The failover happens inside the RAG service, within the one request the
    // counter was incremented for. The user sees an answer and one chat spent.
    const surface = makeSurface(
      scripted([
        quotaFrame(8, 2),
        META,
        frame('token', { text: 'Gated recurrent units.' }),
        frame('done', { finishReason: 'stop', conversation: { id: 'c1' } }),
      ]),
    );

    await surface.submit('what is a GRU?');

    assert.equal(surface.state.content, 'Gated recurrent units.');
    assert.equal(surface.state.error, null, 'the failover is invisible to the user');
    assert.equal(surface.quota.used, 8, 'and costs exactly one chat');
    await assertReadyAndReusable(surface);
  });

  it('still counts the chat when the turn ran and then failed', async () => {
    const surface = makeSurface(
      scripted([
        quotaFrame(9, 1),
        META,
        frame('error', { message: 'The language model is rate limited right now.' }),
        frame('done', { finishReason: 'error', removed: true, conversationId: 'c1' }),
      ]),
    );

    await surface.submit('what is a GRU?');

    assert.equal(surface.quota.used, 9);
    assert.match(surface.state.error, /rate limited/);
    await assertReadyAndReusable(surface);
  });

  it('learns it has run out from the 429 that refused the send', async () => {
    const surface = makeSurface(async function* () {
      const refusal = new Error('Daily chat limit reached. You can send more chats tomorrow.');
      refusal.name = 'ApiRequestError';
      refusal.status = 429;
      refusal.code = 'DAILY_CHAT_LIMIT_REACHED';
      refusal.meta = {
        used: 10,
        limit: 10,
        remaining: 0,
        resetAt: '2026-09-06T00:00:00.000Z',
      };
      throw refusal;
    });

    await surface.submit('an eleventh question');

    // The exact message the backend wrote, not one composed here.
    assert.equal(
      surface.state.error,
      'Daily chat limit reached. You can send more chats tomorrow.',
    );
    assert.deepEqual(surface.quota, {
      used: 10,
      limit: 10,
      remaining: 0,
      resetAt: '2026-09-06T00:00:00.000Z',
    });
    // The point of the whole thing: refused, not stuck.
    assert.equal(surface.showsStop, false);
    assert.equal(surface.canSend, true);
  });

  it('marks a refused turn as never accepted, so the view can drop the bubble', async () => {
    const surface = makeSurface(async function* () {
      const refusal = new Error('Daily chat limit reached. You can send more chats tomorrow.');
      refusal.status = 429;
      refusal.code = 'DAILY_CHAT_LIMIT_REACHED';
      throw refusal;
    });

    await surface.submit('an eleventh question');

    assert.equal(surface.completions[0].accepted, false);
    assert.equal(surface.completions[0].status, 429);
    assert.equal(surface.completions[0].errorCode, 'DAILY_CHAT_LIMIT_REACHED');
  });

  it('marks a turn the server took as accepted', async () => {
    const surface = makeSurface(
      scripted([META, frame('token', { text: 'hi' }), frame('done', { finishReason: 'stop' })]),
    );

    await surface.submit('what is a GRU?');

    assert.equal(surface.completions[0].accepted, true);
  });

  it('shows nothing rather than a guess when the server sends no figures', async () => {
    const surface = makeSurface(
      scripted([META, frame('token', { text: 'hi' }), frame('done', { finishReason: 'stop' })]),
    );

    await surface.submit('what is a GRU?');

    assert.equal(surface.quota, null);
  });

  it('ignores a quota frame it cannot render honestly', async () => {
    const surface = makeSurface(
      scripted([
        frame('quota', { used: 7 }),
        META,
        frame('token', { text: 'hi' }),
        frame('done', { finishReason: 'stop' }),
      ]),
    );

    await surface.submit('what is a GRU?');

    assert.equal(surface.quota, null, 'a half-known allowance is not displayed');
    await assertReadyAndReusable(surface);
  });
});

describe('reset', () => {
  it('returns the surface to idle', async () => {
    const surface = makeSurface(
      scripted([META, frame('token', { text: 'hi' }), frame('done', { finishReason: 'stop' })]),
    );

    await surface.submit('what is a GRU?');
    surface.runner.reset();

    assert.deepEqual(surface.state, { ...IDLE_STREAM });
    assert.equal(surface.canSend, true);
  });
});
