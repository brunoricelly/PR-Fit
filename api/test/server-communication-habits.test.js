import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers.mjs';
import { dateInTimeZone, habitSummary, validateCommunicationHabitsLimits } from '../communication-habits.js';
import { compactB2B2C } from '../b2b2c.js';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'http://localhost:8080';
const SECRET = crypto.randomBytes(32).toString('hex');
const IDS = { coachA: 'u_comm_coach_a', coachB: 'u_comm_coach_b', athleteA: 'u_comm_athlete_a', athleteB: 'u_comm_athlete_b' };

function mintSession(uid) {
  const payload = `${uid}:${Date.now() + 86400000}:0:c`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}

const daysAgo = amount => new Date(Date.now() - amount * 86400000).toISOString().slice(0, 10);
const dayStringForTest = timestamp => new Date(timestamp).toISOString().slice(0, 10);

function baseDb(overrides = {}) {
  const recent = new Date().toISOString();
  return {
    schemaVersion: 6,
    users: [
      { id: IDS.coachA, name: 'Coach A', admin: true, profile: { kind: 'coach', coachSpecialties: ['training'] } },
      { id: IDS.coachB, name: 'Coach B', profile: { kind: 'coach', coachSpecialties: ['nutrition'] } },
      { id: IDS.athleteA, name: 'Athlete A' },
      { id: IDS.athleteB, name: 'Athlete B' },
    ],
    creds: [], subs: [], invites: [], coachInvites: [], coachPrescriptions: [], coachAssessments: [], mealPlans: [], mealAdherence: [],
    coachAthleteLinks: [
      { id: 'cal_comm_aa', coachId: IDS.coachA, athleteId: IDS.athleteA, scopes: ['training'], status: 'active', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'cal_comm_ba', coachId: IDS.coachB, athleteId: IDS.athleteA, scopes: ['nutrition'], status: 'active', createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' },
      { id: 'cal_comm_bb', coachId: IDS.coachB, athleteId: IDS.athleteB, scopes: ['nutrition'], status: 'suspended', createdAt: '2026-01-03T00:00:00.000Z', updatedAt: '2026-01-03T00:00:00.000Z', suspendedAt: '2026-01-03T00:00:00.000Z' },
      { id: 'cal_comm_ab', coachId: IDS.coachA, athleteId: IDS.athleteB, scopes: ['training'], status: 'ended', createdAt: recent, updatedAt: recent, endedAt: recent },
    ],
    coachMessages: [], coachHabits: [], habitCheckins: [],
    ...overrides,
  };
}

function seed(dataDir, db = baseDb()) {
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify(db, null, 2));
}

async function launch(dataDir, env = {}) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN, RP_ID: 'localhost', AUDIT_LOG: '1',
      B2B2C_DB_FAIL_FILE: path.join(dataDir, 'fail-db-write'), ...env },
  });
  let log = '';
  child.stdout.on('data', chunk => log += chunk);
  child.stderr.on('data', chunk => log += chunk);
  const port = await boundPort(child, () => log);
  return { child, api: `http://127.0.0.1:${port}`, log: () => log };
}

async function stop(server) {
  if (server.child.exitCode !== null) return;
  server.child.kill('SIGTERM');
  await new Promise(resolve => server.child.once('exit', resolve));
}

