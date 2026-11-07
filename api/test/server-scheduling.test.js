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

const IDS = {
  coachA: 'u_sched_coach_a',
  coachB: 'u_sched_coach_b',
  athleteA: 'u_sched_athlete_a',
  athleteB: 'u_sched_athlete_b',
};

function mintSession(uid) {
  const payload = `${uid}:${Date.now() + 86400000}:0:c`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}

function baseDb() {
  const now = new Date().toISOString();
  return {
    schemaVersion: 8,
    users: [
      { id: IDS.coachA, name: 'Coach A', admin: true, profile: { kind: 'coach', coachSpecialties: ['training'] } },
      { id: IDS.coachB, name: 'Coach B', profile: { kind: 'coach', coachSpecialties: ['training'] } },
      { id: IDS.athleteA, name: 'Athlete A', profile: { kind: 'athlete' } },
      { id: IDS.athleteB, name: 'Athlete B', profile: { kind: 'athlete' } },
    ],
    creds: [], subs: [], invites: [], deviceLinks: [], watchLinks: [],
    coachInvites: [], coachPrescriptions: [], coachAssessments: [],
    mealPlans: [], mealAdherence: [], coachMessages: [], coachHabits: [], habitCheckins: [],
    progressGoals: [], progressReports: [], accountCleanupJobs: [],
    coachAthleteLinks: [
      { id: 'cal_aa', coachId: IDS.coachA, athleteId: IDS.athleteA, scopes: ['training'], status: 'active', createdAt: now, updatedAt: now },
      { id: 'cal_ba', coachId: IDS.coachB, athleteId: IDS.athleteA, scopes: ['training'], status: 'active', createdAt: now, updatedAt: now },
      { id: 'cal_bb', coachId: IDS.coachB, athleteId: IDS.athleteB, scopes: ['training'], status: 'active', createdAt: now, updatedAt: now },
    ],
    coachAvailability: [],
    coachAppointments: [
      {
        id: 'capp_past_session',
        linkId: 'cal_aa',
        coachId: IDS.coachA,
        athleteId: IDS.athleteA,
        type: 'in_person',
        title: 'Treino Passado',
        notes: '',
        startAt: '2026-01-01T10:00:00.000Z',
        endAt: '2026-01-01T11:00:00.000Z',
        status: 'scheduled',
        canceledBy: null,
        cancelReason: null,
        location: null,
        meetingUrl: null,
        attendance: null,
        createdAt: '2026-01-01T09:00:00.000Z',
        updatedAt: '2026-01-01T09:00:00.000Z',
      },
    ],
  };
}

function seed(dataDir, customDb = null) {
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify(customDb || baseDb(), null, 2));
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

test('1. Configuração de disponibilidade e validação de regras de janelas e fusos horários', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-sched-avail-'));
  seed(dataDir);
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const server = await launch(dataDir);
  t.after(async () => stop(server));

  // Initially coach has no availability
  let res = await request(server, IDS.coachA, 'GET', '/api/coach/availability');
  assert.equal(res.status, 200);
  assert.equal(res.body.availability, null);

  // Rejects invalid timezone
  res = await request(server, IDS.coachA, 'PUT', '/api/coach/availability', {
    timezone: 'Invalid/NonExistent_Zone',
    windows: [{ dayOfWeek: 1, start: '08:00', end: '12:00' }],
  });
  assert.equal(res.status, 400);

  // Rejects invalid window times (start >= end)
  res = await request(server, IDS.coachA, 'PUT', '/api/coach/availability', {
    timezone: 'America/Sao_Paulo',
    windows: [{ dayOfWeek: 1, start: '14:00', end: '10:00' }],
  });
  assert.equal(res.status, 400);

  // Rejects overlapping windows on same day
  res = await request(server, IDS.coachA, 'PUT', '/api/coach/availability', {
    timezone: 'America/Sao_Paulo',
    windows: [
      { dayOfWeek: 1, start: '08:00', end: '12:00' },
      { dayOfWeek: 1, start: '11:00', end: '15:00' },
    ],
  });
  assert.equal(res.status, 400);

  // Rejects invalid duration
  res = await request(server, IDS.coachA, 'PUT', '/api/coach/availability', {
    timezone: 'America/Sao_Paulo',
    sessionDurationMinutes: 5,
    windows: [{ dayOfWeek: 1, start: '08:00', end: '12:00' }],
  });
  assert.equal(res.status, 400);

  // Athlete forbidden from coach availability endpoint
  res = await request(server, IDS.athleteA, 'PUT', '/api/coach/availability', {
    timezone: 'America/Sao_Paulo',
    windows: [{ dayOfWeek: 1, start: '08:00', end: '12:00' }],
  });
  assert.equal(res.status, 403);

  // Valid availability configuration saves successfully
  const validConfig = {
    timezone: 'America/Sao_Paulo',
    sessionDurationMinutes: 60,
    bufferMinutes: 15,
    minNoticeHours: 2,
    maxAdvanceDays: 365,
    windows: [
      { dayOfWeek: 1, start: '08:00', end: '12:00' },
      { dayOfWeek: 3, start: '14:00', end: '18:00' },
      { dayOfWeek: 5, start: '09:00', end: '12:00' },
    ],
  };
  res = await request(server, IDS.coachA, 'PUT', '/api/coach/availability', validConfig);
  assert.equal(res.status, 200);
  assert.equal(res.body.availability.coachId, IDS.coachA);
  assert.equal(res.body.availability.timeZone, 'America/Sao_Paulo');
  assert.equal(res.body.availability.sessionDurationMinutes, 60);
  assert.equal(res.body.availability.bufferMinutes, 15);
  assert.equal(res.body.availability.windows.length, 3);

  // GET returns saved availability
  res = await request(server, IDS.coachA, 'GET', '/api/coach/availability');
  assert.equal(res.status, 200);
  assert.equal(res.body.availability.timeZone, 'America/Sao_Paulo');
  assert.equal(res.body.availability.sessionDurationMinutes, 60);
});

