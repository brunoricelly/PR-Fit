import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffDb, diffIsEmpty, canonicalize, rowKey, findReferenceProblems, ARRAYS_META_KEY } from '../store/diff.js';

const base = () => ({
  schemaVersion: 3,
  users: [{ id: 'u1', name: 'A' }, { id: 'u2', name: 'B' }],
  invites: [{ code: 'c1', usedBy: null }],
  deviceLinks: [{ h: 'h1', uid: 'u1' }],
  mealPlans: [{ id: 'p1', athleteId: 'u1', n: 1 }, { id: 'p1', athleteId: 'u2', n: 2 }],
  coachAvailability: [{ coachId: 'u1', slots: [] }],
  challenges: [],
});

test('identical dbs produce an empty diff (key order irrelevant)', () => {
  const a = base(), b = base();
  b.users[0] = { name: 'A', id: 'u1' };
  assert.ok(diffIsEmpty(diffDb(a, b)));
  assert.ok(diffIsEmpty(diffDb(a, a)));
});

test('insert, update and delete are detected per collection with the right keys', () => {
  const a = base(), b = structuredClone(a);
  b.users.push({ id: 'u3', name: 'C' });
  b.users[0].name = 'A2';
  b.users.splice(1, 1);
  b.invites[0].usedBy = 'u3';
  b.mealPlans[1].n = 9;
  b.deviceLinks = [];
  const d = diffDb(a, b);
  assert.deepEqual(d.upserts.map(u => `${u.collection}:${u.id}`).sort(), [
    'invites:c1', `mealPlans:${JSON.stringify(['u2', 'p1'])}`, 'users:u1', 'users:u3',
  ].sort());
  assert.deepEqual(d.deletes.map(u => `${u.collection}:${u.id}`).sort(), ['deviceLinks:h1', 'users:u2']);
  assert.deepEqual(d.upserts.find(u => u.id === 'u3').data, { id: 'u3', name: 'C' });
  assert.equal(d.metaUpserts.length, 0);
});

test('composite keys keep same id of different athletes apart', () => {
  assert.notEqual(rowKey('mealPlans', { id: 'p', athleteId: 'a' }), rowKey('mealPlans', { id: 'p', athleteId: 'b' }));
  assert.equal(rowKey('subs', { endpoint: 'https://x' }), 'https://x');
  assert.equal(rowKey('coachAvailability', { coachId: 'c' }), 'c');
  assert.equal(rowKey('schedulingReminderPreferences', { userId: 'u' }), 'u');
  assert.throws(() => rowKey('mealPlans', { id: 'p' }), /no usable key/);
  assert.throws(() => rowKey('users', {}), /no usable key/);
  assert.throws(() => diffDb({}, { users: [{ id: 'x' }, { id: 'x' }] }), /duplicate key/);
});

test('scalars go to meta; array key set is tracked so empty arrays survive', () => {
  const a = base(), b = structuredClone(a);
  b.schemaVersion = 4;
  b.groupPrograms = [];
  delete b.challenges;
  const d = diffDb(a, b);
  assert.deepEqual(d.metaUpserts.find(m => m.k === 'schemaVersion'), { k: 'schemaVersion', v: 4 });
  const arrays = d.metaUpserts.find(m => m.k === ARRAYS_META_KEY).v;
  assert.ok(arrays.includes('groupPrograms') && !arrays.includes('challenges'));
  const gone = structuredClone(a); delete gone.schemaVersion;
  assert.deepEqual(diffDb(a, gone).metaDeletes, ['schemaVersion']);
});

test('diff from nothing upserts every row; to nothing deletes every row', () => {
  const a = base();
  const up = diffDb({}, a);
  assert.equal(up.upserts.length, 2 + 1 + 1 + 2 + 1);
  assert.equal(up.deletes.length, 0);
  const down = diffDb(a, {});
  assert.equal(down.deletes.length, 7);
  assert.equal(down.upserts.length, 0);
});

test('canonicalize ignores key order and undefined', () => {
  assert.equal(canonicalize({ b: 1, a: { d: undefined, c: [1, { z: 1, y: 2 }] } }), canonicalize({ a: { c: [1, { y: 2, z: 1 }] }, b: 1 }));
  assert.notEqual(canonicalize([1, 2]), canonicalize([2, 1]));
});

test('findReferenceProblems flags orphans', () => {
  const db = { users: [{ id: 'u1' }], creds: [{ id: 'k', userId: 'zz' }],
    coachAthleteLinks: [{ id: 'l', coachId: 'u1', athleteId: null }], coachInvites: [{ id: 'i', linkId: 'l', coachId: 'u1', tokenHash: 'x' }] };
  assert.deepEqual(findReferenceProblems(db), ['creds k: unknown userId zz']);
});