async function request(server, uid, method, route, body) {
  const response = await fetch(server.api + route, {
    method, headers: { Cookie: `gymsid=${mintSession(uid)}`, Origin: ORIGIN, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json(), headers: response.headers };
}

const message = content => ({ content, category: 'general', refId: null });
const habit = (title, frequency = 'daily') => ({ title, description: '<b>texto literal</b>', targetValue: 8, unit: 'horas', frequency });

test('messages are bidirectional, recipient-read, cursor-stable, isolated and durable', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-communication-'));
  seed(dataDir);
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let server = await launch(dataDir);
  t.after(async () => stop(server));

  const first = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/messages`, message('<b>literal, not HTML</b>'));
  assert.equal(first.status, 201);
  assert.equal(first.body.message.content, '<b>literal, not HTML</b>');
  const reply = await request(server, IDS.athleteA, 'POST', `/api/athlete/messages/${IDS.coachA}`, { content: 'Resposta', category: 'workout_feedback', refId: 'workout_1' });
  assert.equal(reply.status, 201);
  const third = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/messages`, message('Terceira'));
  assert.equal(third.status, 201);

  assert.deepEqual((await request(server, IDS.coachA, 'POST', `/api/messages/${first.body.message.id}/read`)).body.code, 'recipient_required');
  const strangerRead = await request(server, IDS.athleteB, 'POST', `/api/messages/${first.body.message.id}/read`);
  assert.deepEqual([strangerRead.status, strangerRead.body.code], [404, 'message_not_found']);
  const read = await request(server, IDS.athleteA, 'POST', `/api/messages/${first.body.message.id}/read`);
  assert.equal(read.status, 200);
  assert.ok(Number.isFinite(read.body.message.readAt));
  assert.equal((await request(server, IDS.coachA, 'POST', `/api/messages/${reply.body.message.id}/read`)).status, 200);

  const seen = [];
  let cursor = '';
  do {
    const page = await request(server, IDS.athleteA, 'GET', `/api/athlete/messages/${IDS.coachA}?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    assert.equal(page.status, 200);
    seen.push(...page.body.messages.map(item => item.id));
    cursor = page.body.page.nextCursor;
  } while (cursor);
  assert.equal(seen.length, 3);
  assert.equal(new Set(seen).size, 3);

  const otherCoach = await request(server, IDS.coachB, 'POST', `/api/coach/athletes/${IDS.athleteA}/messages`, message('Somente B'));
  assert.equal(otherCoach.status, 201);
  const coachAView = await request(server, IDS.coachA, 'GET', `/api/coach/athletes/${IDS.athleteA}/messages`);
  assert.equal(coachAView.body.messages.some(item => item.id === otherCoach.body.message.id), false);
  assert.equal((await request(server, IDS.athleteB, 'GET', `/api/athlete/messages/${IDS.coachB}`)).body.relationship.readOnly, true);
  assert.deepEqual([(await request(server, IDS.coachB, 'POST', `/api/coach/athletes/${IDS.athleteB}/messages`, message('blocked'))).status,
    (await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteB}/messages`, message('blocked'))).status], [403, 403]);

  const beforeFailure = fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8');
  fs.writeFileSync(path.join(dataDir, 'fail-db-write'), 'once');
  const failed = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/messages`, message('must roll back'));
  assert.deepEqual([failed.status, failed.body.code], [503, 'storage_unavailable']);
  assert.equal(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'), beforeFailure);
  assert.equal((await request(server, IDS.coachA, 'GET', `/api/coach/athletes/${IDS.athleteA}/messages`)).body.messages.length, 3);

  await stop(server);
  server = await launch(dataDir);
  const restarted = await request(server, IDS.athleteA, 'GET', `/api/athlete/messages/${IDS.coachA}`);
  assert.equal(restarted.body.messages.length, 3);
  assert.ok(restarted.body.messages.find(item => item.id === first.body.message.id).readAt);
});

test('habit lifecycle, idempotent check-in, validation, anti-IDOR and cascade are atomic', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-habits-'));
  seed(dataDir);
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const server = await launch(dataDir);
  t.after(async () => stop(server));

  assert.equal((await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/habits`, { ...habit('bad'), targetValue: -1 })).status, 400);
  const daily = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/habits`, habit('Sono'));
  const weekday = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/habits`, habit('Semana', 'weekdays'));
  const weekend = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/habits`, habit('Fim de semana', 'weekends'));
  assert.deepEqual([daily.status, weekday.status, weekend.status], [201, 201, 201]);
  assert.equal(daily.body.habit.description, '<b>texto literal</b>');

  const updated = await request(server, IDS.coachA, 'PATCH', `/api/coach/athletes/${IDS.athleteA}/habits/${daily.body.habit.id}`, { title: 'Sono reparador', targetValue: 7.5 });
  assert.deepEqual([updated.status, updated.body.habit.title, updated.body.habit.targetValue], [200, 'Sono reparador', 7.5]);
  const archived = await request(server, IDS.coachA, 'PATCH', `/api/coach/athletes/${IDS.athleteA}/habits/${weekend.body.habit.id}`, { status: 'archived' });
  assert.equal(archived.body.habit.status, 'archived');
  assert.ok(archived.body.habit.archivedAt);
  const reactivated = await request(server, IDS.coachA, 'PATCH', `/api/coach/athletes/${IDS.athleteA}/habits/${weekend.body.habit.id}`, { status: 'active' });
  assert.deepEqual([reactivated.body.habit.status, reactivated.body.habit.archivedAt], ['active', null]);

  const today = new Date().toISOString().slice(0, 10);
  const future = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  assert.deepEqual([(await request(server, IDS.athleteA, 'POST', '/api/athlete/habits/checkin', { habitId: daily.body.habit.id, date: future, value: 8, completed: true, notes: '' })).status,
    (await request(server, IDS.athleteA, 'POST', '/api/athlete/habits/checkin', { habitId: daily.body.habit.id, date: today, value: -1, completed: true, notes: '' })).status,
    (await request(server, IDS.athleteA, 'POST', '/api/athlete/habits/checkin', { habitId: daily.body.habit.id, date: '2026-99-99', value: 8, completed: true, notes: '' })).status], [400, 400, 400]);
  const first = await request(server, IDS.athleteA, 'POST', '/api/athlete/habits/checkin', { habitId: daily.body.habit.id, date: today, value: 7, completed: false, notes: 'primeiro' });
  const second = await request(server, IDS.athleteA, 'POST', '/api/athlete/habits/checkin', { habitId: daily.body.habit.id, date: today, value: 8, completed: true, notes: 'atualizado' });
  assert.deepEqual([first.status, second.status, first.body.checkin.id === second.body.checkin.id, second.body.checkin.notes], [201, 200, true, 'atualizado']);
  const athleteHabits = await request(server, IDS.athleteA, 'GET', '/api/athlete/habits');
  assert.equal(athleteHabits.status, 200);
  assert.equal(athleteHabits.body.habits.find(item => item.id === daily.body.habit.id).checkin.id, first.body.checkin.id);
  const endpointSummary = await request(server, IDS.coachA, 'GET', `/api/coach/athletes/${IDS.athleteA}/habits-summary`);
  assert.equal(endpointSummary.status, 200);
  assert.equal(endpointSummary.body.summary.habits.find(item => item.habitId === daily.body.habit.id).completedDays, 1);

  const day = new Date(`${today}T00:00:00.000Z`).getUTCDay();
  const offSchedule = day === 0 || day === 6 ? weekday.body.habit.id : weekend.body.habit.id;
  assert.deepEqual([(await request(server, IDS.athleteA, 'POST', '/api/athlete/habits/checkin', { habitId: offSchedule, date: today, value: 8, completed: true, notes: '' })).status,
    (await request(server, IDS.athleteB, 'POST', '/api/athlete/habits/checkin', { habitId: daily.body.habit.id, date: today, value: 8, completed: true, notes: '' })).status], [400, 404]);
  assert.equal((await request(server, IDS.coachB, 'PATCH', `/api/coach/athletes/${IDS.athleteA}/habits/${daily.body.habit.id}`, { title: 'IDOR' })).status, 404);
  assert.equal((await request(server, IDS.coachB, 'POST', `/api/coach/athletes/${IDS.athleteB}/habits`, habit('blocked'))).status, 403);
  const historical = await request(server, IDS.coachA, 'GET', `/api/coach/athletes/${IDS.athleteB}/habits`);
  assert.deepEqual([historical.status, historical.body.relationship.readOnly], [200, true]);

  fs.writeFileSync(path.join(dataDir, 'fail-db-write'), 'once');
  const failedDelete = await request(server, IDS.coachA, 'DELETE', `/api/coach/athletes/${IDS.athleteA}/habits/${daily.body.habit.id}`);
  assert.deepEqual([failedDelete.status, failedDelete.body.code], [503, 'storage_unavailable']);
  let stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
  assert.ok(stored.coachHabits.some(item => item.id === daily.body.habit.id));
  assert.ok(stored.habitCheckins.some(item => item.habitId === daily.body.habit.id));
  const deleted = await request(server, IDS.coachA, 'DELETE', `/api/coach/athletes/${IDS.athleteA}/habits/${daily.body.habit.id}`);
  assert.equal(deleted.status, 200);
  stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
  assert.equal(stored.coachHabits.some(item => item.id === daily.body.habit.id), false);
  assert.equal(stored.habitCheckins.some(item => item.habitId === daily.body.habit.id), false);
});

test('daily, weekday and weekend summaries handle scheduled-day streak edges', () => {
  const createdAt = Date.parse('2026-10-01T00:00:00.000Z');
  const habits = [
    { id: 'hab_daily', title: 'Daily', frequency: 'daily', createdAt, archivedAt: null },
    { id: 'hab_weekdays', title: 'Weekdays', frequency: 'weekdays', createdAt, archivedAt: null },
    { id: 'hab_weekends', title: 'Weekends', frequency: 'weekends', createdAt, archivedAt: null },
  ];
  const row = (habitId, date, completed = true) => ({ habitId, date, completed });
  const summary = habitSummary(habits, [
    row('hab_daily', '2026-11-06'), row('hab_daily', '2026-11-07'), row('hab_daily', '2026-11-08'),
    row('hab_weekdays', '2026-11-04', false), row('hab_weekdays', '2026-11-05'), row('hab_weekdays', '2026-11-06'),
    row('hab_weekends', '2026-11-07'), row('hab_weekends', '2026-11-08'),
  ], '2026-11-08');
  const byId = Object.fromEntries(summary.habits.map(item => [item.habitId, item]));
  assert.deepEqual([byId.hab_daily.currentStreak, byId.hab_daily.longestStreak], [3, 3]);
  assert.deepEqual([byId.hab_weekdays.currentStreak, byId.hab_weekdays.longestStreak], [2, 2]);
  assert.deepEqual([byId.hab_weekends.currentStreak, byId.hab_weekends.longestStreak], [2, 2]);
  assert.equal(byId.hab_weekdays.scheduledDays, 20);
  assert.equal(byId.hab_weekends.scheduledDays, 10);
});

test('message and check-in rate limits, quotas and deterministic retention are enforced', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-communication-limits-'));
  const old = Date.now() - 10 * 86400000;
  const oldHabit = { id: 'hab_old', linkId: 'cal_comm_aa', coachId: IDS.coachA, athleteId: IDS.athleteA, title: 'Old', description: '', targetValue: 1,
    unit: 'vezes', frequency: 'daily', status: 'active', createdAt: old, updatedAt: old, archivedAt: null };
  seed(dataDir, baseDb({
    coachMessages: [{ id: 'cmsg_old', linkId: 'cal_comm_aa', senderId: IDS.coachA, recipientId: IDS.athleteA, content: 'old', category: 'general', refId: null, createdAt: old, readAt: null }],
    coachHabits: [oldHabit],
    habitCheckins: [{ id: 'hchk_old', linkId: 'cal_comm_aa', athleteId: IDS.athleteA, habitId: oldHabit.id, date: daysAgo(10), value: 1, completed: true, notes: '', updatedAt: old }],
  }));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const server = await launch(dataDir, {
    B2B2C_RATE_WINDOW_MS: '1000', B2B2C_MESSAGE_MUTATION_ACCOUNT_MAX: '2', B2B2C_MESSAGE_MUTATION_IP_MAX: '20',
    B2B2C_HABIT_CHECKIN_ACCOUNT_MAX: '2', B2B2C_HABIT_CHECKIN_IP_MAX: '20',
    B2B2C_MESSAGES_PER_LINK: '3', B2B2C_HABITS_PER_LINK: '2', B2B2C_MESSAGE_RETENTION_DAYS: '1', B2B2C_CHECKIN_RETENTION_DAYS: '1',
  });
  t.after(async () => stop(server));
  let stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
  assert.deepEqual([stored.coachMessages.length, stored.habitCheckins.length], [0, 0]);

  assert.equal((await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/messages`, message('one'))).status, 201);
  assert.equal((await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/messages`, message('two'))).status, 201);
  const limited = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/messages`, message('three'));
  assert.deepEqual([limited.status, limited.body.code], [429, 'rate_limited']);
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal((await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/messages`, message('three'))).status, 201);
  const atCapacity = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/messages`, message('four'));
  assert.deepEqual([atCapacity.status, atCapacity.body.code], [409, 'message_capacity']);

  const extraHabit = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/habits`, habit('Second'));
  assert.equal(extraHabit.status, 201);
  const habitAtCapacity = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/habits`, habit('Third'));
  assert.deepEqual([habitAtCapacity.status, habitAtCapacity.body.code], [409, 'habit_capacity']);

  const today = new Date().toISOString().slice(0, 10);
  assert.equal((await request(server, IDS.athleteA, 'POST', '/api/athlete/habits/checkin', { habitId: oldHabit.id, date: today, value: 1, completed: true, notes: '' })).status, 201);
  assert.equal((await request(server, IDS.athleteA, 'POST', '/api/athlete/habits/checkin', { habitId: oldHabit.id, date: today, value: 2, completed: true, notes: '' })).status, 200);
  const checkinLimited = await request(server, IDS.athleteA, 'POST', '/api/athlete/habits/checkin', { habitId: oldHabit.id, date: today, value: 3, completed: true, notes: '' });
  assert.deepEqual([checkinLimited.status, checkinLimited.body.code], [429, 'rate_limited']);
  const audit = fs.readFileSync(path.join(dataDir, 'audit.log'), 'utf8');
  assert.match(audit, /b2b2c\.message\.throttled/);
  assert.match(audit, /b2b2c\.checkin\.throttled/);
});

