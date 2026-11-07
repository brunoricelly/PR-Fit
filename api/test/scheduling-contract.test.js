import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as scheduling from '../scheduling.js';

const minute = 60_000;

function availability(timezone, windows, overrides = {}) {
  return {
    coachId: 'coach_1',
    timezone,
    sessionDurationMinutes: 60,
    bufferMinutes: 0,
    minNoticeHours: 0,
    maxAdvanceDays: 365,
    windows,
    exceptions: [],
    ...overrides,
  };
}

function schedulingDb(appointments = []) {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    users: [
      { id: 'coach_1', profile: { kind: 'coach', coachSpecialties: ['training'] } },
      { id: 'athlete_1', profile: { kind: 'athlete' } },
    ],
    coachAthleteLinks: [{
      id: 'link_1', coachId: 'coach_1', athleteId: 'athlete_1', scopes: ['training'],
      status: 'active', createdAt: now, updatedAt: now,
    }],
    coachAvailability: [],
    coachAppointments: appointments,
    schedulingReminderPreferences: [],
    appointmentReminderStates: [],
    schedulingReminderOutbox: [],
  };
}

function appointment(overrides = {}) {
  return {
    id: 'appointment_1',
    linkId: 'link_1',
    coachId: 'coach_1',
    athleteId: 'athlete_1',
    type: 'in_person',
    title: 'Session',
    notes: '',
    startAt: '2026-06-01T10:00:00.000Z',
    endAt: '2026-06-01T11:00:00.000Z',
    timeZone: 'UTC',
    localDate: '2026-06-01',
    durationMinutes: 60,
    status: 'scheduled',
    cancellation: null,
    location: null,
    meetingUrl: null,
    attendance: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

test('civil time conversion rejects gaps and chooses the earlier instant for folds', () => {
  assert.equal(scheduling.zonedTimeToUtcMs('2026-03-08', '02:30', 'America/New_York'), null);
  assert.equal(
    new Date(scheduling.zonedTimeToUtcMs('2026-11-01', '01:30', 'America/New_York')).toISOString(),
    '2026-11-01T05:30:00.000Z',
  );
  assert.equal(scheduling.zonedTimeToUtcMs('2026-03-29', '02:30', 'Europe/Berlin'), null);
  assert.equal(
    new Date(scheduling.zonedTimeToUtcMs('2026-10-25', '01:30', 'Europe/Lisbon')).toISOString(),
    '2026-10-25T00:30:00.000Z',
  );
});

test('slot generation never emits impossible, duplicate, or non-exact real durations', () => {
  const cases = [
    ['America/New_York', '2026-03-08', { dayOfWeek: 0, start: '01:00', end: '04:00' }],
    ['America/New_York', '2026-11-01', { dayOfWeek: 0, start: '00:00', end: '04:00' }],
    ['Europe/Berlin', '2026-03-29', { dayOfWeek: 0, start: '01:00', end: '04:00' }],
    ['Europe/Lisbon', '2026-10-25', { dayOfWeek: 0, start: '00:00', end: '04:00' }],
    ['America/Sao_Paulo', '2026-06-01', { dayOfWeek: 1, start: '08:00', end: '12:00' }],
    ['Asia/Tokyo', '2026-06-01', { dayOfWeek: 1, start: '08:00', end: '12:00' }],
    ['Pacific/Kiritimati', '2026-06-01', { dayOfWeek: 1, start: '08:00', end: '12:00' }],
  ];

  for (const [timezone, date, window] of cases) {
    const slots = scheduling.calculateAvailabilitySlots({
      availability: availability(timezone, [window]),
      nowMs: Date.parse('2026-01-01T00:00:00.000Z'),
      fromDate: date,
      toDate: date,
    });
    const starts = new Set(slots.map(slot => slot.startAt));
    assert.equal(starts.size, slots.length, `${timezone} emitted duplicate slots`);
    for (const slot of slots) {
      assert.equal(Date.parse(slot.endAt) - Date.parse(slot.startAt), 60 * minute, timezone);
      assert.ok(Date.parse(slot.endAt) > Date.parse(slot.startAt), timezone);
      assert.equal(slot.localDate, date, timezone);
      assert.equal(slot.timeZone, timezone, timezone);
    }
  }
});

test('appointment input requires RFC 3339 offset and configured duration', () => {
  assert.equal(scheduling.validateAppointmentPayload({ startAt: '2026-06-01 10:00:00' }), null);
  assert.equal(scheduling.validateAppointmentPayload({ startAt: 'June 1 2026 10:00' }), null);
  assert.equal(scheduling.validateAppointmentPayload({
    startAt: '2026-06-01T10:00:00Z', endAt: '2026-06-01T12:00:00Z',
  }, { defaultDuration: 60 }), null);
  assert.ok(scheduling.validateAppointmentPayload({
    startAt: '2026-06-01T10:00:00-03:00', endAt: '2026-06-01T11:00:00-03:00',
  }, { defaultDuration: 60 }));
});

test('availability supports CAS metadata and date exceptions', () => {
  const parsed = scheduling.validateAvailabilityInput({
    _rev: 4,
    timezone: 'America/New_York',
    sessionDurationMinutes: 60,
    bufferMinutes: 0,
    minNoticeHours: 2,
    maxAdvanceDays: 365,
    windows: [{ dayOfWeek: 1, start: '09:00', end: '12:00' }],
    exceptions: [
      { date: '2026-07-06', unavailable: true },
      { date: '2026-07-07', windows: [{ start: '14:00', end: '16:00' }] },
    ],
  });
  assert.equal(parsed._rev, 4);
  assert.equal(parsed.exceptions.length, 2);
});

test('schema v8 scheduling validation is fail-closed for orphan, mismatched link, and overlap', () => {
  const orphan = schedulingDb([appointment({ coachId: 'missing_coach' })]);
  assert.throws(() => scheduling.validateSchedulingState(orphan), /coach|participant|user/i);

  const mismatched = schedulingDb([appointment({ athleteId: 'coach_1' })]);
  assert.throws(() => scheduling.validateSchedulingState(mismatched), /link|participant/i);

  const overlap = schedulingDb([
    appointment({ id: 'appointment_1' }),
    appointment({ id: 'appointment_2', athleteId: 'athlete_1', startAt: '2026-06-01T10:30:00.000Z', endAt: '2026-06-01T11:30:00.000Z' }),
  ]);
  assert.throws(() => scheduling.validateSchedulingState(overlap), /overlap/i);
});

test('relationship transition cancellation preserves ended history at the cutoff', () => {
  const db = schedulingDb([
    appointment({ id: 'past', startAt: '2026-05-01T10:00:00.000Z', endAt: '2026-05-01T11:00:00.000Z' }),
    appointment({ id: 'future', startAt: '2026-07-01T10:00:00.000Z', endAt: '2026-07-01T11:00:00.000Z' }),
  ]);
  scheduling.cancelFutureAppointmentsForLink(db, 'link_1', 'relationship_ended', 'coach_1', Date.parse('2026-06-01T00:00:00.000Z'));
  assert.equal(db.coachAppointments.find(item => item.id === 'past').status, 'scheduled');
  const future = db.coachAppointments.find(item => item.id === 'future');
  assert.equal(future.status, 'canceled');
  assert.deepEqual(future.cancellation, {
    actor: 'system', actorId: 'coach_1', reason: 'relationship_ended', canceledAt: '2026-06-01T00:00:00.000Z',
  });
});

test('scheduling migration initializes reminder collections without accepting future schema', () => {
  const db = schedulingDb();
  delete db.schedulingReminderPreferences;
  delete db.appointmentReminderStates;
  delete db.schedulingReminderOutbox;
  assert.equal(scheduling.migrateSchedulingState(db), true);
  assert.deepEqual(db.schedulingReminderPreferences, []);
  assert.deepEqual(db.appointmentReminderStates, []);
  assert.deepEqual(db.schedulingReminderOutbox, []);
});
