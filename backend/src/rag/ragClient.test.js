/**
 * Generation-stream tests for the RAG client.
 *
 *   npm test        (node --test, no extra tooling)
 *
 * This read had no deadline: if the RAG service accepted the request and then
 * went quiet, Express waited on it forever, the browser's SSE stream never
 * closed, and the chat UI stayed stuck generating. The service now heartbeats
 * while it works, so silence means wedged rather than busy - and these check
 * that the distinction is actually made.
 *
 * A stub HTTP server stands in for the Python service; no Python is started.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';

process.env.DATABASE_URL ??= 'postgres://test/test';
process.env.SESSION_SECRET ??= 'test-secret-not-used-by-these-tests';
// Point the client at the stub below and stop it from spawning a real service.
process.env.RAG_SERVICE_AUTOSTART = 'false';

let server;
/** Set per test: writes the NDJSON body for /generate/stream. */
let respond = null;

const port = await new Promise((resolve) => {
  server = http.createServer(async (req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', model: 'stub' }));
      return;
    }
    if (req.url === '/generate/stream') {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      await respond(res);
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});

process.env.RAG_SERVICE_URL = `http://127.0.0.1:${port}`;

const { default: ragClient } = await import('./ragClient.js');

const line = (event) => `${JSON.stringify(event)}\n`;

async function collect(iterator) {
  const events = [];
  for await (const event of iterator) events.push(event);
  return events;
}

before(() => {});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe('streamGeneration', () => {
  it('yields every frame of a normal answer', async () => {
    respond = (res) => {
      res.write(line({ type: 'token', text: 'Gated ' }));
      res.write(line({ type: 'token', text: 'recurrent units.' }));
      res.write(line({ type: 'done', finishReason: 'stop' }));
      res.end();
    };

    const events = await collect(ragClient.streamGeneration({ query: 'q' }));

    assert.deepEqual(
      events.map((event) => event.type),
      ['token', 'token', 'done'],
    );
    assert.equal(
      events
        .filter((event) => event.type === 'token')
        .map((event) => event.text)
        .join(''),
      'Gated recurrent units.',
    );
  });

  it('forwards the error the service reports, then its done', async () => {
    respond = (res) => {
      res.write(
        line({
          type: 'error',
          code: 'LLM_RATE_LIMITED',
          message: 'The language model is rate limited right now.',
        }),
      );
      res.write(line({ type: 'done', finishReason: 'error' }));
      res.end();
    };

    const events = await collect(ragClient.streamGeneration({ query: 'q' }));

    assert.deepEqual(
      events.map((event) => event.type),
      ['error', 'done'],
    );
    assert.equal(events[0].code, 'LLM_RATE_LIMITED');
  });

  it('gives up on a service that has gone silent', async () => {
    // The regression: headers, one frame, and then nothing - ever. Without a
    // deadline this iteration never returns and the chat turn never ends.
    respond = () => new Promise(() => {});

    await assert.rejects(
      () => collect(ragClient.streamGeneration({ query: 'q' }, undefined, { idleTimeoutMs: 150 })),
      (error) => {
        assert.equal(error.code, 'RAG_STREAM_STALLED');
        assert.equal(error.status, 503);
        assert.match(error.message, /stopped responding/);
        return true;
      },
    );
  });

  it('keeps waiting while the service is heartbeating', async () => {
    // A rate-limited Mistral call failing over to Hugging Face can take minutes
    // before the first token. The heartbeat is what stops that being mistaken
    // for a wedge, so a slow answer must survive a short deadline.
    respond = async (res) => {
      for (let i = 0; i < 4; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 60));
        res.write(line({ type: 'heartbeat' }));
      }
      res.write(line({ type: 'token', text: 'answered by the fallback' }));
      res.write(line({ type: 'done', finishReason: 'stop' }));
      res.end();
    };

    const events = await collect(
      ragClient.streamGeneration({ query: 'q' }, undefined, { idleTimeoutMs: 200 }),
    );

    assert.deepEqual(
      events.map((event) => event.type),
      ['heartbeat', 'heartbeat', 'heartbeat', 'heartbeat', 'token', 'done'],
    );
  });

  it('stops quietly when the caller aborts', async () => {
    respond = async (res) => {
      res.write(line({ type: 'token', text: 'Gated ' }));
      await new Promise((resolve) => setTimeout(resolve, 2000));
      res.end();
    };

    const controller = new AbortController();
    const events = [];

    for await (const event of ragClient.streamGeneration({ query: 'q' }, controller.signal)) {
      events.push(event);
      controller.abort();
    }

    assert.deepEqual(
      events.map((event) => event.type),
      ['token'],
    );
  });
});
