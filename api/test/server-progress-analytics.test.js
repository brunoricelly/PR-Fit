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
  const goalRev = response.body.goal._rev;
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
  assert.deepEqual(response.body.items.map(item => item.id), [goalId]);
  assert.equal('goals' in response.body, false);

  response = await request(server, IDS.coachA, 'GET', '/api/progress/metrics');
  assert.equal(response.status, 200, response.text);
  assert.deepEqual(Object.fromEntries(Object.entries(response.body.metrics).map(([metric, definition]) => [metric, definition.pointKind])), {
    body_weight: 'instant', body_fat_percent: 'instant', workouts_per_week: 'interval',
    nutrition_adherence_percent: 'instant', habit_adherence_percent: 'instant',
  });

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

  response = await request(server, IDS.coachA, 'PATCH', `/api/coach/athletes/${IDS.athleteA}/progress-goals/${goalId}?linkId=cal_new`, { _rev: goalRev, targetValue: 2, status: 'achieved' });
  assert.deepEqual([response.status, response.body.goal.status, typeof response.body.goal.achievedAt], [200, 'achieved', 'string']);
  response = await request(server, IDS.coachA, 'DELETE', `/api/coach/athletes/${IDS.athleteA}/progress-goals/${goalId}?linkId=cal_new`, { _rev: response.body.goal._rev });
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