test('2. Cálculo de slots disponíveis e bloqueio de horários já reservados', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-sched-slots-'));
  seed(dataDir);
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const server = await launch(dataDir);
  t.after(async () => stop(server));

  // Configure coach availability: all days 08:00 to 11:00 with 60m duration and 0 buffer
  await request(server, IDS.coachA, 'PUT', '/api/coach/availability', {
    timezone: 'UTC',
    sessionDurationMinutes: 60,
    bufferMinutes: 0,
    minNoticeHours: 0,
    maxAdvanceDays: 365,
    windows: [0, 1, 2, 3, 4, 5, 6].map(d => ({ dayOfWeek: d, start: '08:00', end: '11:00' })),
  });

  // Query slots for a future day (e.g. 2026-12-01)
  let res = await request(server, IDS.athleteA, 'GET', `/api/athlete/coaches/${IDS.coachA}/availability-slots?date=2026-12-01`);
  assert.equal(res.status, 200);
  assert.equal(res.body.timeZone, 'UTC');
  // 08:00-09:00, 09:00-10:00, 10:00-11:00 => 3 slots
  assert.equal(res.body.items.length, 3);
  assert.equal(res.body.items[0].startAt, '2026-12-01T08:00:00.000Z');
  assert.equal(res.body.items[0].endAt, '2026-12-01T09:00:00.000Z');
  assert.equal(res.body.items[1].startAt, '2026-12-01T09:00:00.000Z');
  assert.equal(res.body.items[2].startAt, '2026-12-01T10:00:00.000Z');

  // Book middle slot (09:00 to 10:00)
  const bookRes = await request(server, IDS.athleteA, 'POST', `/api/athlete/coaches/${IDS.coachA}/appointments`, {
    startAt: '2026-12-01T09:00:00.000Z',
    endAt: '2026-12-01T10:00:00.000Z',
    title: 'Sessão Manhã',
  });
  assert.equal(bookRes.status, 201);
  assert.equal(bookRes.body.appointment.status, 'scheduled');

  // Re-check available slots: 09:00 slot is now blocked!
  res = await request(server, IDS.athleteA, 'GET', `/api/athlete/coaches/${IDS.coachA}/availability-slots?date=2026-12-01`);
  assert.equal(res.status, 200);
  assert.equal(res.body.items.length, 2);
  assert.equal(res.body.items[0].startAt, '2026-12-01T08:00:00.000Z');
  assert.equal(res.body.items[1].startAt, '2026-12-01T10:00:00.000Z');
});

test('3. Prevenção de conflito (double-booking) simultâneo', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-sched-conflict-'));
  seed(dataDir);
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const server = await launch(dataDir);
  t.after(async () => stop(server));

  await request(server, IDS.coachA, 'PUT', '/api/coach/availability', {
    timezone: 'UTC', sessionDurationMinutes: 60, bufferMinutes: 15, minNoticeHours: 0, maxAdvanceDays: 365,
    windows: [0, 1, 2, 3, 4, 5, 6].map(d => ({ dayOfWeek: d, start: '08:00', end: '18:00' })),
  });
  await request(server, IDS.coachB, 'PUT', '/api/coach/availability', {
    timezone: 'UTC', sessionDurationMinutes: 60, bufferMinutes: 0, minNoticeHours: 0, maxAdvanceDays: 365,
    windows: [0, 1, 2, 3, 4, 5, 6].map(d => ({ dayOfWeek: d, start: '08:00', end: '18:00' })),
  });

  // Coach A schedules an aligned appointment with Athlete A.
  const app = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/appointments`, {
    startAt: '2026-12-02T10:30:00.000Z',
    endAt: '2026-12-02T11:30:00.000Z',
    title: 'Treino A',
  });
  assert.equal(app.status, 201);

  // Double-booking check: the same aligned slot cannot be booked twice.
  let conflictRes = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/appointments`, {
    startAt: '2026-12-02T10:30:00.000Z',
    endAt: '2026-12-02T11:30:00.000Z',
    title: 'Treino Overlap',
  });
  assert.equal(conflictRes.status, 409);
  assert.equal(conflictRes.body.code, 'double_booking');

  // Buffer check: Coach A has 15min buffer, so 11:05 - 12:05 conflicts with previous 10:00 - 11:00 session
  conflictRes = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/appointments`, {
    startAt: '2026-12-02T11:05:00.000Z',
    endAt: '2026-12-02T12:05:00.000Z',
  });
  assert.equal(conflictRes.status, 400);
  assert.equal(conflictRes.body.code, 'invalid_slot');

  // Athlete double-booking across coaches is blocked.
  conflictRes = await request(server, IDS.athleteA, 'POST', `/api/athlete/coaches/${IDS.coachB}/appointments`, {
    startAt: '2026-12-02T10:00:00.000Z',
    endAt: '2026-12-02T11:00:00.000Z',
  });
  assert.equal(conflictRes.status, 409);
  assert.equal(conflictRes.body.code, 'double_booking');
});

test('4. Criação de agendamentos por coach e por atleta respeitando autorização de vínculo', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-sched-auth-'));
  seed(dataDir);
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const server = await launch(dataDir);
  t.after(async () => stop(server));

  await request(server, IDS.coachA, 'PUT', '/api/coach/availability', {
    timezone: 'UTC', sessionDurationMinutes: 60, bufferMinutes: 0, minNoticeHours: 0, maxAdvanceDays: 365,
    windows: [0, 1, 2, 3, 4, 5, 6].map(d => ({ dayOfWeek: d, start: '08:00', end: '18:00' })),
  });

  // Coach A is NOT linked to Athlete B!
  let res = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteB}/appointments`, {
    startAt: '2026-12-03T10:00:00.000Z',
    endAt: '2026-12-03T11:00:00.000Z',
  });
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'relationship_not_found');

  // Athlete B is NOT linked to Coach A!
  res = await request(server, IDS.athleteB, 'POST', `/api/athlete/coaches/${IDS.coachA}/appointments`, {
    startAt: '2026-12-03T10:00:00.000Z',
    endAt: '2026-12-03T11:00:00.000Z',
  });
  assert.equal(res.status, 404);

  // Athlete A is linked to Coach A: booking succeeds
  res = await request(server, IDS.athleteA, 'POST', `/api/athlete/coaches/${IDS.coachA}/appointments`, {
    startAt: '2026-12-03T10:00:00.000Z',
    endAt: '2026-12-03T11:00:00.000Z',
    title: 'Sessão Válida',
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.appointment.coachId, IDS.coachA);
  assert.equal(res.body.appointment.athleteId, IDS.athleteA);
});

