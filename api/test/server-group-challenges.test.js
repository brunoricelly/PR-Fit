import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers.mjs';
import { migrateB2B2C, B2B2C_SCHEMA_VERSION } from '../b2b2c.js';
import { validateChallengesState } from '../challenges.js';
import { validateGroupProgramsState } from '../group-programs.js';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'http://localhost:8080';
const SECRET = crypto.randomBytes(32).toString('hex');
const IDS = { coachA: 'u_coach_a', coachB: 'u_coach_b', training: 'u_training', nutrition: 'u_nutrition', pending: 'u_pending', suspended: 'u_suspended', ended: 'u_ended', extra: 'u_extra' };

function mintSession(uid) {
  const payload = `${uid}:${Date.now() + 86400000}:0:c`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}

function baseDb() {
  const stamp = '2026-11-01T00:00:00.000Z';
  const athlete = id => ({ id, name: id.replace('u_', ''), profile: { kind: 'athlete' } });
  return {
    schemaVersion: 9,
    users: [
      { id: IDS.coachA, name: 'Coach A', admin: true, profile: { kind: 'coach', coachSpecialties: ['training', 'nutrition'] } },
      { id: IDS.coachB, name: 'Coach B', profile: { kind: 'coach', coachSpecialties: ['training'] } },
      ...[IDS.training, IDS.nutrition, IDS.pending, IDS.suspended, IDS.ended, IDS.extra].map(athlete),
    ],
    creds: [], subs: [], invites: [], deviceLinks: [], watchLinks: [], coachInvites: [], coachPrescriptions: [], coachAssessments: [],
    mealPlans: [], mealAdherence: [], coachMessages: [], coachHabits: [], habitCheckins: [], progressGoals: [], progressReports: [], accountCleanupJobs: [],
    coachAvailability: [], coachAppointments: [],
    coachAthleteLinks: [
      { id: 'cal_training', coachId: IDS.coachA, athleteId: IDS.training, scopes: ['training'], status: 'active', createdAt: stamp, updatedAt: stamp },
      { id: 'cal_extra', coachId: IDS.coachA, athleteId: IDS.extra, scopes: ['training'], status: 'active', createdAt: stamp, updatedAt: stamp },
      { id: 'cal_cross', coachId: IDS.coachB, athleteId: IDS.training, scopes: ['training'], status: 'active', createdAt: stamp, updatedAt: stamp },
      { id: 'cal_nutrition', coachId: IDS.coachA, athleteId: IDS.nutrition, scopes: ['nutrition'], status: 'active', createdAt: stamp, updatedAt: stamp },
      { id: 'cal_pending', coachId: IDS.coachA, athleteId: IDS.pending, scopes: ['training'], status: 'pending', createdAt: stamp, updatedAt: stamp },
      { id: 'cal_suspended', coachId: IDS.coachA, athleteId: IDS.suspended, scopes: ['training'], status: 'suspended', createdAt: stamp, updatedAt: stamp },
      { id: 'cal_ended', coachId: IDS.coachA, athleteId: IDS.ended, scopes: ['training'], status: 'ended', createdAt: stamp, updatedAt: stamp },
    ],
    coachGroups: [], groupMembers: [], groupInvites: [], challenges: [], challengeScores: [], challengeActivityFeed: [], groupPrograms: [], groupProgramAdoptions: [],
  };
}

function seed(dataDir, db = baseDb()) {
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify(db, null, 2));
  fs.writeFileSync(path.join(dataDir, `state-${IDS.training}.json`), JSON.stringify({ workouts: [
    { id: 'workout_1', d: '2026-11-02', start: Date.parse('2026-11-02T10:00:00Z'), vol: 2500 },
    { id: 'workout_2', d: '2026-11-03', start: Date.parse('2026-11-03T10:00:00Z'), vol: 1500 },
  ], routines: [], customEx: [] }));
  fs.writeFileSync(path.join(dataDir, `state-${IDS.extra}.json`), JSON.stringify({ workouts: [{ id: 'workout_3', d: '2026-11-02', start: Date.parse('2026-11-02T12:00:00Z'), vol: 1000 }], routines: [], customEx: [] }));
}

async function launch(dataDir, env = {}) {
  const child = spawn(process.execPath, ['server.js'], { cwd: API, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN, RP_ID: 'localhost', AUDIT_LOG: '1', PASSWORD_LOGIN: '1', ...env } });
  let log = ''; child.stdout.on('data', chunk => log += chunk); child.stderr.on('data', chunk => log += chunk);
  const port = await boundPort(child, () => log);
  return { child, api: `http://127.0.0.1:${port}`, log: () => log };
}

