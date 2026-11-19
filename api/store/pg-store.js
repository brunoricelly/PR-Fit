// PostgreSQL persistence for the db.json document. Not wired into server.js yet.
//   loadAll(pool)             -> db object in the db.json shape
//   saveDiff(pool, diff)      -> applies a diffDb() result in ONE transaction under pg_advisory_xact_lock
//   saveAll(pool, db)         -> diffs db against what is stored (inside the same lock) and applies it
//   getUserState / putUserState -> per-user profile docs with optimistic UPDATE ... WHERE rev = $n
import { ARRAYS_META_KEY, canonicalize, diffDb } from './diff.js';
import { mergeDbCandidate } from '../db-coordinator.js';

// Serialises every db writer (distinct from the migration lock).
export const STORE_LOCK_KEY = 7243002;
const CHUNK = 500;

// diff collection name -> dedicated table and the columns promoted out of `data`.
const DEDICATED = {
  users: { table: 'users', cols: [] },
  creds: { table: 'creds', cols: [['user_id', 'userId']] },
  coachAthleteLinks: { table: 'coach_athlete_links', cols: [['coach_id', 'coachId'], ['athlete_id', 'athleteId']] },
  coachInvites: { table: 'coach_invites', cols: [['link_id', 'linkId'], ['coach_id', 'coachId'], ['token_hash', 'tokenHash']] },
};
// Parents first (FK order). Deletes run in reverse.
const ORDER = ['users', 'coachAthleteLinks', 'creds', 'coachInvites'];
const orderOf = c => { const i = ORDER.indexOf(c); return i < 0 ? ORDER.length : i; };

export class RevConflictError extends Error {
  constructor(uid) { super(`user_state ${uid}: revision conflict`); this.name = 'RevConflictError'; this.uid = uid; }
}

async function inTx(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [STORE_LOCK_KEY]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}

export async function loadAll(db) {
  const out = {};
  const arrays = new Set();
  const meta = (await db.query('SELECT k, v FROM meta')).rows;
  for (const { k, v } of meta) {
    if (k === ARRAYS_META_KEY) for (const n of v) arrays.add(n);
    else out[k] = v;
  }
  for (const [name, { table }] of Object.entries(DEDICATED)) {
    if (arrays.has(name)) out[name] = [];
    for (const r of (await db.query(`SELECT data FROM ${table} ORDER BY seq`)).rows) (out[name] ||= []).push(r.data);
  }
  for (const r of (await db.query('SELECT collection, data FROM collections ORDER BY collection, seq')).rows) {
    (out[r.collection] ||= []).push(r.data);
  }
  for (const name of arrays) out[name] ||= [];
  return out;
}

const chunks = (list, n = CHUNK) => { const o = []; for (let i = 0; i < list.length; i += n) o.push(list.slice(i, i + n)); return o; };