test('5. Bloqueio anti-IDOR: coach A não acessa nem altera agendamentos do coach B; atleta A não vê agendamentos do atleta B', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-sched-idor-'));
  seed(dataDir);
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const server = await launch(dataDir);
  t.after(async () => stop(server));

  await request(server, IDS.coachB, 'PUT', '/api/coach/availability', {
    timezone: 'UTC', sessionDurationMinutes: 60, bufferMinutes: 0, minNoticeHours: 0, maxAdvanceDays: 365,
    windows: [0, 1, 2, 3, 4, 5, 6].map(d => ({ dayOfWeek: d, start: '08:00', end: '18:00' })),
  });

  // Coach B creates appointment with Athlete B
  const bRes = await request(server, IDS.coachB, 'POST', `/api/coach/athletes/${IDS.athleteB}/appointments`, {
    startAt: '2026-12-04T14:00:00.000Z',
    endAt: '2026-12-04T15:00:00.000Z',
    title: 'Sessão B Secreta',
  });
  assert.equal(bRes.status, 201);
  const appBId = bRes.body.appointment.id;

  // Coach A tries to modify Coach B's appointment => 404
  let res = await request(server, IDS.coachA, 'PATCH', `/api/coach/appointments/${appBId}`, {
    title: 'Hacked by Coach A',
  });
  assert.equal(res.status, 404);

  // Coach A tries to mark attendance on Coach B's appointment => 404
  res = await request(server, IDS.coachA, 'POST', `/api/coach/appointments/${appBId}/attendance`, {
    status: 'completed',
  });
  assert.equal(res.status, 404);

  // Athlete A tries to cancel Athlete B's appointment => 404
  res = await request(server, IDS.athleteA, 'POST', `/api/athlete/appointments/${appBId}/cancel`, {
    reason: 'Hacked by Athlete A',
  });
  assert.equal(res.status, 404);

  // Athlete A listing their own appointments does NOT see Athlete B's appointment
  res = await request(server, IDS.athleteA, 'GET', '/api/athlete/appointments');
  assert.equal(res.status, 200);
  assert.equal(res.body.items.some(a => a.id === appBId), false);
});

