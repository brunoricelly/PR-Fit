import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { migrate } from '../store/migrate.js';
import { loadAll, saveAll, saveDiff, saveMerged, getUserState, putUserState, updateUserState, RevConflictError } from '../store/pg-store.js';
import { canonicalize, diffDb } from '../store/diff.js';

const URL = process.env.DATABASE_URL;
const skip = URL ? false : 'DATABASE_URL not set';
const schema = 'store_test_' + crypto.randomBytes(4).toString('hex');
let admin, pool;

export function syntheticDb() {
  const t = '2026-01-01T00:00:00.000Z';
  return {
    schemaVersion: 7,
    users: [{ id: 'u_coach', name: 'Coach', created: t, role: 'coach' }, { id: 'u_a1', name: 'Ana', created: t }, { id: 'u_a2', name: 'Bia', created: t, extra: { nested: [1, 2, { x: null }] } }],
    creds: [{ id: 'cred1', userId: 'u_a1', publicKey: 'pk', counter: 3, transports: ['internal'], created: t, lastUsed: t }, { id: 'cred2', userId: 'u_coach', publicKey: 'pk2', counter: 0, transports: [], created: t, lastUsed: t }],
    subs: [{ endpoint: 'https://push.example/1', userId: 'u_a1', keys: { p256dh: 'a', auth: 'b' } }],
    invites: [{ code: 'INV-1', usedBy: null }, { code: 'INV-2', usedBy: 'u_a1', usedAt: t }],
    deviceLinks: [{ h: 'hash1', uid: 'u_a1', created: t }],
    watchLinks: [{ h: 'whash1', uid: 'u_a1', created: t }],
    coachAthleteLinks: [
      { id: 'cal_1', coachId: 'u_coach', athleteId: 'u_a1', scopes: ['plan'], status: 'active', createdAt: t, updatedAt: t },
      { id: 'cal_2', coachId: 'u_coach', athleteId: null, scopes: [], status: 'pending', createdAt: t, updatedAt: t }],
    coachInvites: [{ id: 'cai_1', linkId: 'cal_2', coachId: 'u_coach', tokenHash: 'th1', createdAt: t, expiresAt: t, acceptedAt: null, acceptedBy: null }],
    coachPrescriptions: [{ id: 'rx1', coachId: 'u_coach', athleteId: 'u_a1', title: 'Treino A' }],
    coachAssessments: [{ id: 'as1', coachId: 'u_coach', athleteId: 'u_a1' }],
    mealPlans: [{ id: 'mp1', athleteId: 'u_a1', coachId: 'u_coach', meals: [] }, { id: 'mp1', athleteId: 'u_a2', coachId: 'u_coach', meals: [{ n: 1 }] }],
    mealAdherence: [{ id: 'ma1', athleteId: 'u_a1', day: '2026-01-01' }],
    mealPlanTombstones: [{ id: 'mp0', athleteId: 'u_a1', at: t }],
    coachMessages: [{ id: 'm1', coachId: 'u_coach', athleteId: 'u_a1', text: 'oi' }],
    coachHabits: [{ id: 'h1', coachId: 'u_coach', athleteId: 'u_a1' }],
    habitCheckins: [{ id: 'hc1', athleteId: 'u_a1' }],
    accountCleanupJobs: [{ id: 'acj1', userId: 'u_a2' }],
    progressGoals: [{ id: 'pg1', athleteId: 'u_a1' }],
    progressReports: [{ id: 'pr1', athleteId: 'u_a1' }],
    coachAvailability: [{ coachId: 'u_coach', slots: [{ d: 1 }] }],
    coachAppointments: [{ id: 'ap1', coachId: 'u_coach', athleteId: 'u_a1' }],
    schedulingReminderPreferences: [{ userId: 'u_a1', enabled: true }],
    appointmentReminderStates: [{ id: 'ars1' }],
    schedulingReminderOutbox: [{ id: 'sro1' }],
    coachGroups: [{ id: 'g1', coachId: 'u_coach' }],
    groupMembers: [{ id: 'gm1', groupId: 'g1', userId: 'u_a1' }],
    groupInvites: [{ id: 'gi1', groupId: 'g1' }],
    challenges: [{ id: 'ch1', groupId: 'g1' }],
    challengeScores: [{ id: 'cs1', challengeId: 'ch1', userId: 'u_a1' }],
    challengeActivityFeed: [],
    groupPrograms: [{ id: 'gp1', groupId: 'g1' }],
    groupProgramAdoptions: [{ id: 'gpa1', programId: 'gp1' }],
  };
}

