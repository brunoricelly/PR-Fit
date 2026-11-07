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
const COACH_ID = 'u_consent_coach';
const ATHLETE_ID = 'u_consent_athlete';
const LINK_ID = 'cal_consent_current';

function mintSession(uid) {
  const payload = `${uid}:${Date.now() + 86400000}:0:c`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}

function seed(dataDir) {
  const now = '2026-11-07T12:00:00.000Z';
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
    schemaVersion: 7,
    users: [
      { id: COACH_ID, name: 'Consent Coach', profile: { kind: 'coach', coachSpecialties: ['assessments'] } },
      { id: ATHLETE_ID, name: 'Consent Athlete' },
    ],
    creds: [], subs: [], invites: [], deviceLinks: [], coachInvites: [], coachPrescriptions: [],
    coachAssessments: [{
      id: 'cass_consent_1', coachId: COACH_ID, athleteId: ATHLETE_ID, assessedAt: '2026-11-06T10:00:00.000Z',
      createdAt: now, updatedAt: now, weightKg: 80, heightCm: 180, notes: '',
      results: null, requiresMedicalClearance: false, medicalAdviceAcknowledgedAt: null, photoOwnerId: null,
    }],
    mealPlans: [], mealAdherence: [], coachMessages: [], coachHabits: [], habitCheckins: [],
    coachAthleteLinks: [{
      id: LINK_ID, coachId: COACH_ID, athleteId: ATHLETE_ID, scopes: ['assessments'], status: 'active',
      createdAt: '2026-11-01T00:00:00.000Z', acceptedAt: '2026-11-01T00:01:00.000Z', updatedAt: now,
    }],
    progressGoals: [], progressReports: [],
  }, null, 2));
  fs.writeFileSync(path.join(dataDir, `state-${ATHLETE_ID}.json`), JSON.stringify({ unit: 'kg', bodyweight: [], workouts: [] }));
}

async function launch(dataDir) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: '0', DATA_DIR: dataDir, ORIGIN, RP_ID: 'localhost', AUDIT_LOG: '1',
      B2B2C_DB_FAIL_FILE: path.join(dataDir, 'fail-db-write'),
      B2B2C_DB_BACKUP_FAIL_FILE: path.join(dataDir, 'fail-db-backup'),
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
  const text = await response.text();
  const contentType = response.headers.get('content-type') || '';
  return { status: response.status, text, body: text && contentType.includes('application/json') ? JSON.parse(text) : null };
}

test('assessment consent revocation archives dependent goals, revokes reports, rolls back durably and boots', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-progress-consent-'));
  seed(dataDir);
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let server = await launch(dataDir);
  t.after(async () => stop(server));

  const goalResponse = await request(server, COACH_ID, 'POST', `/api/coach/athletes/${ATHLETE_ID}/progress-goals?linkId=${LINK_ID}`, {
    metric: 'body_weight', direction: 'decrease', baselineValue: 80, targetValue: 75, tolerance: 0.5,
    startDate: '2026-11-01', targetDate: '2026-12-31', timezone: 'UTC',
  });
  assert.equal(goalResponse.status, 201, goalResponse.text);
  const goalId = goalResponse.body.goal.id;

  const reportResponse = await request(server, COACH_ID, 'POST', `/api/coach/athletes/${ATHLETE_ID}/progress-reports?linkId=${LINK_ID}`, {
    period: 7, timezone: 'UTC', metrics: ['body_weight'],
  });
  assert.equal(reportResponse.status, 201, reportResponse.text);
  const reportId = reportResponse.body.report.id;

  const beforeFailure = fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8');
  fs.writeFileSync(path.join(dataDir, 'fail-db-backup'), 'once');
  let response = await request(server, ATHLETE_ID, 'POST', `/api/athlete/coaches/${LINK_ID}/assessment-consent`, { granted: false });
  assert.deepEqual([response.status, response.body.code], [503, 'storage_unavailable']);
  assert.equal(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'), beforeFailure);
  response = await request(server, COACH_ID, 'GET', `/api/coach/athletes/${ATHLETE_ID}/progress-reports/${reportId}?linkId=${LINK_ID}`);
  assert.equal(response.status, 200, 'failed persistence must not revoke the in-memory report');

  response = await request(server, ATHLETE_ID, 'POST', `/api/athlete/coaches/${LINK_ID}/assessment-consent`, { granted: false });
  assert.equal(response.status, 200, response.text);

  const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
  const goal = stored.progressGoals.find(item => item.id === goalId);
  const report = stored.progressReports.find(item => item.id === reportId);
  assert.equal(goal.status, 'archived');
  assert.equal(typeof goal.archivedAt, 'string');
  assert.equal(typeof report.revokedAt, 'string');
  assert.deepEqual(report.revocation, { reason: 'scope_revoked', scope: 'assessments', actorId: ATHLETE_ID, at: report.revokedAt });

  for (const suffix of ['', '/export?format=json', '/export?format=csv']) {
    response = await request(server, COACH_ID, 'GET', `/api/coach/athletes/${ATHLETE_ID}/progress-reports/${reportId}${suffix}${suffix ? '&' : '?'}linkId=${LINK_ID}`);
    assert.deepEqual([response.status, response.body.code], [410, 'report_revoked']);
    assert.equal(response.text.includes('snapshot'), false);
  }

  await stop(server);
  server = await launch(dataDir);
  response = await fetch(server.api + '/api/health');
  assert.equal(response.status, 200, server.log());
  response = await request(server, COACH_ID, 'GET', `/api/coach/athletes/${ATHLETE_ID}/progress-reports/${reportId}?linkId=${LINK_ID}`);
  assert.deepEqual([response.status, response.body.code], [410, 'report_revoked']);
});