test('6. Cancelamento por ambas as partes e atualização de status de presença', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-sched-lifecycle-'));
  seed(dataDir);
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const server = await launch(dataDir);
  t.after(async () => stop(server));

  await request(server, IDS.coachA, 'PUT', '/api/coach/availability', {
    timezone: 'UTC', sessionDurationMinutes: 60, bufferMinutes: 0, minNoticeHours: 0, maxAdvanceDays: 365,
    windows: [0, 1, 2, 3, 4, 5, 6].map(d => ({ dayOfWeek: d, start: '08:00', end: '18:00' })),
  });

  // Session 1: canceled by Athlete
  let res = await request(server, IDS.athleteA, 'POST', `/api/athlete/coaches/${IDS.coachA}/appointments`, {
    startAt: '2026-12-05T10:00:00.000Z',
    endAt: '2026-12-05T11:00:00.000Z',
  });
  const app1 = res.body.appointment.id;
  res = await request(server, IDS.athleteA, 'POST', `/api/athlete/appointments/${app1}/cancel`, {
    reason: 'Gripe forte',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.appointment.status, 'canceled');
  assert.equal(res.body.appointment.cancellation.actor, 'athlete');
  assert.equal(res.body.appointment.cancellation.reason, 'Gripe forte');

  // Idempotent cancel: second cancel returns 200
  res = await request(server, IDS.athleteA, 'POST', `/api/athlete/appointments/${app1}/cancel`, {
    reason: 'Outro motivo',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.appointment.status, 'canceled');

  // Session 2: canceled by Coach
  res = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/appointments`, {
    startAt: '2026-12-05T14:00:00.000Z',
    endAt: '2026-12-05T15:00:00.000Z',
  });
  const app2 = res.body.appointment.id;
  res = await request(server, IDS.coachA, 'POST', `/api/coach/appointments/${app2}/cancel`, {
    reason: 'Imprevisto pessoal',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.appointment.status, 'canceled');
  assert.equal(res.body.appointment.cancellation.actor, 'coach');

  // Future session attendance fails with session_not_ended
  const futureApp = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/appointments`, {
    startAt: '2026-12-06T10:00:00.000Z',
    endAt: '2026-12-06T11:00:00.000Z',
  });
  res = await request(server, IDS.coachA, 'POST', `/api/coach/appointments/${futureApp.body.appointment.id}/attendance`, {
    status: 'completed',
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'session_not_ended');

  // Past session (seeded in baseDb) attendance records completed / attended
  res = await request(server, IDS.coachA, 'POST', '/api/coach/appointments/capp_past_session/attendance', {
    status: 'completed',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.appointment.status, 'completed');
  assert.equal(res.body.appointment.attendance.state, 'attended');
});

test('7. Comportamento fail-closed quando vínculo é cancelado/encerrado', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-sched-failclosed-'));
  seed(dataDir);
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const server = await launch(dataDir);
  t.after(async () => stop(server));

  await request(server, IDS.coachA, 'PUT', '/api/coach/availability', {
    timezone: 'UTC', sessionDurationMinutes: 60, bufferMinutes: 0, minNoticeHours: 0, maxAdvanceDays: 365,
    windows: [0, 1, 2, 3, 4, 5, 6].map(d => ({ dayOfWeek: d, start: '08:00', end: '18:00' })),
  });

  // Schedule future appointment
  const appRes = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/appointments`, {
    startAt: '2026-12-07T10:00:00.000Z',
    endAt: '2026-12-07T11:00:00.000Z',
  });
  assert.equal(appRes.status, 201);
  const appId = appRes.body.appointment.id;

  // Coach ends relationship via POST /api/coach/links/status
  const relRes = await request(server, IDS.coachA, 'POST', '/api/coach/links/status', {
    linkId: 'cal_aa',
    status: 'ended',
  });
  assert.equal(relRes.status, 200);

  // Future scheduled appointment is automatically canceled
  const checkRes = await request(server, IDS.coachA, 'GET', `/api/coach/athletes/${IDS.athleteA}/appointments`);
  assert.equal(checkRes.status, 200);
  const found = checkRes.body.items.find(a => a.id === appId);
  assert.equal(found.status, 'canceled');
  assert.equal(found.cancellation.actor, 'system');
  assert.equal(found.cancellation.reason, 'relationship_ended');
  const historical = checkRes.body.items.find(a => a.id === 'capp_past_session');
  assert.equal(historical.status, 'scheduled');
  assert.equal(historical.lifecycle.historical, true);
  assert.equal(historical.lifecycle.readOnly, true);
  assert.deepEqual(historical.lifecycle.allowedActions, []);

  const attendanceAfterEnd = await request(server, IDS.coachA, 'POST', '/api/coach/appointments/capp_past_session/attendance', { status: 'completed' });
  assert.equal(attendanceAfterEnd.status, 403);
  assert.equal(attendanceAfterEnd.body.code, 'relationship_inactive');

  // New bookings are blocked
  const newBook = await request(server, IDS.athleteA, 'POST', `/api/athlete/coaches/${IDS.coachA}/appointments`, {
    startAt: '2026-12-07T14:00:00.000Z',
    endAt: '2026-12-07T15:00:00.000Z',
  });
  assert.equal(newBook.status, 403);
  assert.equal(newBook.body.code, 'relationship_inactive');
});

test('8. Rollback transacional de saveDb() e integridade do removeAccount()', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-sched-rollback-'));
  seed(dataDir);
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const server = await launch(dataDir);
  t.after(async () => stop(server));

  // Set availability covering all days
  await request(server, IDS.coachA, 'PUT', '/api/coach/availability', {
    timezone: 'UTC', sessionDurationMinutes: 60, bufferMinutes: 0, minNoticeHours: 0, maxAdvanceDays: 365,
    windows: [0, 1, 2, 3, 4, 5, 6].map(d => ({ dayOfWeek: d, start: '08:00', end: '18:00' })),
  });

  // Inject failure for next save
  fs.writeFileSync(path.join(dataDir, 'fail-db-write'), 'once');

  // Attempt to create appointment => fails 503
  let res = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/appointments`, {
    startAt: '2026-12-08T09:00:00.000Z',
    endAt: '2026-12-08T10:00:00.000Z',
  });
  assert.equal(res.status, 503);
  assert.equal(res.body.code, 'storage_unavailable');

  // In-memory state was rolled back: no appointment was added
  res = await request(server, IDS.coachA, 'GET', `/api/coach/athletes/${IDS.athleteA}/appointments`);
  // capp_past_session is the only appointment present
  assert.equal(res.body.items.filter(a => a.id !== 'capp_past_session').length, 0);

  // Successfully create appointment without failure
  res = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/appointments`, {
    startAt: '2026-12-08T09:00:00.000Z',
    endAt: '2026-12-08T10:00:00.000Z',
  });
  assert.equal(res.status, 201);
  const createdAppId = res.body.appointment.id;

  // Account removal integrity: admin deletes athlete account
  const delRes = await request(server, IDS.coachA, 'POST', '/api/admin/user/delete', {
    id: IDS.athleteA,
  });
  assert.equal(delRes.status, 200);

  // Stored DB has athlete appointments removed, but Coach A availability survives
  const storedDb = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
  assert.equal(storedDb.coachAppointments.some(a => a.id === createdAppId), false);
  assert.equal(storedDb.coachAppointments.some(a => a.athleteId === IDS.athleteA), false);
  assert.equal(storedDb.coachAvailability.some(a => a.coachId === IDS.coachA), true);
});

test('9. Paginação e filtros por data/status', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-sched-pagination-'));
  seed(dataDir);
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const server = await launch(dataDir);
  t.after(async () => stop(server));

  await request(server, IDS.coachA, 'PUT', '/api/coach/availability', {
    timezone: 'UTC', sessionDurationMinutes: 60, bufferMinutes: 0, minNoticeHours: 0, maxAdvanceDays: 365,
    windows: [0, 1, 2, 3, 4, 5, 6].map(d => ({ dayOfWeek: d, start: '08:00', end: '18:00' })),
  });

  // Create 3 appointments on different days
  const dates = ['2026-12-10T09:00:00.000Z', '2026-12-11T09:00:00.000Z', '2026-12-12T09:00:00.000Z'];
  for (const d of dates) {
    const end = new Date(Date.parse(d) + 3600000).toISOString();
    await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/appointments`, {
      startAt: d, endAt: end, title: `Sessão ${d.slice(0, 10)}`,
    });
  }

  // Page 1: limit 2
  let res = await request(server, IDS.coachA, 'GET', `/api/coach/athletes/${IDS.athleteA}/appointments?limit=2`);
  assert.equal(res.status, 200);
  assert.equal(res.body.items.length, 2);
  assert.equal(res.body.hasMore, true);
  assert.ok(res.body.nextCursor);

  // Page 2: with cursor
  const cursor = encodeURIComponent(res.body.nextCursor);
  res = await request(server, IDS.coachA, 'GET', `/api/coach/athletes/${IDS.athleteA}/appointments?limit=2&cursor=${cursor}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.items.length, 2);
  assert.equal(res.body.hasMore, false);

  // Filter by date range (only 2026-12-11)
  res = await request(server, IDS.coachA, 'GET', `/api/coach/athletes/${IDS.athleteA}/appointments?from=2026-12-11T00:00:00.000Z&to=2026-12-11T23:59:59.000Z`);
  assert.equal(res.status, 200);
  assert.equal(res.body.items.length, 1);
  assert.equal(res.body.items[0].startAt, '2026-12-11T09:00:00.000Z');

  // Filter by status (completed) => 0
  res = await request(server, IDS.coachA, 'GET', `/api/coach/athletes/${IDS.athleteA}/appointments?status=completed`);
  assert.equal(res.status, 200);
  assert.equal(res.body.items.length, 0);
});

test('10. Superfície agregada, detalhe, remarcação explícita e contrato canônico', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-sched-contract-'));
  seed(dataDir);
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const server = await launch(dataDir);
  t.after(async () => stop(server));

  await request(server, IDS.coachA, 'PUT', '/api/coach/availability', {
    timezone: 'UTC', sessionDurationMinutes: 60, bufferMinutes: 0, minNoticeHours: 0, maxAdvanceDays: 365,
    windows: [0, 1, 2, 3, 4, 5, 6].map(dayOfWeek => ({ dayOfWeek, start: '08:00', end: '18:00' })),
  });
  const created = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/appointments`, {
    startAt: '2027-01-10T10:00:00Z', title: 'Contrato congelado',
  });
  assert.equal(created.status, 201);
  const appointmentId = created.body.appointment.id;
  assert.equal(created.body.appointment.durationMinutes, 60);
  assert.equal(created.body.appointment.timeZone, 'UTC');
  assert.equal(created.body.appointment.localDate, '2027-01-10');
  assert.deepEqual(created.body.appointment.lifecycle.allowedActions, ['reschedule', 'cancel']);

  let res = await request(server, IDS.coachA, 'GET', '/api/coach/appointments?limit=10');
  assert.equal(res.status, 200);
  assert.ok(res.body.items.some(item => item.id === appointmentId));
  assert.equal('appointments' in res.body, false);
  assert.equal('page' in res.body, false);
  assert.equal(res.body.limit, 10);

  const firstPage = await request(server, IDS.coachA, 'GET', '/api/coach/appointments?limit=1');
  assert.equal(firstPage.status, 200);
  assert.equal(firstPage.body.hasMore, true);
  const reboundCursor = encodeURIComponent(firstPage.body.nextCursor);
  const rebound = await request(server, IDS.coachA, 'GET', `/api/coach/appointments?limit=1&status=scheduled&cursor=${reboundCursor}`);
  assert.equal(rebound.status, 400);
  assert.equal(rebound.body.code, 'invalid_cursor');

  res = await request(server, IDS.coachA, 'GET', `/api/coach/appointments/${appointmentId}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.appointment.athlete.id, IDS.athleteA);
  res = await request(server, IDS.athleteA, 'GET', `/api/athlete/appointments/${appointmentId}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.appointment.coach.id, IDS.coachA);

  res = await request(server, IDS.athleteA, 'POST', `/api/athlete/appointments/${appointmentId}/reschedule`, {
    startAt: '2027-01-10T11:00:00Z',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.appointment.endAt, '2027-01-10T12:00:00.000Z');
  assert.equal(res.body.appointment.durationMinutes, 60);

  res = await request(server, IDS.coachA, 'PATCH', `/api/coach/appointments/${appointmentId}`, { title: 'partial mutation' });
  assert.equal(res.status, 405);
  assert.equal(res.body.code, 'action_required');
  res = await request(server, IDS.coachA, 'POST', `/api/coach/appointments/${appointmentId}/reschedule`, { startAt: '2027-01-10T12:00:00Z', extra: true });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'invalid_reschedule');
});

