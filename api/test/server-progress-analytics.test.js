import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers.mjs';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'http://localhost:8080';
const SECRET = crypto.randomBytes(32).toString('hex');
const IDS = { coachA: 'u_coach_a', coachB: 'u_coach_b', athleteA: 'u_athlete_a', athleteB: 'u_athlete_b' };

function mintSession(uid) {
  const payload = `${uid}:${Date.now() + 86400000}:0:c`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}

function baseDb() {
  return {
    schemaVersion: 7,
    users: [
      { id: IDS.coachA, name: 'Coach A', profile: { kind: 'coach', coachSpecialties: ['training', 'nutrition', 'assessments'] } },
      { id: IDS.coachB, name: 'Coach B', profile: { kind: 'coach', coachSpecialties: ['training'] } },
      { id: IDS.athleteA, name: 'Athlete A' }, { id: IDS.athleteB, name: 'Athlete B' },
    ],
    creds: [], subs: [], invites: [], deviceLinks: [], coachInvites: [], coachPrescriptions: [], coachAssessments: [],
    mealPlans: [], mealAdherence: [], coachHabits: [], habitCheckins: [], progressGoals: [], progressReports: [],
    coachAthleteLinks: [
      { id: 'cal_old', coachId: IDS.coachA, athleteId: IDS.athleteA, scopes: ['training', 'nutrition', 'assessments'], status: 'ended', createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-09-30T23:00:00.000Z', endedAt: '2026-09-30T23:00:00.000Z' },
      { id: 'cal_new', coachId: IDS.coachA, athleteId: IDS.athleteA, scopes: ['training', 'nutrition', 'assessments'], status: 'active', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' },
      { id: 'cal_ba', coachId: IDS.coachB, athleteId: IDS.athleteA, scopes: ['training'], status: 'active', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' },
      { id: 'cal_ab', coachId: IDS.coachA, athleteId: IDS.athleteB, scopes: ['training'], status: 'active', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' },
    ],
    coachMessages: [{ id: 'cmsg_private', linkId: 'cal_new', senderId: IDS.coachA, recipientId: IDS.athleteA,
      content: 'PRIVATE_MESSAGE_MUST_NOT_LEAK', category: 'general', refId: null, createdAt: Date.parse('2026-11-06T10:00:00Z'), readAt: null }],
  };
}

function seed(dataDir) {
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify(baseDb(), null, 2));
  fs.writeFileSync(path.join(dataDir, `state-${IDS.athleteA}.json`), JSON.stringify({
    unit: 'kg', bodyweight: [{ d: '2026-09-15', w: 92 }, { d: '2026-11-02', w: 90 }, { d: '2026-11-07', w: 88 }],
    workouts: [
      { id: 'w_old', d: '2026-09-10', vol: 900 }, { id: 'w_new_1', d: '2026-11-02', vol: 1000 },
      { id: 'w_new_2', d: '2026-11-06', vol: 1200 },
    ],
  }, null, 2));
}

async function launch(dataDir, env = {}) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN, RP_ID: 'localhost', AUDIT_LOG: '1',
      B2B2C_DB_FAIL_FILE: path.join(dataDir, 'fail-db-write'),
      B2B2C_DB_BACKUP_FAIL_FILE: path.join(dataDir, 'fail-db-backup'),
      ...env,
    },
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
  const text = await response.text();
  const contentType = response.headers.get('content-type') || '';
  return { status: response.status, headers: response.headers, text, body: text && contentType.includes('application/json') ? JSON.parse(text) : null };
}

const workoutGoal = {
  metric: 'workouts_per_week', direction: 'increase', baselineValue: 0, targetValue: 3, tolerance: 0,
  startDate: '2026-11-01', targetDate: '2026-12-31', timezone: 'America/Sao_Paulo',
};

test('progress goals and summaries are scoped to the exact relationship and lifecycle', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-progress-'));
  seed(dataDir);
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const server = await launch(dataDir);
  t.after(async () => stop(server));

  let response = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/progress-goals?linkId=cal_new`, workoutGoal);
  assert.equal(response.status, 201, response.text);
  const goalId = response.body.goal.id;
  assert.equal(response.body.goal.linkId, 'cal_new');

  response = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteB}/progress-goals?linkId=cal_ab`, {
    ...workoutGoal, metric: 'body_weight', direction: 'decrease', baselineValue: 90, targetValue: 85,
  });
  assert.deepEqual([response.status, response.body.code], [403, 'scope_forbidden']);

  response = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/progress-goals?linkId=cal_old`, workoutGoal);
  assert.deepEqual([response.status, response.body.code], [403, 'relationship_inactive']);
  response = await request(server, IDS.coachB, 'PATCH', `/api/coach/athletes/${IDS.athleteA}/progress-goals/${goalId}?linkId=cal_ba`, { targetValue: 4 });
  assert.deepEqual([response.status, response.body.code], [404, 'goal_not_found']);

  response = await request(server, IDS.athleteA, 'GET', '/api/athlete/progress-goals');
  assert.deepEqual([response.status, response.body.code], [400, 'link_id_required']);
  response = await request(server, IDS.athleteA, 'GET', '/api/athlete/progress-goals?linkId=cal_new');
  assert.equal(response.status, 200, response.text);
  assert.deepEqual(response.body.goals.map(item => item.id), [goalId]);

  for (const [period, zone] of [[7, 'America/Sao_Paulo'], [30, 'Asia/Tokyo'], [90, 'Pacific/Kiritimati']]) {
    response = await request(server, IDS.coachA, 'GET', `/api/coach/athletes/${IDS.athleteA}/progress-summary?linkId=cal_new&period=${period}&timezone=${zone}&metrics=workouts_per_week`);
    assert.equal(response.status, 200, response.text);
    assert.equal(response.body.summary.period.preset, period);
    assert.equal(response.body.summary.timezone, zone);
  }
  response = await request(server, IDS.coachA, 'GET', `/api/coach/athletes/${IDS.athleteA}/progress-summary?linkId=cal_new&period=7&timezone=UTC&metrics=workouts_per_week,body_fat_percent`);
  assert.equal(response.body.summary.metrics.workouts_per_week.currentValue, 2);
  assert.deepEqual([response.body.summary.metrics.body_fat_percent.available, response.body.summary.metrics.body_fat_percent.currentValue], [false, null]);
  assert.equal(response.body.summary.goals[0].progress.percent, 66.7);

  response = await request(server, IDS.coachA, 'GET', `/api/coach/athletes/${IDS.athleteA}/progress-summary?linkId=cal_old&from=2026-09-01&to=2026-09-30&timezone=UTC&metrics=workouts_per_week`);
  assert.deepEqual([response.body.summary.relationship.linkId, response.body.summary.metrics.workouts_per_week.workoutsCompleted], ['cal_old', 1]);

  response = await request(server, IDS.coachA, 'PATCH', `/api/coach/athletes/${IDS.athleteA}/progress-goals/${goalId}?linkId=cal_new`, { targetValue: 2, status: 'achieved' });
  assert.deepEqual([response.status, response.body.goal.status, typeof response.body.goal.achievedAt], [200, 'achieved', 'string']);
  response = await request(server, IDS.coachA, 'DELETE', `/api/coach/athletes/${IDS.athleteA}/progress-goals/${goalId}?linkId=cal_new`);
  assert.deepEqual([response.status, response.body.goal.status, typeof response.body.goal.archivedAt], [200, 'archived', 'string']);
});

test('reports are immutable, export safely, revoke, and exclude private messages', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-progress-report-'));
  seed(dataDir);
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const server = await launch(dataDir);
  t.after(async () => stop(server));

  const created = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/progress-reports?linkId=cal_new`, {
    period: 7, timezone: 'UTC', metrics: ['workouts_per_week', 'body_weight', 'nutrition_adherence_percent'],
  });
  assert.equal(created.status, 201, created.text);
  const report = created.body.report;
  assert.equal(JSON.stringify(report).includes('PRIVATE_MESSAGE_MUST_NOT_LEAK'), false);
  const snapshot = structuredClone(report.snapshot);

  fs.writeFileSync(path.join(dataDir, `state-${IDS.athleteA}.json`), JSON.stringify({ unit: 'kg', bodyweight: [{ d: '2026-11-07', w: 70 }], workouts: [] }));
  let response = await request(server, IDS.coachA, 'GET', `/api/coach/athletes/${IDS.athleteA}/progress-reports/${report.id}?linkId=cal_new`);
  assert.deepEqual(response.body.report.snapshot, snapshot);

  response = await request(server, IDS.coachA, 'GET', `/api/coach/athletes/${IDS.athleteA}/progress-reports/${report.id}?linkId=cal_new&format=json`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition'), /attachment/);
  assert.equal(response.text.includes('PRIVATE_MESSAGE_MUST_NOT_LEAK'), false);
  response = await request(server, IDS.coachA, 'GET', `/api/coach/athletes/${IDS.athleteA}/progress-reports/${report.id}?linkId=cal_new&format=csv`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/csv/);
  assert.match(response.text, /"workouts_per_week"/);

  response = await request(server, IDS.coachB, 'GET', `/api/coach/athletes/${IDS.athleteA}/progress-reports/${report.id}?linkId=cal_ba`);
  assert.deepEqual([response.status, response.body.code], [404, 'report_not_found']);
  response = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/progress-reports/${report.id}/revoke?linkId=cal_new`);
  assert.equal(typeof response.body.report.revokedAt, 'string');
  response = await request(server, IDS.coachA, 'GET', `/api/coach/athletes/${IDS.athleteA}/progress-reports/${report.id}?linkId=cal_new&format=json`);
  assert.deepEqual([response.status, response.body.code], [410, 'report_revoked']);

  const audit = fs.readFileSync(path.join(dataDir, 'audit.log'), 'utf8');
  assert.equal(audit.includes('PRIVATE_MESSAGE_MUST_NOT_LEAK'), false);
});

test('progress mutations enforce quotas, rate limits and durable rollback', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-progress-resilience-'));
  seed(dataDir);
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let server = await launch(dataDir, {
    B2B2C_PROGRESS_GOALS_PER_LINK: '1', B2B2C_PROGRESS_MUTATION_ACCOUNT_MAX: '2',
    B2B2C_PROGRESS_MUTATION_IP_MAX: '20', B2B2C_RATE_WINDOW_MS: '1000',
  });
  t.after(async () => stop(server));

  fs.writeFileSync(path.join(dataDir, 'fail-db-write'), 'once');
  let response = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/progress-goals?linkId=cal_new`, workoutGoal);
  assert.deepEqual([response.status, response.body.code], [503, 'storage_unavailable']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8')).progressGoals, []);
  assert.deepEqual((await request(server, IDS.coachA, 'GET', `/api/coach/athletes/${IDS.athleteA}/progress-goals?linkId=cal_new`)).body.goals, []);

  response = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/progress-goals?linkId=cal_new`, workoutGoal);
  assert.equal(response.status, 201, response.text);
  response = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/progress-goals?linkId=cal_new`, { ...workoutGoal, targetValue: 4 });
  assert.equal(response.status, 429);
  assert.ok(Number(response.headers.get('retry-after')) >= 1);
  await new Promise(resolve => setTimeout(resolve, 1100));
  response = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/progress-goals?linkId=cal_new`, { ...workoutGoal, targetValue: 4 });
  assert.deepEqual([response.status, response.body.code], [409, 'goal_capacity']);

  await stop(server);
  const storedBefore = fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8');
  server = await launch(dataDir, { B2B2C_PROGRESS_GOALS_PER_LINK: '2' });
  fs.writeFileSync(path.join(dataDir, 'fail-db-backup'), 'once');
  response = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/progress-goals?linkId=cal_new`, { ...workoutGoal, targetValue: 4 });
  assert.deepEqual([response.status, response.body.code], [503, 'storage_unavailable']);
  await stop(server);
  server = await launch(dataDir, { B2B2C_PROGRESS_GOALS_PER_LINK: '2' });
  assert.equal(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'), storedBefore);
  response = await request(server, IDS.coachA, 'GET', `/api/coach/athletes/${IDS.athleteA}/progress-goals?linkId=cal_new`);
  assert.equal(response.status, 200, response.text);
  assert.equal(response.body.goals.length, 1);
});
