// Pure db.json <-> row diffing. No I/O.
import { isDeepStrictEqual } from 'node:util';

export const ARRAYS_META_KEY = '$arrays';
export const DEDICATED = ['users', 'creds', 'coachAthleteLinks', 'coachInvites'];

const byId = row => row.id;
// Composite keys are JSON arrays so no separator can collide with an id.
const composite = row => (typeof row.athleteId === 'string' && typeof row.id === 'string' ? JSON.stringify([row.athleteId, row.id]) : undefined);
export const DEFAULT_KEY_FNS = {
  deviceLinks: row => row.h,
  watchLinks: row => row.h,
  invites: row => row.code,
  subs: row => row.endpoint,
  coachAvailability: row => row.coachId,
  schedulingReminderPreferences: row => row.userId,
  mealPlans: composite,
  mealAdherence: composite,
  mealPlanTombstones: composite,
};

// Key-order-insensitive, undefined-dropping JSON (matches what jsonb round-trips).
export function canonicalize(value) {
  if (Array.isArray(value)) return '[' + value.map(v => canonicalize(v === undefined ? null : v)).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().filter(k => value[k] !== undefined)
      .map(k => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
  }
  return JSON.stringify(value === undefined ? null : value);
}

export function rowKey(collection, row, keyFns = DEFAULT_KEY_FNS) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new TypeError(`${collection}: rows must be objects`);
  const key = (keyFns[collection] || byId)(row);
  if (typeof key !== 'string' || key === '' || key.includes('\u0000')) {
    throw new TypeError(`${collection}: row has no usable key (${key})`);
  }
  return key;
}

function indexRows(collection, rows, keyFns) {
  const map = new Map();
  for (const row of rows) {
    const key = rowKey(collection, row, keyFns);
    if (map.has(key)) throw new Error(`${collection}: duplicate key ${key}`);
    map.set(key, row);
  }
  return map;
}

/**
 * diffDb(persisted, candidate, keyFns) -> { upserts, deletes, metaUpserts, metaDeletes }
 * upserts: [{collection,id,data}] (new or changed rows, in candidate order); deletes: [{collection,id}].
 * Array top-level keys are collections; every other key goes to meta. The set of array keys is
 * tracked in meta '$arrays' so an empty array survives a round trip.
 */
export function diffDb(persisted, candidate, keyFns = {}) {
  const fns = { ...DEFAULT_KEY_FNS, ...keyFns };
  const p = persisted || {}, c = candidate || {};
  const upserts = [], deletes = [], metaUpserts = [], metaDeletes = [];
  const keys = new Set([...Object.keys(p), ...Object.keys(c)]);
  for (const key of keys) {
    const pv = p[key], cv = c[key];
    const pArr = Array.isArray(pv), cArr = Array.isArray(cv);
    if (pArr || cArr) {
      const before = pArr ? indexRows(key, pv, fns) : new Map();
      const after = cArr ? indexRows(key, cv, fns) : new Map();
      for (const [id, row] of after) {
        const old = before.get(id);
        if (old === undefined || (old !== row && canonicalize(old) !== canonicalize(row))) upserts.push({ collection: key, id, data: row });
      }
      for (const id of before.keys()) if (!after.has(id)) deletes.push({ collection: key, id });
      // a key that switched between array and scalar: drop the stale meta entry
      if (!cArr && cv !== undefined) metaUpserts.push({ k: key, v: cv });
      else if (!cArr && pv !== undefined && cv === undefined) { /* array removed entirely: rows deleted above */ }
      if (cArr && !pArr && pv !== undefined) metaDeletes.push(key);
    } else {
      if (cv === undefined) { if (pv !== undefined) metaDeletes.push(key); }
      else if (pv === undefined || canonicalize(pv) !== canonicalize(cv)) metaUpserts.push({ k: key, v: cv });
    }
  }
  const names = o => Object.keys(o).filter(k => Array.isArray(o[k])).sort();
  const pn = names(p), cn = names(c);
  if (!isDeepStrictEqual(pn, cn)) metaUpserts.push({ k: ARRAYS_META_KEY, v: cn });
  return { upserts, deletes, metaUpserts, metaDeletes };
}

export const diffIsEmpty = d => !d.upserts.length && !d.deletes.length && !d.metaUpserts.length && !d.metaDeletes.length;

/** Foreign-key problems a db would hit in Postgres (orphans). Returns string[]. */
export function findReferenceProblems(db) {
  const problems = [];
  const users = new Set((db.users || []).map(u => u.id));
  const links = new Set((db.coachAthleteLinks || []).map(l => l.id));
  for (const c of db.creds || []) if (!users.has(c.userId)) problems.push(`creds ${c.id}: unknown userId ${c.userId}`);
  for (const l of db.coachAthleteLinks || []) {
    if (!users.has(l.coachId)) problems.push(`coachAthleteLinks ${l.id}: unknown coachId ${l.coachId}`);
    if (l.athleteId != null && !users.has(l.athleteId)) problems.push(`coachAthleteLinks ${l.id}: unknown athleteId ${l.athleteId}`);
  }
  for (const i of db.coachInvites || []) {
    if (!links.has(i.linkId)) problems.push(`coachInvites ${i.id}: unknown linkId ${i.linkId}`);
    if (!users.has(i.coachId)) problems.push(`coachInvites ${i.id}: unknown coachId ${i.coachId}`);
    if (typeof i.tokenHash !== 'string' || !i.tokenHash) problems.push(`coachInvites ${i.id}: missing tokenHash`);
  }
  return problems;
}