test('operation scopes enforce training, nutrition, both, no-scope and cross-account isolation', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-communication-scopes-'));
  const db = baseDb();
  db.users.push(
    { id: 'u_comm_coach_both', name: 'Coach Both', profile: { kind: 'coach', coachSpecialties: ['training', 'nutrition'] } },
    { id: 'u_comm_coach_none', name: 'Coach None', profile: { kind: 'coach', coachSpecialties: ['assessments'] } },
  );
  db.coachAthleteLinks.push(
    { id: 'cal_comm_both', coachId: 'u_comm_coach_both', athleteId: IDS.athleteB, scopes: ['training', 'nutrition'], status: 'active', createdAt: '2026-02-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z' },
    { id: 'cal_comm_none', coachId: 'u_comm_coach_none', athleteId: IDS.athleteB, scopes: [], status: 'active', createdAt: '2026-02-02T00:00:00.000Z', updatedAt: '2026-02-02T00:00:00.000Z' },
  );
  db.coachHabits.push({ id: 'hab_nutrition_scope', linkId: 'cal_comm_ba', coachId: IDS.coachB, athleteId: IDS.athleteA,
    title: 'Invalid legacy scope', description: '', targetValue: 1, unit: 'vezes', frequency: 'daily', status: 'active',
    createdAt: Date.now() - 86400000, updatedAt: Date.now() - 86400000, archivedAt: null });
  seed(dataDir, db);
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const server = await launch(dataDir);
  t.after(async () => stop(server));

  assert.equal((await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/messages`, { content: 'treino', category: 'workout_feedback', refId: null })).status, 201);
  assert.deepEqual([(await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/messages`, { content: 'nutri', category: 'nutrition_feedback', refId: null })).status,
    (await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/messages`, message('geral'))).status], [403, 201]);
  const nutrition = await request(server, IDS.coachB, 'POST', `/api/coach/athletes/${IDS.athleteA}/messages`, { content: 'nutri', category: 'nutrition_feedback', refId: null });
  const nutritionWorkout = await request(server, IDS.coachB, 'POST', `/api/coach/athletes/${IDS.athleteA}/messages`, { content: 'treino', category: 'workout_feedback', refId: null });
  const nutritionHabit = await request(server, IDS.coachB, 'POST', `/api/coach/athletes/${IDS.athleteA}/habits`, habit('Sem treinamento'));
  assert.deepEqual([nutrition.status, nutritionWorkout.body.code, nutritionHabit.body.code], [201, 'scope_forbidden', 'scope_forbidden']);
  assert.equal((await request(server, 'u_comm_coach_both', 'POST', `/api/coach/athletes/${IDS.athleteB}/messages`, { content: 'ambos', category: 'nutrition_feedback', refId: null })).status, 201);
  assert.equal((await request(server, 'u_comm_coach_both', 'POST', `/api/coach/athletes/${IDS.athleteB}/habits`, habit('Ambos'))).status, 201);
  const none = await request(server, 'u_comm_coach_none', 'POST', `/api/coach/athletes/${IDS.athleteB}/messages`, message('sem escopo'));
  assert.deepEqual([none.status, none.body.code, Object.hasOwn(none.body, 'link')], [403, 'scope_forbidden', false]);
  assert.equal((await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/habits`, habit('Treino'))).status, 201);
  const scopedCheckin = await request(server, IDS.athleteA, 'POST', '/api/athlete/habits/checkin', {
    habitId: 'hab_nutrition_scope', date: daysAgo(0), value: 1, completed: true, notes: '',
  });
  assert.deepEqual([scopedCheckin.status, scopedCheckin.body.code], [403, 'scope_forbidden']);
  assert.equal((await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteB}/messages`, message('encerrado'))).body.code, 'relationship_inactive');
  assert.equal((await request(server, IDS.athleteB, 'GET', `/api/athlete/messages/${IDS.coachA}?linkId=cal_comm_aa`)).status, 404);
});

test('historical link selection survives re-contracting and rejects another pair link id', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-communication-recontract-'));
  const now = Date.now();
  const oldEndedAt = new Date(now - 120 * 86400000).toISOString();
  const oldLink = { id: 'cal_old_contract', coachId: IDS.coachA, athleteId: IDS.athleteA, scopes: ['training'], status: 'ended',
    createdAt: '2025-01-01T00:00:00.000Z', updatedAt: oldEndedAt, endedAt: oldEndedAt };
  const db = baseDb();
  db.coachAthleteLinks.unshift(oldLink);
  const oldDate = new Date(now - 100 * 86400000).toISOString().slice(0, 10);
  db.coachMessages.push({ id: 'cmsg_old_contract', linkId: oldLink.id, senderId: IDS.coachA, recipientId: IDS.athleteA,
    content: 'histórico antigo', category: 'general', refId: null, createdAt: now - 100 * 86400000, readAt: null });
  db.coachHabits.push({ id: 'hab_old_contract', linkId: oldLink.id, coachId: IDS.coachA, athleteId: IDS.athleteA,
    title: 'Hábito antigo', description: '', targetValue: 1, unit: 'vezes', frequency: 'daily', status: 'active',
    createdAt: now - 200 * 86400000, updatedAt: now - 100 * 86400000, archivedAt: null });
  db.habitCheckins.push({ id: 'hchk_old_contract', linkId: oldLink.id, athleteId: IDS.athleteA, habitId: 'hab_old_contract',
    date: oldDate, value: 1, completed: true, notes: 'histórico', updatedAt: now - 100 * 86400000 });
  seed(dataDir, db);
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const server = await launch(dataDir);
  t.after(async () => stop(server));

  const current = await request(server, IDS.coachA, 'GET', `/api/coach/athletes/${IDS.athleteA}/messages`);
  const old = await request(server, IDS.coachA, 'GET', `/api/coach/athletes/${IDS.athleteA}/messages?linkId=${oldLink.id}`);
  assert.deepEqual([current.body.relationship.linkId, current.body.messages.length, old.body.relationship.readOnly, old.body.messages[0].content],
    ['cal_comm_aa', 0, true, 'histórico antigo']);
  const oldHabits = await request(server, IDS.coachA, 'GET', `/api/coach/athletes/${IDS.athleteA}/habits?linkId=${oldLink.id}`);
  const oldCheckins = await request(server, IDS.coachA, 'GET', `/api/coach/athletes/${IDS.athleteA}/checkins?linkId=${oldLink.id}&from=${oldDate}&to=${oldDate}`);
  assert.deepEqual([oldHabits.body.habits[0].title, oldCheckins.body.checkins[0].notes], ['Hábito antigo', 'histórico']);
  assert.equal((await request(server, IDS.coachA, 'GET', `/api/coach/athletes/${IDS.athleteA}/messages?linkId=cal_comm_ab`)).status, 404);
  const sent = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/messages?linkId=${oldLink.id}`, message('vai no ativo'));
  assert.equal(sent.body.message.linkId, 'cal_comm_aa');
});

