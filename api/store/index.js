// Unified persistence boundary: { kind, lock, loadDb, saveDbUnlocked(merged, persisted), readState,
// readStateStrict, commitState, deleteState, listUserIds, stateVersion, flush, close }.
//
// json (default): the original synchronous file code, moved here unchanged.
// postgres: server.js uses a synchronous lock/loadDb/saveDbUnlocked everywhere, so the process loads
//   the whole db (and every user_state doc) from PG at boot (top-level await) and serves reads from
//   memory. Writes update the memory copy synchronously and are enqueued on a SerialWriteQueue; each
//   runs in ONE transaction under pg_advisory_xact_lock: re-read the stored db (`latest`), three-way
//   merge the caller's change (persisted -> candidate) onto it, apply only the row diff. Durability:
//   server.js defers the response of every mutating request until `await store.flush()` resolves, so
//   nothing answers 2xx before the PG commit; a failed write re-reads PG into memory (resync) and the
//   request answers 500. Reads of another process's writes are only as fresh as the last own write.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { atomicWrite, syncDir } from '../durable.js';
import { SerialWriteQueue } from '../serial-write-queue.js';
import { createInterprocessLock } from '../db-coordinator.js';
import { migrate } from './migrate.js';
import { B2B2CDataError, migrateB2B2C } from '../b2b2c.js';
import { loadAll, saveAll, importUserState, listUserStates, getUserState, putUserState, saveMerged } from './pg-store.js';

export const STORE_KIND = process.env.STORE || 'json';
if (!['json', 'postgres'].includes(STORE_KIND)) throw new Error('STORE must be json or postgres');

const clone = value => structuredClone(value);
const jsonClone = value => JSON.parse(JSON.stringify(value));

