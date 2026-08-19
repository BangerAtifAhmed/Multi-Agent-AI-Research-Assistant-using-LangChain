/**
 * Minimal Server-Sent Events helpers.
 *
 * Every chunk is written and flushed immediately; nothing is buffered, so a
 * token produced by the LLM reaches the browser as soon as it reaches Express.
 */

const HEARTBEAT_MS = 15_000;

export function openStream(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Disable proxy buffering (nginx and friends) so streaming survives a proxy.
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  // Comment frame: keeps idle connections from being closed by intermediaries.
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n');
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  res.on('close', () => clearInterval(heartbeat));
  res.on('finish', () => clearInterval(heartbeat));

  return () => clearInterval(heartbeat);
}

export function sendEvent(res, event, data) {
  if (res.writableEnded) return false;
  // JSON is single-line encoded, so one event never spans multiple data frames.
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  return true;
}

export function closeStream(res) {
  if (!res.writableEnded) res.end();
}

export default { openStream, sendEvent, closeStream };
