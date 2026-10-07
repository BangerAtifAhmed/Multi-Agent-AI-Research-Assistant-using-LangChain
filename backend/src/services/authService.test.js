/**
 * Session-cookie tests.
 *
 *   npm test        (node --test, no extra tooling)
 *
 * On the deployed site sign-in answered 200 and the very next request was 401.
 * The frontend and the API were on different sites, and the cookie went out
 * with development attributes (SameSite=Lax, not Secure) - which a browser
 * silently drops when it arrives from another site. Nothing failed on the
 * server, so nothing was logged. These pin the attributes to the deployment
 * rather than to NODE_ENV.
 *
 * Nothing here touches PostgreSQL, Redis or the RAG service.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, afterEach, before, describe, it } from 'node:test';

import express from 'express';

// Enough to import the module graph without a database or a session secret.
process.env.DATABASE_URL ??= 'postgres://test/test';
process.env.SESSION_SECRET ??= 'test-secret-not-used-by-these-tests';

const { default: config, needsCrossSiteCookie } = await import('../config/index.js');
const { setSessionCookie, clearSessionCookie } = await import('./authService.js');

const realAuth = { ...config.auth };
const name = config.auth.cookieName;

const CROSS_SITE = { cookieSameSite: 'none', cookieSecure: true, cookiePartitioned: true };
const LOCAL = { cookieSameSite: 'lax', cookieSecure: false, cookiePartitioned: false };

let server;
let baseUrl;

before(async () => {
  const app = express();
  app.get('/set', (req, res) => {
    setSessionCookie(res, 'session-token', new Date(Date.now() + 86_400_000));
    res.end();
  });
  app.get('/clear', (req, res) => {
    clearSessionCookie(res);
    res.end();
  });

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

afterEach(() => {
  Object.assign(config.auth, realAuth);
});

/** The Set-Cookie headers of one response, each split into its attributes. */
async function cookiesFrom(path) {
  const response = await fetch(`${baseUrl}${path}`);
  return response.headers.getSetCookie().map((header) => {
    const [pair, ...attributes] = header.split(';').map((part) => part.trim());
    return { value: pair.slice(pair.indexOf('=') + 1), attributes, header };
  });
}

const isExpired = (cookie) =>
  cookie.attributes.some((attribute) => attribute.startsWith('Expires=Thu, 01 Jan 1970'));

describe('needsCrossSiteCookie', () => {
  it('treats an HTTPS frontend as a deployment even when NODE_ENV is development', () => {
    assert.equal(
      needsCrossSiteCookie({ production: false, frontend: 'https://app.onrender.com' }),
      true,
    );
  });

  it('keeps local development on a plain cookie', () => {
    assert.equal(
      needsCrossSiteCookie({ production: false, frontend: 'http://localhost:5173' }),
      false,
    );
  });

  it('always applies in production', () => {
    assert.equal(
      needsCrossSiteCookie({ production: true, frontend: 'http://localhost:5173' }),
      true,
    );
  });
});

describe('session cookie', () => {
  it('is one a browser will keep when it is set from another site', async () => {
    Object.assign(config.auth, CROSS_SITE);

    const cookies = await cookiesFrom('/set');
    const session = cookies.at(-1);

    assert.equal(session.value, 'session-token');
    for (const attribute of ['HttpOnly', 'Secure', 'SameSite=None', 'Partitioned', 'Path=/']) {
      assert.ok(session.attributes.includes(attribute), `${attribute} missing: ${session.header}`);
    }
  });

  it('expires the unpartitioned cookie an earlier release left behind', async () => {
    Object.assign(config.auth, CROSS_SITE);

    const cookies = await cookiesFrom('/set');

    // Two different cookies to a browser. Left alone, the old one is sent
    // first and is the one the server reads.
    assert.equal(cookies.length, 2);
    const [legacy] = cookies;
    assert.equal(legacy.value, '');
    assert.ok(isExpired(legacy), legacy.header);
    assert.ok(!legacy.attributes.includes('Partitioned'), legacy.header);
    // Without these a browser ignores the expiry on a cross-site response.
    assert.ok(legacy.attributes.includes('Secure'), legacy.header);
    assert.ok(legacy.attributes.includes('SameSite=None'), legacy.header);
  });

  it('is cleared with the attributes it was set with', async () => {
    Object.assign(config.auth, CROSS_SITE);

    const cookies = await cookiesFrom('/clear');

    assert.equal(cookies.length, 2);
    assert.deepEqual(
      cookies.map((cookie) => cookie.attributes.includes('Partitioned')).sort(),
      [false, true],
    );
    for (const cookie of cookies) {
      assert.equal(cookie.value, '');
      assert.ok(isExpired(cookie), cookie.header);
      assert.ok(cookie.attributes.includes('Secure'), cookie.header);
      assert.ok(cookie.attributes.includes('SameSite=None'), cookie.header);
    }
  });

  it('stays a single Lax cookie in local development', async () => {
    Object.assign(config.auth, LOCAL);

    const cookies = await cookiesFrom('/set');

    assert.equal(cookies.length, 1);
    const [session] = cookies;
    assert.equal(session.value, 'session-token');
    assert.ok(session.attributes.includes('SameSite=Lax'), session.header);
    assert.ok(!session.attributes.includes('Secure'), session.header);
    assert.ok(!session.attributes.includes('Partitioned'), session.header);
  });

  it('is never Partitioned unless it is also Secure and SameSite=None', async () => {
    // A browser rejects a Partitioned cookie that is not both, outright.
    Object.assign(config.auth, { ...LOCAL, cookiePartitioned: true });

    const cookies = await cookiesFrom('/set');

    assert.equal(cookies.length, 1);
    assert.ok(!cookies[0].attributes.includes('Partitioned'), cookies[0].header);
  });
});