test('retention preserves minimal relationship tombstones while dependent history remains', () => {
  const now = Date.parse('2026-11-07T12:00:00.000Z');
  const endedAt = new Date(now - 100 * 86400000).toISOString();
  const link = { id: 'cal_retained', coachId: 'coach', athleteId: 'athlete', scopes: ['training'], status: 'ended',
    createdAt: '2025-01-01T00:00:00.000Z', updatedAt: endedAt, endedAt, endedBy: 'coach', inviteToken: 'must-not-survive' };
  const habitAt = now - 100 * 86400000;
  const db = {
    coachInvites: [], coachAthleteLinks: [link], coachPrescriptions: [], coachAssessments: [], mealPlans: [], mealAdherence: [],
    coachMessages: [{ id: 'cmsg_retained', linkId: link.id, senderId: 'coach', recipientId: 'athlete', content: 'retained', category: 'general', refId: null, createdAt: habitAt, readAt: null }],
    coachHabits: [{ id: 'hab_retained', linkId: link.id, coachId: 'coach', athleteId: 'athlete', title: 'Retained', description: '', targetValue: 1,
      unit: 'vezes', frequency: 'daily', status: 'archived', createdAt: habitAt, updatedAt: habitAt, archivedAt: habitAt }],
    habitCheckins: [{ id: 'hchk_retained', linkId: link.id, athleteId: 'athlete', habitId: 'hab_retained', date: dayStringForTest(habitAt), value: 1, completed: true, notes: '', updatedAt: habitAt }],
  };
  compactB2B2C(db, { maxLinks: 10, maxInvites: 10, terminalLinksKeep: 0, terminalInvitesKeep: 0, terminalPrescriptionsKeep: 0,
    terminalRetentionDays: 90, maxPrescriptions: 10, messageRetentionDays: 365, archivedHabitRetentionDays: 730, checkinRetentionDays: 730,
    maxMessagesPerLink: 500, maxMessages: 50000, maxHabitsPerLink: 100, maxHabits: 10000, maxCheckinsPerHabit: 730,
    maxCheckinsPerLink: 5000, maxCheckins: 100000, assessmentRetentionDays: 3650, mealAdherenceRetentionDays: 730 }, now);
  assert.deepEqual(Object.keys(db.coachAthleteLinks[0]).sort(), ['athleteId', 'coachId', 'createdAt', 'endedAt', 'id', 'scopes', 'status', 'tombstone', 'updatedAt']);
  assert.deepEqual([db.coachMessages.length, db.coachHabits.length, db.habitCheckins.length], [1, 1, 1]);
  assert.equal(db.coachAthleteLinks[0].inviteToken, undefined);

  compactB2B2C(db, { maxLinks: 10, maxInvites: 10, terminalLinksKeep: 0, terminalInvitesKeep: 0, terminalPrescriptionsKeep: 0,
    terminalRetentionDays: 90, maxPrescriptions: 10, messageRetentionDays: 365, archivedHabitRetentionDays: 730, checkinRetentionDays: 730,
    maxMessagesPerLink: 500, maxMessages: 50000, maxHabitsPerLink: 100, maxHabits: 10000, maxCheckinsPerHabit: 730,
    maxCheckinsPerLink: 5000, maxCheckins: 100000, assessmentRetentionDays: 3650, mealAdherenceRetentionDays: 730 }, now + 264 * 86400000);
  assert.deepEqual([db.coachMessages.length, db.coachHabits.length, db.habitCheckins.length], [1, 1, 1], '365/730-day data remains before cutoff');
  compactB2B2C(db, { maxLinks: 10, maxInvites: 10, terminalLinksKeep: 0, terminalInvitesKeep: 0, terminalPrescriptionsKeep: 0,
    terminalRetentionDays: 90, maxPrescriptions: 10, messageRetentionDays: 365, archivedHabitRetentionDays: 730, checkinRetentionDays: 730,
    maxMessagesPerLink: 500, maxMessages: 50000, maxHabitsPerLink: 100, maxHabits: 10000, maxCheckinsPerHabit: 730,
    maxCheckinsPerLink: 5000, maxCheckins: 100000, assessmentRetentionDays: 3650, mealAdherenceRetentionDays: 730 }, now + 266 * 86400000);
  assert.deepEqual([db.coachMessages.length, db.coachHabits.length, db.habitCheckins.length], [0, 1, 1], 'messages expire at 365 while habits remain');
  compactB2B2C(db, { maxLinks: 10, maxInvites: 10, terminalLinksKeep: 0, terminalInvitesKeep: 0, terminalPrescriptionsKeep: 0,
    terminalRetentionDays: 90, maxPrescriptions: 10, messageRetentionDays: 365, archivedHabitRetentionDays: 730, checkinRetentionDays: 730,
    maxMessagesPerLink: 500, maxMessages: 50000, maxHabitsPerLink: 100, maxHabits: 10000, maxCheckinsPerHabit: 730,
    maxCheckinsPerLink: 5000, maxCheckins: 100000, assessmentRetentionDays: 3650, mealAdherenceRetentionDays: 730 }, now + 631 * 86400000);
  assert.deepEqual([db.coachMessages.length, db.coachHabits.length, db.habitCheckins.length], [0, 0, 0], 'habits and check-ins expire after 730 days');
});

