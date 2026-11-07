import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReminderDispatcher } from '../reminder-dispatcher.js';
import { reconcileAppointmentReminders } from '../scheduling.js';

const start = Date.parse('2026-11-07T12:00:00.000Z');

function reminderDb(overrides = {}) {
  const scheduledFor = new Date(start - 60_000).toISOString();
  return {
    users: [
      { id: 'coach_1', profile: { kind: 'coach', coachSpecialties: ['training'] } },
      { id: 'athlete_1', profile: { kind: 'athlete' } },
    ],
    coachAthleteLinks: [{ id: 'link_1', coachId: 'coach_1', athleteId: 'athlete_1', scopes: ['training'], status: 'active' }],
    coachAppointments: [{
      id: 'appointment_1', linkId: 'link_1', coachId: 'coach_1', athleteId: 'athlete_1', status: 'scheduled',
      startAt: '2026-11-07T13:00:00.000Z', endAt: '2026-11-07T14:00:00.000Z',
    }],
    schedulingReminderPreferences: [],
    appointmentReminderStates: [{
      id: 'srem_1', appointmentId: 'appointment_1', userId: 'coach_1', offsetMinutes: 60,
      scheduledFor, status: 'pending', createdAt: scheduledFor, updatedAt: scheduledFor,
    }],
    schedulingReminderOutbox: [{
      id: 'sout_1', reminderStateId: 'srem_1', appointmentId: 'appointment_1', userId: 'coach_1', offsetMinutes: 60,
      scheduledFor, status: 'pending', attempts: 0, nextAttemptAt: scheduledFor,
      leaseId: null, leaseExpiresAt: null, lastAttemptAt: null, deliveredAt: null, failedAt: null, canceledAt: null,
      idempotencyKey: 'appointment-reminder:srem_1', payload: { type: 'appointment_reminder', appointmentId: 'appointment_1' },
      createdAt: scheduledFor, updatedAt: scheduledFor,
    }],
    ...overrides,
  };
}

function harness({ db = reminderDb(), deliver, commitHook, now = start, config = {} } = {}) {
  let current = structuredClone(db);
  let clock = now;
  let commits = 0;
  const dispatcher = createReminderDispatcher({
    getDb: () => current,
    commit: async candidate => {
      commits++;
      if (commitHook) await commitHook({ candidate, commits, current });
      current = structuredClone(candidate);
    },
    deliver: deliver || (async () => ({ status: 'delivered' })),
    now: () => clock,
    randomId: () => `lease_${commits + 1}`,
    config: { leaseMs: 1000, baseRetryMs: 1000, maxRetryMs: 4000, maxAttempts: 3, batchSize: 10, ...config },
  });
  return {
    dispatcher,
    db: () => current,
    commits: () => commits,
    setNow: value => { clock = value; },
  };
}

function outbox(h) { return h.db().schedulingReminderOutbox[0]; }
function state(h) { return h.db().appointmentReminderStates[0]; }

test('due reminder is claimed durably and concurrent ticks deliver it once', async () => {
  const deliveries = [];
  const h = harness({ deliver: async delivery => { deliveries.push(delivery); return { status: 'delivered' }; } });
  await Promise.all([h.dispatcher.tick(), h.dispatcher.tick()]);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].idempotencyKey, 'appointment-reminder:srem_1');
  assert.equal(outbox(h).status, 'delivered');
  assert.equal(state(h).status, 'delivered');
  await h.dispatcher.tick();
  assert.equal(deliveries.length, 1);
});

test('restart recovers an expired persisted lease with bounded backoff', async () => {
  const db = reminderDb();
  db.schedulingReminderOutbox[0].status = 'processing';
  db.schedulingReminderOutbox[0].attempts = 1;
  db.schedulingReminderOutbox[0].leaseId = 'dead_process';
  db.schedulingReminderOutbox[0].leaseExpiresAt = new Date(start - 1).toISOString();
  db.appointmentReminderStates[0].status = 'processing';
  const deliveries = [];
  const h = harness({ db, deliver: async item => { deliveries.push(item); return { status: 'delivered' }; } });
  await h.dispatcher.tick();
  assert.equal(outbox(h).status, 'retry');
  assert.equal(deliveries.length, 0);
  h.setNow(start + 2000);
  await h.dispatcher.tick();
  assert.equal(deliveries.length, 1);
  assert.equal(outbox(h).status, 'delivered');
});

test('transient delivery failure retries with exponential backoff and then delivers', async () => {
  let calls = 0;
  const h = harness({ deliver: async () => (++calls === 1 ? { status: 'retry' } : { status: 'delivered' }) });
  await h.dispatcher.tick();
  assert.equal(outbox(h).status, 'retry');
  assert.equal(outbox(h).attempts, 1);
  assert.equal(Date.parse(outbox(h).nextAttemptAt), start + 1000);
  h.setNow(start + 999);
  await h.dispatcher.tick();
  assert.equal(calls, 1);
  h.setNow(start + 1000);
  await h.dispatcher.tick();
  assert.equal(calls, 2);
  assert.equal(outbox(h).status, 'delivered');
});

test('persistent delivery failure reaches terminal failed at the configured limit', async () => {
  let calls = 0;
  const h = harness({ deliver: async () => { calls++; return { status: 'retry' }; } });
  for (const at of [start, start + 1000, start + 3000]) {
    h.setNow(at);
    await h.dispatcher.tick();
  }
  assert.equal(calls, 3);
  assert.equal(outbox(h).attempts, 3);
  assert.equal(outbox(h).status, 'failed');
  assert.equal(state(h).status, 'failed');
  h.setNow(start + 100_000);
  await h.dispatcher.tick();
  assert.equal(calls, 3);
});

