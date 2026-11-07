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

function fixture(t, db, backup = 'backup-sentinel') {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-b2b2c-migration-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dataDir, 'secret'), crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  const raw = JSON.stringify(db, null, 2);
  fs.writeFileSync(path.join(dataDir, 'db.json'), raw);
  fs.writeFileSync(path.join(dataDir, 'db.json.bak'), backup);
  return { dataDir, raw, backup };
}

function start(dataDir) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN, RP_ID: 'localhost' },
  });
  let log = '';
  child.stdout.on('data', chunk => log += chunk);
  child.stderr.on('data', chunk => log += chunk);
  const exit = new Promise(resolve => child.once('exit', resolve));
  return { child, exit, log: () => log };
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise(resolve => child.once('exit', resolve));
}

function schedulingFixture(appointments) {
  const timestamp = '2026-01-01T00:00:00.000Z';
  return {
    schemaVersion: 8,
    users: [
      { id: 'u_coach', name: 'Coach', profile: { kind: 'coach', coachSpecialties: ['training'] } },
      { id: 'u_athlete', name: 'Athlete', profile: { kind: 'athlete' } },
    ],
    creds: [], subs: [], invites: [], deviceLinks: [], coachInvites: [], coachPrescriptions: [], coachAssessments: [],
    mealPlans: [], mealAdherence: [], coachMessages: [], coachHabits: [], habitCheckins: [], progressGoals: [], progressReports: [], accountCleanupJobs: [],
    coachAthleteLinks: [{ id: 'cal_sched', coachId: 'u_coach', athleteId: 'u_athlete', scopes: ['training'], status: 'active', createdAt: timestamp, updatedAt: timestamp }],
    coachAvailability: [], coachAppointments: appointments, schedulingReminderPreferences: [], appointmentReminderStates: [], schedulingReminderOutbox: [],
  };
}

function validAppointment(overrides = {}) {
  return {
    id: 'capp_1', linkId: 'cal_sched', coachId: 'u_coach', athleteId: 'u_athlete', type: 'in_person', title: 'Session', notes: '',
    startAt: '2026-06-01T10:00:00.000Z', endAt: '2026-06-01T11:00:00.000Z', timeZone: 'UTC', localDate: '2026-06-01', durationMinutes: 60,
    status: 'scheduled', cancellation: null, location: null, meetingUrl: null, attendance: null,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...overrides,
  };
}

async function assertSchedulingBootRefused(t, db) {
  const sample = fixture(t, db);
  const server = start(sample.dataDir);
  assert.equal(await server.exit, 1);
  assert.match(server.log(), /B2B2C data is invalid/);
  assert.equal(fs.readFileSync(path.join(sample.dataDir, 'db.json'), 'utf8'), sample.raw);
  assert.equal(fs.readFileSync(path.join(sample.dataDir, 'db.json.bak'), 'utf8'), sample.backup);
}