async function stop(server) {
  if (server.child.exitCode !== null || server.child.signalCode !== null) return;
  server.child.kill('SIGTERM');
  await new Promise(resolve => server.child.once('exit', resolve));
}

async function request(server, uid, method, route, body, headers = {}) {
  const response = await fetch(server.api + route, { method, headers: { Cookie: `gymsid=${mintSession(uid)}`, Origin: ORIGIN, 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
}

async function createGroup(server, maxMembers = 10) {
  const response = await request(server, IDS.coachA, 'POST', '/api/coach/groups', { name: 'Grupo', maxMembers, isPrivate: true });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.group;
}

async function activeInvite(server, groupId) {
  const response = await request(server, IDS.coachA, 'GET', `/api/coach/groups/${groupId}/invite`);
  assert.equal(response.status, 200); return response.body.invite.code;
}

async function addAndAccept(server, groupId, athleteId) {
  let response = await request(server, IDS.coachA, 'POST', `/api/coach/groups/${groupId}/members`, { athleteId });
  assert.equal(response.status, 201, JSON.stringify(response.body)); assert.equal(response.body.member.status, 'pending');
  response = await request(server, athleteId, 'POST', `/api/athlete/groups/${groupId}/accept`, {});
  assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body.member;
}

test('anti-IDOR, exact active training scope, pending consent, privacy and invite 410 contracts', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase8-auth-')); seed(dir); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const server = await launch(dir); t.after(() => stop(server)); const group = await createGroup(server, 3);
  assert.equal('inviteCode' in group, false); assert.equal('coachId' in group, false);
  for (const athleteId of [IDS.nutrition, IDS.pending, IDS.suspended, IDS.ended]) {
    const response = await request(server, IDS.coachA, 'POST', `/api/coach/groups/${group.id}/members`, { athleteId });
    assert.equal(response.status, 403, athleteId); assert.equal(response.body.code, 'scope_forbidden');
  }
  let response = await request(server, IDS.coachB, 'POST', `/api/coach/groups/${group.id}/members`, { athleteId: IDS.training });
  assert.equal(response.status, 403); assert.equal(response.body.code, 'access_denied');
  await addAndAccept(server, group.id, IDS.training);
  response = await request(server, IDS.training, 'GET', '/api/athlete/groups');
  assert.equal(response.status, 200); assert.equal(JSON.stringify(response.body).includes('inviteCode'), false); assert.equal(JSON.stringify(response.body).includes(IDS.training), false);
  response = await request(server, IDS.coachA, 'PUT', `/api/coach/groups/${group.id}`, { expectedUpdatedAt: '2026-01-01T00:00:00.000Z', name: 'stale' }); assert.equal(response.status, 409); assert.equal(response.body.code, 'edit_conflict');
  response = await request(server, IDS.training, 'POST', '/api/profile', { kind: 'coach', coachSpecialties: ['training'] }); assert.equal(response.status, 200);
  response = await request(server, IDS.training, 'GET', `/api/athlete/groups/${group.id}?limit=1`); assert.equal(response.status, 200); assert.equal(response.body.page.limit, 1); assert.equal(JSON.stringify(response.body).includes('athleteId'), false);
  const oldCode = await activeInvite(server, group.id);
  response = await request(server, IDS.coachA, 'POST', `/api/coach/groups/${group.id}/invite`, { expiresInDays: 10 }); assert.equal(response.status, 200);
  response = await request(server, IDS.extra, 'POST', '/api/athlete/groups/join', { inviteCode: oldCode }); assert.equal(response.status, 410); assert.equal(response.body.code, 'invite_revoked');
  response = await request(server, IDS.coachA, 'PUT', `/api/coach/groups/${group.id}`, { archived: true }); assert.equal(response.status, 200);
  response = await request(server, IDS.extra, 'POST', '/api/athlete/groups/join', { inviteCode: response.body.inviteCode || (await activeInvite(server, group.id)) }); assert.equal(response.status, 410);
});

test('two concurrent joins cannot exceed the last slot', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase8-capacity-')); seed(dir); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const a = await launch(dir), b = await launch(dir); t.after(() => Promise.all([stop(a), stop(b)])); const group = await createGroup(a, 1), code = await activeInvite(a, group.id);
  const results = await Promise.all([request(a, IDS.training, 'POST', '/api/athlete/groups/join', { inviteCode: code }), request(b, IDS.extra, 'POST', '/api/athlete/groups/join', { inviteCode: code })]);
  assert.deepEqual(results.map(row => row.status).sort(), [200, 409]);
  const disk = JSON.parse(fs.readFileSync(path.join(dir, 'db.json'))); assert.equal(disk.coachGroups[0].memberCount, 1); assert.equal(disk.groupMembers.filter(row => row.status === 'active').length, 1);
});

test('legacy saveDb on a server started earlier preserves group and challenge writes from another process', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase8-lost-update-')), servers = []; seed(dir);
  t.after(async () => { await Promise.all(servers.map(stop)); fs.rmSync(dir, { recursive: true, force: true }); });
  const a = await launch(dir), b = await launch(dir); servers.push(a, b); const group = await createGroup(a); await addAndAccept(a, group.id, IDS.training);
  let response = await request(a, IDS.coachA, 'POST', '/api/coach/challenges', { title: 'Persistente', type: 'workouts_count', scope: 'group', groupId: group.id, startAt: '2026-11-01T00:00:00Z', endAt: '2026-11-30T00:00:00Z', timeZone: 'UTC', status: 'active', rules: { pointsPerWorkout: 10 } });
  assert.equal(response.status, 201, JSON.stringify(response.body)); const challengeId = response.body.challenge.id;
  response = await request(b, IDS.extra, 'POST', '/api/logout/all', {}); assert.equal(response.status, 200, JSON.stringify(response.body));
  await stop(a); await stop(b); const restarted = await launch(dir); servers.push(restarted);
  const disk = JSON.parse(fs.readFileSync(path.join(dir, 'db.json'))); assert.ok(disk.coachGroups.some(row => row.id === group.id)); assert.ok(disk.challenges.some(row => row.id === challengeId));
});

