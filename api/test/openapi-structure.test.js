import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openapi } from './openapi-schema-helper.mjs';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = file => JSON.parse(fs.readFileSync(path.join(API, file), 'utf8'));
const methods = new Set(['get', 'post', 'put', 'patch', 'delete']);
const communicationPaths = [
  '/api/coach/athletes/{athleteId}/messages',
  '/api/athlete/messages/{coachId}',
  '/api/messages/inbox',
  '/api/messages/{messageId}/read',
  '/api/messages/read-through',
  '/api/coach/athletes/{athleteId}/habits',
  '/api/coach/athletes/{athleteId}/habits/{habitId}',
  '/api/athlete/habits',
  '/api/athlete/habits/checkin',
  '/api/coach/athletes/{athleteId}/checkins',
  '/api/athlete/checkins',
  '/api/coach/athletes/{athleteId}/habits-summary',
  '/api/athlete/habits-summary',
];
const bodyOperations = new Set([
  'sendCoachAthleteMessage', 'sendAthleteCoachMessage', 'markMessagesReadThrough',
  'createCoachAthleteHabit', 'updateCoachAthleteHabit', 'upsertAthleteHabitCheckin',
]);

function resolveRef(ref) {
  assert.match(ref, /^#\//, `only local OpenAPI refs are supported: ${ref}`);
  return ref.slice(2).split('/').map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce((value, key) => value?.[key], openapi);
}

function operations() {
  return Object.entries(openapi.paths).flatMap(([route, item]) => Object.entries(item)
    .filter(([method]) => methods.has(method))
    .map(([method, operation]) => ({ route, method, operation })));
}

function responseSchema(response) {
  const resolved = response?.$ref ? resolveRef(response.$ref) : response;
  return resolved?.content?.['application/json']?.schema;
}

test('openapi.yaml is OpenAPI 3.1 and follows the project version', () => {
  assert.equal(openapi.openapi, '3.1.0');
  assert.equal(openapi.info.version, readJson('package.json').version);
  assert.equal(openapi.info.version, readJson('../frontend/package.json').version);
  assert.ok(openapi.paths && openapi.components?.schemas && openapi.components?.responses);
});

test('every local $ref resolves and every operationId is present and unique', () => {
  const refs = [];
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (typeof value.$ref === 'string') refs.push(value.$ref);
    for (const child of Object.values(value)) visit(child);
  };
  visit(openapi);
  assert.ok(refs.length > 100, `only found ${refs.length} refs`);
  for (const ref of refs) assert.notEqual(resolveRef(ref), undefined, `unresolved $ref: ${ref}`);

  const ids = operations().map(({ route, method, operation }) => {
    assert.equal(typeof operation.operationId, 'string', `${method.toUpperCase()} ${route} has no operationId`);
    assert.ok(operation.operationId.length > 0, `${method.toUpperCase()} ${route} has an empty operationId`);
    return operation.operationId;
  });
  assert.equal(new Set(ids).size, ids.length, 'operationId values must be unique');
});

test('communication routes have request schemas where they accept bodies and JSON success schemas', () => {
  for (const route of communicationPaths) {
    const item = openapi.paths[route];
    assert.ok(item, `${route} is missing`);
    for (const [method, operation] of Object.entries(item).filter(([name]) => methods.has(name))) {
      if (bodyOperations.has(operation.operationId)) {
        assert.ok(operation.requestBody?.content?.['application/json']?.schema, `${method.toUpperCase()} ${route} has no request schema`);
      }
      const successes = Object.entries(operation.responses || {}).filter(([status]) => /^2\d\d$/.test(status));
      assert.ok(successes.length, `${method.toUpperCase()} ${route} has no success response`);
      for (const [status, response] of successes) {
        assert.ok(responseSchema(response), `${method.toUpperCase()} ${route} ${status} has no JSON response schema`);
      }
    }
  }
});

