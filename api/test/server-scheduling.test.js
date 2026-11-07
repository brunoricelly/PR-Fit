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
    maxAdvanceDays: 30,
    windows: [
      { dayOfWeek: 1, start: '08:00', end: '12:00' },
      { dayOfWeek: 3, start: '14:00', end: '18:00' },
      { dayOfWeek: 5, start: '09:00', end: '12:00' },
    ],
  };
  res = await request(server, IDS.coachA, 'PUT', '/api/coach/availability', validConfig);
  assert.equal(res.status, 200);
  assert.equal(res.body.availability.coachId, IDS.coachA);
  assert.equal(res.body.availability.timezone, 'America/Sao_Paulo');
  assert.equal(res.body.availability.sessionDurationMinutes, 60);
  assert.equal(res.body.availability.bufferMinutes, 15);
  assert.equal(res.body.availability.windows.length, 3);

  // GET returns saved availability
  res = await request(server, IDS.coachA, 'GET', '/api/coach/availability');
  assert.equal(res.status, 200);
  assert.equal(res.body.availability.timezone, 'America/Sao_Paulo');
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
    maxAdvanceDays: 30,
    windows: [0, 1, 2, 3, 4, 5, 6].map(d => ({ dayOfWeek: d, start: '08:00', end: '11:00' })),
  });

  // Query slots for a future day (e.g. 2026-12-01)
  let res = await request(server, IDS.athleteA, 'GET', `/api/athlete/coaches/${IDS.coachA}/availability-slots?date=2026-12-01`);
  assert.equal(res.status, 200);
  assert.equal(res.body.timezone, 'UTC');
  // 08:00-09:00, 09:00-10:00, 10:00-11:00 => 3 slots
  assert.equal(res.body.slots.length, 3);
  assert.equal(res.body.slots[0].startAt, '2026-12-01T08:00:00.000Z');
  assert.equal(res.body.slots[0].endAt, '2026-12-01T09:00:00.000Z');
  assert.equal(res.body.slots[1].startAt, '2026-12-01T09:00:00.000Z');
  assert.equal(res.body.slots[2].startAt, '2026-12-01T10:00:00.000Z');

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
  assert.equal(res.body.slots.length, 2);
  assert.equal(res.body.slots[0].startAt, '2026-12-01T08:00:00.000Z');
  assert.equal(res.body.slots[1].startAt, '2026-12-01T10:00:00.000Z');
});

