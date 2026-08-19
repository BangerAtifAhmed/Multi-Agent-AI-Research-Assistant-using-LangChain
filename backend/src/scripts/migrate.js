#!/usr/bin/env node
/**
 * Reproducible SQL migration runner.
 *
 *   npm run migrate         apply every pending migration
 *   npm run migrate:status  show what is applied and what is pending
 *
 * Each file in backend/migrations/ runs once, inside a transaction, in filename
 * order, and is recorded in schema_migrations. A fresh clone reaches the same
 * schema by running the same command.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import config, { BACKEND_DIR, assertRequiredConfig } from '../config/index.js';
import { pool, closeDatabase } from '../config/database.js';

const MIGRATIONS_DIR = path.join(BACKEND_DIR, 'migrations');

const ensureMigrationsTable = () =>
  pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        TEXT PRIMARY KEY,
      checksum    TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

async function loadMigrations() {
  const entries = await fs.readdir(MIGRATIONS_DIR);
  const files = entries.filter((name) => name.endsWith('.sql')).sort();

  return Promise.all(
    files.map(async (name) => {
      const sql = await fs.readFile(path.join(MIGRATIONS_DIR, name), 'utf8');
      return { name, sql, checksum: crypto.createHash('sha256').update(sql).digest('hex') };
    }),
  );
}

async function status() {
  await ensureMigrationsTable();
  const { rows } = await pool.query('SELECT name, checksum, applied_at FROM schema_migrations');
  const applied = new Map(rows.map((row) => [row.name, row]));
  const migrations = await loadMigrations();

  console.log(`database: ${new URL(config.database.url).host}\n`);
  for (const migration of migrations) {
    const record = applied.get(migration.name);
    if (!record) {
      console.log(`  pending  ${migration.name}`);
    } else if (record.checksum !== migration.checksum) {
      console.log(`  CHANGED  ${migration.name}  (already applied, file has been edited)`);
    } else {
      console.log(`  applied  ${migration.name}  ${record.applied_at.toISOString().slice(0, 19)}`);
    }
  }
}

// Arbitrary but fixed key; every deployment of this app uses the same one.
const MIGRATION_LOCK_KEY = 727274001;

/**
 * Runs `handler` while holding a PostgreSQL advisory lock.
 *
 * Containers run migrations on start, so several replicas can boot at once.
 * Without this, two of them could execute the same DDL concurrently - the
 * ALTER TABLE statements in 008/009 are not safe to run twice in parallel.
 * The lock is session-scoped, so it is released even if the process is killed.
 */
async function withMigrationLock(handler) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    return await handler();
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
    client.release();
  }
}

async function migrate() {
  await ensureMigrationsTable();
  const { rows } = await pool.query('SELECT name, checksum FROM schema_migrations');
  const applied = new Map(rows.map((row) => [row.name, row.checksum]));
  const migrations = await loadMigrations();

  let count = 0;
  for (const migration of migrations) {
    const existing = applied.get(migration.name);

    if (existing) {
      if (existing !== migration.checksum) {
        console.warn(
          `  ! ${migration.name} was already applied but its contents changed. ` +
            'Add a new migration instead of editing an applied one.',
        );
      }
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(migration.sql);
      await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
        migration.name,
        migration.checksum,
      ]);
      await client.query('COMMIT');
      console.log(`  applied  ${migration.name}`);
      count += 1;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`  FAILED   ${migration.name}: ${error.message}`);
      throw error;
    } finally {
      client.release();
    }
  }

  console.log(count ? `\n${count} migration(s) applied.` : '\nDatabase already up to date.');
}

try {
  assertRequiredConfig();
  if (process.argv.includes('--status')) await status();
  else await withMigrationLock(migrate);
  await closeDatabase();
  process.exit(0);
} catch (error) {
  console.error(`\nMigration failed: ${error.message}`);
  await closeDatabase();
  process.exit(1);
}
