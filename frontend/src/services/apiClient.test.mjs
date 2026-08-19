/**
 * API base URL normalisation.
 *
 *   node src/services/apiClient.test.mjs
 *
 * Guards the bug where VITE_API_URL was set to the bare origin, so every
 * request lost the server's /api prefix and Google login 404'd with
 * ROUTE_NOT_FOUND.
 */

// Mirrors normaliseApiBaseUrl in apiClient.js. Kept inline so the test does not
// need a bundler to resolve import.meta.env.
function normaliseApiBaseUrl(value) {
  const raw = String(value ?? '').trim().replace(/\/+$/, '');
  if (!raw) return '/api';
  if (/\/api$/i.test(raw)) return raw;
  return `${raw}/api`;
}

const googleLoginUrl = (base, redirectTo = '/') =>
  `${base}/auth/google?redirectTo=${encodeURIComponent(redirectTo)}`;

let passed = 0;
let failed = 0;
const check = (name, actual, expected) => {
  const ok = actual === expected;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) {
    console.log(`        expected: ${expected}`);
    console.log(`        actual:   ${actual}`);
    failed += 1;
  } else {
    passed += 1;
  }
};

const RENDER = 'https://multi-agent-ai-research-assistant-using.onrender.com';

console.log('=== base URL normalisation ===');
check('bare origin gains /api', normaliseApiBaseUrl(RENDER), `${RENDER}/api`);
check('origin with trailing slash', normaliseApiBaseUrl(`${RENDER}/`), `${RENDER}/api`);
check('origin already ending in /api', normaliseApiBaseUrl(`${RENDER}/api`), `${RENDER}/api`);
check('origin with /api and a slash', normaliseApiBaseUrl(`${RENDER}/api/`), `${RENDER}/api`);
check(
  'local development value is unchanged',
  normaliseApiBaseUrl('http://localhost:3000/api'),
  'http://localhost:3000/api',
);
check('local origin gains /api', normaliseApiBaseUrl('http://localhost:3000'), 'http://localhost:3000/api');
check('same-origin relative path', normaliseApiBaseUrl('/api'), '/api');
check('empty falls back to /api', normaliseApiBaseUrl(''), '/api');
check('undefined falls back to /api', normaliseApiBaseUrl(undefined), '/api');
check('surrounding whitespace trimmed', normaliseApiBaseUrl(`  ${RENDER}  `), `${RENDER}/api`);

console.log('\n=== resulting Google login URL (the reported bug) ===');
check(
  'production: bare origin',
  googleLoginUrl(normaliseApiBaseUrl(RENDER)),
  `${RENDER}/api/auth/google?redirectTo=%2F`,
);
check(
  'production: origin already with /api',
  googleLoginUrl(normaliseApiBaseUrl(`${RENDER}/api`)),
  `${RENDER}/api/auth/google?redirectTo=%2F`,
);
check(
  'local development',
  googleLoginUrl(normaliseApiBaseUrl('http://localhost:3000/api')),
  'http://localhost:3000/api/auth/google?redirectTo=%2F',
);
check(
  'redirectTo is encoded',
  googleLoginUrl(normaliseApiBaseUrl(RENDER), '/library'),
  `${RENDER}/api/auth/google?redirectTo=%2Flibrary`,
);

console.log('\n=== ordinary API calls keep the prefix ===');
for (const path of ['/auth/me', '/conversations', '/documents', '/chat', '/health']) {
  check(`${path}`, `${normaliseApiBaseUrl(RENDER)}${path}`, `${RENDER}/api${path}`);
}

// The regression itself: the old code returned the value untouched.
console.log('\n=== regression ===');
const oldBehaviour = RENDER.replace(/\/+$/, '');
check('old code produced the failing URL', `${oldBehaviour}/auth/google`, `${RENDER}/auth/google`);
check(
  'new code no longer produces it',
  googleLoginUrl(normaliseApiBaseUrl(RENDER)).includes('/api/auth/google'),
  true,
);

console.log(`\n${failed === 0 ? 'ALL PASSED' : `${failed} FAILED`} (${passed} passed)`);
process.exit(failed ? 1 : 0);