test('3. Prevenção de conflito (double-booking) simultâneo', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-sched-conflict-'));
  seed(dataDir);
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const server = await launch(dataDir);
  t.after(async () => stop(server));

  await request(server, IDS.coachA, 'PUT', '/api/coach/availability', {
    timezone: 'UTC', sessionDurationMinutes: 60, bufferMinutes: 15, minNoticeHours: 0, maxAdvanceDays: 30,
    windows: [0, 1, 2, 3, 4, 5, 6].map(d => ({ dayOfWeek: d, start: '08:00', end: '18:00' })),
  });
  await request(server, IDS.coachB, 'PUT', '/api/coach/availability', {
    timezone: 'UTC', sessionDurationMinutes: 60, bufferMinutes: 0, minNoticeHours: 0, maxAdvanceDays: 30,
    windows: [0, 1, 2, 3, 4, 5, 6].map(d => ({ dayOfWeek: d, start: '08:00', end: '18:00' })),
  });

  // Coach A schedules appointment with Athlete A for 2026-12-02 10:00 - 11:00
  const app = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/appointments`, {
    startAt: '2026-12-02T10:00:00.000Z',
    endAt: '2026-12-02T11:00:00.000Z',
    title: 'Treino A',
  });
  assert.equal(app.status, 201);

  // Double-booking check: Coach A cannot schedule another session overlapping 10:00 - 11:00
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
  assert.equal(conflictRes.status, 409);

  // Athlete double-booking: Athlete A already has session 10:00 - 11:00 with Coach A.
  // Athlete A tries to book with Coach B at the same time (10:00 - 11:00): blocked!
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
    timezone: 'UTC', sessionDurationMinutes: 60, bufferMinutes: 0, minNoticeHours: 0, maxAdvanceDays: 30,
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
    timezone: 'UTC', sessionDurationMinutes: 60, bufferMinutes: 0, minNoticeHours: 0, maxAdvanceDays: 30,
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
    cancelReason: 'Hacked by Athlete A',
  });
  assert.equal(res.status, 404);

  // Athlete A listing their own appointments does NOT see Athlete B's appointment
  res = await request(server, IDS.athleteA, 'GET', '/api/athlete/appointments');
  assert.equal(res.status, 200);
  assert.equal(res.body.appointments.some(a => a.id === appBId), false);
});

test('6. Cancelamento por ambas as partes e atualização de status de presença', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-sched-lifecycle-'));
  seed(dataDir);
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const server = await launch(dataDir);
  t.after(async () => stop(server));

  await request(server, IDS.coachA, 'PUT', '/api/coach/availability', {
    timezone: 'UTC', sessionDurationMinutes: 60, bufferMinutes: 0, minNoticeHours: 0, maxAdvanceDays: 30,
    windows: [0, 1, 2, 3, 4, 5, 6].map(d => ({ dayOfWeek: d, start: '08:00', end: '18:00' })),
  });

  // Session 1: canceled by Athlete
  let res = await request(server, IDS.athleteA, 'POST', `/api/athlete/coaches/${IDS.coachA}/appointments`, {
    startAt: '2026-12-05T10:00:00.000Z',
    endAt: '2026-12-05T11:00:00.000Z',
  });
  const app1 = res.body.appointment.id;
  res = await request(server, IDS.athleteA, 'POST', `/api/athlete/appointments/${app1}/cancel`, {
    cancelReason: 'Gripe forte',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.appointment.status, 'canceled');
  assert.equal(res.body.appointment.canceledBy, 'athlete');
  assert.equal(res.body.appointment.cancelReason, 'Gripe forte');

  // Idempotent cancel: second cancel returns 200
  res = await request(server, IDS.athleteA, 'POST', `/api/athlete/appointments/${app1}/cancel`, {
    cancelReason: 'Outro motivo',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.appointment.status, 'canceled');

  // Session 2: canceled by Coach
  res = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/appointments`, {
    startAt: '2026-12-05T14:00:00.000Z',
    endAt: '2026-12-05T15:00:00.000Z',
  });
  const app2 = res.body.appointment.id;
  res = await request(server, IDS.coachA, 'PATCH', `/api/coach/appointments/${app2}`, {
    status: 'canceled',
    cancelReason: 'Imprevisto pessoal',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.appointment.status, 'canceled');
  assert.equal(res.body.appointment.canceledBy, 'coach');

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
  assert.equal(res.body.appointment.attendance, 'attended');
});

test('7. Comportamento fail-closed quando vínculo é cancelado/encerrado', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-sched-failclosed-'));
  seed(dataDir);
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const server = await launch(dataDir);
  t.after(async () => stop(server));

  await request(server, IDS.coachA, 'PUT', '/api/coach/availability', {
    timezone: 'UTC', sessionDurationMinutes: 60, bufferMinutes: 0, minNoticeHours: 0, maxAdvanceDays: 30,
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
  const found = checkRes.body.appointments.find(a => a.id === appId);
  assert.equal(found.status, 'canceled');
  assert.equal(found.canceledBy, 'system');
  assert.equal(found.cancelReason, 'relationship_ended');

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
    timezone: 'UTC', sessionDurationMinutes: 60, bufferMinutes: 0, minNoticeHours: 0, maxAdvanceDays: 30,
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
  assert.equal(res.body.appointments.filter(a => a.id !== 'capp_past_session').length, 0);

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
    timezone: 'UTC', sessionDurationMinutes: 60, bufferMinutes: 0, minNoticeHours: 0, maxAdvanceDays: 30,
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
  assert.equal(res.body.appointments.length, 2);
  assert.equal(res.body.page.hasMore, true);
  assert.ok(res.body.page.nextCursor);

  // Page 2: with cursor
  const cursor = encodeURIComponent(res.body.page.nextCursor);
  res = await request(server, IDS.coachA, 'GET', `/api/coach/athletes/${IDS.athleteA}/appointments?limit=2&cursor=${cursor}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.appointments.length, 2);
  assert.equal(res.body.page.hasMore, false);

  // Filter by date range (only 2026-12-11)
  res = await request(server, IDS.coachA, 'GET', `/api/coach/athletes/${IDS.athleteA}/appointments?from=2026-12-11T00:00:00.000Z&to=2026-12-11T23:59:59.000Z`);
  assert.equal(res.status, 200);
  assert.equal(res.body.appointments.length, 1);
  assert.equal(res.body.appointments[0].startAt, '2026-12-11T09:00:00.000Z');

  // Filter by status (completed) => 0
  res = await request(server, IDS.coachA, 'GET', `/api/coach/athletes/${IDS.athleteA}/appointments?status=completed`);
  assert.equal(res.status, 200);
  assert.equal(res.body.appointments.length, 0);
});