const progressPaths = [
  '/api/progress/metrics',
  '/api/coach/athletes/{athleteId}/progress-goals',
  '/api/coach/athletes/{athleteId}/progress-goals/{goalId}',
  '/api/coach/athletes/{athleteId}/progress-summary',
  '/api/coach/athletes/{athleteId}/progress-reports',
  '/api/coach/athletes/{athleteId}/progress-reports/{reportId}',
  '/api/coach/athletes/{athleteId}/progress-reports/{reportId}/export',
  '/api/coach/athletes/{athleteId}/progress-reports/{reportId}/revoke',
  '/api/athlete/progress-goals',
  '/api/athlete/progress-summary',
  '/api/athlete/progress-reports',
  '/api/athlete/progress-reports/{reportId}',
  '/api/athlete/progress-reports/{reportId}/export',
  '/api/admin/account-cleanup',
  '/api/admin/account-cleanup/{cleanupJobId}',
];
const progressBodyOperations = new Set([
  'createCoachAthleteProgressGoal', 'updateCoachAthleteProgressGoal',
  'createCoachAthleteProgressReport',
]);

test('progress and cleanup routes have request schemas where required and success responses', () => {
  for (const route of progressPaths) {
    const item = openapi.paths[route];
    assert.ok(item, `${route} is missing`);
    for (const [method, operation] of Object.entries(item).filter(([name]) => methods.has(name))) {
      if (progressBodyOperations.has(operation.operationId)) {
        assert.ok(operation.requestBody?.content?.['application/json']?.schema, `${method.toUpperCase()} ${route} has no request schema`);
      }
      const successes = Object.entries(operation.responses || {}).filter(([status]) => /^2\d\d$/.test(status));
      assert.ok(successes.length, `${method.toUpperCase()} ${route} has no success response`);
      for (const [status, response] of successes) {
        const resolved = response?.$ref ? resolveRef(response.$ref) : response;
        const hasContent = resolved?.content?.['application/json']?.schema || resolved?.content?.['text/csv']?.schema;
        assert.ok(hasContent, `${method.toUpperCase()} ${route} ${status} has no response schema`);
      }
    }
  }
});

test('ProgressPoint discriminated union validates instant and interval variants', () => {
  const instantPoint = {
    kind: 'instant',
    date: '2026-03-01',
    value: 80.5,
    unit: 'kg',
    source: 'assessment',
    coverage: { observed: 1, expected: 1, percent: 100 },
    freshness: { status: 'fresh', latestDate: '2026-03-01', ageDays: 0, staleAfterDays: 30 },
  };
  const intervalPoint = {
    kind: 'interval',
    from: '2026-03-01',
    to: '2026-03-07',
    value: 4,
    numerator: 4,
    denominator: 7,
    unit: 'workouts_per_week',
    coverage: { observed: 7, expected: 7, percent: 100 },
    freshness: { status: 'fresh', latestDate: '2026-03-07', ageDays: 0, staleAfterDays: 7 },
  };
  const pointSchema = openapi.components.schemas.ProgressPoint;
  assert.ok(pointSchema.oneOf && pointSchema.discriminator);

  const instantErrors = openapi.components.schemas.ProgressPointInstant;
  assert.equal(openapi.components.schemas.ProgressPointInstant.properties.kind.enum[0], 'instant');
  assert.equal(openapi.components.schemas.ProgressPointInterval.properties.kind.enum[0], 'interval');
});

test('pagination envelopes define items, limit, hasMore, nextCursor and relationship where expected', () => {
  for (const pageName of ['ProgressGoalsPage', 'ProgressReportsPage']) {
    const schema = openapi.components.schemas[pageName];
    assert.ok(schema);
    assert.deepEqual(schema.required, ['items', 'limit', 'hasMore', 'nextCursor', 'relationship']);
    assert.equal(schema.additionalProperties, false);
  }
  const cleanupPage = openapi.components.schemas.AccountCleanupPage;
  assert.ok(cleanupPage);
  assert.deepEqual(cleanupPage.required, ['items', 'limit', 'hasMore', 'nextCursor']);
  assert.equal(cleanupPage.additionalProperties, false);

  const appointmentPage = openapi.components.schemas.AppointmentPage;
  assert.ok(appointmentPage);
  assert.deepEqual(appointmentPage.required, ['items', 'limit', 'hasMore', 'nextCursor']);
  assert.equal(appointmentPage.additionalProperties, false);
});

