import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = path.join(API, 'test/fixtures/reminder-process-worker.mjs');
const now = Date.parse('2026-11-07T12:00:00.000Z');

function reminderDb() {
  const scheduledFor = new Date(now - 60_000).toISOString();
  return {
    users: [{ id: 'coach_1', profile: { kind: 'coach', coachSpecialties: ['training'] } }, { id: 'athlete_1', profile: { kind: 'athlete' } }],
    coachAthleteLinks: [{ id: 'link_1', coachId: 'coach_1', athleteId: 'athlete_1', scopes: ['training'], status: 'active' }],
    coachAppointments: [{ id: 'appointment_1', linkId: 'link_1', coachId: 'coach_1', athleteId: 'athlete_1', status: 'scheduled' }],
    schedulingReminderPreferences: [{ userId: 'coach_1', enabled: true, offsetsMinutes: [60], timeZone: 'UTC', updatedAt: scheduledFor }],
    appointmentReminderStates: [{ id: 'srem_1', appointmentId: 'appointment_1', userId: 'coach_1', offsetMinutes: 60, scheduledFor, status: 'pending', createdAt: scheduledFor, updatedAt: scheduledFor }],
    schedulingReminderOutbox: [{
      id: 'sout_1', reminderStateId: 'srem_1', appointmentId: 'appointment_1', userId: 'coach_1', offsetMinutes: 60,
      scheduledFor, status: 'pending', attempts: 0, nextAttemptAt: scheduledFor, leaseId: null, leaseExpiresAt: null,
      lastAttemptAt: null, deliveryAttemptId: null, deliveryStartedAt: null, deliveredAt: null, failedAt: null,
      canceledAt: null, deliveryUncertainAt: null, idempotencyKey: 'appointment-reminder:srem_1',
      payload: { type: 'appointment_reminder' }, createdAt: scheduledFor, updatedAt: scheduledFor,
    }],
  };
}

async function runPair(t, mode, db) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-reminder-mp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbFile = path.join(dir, 'db.json');
  const barrier = path.join(dir, 'barrier');
  const sink = path.join(dir, 'sink');
  fs.mkdirSync(barrier);
  fs.writeFileSync(dbFile, JSON.stringify(db, null, 2));
  const children = ['a', 'b'].map(name => spawn(process.execPath, [WORKER, mode, dbFile, barrier, mode === 'dispatch' ? sink : name, String(now)], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
  }));
  const logs = new Map(children.map(child => [child, '']));
  for (const child of children) {
    child.stdout.on('data', chunk => logs.set(child, logs.get(child) + chunk));
    child.stderr.on('data', chunk => logs.set(child, logs.get(child) + chunk));
  }
  const deadline = Date.now() + 10_000;
  while (fs.readdirSync(barrier).filter(name => name.startsWith('ready-')).length < 2) {
    const exited = children.find(child => child.exitCode !== null);
    if (exited) throw new Error(logs.get(exited));
    if (Date.now() > deadline) throw new Error('workers did not reach barrier');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  fs.writeFileSync(path.join(barrier, 'go'), '');
  await Promise.all(children.map(child => new Promise((resolve, reject) => child.once('exit', code => code === 0 ? resolve() : reject(new Error(logs.get(child)))))));
  return { db: JSON.parse(fs.readFileSync(dbFile, 'utf8')), sink: fs.existsSync(sink) ? fs.readFileSync(sink, 'utf8').trim().split('\n').filter(Boolean) : [] };
}

test('two real Node processes sharing db.json invoke the provider once and persist one claim', async t => {
  const result = await runPair(t, 'dispatch', reminderDb());
  assert.deepEqual(result.sink, ['appointment-reminder:srem_1']);
  assert.equal(result.db.schedulingReminderOutbox[0].attempts, 1);
  assert.equal(result.db.schedulingReminderOutbox[0].status, 'delivered');
});

test('two real processes with stale clones preserve both non-conflicting mutations', async t => {
  const result = await runPair(t, 'merge', { seed: true });
  assert.equal(result.db.worker_a > 0, true);
  assert.equal(result.db.worker_b > 0, true);
});
