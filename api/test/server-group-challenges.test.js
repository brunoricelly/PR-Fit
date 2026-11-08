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
import { validateChallengesState, removeChallengesUser } from '../challenges.js';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'http://localhost:8080';
const SECRET = crypto.randomBytes(32).toString('hex');

const IDS = {
  coachA: 'u_coach_a',
  coachB: 'u_coach_b',
  athleteA: 'u_athlete_a',
  athleteB: 'u_athlete_b',
  athleteC: 'u_athlete_c',
};

function mintSession(uid) {
  const payload = `${uid}:${Date.now() + 86400000}:0:c`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}

function baseDb() {
  const now = new Date().toISOString();
  return {
    schemaVersion: 9,
    users: [
      { id: IDS.coachA, name: 'Coach A', admin: true, profile: { kind: 'coach', coachSpecialties: ['training', 'nutrition'] } },
      { id: IDS.coachB, name: 'Coach B', profile: { kind: 'coach', coachSpecialties: ['training'] } },
      { id: IDS.athleteA, name: 'Athlete A', profile: { kind: 'athlete' } },
      { id: IDS.athleteB, name: 'Athlete B', profile: { kind: 'athlete' } },
      { id: IDS.athleteC, name: 'Athlete C', profile: { kind: 'athlete' } },
    ],
    creds: [], subs: [], invites: [], deviceLinks: [], watchLinks: [],
    coachInvites: [], coachPrescriptions: [], coachAssessments: [],
    mealPlans: [], mealAdherence: [], coachMessages: [], coachHabits: [], habitCheckins: [],
    progressGoals: [], progressReports: [], accountCleanupJobs: [],
    coachAvailability: [], coachAppointments: [],
    coachAthleteLinks: [
      { id: 'cal_aa', coachId: IDS.coachA, athleteId: IDS.athleteA, scopes: ['training', 'nutrition'], status: 'active', createdAt: now, updatedAt: now },
      { id: 'cal_ab', coachId: IDS.coachA, athleteId: IDS.athleteB, scopes: ['training'], status: 'active', createdAt: now, updatedAt: now },
      { id: 'cal_bb', coachId: IDS.coachB, athleteId: IDS.athleteB, scopes: ['training'], status: 'active', createdAt: now, updatedAt: now },
    ],
    coachGroups: [],
    groupMembers: [],
    challenges: [],
    challengeScores: [],
    challengeActivityFeed: [],
  };
}

function seed(dataDir, customDb = null) {
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify(customDb || baseDb(), null, 2));

  // Seed athlete state files for workout scoring
  fs.writeFileSync(path.join(dataDir, `state-${IDS.athleteA}.json`), JSON.stringify({
    unit: 'kg',
    workouts: [
      { id: 'w_a1', d: '2026-11-02', vol: 1500, start: Date.parse('2026-11-02T10:00:00Z') },
      { id: 'w_a2', d: '2026-11-04', vol: 1500, start: Date.parse('2026-11-04T10:00:00Z') },
    ],
  }, null, 2));

  fs.writeFileSync(path.join(dataDir, `state-${IDS.athleteB}.json`), JSON.stringify({
    unit: 'kg',
    workouts: [
      { id: 'w_b1', d: '2026-11-02', vol: 1000, start: Date.parse('2026-11-02T12:00:00Z') },
    ],
  }, null, 2));

  fs.writeFileSync(path.join(dataDir, `state-${IDS.athleteC}.json`), JSON.stringify({
    unit: 'kg',
    workouts: [],
  }, null, 2));
}

async function launch(dataDir, env = {}) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: '0',
      DATA_DIR: dataDir,
      ORIGIN,
      RP_ID: 'localhost',
      AUDIT_LOG: '1',
      PASSWORD_LOGIN: '1',
      B2B2C_DB_FAIL_FILE: path.join(dataDir, 'fail-db-write'),
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
    method,
    headers: {
      Cookie: `gymsid=${mintSession(uid)}`,
      Origin: ORIGIN,
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  const contentType = response.headers.get('content-type') || '';
  return {
    status: response.status,
    headers: response.headers,
    text,
    body: text && contentType.includes('application/json') ? JSON.parse(text) : null,
  };
}