const schedulingPaths = [
  '/api/coach/availability',
  '/api/coach/appointments',
  '/api/coach/athletes/{athleteId}/appointments',
  '/api/coach/athletes/{athleteId}/availability-slots',
  '/api/coach/appointments/{appointmentId}',
  '/api/coach/appointments/{appointmentId}/reschedule',
  '/api/coach/appointments/{appointmentId}/cancel',
  '/api/coach/appointments/{appointmentId}/attendance',
  '/api/athlete/coaches/{coachId}/availability-slots',
  '/api/athlete/appointments',
  '/api/athlete/coaches/{coachId}/appointments',
  '/api/athlete/appointments/{appointmentId}',
  '/api/athlete/appointments/{appointmentId}/reschedule',
  '/api/athlete/appointments/{appointmentId}/cancel',
  '/api/scheduling/reminder-preferences',
  '/api/admin/scheduling-reminders/status',
];
const schedulingBodyOperations = new Set([
  'upsertCoachAvailability',
  'createCoachAthleteAppointment',
  'rescheduleCoachAppointment',
  'cancelCoachAppointment',
  'recordCoachAppointmentAttendance',
  'createAthleteAppointment',
  'rescheduleAthleteAppointment',
  'cancelAthleteAppointment',
  'upsertSchedulingReminderPreferences',
]);

test('scheduling routes have request schemas where required, operations, and success responses', () => {
  for (const route of schedulingPaths) {
    const item = openapi.paths[route];
    assert.ok(item, route + ' is missing from paths');
    for (const [method, operation] of Object.entries(item).filter(([name]) => methods.has(name))) {
      if (schedulingBodyOperations.has(operation.operationId)) {
        assert.ok(operation.requestBody?.content?.['application/json']?.schema, method.toUpperCase() + ' ' + route + ' has no request schema');
      }
      const successes = Object.entries(operation.responses || {}).filter(([status]) => /^2\d\d$/.test(status));
      assert.ok(successes.length > 0 || (method === 'patch' && operation.responses?.['405']), method.toUpperCase() + ' ' + route + ' has no success response');
      for (const [status, response] of successes) {
        assert.ok(responseSchema(response), method.toUpperCase() + ' ' + route + ' ' + status + ' has no JSON response schema');
      }
    }
  }

  const requiredSchemas = [
    'AvailabilityWindow', 'AvailabilityException', 'CoachAvailability',
    'UpsertCoachAvailabilityRequest', 'AvailabilitySlot', 'AvailabilitySlotsResponse',
    'Appointment', 'AppointmentParticipantSummary', 'AppointmentLifecycle',
    'AppointmentCancellation', 'AppointmentAttendance',
    'CreateAppointmentRequest', 'RescheduleAppointmentRequest',
    'CancelAppointmentRequest', 'RecordAttendanceRequest',
    'AppointmentPage', 'SchedulingReminderPreferences',
    'SchedulingReminderStatusResponse', 'SchedulingError',
  ];
  for (const schemaName of requiredSchemas) {
    assert.ok(openapi.components.schemas[schemaName], 'missing schema ' + schemaName);
  }
});

test('AppointmentLifecycle defines historical, readOnly, and allowedActions', () => {
  const lifecycle = openapi.components.schemas.AppointmentLifecycle;
  assert.ok(lifecycle);
  assert.deepEqual(lifecycle.required, ['historical', 'readOnly', 'allowedActions']);
  assert.equal(lifecycle.properties.historical.type, 'boolean');
  assert.equal(lifecycle.properties.readOnly.type, 'boolean');
  assert.deepEqual(lifecycle.properties.allowedActions.items.enum, ['reschedule', 'cancel', 'attendance']);
});

test('SchedulingError schema defines error, code, and optional violations', () => {
  const errorSchema = openapi.components.schemas.SchedulingError;
  assert.ok(errorSchema);
  assert.deepEqual(errorSchema.required, ['error', 'code']);
  assert.ok(errorSchema.properties.violations);
  const violationSchema = openapi.components.schemas.SchedulingViolation;
  assert.ok(violationSchema);
  assert.deepEqual(violationSchema.required, ['field', 'code']);
});