test('11. Escopo training e linkId explícito isolam recontratação', async t => {
  const multiple = baseDb();
  multiple.coachAthleteLinks.push({
    id: 'cal_aa_old', coachId: IDS.coachA, athleteId: IDS.athleteA, scopes: ['training'], status: 'ended',
    createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-12-01T00:00:00.000Z', endedAt: '2025-12-01T00:00:00.000Z',
  });
  multiple.coachAppointments.push({
    id: 'capp_old_link', linkId: 'cal_aa_old', coachId: IDS.coachA, athleteId: IDS.athleteA,
    type: 'in_person', title: 'Historical relationship', notes: '',
    startAt: '2025-11-01T10:00:00.000Z', endAt: '2025-11-01T11:00:00.000Z',
    timeZone: 'UTC', localDate: '2025-11-01', durationMinutes: 60, status: 'completed', cancellation: null,
    location: null, meetingUrl: null,
    attendance: { state: 'attended', recordedBy: IDS.coachA, recordedAt: '2025-11-01T11:01:00.000Z' },
    createdAt: '2025-10-01T00:00:00.000Z', updatedAt: '2025-11-01T11:01:00.000Z',
  });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-sched-links-'));
  seed(dataDir, multiple);
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const server = await launch(dataDir);
  t.after(async () => stop(server));
  await request(server, IDS.coachA, 'PUT', '/api/coach/availability', {
    timezone: 'UTC', sessionDurationMinutes: 60, bufferMinutes: 0, minNoticeHours: 0, maxAdvanceDays: 365,
    windows: [0, 1, 2, 3, 4, 5, 6].map(dayOfWeek => ({ dayOfWeek, start: '08:00', end: '18:00' })),
  });

  let res = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/appointments`, {
    startAt: '2027-01-11T10:00:00Z',
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'link_id_required');
  res = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/appointments`, {
    linkId: 'cal_aa', startAt: '2027-01-11T10:00:00Z',
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.appointment.linkId, 'cal_aa');

  const nutrition = baseDb();
  nutrition.coachAppointments = [];
  nutrition.coachAthleteLinks.find(link => link.id === 'cal_aa').scopes = ['nutrition'];
  const nutritionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-sched-nutrition-'));
  seed(nutritionDir, nutrition);
  t.after(() => fs.rmSync(nutritionDir, { recursive: true, force: true }));
  const nutritionServer = await launch(nutritionDir);
  t.after(async () => stop(nutritionServer));
  res = await request(nutritionServer, IDS.athleteA, 'GET', `/api/athlete/coaches/${IDS.coachA}/availability-slots?date=2027-01-11`);
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'scope_forbidden');
});

