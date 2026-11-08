import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterprocessLock, FileLockTimeoutError } from '../db-coordinator.js';

test('an active lock is not stolen, an expired lock is recovered, and a foreign token cannot unlock it', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-db-lock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lockPath = path.join(dir, 'db.lock');
  let clock = 1000;
  const first = createInterprocessLock({ lockPath, leaseMs: 100, acquireTimeoutMs: 20, retryMs: 2, now: () => clock, token: () => 'owner_a' });
  const second = createInterprocessLock({ lockPath, leaseMs: 100, acquireTimeoutMs: 20, retryMs: 2, now: () => clock, token: () => 'owner_b' });
  const held = await first.acquire();
  await assert.rejects(second.acquire(), FileLockTimeoutError);

  fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({ token: 'foreign', acquiredAt: clock, expiresAt: clock + 100 }));
  assert.equal(await held.release(), false);
  assert.equal(fs.existsSync(lockPath), true);

  clock += 1000;
  const recovered = await second.acquire();
  assert.equal((await second.inspect()).active, true);
  assert.equal(await recovered.release(), true);
  assert.equal(fs.existsSync(lockPath), false);
});
