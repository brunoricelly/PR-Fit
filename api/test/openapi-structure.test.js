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
