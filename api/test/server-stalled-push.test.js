/* The stalled-athlete push, end to end through the real tick (server.js in a child, tick shortened).
   The push is owed from 18:00 to 21:00 on the athlete's own clock, so each test picks the zone where
   it is 19:xx right now (see server-nudge.test.js). stalled.test.js covers the rules themselves. */
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
const SECRET = crypto.randomBytes(32).toString('hex');
const ATH = 'u_s_ath', COACH = 'u_s_coach';
const sub = { userId: ATH, endpoint: 'https://localhost/x', keys: { p256dh: 'p', auth: 'a' }, created: new Date().toISOString() };
const wait = ms => new Promise(r => setTimeout(r, ms));
const fired = log => (log.match(new RegExp(`stalled push firing ${ATH}`, 'g')) || []).length;
const until = async (pred, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end && !pred()) await wait(100); };

function zoneAt(hour) {
  let off = (hour - new Date().getUTCHours() + 48) % 24;
  if (off > 14) off -= 24;
  return off === 0 ? 'UTC' : off > 0 ? `Etc/GMT-${off}` : `Etc/GMT+${-off}`;
}
const dateIn = (tz, ms = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const daysAgo = (tz, n) => dateIn(tz, Date.now() - n * 86400000);

async function start(t, { scopes = ['training'], status = 'active' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-stalledpush-'));
  fs.writeFileSync(path.join(dir, 'secret'), SECRET, { mode: 0o600 });
  const at = '2026-01-01T00:00:00.000Z';
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({
    users: [
      { id: ATH, name: 'Ath', created: at },
      { id: COACH, name: 'Coach', created: at, profile: { kind: 'coach', coachSpecialties: ['training'] } },
    ],
    creds: [], subs: [sub], invites: [], coachInvites: [],
    coachAthleteLinks: [{ id: 'l1', coachId: COACH, athleteId: ATH, scopes, status, createdAt: at, updatedAt: at, acceptedAt: at }],
  }));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '0', DATA_DIR: dir, ORIGIN: 'http://localhost:8080', RP_ID: 'localhost', REMINDER_TICK_MS: '200' },
  });
  const h = { dir, child, log: '' };
  child.stdout.on('data', d => h.log += d);
  child.stderr.on('data', d => h.log += d);
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }); });
  await boundPort(child, () => h.log);
  h.write = S => fs.writeFileSync(path.join(dir, `state-${ATH}.json`), JSON.stringify(S));
  h.db = () => JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'));
  return h;
}
// The reminder itself is off here, so only the stalled push can fire.
const stalledState = (tz, over = {}) => ({ reminder: { on: false, tz }, routines: [], workouts: [{ id: 'w', d: daysAgo(tz, 12) }], ...over });

test('a stalled athlete gets one push in the evening, marked once per date', { skip: JSON_ONLY }, async t => {
  const tz = zoneAt(19);
  const h = await start(t);
  h.write(stalledState(tz));
  await until(() => fired(h.log) > 0);
  assert.equal(fired(h.log), 1, h.log);
  await wait(1200);
  assert.equal(fired(h.log), 1, 'fired twice on one date');
  const mark = h.db().users.find(u => u.id === ATH).stalledSent;
  assert.equal(mark.date, dateIn(tz));
  assert.equal(mark.count, 1);
  assert.equal(mark.lastWorkout, daysAgo(tz, 12));
});

test('silent when it should be', { skip: JSON_ONLY }, async t => {
  const tz = zoneAt(19);
  const cases = [
    ['trained recently', {}, stalledState(tz, { workouts: [{ id: 'w', d: daysAgo(tz, 2) }] })],
    ['outside the evening window (10:xx)', {}, stalledState(zoneAt(10))],
    ['after the window (22:xx)', {}, stalledState(zoneAt(22))],
    ['noted as away today', {}, stalledState(tz, { dayNotes: { [dateIn(tz)]: { tag: 'travel' } } })],
    ['athlete switched it off', {}, stalledState(tz, { stalledPush: false })],
    ['no training in the relationship', { scopes: ['nutrition'] }, stalledState(tz)],
    ['relationship suspended', { status: 'suspended' }, stalledState(tz)],
    ['no workout ever, link just old enough is "never", not stalled', {}, stalledState(tz, { workouts: [] })],
  ];
  for (const [name, opts, state] of cases) {
    const h = await start(t, opts);
    h.write(state);
    await wait(900);
    assert.equal(fired(h.log), 0, `${name}:\n${h.log}`);
  }
});
