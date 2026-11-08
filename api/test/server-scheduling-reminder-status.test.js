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
const mint = uid => {
  const payload = `${uid}:${Date.now() + 86400000}:0:c`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
};

async function start(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-reminder-admin-'));
  const now = new Date().toISOString();
  const db = {
    schemaVersion: 8,
    users: [
      { id: 'admin_1', name: 'Admin Secret', admin: true, profile: { kind: 'athlete' } },
      { id: 'coach_1', name: 'Coach Secret', profile: { kind: 'coach', coachSpecialties: ['training'] } },
      { id: 'athlete_1', name: 'Athlete Secret', profile: { kind: 'athlete' } },
    ],
    creds: [], subs: [], invites: [], deviceLinks: [], watchLinks: [], coachInvites: [], coachPrescriptions: [], coachAssessments: [],
    mealPlans: [], mealAdherence: [], coachMessages: [], coachHabits: [], habitCheckins: [], progressGoals: [], progressReports: [], accountCleanupJobs: [],
    coachAthleteLinks: [{ id: 'link_secret', coachId: 'coach_1', athleteId: 'athlete_1', scopes: ['training'], status: 'active', createdAt: now, updatedAt: now }],
    coachAvailability: [], coachAppointments: [], schedulingReminderPreferences: [], appointmentReminderStates: [], schedulingReminderOutbox: [],
  };
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify(db, null, 2));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN, RP_ID: 'localhost', B2B2C_SCHEDULING_REMINDER_TICK_MS: '60000' },
  });
  let log = '';
  child.stdout.on('data', chunk => log += chunk);
  child.stderr.on('data', chunk => log += chunk);
  const port = await boundPort(child, () => log);
  t.after(async () => {
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { api: `http://127.0.0.1:${port}`, log: () => log };
}

async function status(server, uid) {
  return fetch(`${server.api}/api/admin/scheduling-reminders/status`, {
    headers: { Cookie: `gymsid=${mint(uid)}`, Origin: ORIGIN },
  });
}

test('admin reminder status is aggregated, rate-limited, authorized, and contains no scheduling PII', async t => {
  const server = await start(t);
  const admin = await status(server, 'admin_1');
  assert.equal(admin.status, 200);
  const body = await admin.json();
  assert.equal(typeof body.dispatcher.running, 'boolean');
  assert.equal(typeof body.backlog.delivery_uncertain, 'number');
  assert.equal(typeof body.leases.active, 'number');
  assert.equal(typeof body.config.lockLeaseMs, 'number');
  const serialized = JSON.stringify(body);
  for (const forbidden of ['userId', 'appointmentId', 'endpoint', 'payload', 'notes', 'location', 'meetingUrl', 'Secret', 'link_secret']) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  assert.equal((await status(server, 'coach_1')).status, 403);
  assert.equal((await status(server, 'athlete_1')).status, 403);
});