test('cancellation and rescheduling before a tick prevent stale delivery', async () => {
  const db = reminderDb();
  db.schedulingReminderPreferences.push({
    userId: 'coach_1', enabled: true, offsetsMinutes: [60], timeZone: 'UTC', updatedAt: new Date(start).toISOString(),
  });
  db.coachAppointments[0].startAt = '2026-11-07T15:00:00.000Z';
  db.coachAppointments[0].endAt = '2026-11-07T16:00:00.000Z';
  reconcileAppointmentReminders(db, db.coachAppointments[0], start, { userId: 'coach_1' });
  const deliveries = [];
  const h = harness({ db, deliver: async item => { deliveries.push(item); return { status: 'delivered' }; } });
  await h.dispatcher.tick();
  assert.equal(deliveries.length, 0);
  assert.equal(outbox(h).scheduledFor, '2026-11-07T14:00:00.000Z');

  const canceledDb = structuredClone(h.db());
  canceledDb.coachAppointments[0].status = 'canceled';
  reconcileAppointmentReminders(canceledDb, canceledDb.coachAppointments[0], start + 1000);
  const canceled = harness({ db: canceledDb, deliver: async item => { deliveries.push(item); return { status: 'delivered' }; }, now: Date.parse('2026-11-07T15:00:00.000Z') });
  await canceled.dispatcher.tick();
  assert.equal(deliveries.length, 0);
  assert.equal(outbox(canceled).status, 'canceled');
});

test('save failures never publish an uncommitted claim or completion', async () => {
  let deliveries = 0;
  const claimFailure = harness({
    deliver: async () => { deliveries++; return { status: 'delivered' }; },
    commitHook: async ({ commits }) => { if (commits === 1) throw new Error('disk full'); },
  });
  await assert.rejects(claimFailure.dispatcher.tick(), /disk full/);
  assert.equal(deliveries, 0);
  assert.equal(outbox(claimFailure).status, 'pending');

  const deliveredKeys = new Set();
  let failCompletion = true;
  const completionFailure = harness({
    deliver: async ({ idempotencyKey }) => {
      const duplicate = deliveredKeys.has(idempotencyKey);
      deliveredKeys.add(idempotencyKey);
      return { status: 'delivered', duplicate };
    },
    commitHook: async ({ candidate }) => {
      if (failCompletion && candidate.schedulingReminderOutbox[0].status === 'delivered') {
        failCompletion = false;
        throw new Error('completion save failed');
      }
    },
  });
  await assert.rejects(completionFailure.dispatcher.tick(), /completion save failed/);
  assert.equal(outbox(completionFailure).status, 'processing');
  completionFailure.setNow(start + 2000);
  await completionFailure.dispatcher.tick();
  assert.equal(deliveredKeys.size, 1);
  assert.equal(outbox(completionFailure).status, 'retry');
  completionFailure.setNow(start + 4000);
  await completionFailure.dispatcher.tick();
  assert.equal(deliveredKeys.size, 1);
  assert.equal(outbox(completionFailure).status, 'delivered');
});

test('dispatcher preserves user and appointment isolation in each delivery', async () => {
  const db = reminderDb();
  const secondState = {
    ...structuredClone(db.appointmentReminderStates[0]), id: 'srem_2', userId: 'athlete_1', offsetMinutes: 30,
  };
  const secondOutbox = {
    ...structuredClone(db.schedulingReminderOutbox[0]), id: 'sout_2', reminderStateId: 'srem_2', userId: 'athlete_1', offsetMinutes: 30,
    idempotencyKey: 'appointment-reminder:srem_2',
  };
  db.appointmentReminderStates.push(secondState);
  db.schedulingReminderOutbox.push(secondOutbox);
  const deliveries = [];
  const h = harness({ db, deliver: async item => { deliveries.push(item); return { status: 'delivered' }; } });
  await h.dispatcher.tick();
  assert.deepEqual(deliveries.map(item => [item.userId, item.appointmentId, item.offsetMinutes]).sort(), [
    ['athlete_1', 'appointment_1', 30],
    ['coach_1', 'appointment_1', 60],
  ]);
});

test('dispatcher lifecycle schedules one timer and teardown clears it and drains work', async () => {
  const scheduled = [];
  const cleared = [];
  let release;
  let current = reminderDb();
  const dispatcher = createReminderDispatcher({
    getDb: () => current,
    commit: candidate => { current = structuredClone(candidate); },
    deliver: () => new Promise(resolve => { release = resolve; }),
    now: () => start,
    setIntervalFn: (fn, ms) => { const handle = { fn, ms, unref() {} }; scheduled.push(handle); return handle; },
    clearIntervalFn: handle => cleared.push(handle),
    config: { tickMs: 250, leaseMs: 1000, baseRetryMs: 1000, maxRetryMs: 4000, maxAttempts: 3, batchSize: 10 },
  });
  dispatcher.start();
  dispatcher.start();
  assert.equal(scheduled.length, 1);
  const tick = scheduled[0].fn();
  const stopping = dispatcher.stop();
  release({ status: 'delivered' });
  await tick;
  await stopping;
  assert.deepEqual(cleared, scheduled);
});