test('1. Criação de grupos e limites de membros (maxMembers)', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-test-groups-'));
  seed(dataDir);
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const server = await launch(dataDir);
  t.after(async () => stop(server));

  // Athlete cannot create groups
  let res = await request(server, IDS.athleteA, 'POST', '/api/coach/groups', { name: 'Atleta Grupo' });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'role_forbidden');

  // Coach A creates valid group
  res = await request(server, IDS.coachA, 'POST', '/api/coach/groups', {
    name: 'Grupo Hipertrofia Elite',
    description: 'Desafios de hipertrofia para atletas avançados',
    category: 'hipertrofia',
    maxMembers: 2,
    isPrivate: true,
  });
  assert.equal(res.status, 201);
  const group = res.body.group;
  assert.equal(group.coachId, IDS.coachA);
  assert.equal(group.name, 'Grupo Hipertrofia Elite');
  assert.equal(group.category, 'hipertrofia');
  assert.equal(group.maxMembers, 2);
  assert.equal(group.memberCount, 0);
  assert.ok(group.inviteCode.startsWith('GRP-'));

  // Validation: empty name rejected
  res = await request(server, IDS.coachA, 'POST', '/api/coach/groups', { name: '   ' });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'invalid_name');

  // Coach lists their groups
  res = await request(server, IDS.coachA, 'GET', '/api/coach/groups');
  assert.equal(res.status, 200);
  assert.equal(res.body.groups.length, 1);
  assert.equal(res.body.groups[0].id, group.id);

  // Coach adds Athlete A to group
  res = await request(server, IDS.coachA, 'POST', `/api/coach/groups/${group.id}/members`, {
    athleteId: IDS.athleteA,
    role: 'member',
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.member.athleteId, IDS.athleteA);
  assert.equal(res.body.member.status, 'active');

  // Duplicate active member rejected
  res = await request(server, IDS.coachA, 'POST', `/api/coach/groups/${group.id}/members`, {
    athleteId: IDS.athleteA,
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'already_member');

  // Adding another coach as member rejected
  res = await request(server, IDS.coachA, 'POST', `/api/coach/groups/${group.id}/members`, {
    athleteId: IDS.coachB,
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'invalid_athlete');

  // Coach adds Athlete B (reaches maxMembers: 2)
  res = await request(server, IDS.coachA, 'POST', `/api/coach/groups/${group.id}/members`, {
    athleteId: IDS.athleteB,
  });
  assert.equal(res.status, 201);

  // Third member rejected because capacity is 2
  res = await request(server, IDS.coachA, 'POST', `/api/coach/groups/${group.id}/members`, {
    athleteId: IDS.athleteC,
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'group_full');

  // Coach removes Athlete A from group
  res = await request(server, IDS.coachA, 'DELETE', `/api/coach/groups/${group.id}/members/${IDS.athleteA}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'removed');

  // Group member count is now 1, so Athlete C can now be added
  res = await request(server, IDS.coachA, 'POST', `/api/coach/groups/${group.id}/members`, {
    athleteId: IDS.athleteC,
  });
  assert.equal(res.status, 201);
});

test('2. Entrada por inviteCode e saída voluntária (leave)', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-test-invite-'));
  seed(dataDir);
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const server = await launch(dataDir);
  t.after(async () => stop(server));

  // Coach creates group
  let res = await request(server, IDS.coachA, 'POST', '/api/coach/groups', {
    name: 'Grupo Aberto',
    maxMembers: 10,
  });
  const group = res.body.group;
  const inviteCode = group.inviteCode;

  // Invalid invite code rejected
  res = await request(server, IDS.athleteA, 'POST', '/api/athlete/groups/join', {
    inviteCode: 'GRP-NONEXISTENT',
  });
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'group_not_found');

  // Athlete A joins using inviteCode
  res = await request(server, IDS.athleteA, 'POST', '/api/athlete/groups/join', {
    inviteCode,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.group.id, group.id);
  assert.equal(res.body.member.athleteId, IDS.athleteA);
  assert.equal(res.body.member.status, 'active');

  // Athlete lists their groups
  res = await request(server, IDS.athleteA, 'GET', '/api/athlete/groups');
  assert.equal(res.status, 200);
  assert.equal(res.body.groups.length, 1);
  assert.equal(res.body.groups[0].id, group.id);

  // Athlete leaves group
  res = await request(server, IDS.athleteA, 'POST', `/api/athlete/groups/${group.id}/leave`);
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'left');

  // Athlete groups list is now empty
  res = await request(server, IDS.athleteA, 'GET', '/api/athlete/groups');
  assert.equal(res.status, 200);
  assert.equal(res.body.groups.length, 0);

  // Leaving again returns 404 not_member
  res = await request(server, IDS.athleteA, 'POST', `/api/athlete/groups/${group.id}/leave`);
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'not_member');
});

test('3. Isolamento anti-IDOR entre coaches distintos', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-test-idor-'));
  seed(dataDir);
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const server = await launch(dataDir);
  t.after(async () => stop(server));

  // Coach A creates group and challenge
  let res = await request(server, IDS.coachA, 'POST', '/api/coach/groups', { name: 'Grupo Coach A' });
  const groupA = res.body.group;

  res = await request(server, IDS.coachA, 'POST', '/api/coach/challenges', {
    name: 'Desafio Coach A',
    type: 'workouts_count',
    scope: 'group',
    groupId: groupA.id,
    startAt: '2026-11-01T00:00:00.000Z',
    endAt: '2026-11-30T23:59:59.000Z',
    timeZone: 'UTC',
  });
  const challengeA = res.body.challenge;

  // Coach B cannot view Coach A's group
  res = await request(server, IDS.coachB, 'GET', `/api/coach/groups/${groupA.id}`);
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'access_denied');

  // Coach B cannot modify Coach A's group
  res = await request(server, IDS.coachB, 'PUT', `/api/coach/groups/${groupA.id}`, { name: 'Hacked' });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'access_denied');

  // Coach B cannot delete Coach A's group
  res = await request(server, IDS.coachB, 'DELETE', `/api/coach/groups/${groupA.id}`);
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'access_denied');

  // Coach B cannot view Coach A's challenge
  res = await request(server, IDS.coachB, 'GET', `/api/coach/challenges/${challengeA.id}`);
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'access_denied');

  // Coach B cannot modify Coach A's challenge
  res = await request(server, IDS.coachB, 'PUT', `/api/coach/challenges/${challengeA.id}`, { name: 'Hacked Challenge' });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'access_denied');

  // Coach B cannot delete Coach A's challenge
  res = await request(server, IDS.coachB, 'DELETE', `/api/coach/challenges/${challengeA.id}`);
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'access_denied');

  // Athlete C (not in group) cannot view challenge leaderboard
  res = await request(server, IDS.athleteC, 'GET', `/api/athlete/challenges/${challengeA.id}/leaderboard`);
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'access_denied');
});

test('4. Ciclo de vida de desafios (rascunho draft, ativo active, encerrado archived)', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-test-lifecycle-'));
  seed(dataDir);
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const server = await launch(dataDir);
  t.after(async () => stop(server));

  // Coach creates group and adds Athlete A
  let res = await request(server, IDS.coachA, 'POST', '/api/coach/groups', { name: 'Grupo Ciclo' });
  const group = res.body.group;
  await request(server, IDS.coachA, 'POST', `/api/coach/groups/${group.id}/members`, { athleteId: IDS.athleteA });

  // Coach creates challenge in draft status
  res = await request(server, IDS.coachA, 'POST', '/api/coach/challenges', {
    name: 'Desafio Rascunho',
    type: 'workouts_count',
    scope: 'group',
    groupId: group.id,
    startAt: '2026-11-01T00:00:00.000Z',
    endAt: '2026-11-30T23:59:59.000Z',
    status: 'draft',
  });
  assert.equal(res.status, 201);
  const challenge = res.body.challenge;
  assert.equal(challenge.status, 'draft');

  // Athlete cannot see draft challenge
  res = await request(server, IDS.athleteA, 'GET', `/api/athlete/challenges/${challenge.id}`);
  assert.equal(res.status, 404);

  // Coach activates challenge
  res = await request(server, IDS.coachA, 'PUT', `/api/coach/challenges/${challenge.id}`, {
    status: 'active',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.challenge.status, 'active');

  // Athlete can now see active challenge
  res = await request(server, IDS.athleteA, 'GET', `/api/athlete/challenges/${challenge.id}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.challenge.id, challenge.id);

  // Coach archives challenge
  res = await request(server, IDS.coachA, 'PUT', `/api/coach/challenges/${challenge.id}`, {
    status: 'archived',
  });
  assert.equal(res.status, 200);

  // Athlete challenge list does not show archived challenges
  res = await request(server, IDS.athleteA, 'GET', '/api/athlete/challenges');
  assert.equal(res.status, 200);
  assert.equal(res.body.challenges.some(c => c.id === challenge.id), false);
});

test('5. Atualização de pontuação do Leaderboard e desempate determinístico', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-test-scoring-'));
  seed(dataDir);
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const server = await launch(dataDir);
  t.after(async () => stop(server));

  // Coach A creates group and adds Athlete A and Athlete B
  let res = await request(server, IDS.coachA, 'POST', '/api/coach/groups', { name: 'Grupo Desafio Treinos' });
  const group = res.body.group;
  await request(server, IDS.coachA, 'POST', `/api/coach/groups/${group.id}/members`, { athleteId: IDS.athleteA });
  await request(server, IDS.coachA, 'POST', `/api/coach/groups/${group.id}/members`, { athleteId: IDS.athleteB });

  // 1. workouts_count challenge
  // Athlete A has 2 workouts, Athlete B has 1 workout
  res = await request(server, IDS.coachA, 'POST', '/api/coach/challenges', {
    name: 'Desafio Maior Frequência',
    type: 'workouts_count',
    scope: 'group',
    groupId: group.id,
    startAt: '2026-11-01T00:00:00.000Z',
    endAt: '2026-11-30T23:59:59.000Z',
    timeZone: 'UTC',
    rules: { pointsPerWorkout: 10 },
  });
  const chalWorkouts = res.body.challenge;

  res = await request(server, IDS.coachA, 'GET', `/api/coach/challenges/${chalWorkouts.id}/leaderboard`);
  assert.equal(res.status, 200);
  assert.equal(res.body.leaderboard.length, 2);
  assert.equal(res.body.leaderboard[0].athleteId, IDS.athleteA);
  assert.equal(res.body.leaderboard[0].rank, 1);
  assert.equal(res.body.leaderboard[0].score, 20); // 2 * 10
  assert.equal(res.body.leaderboard[1].athleteId, IDS.athleteB);
  assert.equal(res.body.leaderboard[1].rank, 2);
  assert.equal(res.body.leaderboard[1].score, 10); // 1 * 10

  // 2. volume_load challenge
  // Athlete A has vol: 1500 + 1500 = 3000 kg, Athlete B has vol: 1000 kg
  res = await request(server, IDS.coachA, 'POST', '/api/coach/challenges', {
    name: 'Desafio Volume Total',
    type: 'volume_load',
    scope: 'group',
    groupId: group.id,
    startAt: '2026-11-01T00:00:00.000Z',
    endAt: '2026-11-30T23:59:59.000Z',
  });
  const chalVolume = res.body.challenge;

  res = await request(server, IDS.athleteA, 'GET', `/api/athlete/challenges/${chalVolume.id}/leaderboard`);
  assert.equal(res.status, 200);
  assert.equal(res.body.leaderboard[0].athleteId, IDS.athleteA);
  assert.equal(res.body.leaderboard[0].score, 3000);
  assert.equal(res.body.leaderboard[1].athleteId, IDS.athleteB);
  assert.equal(res.body.leaderboard[1].score, 1000);

  // 3. Tie-breaker verification: two athletes with same score
  // Update state-u_athlete_b to also have 2 workouts totaling 3000 kg, but logged LATER than A
  fs.writeFileSync(path.join(dataDir, `state-${IDS.athleteB}.json`), JSON.stringify({
    unit: 'kg',
    workouts: [
      { id: 'w_b1', d: '2026-11-02', vol: 1500, start: Date.parse('2026-11-02T12:00:00Z') },
      { id: 'w_b2', d: '2026-11-05', vol: 1500, start: Date.parse('2026-11-05T15:00:00Z') }, // later than A's 2026-11-04
    ],
  }, null, 2));

  res = await request(server, IDS.coachA, 'GET', `/api/coach/challenges/${chalVolume.id}/leaderboard`);
  assert.equal(res.status, 200);
  assert.equal(res.body.leaderboard[0].score, 3000);
  assert.equal(res.body.leaderboard[1].score, 3000);
  // Athlete A achieved their last workout on 2026-11-04, before Athlete B on 2026-11-05
  // Deterministic tie-breaker awards rank 1 to Athlete A (earliest completion)
  assert.equal(res.body.leaderboard[0].athleteId, IDS.athleteA);
  assert.equal(res.body.leaderboard[0].rank, 1);
  assert.equal(res.body.leaderboard[1].athleteId, IDS.athleteB);
  assert.equal(res.body.leaderboard[1].rank, 2);
});

test('6. Feed de atividades recentes do desafio', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-test-feed-'));
  const db = baseDb();
  const group = {
    id: 'cgrp_feed_test', coachId: IDS.coachA, name: 'Feed Group', description: '',
    category: 'geral', maxMembers: 10, isPrivate: false, inviteCode: 'GRP-FEED',
    memberCount: 1, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', archivedAt: null,
  };
  const member = {
    id: 'gmem_feed_test', groupId: group.id, coachId: IDS.coachA, athleteId: IDS.athleteA,
    joinedAt: '2026-11-01T00:00:00.000Z', role: 'member', status: 'active',
  };
  const challenge = {
    id: 'chal_feed_test', coachId: IDS.coachA, groupId: group.id, scope: 'group',
    name: 'Feed Challenge', title: 'Feed Challenge', description: '', type: 'workouts_count',
    startAt: '2026-11-01T00:00:00.000Z', endAt: '2026-11-30T23:59:59.000Z', timeZone: 'UTC',
    status: 'active', rules: {}, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
  };
  const feed1 = {
    id: 'caft_1', challengeId: challenge.id, athleteId: IDS.athleteA, athleteName: 'Athlete A',
    activityType: 'workout', description: 'Completou Treino de Pernas', pointsAwarded: 1, timestamp: '2026-11-02T10:00:00.000Z',
  };
  const feed2 = {
    id: 'caft_2', challengeId: challenge.id, athleteId: IDS.athleteA, athleteName: 'Athlete A',
    activityType: 'workout', description: 'Completou Treino de Peito', pointsAwarded: 1, timestamp: '2026-11-04T10:00:00.000Z',
  };
  db.coachGroups = [group];
  db.groupMembers = [member];
  db.challenges = [challenge];
  db.challengeActivityFeed = [feed1, feed2];

  seed(dataDir, db);
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const server = await launch(dataDir);
  t.after(async () => stop(server));

  const res = await request(server, IDS.coachA, 'GET', `/api/coach/challenges/${challenge.id}/leaderboard`);
  assert.equal(res.status, 200);
  assert.equal(res.body.activityFeed.length, 2);
  // Ordered newest first
  assert.equal(res.body.activityFeed[0].id, 'caft_2');
  assert.equal(res.body.activityFeed[1].id, 'caft_1');
});

