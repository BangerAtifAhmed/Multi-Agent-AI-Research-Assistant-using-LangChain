/**
 * SSE transport tests.
 *
 *   npm test        (node --test, no extra tooling)
 *
 * `parseSse` is the only thing standing between the chat UI and a half-open
 * socket. The reader has no deadline of its own, so before the stall watchdog
 * existed a server that stopped talking - without closing the connection - left
 * the composer generating forever. These check that every stream ends: cleanly,
 * on abort, and on silence.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseSse, STREAM_STALL_MS } from './chatApi.js';

/** A Response-alike carrying `chunks`; `open` leaves the stream hanging after. */
function fakeResponse(chunks, { open = false } = {}) {
  const encoder = new TextEncoder();
  return {
    body: new ReadableStream({
      async start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        // A server that has gone quiet without hanging up: no more data, and no
        // close either. This is what a wedged backend looks like on the wire.
        if (!open) controller.close();
      },
      cancel() {},
    }),
  };
}

const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const collect = async (iterator) => {
  const frames = [];
  for await (const frame of iterator) frames.push(frame);
  return frames;
};

describe('parseSse', () => {
  it('yields each frame as it arrives', async () => {
    const response = fakeResponse([
      sse('meta', { assistantMessageId: 'a1' }),
      sse('token', { text: 'Gated ' }),
      sse('done', { finishReason: 'stop' }),
    ]);

    const frames = await collect(parseSse(response));

    assert.deepEqual(
      frames.map((frame) => frame.event),
      ['meta', 'token', 'done'],
    );
    assert.equal(frames[1].data.text, 'Gated ');
  });

  it('reassembles a frame split across chunks', async () => {
    const response = fakeResponse(['event: tok', 'en\ndata: {"text":"hi"}', '\n\n']);

    const frames = await collect(parseSse(response));

    assert.deepEqual(frames, [{ event: 'token', data: { text: 'hi' } }]);
  });

  it('skips heartbeat comments and unparsable frames', async () => {
    const response = fakeResponse([
      ': ping\n\n',
      'event: token\ndata: not json\n\n',
      sse('done', { finishReason: 'stop' }),
    ]);

    const frames = await collect(parseSse(response));

    assert.deepEqual(
      frames.map((frame) => frame.event),
      ['done'],
    );
  });

  it('ends when the stream goes silent', async () => {
    // The regression: an open connection with nothing coming down it. Without a
    // deadline this read never settles and the UI never leaves the generating
    // state.
    const response = fakeResponse([sse('token', { text: 'Gated ' })], { open: true });

    const frames = [];
    await assert.rejects(
      async () => {
        for await (const frame of parseSse(response, undefined, { stallMs: 60 })) {
          frames.push(frame);
        }
      },
      (error) => {
        assert.equal(error.code, 'STREAM_STALLED');
        assert.match(error.message, /stopped responding/);
        return true;
      },
    );

    // Whatever did arrive was still delivered before giving up.
    assert.equal(frames.length, 1);
  });

  it('does not give up on a stream that is merely slow', async () => {
    const encoder = new TextEncoder();
    const response = {
      body: new ReadableStream({
        async start(controller) {
          controller.enqueue(encoder.encode(sse('token', { text: 'a' })));
          // Three quiet gaps, each shorter than the deadline, kept alive by the
          // heartbeat the server sends every 15s in production.
          for (let i = 0; i < 3; i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 40));
            controller.enqueue(encoder.encode(': ping\n\n'));
          }
          controller.enqueue(encoder.encode(sse('done', { finishReason: 'stop' })));
          controller.close();
        },
        cancel() {},
      }),
    };

    const frames = await collect(parseSse(response, undefined, { stallMs: 100 }));

    assert.deepEqual(
      frames.map((frame) => frame.event),
      ['token', 'done'],
    );
  });

  it('ends when the caller aborts', async () => {
    const controller = new AbortController();
    const response = fakeResponse([sse('token', { text: 'Gated ' })], { open: true });

    const frames = [];
    for await (const frame of parseSse(response, controller.signal, { stallMs: 5000 })) {
      frames.push(frame);
      controller.abort();
    }

    assert.equal(frames.length, 1, 'the stream stops where Stop was pressed');
  });

  it('waits longer than the server heartbeat before calling a stream dead', () => {
    // The server writes ": ping" every 15s, so anything at or below that would
    // cut off healthy connections.
    assert.ok(STREAM_STALL_MS > 15_000, `${STREAM_STALL_MS}ms is not long enough`);
  });
});
