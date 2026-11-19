/* Read what a server persisted, whichever store it ran on.
 *
 * STORE unset/json: DATA_DIR/db.json and DATA_DIR/state-<uid>.json, as the tests always did.
 * STORE=postgres: the rows under the schema PG_SCHEMA_FROM_DATA_DIR gave that DATA_DIR (loadAll /
 * user_state), read in a short-lived connection. Call after the server replied or stopped: the
 * server answers only once its writes are committed.
 *
 *   await readDb(dataDir)        -> the db document (object)
 *   await readDbText(dataDir)    -> a string that is equal iff the stored db is equal (file text for json)
 *   await readDbSize(dataDir)    -> byte size of that text
 *   await readState(dataDir, uid)-> the user's profile document, or null
 */
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { loadAll, getUserState } from '../../store/pg-store.js';
import { schemaForDataDir } from '../../store/index.js';

export const isPostgres = () => (process.env.STORE || 'json').toLowerCase() === 'postgres';

async function withPg(dataDir, fn) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    if (/^(1|true)$/i.test(process.env.PG_SCHEMA_FROM_DATA_DIR || '')) await client.query(`SET search_path TO ${schemaForDataDir(dataDir)}`);
    return await fn(client);
  } finally { await client.end(); }
}

export async function readDb(dataDir) {
  if (!isPostgres()) return JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
  return withPg(dataDir, client => loadAll(client));
}

export async function readDbText(dataDir) {
  if (!isPostgres()) return fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8');
  return JSON.stringify(await readDb(dataDir));
}

export async function readDbSize(dataDir) {
  return Buffer.byteLength(await readDbText(dataDir));
}

export async function readState(dataDir, uid) {
  if (!isPostgres()) {
    try { return JSON.parse(fs.readFileSync(path.join(dataDir, `state-${uid}.json`), 'utf8')); } catch { return null; }
  }
  return withPg(dataDir, async client => (await getUserState(client, uid))?.doc ?? null);
}