test('goal mutations use atomic revision preconditions for PATCH and DELETE', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-progress-cas-'));
  seed(dataDir);
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const server = await launch(dataDir);
  t.after(async () => stop(server));

  let response = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/progress-goals?linkId=cal_new`, workoutGoal);
  assert.equal(response.status, 201, response.text);
  const goal = response.body.goal;
  const route = `/api/coach/athletes/${IDS.athleteA}/progress-goals/${goal.id}?linkId=cal_new`;

  let results = await Promise.all([
    request(server, IDS.coachA, 'PATCH', route, { _rev: goal._rev, targetValue: 4 }),
    request(server, IDS.coachA, 'PATCH', route, { _rev: goal._rev, targetValue: 5 }),
  ]);
  assert.deepEqual(results.map(item => item.status).sort(), [200, 409]);
  assert.equal(results.find(item => item.status === 409).body.code, 'stale_version');
  response = await request(server, IDS.coachA, 'GET', route);
  assert.equal(response.body.goal._rev, 2);
  assert.equal(response.body.goal.targetValue, results.find(item => item.status === 200).body.goal.targetValue);

  const rev = response.body.goal._rev;
  results = await Promise.all([
    request(server, IDS.coachA, 'PATCH', route, { _rev: rev, targetValue: 6 }),
    request(server, IDS.coachA, 'DELETE', route, { _rev: rev }),
  ]);
  assert.deepEqual(results.map(item => item.status).sort(), [200, 409]);
  assert.equal(results.find(item => item.status === 409).body.code, 'stale_version');
  response = await request(server, IDS.coachA, 'GET', route);
  assert.equal(response.body.goal._rev, 3);
  const winner = results.find(item => item.status === 200).body.goal;
  assert.deepEqual([response.body.goal.status, response.body.goal.targetValue], [winner.status, winner.targetValue]);

  response = await request(server, IDS.coachA, 'DELETE', route);
  assert.deepEqual([response.status, response.body.code], [400, 'precondition_required']);
});

test('goal detail reapplies current coach specialty on historical links without cross-tenant enumeration', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-progress-detail-capability-'));
  seed(dataDir);
  const file = path.join(dataDir, 'db.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.users.find(user => user.id === IDS.coachA).profile.coachSpecialties = ['training'];
  data.progressGoals.push({
    id: 'pgoal_historical_assessment', linkId: 'cal_old', coachId: IDS.coachA, athleteId: IDS.athleteA,
    metric: 'body_weight', direction: 'decrease', baselineValue: 90, targetValue: 85, tolerance: 0.5,
    unit: 'kg', startDate: '2026-08-01', targetDate: '2026-09-30', timezone: 'UTC', status: 'archived', _rev: 2,
    createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-09-30T23:00:00.000Z', achievedAt: null,
    archivedAt: '2026-09-30T23:00:00.000Z', archiveReason: 'manual',
  });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const server = await launch(dataDir);
  t.after(async () => stop(server));
  const route = `/api/coach/athletes/${IDS.athleteA}/progress-goals/pgoal_historical_assessment?linkId=cal_old`;

  let response = await request(server, IDS.coachA, 'GET', route);
  assert.deepEqual([response.status, response.body.code], [403, 'scope_forbidden']);
  response = await request(server, IDS.athleteA, 'GET', '/api/athlete/progress-goals?linkId=cal_old&status=archived');
  assert.deepEqual(response.body.items.map(item => item.id), ['pgoal_historical_assessment']);
  response = await request(server, IDS.coachB, 'GET', `/api/coach/athletes/${IDS.athleteA}/progress-goals/pgoal_historical_assessment?linkId=cal_ba`);
  assert.deepEqual([response.status, response.body.code], [404, 'goal_not_found']);
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
  assert.deepEqual((await request(server, IDS.coachA, 'GET', `/api/coach/athletes/${IDS.athleteA}/progress-goals?linkId=cal_new`)).body.items, []);

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
  assert.equal(response.body.items.length, 1);
});

test('athlete report reads, metadata catalog, timezone errors and detail egress are fail-closed', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-progress-athlete-'));
  seed(dataDir);
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const server = await launch(dataDir, { B2B2C_PROGRESS_EXPORT_ACCOUNT_MAX: '1', B2B2C_PROGRESS_EXPORT_IP_MAX: '10' });
  t.after(async () => stop(server));

  let response = await request(server, IDS.coachA, 'GET', '/api/progress/metrics');
  assert.equal(response.status, 200, response.text);
  assert.deepEqual(response.body.metrics.workouts_per_week.volume,
    { unit: 'source_weight_repetitions', labelPtBr: 'Soma de carga da fonte multiplicada por repetições' });

  response = await request(server, IDS.coachA, 'GET', `/api/coach/athletes/${IDS.athleteA}/progress-summary?linkId=cal_new&period=30&timezone=Not/A_Zone&metrics=workouts_per_week`);
  assert.deepEqual([response.status, response.body.code], [400, 'invalid_timezone']);

  response = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/progress-reports?linkId=cal_new`, {
    period: 30, timezone: 'Pacific/Kiritimati', metrics: ['workouts_per_week'],
  });
  assert.equal(response.status, 201, response.text);
  const reportId = response.body.report.id;

  response = await request(server, IDS.athleteA, 'GET', `/api/athlete/progress-reports?linkId=cal_new`);
  assert.deepEqual(response.body.items.map(item => item.id), [reportId]);
  response = await request(server, IDS.athleteA, 'GET', `/api/athlete/progress-reports/${reportId}?linkId=cal_new`);
  assert.equal(response.status, 200, response.text);
  response = await request(server, IDS.athleteA, 'GET', `/api/athlete/progress-reports/${reportId}/export?linkId=cal_new&format=json`);
  assert.equal(response.status, 429, 'detail and export share the egress budget');
  assert.ok(Number(response.headers.get('retry-after')) >= 1);

  response = await request(server, IDS.athleteB, 'GET', `/api/athlete/progress-reports/${reportId}?linkId=cal_ab`);
  assert.deepEqual([response.status, response.body.code], [404, 'report_not_found']);
  response = await request(server, IDS.coachB, 'GET', `/api/coach/athletes/${IDS.athleteA}/progress-reports/${reportId}?linkId=cal_ba`);
  assert.deepEqual([response.status, response.body.code], [404, 'report_not_found']);
});

