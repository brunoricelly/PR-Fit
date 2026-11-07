import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers.mjs';
import { habitSummary } from '../communication-habits.js';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'http://localhost:8080';
const SECRET = crypto.randomBytes(32).toString('hex');
const IDS = { coachA: 'u_comm_coach_a', coachB: 'u_comm_coach_b', athleteA: 'u_comm_athlete_a', athleteB: 'u_comm_athlete_b' };

function mintSession(uid) {
  const payload = `${uid}:${Date.now() + 86400000}:0:c`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}

const daysAgo = amount => new Date(Date.now() - amount * 86400000).toISOString().slice(0, 10);

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
  return { status: response.status, body: await response.json() };
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
