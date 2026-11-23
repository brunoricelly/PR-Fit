import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A write that PostgreSQL rejects must (1) answer 500, never a success that did not stick,
// (2) leave memory equal to what the database really holds, and (3) not poison later writes.
const URL = process.env.DATABASE_URL;
const skip = URL ? false : 'DATABASE_URL not set';
const API = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 39231, B = `http://localhost:${PORT}`;
const PW = 'Tst-Pass-93847!xq';

test('failed commit answers 500, memory resyncs to PG, next write succeeds', { skip }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'write-fail-'));
  const failFile = path.join(dataDir, 'fail-db-write');
  const child = spawn(process.execPath, ['server.js'], { cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, STORE: 'postgres', DATABASE_URL: URL, PG_SCHEMA_FROM_DATA_DIR: '1', DATA_DIR: dataDir, PORT: String(PORT),
      ORIGIN: B, RP_ID: 'localhost', RP_NAME: 'test', PASSWORD_LOGIN: '1', FIRST_USER_ADMIN: '1', B2B2C_PG_ASYNC_FAIL_FILE: failFile } });
  let log = ''; child.stdout.on('data', d => { log += d; }); child.stderr.on('data', d => { log += d; });
  const exited = new Promise(r => child.on('exit', r));
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(B + '/api/health')).ok) break; } catch { /* booting */ } await new Promise(r => setTimeout(r, 200)); }
    const post = (p, body, cookie) => fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: B, ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
    const ok = await post('/api/register/password', { name: 'Coach1', password: PW, email: null });
    assert.equal(ok.status, 200, log);
    const cookie = ok.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
    const profile = { kind: 'coach', coachSpecialties: ['training'] };
    assert.equal((await post('/api/profile', profile, cookie)).status, 200);

    fs.writeFileSync(failFile, 'once');
    const failed = await post('/api/profile', { kind: 'coach', coachSpecialties: ['training', 'nutrition'] }, cookie);
    assert.equal(failed.status, 500, 'a write PG refused must not answer success');

    const me = await (await fetch(B + '/api/me', { headers: { Cookie: cookie } })).json();
    assert.deepEqual(me.user.profile.coachSpecialties, ['training'], 'memory must not keep the change PG never stored');

    const retry = await post('/api/profile', { kind: 'coach', coachSpecialties: ['training', 'nutrition'] }, cookie);
    assert.equal(retry.status, 200, 'the queue is not poisoned by the earlier failure');
    const me2 = await (await fetch(B + '/api/me', { headers: { Cookie: cookie } })).json();
    assert.deepEqual(me2.user.profile.coachSpecialties, ['training', 'nutrition']);
  } finally {
    child.kill(); await exited; fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
