// Idempotent SQL migration runner: api/migrations/NNN_name.sql, applied in order, each inside its
// own transaction, serialised across processes by a session advisory lock and tracked in
// schema_migrations (version, name, checksum, applied_at).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
// Arbitrary constant, distinct from the store's transaction lock (see pg-store.js).
export const MIGRATE_LOCK_KEY = 7243001;

export function listMigrations(dir = MIGRATIONS_DIR) {
  return fs.readdirSync(dir).filter(f => /^\d+_.+\.sql$/.test(f)).sort().map(file => {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    return { version: parseInt(file, 10), name: file.replace(/\.sql$/, ''), sql, checksum: crypto.createHash('sha256').update(sql).digest('hex') };
  });
}

export async function migrate(pool, { dir = MIGRATIONS_DIR, log = () => {} } = {}) {
  const client = await pool.connect();
  const applied = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATE_LOCK_KEY]);
    try {
      await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
        version integer PRIMARY KEY, name text NOT NULL, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
      const done = new Map((await client.query('SELECT version, checksum FROM schema_migrations')).rows.map(r => [r.version, r.checksum]));
      for (const m of listMigrations(dir)) {
        if (done.has(m.version)) {
          if (done.get(m.version) !== m.checksum) throw new Error(`migration ${m.name} was modified after being applied`);
          continue;
        }
        await client.query('BEGIN');
        try {
          await client.query(m.sql);
          await client.query('INSERT INTO schema_migrations(version, name, checksum) VALUES ($1,$2,$3)', [m.version, m.name, m.checksum]);
          await client.query('COMMIT');
        } catch (e) { await client.query('ROLLBACK'); throw e; }
        applied.push(m.name);
        log(`applied ${m.name}`);
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATE_LOCK_KEY]).catch(() => {});
    }
  } finally { client.release(); }
  return applied;
}