async function applyDiff(client, diff) {
  const groups = new Map();
  for (const u of diff.upserts || []) {
    if (!groups.has(u.collection)) groups.set(u.collection, []);
    groups.get(u.collection).push({ id: u.id, data: u.data });
  }
  const upsertNames = [...groups.keys()].sort((a, b) => orderOf(a) - orderOf(b));
  for (const name of upsertNames) {
    for (const part of chunks(groups.get(name))) {
      const ded = DEDICATED[name];
      if (ded) {
        const cols = ded.cols.map(c => c[0]);
        const sel = ded.cols.map(c => `e->'data'->>'${c[1]}'`);
        await client.query(
          `INSERT INTO ${ded.table}(id${cols.map(c => ', ' + c).join('')}, data)
           SELECT e->>'id'${sel.map(s => ', ' + s).join('')}, e->'data' FROM jsonb_array_elements($1::jsonb) e
           ON CONFLICT (id) DO UPDATE SET ${cols.map(c => `${c} = EXCLUDED.${c}`).join(', ')}${cols.length ? ', ' : ''}data = EXCLUDED.data, updated_at = now()`,
          [JSON.stringify(part)]);
      } else {
        await client.query(
          `INSERT INTO collections(collection, id, data)
           SELECT $1, e->>'id', e->'data' FROM jsonb_array_elements($2::jsonb) e
           ON CONFLICT (collection, id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
          [name, JSON.stringify(part)]);
      }
    }
  }
  const dels = new Map();
  for (const d of diff.deletes || []) {
    if (!dels.has(d.collection)) dels.set(d.collection, []);
    dels.get(d.collection).push(d.id);
  }
  for (const name of [...dels.keys()].sort((a, b) => orderOf(b) - orderOf(a))) {
    for (const part of chunks(dels.get(name))) {
      const ded = DEDICATED[name];
      if (ded) await client.query(`DELETE FROM ${ded.table} WHERE id = ANY($1::text[])`, [part]);
      else await client.query('DELETE FROM collections WHERE collection = $1 AND id = ANY($2::text[])', [name, part]);
    }
  }
  for (const m of diff.metaDeletes || []) await client.query('DELETE FROM meta WHERE k = $1', [m]);
  for (const m of diff.metaUpserts || []) {
    await client.query('INSERT INTO meta(k, v) VALUES ($1, $2::jsonb) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v', [m.k, JSON.stringify(m.v)]);
  }
}

export function saveDiff(pool, diff) {
  return inTx(pool, client => applyDiff(client, diff));
}

/** Replace the stored db with `db` (diff-based, so unchanged rows are not rewritten). Returns the diff applied. */
export function saveAll(pool, db, keyFns) {
  return inTx(pool, async client => {
    const diff = diffDb(await loadAll(client), db, keyFns);
    await applyDiff(client, diff);
    return diff;
  });
}

/**
 * The server's saveDb under the advisory lock: re-read the stored db inside the transaction (the
 * `latest` the JSON lock path reads), three-way merge `candidate` onto it using `base` (what the
 * caller started from), and apply only the row-level diff. Throws ConcurrentDbWriteError when
 * another process changed the same top-level key. Returns the merged document.
 */
export function saveMerged(pool, base, candidate, keyFns) {
  return inTx(pool, async client => {
    const latest = await loadAll(client);
    // PG returns rows in insertion order (seq), the in-memory arrays may have been re-sorted since
    // (compactB2B2C): the same rows in another order are not another writer's change.
    for (const key of Object.keys(latest)) {
      const l = latest[key], b = base[key];
      if (Array.isArray(l) && Array.isArray(b) && l.length === b.length
          && canonicalize(l.map(canonicalize).sort()) === canonicalize(b.map(canonicalize).sort())) latest[key] = structuredClone(b);
    }
    const merged = mergeDbCandidate(latest, base, candidate);
    await applyDiff(client, diffDb(latest, merged, keyFns));
    return merged;
  });
}

export async function getUserState(db, uid) {
  const r = await db.query('SELECT doc, rev, updated_at FROM user_state WHERE uid = $1', [uid]);
  return r.rows[0] ? { doc: r.rows[0].doc, rev: r.rows[0].rev, updatedAt: r.rows[0].updated_at } : null;
}

/** expectedRev null = create (fails if it exists); otherwise UPDATE ... WHERE rev = expectedRev. Returns the new rev. */
export async function putUserState(db, uid, doc, expectedRev) {
  const text = JSON.stringify(doc);
  if (expectedRev == null) {
    const r = await db.query('INSERT INTO user_state(uid, doc, rev) VALUES ($1, $2::jsonb, 1) ON CONFLICT (uid) DO NOTHING RETURNING rev', [uid, text]);
    if (!r.rowCount) throw new RevConflictError(uid);
    return r.rows[0].rev;
  }
  const r = await db.query('UPDATE user_state SET doc = $2::jsonb, rev = rev + 1, updated_at = now() WHERE uid = $1 AND rev = $3 RETURNING rev', [uid, text, expectedRev]);
  if (!r.rowCount) throw new RevConflictError(uid);
  return r.rows[0].rev;
}

/** Read-modify-write with retry on rev conflicts: fn(doc|null) -> next doc. */
export async function updateUserState(db, uid, fn, { retries = 5 } = {}) {
  for (let i = 0; ; i++) {
    const cur = await getUserState(db, uid);
    const next = await fn(cur ? cur.doc : null);
    try { return { doc: next, rev: await putUserState(db, uid, next, cur ? cur.rev : null) }; }
    catch (e) { if (!(e instanceof RevConflictError) || i >= retries) throw e; }
  }
}

/** Idempotent import (migration): writes only when absent or different; keeps rev otherwise. */
export async function importUserState(db, uid, doc) {
  const r = await db.query(
    `INSERT INTO user_state(uid, doc, rev) VALUES ($1, $2::jsonb, 1)
     ON CONFLICT (uid) DO UPDATE SET doc = EXCLUDED.doc, rev = user_state.rev + 1, updated_at = now()
       WHERE user_state.doc IS DISTINCT FROM EXCLUDED.doc
     RETURNING rev`, [uid, JSON.stringify(doc)]);
  return r.rowCount ? 'written' : 'unchanged';
}

export async function listUserStates(db) {
  return (await db.query('SELECT uid, doc, rev FROM user_state ORDER BY uid')).rows;
}

/** Row counts per collection (dedicated tables + collections + user_state), for reports. */
export async function countAll(db) {
  const out = {};
  for (const [name, { table }] of Object.entries(DEDICATED)) out[name] = +(await db.query(`SELECT count(*) FROM ${table}`)).rows[0].count;
  for (const r of (await db.query('SELECT collection, count(*) FROM collections GROUP BY collection ORDER BY collection')).rows) out[r.collection] = +r.count;
  out.user_state = +(await db.query('SELECT count(*) FROM user_state')).rows[0].count;
  return out;
}