test('goal and report listings use bound opaque cursors and terminal records do not consume capacity', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-progress-pages-'));
  seed(dataDir);
  const file = path.join(dataDir, 'db.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (let index = 0; index < 5; index++) {
    const createdAt = `2026-11-0${index + 1}T00:00:00.000Z`;
    data.progressGoals.push({
      id: `pgoal_page_${index}`, linkId: 'cal_new', coachId: IDS.coachA, athleteId: IDS.athleteA,
      metric: 'workouts_per_week', direction: 'increase', baselineValue: 0, targetValue: index + 1, tolerance: 0,
      unit: 'workouts_per_week', startDate: '2026-11-01', targetDate: '2026-12-31', timezone: 'UTC',
      status: index < 4 ? 'archived' : 'active', _rev: 1, createdAt, updatedAt: createdAt,
      achievedAt: null, archivedAt: index < 4 ? createdAt : null, archiveReason: index < 4 ? 'manual' : null,
    });
  }
  for (let index = 0; index < 3; index++) {
    const createdAt = `2026-11-0${index + 2}T12:00:00.000Z`;
    const revokedAt = index === 0 ? '2026-11-06T00:00:00.000Z' : null;
    data.progressReports.push({
      id: `prep_page_${index}`, linkId: 'cal_new', coachId: IDS.coachA, athleteId: IDS.athleteA,
      interval: { from: `2026-11-0${index + 1}`, to: `2026-11-0${index + 2}` }, timezone: 'UTC', metrics: ['workouts_per_week'],
      summary: 'workouts_per_week: fixture.', snapshot: { version: 1, generatedAt: createdAt, period: { from: '2026-11-01', to: '2026-11-02' }, metrics: {} },
      createdAt, revokedAt, revocation: revokedAt ? { reason: 'scope_revoked', scope: 'training', actorId: IDS.athleteA, at: revokedAt } : null,
    });
  }
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const server = await launch(dataDir, { B2B2C_PROGRESS_GOALS_PER_LINK: '1', B2B2C_MAX_PROGRESS_GOALS: '1' });
  t.after(async () => stop(server));

  let response = await request(server, IDS.coachA, 'GET', `/api/coach/athletes/${IDS.athleteA}/progress-goals?linkId=cal_new&status=archived&limit=2`);
  assert.deepEqual([response.status, response.body.items.length, response.body.hasMore], [200, 2, true]);
  assert.equal('goals' in response.body, false);
  const cursor = response.body.nextCursor;
  response = await request(server, IDS.coachA, 'GET', `/api/coach/athletes/${IDS.athleteA}/progress-goals?linkId=cal_new&status=archived&limit=2&cursor=${encodeURIComponent(cursor)}`);
  assert.deepEqual([response.status, response.body.items.length, response.body.hasMore], [200, 2, false]);
  response = await request(server, IDS.coachA, 'GET', `/api/coach/athletes/${IDS.athleteA}/progress-goals?linkId=cal_new&status=active&limit=2&cursor=${encodeURIComponent(cursor)}`);
  assert.deepEqual([response.status, response.body.code], [400, 'invalid_cursor']);
  response = await request(server, IDS.coachA, 'GET', `/api/coach/athletes/${IDS.athleteB}/progress-goals?linkId=cal_ab&status=archived&limit=2&cursor=${encodeURIComponent(cursor)}`);
  assert.deepEqual([response.status, response.body.code], [400, 'invalid_cursor']);

  response = await request(server, IDS.coachA, 'GET', `/api/coach/athletes/${IDS.athleteA}/progress-reports?linkId=cal_new&status=active&from=2026-11-01&to=2026-11-10&limit=1`);
  assert.deepEqual([response.status, response.body.items.length, response.body.hasMore], [200, 1, true]);
  const reportCursor = response.body.nextCursor;
  response = await request(server, IDS.athleteA, 'GET', `/api/athlete/progress-reports?linkId=cal_new&status=active&from=2026-11-01&to=2026-11-10&limit=1&cursor=${encodeURIComponent(reportCursor)}`);
  assert.deepEqual([response.status, response.body.items.length, response.body.hasMore], [200, 1, false]);
  response = await request(server, IDS.coachA, 'GET', `/api/coach/athletes/${IDS.athleteA}/progress-reports?linkId=cal_new&status=revoked&from=2026-11-01&to=2026-11-10`);
  assert.deepEqual(response.body.items.map(item => item.id), ['prep_page_0']);
  assert.equal('reports' in response.body, false);

  response = await request(server, IDS.coachA, 'DELETE', `/api/coach/athletes/${IDS.athleteA}/progress-goals/pgoal_page_4?linkId=cal_new`, { _rev: 1 });
  assert.equal(response.body.archived, true);
  response = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteB}/progress-goals?linkId=cal_ab`, workoutGoal);
  assert.equal(response.status, 201, response.text);
  response = await request(server, IDS.coachA, 'GET', `/api/coach/athletes/${IDS.athleteB}/progress-goals/${response.body.goal.id}?linkId=cal_ab`);
  assert.equal(response.status, 200, response.text);
  response = await request(server, IDS.coachA, 'PATCH', `/api/coach/athletes/${IDS.athleteB}/progress-goals/${response.body.goal.id}?linkId=cal_ab`, { _rev: 999, targetValue: 4 });
  assert.deepEqual([response.status, response.body.code], [409, 'stale_version']);
});
