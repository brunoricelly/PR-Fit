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
  ['corrupt B2B2C collection', { schemaVersion: 2, users: [], creds: [], subs: [], invites: [], coachInvites: {}, coachAthleteLinks: [] }],
  ['corrupt baseline collection', { schemaVersion: 2, users: null, creds: [], subs: [], invites: [], coachInvites: [], coachAthleteLinks: [] }],
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
  assert.equal(stored.schemaVersion, 2);
  assert.deepEqual(stored.coachInvites, []);
  assert.deepEqual(stored.coachAthleteLinks, []);
});

test('known schema version 1 migrates to version 2', async t => {
  const sample = fixture(t, { schemaVersion: 1, users: [], creds: [], subs: [], invites: [] });
  const server = start(sample.dataDir);
  await boundPort(server.child, server.log);
  await stop(server.child);
  const stored = JSON.parse(fs.readFileSync(path.join(sample.dataDir, 'db.json'), 'utf8'));
  assert.equal(stored.schemaVersion, 2);
  assert.deepEqual(stored.coachInvites, []);
  assert.deepEqual(stored.coachAthleteLinks, []);
});
