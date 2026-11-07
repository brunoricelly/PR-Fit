/* The account's own delete (App Store rule 5.1.1(v)): a signed-in profile removes itself with
   the same clean-up the admin's delete runs (removeAccount in server.js), typing its name back
   and proving it is the owner the way the other changes to a way in do (proveOwner): here with
   the current password, the passkey half is in server-passkeys.test.js. A paired phone, which
   can hold no passkey for the server, proves a profile without a password by its pairing. The last admin cannot
   leave an instance others still use. Real server.js in a child, same harness as
   server-admin-delete.test.js. */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../password.js';
import { boundPort } from './helpers.mjs';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = crypto.randomBytes(32).toString('hex');
const mintSession = uid => {
  const payload = `${uid}:${Date.now() + 86400000}:0`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
};
const GOOD = 'correct horse battery staple';
let pwHash;
before(async () => { pwHash ??= await hashPassword(GOOD); });
const ADMIN = 'u_adm_1', ADMIN2 = 'u_adm_2', USER = 'u_usr_1';
const as = uid => ({ Cookie: `gymsid=${mintSession(uid)}`, 'Content-Type': 'application/json', Origin: 'http://localhost:8080' });
async function startServer(t, { users: which = ['admin', 'user'], env = {} } = {}) {
  pwHash ??= await hashPassword(GOOD);
  const pw = { h: pwHash, set: new Date().toISOString() };
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-selfdel-'));
  if (env.B2B2C_DB_FAIL_FILE === true) env.B2B2C_DB_FAIL_FILE = path.join(dataDir, 'fail-db-write');
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  const all = {
    admin: { id: ADMIN, name: 'Adminna', created: new Date().toISOString(), admin: true, pw },
    admin2: { id: ADMIN2, name: 'Second', created: new Date().toISOString(), admin: true, pw },
    user: { id: USER, name: 'Mallory', created: new Date().toISOString(), invitedBy: 'CODE1', pw },
    // Passkey-only: no password that could prove anything.
    nopw: { id: 'u_nopw', name: 'Keyonly', created: new Date().toISOString() },
  };
  const chosen = which.map(k => all[k]);
  const coachId = chosen.find(user => user.id === ADMIN)?.id;
  const athleteId = chosen.find(user => user.id === USER)?.id;
  const mealPlans = coachId && athleteId ? [{
    id: 'mp_delete_fixture', coachId, athleteId, title: 'Deletion fixture', status: 'active', targetCalories: 2000,
    targetMacros: { protein: 150, carbs: 250, fats: 65, fiber: 30, waterMl: 2500 },
    meals: [{ id: 'm_delete_fixture', name: 'Full day', time: '08:00', items: [{ id: 'it_delete_fixture', name: 'Menu', portion: 'daily', calories: 2000, protein: 150, carbs: 250, fats: 65, fiber: 30, substitutes: [] }] }],
    notes: '', createdAt: 1, updatedAt: 1,
  }] : [];
  const mealAdherence = mealPlans.length ? [{ id: 'adh_delete_fixture', athleteId, mealPlanId: mealPlans[0].id, date: '2026-11-06', mealsChecked: ['m_delete_fixture'], waterDrunkMl: 1000, notes: '', updatedAt: 1 }] : [];
  const communicationNow = Date.now();
  const coachMessages = coachId && athleteId ? [{ id: 'cmsg_delete_fixture', linkId: 'cal_delete_fixture', senderId: coachId, recipientId: athleteId,
    content: 'deletion fixture', category: 'general', refId: null, createdAt: communicationNow, readAt: null }] : [];
  const coachHabits = coachId && athleteId ? [{ id: 'hab_delete_fixture', linkId: 'cal_delete_fixture', coachId, athleteId, title: 'Deletion fixture',
    description: '', targetValue: 1, unit: 'vezes', frequency: 'daily', status: 'active', createdAt: communicationNow, updatedAt: communicationNow, archivedAt: null }] : [];
  const habitCheckins = coachHabits.length ? [{ id: 'hchk_delete_fixture', linkId: 'cal_delete_fixture', athleteId, habitId: coachHabits[0].id,
    date: new Date().toISOString().slice(0, 10), value: 1, completed: true, notes: '', updatedAt: communicationNow }] : [];
  const progressTimestamp = '2026-11-01T00:00:00.000Z';
  const progressGoals = coachId && athleteId ? [{
    id: 'pgoal_delete_fixture', linkId: 'cal_delete_fixture', coachId, athleteId,
    metric: 'nutrition_adherence_percent', direction: 'increase', baselineValue: 50, targetValue: 80, tolerance: 2,
    startDate: '2026-11-01', targetDate: '2026-12-01', timezone: 'UTC', status: 'active',
    createdAt: progressTimestamp, updatedAt: progressTimestamp, achievedAt: null, archivedAt: null,
  }] : [];
  const progressReports = coachId && athleteId ? [{
    id: 'prep_delete_fixture', linkId: 'cal_delete_fixture', coachId, athleteId,
    interval: { from: '2026-11-01', to: '2026-11-06' }, timezone: 'UTC', metrics: ['nutrition_adherence_percent'],
    summary: 'nutrition_adherence_percent: unavailable (fixture).',
    snapshot: { version: 1, generatedAt: progressTimestamp, period: { from: '2026-11-01', to: '2026-11-06' }, metrics: {} },
    createdAt: progressTimestamp, revokedAt: null,
  }] : [];
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
    users: which.map(k => all[k]),
    creds: [{ id: 'c-user', userId: USER, publicKey: 'x' }, { id: 'c-admin', userId: ADMIN, publicKey: 'y' }],
    subs: [{ endpoint: 'https://push/user', userId: USER }, { endpoint: 'https://push/admin', userId: ADMIN }],
    deviceLinks: [{ userId: USER, h: 'device-user', exp: Date.now() + 86400000 }, { userId: ADMIN, h: 'device-admin', exp: Date.now() + 86400000 }],
    watchLinks: [{ id: 'watch-user', userId: USER, h: 'watch-user', created: Date.now() }, { id: 'watch-admin', userId: ADMIN, h: 'watch-admin', created: Date.now() }],
    invites: [{ code: 'CODE1', usedBy: USER, usedAt: new Date().toISOString() }],
    coachInvites: [], coachAthleteLinks: coachId && athleteId ? [{ id: 'cal_delete_fixture', coachId, athleteId, scopes: ['nutrition'], status: 'active', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }] : [],
    coachPrescriptions: [], coachAssessments: [], mealPlans, mealAdherence, coachMessages, coachHabits, habitCheckins,
    progressGoals, progressReports,
  }));
  for (const uid of [USER, ADMIN]) fs.writeFileSync(path.join(dataDir, `state-${uid}.json`), JSON.stringify({ unit: 'kg', workouts: [], _rev: 3 }));
  const processEnv = { ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN: 'http://localhost:8080', RP_ID: 'localhost', PASSWORD_LOGIN: '1', AUDIT_LOG: '1', ...env };
  const spawnServer = () => spawn(process.execPath, ['server.js'], { cwd: API, stdio: ['ignore', 'pipe', 'pipe'], env: processEnv });
  const h = { api: '', log: '', dataDir, child: spawnServer() };
  const listen = child => { child.stdout.on('data', d => h.log += d); child.stderr.on('data', d => h.log += d); };
  listen(h.child);
  t.after(() => { h.child.kill('SIGKILL'); fs.rmSync(dataDir, { recursive: true, force: true }); });
  h.port = await boundPort(h.child, () => h.log);
  h.api = `http://127.0.0.1:${h.port}`;
  h.restart = async () => {
    const old = h.child;
    old.kill('SIGTERM');
    await new Promise(resolve => old.once('exit', resolve));
    h.child = spawnServer();
    listen(h.child);
    h.port = await boundPort(h.child, () => h.log);
    h.api = `http://127.0.0.1:${h.port}`;
  };
  h.del = async (uid, body) => {
    const r = await fetch(`${h.api}/api/account/delete`, { method: 'POST', headers: as(uid), body: JSON.stringify(body) });
    return { status: r.status, body: await r.json(), cookie: r.headers.get('set-cookie') || '' };
  };
  h.db = () => JSON.parse(fs.readFileSync(path.join(h.dataDir, 'db.json'), 'utf8'));
  h.audit = () => fs.readFileSync(path.join(h.dataDir, 'audit.log'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  h.stackFrames = () => h.log.split('\n').filter(l => /^\s+at /.test(l)).length;
  return h;
}

for (const [label, deleted, survivors] of [
  ['athlete', USER, ['admin', 'user']],
  ['coach', ADMIN, ['admin', 'admin2', 'user']],
]) {
  test(`failed ${label} account deletion rolls nutrition back in memory and on the next save`, async t => {
    const h = await startServer(t, { users: survivors, env: { B2B2C_DB_FAIL_FILE: true } });
    const before = h.db();
    assert.ok(before.mealPlans.length && before.mealAdherence.length);
    assert.ok(before.coachMessages.length && before.coachHabits.length && before.habitCheckins.length);
    assert.ok(before.progressGoals.length && before.progressReports.length);
    fs.writeFileSync(path.join(h.dataDir, 'fail-db-write'), 'once');
    const account = before.users.find(user => user.id === deleted);
    const failed = await h.del(deleted, { name: account.name, current: GOOD });
    assert.equal(failed.status, 500);
    assert.deepEqual(h.db().mealPlans, before.mealPlans, 'disk plans rolled back');
    assert.deepEqual(h.db().mealAdherence, before.mealAdherence, 'disk adherence rolled back');
    assert.deepEqual(h.db().coachMessages, before.coachMessages, 'disk messages rolled back');
    assert.deepEqual(h.db().coachHabits, before.coachHabits, 'disk habits rolled back');
    assert.deepEqual(h.db().habitCheckins, before.habitCheckins, 'disk check-ins rolled back');
    assert.deepEqual(h.db().progressGoals, before.progressGoals, 'disk progress goals rolled back');
    assert.deepEqual(h.db().progressReports, before.progressReports, 'disk progress reports rolled back');
    assert.deepEqual(h.db().deviceLinks, before.deviceLinks, 'disk device links rolled back');
    assert.deepEqual(h.db().watchLinks, before.watchLinks, 'disk watch links rolled back');
    await h.restart();
    assert.deepEqual(h.db().users, before.users, 'restart keeps the account');
    assert.deepEqual(h.db().deviceLinks, before.deviceLinks, 'restart keeps device links');
    assert.deepEqual(h.db().watchLinks, before.watchLinks, 'restart keeps watch links');
    // A subsequent successful DB mutation persists the in-memory snapshot too. Without the two
    // collections in removeAccount's snapshot this save would silently commit their deletion.
    const info = await fetch(`${h.api}/api/logout/all`, { method: 'POST', headers: as(USER) });
    assert.equal(info.status, 200);
    assert.deepEqual(h.db().mealPlans, before.mealPlans, 'next save proves in-memory plans survived');
    assert.deepEqual(h.db().mealAdherence, before.mealAdherence, 'next save proves in-memory adherence survived');
    assert.deepEqual(h.db().coachMessages, before.coachMessages, 'next save proves in-memory messages survived');
    assert.deepEqual(h.db().coachHabits, before.coachHabits, 'next save proves in-memory habits survived');
    assert.deepEqual(h.db().habitCheckins, before.habitCheckins, 'next save proves in-memory check-ins survived');
    assert.deepEqual(h.db().progressGoals, before.progressGoals, 'next save proves in-memory progress goals survived');
    assert.deepEqual(h.db().progressReports, before.progressReports, 'next save proves in-memory progress reports survived');
  });
}

test('removes the account and everything attached to it, and ends the session', async t => {
  const h = await startServer(t);
  const res = await h.del(USER, { name: 'Mallory', current: GOOD });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.match(res.cookie, /gymsid=;.*Max-Age=0/, 'the session cookie is cleared');

  const db = h.db();
  assert.deepEqual(db.users.map(u => u.id), [ADMIN], 'the user is gone');
  assert.deepEqual(db.creds.map(c => c.userId), [ADMIN], 'their passkeys are gone');
  assert.deepEqual(db.subs.map(s => s.userId), [ADMIN], 'their push subscriptions are gone');
  assert.deepEqual([db.coachMessages.length, db.coachHabits.length, db.habitCheckins.length], [0, 0, 0], 'communication and habits are gone');
  assert.deepEqual([db.progressGoals.length, db.progressReports.length], [0, 0], 'progress goals and reports are gone');
  assert.equal(db.deviceLinks.some(link => link.userId === USER), false);
  assert.equal(db.watchLinks.some(link => link.userId === USER), false);
  assert.equal(fs.existsSync(path.join(h.dataDir, `state-${USER}.json`)), false, 'their history is gone');
  assert.equal(fs.existsSync(path.join(h.dataDir, `state-${ADMIN}.json`)), true, 'nobody else’s is touched');
  assert.equal(db.invites[0].usedBy, USER, 'the code they joined with stays burned');

  const me = await fetch(`${h.api}/api/me`, { headers: as(USER) });
  assert.equal(me.status, 401, 'a cookie for a deleted account is worthless');
  const ev = h.audit().find(r => r.ev === 'auth.account.delete');
  assert.ok(ev, 'audited');
  assert.equal(ev.uid, USER);
  assert.equal(ev.name, 'Mallory', 'by name, since the id stops meaning anything');
  assert.equal(h.stackFrames(), 0, `no stack traces:\n${h.log}`);
});

test('external cleanup failure is observable and boot retry never resurrects the account', async t => {
  const h = await startServer(t, { env: { ACCOUNT_CLEANUP_FAIL_FILE: 'cleanup-fail' } });
  fs.writeFileSync(path.join(h.dataDir, 'cleanup-fail'), 'state,integrations');
  const res = await h.del(USER, { name: 'Mallory', current: GOOD });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'cleanup_pending');
  let stored = h.db();
  assert.equal(stored.users.some(user => user.id === USER), false, 'access is removed before cleanup');
  assert.equal(stored.accountCleanupJobs.length, 1);
  assert.equal(stored.accountCleanupJobs[0].status, 'pending');
  assert.match(stored.accountCleanupJobs[0].lastError, /integrations:EIO/);
  assert.equal(JSON.stringify(stored.accountCleanupJobs[0]).includes('user'), false, 'cleanup metadata has no plaintext subject id');

  await h.restart();
  for (let attempt = 0; attempt < 50 && h.db().accountCleanupJobs[0].status !== 'complete'; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  stored = h.db();
  assert.equal(stored.users.some(user => user.id === USER), false, 'retry does not resurrect the account');
  assert.equal(stored.accountCleanupJobs[0].status, 'complete');
  assert.ok(stored.accountCleanupJobs[0].attempts >= 2);
  assert.equal(fs.existsSync(path.join(h.dataDir, `state-${USER}.json`)), false);
});

test('external cleanup retries during runtime with bounded attempts and no account resurrection', async t => {
  const h = await startServer(t, { env: {
    ACCOUNT_CLEANUP_FAIL_FILE: 'cleanup-fail', ACCOUNT_CLEANUP_RETRY_BASE_MS: '80',
    ACCOUNT_CLEANUP_RETRY_MAX_MS: '80', ACCOUNT_CLEANUP_MAX_ATTEMPTS: '3',
  } });
  fs.writeFileSync(path.join(h.dataDir, 'cleanup-fail'), 'integrations');
  const res = await h.del(USER, { name: 'Mallory', current: GOOD });
  assert.equal(res.body.status, 'cleanup_pending');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual([h.db().accountCleanupJobs[0].status, h.db().accountCleanupJobs[0].attempts], ['pending', 1], 'retry honors its persisted backoff');
  for (let attempt = 0; attempt < 50 && h.db().accountCleanupJobs[0].status !== 'complete'; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const stored = h.db();
  assert.equal(stored.users.some(user => user.id === USER), false);
  assert.equal(stored.accountCleanupJobs[0].status, 'complete');
  assert.ok(stored.accountCleanupJobs[0].attempts >= 2);
});

test('cleanup retry exhaustion becomes manual review and does not consume pending capacity forever', async t => {
  const h = await startServer(t, { env: {
    ACCOUNT_CLEANUP_FAIL_STEP: 'integrations', ACCOUNT_CLEANUP_RETRY_BASE_MS: '10',
    ACCOUNT_CLEANUP_RETRY_MAX_MS: '20', ACCOUNT_CLEANUP_MAX_ATTEMPTS: '2',
  } });
  const res = await h.del(USER, { name: 'Mallory', current: GOOD });
  assert.equal(res.body.status, 'cleanup_pending');
  for (let attempt = 0; attempt < 50 && h.db().accountCleanupJobs[0].status === 'pending'; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const job = h.db().accountCleanupJobs[0];
  assert.equal(job.status, 'manual_review');
  assert.equal(job.attempts, 2);
  assert.match(job.lastError, /integrations:EIO/);
  assert.equal(JSON.stringify(job).includes(USER), false);
});

test('cleanup subject decryption failure is fail-closed and observable without exposing the account', async t => {
  const h = await startServer(t, { env: {
    ACCOUNT_CLEANUP_FAIL_STEP: 'integrations', ACCOUNT_CLEANUP_RETRY_BASE_MS: '60000',
    ACCOUNT_CLEANUP_RETRY_MAX_MS: '60000', ACCOUNT_CLEANUP_MAX_ATTEMPTS: '2',
  } });
  const res = await h.del(USER, { name: 'Mallory', current: GOOD });
  assert.equal(res.body.status, 'cleanup_pending');
  fs.writeFileSync(path.join(h.dataDir, 'secret'), crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  await h.restart();
  for (let attempt = 0; attempt < 50 && h.db().accountCleanupJobs[0].status === 'pending'; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const job = h.db().accountCleanupJobs[0];
  assert.deepEqual([job.status, job.lastError], ['manual_review', 'subject:invalid']);
  assert.equal(h.log.includes(USER), false);
  assert.equal(h.db().users.some(user => user.id === USER), false);
});

test('missing external files are successful idempotent cleanup, not pending work', async t => {
  const h = await startServer(t);
  fs.unlinkSync(path.join(h.dataDir, `state-${USER}.json`));
  const res = await h.del(USER, { name: 'Mallory', current: GOOD });
  assert.deepEqual(res.body, { ok: true });
  assert.equal(h.db().accountCleanupJobs[0].status, 'complete');
});

test('needs the account name typed back', async t => {
  const h = await startServer(t);
  // Checked before the proof: a wrong name costs no password check, even with the right one.
  for (const body of [{}, { name: '' }, { name: 'mallory', current: GOOD }, { name: 'Adminna', current: GOOD }, { name: 42 }]) {
    const res = await h.del(USER, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.code, 'confirm-name');
  }
  assert.equal(h.db().users.length, 2, 'nothing was removed');
  // Spaces around it are a keyboard's, not a different name.
  assert.equal((await h.del(USER, { name: ' Mallory ', current: GOOD })).status, 200);
});

test('needs a session, and a request from another origin is refused', async t => {
  const h = await startServer(t);
  const anon = await fetch(`${h.api}/api/account/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:8080' }, body: JSON.stringify({ name: 'Mallory' }) });
  assert.equal(anon.status, 401);
  const cross = await fetch(`${h.api}/api/account/delete`, { method: 'POST', headers: { ...as(USER), Origin: 'https://evil.example' }, body: JSON.stringify({ name: 'Mallory' }) });
  assert.equal(cross.status, 403);
  assert.equal(h.db().users.length, 2);
});

test('the last admin cannot leave while other profiles remain, proof or not', async t => {
  const h = await startServer(t);
  assert.equal((await h.del(ADMIN, { name: 'Adminna' })).body.code, 'last-admin', 'refused before any proof is asked');
  const res = await h.del(ADMIN, { name: 'Adminna', current: GOOD });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'last-admin');
  assert.equal(h.db().users.length, 2, 'nothing was removed');
});

test('the delete sheet learns of the last-admin refusal before it asks for any proof', async t => {
  const h = await startServer(t, { users: ['admin', 'user', 'admin2'] });
  const info = async uid => (await fetch(`${h.api}/api/account/passkeys`, { headers: as(uid) })).json();
  assert.equal((await info(ADMIN)).deleteBlocked, undefined, 'another admin remains: nothing blocks');
  assert.equal((await info(USER)).deleteBlocked, undefined, 'a plain profile is never blocked');
  assert.equal((await h.del(ADMIN2, { name: h.db().users.find(u => u.id === ADMIN2).name, current: GOOD })).status, 200);
  assert.equal((await info(ADMIN)).deleteBlocked, 'last-admin', 'now the only admin, with a profile left');
  assert.equal((await info(USER)).deleteBlocked, undefined);
});

test('alone on the instance the last admin is not blocked', async t => {
  const h = await startServer(t, { users: ['admin'] });
  const r = await (await fetch(`${h.api}/api/account/passkeys`, { headers: as(ADMIN) })).json();
  assert.equal(r.deleteBlocked, undefined);
});

test('an admin can leave while another admin remains', async t => {
  const h = await startServer(t, { users: ['admin', 'admin2', 'user'] });
  assert.equal((await h.del(ADMIN, { name: 'Adminna', current: GOOD })).status, 200);
  assert.deepEqual(h.db().users.map(u => u.id).sort(), [ADMIN2, USER].sort());
});

test('the only profile on the instance can delete itself, admin or not', async t => {
  const h = await startServer(t, { users: ['admin'] });
  assert.equal((await h.del(ADMIN, { name: 'Adminna', current: GOOD })).status, 200);
  assert.deepEqual(h.db().users, []);
  assert.equal(fs.existsSync(path.join(h.dataDir, `state-${ADMIN}.json`)), false);
});

test('a paired phone: the pairing is the proof without a password, the password with one', async t => {
  const h = await startServer(t, { users: ['admin', 'user', 'nopw'] });
  const phone = (uid, body) => fetch(`${h.api}/api/account/delete`, {
    method: 'POST', headers: { Authorization: `Bearer ${mintSession(uid)}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  }).then(async r => ({ status: r.status, body: await r.json() }));

  // A profile with a password sends it from the phone like from anywhere else.
  const without = await phone(USER, { name: 'Mallory' });
  assert.equal(without.status, 403);
  assert.equal(without.body.code, 'current-required');
  assert.equal((await phone(USER, { name: 'Mallory', current: 'not the password at all' })).body.code, 'current-wrong');
  assert.equal(h.db().users.length, 3, 'nothing was removed');
  // The name and the last admin still come first.
  assert.equal((await phone('u_nopw', { name: 'keyonly' })).body.code, 'confirm-name');

  // Passkey-only: the phone cannot hold a passkey for the server, so the pairing proves it.
  const keyOnly = await phone('u_nopw', { name: 'Keyonly' });
  assert.equal(keyOnly.status, 200);
  assert.deepEqual(h.db().users.map(u => u.id).sort(), [ADMIN, USER].sort());
  assert.equal(h.audit().find(r => r.ev === 'auth.account.delete')?.msg, 'device');

  assert.equal((await phone(USER, { name: 'Mallory', current: GOOD })).status, 200);
  assert.deepEqual(h.db().users.map(u => u.id), [ADMIN]);
});

test('a browser never gets the phone’s pass: no proof, no delete', async t => {
  const h = await startServer(t, { users: ['admin', 'nopw'] });
  const res = await h.del('u_nopw', { name: 'Keyonly' });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'passkey-required');
  assert.equal(h.db().users.length, 2);
});

test('a browser cookie replayed as a Bearer is still a cookie: no device pass', async t => {
  const h = await startServer(t, { users: ['admin', 'nopw'] });
  // A cookie as the server mints it for a browser: the fourth field says `c`.
  const payload = `u_nopw:${Date.now() + 86400000}:0:c`;
  const cookie = payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  const r = await fetch(`${h.api}/api/account/delete`, {
    method: 'POST', headers: { Authorization: `Bearer ${cookie}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Keyonly' })
  });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).code, 'passkey-required');
  assert.equal(h.db().users.length, 2, 'nothing was removed');
  // A token the pairing made (`b`) still carries the device pass.
  const pb = `u_nopw:${Date.now() + 86400000}:0:b`;
  const paired = pb + '.' + crypto.createHmac('sha256', SECRET).update(pb).digest('base64url');
  const ok = await fetch(`${h.api}/api/account/delete`, {
    method: 'POST', headers: { Authorization: `Bearer ${paired}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Keyonly' })
  });
  assert.equal(ok.status, 200);
});

test('needs proof that the owner is here: missing or wrong, nothing is removed', async t => {
  const h = await startServer(t, { users: ['admin', 'user', 'nopw'] });
  const none = await h.del(USER, { name: 'Mallory' });
  assert.equal(none.status, 403);
  assert.equal(none.body.code, 'current-required');
  const wrong = await h.del(USER, { name: 'Mallory', current: 'not the password at all' });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.body.code, 'current-wrong');
  // No password, so only a passkey can say it is them; an assertion that does not verify is no proof.
  const keyOnly = await h.del('u_nopw', { name: 'Keyonly', current: GOOD });
  assert.equal(keyOnly.status, 403);
  assert.equal(keyOnly.body.code, 'passkey-required');
  const bogus = await h.del('u_nopw', { name: 'Keyonly', cid: 'nope', credential: { id: 'x', response: {} } });
  assert.equal(bogus.status, 403);
  assert.equal(bogus.body.code, 'passkey');

  assert.equal(h.db().users.length, 3, 'nothing was removed');
  assert.equal(fs.existsSync(path.join(h.dataDir, `state-${USER}.json`)), true);
  const fails = h.audit().filter(r => r.ev === 'auth.proof.fail');
  assert.ok(fails.length >= 2 && fails.every(r => r.act === 'account-delete'), 'logged as a refused proof for the delete');
  assert.ok(!h.audit().some(r => r.ev === 'auth.account.delete'));
});

test('with password sign-in off, a password proves nothing', async t => {
  const h = await startServer(t, { env: { PASSWORD_LOGIN: '' } });
  const res = await h.del(USER, { name: 'Mallory', current: GOOD });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'passkey-required');
  assert.equal(h.db().users.length, 2);
});