test('12. Lembretes persistem, reconciliam e disponibilidade usa CAS', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-sched-reminders-'));
  seed(dataDir);
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let server = await launch(dataDir);
  t.after(async () => stop(server));

  let availability = await request(server, IDS.coachA, 'PUT', '/api/coach/availability', {
    timezone: 'UTC', sessionDurationMinutes: 60, bufferMinutes: 0, minNoticeHours: 0, maxAdvanceDays: 365,
    windows: [0, 1, 2, 3, 4, 5, 6].map(dayOfWeek => ({ dayOfWeek, start: '08:00', end: '18:00' })),
  });
  assert.equal(availability.status, 200);
  assert.equal(availability.body.availability._rev, 1);

  const casPayload = {
    _rev: 1, timeZone: 'UTC', sessionDurationMinutes: 60, bufferMinutes: 0, minNoticeHours: 0, maxAdvanceDays: 365,
    windows: [0, 1, 2, 3, 4, 5, 6].map(dayOfWeek => ({ dayOfWeek, start: '08:00', end: '17:00' })), exceptions: [],
  };
  const cas = await Promise.all([
    request(server, IDS.coachA, 'PUT', '/api/coach/availability', casPayload),
    request(server, IDS.coachA, 'PUT', '/api/coach/availability', casPayload),
  ]);
  assert.deepEqual(cas.map(result => result.status).sort(), [200, 409]);

  for (const uid of [IDS.coachA, IDS.athleteA]) {
    const pref = await request(server, uid, 'PUT', '/api/scheduling/reminder-preferences', {
      enabled: true, offsetsMinutes: [60], timeZone: 'UTC',
    });
    assert.equal(pref.status, 200);
  }
  const created = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/appointments`, {
    startAt: '2027-01-12T10:00:00Z',
  });
  assert.equal(created.status, 201);
  const appointmentId = created.body.appointment.id;
  let stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
  assert.equal(stored.appointmentReminderStates.filter(item => item.appointmentId === appointmentId && item.status === 'pending').length, 2);
  assert.equal(stored.schedulingReminderOutbox.filter(item => item.appointmentId === appointmentId && item.status === 'pending').length, 2);

  let res = await request(server, IDS.coachA, 'POST', `/api/coach/appointments/${appointmentId}/reschedule`, {
    startAt: '2027-01-12T11:00:00Z',
  });
  assert.equal(res.status, 200);
  stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
  assert.equal(stored.appointmentReminderStates.filter(item => item.appointmentId === appointmentId && item.status === 'pending').length, 2);
  assert.equal(stored.appointmentReminderStates.filter(item => item.appointmentId === appointmentId && item.status === 'canceled').length, 0);
  assert.ok(stored.appointmentReminderStates.filter(item => item.appointmentId === appointmentId).every(item => item.scheduledFor === '2027-01-12T10:00:00.000Z'));

  res = await request(server, IDS.coachA, 'POST', `/api/coach/appointments/${appointmentId}/cancel`, { reason: 'agenda alterada' });
  assert.equal(res.status, 200);
  stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
  assert.equal(stored.appointmentReminderStates.filter(item => item.appointmentId === appointmentId && item.status === 'pending').length, 0);
  assert.equal(stored.schedulingReminderOutbox.filter(item => item.appointmentId === appointmentId && item.status === 'pending').length, 0);

  await stop(server);
  server = await launch(dataDir);
  res = await request(server, IDS.coachA, 'GET', '/api/scheduling/reminder-preferences');
  assert.equal(res.status, 200);
  assert.equal(res.body.preferences.enabled, true);
  assert.ok(res.body.appointmentReminderStates.some(item => item.appointmentId === appointmentId));

  const afterRestart = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/appointments`, {
    startAt: '2027-01-13T10:00:00Z',
  });
  assert.equal(afterRestart.status, 201);
  const relationshipAppointmentId = afterRestart.body.appointment.id;
  const ended = await request(server, IDS.coachA, 'POST', '/api/coach/links/status', { linkId: 'cal_aa', status: 'ended' });
  assert.equal(ended.status, 200);
  stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
  assert.equal(stored.schedulingReminderOutbox.filter(item => item.appointmentId === relationshipAppointmentId && item.status === 'pending').length, 0);
});