test('lifecycle is one-way, scoring uses real workouts, feed is private, deterministic and GET is pure', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase8-score-')); seed(dir); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const server = await launch(dir); t.after(() => stop(server)); const group = await createGroup(server); await addAndAccept(server, group.id, IDS.training); await addAndAccept(server, group.id, IDS.extra);
  let response = await request(server, IDS.coachA, 'POST', '/api/coach/challenges', { title: 'Treinos', type: 'workouts_count', scope: 'group', groupId: group.id, startAt: '2026-11-01T00:00:00Z', endAt: '2026-11-30T00:00:00Z', timeZone: 'UTC', status: 'active', rules: { pointsPerWorkout: 10 } });
  assert.equal(response.status, 201); const id = response.body.challenge.id, before = fs.readFileSync(path.join(dir, 'db.json'), 'utf8');
  response = await request(server, IDS.training, 'GET', `/api/athlete/challenges/${id}/leaderboard?limit=1&feedlimit=1`); assert.equal(response.status, 200); assert.equal(response.body.leaderboard[0].score, 20);
  const serialized = JSON.stringify(response.body); assert.equal(serialized.includes('athleteId'), false); assert.equal(serialized.includes('@'), false); assert.ok(response.body.activityFeed.every(row => row.activityType === 'workout_completed'));
  assert.equal(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'), before, 'leaderboard GET must not persist');
  response = await request(server, IDS.coachA, 'PUT', `/api/coach/challenges/${id}`, { status: 'completed' }); assert.equal(response.status, 200);
  response = await request(server, IDS.coachA, 'PUT', `/api/coach/challenges/${id}`, { status: 'active' }); assert.equal(response.status, 409); assert.equal(response.body.code, 'invalid_transition');
  await request(server, IDS.training, 'POST', `/api/athlete/groups/${group.id}/leave`, {});
  response = await request(server, IDS.coachA, 'GET', `/api/coach/challenges/${id}/leaderboard`); assert.equal(response.status, 200); assert.equal(response.body.leaderboard.length, 2, 'historical ranking remains frozen');
});

