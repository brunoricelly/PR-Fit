import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers.mjs';

const JSON_ONLY = process.env.STORE === 'postgres' ? 'json-store fixture: edits, corrupts or locks db.json/state files out of band (not a Postgres behaviour); durable-store equivalents live in store-pg, store-writer-lock and store-write-failure' : false;

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'http://localhost:8080';
const SECRET = crypto.randomBytes(32).toString('hex');
const IDS = {
  coach: 'u_training_coach', otherCoach: 'u_other_coach', nutritionCoach: 'u_nutrition_coach',
  athlete: 'u_athlete', otherAthlete: 'u_other_athlete', pausedAthlete: 'u_paused', nutritionOnly: 'u_nutri_only',
};
const MANY = Array.from({ length: 52 }, (_, i) => `u_many_${i}`);

function mintSession(uid) {
  const payload = `${uid}:${Date.now() + 86400000}:0:c`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}

function seed(dataDir) {
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
    schemaVersion: 3,
    users: [
      { id: IDS.coach, name: 'Coach Treino', profile: { kind: 'coach', coachSpecialties: ['training'] } },
      { id: IDS.otherCoach, name: 'Outro Coach', profile: { kind: 'coach', coachSpecialties: ['training'] } },
      { id: IDS.nutritionCoach, name: 'Nutri', profile: { kind: 'coach', coachSpecialties: ['nutrition'] } },
      { id: IDS.athlete, name: 'Ana' },
      { id: IDS.otherAthlete, name: 'Bia' },
      { id: IDS.pausedAthlete, name: 'Caio' },
      { id: IDS.nutritionOnly, name: 'Duda' },
      ...MANY.map(id => ({ id, name: id })),
    ],
    creds: [], subs: [], invites: [], coachInvites: [], coachPrescriptions: [],
    coachAthleteLinks: [
      { id: 'cal_training', coachId: IDS.coach, athleteId: IDS.athlete, scopes: ['training'], status: 'active', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' },
      { id: 'cal_other', coachId: IDS.otherCoach, athleteId: IDS.otherAthlete, scopes: ['training'], status: 'active', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' },
      { id: 'cal_paused', coachId: IDS.coach, athleteId: IDS.pausedAthlete, scopes: ['training'], status: 'paused', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' },
      { id: 'cal_nutri_only', coachId: IDS.coach, athleteId: IDS.nutritionOnly, scopes: ['nutrition'], status: 'active', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' },
      ...MANY.map(id => ({ id: `cal_${id}`, coachId: IDS.coach, athleteId: id, scopes: ['training'], status: 'active', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' })),
      { id: 'cal_nutrition', coachId: IDS.nutritionCoach, athleteId: IDS.athlete, scopes: ['nutrition'], status: 'active', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' },
    ],
  }, null, 2));
}

async function launch(dataDir, env = {}) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN, RP_ID: 'localhost', AUDIT_LOG: '1', ...env },
  });
  let log = '';
  child.stdout.on('data', chunk => log += chunk);
  child.stderr.on('data', chunk => log += chunk);
  const port = await boundPort(child, () => log);
  return { child, api: `http://127.0.0.1:${port}`, log: () => log };
}

async function waitForFile(file) {
  const deadline = Date.now() + 30000;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${file}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function stop(server) {
  if (server.child.exitCode !== null) return;
  server.child.kill('SIGTERM');
  await new Promise(resolve => server.child.once('exit', resolve));
}

async function request(server, uid, method, route, body) {
  const response = await fetch(server.api + route, {
    method,
    headers: { Cookie: `gymsid=${mintSession(uid)}`, Origin: ORIGIN, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}


const routine = {
  routine: {
    name: 'Ficha ABC', notes: 'Progredir.',
    divisions: [
      { name: 'A', exercises: [{ catalogueId: '0025', name: 'Supino reto', sets: 4, reps: '8-10', load: '60 kg', restSeconds: 90, notes: 'RIR 2' }] },
      { name: 'B', exercises: [{ name: 'Remada baixa', sets: 4, reps: '10', load: '50 kg', restSeconds: 90, notes: '' }] },
    ],
  },
};
const T = '/api/coach/workout-templates';

async function boot(t, env) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-wtpl-'));
  seed(dataDir);
  const server = await launch(dataDir, env);
  t.after(async () => { await stop(server); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { dataDir, server };
}
const prescriptions = (dataDir) => JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8')).coachPrescriptions;

test('templates: auth, role, capability and ownership are enforced before anything is revealed', async t => {
  const { server } = await boot(t);
  const anon = await fetch(server.api + T, { headers: { Origin: ORIGIN } });
  assert.equal(anon.status, 401);
  assert.equal((await request(server, IDS.athlete, 'GET', T)).status, 403);
  assert.equal((await request(server, IDS.nutritionCoach, 'POST', T, routine)).status, 403);
  const created = await request(server, IDS.coach, 'POST', T, routine);
  assert.equal(created.status, 201);
  const id = created.body.template.id;
  assert.match(id, /^wtpl_/);
  // another coach neither sees, edits, deletes nor assigns it - and gets the same 404 as for a missing id
  assert.deepEqual((await request(server, IDS.otherCoach, 'GET', T)).body, { templates: [] });
  for (const [method, suffix, body] of [['PUT', '', routine], ['DELETE', '', undefined], ['POST', '/assign', { athleteIds: [IDS.otherAthlete] }]]) {
    const foreign = await request(server, IDS.otherCoach, method, `${T}/${id}${suffix}`, body);
    const missing = await request(server, IDS.otherCoach, method, `${T}/wtpl_doesnotexist${suffix}`, body);
    assert.equal(foreign.status, 404, `${method}${suffix}`);
    assert.deepEqual(foreign.body, missing.body);
  }
  assert.equal((await request(server, IDS.coach, 'GET', T)).body.templates.length, 1);
});

test('templates: invalid routine, id and body are refused with 400', async t => {
  const { server } = await boot(t);
  assert.equal((await request(server, IDS.coach, 'POST', T, { routine: { name: '', divisions: [] } })).status, 400);
  assert.equal((await request(server, IDS.coach, 'POST', T, { ...routine, extra: 1 })).status, 400);
  assert.equal((await request(server, IDS.coach, 'PUT', `${T}/bad.id`, routine)).status, 404);
  const { body } = await request(server, IDS.coach, 'POST', T, routine);
  const url = `${T}/${body.template.id}/assign`;
  for (const bad of [{}, { athleteIds: [] }, { athleteIds: 'x' }, { athleteIds: [1] }, { athleteIds: ['a b'] }, { athleteIds: [IDS.athlete], extra: 1 }, { athleteIds: MANY.slice(0, 51) }]) {
    assert.equal((await request(server, IDS.coach, 'POST', url, bad)).status, 400, JSON.stringify(bad).slice(0, 60));
  }
});

test('assign: per-athlete outcomes, duplicates skipped, independent copies, template edit/delete never touches them', async t => {
  const { dataDir, server } = await boot(t);
  const { body: { template } } = await request(server, IDS.coach, 'POST', T, routine);
  const url = `${T}/${template.id}/assign`;
  const targets = [IDS.athlete, IDS.otherAthlete, IDS.pausedAthlete, IDS.nutritionOnly, 'u_ghost', IDS.coach, IDS.athlete];
  const first = await request(server, IDS.coach, 'POST', url, { athleteIds: targets });
  assert.equal(first.status, 200);
  const by = Object.fromEntries(first.body.results.map(r => [r.athleteId, r]));
  assert.equal(first.body.results.length, 6, 'repeated ids collapse into one result');
  assert.equal(by[IDS.athlete].status, 'assigned');
  assert.equal(by[IDS.otherAthlete].code, 'relationship_not_found', "another coach's athlete looks like a stranger");
  assert.equal(by[IDS.pausedAthlete].status, 'skipped');
  assert.ok(['relationship_inactive', 'relationship_not_found'].includes(by[IDS.pausedAthlete].code));
  assert.equal(by[IDS.nutritionOnly].code, 'scope_forbidden');
  assert.equal(by.u_ghost.code, 'relationship_not_found');
  assert.equal(by[IDS.coach].code, 'relationship_not_found');
  assert.equal(prescriptions(dataDir).length, 1);

  const again = await request(server, IDS.coach, 'POST', url, { athleteIds: [IDS.athlete] });
  assert.equal(again.body.results[0].code, 'already_assigned');
  assert.equal(again.body.results[0].prescriptionId, by[IDS.athlete].prescriptionId);
  assert.equal(prescriptions(dataDir).length, 1, 'no second prescription');

  // copy is independent: edit then delete the template, the prescription keeps the original routine
  const edited = structuredClone(routine); edited.routine.name = 'Ficha NOVA';
  assert.equal((await request(server, IDS.coach, 'PUT', `${T}/${template.id}`, edited)).status, 200);
  assert.equal((await request(server, IDS.coach, 'DELETE', `${T}/${template.id}`)).status, 200);
  const row = prescriptions(dataDir)[0];
  assert.equal(row.routine.name, 'Ficha ABC');
  assert.equal(row.templateId, template.id);
  assert.equal(row.state, 'available');
  assert.equal(row.athleteId, IDS.athlete);
  assert.equal((await request(server, IDS.coach, 'POST', url, { athleteIds: [IDS.athlete] })).status, 404, 'deleted template cannot be assigned');
});

test('assign: 50 athletes in one request is accepted, withdrawn prescriptions free the template for re-assignment', async t => {
  const { dataDir, server } = await boot(t);
  const { body: { template } } = await request(server, IDS.coach, 'POST', T, routine);
  const url = `${T}/${template.id}/assign`;
  const ok = await request(server, IDS.coach, 'POST', url, { athleteIds: MANY.slice(0, 50) });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.results.filter(r => r.status === 'assigned').length, 50);
  assert.equal(prescriptions(dataDir).length, 50);
  assert.equal(new Set(prescriptions(dataDir).map(r => r.id)).size, 50);
  // athlete sees it through the ordinary flow
  const mine = await request(server, MANY[0], 'GET', '/api/athlete/prescriptions');
  assert.equal(mine.status, 200);
  assert.equal(mine.body.prescriptions.length, 1);
  assert.equal(mine.body.prescriptions[0].routine.name, 'Ficha ABC');
  const del = await request(server, IDS.coach, 'DELETE', `/api/coach/athletes/${MANY[0]}/routines/${ok.body.results[0].prescriptionId}`);
  assert.equal(del.status, 200);
  const re = await request(server, IDS.coach, 'POST', url, { athleteIds: [MANY[0]] });
  assert.equal(re.body.results[0].status, 'assigned');
});

test('quota: per-athlete prescription capacity is reported per athlete and does not abort the rest', async t => {
  const { dataDir, server } = await boot(t, { B2B2C_PRESCRIPTIONS_PER_ATHLETE: '1' });
  const { body: { template } } = await request(server, IDS.coach, 'POST', T, routine);
  const other = structuredClone(routine); other.routine.name = 'Outra';
  const { body: { template: second } } = await request(server, IDS.coach, 'POST', T, other);
  await request(server, IDS.coach, 'POST', `${T}/${template.id}/assign`, { athleteIds: [IDS.athlete] });
  const res = await request(server, IDS.coach, 'POST', `${T}/${second.id}/assign`, { athleteIds: [IDS.athlete, MANY[0]] });
  const by = Object.fromEntries(res.body.results.map(r => [r.athleteId, r]));
  assert.equal(by[IDS.athlete].code, 'prescription_capacity');
  assert.equal(by[MANY[0]].status, 'assigned');
  assert.equal(prescriptions(dataDir).length, 2);
});

test('quota: template count per coach is capped with 409', async t => {
  const { server } = await boot(t, { B2B2C_WORKOUT_TEMPLATE_MUTATION_ACCOUNT_MAX: '1000', B2B2C_WORKOUT_TEMPLATE_MUTATION_IP_MAX: '1000' });
  for (let i = 0; i < 100; i++) assert.equal((await request(server, IDS.coach, 'POST', T, routine)).status, 201);
  const over = await request(server, IDS.coach, 'POST', T, routine);
  assert.equal(over.status, 409);
  assert.equal(over.body.code, 'template_limit_reached');
  assert.equal((await request(server, IDS.otherCoach, 'POST', T, routine)).status, 201, 'another coach is unaffected');
});

test('templates and assignments survive a restart', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-wtpl-'));
  seed(dataDir);
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let server = await launch(dataDir);
  const { body: { template } } = await request(server, IDS.coach, 'POST', T, routine);
  await request(server, IDS.coach, 'POST', `${T}/${template.id}/assign`, { athleteIds: [IDS.athlete] });
  await stop(server);
  server = await launch(dataDir);
  t.after(() => stop(server));
  const list = await request(server, IDS.coach, 'GET', T);
  assert.equal(list.body.templates[0].id, template.id);
  assert.equal(prescriptions(dataDir).length, 1);
  assert.equal((await request(server, IDS.coach, 'POST', `${T}/${template.id}/assign`, { athleteIds: [IDS.athlete] })).body.results[0].code, 'already_assigned');
});

test('rate limit: mutations are throttled per account with 429 and Retry-After', async t => {
  const { server } = await boot(t, { B2B2C_WORKOUT_TEMPLATE_MUTATION_ACCOUNT_MAX: '2' });
  assert.equal((await request(server, IDS.coach, 'POST', T, routine)).status, 201);
  assert.equal((await request(server, IDS.coach, 'POST', T, routine)).status, 201);
  const res = await fetch(server.api + T, { method: 'POST', headers: { Cookie: `gymsid=${mintSession(IDS.coach)}`, Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify(routine) });
  assert.equal(res.status, 429);
  assert.ok(Number(res.headers.get('retry-after')) > 0);
  assert.equal((await request(server, IDS.otherCoach, 'POST', T, routine)).status, 201, 'other accounts are not throttled');
});