test('7. Fail-closed no removeAccount() para coach e atleta', async t => {
  const db = baseDb();
  const group = {
    id: 'cgrp_del_coach', coachId: IDS.coachA, name: 'Coach A Group', description: '',
    category: 'geral', maxMembers: 10, isPrivate: false, inviteCode: 'GRP-COACH',
    memberCount: 2, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', archivedAt: null,
  };
  const memberA = {
    id: 'gmem_del_a', groupId: group.id, coachId: IDS.coachA, athleteId: IDS.athleteA,
    joinedAt: '2026-11-01T00:00:00.000Z', role: 'member', status: 'active',
  };
  const memberB = {
    id: 'gmem_del_b', groupId: group.id, coachId: IDS.coachA, athleteId: IDS.athleteB,
    joinedAt: '2026-11-01T00:00:00.000Z', role: 'member', status: 'active',
  };
  const challenge = {
    id: 'chal_del_test', coachId: IDS.coachA, groupId: group.id, scope: 'group',
    name: 'Delete Challenge', title: 'Delete Challenge', description: '', type: 'workouts_count',
    startAt: '2026-11-01T00:00:00.000Z', endAt: '2026-11-30T23:59:59.000Z', timeZone: 'UTC',
    status: 'active', rules: {}, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
  };
  const score = { id: 'cscr_del', challengeId: challenge.id, athleteId: IDS.athleteA, score: 10 };
  const feed = {
    id: 'caft_del', challengeId: challenge.id, athleteId: IDS.athleteA, athleteName: 'Athlete A',
    activityType: 'workout', description: 'Log', pointsAwarded: 1, timestamp: '2026-11-02T10:00:00.000Z',
  };

  db.coachGroups = [group];
  db.groupMembers = [memberA, memberB];
  db.challenges = [challenge];
  db.challengeScores = [score];
  db.challengeActivityFeed = [feed];

  // Test removing Athlete A: memberA removed, memberB remains, group memberCount becomes 1
  removeChallengesUser(db, IDS.athleteA);
  assert.equal(db.coachGroups.length, 1);
  assert.equal(db.coachGroups[0].memberCount, 1);
  assert.equal(db.groupMembers.length, 1);
  assert.equal(db.groupMembers[0].athleteId, IDS.athleteB);
  assert.equal(db.challengeScores.length, 0); // Athlete A's score removed
  assert.equal(db.challengeActivityFeed.length, 0); // Athlete A's feed removed

  // Test removing Coach A: group, challenges, and all remaining members deleted
  removeChallengesUser(db, IDS.coachA);
  assert.equal(db.coachGroups.length, 0);
  assert.equal(db.groupMembers.length, 0);
  assert.equal(db.challenges.length, 0);
});