test('custom points is idempotent, bounded, auditable and corrected by compensation', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase8-custom-')); seed(dir); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const server = await launch(dir); t.after(() => stop(server)); const group = await createGroup(server); await addAndAccept(server, group.id, IDS.training);
  let response = await request(server, IDS.coachA, 'POST', '/api/coach/challenges', { title: 'Pontos', type: 'custom_points', scope: 'group', groupId: group.id, startAt: '2026-11-01T00:00:00Z', endAt: '2026-11-30T00:00:00Z', timeZone: 'UTC', status: 'active', rules: { maxPointsPerAdjustment: 50, maxAbsoluteScore: 100 } });
  const id = response.body.challenge.id, headers = { 'Idempotency-Key': 'points-0001' };
  response = await request(server, IDS.coachA, 'POST', `/api/coach/challenges/${id}/points`, { athleteId: IDS.training, points: 20, reason: 'Bônus validado' }, headers); assert.equal(response.status, 200); const adjustmentId = response.body.adjustment.id;
  response = await request(server, IDS.coachA, 'POST', `/api/coach/challenges/${id}/points`, { athleteId: IDS.training, points: 20, reason: 'Bônus validado' }, headers); assert.equal(response.body.idempotent, true); assert.equal(response.body.score, 20);
  response = await request(server, IDS.coachA, 'POST', `/api/coach/challenges/${id}/points`, { athleteId: IDS.training, points: 10, reason: 'Outro uso' }, headers); assert.equal(response.status, 409); assert.equal(response.body.code, 'idempotency_conflict');
  response = await request(server, IDS.coachA, 'POST', `/api/coach/challenges/${id}/points`, { athleteId: IDS.training, points: -20, reason: 'Correção', correctionOf: adjustmentId }, { 'Idempotency-Key': 'points-0002' }); assert.equal(response.status, 200); assert.equal(response.body.score, 0);
  response = await request(server, IDS.coachA, 'POST', `/api/coach/challenges/${id}/points`, { athleteId: IDS.training, points: -20, reason: 'Correção repetida', correctionOf: adjustmentId }, { 'Idempotency-Key': 'points-0004' }); assert.equal(response.status, 422); assert.equal(response.body.code, 'invalid_correction');
  response = await request(server, IDS.coachA, 'POST', `/api/coach/challenges/${id}/points`, { athleteId: IDS.training, points: 51, reason: 'Excesso' }, { 'Idempotency-Key': 'points-0003' }); assert.equal(response.status, 422);
});

const routine = { name: 'Coletivo A', notes: '', divisions: [{ name: 'A', exercises: [{ name: 'Agachamento', sets: 3, reps: '8-12', load: '', restSeconds: 60, notes: '' }] }] };

test('collective programs publish immutable versions and adopt atomically without duplicates', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase8-program-')); seed(dir); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const server = await launch(dir); t.after(() => stop(server)); const group = await createGroup(server); await addAndAccept(server, group.id, IDS.training);
  let response = await request(server, IDS.coachA, 'POST', '/api/coach/group-programs', { groupId: group.id, title: 'Programa coletivo', routine }); assert.equal(response.status, 201, JSON.stringify(response.body)); const id = response.body.program.id;
  response = await request(server, IDS.coachA, 'POST', `/api/coach/group-programs/${id}/publish`, {}); assert.equal(response.status, 200); assert.equal(response.body.program.status, 'published');
  response = await request(server, IDS.coachA, 'PUT', `/api/coach/group-programs/${id}`, { title: 'Mutação proibida' }); assert.equal(response.status, 409);
  response = await request(server, IDS.training, 'POST', `/api/athlete/group-programs/${id}/adopt`, {}); assert.equal(response.status, 200, JSON.stringify(response.body)); assert.equal(response.body.idempotent, false);
  const routineIds = response.body.routineIds;
  response = await request(server, IDS.training, 'POST', `/api/athlete/group-programs/${id}/adopt`, {}); assert.equal(response.status, 200); assert.equal(response.body.idempotent, true); assert.deepEqual(response.body.routineIds, routineIds);
  const state = JSON.parse(fs.readFileSync(path.join(dir, `state-${IDS.training}.json`))); assert.equal(state.routines.filter(row => row.prescriptionId).length, 1);
  response = await request(server, IDS.coachA, 'POST', `/api/coach/group-programs/${id}/versions`, {}); assert.equal(response.status, 201); assert.equal(response.body.program.version, 2);
  response = await request(server, IDS.coachA, 'GET', '/api/coach/group-programs?limit=1'); assert.equal(response.status, 200); assert.equal(response.body.programs.length, 1); assert.equal(response.body.page.hasMore, true);
  await request(server, IDS.coachA, 'POST', `/api/coach/group-programs/${id}/archive`, {}); await request(server, IDS.training, 'POST', `/api/athlete/groups/${group.id}/leave`, {});
  const disk = JSON.parse(fs.readFileSync(path.join(dir, 'db.json'))); assert.equal(disk.groupProgramAdoptions.length, 1, 'leaving and archiving preserve adoption history');
});