test('check-in history, athlete summary, timezone validation and stable pagination are complete', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-checkin-history-'));
  const now = Date.now();
  const dates = [daysAgo(0), daysAgo(1), daysAgo(2)];
  const seededHabit = { id: 'hab_history', linkId: 'cal_comm_aa', coachId: IDS.coachA, athleteId: IDS.athleteA, title: 'History', description: '',
    targetValue: 1, unit: 'vezes', frequency: 'daily', status: 'active', createdAt: now - 10 * 86400000, updatedAt: now, archivedAt: null };
  const checkins = dates.map((date, index) => ({ id: `hchk_history_${index}`, linkId: 'cal_comm_aa', athleteId: IDS.athleteA,
    habitId: seededHabit.id, date, value: index + 1, completed: index !== 1, notes: `n${index}`, updatedAt: now - index }));
  seed(dataDir, baseDb({ coachHabits: [seededHabit], habitCheckins: checkins }));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const server = await launch(dataDir);
  t.after(async () => stop(server));

  const first = await request(server, IDS.coachA, 'GET', `/api/coach/athletes/${IDS.athleteA}/checkins?period=7&limit=1&timezone=America%2FSao_Paulo`);
  assert.deepEqual([first.status, first.body.checkins.length, first.body.checkins[0].notes, first.body.period.timezone, first.body.page.hasMore],
    [200, 1, 'n0', 'America/Sao_Paulo', true]);
  const second = await request(server, IDS.coachA, 'GET', `/api/coach/athletes/${IDS.athleteA}/checkins?period=7&limit=1&timezone=America%2FSao_Paulo&cursor=${encodeURIComponent(first.body.page.nextCursor)}`);
  assert.equal(second.body.checkins[0].id, 'hchk_history_1');
  const athlete = await request(server, IDS.athleteA, 'GET', `/api/athlete/checkins?linkId=cal_comm_aa&period=30&timezone=Asia%2FTokyo`);
  assert.deepEqual([athlete.status, athlete.body.checkins.length], [200, 3]);
  const ownSummary = await request(server, IDS.athleteA, 'GET', `/api/athlete/habits-summary?linkId=cal_comm_aa&period=7&timezone=Asia%2FTokyo`);
  assert.equal(ownSummary.body.summary.habits[0].longestStreakInPeriod, 1);
  assert.deepEqual([(await request(server, IDS.athleteB, 'GET', `/api/athlete/checkins?linkId=cal_comm_aa&period=7`)).status,
    (await request(server, IDS.coachA, 'GET', `/api/coach/athletes/${IDS.athleteA}/checkins?period=8`)).body.code,
    (await request(server, IDS.coachA, 'GET', `/api/coach/athletes/${IDS.athleteA}/checkins?period=7&limit=0`)).body.code,
    (await request(server, IDS.coachA, 'GET', `/api/coach/athletes/${IDS.athleteA}/checkins?period=7&cursor=bad`)).body.code,
    (await request(server, IDS.coachA, 'GET', `/api/coach/athletes/${IDS.athleteA}/checkins?period=7&timezone=Moon%2FBase`)).body.code],
  [404, 'invalid_period', 'invalid_pagination', 'invalid_pagination', 'invalid_timezone']);
  const anonymous = await fetch(`${server.api}/api/messages/inbox`);
  assert.equal(anonymous.status, 401);
  assert.equal((await request(server, IDS.coachA, 'GET', `/api/athlete/checkins?linkId=cal_comm_aa&period=7`)).body.code, 'role_forbidden');
  assert.equal((await request(server, IDS.athleteA, 'GET', `/api/coach/athletes/${IDS.athleteA}/checkins?period=7`)).body.code, 'role_forbidden');
});

