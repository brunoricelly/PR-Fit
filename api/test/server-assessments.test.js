import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers.mjs';
import * as mediaSamples from './media-samples.mjs';

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
    schemaVersion: 4,
    users: [
      { id: IDS.coachA, name: 'Coach A', profile: { kind: 'coach', coachSpecialties: ['training', 'assessments'] } },
      { id: IDS.coachB, name: 'Coach B', profile: { kind: 'coach', coachSpecialties: ['training', 'assessments'] } },
      { id: IDS.athleteA, name: 'Athlete A' },
      { id: IDS.athleteB, name: 'Athlete B' },
    ],
    creds: [], subs: [], invites: [], coachInvites: [], coachPrescriptions: [],
    coachAthleteLinks: [
      { id: 'cal_a_a', coachId: IDS.coachA, athleteId: IDS.athleteA, scopes: ['training', 'assessments'], status: 'active', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' },
      { id: 'cal_b_a', coachId: IDS.coachB, athleteId: IDS.athleteA, scopes: ['training', 'assessments'], status: 'active', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' },
      { id: 'cal_a_b', coachId: IDS.coachA, athleteId: IDS.athleteB, scopes: ['training'], status: 'active', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' },
    ],
  }, null, 2));
}

async function launch(dataDir, env = {}) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN, RP_ID: 'localhost', AUDIT_LOG: '1',
      B2B2C_ASSESSMENTS_PER_ATHLETE: '2', B2B2C_MAX_ASSESSMENTS: '4',
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
    headers: { Cookie: `gymsid=${mintSession(uid)}`, Origin: ORIGIN, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

async function rawRequest(server, uid, method, route, body, contentType) {
  return fetch(server.api + route, {
    method,
    headers: { Cookie: `gymsid=${mintSession(uid)}`, Origin: ORIGIN, ...(contentType ? { 'Content-Type': contentType } : {}) },
    ...(body === undefined ? {} : { body }),
  });
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

  let consent = await request(server, IDS.coachA, 'GET', `/api/coach/athletes/${IDS.athleteB}/assessments`);
  assert.deepEqual([consent.status, consent.body.code], [403, 'scope_forbidden'], 'training scope does not grant health access');
  consent = await request(server, IDS.coachB, 'POST', '/api/athlete/coaches/cal_a_b/assessment-consent', { granted: true });
  assert.deepEqual([consent.status, consent.body.code], [404, 'relationship_not_found']);
  consent = await request(server, IDS.athleteB, 'POST', '/api/athlete/coaches/cal_a_b/assessment-consent', { granted: true });
  assert.equal(consent.status, 200);
  assert.ok(consent.body.link.scopes.includes('assessments'));
  assert.equal((await request(server, IDS.coachA, 'GET', `/api/coach/athletes/${IDS.athleteB}/assessments`)).status, 200);
  fs.writeFileSync(path.join(dataDir, 'fail-db-write'), 'once');
  const failedRevoke = await request(server, IDS.athleteB, 'POST', '/api/athlete/coaches/cal_a_b/assessment-consent', { granted: false });
  assert.deepEqual([failedRevoke.status, failedRevoke.body.code], [503, 'storage_unavailable']);
  assert.equal((await request(server, IDS.coachA, 'GET', `/api/coach/athletes/${IDS.athleteB}/assessments`)).status, 200, 'failed consent write leaves access unchanged');
  consent = await request(server, IDS.athleteB, 'POST', '/api/athlete/coaches/cal_a_b/assessment-consent', { granted: false });
  assert.equal(consent.status, 200);
  assert.equal((await request(server, IDS.coachA, 'GET', `/api/coach/athletes/${IDS.athleteB}/assessments`)).status, 403);
  assert.equal((await request(server, IDS.athleteB, 'POST', '/api/athlete/coaches/cal_a_b/assessment-consent', { granted: true })).status, 200);

  const invalidPayloads = [
    { skinfolds: { triceps: 0 } },
    { circumferences: { waist: 301 } },
    { bioimpedance: { bodyFatPercent: 101 } },
    { parq: { answers: [false, false] } },
    { assessedAt: '2126-01-01T00:00:00.000Z', bioimpedance: { bodyFatPercent: 20 } },
    { assessedAt: '1900-01-01T00:00:00.000Z', bioimpedance: { bodyFatPercent: 20 } },
    { weightKg: 80, skinfolds: { protocol: 'pollock3', sex: 'male', age: 1, chest: 0.1, abdomen: 0.1, thigh: 0.1 } },
  ];
  for (const payload of invalidPayloads) {
    const invalid = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/assessments`, payload);
    assert.deepEqual([invalid.status, invalid.body.code], [400, 'invalid_assessment']);
  }
  const photoBytes = mediaSamples.jpeg(1000);
  const photoHash = mediaSamples.sha(photoBytes);
  assert.equal((await rawRequest(server, IDS.coachA, 'PUT', `/api/media/${photoHash}`, photoBytes, 'image/jpeg')).status, 201);
  const highBoundary = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteB}/assessments`, {
    weightKg: 80, skinfolds: { protocol: 'pollock7', sex: 'male', age: 120, chest: 100, midaxillary: 100, triceps: 100, subscapular: 100, abdomen: 100, suprailiac: 100, thigh: 100 },
    photos: [{ kind: 'image', hash: photoHash, mime: 'image/jpeg', size: photoBytes.length, width: 100, height: 100 }],
  });
  assert.equal(highBoundary.status, 201);
  assert.ok(highBoundary.body.assessment.results.bodyFatPercent >= 0 && highBoundary.body.assessment.results.bodyFatPercent <= 100);
  const photoRoute = highBoundary.body.assessment.photos[0].url;
  assert.equal((await rawRequest(server, IDS.coachA, 'GET', photoRoute)).status, 200);
  assert.equal((await rawRequest(server, IDS.athleteB, 'GET', photoRoute)).status, 200);
  assert.equal((await rawRequest(server, IDS.coachB, 'GET', photoRoute)).status, 404);
  assert.equal((await request(server, IDS.coachA, 'DELETE', `/api/coach/athletes/${IDS.athleteB}/assessments/${highBoundary.body.assessment.id}`)).status, 200);
  assert.equal(fs.existsSync(path.join(dataDir, 'uploads', IDS.coachA, `${photoHash}.jpg`)), false, 'last assessment photo reference removes the blob');

  const beforeFailedCreate = fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8');
  fs.writeFileSync(path.join(dataDir, 'fail-db-write'), 'once');
  const failedCreate = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/assessments`, validAssessment);
  assert.deepEqual([failedCreate.status, failedCreate.body.code], [503, 'storage_unavailable']);
  assert.equal(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'), beforeFailedCreate);
  assert.deepEqual((await request(server, IDS.athleteA, 'GET', '/api/athlete/assessments')).body.assessments, []);

  let result = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/assessments`, validAssessment);
  assert.equal(result.status, 201, JSON.stringify(result.body));
  const assessmentId = result.body.assessment.id;
  assert.equal(result.body.assessment.coach.name, 'Coach A');
  assert.equal(result.body.assessment.athlete.name, 'Athlete A');
  assert.equal(JSON.stringify(result.body).includes(IDS.coachA), false);
  assert.ok(result.body.assessment.results.density > 1);
  assert.ok(result.body.assessment.results.bodyFatPercent > 0);
  assert.equal(result.body.assessment.results.fatMassKg + result.body.assessment.results.leanMassKg, 80);

  fs.writeFileSync(path.join(dataDir, 'fail-db-write'), 'once');
  const failedDelete = await request(server, IDS.coachA, 'DELETE', `/api/coach/athletes/${IDS.athleteA}/assessments/${assessmentId}`);
  assert.deepEqual([failedDelete.status, failedDelete.body.code], [503, 'storage_unavailable']);
  assert.equal((await request(server, IDS.coachA, 'GET', `/api/coach/athletes/${IDS.athleteA}/assessments/${assessmentId}`)).status, 200);
  await stop(server);
  server = await launch(dataDir);
  assert.equal((await request(server, IDS.coachA, 'GET', `/api/coach/athletes/${IDS.athleteA}/assessments/${assessmentId}`)).status, 200);

  result = await request(server, IDS.coachA, 'GET', `/api/coach/athletes/${IDS.athleteA}/assessments/${assessmentId}`);
  assert.equal(result.status, 200);
  assert.equal(result.body.assessment.notes, validAssessment.notes);

  fs.writeFileSync(path.join(dataDir, 'fail-db-write'), 'once');
  const failedCorrection = await request(server, IDS.coachA, 'PATCH', `/api/coach/athletes/${IDS.athleteA}/assessments/${assessmentId}`, {
    ...validAssessment, notes: 'Must not survive',
  });
  assert.deepEqual([failedCorrection.status, failedCorrection.body.code], [503, 'storage_unavailable']);
  assert.equal((await request(server, IDS.coachA, 'GET', `/api/coach/athletes/${IDS.athleteA}/assessments/${assessmentId}`)).body.assessment.notes, validAssessment.notes);
  const corrected = await request(server, IDS.coachA, 'PATCH', `/api/coach/athletes/${IDS.athleteA}/assessments/${assessmentId}`, {
    ...validAssessment, notes: 'Avaliação corrigida',
  });
  assert.equal(corrected.status, 200);
  assert.equal(corrected.body.assessment.notes, 'Avaliação corrigida');

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

  result = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteB}/assessments`, {
    parq: { answers: [false, false, false, false, false, false, true], notes: 'Requer liberação.', acknowledged: true },
  });
  assert.equal(result.status, 201);
  assert.equal(result.body.assessment.requiresMedicalClearance, true);
  assert.match(result.body.assessment.medicalClearanceNotice, /not a diagnosis/i);
  assert.ok(result.body.assessment.medicalAdviceAcknowledgedAt);
  assert.equal(result.body.assessment.parq.answers[6].questionId, 'other_reason');
  assert.ok(result.body.assessment.parq.answers[6].text);

  result = await request(server, IDS.coachB, 'POST', `/api/coach/athletes/${IDS.athleteA}/assessments`, {
    circumferences: { waist: 82 }, notes: 'Segundo profissional',
  });
  assert.equal(result.status, 201);
  const fairShare = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/assessments`, {
    bioimpedance: { bodyFatPercent: 14 },
  });
  assert.equal(fairShare.status, 201, 'another professional cannot consume this coach-athlete quota');

  const pairCapacity = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/assessments`, {
    circumferences: { hip: 99 },
  });
  assert.deepEqual([pairCapacity.status, pairCapacity.body.code], [409, 'assessment_capacity']);
  const globalCapacity = await request(server, IDS.coachB, 'POST', `/api/coach/athletes/${IDS.athleteA}/assessments`, { circumferences: { hip: 99 } });
  assert.deepEqual([globalCapacity.status, globalCapacity.body.code], [409, 'assessment_capacity']);

  await stop(server);
  server = await launch(dataDir);
  result = await request(server, IDS.athleteA, 'GET', '/api/athlete/assessments');
  assert.equal(result.body.assessments.length, 3);

  fs.writeFileSync(path.join(dataDir, 'fail-db-write'), 'once');
  const failedOwnDelete = await request(server, IDS.athleteA, 'DELETE', `/api/athlete/assessments/${fairShare.body.assessment.id}`, { confirmation: fairShare.body.assessment.id });
  assert.deepEqual([failedOwnDelete.status, failedOwnDelete.body.code], [503, 'storage_unavailable']);
  assert.equal((await request(server, IDS.athleteA, 'GET', '/api/athlete/assessments')).body.assessments.length, 3);
  assert.equal((await request(server, IDS.athleteA, 'DELETE', `/api/athlete/assessments/${fairShare.body.assessment.id}`, { confirmation: fairShare.body.assessment.id })).status, 200);

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

test('assessment creation is throttled per account and address', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-assessments-rate-'));
  seed(dataDir);
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const server = await launch(dataDir, {
    B2B2C_ASSESSMENT_CREATE_ACCOUNT_MAX: '1',
    B2B2C_ASSESSMENT_CREATE_IP_MAX: '2',
    B2B2C_RATE_WINDOW_MS: '60000',
  });
  t.after(async () => stop(server));

  assert.equal((await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/assessments`, validAssessment)).status, 201);
  const limited = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/assessments`, {
    bioimpedance: { bodyFatPercent: 20 },
  });
  assert.deepEqual([limited.status, limited.body.code], [429, 'rate_limited']);
});