test('collective program adoption journal recovers the state-to-db failure exactly once', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase8-program-journal-')), barriers = fs.mkdtempSync(path.join(os.tmpdir(), 'phase8-program-journal-fault-')); seed(dir); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); t.after(() => fs.rmSync(barriers, { recursive: true, force: true }));
  fs.writeFileSync(path.join(barriers, `group-adoption-after-state-${IDS.training}.fail-once`), '');
  let server = await launch(dir, { STATE_WRITE_TEST_DIR: barriers }); t.after(() => stop(server)); const group = await createGroup(server); await addAndAccept(server, group.id, IDS.training);
  let response = await request(server, IDS.coachA, 'POST', '/api/coach/group-programs', { groupId: group.id, title: 'Programa recuperável', routine }); const id = response.body.program.id;
  await request(server, IDS.coachA, 'POST', `/api/coach/group-programs/${id}/publish`, {});
  response = await request(server, IDS.training, 'POST', `/api/athlete/group-programs/${id}/adopt`, {}); assert.equal(response.status, 503); assert.equal(response.body.code, 'adoption_pending');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'db.json'))).groupProgramAdoptions.length, 0); assert.equal(fs.readdirSync(dir).filter(name => name.startsWith('group-program-adoption-')).length, 1);
  await stop(server); server = await launch(dir, { STATE_WRITE_TEST_DIR: barriers });
  assert.equal(fs.readdirSync(dir).filter(name => name.startsWith('group-program-adoption-')).length, 0); assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'db.json'))).groupProgramAdoptions.length, 1);
  response = await request(server, IDS.training, 'POST', `/api/athlete/group-programs/${id}/adopt`, {}); assert.equal(response.status, 200); assert.equal(response.body.idempotent, true);
  const state = JSON.parse(fs.readFileSync(path.join(dir, `state-${IDS.training}.json`))); assert.equal(state.routines.filter(row => row.prescriptionId).length, 1);
  const audit = fs.readFileSync(path.join(dir, 'audit.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line)); assert.equal(audit.filter(row => row.ev === 'athlete.group-program.adopt' && row.msg === id).length, 1);
});

test('rate limits return 429 and Retry-After', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase8-rate-')); seed(dir); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const server = await launch(dir, { B2B2C_CHALLENGE_MUTATION_ACCOUNT_MAX: '1', B2B2C_CHALLENGE_MUTATION_IP_MAX: '100' }); t.after(() => stop(server));
  assert.equal((await request(server, IDS.coachA, 'POST', '/api/coach/groups', { name: 'Um' })).status, 201);
  const response = await request(server, IDS.coachA, 'POST', '/api/coach/groups', { name: 'Dois' }); assert.equal(response.status, 429); assert.ok(Number(response.headers.get('retry-after')) >= 1);
});

