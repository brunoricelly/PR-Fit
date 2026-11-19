import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers.mjs';
import { readDb, readDbText, readDbSize, readState } from './helpers/read-db.js';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'http://localhost:8080';
const SECRET = crypto.randomBytes(32).toString('hex');
const USERS = {
  athlete2: { id: 'u_athlete_2', name: 'Athlete 2' },
  athlete3: { id: 'u_athlete_3', name: 'Athlete 3' },
  coachA: { id: 'u_coach_a', name: 'Coach A', profile: { kind: 'coach', coachSpecialties: ['training'] } },
  coachB: { id: 'u_coach_b', name: 'Coach B', profile: { kind: 'coach', coachSpecialties: ['training'] } },
  athlete: { id: 'u_athlete', name: 'Athlete' },
};

function mintSession(uid) {
  const payload = `${uid}:${Date.now() + 86400000}:0:c`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}

function makeDataDir(t, db = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-b2b2c-limits-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
    schemaVersion: 3, users: Object.values(USERS), creds: [], subs: [], invites: [],
    coachInvites: [], coachAthleteLinks: [], coachPrescriptions: [], ...db,
  }, null, 2));
  return dataDir;
}

async function launch(dataDir, env = {}) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN, RP_ID: 'localhost', AUDIT_LOG: '1', ...env },
  });
  let log = '';
  child.stdout.on('data', chunk => log += chunk);
  child.stderr.on('data', chunk => log += chunk);
  const port = await boundPort(child, () => log);
  return { child, log: () => log, api: `http://127.0.0.1:${port}` };
}

async function stop(server) {
  if (server.child.exitCode !== null) return;
  server.child.kill('SIGTERM');
  await new Promise(resolve => server.child.once('exit', resolve));
}

async function request(server, uid, method, route, body, ip = '198.51.100.10') {
  const response = await fetch(server.api + route, {
    method,
    headers: {
      Cookie: `gymsid=${mintSession(uid)}`, Origin: ORIGIN, 'Content-Type': 'application/json',
      'X-Forwarded-For': ip,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json(), retryAfter: response.headers.get('retry-after') };
}

const createInvite = (server, uid, ip) => request(server, uid, 'POST', '/api/coach/invites', { scopes: ['training'], expiresInDays: 7 }, ip);
const acceptInvite = (server, uid, token, ip) => request(server, uid, 'POST', '/api/coach/invites/accept', { token }, ip);

const roomy = {
  TRUST_PROXY: '1', B2B2C_PENDING_INVITES_PER_COACH: '50',
  B2B2C_INVITE_CREATE_ACCOUNT_MAX: '1000', B2B2C_INVITE_CREATE_IP_MAX: '1000',
  B2B2C_INVITE_ACCEPT_ACCOUNT_MAX: '1000', B2B2C_INVITE_ACCEPT_IP_MAX: '1000',
};

test('B2B2C_MAX_LINKS_PER_COACH caps one professional, not the others, and ending a link frees the slot', async t => {
  const dataDir = makeDataDir(t);
  const server = await launch(dataDir, { ...roomy, B2B2C_MAX_LINKS_PER_COACH: '2' });
  t.after(() => stop(server));

  const a1 = await createInvite(server, USERS.coachA.id, '198.51.100.1');
  const a2 = await createInvite(server, USERS.coachA.id, '198.51.100.1');
  assert.deepEqual([a1.status, a2.status], [201, 201]);
  const blocked = await createInvite(server, USERS.coachA.id, '198.51.100.1');
  assert.deepEqual([blocked.status, blocked.body.code], [409, 'coach_link_limit']);

  const b1 = await createInvite(server, USERS.coachB.id, '198.51.100.2');
  assert.equal(b1.status, 201, JSON.stringify(b1.body));

  const accepted = await acceptInvite(server, USERS.athlete.id, a1.body.invite.token, '203.0.113.1');
  assert.deepEqual([accepted.status, accepted.body.link?.status], [200, 'active']);
  const stillBlocked = await createInvite(server, USERS.coachA.id, '198.51.100.1');
  assert.deepEqual([stillBlocked.status, stillBlocked.body.code], [409, 'coach_link_limit']);

  const ended = await request(server, USERS.athlete.id, 'POST', '/api/coach/links/status', { linkId: accepted.body.link.id, status: 'ended' }, '192.0.2.1');
  assert.equal(ended.status, 200, JSON.stringify(ended.body));
  const freed = await createInvite(server, USERS.coachA.id, '198.51.100.1');
  assert.equal(freed.status, 201, JSON.stringify(freed.body));
});

test('the global B2B2C_MAX_LINKS stays the ceiling above the per-professional limit', async t => {
  const dataDir = makeDataDir(t);
  const server = await launch(dataDir, { ...roomy, B2B2C_MAX_LINKS_PER_COACH: '5', B2B2C_MAX_LINKS: '2', B2B2C_MAX_INVITES: '10' });
  t.after(() => stop(server));
  assert.equal((await createInvite(server, USERS.coachA.id, '198.51.100.1')).status, 201);
  assert.equal((await createInvite(server, USERS.coachB.id, '198.51.100.2')).status, 201);
  const blocked = await createInvite(server, USERS.coachA.id, '198.51.100.1');
  assert.deepEqual([blocked.status, blocked.body.code], [409, 'relationship_capacity']);
});

test('the per-professional limit is 200 by default and acceptance enforces a lowered limit', async t => {
  const token = crypto.randomBytes(32).toString('base64url');
  const hash = crypto.createHash('sha256').update(token).digest('base64url');
  const at = '2026-01-01T00:00:00.000Z';
  const link = (id, athleteId, status) => ({ id, coachId: USERS.coachA.id, athleteId, scopes: ['training'], status, createdAt: at, updatedAt: at, ...(status === 'active' ? { acceptedAt: at } : {}) });
  const dataDir = makeDataDir(t, {
    coachAthleteLinks: [link('cal_1', USERS.athlete2.id, 'active'), link('cal_2', USERS.athlete3.id, 'active'), link('cal_3', null, 'pending')],
    coachInvites: [{ id: 'cai_3', linkId: 'cal_3', coachId: USERS.coachA.id, tokenHash: hash, createdAt: at, expiresAt: '2099-01-01T00:00:00.000Z', acceptedAt: null, acceptedBy: null }],
  });
  let server = await launch(dataDir, { ...roomy, B2B2C_MAX_LINKS_PER_COACH: '2' });
  t.after(() => stop(server));
  const refused = await acceptInvite(server, USERS.athlete.id, token, '203.0.113.5');
  assert.deepEqual([refused.status, refused.body.code], [409, 'coach_link_limit']);
  await stop(server);

  // default (200): the same acceptance goes through
  server = await launch(dataDir, roomy);
  const ok = await acceptInvite(server, USERS.athlete.id, token, '203.0.113.6');
  assert.deepEqual([ok.status, ok.body.link?.status], [200, 'active']);
});
