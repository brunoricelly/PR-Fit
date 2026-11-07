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
const USERS = {
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
const acceptInvite = (server, token, ip) => request(server, USERS.athlete.id, 'POST', '/api/coach/invites/accept', { token }, ip);

const tightStorage = {
  TRUST_PROXY: '1', B2B2C_PENDING_INVITES_PER_COACH: '2',
  B2B2C_MAX_INVITES: '6', B2B2C_MAX_LINKS: '6',
  B2B2C_TERMINAL_INVITES_KEEP: '2', B2B2C_TERMINAL_LINKS_KEEP: '2',
  B2B2C_TERMINAL_RETENTION_DAYS: '365',
  B2B2C_INVITE_CREATE_ACCOUNT_MAX: '100', B2B2C_INVITE_CREATE_IP_MAX: '100',
  B2B2C_INVITE_ACCEPT_ACCOUNT_MAX: '100', B2B2C_INVITE_ACCEPT_IP_MAX: '100',
};

test('pending limits are isolated per coach and legitimate acceptance still works', async t => {
  const dataDir = makeDataDir(t);
  const server = await launch(dataDir, tightStorage);
  t.after(() => stop(server));

  const a1 = await createInvite(server, USERS.coachA.id, '198.51.100.1');
  const a2 = await createInvite(server, USERS.coachA.id, '198.51.100.1');
  assert.equal(a1.status, 201);
  assert.equal(a2.status, 201);
  const blocked = await createInvite(server, USERS.coachA.id, '198.51.100.1');
  assert.deepEqual([blocked.status, blocked.body.code], [409, 'pending_invite_limit']);

  const b1 = await createInvite(server, USERS.coachB.id, '198.51.100.2');
  assert.equal(b1.status, 201, JSON.stringify(b1.body));
  const accepted = await acceptInvite(server, b1.body.invite.token, '203.0.113.1');
  assert.deepEqual([accepted.status, accepted.body.link?.status], [200, 'active']);
});

test('creation and acceptance are rate limited independently by account and address', async t => {
  const dataDir = makeDataDir(t);
  let server = await launch(dataDir, {
    ...tightStorage,
    B2B2C_PENDING_INVITES_PER_COACH: '10',
    B2B2C_INVITE_CREATE_ACCOUNT_MAX: '2', B2B2C_INVITE_CREATE_IP_MAX: '50',
  });
  t.after(() => stop(server));

  assert.equal((await createInvite(server, USERS.coachA.id, '198.51.100.1')).status, 201);
  assert.equal((await createInvite(server, USERS.coachA.id, '198.51.100.2')).status, 201);
  const accountLimited = await createInvite(server, USERS.coachA.id, '198.51.100.3');
  assert.deepEqual([accountLimited.status, accountLimited.body.code], [429, 'rate_limited']);
  assert.ok(+accountLimited.retryAfter >= 1);
  assert.equal((await createInvite(server, USERS.coachB.id, '198.51.100.4')).status, 201);

  await stop(server);
  server = await launch(dataDir, {
    ...tightStorage,
    B2B2C_PENDING_INVITES_PER_COACH: '10',
    B2B2C_INVITE_CREATE_ACCOUNT_MAX: '50', B2B2C_INVITE_CREATE_IP_MAX: '2',
  });
  assert.equal((await createInvite(server, USERS.coachA.id, '203.0.113.9')).status, 201);
  assert.equal((await createInvite(server, USERS.coachB.id, '203.0.113.9')).status, 201);
  const ipLimited = await createInvite(server, USERS.coachB.id, '203.0.113.9');
  assert.deepEqual([ipLimited.status, ipLimited.body.code], [429, 'rate_limited']);

  await stop(server);
  server = await launch(dataDir, {
    ...tightStorage,
    B2B2C_INVITE_ACCEPT_ACCOUNT_MAX: '2', B2B2C_INVITE_ACCEPT_IP_MAX: '50',
  });
  const invalid = crypto.randomBytes(32).toString('base64url');
  assert.equal((await acceptInvite(server, invalid, '192.0.2.1')).status, 410);
  assert.equal((await acceptInvite(server, invalid, '192.0.2.2')).status, 410);
  const acceptLimited = await acceptInvite(server, invalid, '192.0.2.3');
  assert.deepEqual([acceptLimited.status, acceptLimited.body.code], [429, 'rate_limited']);

  await stop(server);
  server = await launch(dataDir, {
    ...tightStorage,
    B2B2C_INVITE_ACCEPT_ACCOUNT_MAX: '50', B2B2C_INVITE_ACCEPT_IP_MAX: '2',
  });
  assert.equal((await acceptInvite(server, invalid, '192.0.2.20')).status, 410);
  assert.equal((await acceptInvite(server, invalid, '192.0.2.20')).status, 410);
  const acceptIpLimited = await acceptInvite(server, invalid, '192.0.2.20');
  assert.deepEqual([acceptIpLimited.status, acceptIpLimited.body.code], [429, 'rate_limited']);
});

test('terminal invitations and links compact to fixed bounds and stay compact after restart', async t => {
  const dataDir = makeDataDir(t);
  let server = await launch(dataDir, { ...tightStorage, B2B2C_PENDING_INVITES_PER_COACH: '1' });
  t.after(() => stop(server));
  const sizes = [];

  for (let index = 0; index < 8; index++) {
    const created = await createInvite(server, USERS.coachA.id, `198.51.100.${index + 1}`);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const accepted = await acceptInvite(server, created.body.invite.token, `203.0.113.${index + 1}`);
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    const ended = await request(server, USERS.athlete.id, 'POST', '/api/coach/links/status', {
      linkId: accepted.body.link.id, status: 'ended',
    }, `192.0.2.${index + 1}`);
    assert.equal(ended.status, 200, JSON.stringify(ended.body));
    const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
    assert.ok(stored.coachInvites.length <= 2);
    assert.ok(stored.coachAthleteLinks.length <= 2);
    sizes.push(fs.statSync(path.join(dataDir, 'db.json')).size);
  }
  assert.ok(Math.max(...sizes.slice(3)) - Math.min(...sizes.slice(3)) < 256, sizes.join(','));

  const before = fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8');
  await stop(server);
  server = await launch(dataDir, tightStorage);
  const after = fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8');
  assert.equal(after, before);
  const compact = JSON.parse(after);
  assert.ok(compact.coachInvites.length <= 2);
  assert.ok(compact.coachAthleteLinks.length <= 2);
});

test('dependent terminal links consume the hard limit and block further invites across restarts', async t => {
  const dataDir = makeDataDir(t);
  const retainedStorage = {
    ...tightStorage,
    B2B2C_PENDING_INVITES_PER_COACH: '1',
    B2B2C_MAX_LINKS: '3',
    B2B2C_TERMINAL_LINKS_KEEP: '0',
    B2B2C_TERMINAL_RETENTION_DAYS: '0',
  };
  let server = await launch(dataDir, retainedStorage);
  t.after(() => stop(server));

  for (let index = 0; index < 3; index++) {
    const created = await createInvite(server, USERS.coachA.id, `198.51.100.${index + 30}`);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const accepted = await acceptInvite(server, created.body.invite.token, `203.0.113.${index + 30}`);
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    const message = await request(server, USERS.coachA.id, 'POST', `/api/coach/athletes/${USERS.athlete.id}/messages`, {
      content: `retained ${index}`, category: 'general', refId: null,
    }, `192.0.2.${index + 30}`);
    assert.equal(message.status, 201, JSON.stringify(message.body));
    const ended = await request(server, USERS.athlete.id, 'POST', '/api/coach/links/status', {
      linkId: accepted.body.link.id, status: 'ended',
    }, `192.0.2.${index + 40}`);
    assert.equal(ended.status, 200, JSON.stringify(ended.body));
  }

  const blocked = await createInvite(server, USERS.coachA.id, '198.51.100.99');
  assert.deepEqual([blocked.status, blocked.body.code], [409, 'relationship_capacity']);
  await stop(server);
  const beforeRestartRaw = fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8');
  const beforeRestart = JSON.parse(beforeRestartRaw);
  assert.deepEqual([beforeRestart.coachAthleteLinks.length, beforeRestart.coachMessages.length], [3, 3]);
  assert.ok(beforeRestart.coachAthleteLinks.every(link => link.tombstone === true));
  const retainedIds = beforeRestart.coachAthleteLinks.map(link => link.id).sort();

  server = await launch(dataDir, retainedStorage);
  const afterRestartRaw = fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8');
  const afterRestart = JSON.parse(afterRestartRaw);
  assert.equal(afterRestartRaw, beforeRestartRaw);
  assert.deepEqual(afterRestart.coachAthleteLinks.map(link => link.id).sort(), retainedIds);
  assert.deepEqual(afterRestart.coachMessages.map(message => message.linkId).sort(), retainedIds);
  assert.equal(afterRestart.coachAthleteLinks.length, 3);
  const blockedAgain = await createInvite(server, USERS.coachA.id, '198.51.100.100');
  assert.deepEqual([blockedAgain.status, blockedAgain.body.code], [409, 'relationship_capacity']);
});

test('B2B2C_MAX_LINKS is clamped to the one-link operational minimum', async t => {
  const dataDir = makeDataDir(t);
  const server = await launch(dataDir, { ...tightStorage, B2B2C_MAX_LINKS: '0', B2B2C_PENDING_INVITES_PER_COACH: '2' });
  t.after(() => stop(server));
  assert.equal((await createInvite(server, USERS.coachA.id, '198.51.100.110')).status, 201);
  const blocked = await createInvite(server, USERS.coachA.id, '198.51.100.111');
  assert.deepEqual([blocked.status, blocked.body.code], [409, 'relationship_capacity']);
});

test('boot compacts an inflated legacy set of live pending invitations to global bounds', async t => {
  const expired = [];
  const links = [];
  for (let index = 0; index < 30; index++) {
    const linkId = `cal_old_${String(index).padStart(2, '0')}`;
    links.push({
      id: linkId, coachId: USERS.coachA.id, athleteId: null, scopes: ['training'], status: 'pending',
      createdAt: `2025-01-${String((index % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
      updatedAt: '2025-01-01T00:00:00.000Z',
    });
    expired.push({
      id: `cai_old_${index}`, linkId, coachId: USERS.coachA.id,
      tokenHash: crypto.randomBytes(32).toString('base64url'),
      createdAt: '2025-01-01T00:00:00.000Z', expiresAt: '2099-02-01T00:00:00.000Z',
      acceptedAt: null, acceptedBy: null,
    });
  }
  const dataDir = makeDataDir(t, { coachInvites: expired, coachAthleteLinks: links });
  const server = await launch(dataDir, tightStorage);
  t.after(() => stop(server));
  const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
  assert.equal(stored.coachInvites.length, 6);
  assert.equal(stored.coachAthleteLinks.length, 6);
  assert.deepEqual(stored.coachAthleteLinks.map(link => link.id), links.slice(-6).map(link => link.id));
});
