import pg from 'pg';

import config from './index.js';
import logger from '../utils/logger.js';

/**
 * PostgreSQL (Neon) connection pool.
 *
 * One pool for the whole process - never a connection per request. Every query
 * in the app goes through here with parameter binding, so user input is never
 * concatenated into SQL.
 */

const { Pool, types } = pg;

// Return BIGINT (file_size) as a JS number rather than a string.
types.setTypeParser(types.builtins.INT8, (value) => Number.parseInt(value, 10));

const needsSsl = !/[?&]sslmode=disable/.test(config.database.url);

export const pool = new Pool({
  connectionString: config.database.url,
  max: config.database.poolMax,
  idleTimeoutMillis: config.database.idleTimeoutMs,
  connectionTimeoutMillis: config.database.connectionTimeoutMs,
  // Neon terminates TLS at its proxy with a certificate chain Node does not
  // ship; the connection is still encrypted.
  ssl: needsSsl ? { rejectUnauthorized: false } : false,
});

pool.on('error', (error) => {
  logger.error('postgres pool error:', error.message);
});

/** Runs a parameterised query. */
export function query(text, params) {
  return pool.query(text, params);
}

/** Runs a set of queries in a single transaction, rolling back on failure. */
export async function withTransaction(handler) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await handler(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function checkDatabase() {
  const started = Date.now();
  await pool.query('SELECT 1');
  return { connected: true, latencyMs: Date.now() - started };
}

export async function closeDatabase() {
  await pool.end().catch(() => {});
}

export default { pool, query, withTransaction, checkDatabase, closeDatabase };