before(async () => {
  if (skip) return;
  admin = new pg.Pool({ connectionString: URL, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new pg.Pool({ connectionString: URL, max: 8, options: `-c search_path=${schema}` });
  await migrate(pool);
});
after(async () => {
  if (skip) return;
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});

test('migrate is idempotent', { skip }, async () => {
  assert.deepEqual(await migrate(pool), []);
  // concurrent runners on a fresh schema: exactly one applies
  await admin.query(`CREATE SCHEMA ${schema}_m`);
  const p = new pg.Pool({ connectionString: URL, max: 4, options: `-c search_path=${schema}_m` });
  try {
    const runs = await Promise.all([migrate(p), migrate(p), migrate(p)]);
    assert.equal(runs.flat().length, 2);
  } finally { await p.end(); await admin.query(`DROP SCHEMA ${schema}_m CASCADE`); }
});

test('round trip: loadAll(saveAll(db)) equals the input db, and stays stable on re-save', { skip }, async () => {
  const db = syntheticDb();
  await saveAll(pool, db);
  const back = await loadAll(pool);
  assert.deepEqual(back, db);
  assert.equal(canonicalize(back), canonicalize(db));
  const again = await saveAll(pool, back);
  assert.equal(again.upserts.length + again.deletes.length + again.metaUpserts.length + again.metaDeletes.length, 0);
});

test('incremental diffs: update, insert, delete (FK cascade-safe order), empty arrays survive', { skip }, async () => {
  const db = syntheticDb();
  await saveAll(pool, db);
  const next = structuredClone(db);
  next.users[1].name = 'Ana 2';
  next.users.push({ id: 'u_new', name: 'Novo', created: 'x' });
  next.creds.push({ id: 'cred3', userId: 'u_new' });
  next.coachInvites = []; // delete child before parents
  next.coachAthleteLinks = next.coachAthleteLinks.filter(l => l.id !== 'cal_2');
  next.mealPlans = next.mealPlans.filter(p => p.athleteId !== 'u_a2');
  next.schemaVersion = 8;
  delete next.watchLinks;
  await saveDiff(pool, diffDb(await loadAll(pool), next));
  const back = await loadAll(pool);
  assert.equal(canonicalize(back), canonicalize(next));
  assert.deepEqual(back.coachInvites, []);
  assert.equal(back.watchLinks, undefined);
  // deleting a user removes dependent creds in the same diff
  const n2 = structuredClone(next);
  n2.users = n2.users.filter(u => u.id !== 'u_new'); n2.creds = n2.creds.filter(c => c.userId !== 'u_new');
  await saveAll(pool, n2);
  assert.equal(canonicalize(await loadAll(pool)), canonicalize(n2));
});

test('invalid rows are rejected atomically (FK violation rolls the whole diff back)', { skip }, async () => {
  const db = syntheticDb();
  await saveAll(pool, db);
  const bad = structuredClone(db);
  bad.challenges.push({ id: 'ch_new' });
  bad.creds.push({ id: 'orphan', userId: 'nobody' });
  await assert.rejects(saveAll(pool, bad), /foreign key|violates/);
  assert.deepEqual(await loadAll(pool), db);
});

test('2 concurrent saves are serialised: both apply, none torn', { skip }, async () => {
  await saveAll(pool, syntheticDb());
  const base = await loadAll(pool);
  const a = structuredClone(base), b = structuredClone(base);
  for (let i = 0; i < 200; i++) { a.challengeScores.push({ id: 'a' + i, challengeId: 'ch1', userId: 'u_a1' }); b.challengeActivityFeed.push({ id: 'b' + i }); }
  a.users[0].name = 'from A';
  const dA = diffDb(base, a), dB = diffDb(base, b);
  await Promise.all([saveDiff(pool, dA), saveDiff(pool, dB)]);
  const back = await loadAll(pool);
  assert.equal(back.challengeScores.length, 201);
  assert.equal(back.challengeActivityFeed.length, 200);
  assert.equal(back.users[0].name, 'from A');
  // two full saveAll in parallel: last writer wins whole, result equals one of the inputs
  const x = structuredClone(base), y = structuredClone(base);
  x.schemaVersion = 100; x.coachGroups.push({ id: 'gx', coachId: 'u_coach' });
  y.schemaVersion = 200; y.coachGroups.push({ id: 'gy', coachId: 'u_coach' });
  await Promise.all([saveAll(pool, x), saveAll(pool, y)]);
  const fin = await loadAll(pool);
  assert.ok(canonicalize(fin) === canonicalize(x) || canonicalize(fin) === canonicalize(y));
});

test('saveMerged usa caminho rápido sem reler tabelas e o db_rev sobe', { skip }, async () => {
  await saveAll(pool, syntheticDb());
  let tableReads = 0;
  const observed = {
    query: (...args) => pool.query(...args),
    connect: async () => {
      const client = await pool.connect();
      return {
        query: (...args) => {
          if (/SELECT (?:collection, )?data FROM (?:collections|users|creds|coach_athlete_links|coach_invites)/.test(args[0])) tableReads++;
          return client.query(...args);
        },
        release: () => client.release(),
      };
    },
  };
  const base = await loadAll(observed);
  tableReads = 0;
  const next = structuredClone(base);
  next.coachMessages.push({ id: 'fast', text: 'incremental' });
  await saveMerged(observed, base, next);
  assert.equal(tableReads, 0);
  assert.ok((await pool.query("SELECT (v #>> '{}')::int AS rev FROM meta WHERE k='$db_rev'")).rows[0].rev > 0);
  assert.equal((await loadAll(pool)).coachMessages.at(-1).id, 'fast');
});

test('dois pools detectam revisão externa, mesclam chaves distintas e preservam conflito', { skip }, async () => {
  await saveAll(pool, syntheticDb());
  const p2 = new pg.Pool({ connectionString: URL, max: 2, options: `-c search_path=${schema}` });
  try {
    const base1 = await loadAll(pool), base2 = await loadAll(p2);
    const one = structuredClone(base1); one.challengeScores.push({ id: 'pool1', challengeId: 'ch1', userId: 'u_a1' });
    const two = structuredClone(base2); two.challengeActivityFeed.push({ id: 'pool2' });
    await saveMerged(pool, base1, one);
    await saveMerged(p2, base2, two); // revisão divergente: caminho lento + merge
    const merged = await loadAll(pool);
    assert.ok(merged.challengeScores.some(r => r.id === 'pool1'));
    assert.ok(merged.challengeActivityFeed.some(r => r.id === 'pool2'));

    const stale = await loadAll(p2), current = await loadAll(pool);
    const a = structuredClone(current), b = structuredClone(stale);
    a.schemaVersion = 101; b.schemaVersion = 202;
    await saveMerged(pool, current, a);
    await assert.rejects(saveMerged(p2, stale, b), { name: 'ConcurrentDbWriteError', key: 'schemaVersion' });
  } finally { await p2.end(); }
});

test('user_state: optimistic rev; concurrent writers conflict, updateUserState retries', { skip }, async () => {
  assert.equal(await getUserState(pool, 'u1'), null);
  assert.equal(await putUserState(pool, 'u1', { w: 1 }, null), 1);
  await assert.rejects(putUserState(pool, 'u1', { w: 9 }, null), RevConflictError);
  const results = await Promise.allSettled([putUserState(pool, 'u1', { w: 'A' }, 1), putUserState(pool, 'u1', { w: 'B' }, 1)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.ok(results.find(r => r.status === 'rejected').reason instanceof RevConflictError);
  assert.equal((await getUserState(pool, 'u1')).rev, 2);
  await assert.rejects(putUserState(pool, 'u1', { w: 'stale' }, 1), RevConflictError);
  await putUserState(pool, 'u2', { n: 0 }, null);
  await Promise.all(Array.from({ length: 10 }, () => updateUserState(pool, 'u2', d => ({ n: d.n + 1 }), { retries: 20 })));
  const s = await getUserState(pool, 'u2');
  assert.equal(s.doc.n, 10);
  assert.equal(s.rev, 11);
});