test('timezone day boundaries and pending-today streak behavior are deterministic', () => {
  const instant = Date.parse('2026-11-07T02:30:00.000Z');
  assert.deepEqual([dateInTimeZone(instant, 'America/Sao_Paulo'), dateInTimeZone(instant, 'Asia/Tokyo')], ['2026-11-06', '2026-11-07']);
  const createdAt = Date.parse('2026-10-01T00:00:00.000Z');
  for (const [frequency, today, previous] of [
    ['daily', '2026-11-07', '2026-11-06'],
    ['weekdays', '2026-11-06', '2026-11-05'],
    ['weekends', '2026-11-08', '2026-11-07'],
  ]) {
    const habitRow = { id: `hab_${frequency}`, title: frequency, frequency, createdAt, archivedAt: null };
    assert.equal(habitSummary([habitRow], [{ habitId: habitRow.id, date: previous, completed: true }], today, 7).habits[0].currentStreak, 1);
    assert.equal(habitSummary([habitRow], [{ habitId: habitRow.id, date: previous, completed: true },
      { habitId: habitRow.id, date: today, completed: false }], today, 7).habits[0].currentStreak, 0);
  }
  const missed = { id: 'hab_missed', title: 'missed', frequency: 'daily', createdAt, archivedAt: null };
  assert.equal(habitSummary([missed], [{ habitId: missed.id, date: '2026-11-05', completed: true }], '2026-11-07', 7).habits[0].currentStreak, 0);
  assert.throws(() => validateCommunicationHabitsLimits({ archivedHabitRetentionDays: 365, checkinRetentionDays: 730 }),
    /archived habit retention/);
});

