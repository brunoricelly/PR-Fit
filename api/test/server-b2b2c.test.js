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
const IDS = { legacy: 'u_legacy', coachA: 'u_coach_a', coachB: 'u_coach_b', athleteA: 'u_athlete_a', athleteB: 'u_athlete_b' };
const expiredToken = crypto.randomBytes(32).toString('base64url');
const tokenHash = token => crypto.createHash('sha256').update(token).digest('base64url');

function mintSession(uid) {
  const payload = `${uid}:${Date.now() + 86400000}:0:c`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}

function seed(dataDir) {
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
    users: [
      { id: IDS.legacy, name: 'Legacy', created: '2026-01-01T00:00:00.000Z' },
      { id: IDS.coachA, name: 'Coach A', created: '2026-01-02T00:00:00.000Z' },
      { id: IDS.coachB, name: 'Coach B', created: '2026-01-03T00:00:00.000Z' },
      { id: IDS.athleteA, name: 'Athlete A', created: '2026-01-04T00:00:00.000Z' },
      { id: IDS.athleteB, name: 'Athlete B', created: '2026-01-05T00:00:00.000Z' },
    ],
    creds: [{ id: 'cred-secret', userId: IDS.coachA, publicKey: 'do-not-leak', counter: 0 }],
    subs: [], invites: [],
    coachInvites: [{
      id: 'cai_expired', linkId: 'cal_expired', coachId: IDS.coachA,
      tokenHash: tokenHash(expiredToken), createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-02T00:00:00.000Z', acceptedAt: null, acceptedBy: null,
    }],
    coachAthleteLinks: [{
      id: 'cal_expired', coachId: IDS.coachA, athleteId: null, scopes: ['training'], status: 'pending',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    }],
  }));
  fs.writeFileSync(path.join(dataDir, `state-${IDS.legacy}.json`), JSON.stringify({ workouts: [{ id: 'w_legacy' }], routines: [] }));
}

async function launch(dataDir) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN, RP_ID: 'localhost', AUDIT_LOG: '1' },
  });
  let log = '';
  child.stdout.on('data', d => log += d);
  child.stderr.on('data', d => log += d);
  const port = await boundPort(child, () => log);
  return { child, log: () => log, api: `http://127.0.0.1:${port}` };
}

async function stop(server) {
  if (server.child.exitCode !== null) return;
  server.child.kill('SIGTERM');
  await new Promise(resolve => server.child.once('exit', resolve));
}

