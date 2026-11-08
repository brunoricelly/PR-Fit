import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('dispatcher lock, retry, retention, capacity and admin read limits are documented and shipped', () => {
  const env = fs.readFileSync(new URL('../../.env.example', import.meta.url), 'utf8');
  for (const name of [
    'B2B2C_SCHEDULING_REMINDER_TICK_MS', 'B2B2C_SCHEDULING_REMINDER_LEASE_MS',
    'B2B2C_SCHEDULING_REMINDER_LOCK_LEASE_MS', 'B2B2C_SCHEDULING_REMINDER_LOCK_TIMEOUT_MS',
    'B2B2C_SCHEDULING_REMINDER_LOCK_RETRY_MS', 'B2B2C_SCHEDULING_REMINDER_RETRY_BASE_MS',
    'B2B2C_SCHEDULING_REMINDER_RETRY_MAX_MS', 'B2B2C_SCHEDULING_REMINDER_MAX_ATTEMPTS',
    'B2B2C_SCHEDULING_REMINDER_BATCH_SIZE', 'B2B2C_SCHEDULING_REMINDER_RETENTION_DAYS',
    'B2B2C_MAX_APPOINTMENT_REMINDER_STATES', 'B2B2C_MAX_SCHEDULING_REMINDER_OUTBOX',
    'B2B2C_SCHEDULING_REMINDER_STATUS_ACCOUNT_MAX', 'B2B2C_SCHEDULING_REMINDER_STATUS_IP_MAX',
  ]) assert.match(env, new RegExp(`^#?\\s*${name}=`, 'm'), name);

  const dockerfile = fs.readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
  assert.match(dockerfile, /db-coordinator\.js/);
});