test('8. Migração fail-closed de schema v8 para v9 e validação de integridade', async t => {
  // 1. Clean migration from v8
  const legacyV8 = {
    schemaVersion: 8,
    users: [], creds: [], subs: [], invites: [],
    coachInvites: [], coachAthleteLinks: [], coachPrescriptions: [], coachAssessments: [],
    mealPlans: [], mealAdherence: [], coachMessages: [], coachHabits: [], habitCheckins: [],
    progressGoals: [], progressReports: [], coachAvailability: [], coachAppointments: [],
  };
  const changed = migrateB2B2C(legacyV8);
  assert.equal(changed, true);
  assert.equal(legacyV8.schemaVersion, B2B2C_SCHEMA_VERSION);
  assert.equal(B2B2C_SCHEMA_VERSION, 9);
  assert.deepEqual(legacyV8.coachGroups, []);
  assert.deepEqual(legacyV8.groupMembers, []);
  assert.deepEqual(legacyV8.challenges, []);
  assert.deepEqual(legacyV8.challengeScores, []);
  assert.deepEqual(legacyV8.challengeActivityFeed, []);

  // 2. Corrupt group record causes fail-closed validation error
  const corruptDb = {
    ...legacyV8,
    coachGroups: [{ id: 'cgrp_corrupt', coachId: 'invalid' }],
  };
  assert.throws(() => validateChallengesState(corruptDb), /coachGroups/);

  // 3. Orphan challenge groupId causes fail-closed validation error
  const orphanChallengeDb = {
    ...legacyV8,
    challenges: [{
      id: 'chal_orphan', coachId: 'u_coach', scope: 'group', groupId: 'cgrp_nonexistent',
      type: 'workouts_count', name: 'Orphan', description: '',
      startAt: '2026-11-01T00:00:00.000Z', endAt: '2026-11-30T00:00:00.000Z', timeZone: 'UTC',
      status: 'active', rules: {}, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
    }],
  };
  assert.throws(() => validateChallengesState(orphanChallengeDb), /groupId/);

  // 4. Inverted dates in challenge cause fail-closed validation error
  const invertedDatesDb = {
    ...legacyV8,
    challenges: [{
      id: 'chal_bad_dates', coachId: 'u_coach', scope: 'coach_students', groupId: null,
      type: 'workouts_count', name: 'Bad Dates', description: '',
      startAt: '2026-11-30T00:00:00.000Z', endAt: '2026-11-01T00:00:00.000Z', timeZone: 'UTC',
      status: 'active', rules: {}, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
    }],
  };
  assert.throws(() => validateChallengesState(invertedDatesDb), /endAt must be after startAt/);
});