test('check-in limits apply per relationship and globally', async t => {
  const firstDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-checkin-link-limit-'));
  const now = Date.now();
  const habits = ['one', 'two'].map((suffix, index) => ({ id: `hab_limit_${suffix}`, linkId: 'cal_comm_aa', coachId: IDS.coachA,
    athleteId: IDS.athleteA, title: suffix, description: '', targetValue: 1, unit: 'vezes', frequency: 'daily', status: 'active',
    createdAt: now - 86400000, updatedAt: now - index, archivedAt: null }));
  seed(firstDir, baseDb({ coachHabits: habits }));
  t.after(() => fs.rmSync(firstDir, { recursive: true, force: true }));
  let server = await launch(firstDir, { B2B2C_CHECKINS_PER_LINK: '1', B2B2C_MAX_CHECKINS: '10' });
  assert.equal((await request(server, IDS.athleteA, 'POST', '/api/athlete/habits/checkin', {
    habitId: habits[0].id, date: daysAgo(0), value: 1, completed: true, notes: '',
  })).status, 201);
  assert.equal((await request(server, IDS.athleteA, 'POST', '/api/athlete/habits/checkin', {
    habitId: habits[1].id, date: daysAgo(0), value: 1, completed: true, notes: '',
  })).body.code, 'checkin_capacity');
  await stop(server);

  const secondDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-checkin-global-limit-'));
  const db = baseDb({ coachHabits: [habits[0]] });
  db.users.push({ id: 'u_limit_coach', name: 'Limit Coach', profile: { kind: 'coach', coachSpecialties: ['training'] } });
  db.coachAthleteLinks.push({ id: 'cal_limit_other', coachId: 'u_limit_coach', athleteId: IDS.athleteB, scopes: ['training'], status: 'active',
    createdAt: '2026-01-04T00:00:00.000Z', updatedAt: '2026-01-04T00:00:00.000Z' });
  db.coachHabits.push({ ...habits[1], id: 'hab_limit_other', linkId: 'cal_limit_other', coachId: 'u_limit_coach', athleteId: IDS.athleteB });
  seed(secondDir, db);
  t.after(() => fs.rmSync(secondDir, { recursive: true, force: true }));
  server = await launch(secondDir, { B2B2C_CHECKINS_PER_LINK: '10', B2B2C_MAX_CHECKINS: '1' });
  t.after(async () => stop(server));
  assert.equal((await request(server, IDS.athleteA, 'POST', '/api/athlete/habits/checkin', {
    habitId: habits[0].id, date: daysAgo(0), value: 1, completed: true, notes: '',
  })).status, 201);
  assert.equal((await request(server, IDS.athleteB, 'POST', '/api/athlete/habits/checkin', {
    habitId: 'hab_limit_other', date: daysAgo(0), value: 1, completed: true, notes: '',
  })).body.code, 'checkin_capacity');
});