const headers = uid => ({ Cookie: `gymsid=${mintSession(uid)}`, Origin: ORIGIN, 'Content-Type': 'application/json' });
async function request(server, uid, method, route, body) {
  const response = await fetch(server.api + route, {
    method,
    headers: headers(uid),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

test('B2B2C profile, invite, relationship isolation and persistence', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-b2b2c-'));
  seed(dataDir);
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let server = await launch(dataDir);
  t.after(async () => stop(server));

  let result = await request(server, IDS.legacy, 'GET', '/api/me');
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.user, { id: IDS.legacy, name: 'Legacy', admin: false });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, `state-${IDS.legacy}.json`), 'utf8')).workouts, [{ id: 'w_legacy' }]);
  let stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
  assert.equal(stored.schemaVersion, 2);
  assert.ok(Array.isArray(stored.coachInvites));
  assert.ok(Array.isArray(stored.coachAthleteLinks));

  result = await request(server, IDS.athleteA, 'POST', '/api/coach/invites', { scopes: ['training'] });
  assert.deepEqual([result.status, result.body.code], [403, 'role_forbidden']);

  result = await request(server, IDS.coachA, 'POST', '/api/profile', { kind: 'coach', coachSpecialties: ['training'], admin: true });
  assert.deepEqual([result.status, result.body.code], [400, 'invalid_profile']);
  result = await request(server, IDS.coachA, 'POST', '/api/profile', { kind: 'coach', coachSpecialties: ['training'] });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.user.profile, { kind: 'coach', coachSpecialties: ['training'] });
  assert.ok(result.body.user.capabilities.includes('relationships:invite'));
  assert.equal(result.body.user.admin, false);
  await request(server, IDS.coachB, 'POST', '/api/profile', { kind: 'coach', coachSpecialties: ['training'] });

  result = await request(server, IDS.coachA, 'POST', '/api/coach/invites', { scopes: ['nutrition'] });
  assert.deepEqual([result.status, result.body.code], [400, 'invalid_scope']);
  result = await request(server, IDS.coachA, 'POST', '/api/coach/invites', { scopes: ['training'], expiresInDays: 7 });
  assert.equal(result.status, 201);
  const inviteToken = result.body.invite.token;
  const linkId = result.body.invite.linkId;
  assert.match(inviteToken, /^[A-Za-z0-9_-]{40,}$/);

  stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
  const diskInvite = stored.coachInvites.find(invite => invite.id === result.body.invite.id);
  assert.ok(diskInvite.tokenHash);
  assert.equal(JSON.stringify(stored).includes(inviteToken), false);

  result = await request(server, IDS.athleteA, 'POST', '/api/coach/invites/accept', { token: 'invalid' });
  assert.deepEqual([result.status, result.body.code], [410, 'invite_invalid']);
  result = await request(server, IDS.athleteA, 'POST', '/api/coach/invites/accept', { token: expiredToken });
  assert.deepEqual([result.status, result.body.code], [410, 'invite_invalid']);

  result = await request(server, IDS.athleteA, 'POST', '/api/coach/invites/accept', { token: inviteToken });
  assert.equal(result.status, 200);
  assert.equal(result.body.link.id, linkId);
  assert.equal(result.body.link.status, 'active');
  assert.deepEqual(result.body.link.coach, { id: IDS.coachA, name: 'Coach A', profile: { kind: 'coach', coachSpecialties: ['training'] } });
  assert.equal(JSON.stringify(result.body).includes('tokenHash'), false);
  assert.equal(JSON.stringify(result.body).includes('publicKey'), false);

  result = await request(server, IDS.coachA, 'POST', '/api/profile', { kind: 'coach', coachSpecialties: ['training', 'nutrition'] });
  assert.equal(result.status, 200);
  result = await request(server, IDS.coachA, 'POST', '/api/profile', { kind: 'coach', coachSpecialties: ['nutrition'] });
  assert.deepEqual([result.status, result.body.code], [409, 'relationships_active']);

  const replay = await request(server, IDS.athleteA, 'POST', '/api/coach/invites/accept', { token: inviteToken });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.link.id, linkId);
  result = await request(server, IDS.athleteB, 'POST', '/api/coach/invites/accept', { token: inviteToken });
  assert.deepEqual([result.status, result.body.code], [409, 'invite_used']);

  const own = await request(server, IDS.coachA, 'GET', '/api/coach/athletes');
  assert.equal(own.status, 200);
  assert.ok(own.body.links.some(link => link.id === linkId && link.athlete.id === IDS.athleteA));
  assert.equal(JSON.stringify(own.body).includes('tokenHash'), false);
  const other = await request(server, IDS.coachB, 'GET', '/api/coach/athletes');
  assert.equal(other.status, 200);
  assert.equal(other.body.links.some(link => link.id === linkId), false);
  const athleteLinks = await request(server, IDS.athleteA, 'GET', '/api/athlete/coaches');
  assert.equal(athleteLinks.body.links.length, 1);
  assert.equal(athleteLinks.body.links[0].coach.id, IDS.coachA);

  result = await request(server, IDS.athleteA, 'POST', '/api/profile', { kind: 'coach', coachSpecialties: ['nutrition'] });
  assert.equal(result.status, 200);
  const dualRoleLinks = await request(server, IDS.athleteA, 'GET', '/api/athlete/coaches');
  assert.equal(dualRoleLinks.body.links[0].status, 'active');
  assert.equal(dualRoleLinks.body.links[0].coach.id, IDS.coachA);

  result = await request(server, IDS.coachB, 'POST', '/api/coach/links/status', { linkId, status: 'suspended' });
  assert.deepEqual([result.status, result.body.code], [404, 'relationship_not_found']);
  result = await request(server, IDS.coachA, 'POST', '/api/coach/links/status', { linkId, status: 'suspended' });
  assert.equal(result.status, 200);
  assert.equal(result.body.link.status, 'suspended');
  result = await request(server, IDS.athleteA, 'POST', '/api/coach/links/status', { linkId, status: 'ended' });
  assert.equal(result.status, 200);
  assert.equal(result.body.link.status, 'ended');
  const endedAgain = await request(server, IDS.athleteA, 'POST', '/api/coach/links/status', { linkId, status: 'ended' });
  assert.equal(endedAgain.status, 200);
  assert.equal(endedAgain.body.link.id, linkId);
  result = await request(server, IDS.coachA, 'POST', '/api/coach/links/status', { linkId, status: 'suspended' });
  assert.deepEqual([result.status, result.body.code], [409, 'invalid_transition']);
  assert.ok(fs.existsSync(path.join(dataDir, `state-${IDS.legacy}.json`)), 'ending a link does not delete training data');

  await stop(server);
  server = await launch(dataDir);
  const afterRestart = await request(server, IDS.athleteA, 'GET', '/api/athlete/coaches');
  assert.equal(afterRestart.body.links[0].status, 'ended');
  const replayAfterRestart = await request(server, IDS.athleteA, 'POST', '/api/coach/invites/accept', { token: inviteToken });
  assert.equal(replayAfterRestart.body.link.id, linkId);

  const audit = fs.readFileSync(path.join(dataDir, 'audit.log'), 'utf8');
  for (const event of [
    'b2b2c.invite.create', 'b2b2c.invite.accept', 'b2b2c.invite.accept.denied',
    'b2b2c.link.suspend', 'b2b2c.link.end', 'b2b2c.link.transition.denied',
  ]) {
    assert.match(audit, new RegExp(event));
  }
  assert.doesNotMatch(audit, new RegExp(inviteToken));
  assert.match(audit, /athlete\[\]->coach\[nutrition\]/);
  for (const reason of ['invite_invalid', 'invite_expired', 'invite_used', 'relationship_not_found', 'invalid_transition']) {
    assert.match(audit, new RegExp(reason));
  }
});
