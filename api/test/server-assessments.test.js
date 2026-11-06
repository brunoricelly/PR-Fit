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

function seed(dataDir) {
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
    schemaVersion: 3,
    users: [
      { id: IDS.coachA, name: 'Coach A', profile: { kind: 'coach', coachSpecialties: ['training'] } },
      { id: IDS.coachB, name: 'Coach B', profile: { kind: 'coach', coachSpecialties: ['training'] } },
      { id: IDS.athleteA, name: 'Athlete A' },
      { id: IDS.athleteB, name: 'Athlete B' },
    ],
    creds: [], subs: [], invites: [], coachInvites: [], coachPrescriptions: [],
    coachAthleteLinks: [
      { id: 'cal_a_a', coachId: IDS.coachA, athleteId: IDS.athleteA, scopes: ['training'], status: 'active', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' },
      { id: 'cal_b_a', coachId: IDS.coachB, athleteId: IDS.athleteA, scopes: ['training'], status: 'active', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' },
      { id: 'cal_a_b', coachId: IDS.coachA, athleteId: IDS.athleteB, scopes: ['training'], status: 'active', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' },
    ],
  }, null, 2));
}

async function launch(dataDir) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN, RP_ID: 'localhost', AUDIT_LOG: '1',
      B2B2C_ASSESSMENTS_PER_ATHLETE: '2', B2B2C_MAX_ASSESSMENTS: '3',
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
    headers: { Cookie: `gymsid=${mintSession(uid)}`, Origin: ORIGIN, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

const validAssessment = {
  assessedAt: '2026-11-05T10:00:00.000Z',
  weightKg: 80,
  heightCm: 180,
  skinfolds: { protocol: 'pollock3', sex: 'male', age: 30, chest: 10, abdomen: 15, thigh: 12 },
  circumferences: { chest: 102, waist: 84, arm: 36 },
  bioimpedance: { bodyFatPercent: 15, muscleMassKg: 62, waterPercent: 58 },
  parq: { answers: [false, false, false, false, false, false, false], notes: '' },
  notes: 'Avaliação inicial',
};

test('assessment endpoints validate, isolate, persist and enforce bounded storage', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-assessments-'));
  seed(dataDir);
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let server = await launch(dataDir);
  t.after(async () => stop(server));

  let stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
  assert.deepEqual(stored.coachAssessments, [], 'migration initializes assessment storage');

  const invalidPayloads = [
    { skinfolds: { triceps: 0 } },
    { circumferences: { waist: 301 } },
    { bioimpedance: { bodyFatPercent: 101 } },
    { parq: { answers: [false, false] } },
  ];
  for (const payload of invalidPayloads) {
    const invalid = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/assessments`, payload);
    assert.deepEqual([invalid.status, invalid.body.code], [400, 'invalid_assessment']);
  }

  let result = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/assessments`, validAssessment);
  assert.equal(result.status, 201, JSON.stringify(result.body));
  const assessmentId = result.body.assessment.id;
  assert.equal(result.body.assessment.coach.id, IDS.coachA);
  assert.equal(result.body.assessment.athlete.id, IDS.athleteA);
  assert.ok(result.body.assessment.results.density > 1);
  assert.ok(result.body.assessment.results.bodyFatPercent > 0);
  assert.equal(result.body.assessment.results.fatMassKg + result.body.assessment.results.leanMassKg, 80);

  result = await request(server, IDS.coachA, 'GET', `/api/coach/athletes/${IDS.athleteA}/assessments/${assessmentId}`);
  assert.equal(result.status, 200);
  assert.equal(result.body.assessment.notes, validAssessment.notes);

  const otherCoachRead = await request(server, IDS.coachB, 'GET', `/api/coach/athletes/${IDS.athleteA}/assessments/${assessmentId}`);
  assert.deepEqual([otherCoachRead.status, otherCoachRead.body.code], [404, 'assessment_not_found']);
  const otherCoachDelete = await request(server, IDS.coachB, 'DELETE', `/api/coach/athletes/${IDS.athleteA}/assessments/${assessmentId}`);
  assert.deepEqual([otherCoachDelete.status, otherCoachDelete.body.code], [404, 'assessment_not_found']);
  const mismatchedAthlete = await request(server, IDS.coachA, 'GET', `/api/coach/athletes/${IDS.athleteB}/assessments/${assessmentId}`);
  assert.deepEqual([mismatchedAthlete.status, mismatchedAthlete.body.code], [404, 'assessment_not_found']);

  const ownHistory = await request(server, IDS.athleteA, 'GET', '/api/athlete/assessments');
  assert.deepEqual(ownHistory.body.assessments.map(item => item.id), [assessmentId]);
  const otherHistory = await request(server, IDS.athleteB, 'GET', '/api/athlete/assessments');
  assert.deepEqual(otherHistory.body.assessments, []);

  result = await request(server, IDS.coachB, 'POST', `/api/coach/athletes/${IDS.athleteA}/assessments`, {
    circumferences: { waist: 82 }, notes: 'Segundo profissional',
  });
  assert.equal(result.status, 201);
  const athleteCapacity = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/assessments`, {
    bioimpedance: { bodyFatPercent: 14 },
  });
  assert.deepEqual([athleteCapacity.status, athleteCapacity.body.code], [409, 'assessment_capacity']);

  result = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteB}/assessments`, {
    parq: { answers: [false, false, false, false, false, false, true], notes: 'Requer liberação.' },
  });
  assert.equal(result.status, 201);
  const globalCapacity = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteB}/assessments`, {
    circumferences: { hip: 99 },
  });
  assert.deepEqual([globalCapacity.status, globalCapacity.body.code], [409, 'assessment_capacity']);

  await stop(server);
  server = await launch(dataDir);
  result = await request(server, IDS.athleteA, 'GET', '/api/athlete/assessments');
  assert.equal(result.body.assessments.length, 2);

  const deleted = await request(server, IDS.coachA, 'DELETE', `/api/coach/athletes/${IDS.athleteA}/assessments/${assessmentId}`);
  assert.equal(deleted.status, 200);
  stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
  assert.equal(stored.coachAssessments.some(item => item.id === assessmentId), false);

  const audit = fs.readFileSync(path.join(dataDir, 'audit.log'), 'utf8');
  for (const event of ['b2b2c.assessment.create', 'b2b2c.assessment.read', 'b2b2c.assessment.delete', 'b2b2c.assessment.create.denied']) {
    assert.match(audit, new RegExp(event));
  }
  assert.match(audit, /assessment_not_found/);
  assert.match(audit, /assessment_capacity/);
});