test('inbox and read-through are participant-only, historical, idempotent and rate-limited', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-inbox-read-'));
  const now = Date.now();
  const messages = [
    { id: 'cmsg_read_1', linkId: 'cal_comm_ab', senderId: IDS.coachA, recipientId: IDS.athleteB, content: 'one', category: 'general', refId: null, createdAt: now - 2, readAt: null },
    { id: 'cmsg_read_2', linkId: 'cal_comm_ab', senderId: IDS.coachA, recipientId: IDS.athleteB, content: 'two', category: 'general', refId: null, createdAt: now - 1, readAt: null },
  ];
  seed(dataDir, baseDb({ coachMessages: messages }));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const server = await launch(dataDir, { B2B2C_MESSAGE_READ_ACCOUNT_MAX: '1', B2B2C_MESSAGE_READ_IP_MAX: '20', B2B2C_RATE_WINDOW_MS: '60000' });
  t.after(async () => stop(server));

  const inbox = await request(server, IDS.athleteB, 'GET', '/api/messages/inbox?limit=10');
  assert.deepEqual([inbox.body.conversations[0].linkId, inbox.body.conversations[0].unreadCount,
    inbox.body.conversations[0].lastMessage.content, inbox.body.conversations[0].status], ['cal_comm_ab', 2, 'two', 'ended']);
  const bulk = await request(server, IDS.athleteB, 'POST', '/api/messages/read-through', { linkId: 'cal_comm_ab', throughMessageId: 'cmsg_read_1' });
  assert.deepEqual([bulk.status, bulk.body.readCount], [200, 1]);
  const repeat = await request(server, IDS.athleteB, 'POST', '/api/messages/read-through', { linkId: 'cal_comm_ab', throughMessageId: 'cmsg_read_1' });
  assert.deepEqual([repeat.status, repeat.body.readCount], [200, 0]);
  const limited = await request(server, IDS.athleteB, 'POST', '/api/messages/cmsg_read_2/read');
  assert.deepEqual([limited.status, limited.body.code, Number(limited.headers.get('retry-after')) > 0], [429, 'rate_limited', true]);
  assert.equal((await request(server, IDS.coachA, 'POST', '/api/messages/read-through', { linkId: 'cal_comm_ab', throughMessageId: 'cmsg_read_2' })).body.code, 'recipient_required');
  assert.equal((await request(server, IDS.athleteA, 'POST', '/api/messages/read-through', { linkId: 'cal_comm_ab', throughMessageId: 'cmsg_read_2' })).status, 404);
});

test('habit mutations are separately rate-limited while no-op updates avoid writes', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-habit-rate-'));
  seed(dataDir);
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const server = await launch(dataDir, { B2B2C_HABIT_MUTATION_ACCOUNT_MAX: '1', B2B2C_HABIT_MUTATION_IP_MAX: '20', B2B2C_RATE_WINDOW_MS: '60000' });
  t.after(async () => stop(server));
  const created = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/habits`, habit('Rate'));
  assert.equal(created.status, 201);
  const before = fs.statSync(path.join(dataDir, 'db.json')).mtimeMs;
  const noop = await request(server, IDS.coachA, 'PATCH', `/api/coach/athletes/${IDS.athleteA}/habits/${created.body.habit.id}`, { title: 'Rate' });
  assert.deepEqual([noop.status, fs.statSync(path.join(dataDir, 'db.json')).mtimeMs], [200, before]);
  const limited = await request(server, IDS.coachA, 'PATCH', `/api/coach/athletes/${IDS.athleteA}/habits/${created.body.habit.id}`, { title: 'Changed' });
  assert.deepEqual([limited.status, limited.body.code, Number(limited.headers.get('retry-after')) > 0], [429, 'rate_limited', true]);
});

test('relationship transition and backup failures are fail-closed across GET and restart', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-durable-transition-'));
  seed(dataDir);
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const failDb = path.join(dataDir, 'fail-db-write');
  const failBackup = path.join(dataDir, 'fail-db-backup');
  let server = await launch(dataDir, { B2B2C_DB_FAIL_FILE: failDb, B2B2C_DB_BACKUP_FAIL_FILE: failBackup });
  t.after(async () => stop(server));

  fs.writeFileSync(failDb, 'once');
  const failedTransition = await request(server, IDS.coachA, 'POST', '/api/coach/links/status', { linkId: 'cal_comm_aa', status: 'ended' });
  assert.deepEqual([failedTransition.status, failedTransition.body.code], [503, 'storage_unavailable']);
  const afterFailure = await request(server, IDS.coachA, 'GET', '/api/coach/athletes');
  assert.equal(afterFailure.body.links.find(item => item.id === 'cal_comm_aa').status, 'active');
  await stop(server);
  server = await launch(dataDir, { B2B2C_DB_FAIL_FILE: failDb, B2B2C_DB_BACKUP_FAIL_FILE: failBackup });
  assert.equal((await request(server, IDS.coachA, 'GET', '/api/coach/athletes')).body.links.find(item => item.id === 'cal_comm_aa').status, 'active');

  fs.writeFileSync(failBackup, 'once');
  const failedMessage = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/messages`, message('backup failure'));
  assert.deepEqual([failedMessage.status, failedMessage.body.code], [503, 'storage_unavailable']);
  await stop(server);
  server = await launch(dataDir, { B2B2C_DB_FAIL_FILE: failDb, B2B2C_DB_BACKUP_FAIL_FILE: failBackup });
  assert.equal((await request(server, IDS.coachA, 'GET', `/api/coach/athletes/${IDS.athleteA}/messages`)).body.messages.length, 0);
  const confirmed = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/messages`, message('confirmed'));
  assert.equal(confirmed.status, 201);
  await stop(server);
  fs.writeFileSync(path.join(dataDir, 'db.json'), '{broken');
  server = await launch(dataDir, { B2B2C_DB_FAIL_FILE: failDb, B2B2C_DB_BACKUP_FAIL_FILE: failBackup });
  assert.equal((await request(server, IDS.coachA, 'GET', `/api/coach/athletes/${IDS.athleteA}/messages`)).body.messages[0].content, 'confirmed');
});
