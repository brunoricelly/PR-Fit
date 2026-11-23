import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const URL = process.env.DATABASE_URL;
const skip = URL ? false : 'DATABASE_URL not set';
const API = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Starts the real server.js against the same database + schema (same DATA_DIR => same schema).
function start(dataDir, port, extra = {}) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API,
    env: { ...process.env, STORE: 'postgres', DATABASE_URL: URL, PG_SCHEMA_FROM_DATA_DIR: '1', DATA_DIR: dataDir, PORT: String(port),
      ORIGIN: `http://localhost:${port}`, RP_ID: 'localhost', RP_NAME: 'test', PASSWORD_LOGIN: '1', ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = { out: '' };
  child.stdout.on('data', d => { log.out += d; });
  child.stderr.on('data', d => { log.out += d; });
  const exited = new Promise(resolve => child.on('exit', code => resolve(code)));
  return { child, log, exited };
}
async function healthy(port, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if ((await fetch(`http://localhost:${port}/api/health`)).ok) return true; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

test('a second API process on the same database refuses to start while the first is alive', { skip }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-lock-'));
  const first = start(dataDir, 39211);
  let second;
  try {
    assert.equal(await healthy(39211), true, 'first process must come up: ' + first.log.out);
    second = start(dataDir, 39212, { STORE_WRITER_LOCK_WAIT_MS: '1500' });
    const code = await Promise.race([second.exited, new Promise(r => setTimeout(() => r('still-running'), 12000))]);
    assert.notEqual(code, 'still-running', 'second process must exit');
    assert.notEqual(code, 0);
    assert.match(second.log.out, /writer lock/);
    assert.equal((await fetch('http://localhost:39211/api/health')).ok, true, 'first process unaffected');
  } finally {
    first.child.kill();
    second?.child.kill();
    await first.exited;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('the lock is released when the first process stops (rolling restart works)', { skip }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-lock-'));
  const first = start(dataDir, 39213);
  let second;
  try {
    assert.equal(await healthy(39213), true, first.log.out);
    second = start(dataDir, 39214, { STORE_WRITER_LOCK_WAIT_MS: '20000' });
    await new Promise(r => setTimeout(r, 1000));
    first.child.kill('SIGTERM');
    await first.exited;
    assert.equal(await healthy(39214, 20000), true, 'second takes over after the first exits: ' + second.log.out);
  } finally {
    first.child.kill();
    second?.child.kill();
    await second?.exited;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('STORE_SINGLE_WRITER_LOCK=0 disables the guard', { skip }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-lock-'));
  const first = start(dataDir, 39215);
  let second;
  try {
    assert.equal(await healthy(39215), true, first.log.out);
    second = start(dataDir, 39216, { STORE_SINGLE_WRITER_LOCK: '0' });
    assert.equal(await healthy(39216), true, second.log.out);
  } finally {
    first.child.kill();
    second?.child.kill();
    await first.exited;
    await second?.exited;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