test('schema v9 validation is fail-closed for count, invite, score, eligibility, scope, rules and unknown fields', () => {
  const db = baseDb(); const stamp = '2026-11-01T00:00:00.000Z';
  db.coachGroups.push({ id: 'cgrp_schema', coachId: IDS.coachA, name: 'G', description: '', category: 'geral', maxMembers: 2, isPrivate: true, memberCount: 1, createdAt: stamp, updatedAt: stamp, archivedAt: null });
  assert.throws(() => validateChallengesState(structuredClone(db)), /memberCount mismatch/);
  db.coachGroups[0].memberCount = 0;
  db.groupInvites.push({ id: 'ginv_1', groupId: 'cgrp_schema', coachId: IDS.coachA, code: 'GRP-AAAAAAAAAAAAAAAA', status: 'active', createdAt: stamp, updatedAt: stamp, expiresAt: '2027-01-01T00:00:00.000Z', revokedAt: null });
  db.groupInvites.push({ ...db.groupInvites[0], id: 'ginv_2', code: 'grp-aaaaaaaaaaaaaaaa', status: 'revoked', revokedAt: stamp });
  assert.throws(() => validateChallengesState(structuredClone(db)), /groupInvites/); db.groupInvites.pop();
  const challenge = { id: 'chal_schema', coachId: IDS.coachA, groupId: null, scope: 'coach_students', title: 'C', description: '', type: 'workouts_count', startAt: stamp, endAt: '2026-12-01T00:00:00.000Z', timeZone: 'UTC', status: 'active', rules: { pointsPerWorkout: 10 }, participantIds: [IDS.training], createdAt: stamp, updatedAt: stamp, activatedAt: stamp, completedAt: null, archivedAt: null };
  db.challenges.push(challenge); db.challengeScores.push({ id: 'cscr_1', challengeId: challenge.id, athleteId: IDS.training, score: 1, workoutsCount: 0, volumeLoad: 0, habitCheckinsCount: 0, lastActivityAt: null, updatedAt: stamp, finalized: false }, { id: 'cscr_2', challengeId: challenge.id, athleteId: IDS.training, score: 2, workoutsCount: 0, volumeLoad: 0, habitCheckinsCount: 0, lastActivityAt: null, updatedAt: stamp, finalized: false });
  assert.throws(() => validateChallengesState(structuredClone(db)), /challengeScores/); db.challengeScores.pop();
  db.challengeScores[0].athleteId = IDS.nutrition; assert.throws(() => validateChallengesState(structuredClone(db)), /challengeScores/); db.challengeScores = [];
  db.challenges[0].groupId = 'cgrp_schema'; assert.throws(() => validateChallengesState(structuredClone(db)), /challenges/); db.challenges[0].groupId = null;
  db.challenges[0].rules = { pointsPerWorkout: -1 }; assert.throws(() => validateChallengesState(structuredClone(db)), /challenges/); db.challenges[0].rules = { pointsPerWorkout: 10 };
  db.challenges[0].unexpected = true; assert.throws(() => validateChallengesState(structuredClone(db)), /challenges/);
  delete db.challenges[0].unexpected; db.challenges = [];
  const normalizedRoutine = { name: 'R', notes: '', divisions: [{ id: 'division_1', name: 'A', exercises: [{ id: 'exercise_1_1', name: 'Agachamento', sets: 3, reps: '10', load: '', restSeconds: 60, notes: '' }] }] };
  db.groupPrograms.push({ id: 'gprg_schema', seriesId: 'gprs_schema', coachId: IDS.coachA, groupId: 'cgrp_schema', templateId: null, prescriptionId: 'gprx_schema', title: 'P', version: 1, status: 'draft', routine: normalizedRoutine, createdAt: stamp, updatedAt: stamp, publishedAt: null, archivedAt: null });
  assert.equal(validateGroupProgramsState(structuredClone(db)), true); db.groupPrograms[0].routine.extra = true; assert.throws(() => validateGroupProgramsState(structuredClone(db)), /groupPrograms/);
});

test('v8 migration initializes all phase-8 collections and invalid v9 boot changes neither db.json nor backup', async t => {
  const legacy = { ...baseDb(), schemaVersion: 8 }; for (const key of ['coachGroups', 'groupMembers', 'groupInvites', 'challenges', 'challengeScores', 'challengeActivityFeed', 'groupPrograms', 'groupProgramAdoptions']) delete legacy[key];
  assert.equal(migrateB2B2C(legacy), true); assert.equal(legacy.schemaVersion, B2B2C_SCHEMA_VERSION); for (const key of ['coachGroups', 'groupMembers', 'groupInvites', 'challenges', 'challengeScores', 'challengeActivityFeed', 'groupPrograms', 'groupProgramAdoptions']) assert.deepEqual(legacy[key], []);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase8-invalid-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); const invalid = baseDb(), stamp = '2026-11-01T00:00:00.000Z';
  invalid.coachGroups.push({ id: 'cgrp_invalid', coachId: IDS.coachA, name: 'G', description: '', category: 'geral', maxMembers: 2, isPrivate: true, memberCount: 1, createdAt: stamp, updatedAt: stamp, archivedAt: null }); seed(dir, invalid); fs.writeFileSync(path.join(dir, 'db.json.bak'), 'sentinel-backup');
  const before = fs.readFileSync(path.join(dir, 'db.json')), backup = fs.readFileSync(path.join(dir, 'db.json.bak'));
  const child = spawn(process.execPath, ['server.js'], { cwd: API, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PORT: '0', DATA_DIR: dir, ORIGIN, RP_ID: 'localhost' } }); let log = ''; child.stderr.on('data', chunk => log += chunk); child.stdout.on('data', chunk => log += chunk); await new Promise(resolve => child.once('exit', resolve));
  assert.equal(child.exitCode, 1, log); assert.deepEqual(fs.readFileSync(path.join(dir, 'db.json')), before); assert.deepEqual(fs.readFileSync(path.join(dir, 'db.json.bak')), backup);
});
