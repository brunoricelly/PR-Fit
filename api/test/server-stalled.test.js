import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers.mjs';

const JSON_ONLY = process.env.STORE === 'postgres' ? 'json-store fixture: seeds db.json and state files out of band (not a Postgres behaviour); the rules are covered by stalled.test.js' : false;
const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'http://localhost:8080';
const SECRET = crypto.randomBytes(32).toString('hex');
const ID = { coach: 'u_c1', other: 'u_c2', nutri: 'u_c3', stalled: 'u_a1', active: 'u_a2', fresh: 'u_a3', notraining: 'u_a4', paused: 'u_a5', excused: 'u_a6' };
const iso = off => new Date(Date.now() + off * 86400000).toISOString().slice(0, 10);
const NOW = new Date().toISOString();

const mint = uid => {
  const payload = `${uid}:${Date.now() + 86400000}:0:c`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
};
const link = (id, coachId, athleteId, scopes, status = 'active', acceptedAt = '2026-01-01T00:00:00.000Z') =>
  ({ id, coachId, athleteId, scopes, status, createdAt: acceptedAt, updatedAt: acceptedAt, acceptedAt });
const user = (id, name, profile) => ({ id, name, created: '2026-01-01T00:00:00.000Z', ...(profile ? { profile } : {}) });
const state = (workouts, extra = {}) => JSON.stringify({ workouts: workouts.map(d => ({ id: 'w' + d, d })), routines: [], ...extra });

function seed(dir) {
  fs.writeFileSync(path.join(dir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({
    users: [
      user(ID.coach, 'Coach', { kind: 'coach', coachSpecialties: ['training'] }),
      user(ID.other, 'Other coach', { kind: 'coach', coachSpecialties: ['training'] }),
      user(ID.nutri, 'Nutri coach', { kind: 'coach', coachSpecialties: ['nutrition'] }),
      ...['stalled', 'active', 'fresh', 'notraining', 'paused', 'excused'].map(k => user(ID[k], k)),
    ],
    creds: [], subs: [], invites: [], coachInvites: [],
    coachAthleteLinks: [
      link('l1', ID.coach, ID.stalled, ['training']),
      link('l2', ID.coach, ID.active, ['training']),
      link('l3', ID.coach, ID.fresh, ['training'], 'active', NOW),
      link('l4', ID.coach, ID.notraining, ['nutrition']),
      link('l5', ID.coach, ID.paused, ['training'], 'suspended'),
      link('l6', ID.coach, ID.excused, ['training']),
      link('l7', ID.other, ID.active, ['training']),
      link('l8', ID.nutri, ID.stalled, ['nutrition']),
    ],
  }));
  const put = (uid, body) => fs.writeFileSync(path.join(dir, `state-${uid}.json`), body);
  put(ID.stalled, state([iso(-20), iso(-12)]));
  put(ID.active, state([iso(-1)]));
  put(ID.notraining, state([iso(-30)]));
  put(ID.paused, state([iso(-30)]));
  put(ID.excused, state([iso(-30)], { dayNotes: { [iso(0)]: { tag: 'travel' } } }));
}

async function launch(dir) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '0', DATA_DIR: dir, ORIGIN, RP_ID: 'localhost' },
  });
  let log = '';
  child.stdout.on('data', d => log += d);
  child.stderr.on('data', d => log += d);
  const port = await boundPort(child, () => log);
  return { child, api: `http://127.0.0.1:${port}` };
}
const get = async (server, uid, route) => {
  const r = await fetch(server.api + route, { headers: { Cookie: `gymsid=${mint(uid)}`, Origin: ORIGIN } });
  return { status: r.status, body: await r.json() };
};
const byAthlete = (links, id) => links.find(l => l.athlete?.id === id);

test('coach list carries activity only where training is shared and active', { skip: JSON_ONLY }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-stalled-'));
  seed(dir);
  const server = await launch(dir);
  t.after(async () => { server.child.kill('SIGTERM'); await new Promise(r => server.child.once('exit', r)); fs.rmSync(dir, { recursive: true, force: true }); });

  const res = await get(server, ID.coach, '/api/coach/athletes');
  assert.equal(res.status, 200);
  assert.equal(res.body.stalledDays, 7);
  const { links } = res.body;
  assert.equal(links.length, 6, 'only this coach\'s own links');

  const stalled = byAthlete(links, ID.stalled).activity;
  assert.equal(stalled.status, 'stalled');
  assert.equal(stalled.lastWorkoutDate, iso(-12));
  assert.equal(stalled.daysSince, 12);
  assert.equal(byAthlete(links, ID.active).activity.status, 'active');
  assert.equal(byAthlete(links, ID.fresh).activity.status, 'active', 'a just-accepted athlete with no workout is not stalled');
  assert.equal(byAthlete(links, ID.excused).activity.status, 'excused');

  assert.equal(byAthlete(links, ID.notraining).activity, undefined, 'no training scope: no activity');
  assert.equal(byAthlete(links, ID.paused).activity, undefined, 'suspended link: no activity');
});

test('the threshold is adjustable and clamped; another coach sees only their own link', { skip: JSON_ONLY }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-stalled-'));
  seed(dir);
  const server = await launch(dir);
  t.after(async () => { server.child.kill('SIGTERM'); await new Promise(r => server.child.once('exit', r)); fs.rmSync(dir, { recursive: true, force: true }); });

  let res = await get(server, ID.coach, '/api/coach/athletes?stalledDays=30');
  assert.equal(res.body.stalledDays, 30);
  assert.equal(byAthlete(res.body.links, ID.stalled).activity.status, 'active');
  res = await get(server, ID.coach, '/api/coach/athletes?stalledDays=1');
  assert.equal(res.body.stalledDays, 2, 'clamped to the minimum');
  res = await get(server, ID.coach, '/api/coach/athletes?stalledDays=x');
  assert.equal(res.body.stalledDays, 7);

  res = await get(server, ID.other, '/api/coach/athletes');
  assert.equal(res.body.links.length, 1);
  assert.equal(res.body.links[0].activity.status, 'active', 'that coach sees the same athlete from their own link only');

  res = await get(server, ID.nutri, '/api/coach/athletes');
  assert.equal(res.body.links[0].activity, undefined, 'a nutrition-only coach cannot read training activity');
});

test('an athlete cannot use the coach list', { skip: JSON_ONLY }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-stalled-'));
  seed(dir);
  const server = await launch(dir);
  t.after(async () => { server.child.kill('SIGTERM'); await new Promise(r => server.child.once('exit', r)); fs.rmSync(dir, { recursive: true, force: true }); });
  const res = await get(server, ID.stalled, '/api/coach/athletes');
  assert.equal(res.status, 403);
});
