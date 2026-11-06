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

function session(uid) {
  const payload = `${uid}:${Date.now() + 86400000}:0:c`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}

async function waitFor(file) {
  const deadline = Date.now() + 30000;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${file}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('state write admission bounds per-profile and global backlog before parsing bodies', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-state-admission-'));
  const barriers = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-state-admission-barriers-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  t.after(() => fs.rmSync(barriers, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  const users = ['u_admit_1', 'u_admit_2', 'u_admit_3'];
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
    users: users.map(id => ({ id, name: id })), creds: [], subs: [], invites: [],
  }));
  for (const id of users) {
    fs.writeFileSync(path.join(dataDir, `state-${id}.json`), JSON.stringify({ _rev: 1, _wid: `wid-${id}`, routines: [], workouts: [] }));
  }
  for (const id of users.slice(0, 2)) fs.writeFileSync(path.join(barriers, `put-after-read-${id}.wait`), '');

  const child = spawn(process.execPath, ['server.js'], {
    cwd: API,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: '0', DATA_DIR: dataDir, ORIGIN, RP_ID: 'localhost', STATE_WRITE_TEST_DIR: barriers,
      STATE_WRITE_PER_USER_MAX: '1', STATE_WRITE_GLOBAL_MAX: '2',
    },
  });
  let log = '';
  child.stdout.on('data', chunk => log += chunk);
  child.stderr.on('data', chunk => log += chunk);
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise(resolve => child.once('exit', resolve));
    }
  });
  const port = await boundPort(child, () => log);
  const api = `http://127.0.0.1:${port}`;
  const headers = id => ({ Cookie: `gymsid=${session(id)}`, Origin: ORIGIN, 'Content-Type': 'application/json' });
  const valid = id => fetch(api + '/api/data', {
    method: 'PUT', headers: headers(id),
    body: JSON.stringify({ state: { routines: [], workouts: [{ id: `workout-${id}` }] }, baseRev: 1, baseWid: `wid-${id}`, stamped: true }),
  });

  const first = valid(users[0]);
  const second = valid(users[1]);
  await Promise.all(users.slice(0, 2).map(id => waitFor(path.join(barriers, `put-after-read-${id}.reached`))));

  const perKey = await fetch(api + '/api/data', { method: 'PUT', headers: headers(users[0]), body: '{' });
  assert.equal(perKey.status, 429);
  assert.equal((await perKey.json()).code, 'state-write-busy');
  const global = await fetch(api + '/api/data', { method: 'PUT', headers: headers(users[2]), body: '{' });
  assert.equal(global.status, 503);
  assert.equal((await global.json()).code, 'busy');

  for (const id of users.slice(0, 2)) fs.writeFileSync(path.join(barriers, `put-after-read-${id}.release`), '');
  assert.deepEqual(await Promise.all([first, second].map(async response => (await response).status)), [200, 200]);

  const afterRelease = await valid(users[2]);
  assert.equal(afterRelease.status, 200);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, `state-${users[2]}.json`), 'utf8')).workouts[0].id, `workout-${users[2]}`);
});