test('13. Vinte reservas concorrentes produzem uma criação e dezenove conflitos', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-sched-race-'));
  seed(dataDir);
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const server = await launch(dataDir);
  t.after(async () => stop(server));
  await request(server, IDS.coachA, 'PUT', '/api/coach/availability', {
    timezone: 'UTC', sessionDurationMinutes: 60, bufferMinutes: 0, minNoticeHours: 0, maxAdvanceDays: 365,
    windows: [0, 1, 2, 3, 4, 5, 6].map(dayOfWeek => ({ dayOfWeek, start: '08:00', end: '18:00' })),
  });
  const results = await Promise.all(Array.from({ length: 20 }, () => request(
    server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/appointments`, { startAt: '2027-01-13T10:00:00Z' },
  )));
  assert.equal(results.filter(result => result.status === 201).length, 1);
  assert.equal(results.filter(result => result.status === 409 && result.body.code === 'double_booking').length, 19);
});

test('14. Exceções removem blackouts e o horizonte de 365 dias é consultável', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-sched-exceptions-'));
  seed(dataDir);
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const server = await launch(dataDir);
  t.after(async () => stop(server));
  await request(server, IDS.coachA, 'PUT', '/api/coach/availability', {
    timezone: 'Pacific/Kiritimati', sessionDurationMinutes: 60, bufferMinutes: 0, minNoticeHours: 0, maxAdvanceDays: 365,
    windows: [0, 1, 2, 3, 4, 5, 6].map(dayOfWeek => ({ dayOfWeek, start: '08:00', end: '10:00' })),
    exceptions: [
      { date: '2027-08-01', unavailable: true },
      { date: '2027-08-02', windows: [{ start: '14:00', end: '16:00' }] },
    ],
  });
  let res = await request(server, IDS.athleteA, 'GET', `/api/athlete/coaches/${IDS.coachA}/availability-slots?date=2027-08-01`);
  assert.equal(res.status, 200);
  assert.equal(res.body.items.length, 0);
  res = await request(server, IDS.athleteA, 'GET', `/api/athlete/coaches/${IDS.coachA}/availability-slots?date=2027-08-02`);
  assert.equal(res.status, 200);
  assert.equal(res.body.items.length, 2);
  assert.equal(res.body.items[0].localDate, '2027-08-02');
});

test('15. Coach e atleta obedecem minNotice, maxAdvance, passado e duração configurada', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-sched-policy-'));
  seed(dataDir);
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const server = await launch(dataDir);
  t.after(async () => stop(server));
  await request(server, IDS.coachA, 'PUT', '/api/coach/availability', {
    timezone: 'UTC', sessionDurationMinutes: 60, bufferMinutes: 0, minNoticeHours: 48, maxAdvanceDays: 10,
    windows: [0, 1, 2, 3, 4, 5, 6].map(dayOfWeek => ({ dayOfWeek, start: '00:00', end: '23:00' })),
  });
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10) + 'T12:00:00Z';
  const far = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10) + 'T12:00:00Z';
  for (const [uid, route] of [
    [IDS.coachA, `/api/coach/athletes/${IDS.athleteA}/appointments`],
    [IDS.athleteA, `/api/athlete/coaches/${IDS.coachA}/appointments`],
  ]) {
    let res = await request(server, uid, 'POST', route, { startAt: tomorrow });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'min_notice_violated');
    res = await request(server, uid, 'POST', route, { startAt: far });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'max_advance_exceeded');
    res = await request(server, uid, 'POST', route, { startAt: '2026-01-01T12:00:00Z' });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'past_appointment');
    res = await request(server, uid, 'POST', route, { startAt: far, endAt: new Date(Date.parse(far) + 2 * 3600000).toISOString() });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'invalid_appointment');
  }
});

test('16. PUT idêntico preserva pending e atualização de um participante não toca o outro', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-sched-reminder-idempotent-'));
  seed(dataDir);
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const server = await launch(dataDir, { B2B2C_SCHEDULING_REMINDER_TICK_MS: '600000' });
  t.after(async () => stop(server));
  await request(server, IDS.coachA, 'PUT', '/api/coach/availability', {
    timezone: 'UTC', sessionDurationMinutes: 60, bufferMinutes: 0, minNoticeHours: 0, maxAdvanceDays: 365,
    windows: [0, 1, 2, 3, 4, 5, 6].map(dayOfWeek => ({ dayOfWeek, start: '08:00', end: '18:00' })),
  });
  for (const uid of [IDS.coachA, IDS.athleteA]) {
    assert.equal((await request(server, uid, 'PUT', '/api/scheduling/reminder-preferences', {
      enabled: true, offsetsMinutes: [60], timeZone: 'UTC',
    })).status, 200);
  }
  const created = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/appointments`, {
    startAt: '2027-02-10T10:00:00Z',
  });
  assert.equal(created.status, 201);
  const appointmentId = created.body.appointment.id;
  let stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
  const coachBefore = structuredClone(stored.appointmentReminderStates.find(item => item.appointmentId === appointmentId && item.userId === IDS.coachA));
  const athleteBefore = structuredClone(stored.appointmentReminderStates.find(item => item.appointmentId === appointmentId && item.userId === IDS.athleteA));

  assert.equal((await request(server, IDS.coachA, 'PUT', '/api/scheduling/reminder-preferences', {
    enabled: true, offsetsMinutes: [60], timeZone: 'UTC',
  })).status, 200);
  stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
  assert.deepEqual(stored.appointmentReminderStates.find(item => item.id === coachBefore.id), coachBefore);
  assert.deepEqual(stored.appointmentReminderStates.find(item => item.id === athleteBefore.id), athleteBefore);

  assert.equal((await request(server, IDS.coachA, 'PUT', '/api/scheduling/reminder-preferences', {
    enabled: true, offsetsMinutes: [15, 60], timeZone: 'UTC',
  })).status, 200);
  stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
  assert.deepEqual(stored.appointmentReminderStates.find(item => item.id === athleteBefore.id), athleteBefore);
  assert.deepEqual(
    stored.appointmentReminderStates.filter(item => item.appointmentId === appointmentId && item.userId === IDS.coachA && item.status === 'pending')
      .map(item => item.offsetMinutes).sort((a, b) => a - b),
    [15, 60],
  );
});

test('17. Profissional dual-role completa ações de atleta sem ampliar IDOR', async t => {
  const dualRole = baseDb();
  dualRole.users.find(user => user.id === IDS.athleteA).profile = { kind: 'coach', coachSpecialties: ['training'] };
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-sched-dual-role-'));
  seed(dataDir, dualRole);
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let server = await launch(dataDir);
  t.after(async () => stop(server));
  await request(server, IDS.coachA, 'PUT', '/api/coach/availability', {
    timezone: 'UTC', sessionDurationMinutes: 60, bufferMinutes: 0, minNoticeHours: 0, maxAdvanceDays: 365,
    windows: [0, 1, 2, 3, 4, 5, 6].map(dayOfWeek => ({ dayOfWeek, start: '08:00', end: '18:00' })),
  });

  let response = await request(server, IDS.athleteA, 'GET', `/api/athlete/coaches/${IDS.coachA}/availability-slots?date=2027-02-11`);
  assert.equal(response.status, 200);
  response = await request(server, IDS.athleteA, 'POST', `/api/athlete/coaches/${IDS.coachA}/appointments`, {
    startAt: '2027-02-11T10:00:00Z',
  });
  assert.equal(response.status, 201);
  const appointmentId = response.body.appointment.id;
  assert.equal((await request(server, IDS.athleteA, 'GET', '/api/athlete/appointments')).status, 200);
  assert.equal((await request(server, IDS.athleteA, 'GET', `/api/athlete/coaches/${IDS.coachA}/appointments`)).status, 200);
  assert.equal((await request(server, IDS.athleteA, 'GET', `/api/athlete/appointments/${appointmentId}`)).status, 200);
  assert.equal((await request(server, IDS.athleteA, 'POST', `/api/athlete/appointments/${appointmentId}/reschedule`, {
    startAt: '2027-02-11T11:00:00Z',
  })).status, 200);
  assert.equal((await request(server, IDS.athleteA, 'POST', `/api/athlete/appointments/${appointmentId}/cancel`, {
    reason: 'mudança de agenda',
  })).status, 200);

  const foreign = dualRole.coachAppointments.find(item => item.id === 'capp_past_session');
  foreign.athleteId = IDS.athleteB;
  foreign.linkId = 'cal_bb';
  foreign.coachId = IDS.coachB;
  await stop(server);
  const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
  stored.coachAppointments.push({ ...foreign, id: 'capp_foreign', timeZone: 'UTC', localDate: '2026-01-01', durationMinutes: 60, cancellation: null });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify(stored, null, 2));
  server = await launch(dataDir);
  assert.equal((await request(server, IDS.athleteA, 'GET', '/api/athlete/appointments/capp_foreign')).status, 404);
  assert.equal((await request(server, IDS.athleteA, 'GET', `/api/athlete/coaches/${IDS.coachB}/appointments?linkId=cal_bb`)).status, 404);
});