function jsonStore({ dataDir, lockOptions }) {
  const dbFile = path.join(dataDir, 'db.json');
  const lock = createInterprocessLock({ lockPath: dbFile + '.lock', ...lockOptions });
  const txn = dbFile + '.txn';
  const old = dbFile + '.txn.old';
  const next = dbFile + '.txn.new';
  const stateFile = uid => path.join(dataDir, 'state-' + uid.replace(/[^a-zA-Z0-9_-]/g, '') + '.json');
  const cleanup = ({ strict = false } = {}) => {
    for (const file of [txn, old, next, dbFile + '.next', dbFile + '.bak.next']) {
      try { fs.unlinkSync(file); } catch (error) {
        if (error.code === 'ENOENT') continue;
        if (strict) throw error;
        console.error('db transaction cleanup failed', path.basename(file), error.message);
      }
    }
    syncDir(dataDir);
  };
  const reconcile = () => {
    if (!fs.existsSync(txn)) return;
    const transaction = JSON.parse(fs.readFileSync(txn, 'utf8'));
    if (!transaction || !['prepared', 'committed'].includes(transaction.phase)) throw new Error('invalid db transaction journal');
    const source = transaction.phase === 'committed' ? next : old;
    const snapshot = JSON.parse(fs.readFileSync(source, 'utf8'));
    if (!snapshot || typeof snapshot.exists !== 'boolean' || typeof snapshot.text !== 'string') throw new Error('invalid db transaction snapshot');
    if (snapshot.exists) {
      atomicWrite(dbFile, snapshot.text, 0o600);
      atomicWrite(dbFile + '.bak', snapshot.text, 0o600);
    } else {
      for (const file of [dbFile, dbFile + '.bak']) try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      syncDir(dataDir);
    }
    cleanup({ strict: true });
  };
  const loadDb = () => {
    reconcile();
    let raw;
    try { raw = fs.readFileSync(dbFile, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return { users: [], creds: [], subs: [], invites: [] }; throw error; }
    const parse = text => { const value = JSON.parse(text); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object'); return value; };
    try { return parse(raw); } catch (error) {
      const aside = `${dbFile}.unreadable-${Date.now()}`;
      try { fs.copyFileSync(dbFile, aside); } catch { /* original remains */ }
      console.error(`db.json cannot be read (${error.message}); kept a copy as ${path.basename(aside)}`);
      try {
        const backup = parse(fs.readFileSync(dbFile + '.bak', 'utf8'));
        console.error('db.json: using db.json.bak, the copy of the last save');
        return backup;
      } catch {
        console.error('db.json: no readable db.json.bak either. Refusing to start: restore db.json from a backup.');
        process.exit(1);
      }
    }
  };
  const saveDbUnlocked = candidate => {
    const failMarker = process.env.B2B2C_DB_FAIL_FILE;
    if (failMarker && fs.existsSync(failMarker)) { fs.unlinkSync(failMarker); throw new Error('injected db write failure'); }
    const text = JSON.stringify(candidate, null, 2);
    const previous = fs.existsSync(dbFile) ? fs.readFileSync(dbFile, 'utf8') : '';
    atomicWrite(old, JSON.stringify({ exists: fs.existsSync(dbFile), text: previous }), 0o600);
    atomicWrite(next, JSON.stringify({ exists: true, text }), 0o600);
    atomicWrite(txn, JSON.stringify({ phase: 'prepared' }), 0o600);
    atomicWrite(dbFile + '.next', text, 0o600);
    const backupFailMarker = process.env.B2B2C_DB_BACKUP_FAIL_FILE;
    if (backupFailMarker && fs.existsSync(backupFailMarker)) { fs.unlinkSync(backupFailMarker); throw new Error('injected db backup write failure'); }
    atomicWrite(dbFile + '.bak.next', text, 0o600);
    fs.renameSync(dbFile + '.bak.next', dbFile + '.bak'); syncDir(dataDir);
    fs.renameSync(dbFile + '.next', dbFile); syncDir(dataDir);
    atomicWrite(txn, JSON.stringify({ phase: 'committed' }), 0o600);
    cleanup();
  };
  return {
    kind: 'json', lock, loadDb, saveDbUnlocked,
    readState(uid) { try { return JSON.parse(fs.readFileSync(stateFile(uid), 'utf8')); } catch { return null; } },
    readStateStrict(uid, unreadable) {
      let raw; try { raw = fs.readFileSync(stateFile(uid), 'utf8'); } catch (error) { return error.code === 'ENOENT' ? null : unreadable; }
      try { return JSON.parse(raw); } catch { return unreadable; }
    },
    commitState(uid, previous, doc, text) { atomicWrite(stateFile(uid), text); },
    deleteState(uid) { try { fs.unlinkSync(stateFile(uid)); } catch (error) { if (error.code !== 'ENOENT') throw error; } },
    listUserIds() { try { return fs.readdirSync(dataDir).filter(f => /^state-[a-zA-Z0-9_-]+\.json$/.test(f)).map(f => f.slice(6, -5)); } catch { return []; } },
    peekState(uid) { return this.readState(uid); },
    stateVersion(uid) { try { const st = fs.statSync(stateFile(uid)); return `${st.mtimeMs}:${st.size}`; } catch { return null; } },
    hasPending: () => false, afterCommit: fn => fn(), 
    flush: async () => {}, close: async () => {},
  };
}

// The JSON store refuses to boot on a db.json whose B2B2C data is invalid; the import into PG must
// behave the same instead of dying in the middle of the upserts. Validates the same way server.js
// does at boot (migrateB2B2C), then checks the foreign keys PG enforces (a coach_athlete_links row
// whose coach is not in users, an invite whose link is missing...) which a db.json may carry
// without complaint. Returns the document as read (unmigrated); throws B2B2CDataError otherwise.
function validateLegacyForImport(file) {
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { throw new B2B2CDataError(`db.json is not valid JSON: ${error.message}`); }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new B2B2CDataError('db.json must be an object');
  for (const key of ['users', 'creds', 'subs', 'invites', 'deviceLinks']) {
    if (doc[key] === undefined) doc[key] = [];
    else if (!Array.isArray(doc[key])) throw new B2B2CDataError(`${key} must be an array`);
  }
  const raw = structuredClone(doc); // imported as found: the boot migration then runs (and persists) like it does on JSON
  migrateB2B2C(doc);
  const ids = list => new Set(list.map(r => r?.id));
  const users = ids(doc.users), links = ids(doc.coachAthleteLinks);
  const need = (what, ok) => { if (!ok) throw new B2B2CDataError(`${what} (orphan reference: PostgreSQL enforces foreign keys; fix or remove it in db.json)`); };
  for (const c of doc.creds) need(`cred ${c?.id} points to unknown user ${c?.userId}`, users.has(c?.userId));
  for (const l of doc.coachAthleteLinks) {
    need(`coach link ${l?.id} has unknown coach ${l?.coachId}`, users.has(l?.coachId));
    need(`coach link ${l?.id} has unknown athlete ${l?.athleteId}`, l?.athleteId == null || users.has(l.athleteId));
  }
  for (const i of doc.coachInvites) {
    need(`coach invite ${i?.id} points to unknown link ${i?.linkId}`, links.has(i?.linkId));
    need(`coach invite ${i?.id} has unknown coach ${i?.coachId}`, users.has(i?.coachId));
  }
  return raw;
}

// Optional, off by default (both are test/bootstrap aids):
//   PG_SCHEMA_FROM_DATA_DIR=1  one schema per DATA_DIR, so parallel test servers do not share rows.
//   STORE_IMPORT_JSON=1        a freshly migrated, empty database is seeded from DATA_DIR/db.json and
//                              state-<uid>.json (same as scripts/migrate-json-to-pg.js).
export const schemaForDataDir = dataDir => 's_' + crypto.createHash('sha1').update(path.resolve(dataDir)).digest('hex').slice(0, 16);

async function postgresStore({ databaseUrl, poolMax, dataDir }) {
  if (!databaseUrl) throw new Error('DATABASE_URL is required when STORE=postgres');
  const poolOptions = { connectionString: databaseUrl, max: poolMax };
  if (/^(1|true)$/i.test(process.env.PG_SCHEMA_FROM_DATA_DIR || '')) {
    const schema = schemaForDataDir(dataDir);
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    try { await admin.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`); } finally { await admin.end(); }
    poolOptions.options = `-c search_path=${schema}`;
  }
  const pool = new pg.Pool(poolOptions);
  const applied = await migrate(pool, { log: name => console.log(`postgres migration: ${name}`) });
  if (applied.length && /^(1|true)$/i.test(process.env.STORE_IMPORT_JSON || '') && fs.existsSync(path.join(dataDir, 'db.json'))) {
    let legacy;
    try { legacy = validateLegacyForImport(path.join(dataDir, 'db.json')); } catch (error) {
      if (!(error instanceof B2B2CDataError)) throw error;
      console.error(`db.json B2B2C data is invalid (${error.message}). Refusing to start; db.json and db.json.bak were not changed.`);
      await pool.end().catch(() => {});
      process.exit(1);
    }
    await saveAll(pool, legacy);
    for (const name of fs.readdirSync(dataDir).filter(f => /^state-[a-zA-Z0-9_-]+\.json$/.test(f))) {
      await importUserState(pool, name.slice(6, -5), JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8')));
    }
    console.log('postgres: imported db.json and state files into an empty database');
  }
  // A database nobody has written to yet loads as {}: give it the shape the json store starts from.
  const loadStored = async () => { const doc = await loadAll(pool); for (const k of ['users', 'creds', 'subs', 'invites']) doc[k] ??= []; return doc; };
  let cache = await loadStored();
  let committed = clone(cache); // the last state this process knows PG to hold
  const safe = uid => String(uid).replace(/[^a-zA-Z0-9_-]/g, '');
  const states = new Map((await listUserStates(pool)).map(row => [row.uid, { doc: row.doc, rev: row.rev, version: 1 }]));
  const writes = new SerialWriteQueue();
  let last = Promise.resolve();
  let generation = 0;
  let failures = 0;
  let onResync = null;
  // Every persistence task goes through here: serial, and a failed one re-reads what PG really has
  // (the in-memory copy is optimistic) before the next one runs. `last` is what flush() awaits.
  const enqueue = (task, recover) => {
    const result = writes.run(async () => {
      try { return await task(); }
      catch (error) {
        failures++;
        console.error('postgres write failed:', error.message);
        try { await recover?.(); } catch (e) { console.error('postgres resync failed:', e.message); }
        throw error;
      }
    });
    last = result;
    result.catch(() => {});
    return result;
  };
  const resyncDb = async () => {
    generation++;
    cache = await loadStored();
    committed = clone(cache);
    onResync?.(clone(cache));
  };
  // In-process mutual exclusion for the async critical sections that held the file lock (sync ones
  // cannot interleave on one thread). Cross-process exclusion is pg_advisory_xact_lock in saveMerged.
  // The section only resolves once its writes are committed (or rejects when they failed).
  let mutex = Promise.resolve();
  const lock = {
    withLockSync: task => task(),
    withLock(task) {
      const run = mutex.then(async () => { const result = await task(); await last; return result; });
      mutex = run.catch(() => {});
      return run;
    },
    async inspect() { return { active: writes.pending > 0, expired: false, store: 'postgres' }; },
  };
  return {
    kind: 'postgres', lock,
    setResyncHandler(fn) { onResync = fn; },
    loadDb: () => clone(cache),
    saveDbUnlocked(candidate) {
      const failMarker = process.env.B2B2C_DB_FAIL_FILE;
      if (failMarker && fs.existsSync(failMarker)) { fs.unlinkSync(failMarker); throw new Error('injected db write failure'); }
      const mine = ++generation;
      const snapshot = jsonClone(candidate); // what a JSON round trip (and jsonb) would keep
      cache = clone(snapshot);
      enqueue(async () => {
        // base = what this process last knew PG to hold; earlier queued writes have committed by now.
        const merged = jsonClone(await saveMerged(pool, committed, snapshot));
        committed = merged;
        if (generation === mine) cache = clone(merged);
        return merged;
      }, resyncDb);
    },
    // peekState hands out the cached document itself: callers must not mutate it.
    peekState(uid) { return states.get(safe(uid))?.doc ?? null; },
    readState(uid) { const row = states.get(safe(uid)); return row ? clone(row.doc) : null; },
    readStateStrict(uid) { const row = states.get(safe(uid)); return row ? clone(row.doc) : null; },
    commitState(rawUid, previous, doc) {
      const uid = safe(rawUid);
      const current = states.get(uid);
      const expected = current?.rev ?? null;
      states.set(uid, { doc: clone(doc), rev: (expected ?? 0) + 1, version: (current?.version ?? 0) + 1 });
      const snapshot = clone(doc);
      enqueue(() => putUserState(pool, uid, snapshot, expected), async () => {
        const row = await getUserState(pool, uid);
        if (row) states.set(uid, { doc: row.doc, rev: row.rev, version: (states.get(uid)?.version ?? 0) + 1 });
        else states.delete(uid);
      });
    },
    deleteState(rawUid) {
      const uid = safe(rawUid);
      states.delete(uid);
      enqueue(() => pool.query('DELETE FROM user_state WHERE uid = $1', [uid]));
    },
    listUserIds: () => [...states.keys()],
    stateVersion(uid) { const row = states.get(safe(uid)); return row ? String(row.version) : null; },
    hasPending: () => writes.pending > 0,
    // Runs fn once everything enqueued before it is committed; skipped if any of it failed.
    afterCommit(fn) {
      const before = failures;
      enqueue(async () => { if (failures === before) fn(); });
    },
    // Resolves once every write enqueued so far is committed; rejects if the latest one failed.
    flush: () => last,
    async close() { await last.catch(() => {}); await pool.end(); },
  };
}

let active = null;
/** The store server.js created, for modules (coach/jobs.js) that read profile documents. */
export const activeStore = () => active;

export async function createStore({ dataDir, lockOptions = {} } = {}) {
  active = await buildStore({ dataDir, lockOptions });
  return active;
}

async function buildStore({ dataDir, lockOptions }) {
  if (STORE_KIND === 'postgres') return postgresStore({
    dataDir,
    databaseUrl: process.env.DATABASE_URL,
    poolMax: Math.max(1, Math.min(100, Number(process.env.PG_POOL_MAX) || 10)),
  });
  return jsonStore({ dataDir, lockOptions });
}