for (const [name, db] of [
  ['future schema', { schemaVersion: 999, users: [], creds: [], subs: [], invites: [], coachInvites: [], coachAthleteLinks: [] }],
  ['corrupt B2B2C collection', { schemaVersion: 3, users: [], creds: [], subs: [], invites: [], coachInvites: {}, coachAthleteLinks: [], coachPrescriptions: [] }],
  ['corrupt prescription collection', { schemaVersion: 3, users: [], creds: [], subs: [], invites: [], coachInvites: [], coachAthleteLinks: [], coachPrescriptions: {} }],
  ['corrupt assessment collection', { schemaVersion: 4, users: [], creds: [], subs: [], invites: [], coachInvites: [], coachAthleteLinks: [], coachPrescriptions: [], coachAssessments: {} }],
  ['corrupt assessment record', { schemaVersion: 4, users: [], creds: [], subs: [], invites: [], coachInvites: [], coachAthleteLinks: [], coachPrescriptions: [], coachAssessments: [{ id: 'bad' }] }],
  ['corrupt assessment payload', { schemaVersion: 4, users: [], creds: [], subs: [], invites: [], coachInvites: [], coachAthleteLinks: [], coachPrescriptions: [], coachAssessments: [{ id: 'cas_bad', coachId: 'u_c', athleteId: 'u_a', assessedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', parq: { version: '2024.1', answers: [] } }] }],
  ['corrupt baseline collection', { schemaVersion: 3, users: null, creds: [], subs: [], invites: [], coachInvites: [], coachAthleteLinks: [], coachPrescriptions: [] }],
  ['corrupt message collection', { schemaVersion: 6, users: [], creds: [], subs: [], invites: [], coachInvites: [], coachAthleteLinks: [], coachPrescriptions: [], coachAssessments: [], mealPlans: [], mealAdherence: [], coachMessages: {}, coachHabits: [], habitCheckins: [] }],
  ['corrupt message record', { schemaVersion: 6, users: [], creds: [], subs: [], invites: [], coachInvites: [], coachAthleteLinks: [], coachPrescriptions: [], coachAssessments: [], mealPlans: [], mealAdherence: [], coachMessages: [{ id: 'cmsg_bad' }], coachHabits: [], habitCheckins: [] }],
  ['corrupt habit record', { schemaVersion: 6, users: [], creds: [], subs: [], invites: [], coachInvites: [], coachAthleteLinks: [], coachPrescriptions: [], coachAssessments: [], mealPlans: [], mealAdherence: [], coachMessages: [], coachHabits: [{ id: 'hab_bad' }], habitCheckins: [] }],
  ['orphan habit check-in', { schemaVersion: 6, users: [], creds: [], subs: [], invites: [], coachInvites: [], coachAthleteLinks: [], coachPrescriptions: [], coachAssessments: [], mealPlans: [], mealAdherence: [], coachMessages: [], coachHabits: [], habitCheckins: [{ id: 'hchk_bad', habitId: 'hab_missing' }] }],
  ['corrupt progress collection', { schemaVersion: 7, users: [], creds: [], subs: [], invites: [], coachInvites: [], coachAthleteLinks: [], coachPrescriptions: [], coachAssessments: [], mealPlans: [], mealAdherence: [], coachMessages: [], coachHabits: [], habitCheckins: [], progressGoals: {}, progressReports: [] }],
  ['corrupt progress goal', { schemaVersion: 7, users: [], creds: [], subs: [], invites: [], coachInvites: [], coachAthleteLinks: [], coachPrescriptions: [], coachAssessments: [], mealPlans: [], mealAdherence: [], coachMessages: [], coachHabits: [], habitCheckins: [], progressGoals: [{ id: 'pgoal_bad' }], progressReports: [] }],
  ['corrupt availability collection', { schemaVersion: 8, users: [], creds: [], subs: [], invites: [], coachInvites: [], coachAthleteLinks: [], coachPrescriptions: [], coachAssessments: [], mealPlans: [], mealAdherence: [], coachMessages: [], coachHabits: [], habitCheckins: [], progressGoals: [], progressReports: [], coachAvailability: {}, coachAppointments: [] }],
  ['corrupt appointment collection', { schemaVersion: 8, users: [], creds: [], subs: [], invites: [], coachInvites: [], coachAthleteLinks: [], coachPrescriptions: [], coachAssessments: [], mealPlans: [], mealAdherence: [], coachMessages: [], coachHabits: [], habitCheckins: [], progressGoals: [], progressReports: [], coachAvailability: [], coachAppointments: {} }],
  ['duplicate meal plan ids', {
    schemaVersion: 5, users: [], creds: [], subs: [], invites: [], coachInvites: [], coachAthleteLinks: [], coachPrescriptions: [], coachAssessments: [],
    mealPlans: [1, 2].map(() => ({ id: 'mp_duplicate', coachId: 'u_c', athleteId: 'u_a', title: 'P', status: 'draft', targetCalories: 2000,
      targetMacros: { protein: 150, carbs: 250, fats: 65, fiber: 30, waterMl: 2500 }, meals: [{ id: 'm_1', name: 'Day', time: '08:00', items: [{ id: 'it_1', name: 'Menu', portion: 'day', calories: 2000, protein: 150, carbs: 250, fats: 65, fiber: 30, substitutes: [] }] }], notes: '', createdAt: 1, updatedAt: 1 })),
    mealAdherence: [],
  }],
  ['duplicate adherence ids', {
    schemaVersion: 5, users: [], creds: [], subs: [], invites: [], coachInvites: [], coachAthleteLinks: [], coachPrescriptions: [], coachAssessments: [],
    mealPlans: [{ id: 'mp_1', coachId: 'u_c', athleteId: 'u_a', title: 'P', status: 'draft', targetCalories: 2000,
      targetMacros: { protein: 150, carbs: 250, fats: 65, fiber: 30, waterMl: 2500 }, meals: [{ id: 'm_1', name: 'Day', time: '08:00', items: [{ id: 'it_1', name: 'Menu', portion: 'day', calories: 2000, protein: 150, carbs: 250, fats: 65, fiber: 30, substitutes: [] }] }], notes: '', createdAt: 1, updatedAt: 1 }],
    mealAdherence: ['2026-11-05', '2026-11-06'].map(date => ({ id: 'adh_duplicate', athleteId: 'u_a', mealPlanId: 'mp_1', date, mealsChecked: [], waterDrunkMl: 0, notes: '', updatedAt: 1 })),
  }],
  ['duplicate meal ids', (() => {
    const item = { id: 'it_1', name: 'Menu', portion: 'day', calories: 2000, protein: 150, carbs: 250, fats: 65, fiber: 30, substitutes: [] };
    const meal = { id: 'm_duplicate', name: 'Day', time: '08:00', items: [item] };
    return { schemaVersion: 5, users: [], creds: [], subs: [], invites: [], coachInvites: [], coachAthleteLinks: [], coachPrescriptions: [], coachAssessments: [], mealAdherence: [],
      mealPlans: [{ id: 'mp_1', coachId: 'u_c', athleteId: 'u_a', title: 'P', status: 'draft', targetCalories: 4000, targetMacros: { protein: 300, carbs: 500, fats: 130, fiber: 60, waterMl: 2500 }, meals: [meal, structuredClone(meal)], notes: '', createdAt: 1, updatedAt: 1 }] };
  })()],
  ['duplicate meal item ids', (() => {
    const item = { id: 'it_duplicate', name: 'Menu', portion: 'half day', calories: 1000, protein: 75, carbs: 125, fats: 32.5, fiber: 15, substitutes: [] };
    return { schemaVersion: 5, users: [], creds: [], subs: [], invites: [], coachInvites: [], coachAthleteLinks: [], coachPrescriptions: [], coachAssessments: [], mealAdherence: [],
      mealPlans: [{ id: 'mp_1', coachId: 'u_c', athleteId: 'u_a', title: 'P', status: 'draft', targetCalories: 2000, targetMacros: { protein: 150, carbs: 250, fats: 65, fiber: 30, waterMl: 2500 }, meals: [{ id: 'm_1', name: 'Day', time: '08:00', items: [item, structuredClone(item)] }], notes: '', createdAt: 1, updatedAt: 1 }] };
  })()],
]) {
  test(`${name} refuses boot without overwriting db.json or db.json.bak`, async t => {
    const sample = fixture(t, db);
    const server = start(sample.dataDir);
    assert.equal(await server.exit, 1);
    assert.match(server.log(), /B2B2C.*Refusing to start/i);
    assert.equal(fs.readFileSync(path.join(sample.dataDir, 'db.json'), 'utf8'), sample.raw);
    assert.equal(fs.readFileSync(path.join(sample.dataDir, 'db.json.bak'), 'utf8'), sample.backup);
  });
}

test('a valid legacy baseline with missing B2B2C fields migrates once', async t => {
  const sample = fixture(t, { users: [], creds: [], subs: [], invites: [] });
  const server = start(sample.dataDir);
  await boundPort(server.child, server.log);
  await stop(server.child);
  const stored = JSON.parse(fs.readFileSync(path.join(sample.dataDir, 'db.json'), 'utf8'));
  assert.equal(stored.schemaVersion, 8);
  assert.deepEqual(stored.coachInvites, []);
  assert.deepEqual(stored.coachAthleteLinks, []);
  assert.deepEqual(stored.coachPrescriptions, []);
  assert.deepEqual(stored.coachAssessments, []);
  assert.deepEqual(stored.mealPlans, []);
  assert.deepEqual(stored.mealAdherence, []);
  assert.deepEqual(stored.coachMessages, []);
  assert.deepEqual(stored.coachHabits, []);
  assert.deepEqual(stored.habitCheckins, []);
  assert.deepEqual(stored.progressGoals, []);
  assert.deepEqual(stored.progressReports, []);
  assert.deepEqual(stored.coachAvailability, []);
  assert.deepEqual(stored.coachAppointments, []);
});

test('known schema versions migrate to version 8', async t => {
  for (const schemaVersion of [1, 2, 3, 4, 5, 6, 7]) {
    const sample = fixture(t, { schemaVersion, users: [], creds: [], subs: [], invites: [] });
    const server = start(sample.dataDir);
    await boundPort(server.child, server.log);
    await stop(server.child);
    const stored = JSON.parse(fs.readFileSync(path.join(sample.dataDir, 'db.json'), 'utf8'));
    assert.equal(stored.schemaVersion, 8);
    assert.deepEqual(stored.coachInvites, []);
    assert.deepEqual(stored.coachAthleteLinks, []);
    assert.deepEqual(stored.coachPrescriptions, []);
    assert.deepEqual(stored.coachAssessments, []);
    assert.deepEqual(stored.mealPlans, []);
    assert.deepEqual(stored.mealAdherence, []);
    assert.deepEqual(stored.coachMessages, []);
    assert.deepEqual(stored.coachHabits, []);
    assert.deepEqual(stored.habitCheckins, []);
    assert.deepEqual(stored.progressGoals, []);
    assert.deepEqual(stored.progressReports, []);
    assert.deepEqual(stored.coachAvailability, []);
    assert.deepEqual(stored.coachAppointments, []);
  }
});

test('historical archived goals and revoked reports migrate once without changing historical payloads', async t => {
  const timestamp = '2026-06-01T12:00:00.000Z';
  const snapshot = { version: 1, generatedAt: timestamp, period: { from: '2026-05-01', to: '2026-05-31' }, metrics: { body_weight: { available: false } } };
  const sample = fixture(t, {
    schemaVersion: 7, users: [], creds: [], subs: [], invites: [], coachInvites: [], coachPrescriptions: [], coachAssessments: [],
    mealPlans: [], mealAdherence: [], coachMessages: [], coachHabits: [], habitCheckins: [], accountCleanupJobs: [],
    coachAthleteLinks: [{ id: 'cal_history', coachId: 'u_coach', athleteId: 'u_athlete', scopes: ['assessments'], status: 'ended', createdAt: timestamp, updatedAt: timestamp, endedAt: timestamp }],
    progressGoals: [{
      id: 'pgoal_history', linkId: 'cal_history', coachId: 'u_coach', athleteId: 'u_athlete', metric: 'body_weight',
      direction: 'decrease', baselineValue: 90, targetValue: 85, tolerance: 0.5, startDate: '2026-05-01', targetDate: '2026-05-31',
      timezone: 'UTC', status: 'archived', createdAt: timestamp, updatedAt: timestamp, achievedAt: null, archivedAt: timestamp,
    }],
    progressReports: [{
      id: 'prep_history', linkId: 'cal_history', coachId: 'u_coach', athleteId: 'u_athlete', interval: { from: '2026-05-01', to: '2026-05-31' },
      timezone: 'UTC', metrics: ['body_weight'], summary: 'body_weight: historical.', snapshot, createdAt: timestamp, revokedAt: timestamp,
    }],
  });
  let server = start(sample.dataDir);
  await boundPort(server.child, server.log);
  await stop(server.child);
  const firstText = fs.readFileSync(path.join(sample.dataDir, 'db.json'), 'utf8');
  const first = JSON.parse(firstText);
  assert.deepEqual({ unit: first.progressGoals[0].unit, rev: first.progressGoals[0]._rev, reason: first.progressGoals[0].archiveReason }, { unit: 'kg', rev: 1, reason: 'manual' });
  assert.equal(first.progressReports[0].revocation, null);
  assert.deepEqual(first.progressReports[0].snapshot, snapshot);
  assert.equal(first.progressReports[0].createdAt, timestamp);
  assert.equal(first.progressReports[0].revokedAt, timestamp);

  server = start(sample.dataDir);
  await boundPort(server.child, server.log);
  await stop(server.child);
  assert.equal(fs.readFileSync(path.join(sample.dataDir, 'db.json'), 'utf8'), firstText);
});

test('version 3 assessment PAR-Q answers migrate to stable question ids without granting new consent', async t => {
  const sample = fixture(t, {
    schemaVersion: 3,
    users: [], creds: [], subs: [], invites: [], coachInvites: [], coachPrescriptions: [],
    coachAthleteLinks: [{ id: 'cal_1', coachId: 'u_coach', athleteId: 'u_athlete', scopes: ['training'], status: 'active' }],
    coachAssessments: [{
      id: 'cas_1', coachId: 'u_coach', athleteId: 'u_athlete', assessedAt: '2026-01-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      parq: { answers: [false, false, false, false, false, false, true], notes: 'legacy' },
    }],
  });
  const server = start(sample.dataDir);
  await boundPort(server.child, server.log);
  await stop(server.child);
  const stored = JSON.parse(fs.readFileSync(path.join(sample.dataDir, 'db.json'), 'utf8'));
  assert.deepEqual(stored.coachAthleteLinks[0].scopes, ['training']);
  assert.equal(stored.coachAssessments[0].parq.version, '2024.1');
  assert.equal(stored.coachAssessments[0].parq.answers[6].questionId, 'other_reason');
  assert.equal(stored.coachAssessments[0].requiresMedicalClearance, true);
});

test('orphan scheduling participant refuses boot without rewriting primary or backup', async t => {
  await assertSchedulingBootRefused(t, schedulingFixture([validAppointment({ coachId: 'u_missing' })]));
});

test('mismatched scheduling link refuses boot without rewriting primary or backup', async t => {
  await assertSchedulingBootRefused(t, schedulingFixture([validAppointment({ athleteId: 'u_coach' })]));
});

test('overlapping scheduled appointments refuse boot without rewriting primary or backup', async t => {
  await assertSchedulingBootRefused(t, schedulingFixture([
    validAppointment(),
    validAppointment({ id: 'capp_2', startAt: '2026-06-01T10:30:00.000Z', endAt: '2026-06-01T11:30:00.000Z' }),
  ]));
});

function reminderFixture() {
  const db = schedulingFixture([
    validAppointment(),
    validAppointment({ id: 'capp_2', startAt: '2026-06-02T10:00:00.000Z', endAt: '2026-06-02T11:00:00.000Z', localDate: '2026-06-02' }),
  ]);
  db.schedulingReminderPreferences = [{
    userId: 'u_coach', enabled: true, offsetsMinutes: [60], timeZone: 'UTC', updatedAt: '2026-01-01T00:00:00.000Z',
  }];
  db.appointmentReminderStates = [{
    id: 'srem_boot', appointmentId: 'capp_1', userId: 'u_coach', offsetMinutes: 60,
    scheduledFor: '2026-06-01T09:00:00.000Z', status: 'pending', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  }];
  db.schedulingReminderOutbox = [{
    id: 'sout_boot', reminderStateId: 'srem_boot', appointmentId: 'capp_1', userId: 'u_coach', offsetMinutes: 60,
    scheduledFor: '2026-06-01T09:00:00.000Z', status: 'pending', attempts: 0, nextAttemptAt: '2026-06-01T09:00:00.000Z',
    leaseId: null, leaseExpiresAt: null, lastAttemptAt: null, deliveredAt: null, failedAt: null, canceledAt: null,
    idempotencyKey: 'appointment-reminder:srem_boot', payload: { type: 'appointment_reminder', appointmentId: 'capp_1' },
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  }];
  return db;
}

test('cross-user reminder outbox refuses boot without rewriting primary or backup', async t => {
  const db = reminderFixture();
  db.schedulingReminderOutbox[0].userId = 'u_athlete';
  await assertSchedulingBootRefused(t, db);
});

test('cross-appointment reminder outbox refuses boot without rewriting primary or backup', async t => {
  const db = reminderFixture();
  db.schedulingReminderOutbox[0].appointmentId = 'capp_2';
  db.schedulingReminderOutbox[0].payload.appointmentId = 'capp_2';
  await assertSchedulingBootRefused(t, db);
});
