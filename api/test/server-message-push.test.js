/* A coach <-> athlete message sends a push to the other side only, best effort, after the commit.
   The text never reaches the log or the push. Real server in a child, sessions minted with the test secret. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers.mjs';

const JSON_ONLY = process.env.STORE === 'postgres' ? 'json-store fixture: seeds db.json out of band (not a Postgres behaviour); the copy is covered by push-messages.test.js' : false;
const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'http://localhost:8080';
const SECRET = crypto.randomBytes(32).toString('hex');
const ATH = 'u_m_ath', COACH = 'u_m_coach';
const at = '2026-01-01T00:00:00.000Z';
const mint = uid => {
  const payload = `${uid}:${Date.now() + 86400000}:0:c`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
};
const sub = uid => ({ userId: uid, endpoint: 'https://localhost/x', keys: { p256dh: 'p', auth: 'a' }, created: at });
const count = (log, uid) => (log.match(new RegExp(`message push firing ${uid}`, 'g')) || []).length;

async function start(t, { subs = [sub(ATH), sub(COACH)], athState = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-msgpush-'));
  fs.writeFileSync(path.join(dir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({
    users: [
      { id: ATH, name: 'Ath', created: at },
      { id: COACH, name: 'Coach', created: at, profile: { kind: 'coach', coachSpecialties: ['training'] } },
    ],
    creds: [], subs, invites: [], coachInvites: [],
    coachAthleteLinks: [{ id: 'l1', coachId: COACH, athleteId: ATH, scopes: ['training'], status: 'active', createdAt: at, updatedAt: at, acceptedAt: at }],
  }));
  if (athState) fs.writeFileSync(path.join(dir, `state-${ATH}.json`), JSON.stringify(athState));
  const child = spawn(process.execPath, ['server.js'], { cwd: API, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PORT: '0', DATA_DIR: dir, ORIGIN, RP_ID: 'localhost' } });
  const h = { log: '' };
  child.stdout.on('data', d => h.log += d);
  child.stderr.on('data', d => h.log += d);
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }); });
  const port = await boundPort(child, () => h.log);
  h.send = async (uid, route, text) => {
    const r = await fetch(`http://127.0.0.1:${port}${route}`, { method: 'POST', headers: { Cookie: `gymsid=${mint(uid)}`, Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ content: text }) });
    return r.status;
  };
  return h;
}

test('the coach writes: only the athlete is notified, without the text', { skip: JSON_ONLY }, async t => {
  const h = await start(t);
  const status = await h.send(COACH, `/api/coach/athletes/${ATH}/messages`, 'segredo-do-treino-123');
  assert.equal(status, 201, h.log);
  assert.equal(count(h.log, ATH), 1, h.log);
  assert.equal(count(h.log, COACH), 0, h.log);
  assert.ok(!h.log.includes('segredo-do-treino-123'), 'message text leaked into the log');
});

test('the athlete writes: only the coach is notified', { skip: JSON_ONLY }, async t => {
  const h = await start(t);
  assert.equal(await h.send(ATH, `/api/athlete/messages/${COACH}`, 'oi coach'), 201, h.log);
  assert.equal(count(h.log, COACH), 1, h.log);
  assert.equal(count(h.log, ATH), 0, h.log);
});

test('a recipient without a subscription never fails the send', { skip: JSON_ONLY }, async t => {
  const h = await start(t, { subs: [] });
  assert.equal(await h.send(COACH, `/api/coach/athletes/${ATH}/messages`, 'oi'), 201, h.log);
});

test('a refused message (stranger) pushes nothing', { skip: JSON_ONLY }, async t => {
  const h = await start(t);
  const status = await h.send('u_m_stranger', `/api/coach/athletes/${ATH}/messages`, 'x');
  assert.notEqual(status, 201);
  assert.equal(count(h.log, ATH), 0, h.log);
});

test('an athlete who switched message alerts off is not pushed, and the message is still stored', { skip: JSON_ONLY }, async t => {
  const h = await start(t, { athState: { messagePush: false, workouts: [], routines: [] } });
  assert.equal(await h.send(COACH, `/api/coach/athletes/${ATH}/messages`, 'oi'), 201, h.log);
  assert.equal(count(h.log, ATH), 0, h.log);
});

test('the setting is per recipient: the coach is still pushed', { skip: JSON_ONLY }, async t => {
  const h = await start(t, { athState: { messagePush: false, workouts: [], routines: [] } });
  assert.equal(await h.send(ATH, `/api/athlete/messages/${COACH}`, 'oi'), 201, h.log);
  assert.equal(count(h.log, COACH), 1, h.log);
});
