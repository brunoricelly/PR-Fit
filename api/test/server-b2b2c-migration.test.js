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

for (const [name, db] of [
  ['future schema', { schemaVersion: 999, users: [], creds: [], subs: [], invites: [], coachInvites: [], coachAthleteLinks: [] }],
  ['corrupt B2B2C collection', { schemaVersion: 3, users: [], creds: [], subs: [], invites: [], coachInvites: {}, coachAthleteLinks: [], coachPrescriptions: [] }],
  ['corrupt prescription collection', { schemaVersion: 3, users: [], creds: [], subs: [], invites: [], coachInvites: [], coachAthleteLinks: [], coachPrescriptions: {} }],
  ['corrupt assessment collection', { schemaVersion: 4, users: [], creds: [], subs: [], invites: [], coachInvites: [], coachAthleteLinks: [], coachPrescriptions: [], coachAssessments: {} }],
  ['corrupt assessment record', { schemaVersion: 4, users: [], creds: [], subs: [], invites: [], coachInvites: [], coachAthleteLinks: [], coachPrescriptions: [], coachAssessments: [{ id: 'bad' }] }],
  ['corrupt assessment payload', { schemaVersion: 4, users: [], creds: [], subs: [], invites: [], coachInvites: [], coachAthleteLinks: [], coachPrescriptions: [], coachAssessments: [{ id: 'cas_bad', coachId: 'u_c', athleteId: 'u_a', assessedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', parq: { version: '2024.1', answers: [] } }] }],
  ['corrupt baseline collection', { schemaVersion: 3, users: null, creds: [], subs: [], invites: [], coachInvites: [], coachAthleteLinks: [], coachPrescriptions: [] }],
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
  assert.equal(stored.schemaVersion, 4);
  assert.deepEqual(stored.coachInvites, []);
  assert.deepEqual(stored.coachAthleteLinks, []);
  assert.deepEqual(stored.coachPrescriptions, []);
  assert.deepEqual(stored.coachAssessments, []);
});

test('known schema versions migrate to version 4', async t => {
  const sample = fixture(t, { schemaVersion: 1, users: [], creds: [], subs: [], invites: [] });
  const server = start(sample.dataDir);
  await boundPort(server.child, server.log);
  await stop(server.child);
  const stored = JSON.parse(fs.readFileSync(path.join(sample.dataDir, 'db.json'), 'utf8'));
  assert.equal(stored.schemaVersion, 4);
  assert.deepEqual(stored.coachInvites, []);
  assert.deepEqual(stored.coachAthleteLinks, []);
  assert.deepEqual(stored.coachPrescriptions, []);
  assert.deepEqual(stored.coachAssessments, []);
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
