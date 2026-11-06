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
const IDS = {
  coach: 'u_training_coach', otherCoach: 'u_other_coach', nutritionCoach: 'u_nutrition_coach',
  athlete: 'u_athlete', otherAthlete: 'u_other_athlete',
};

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
    ],
    creds: [], subs: [], invites: [], coachInvites: [], coachPrescriptions: [],
    coachAthleteLinks: [
      { id: 'cal_training', coachId: IDS.coach, athleteId: IDS.athlete, scopes: ['training'], status: 'active', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' },
      { id: 'cal_other', coachId: IDS.otherCoach, athleteId: IDS.otherAthlete, scopes: ['training'], status: 'active', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' },
      { id: 'cal_nutrition', coachId: IDS.nutritionCoach, athleteId: IDS.athlete, scopes: ['nutrition'], status: 'active', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' },
    ],
  }, null, 2));
}

async function launch(dataDir) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN, RP_ID: 'localhost', AUDIT_LOG: '1' },
  });
  let log = '';
  child.stdout.on('data', chunk => log += chunk);
  child.stderr.on('data', chunk => log += chunk);
  const port = await boundPort(child, () => log);
  return { child, api: `http://127.0.0.1:${port}`, log: () => log };
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
    name: 'Ficha hipertrofia ABC',
    notes: 'Progredir quando completar a faixa.',
    divisions: [
      { name: 'A — Peito e tríceps', exercises: [
        { catalogueId: '0025', name: 'Supino reto', sets: 4, reps: '8-10', load: '60 kg', restSeconds: 90, notes: 'RIR 2' },
        { name: 'Tríceps corda', sets: 3, reps: '12', load: '25 kg', restSeconds: 60, notes: '' },
      ] },
      { name: 'B — Costas e bíceps', exercises: [
        { name: 'Remada baixa', sets: 4, reps: '10', load: '50 kg', restSeconds: 90, notes: 'Segurar 1 s' },
      ] },
      { name: 'C — Pernas', exercises: [
        { name: 'Agachamento', sets: 4, reps: '6-8', load: '80 kg', restSeconds: 120, notes: '' },
      ] },
    ],
  },
};

test('prescriptions persist, require active training scope, and can be adopted and withdrawn', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-prescriptions-'));
  seed(dataDir);
  const existingRoutine = { id: 'mine', name: 'Minha rotina', ex: [{ id: '0027', sets: 3, reps: 8, weight: 40 }], _ts: 90 };
  const existingCustom = { id: 'my_row', n: 'Remada baixa', bp: 'back', eq: 'cable', custom: true, _ts: 91 };
  fs.writeFileSync(path.join(dataDir, `state-${IDS.athlete}.json`), JSON.stringify({
    _rev: 7, _wid: 'wid-before', _wids: ['wid-ancestor'], _ts: 100, unit: 'kg', workouts: [],
    routines: [existingRoutine], customEx: [existingCustom],
  }));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let server = await launch(dataDir);
  t.after(async () => stop(server));

  let result = await request(server, IDS.otherCoach, 'GET', `/api/coach/athletes/${IDS.athlete}/routines`);
  assert.deepEqual([result.status, result.body.code], [404, 'relationship_not_found']);

  result = await request(server, IDS.nutritionCoach, 'POST', `/api/coach/athletes/${IDS.athlete}/routines`, routine);
  assert.deepEqual([result.status, result.body.code], [403, 'scope_forbidden']);

  result = await request(server, IDS.coach, 'POST', `/api/coach/athletes/${IDS.athlete}/routines`, { routine: { name: '', divisions: [] } });
  assert.deepEqual([result.status, result.body.code], [400, 'invalid_routine']);

  result = await request(server, IDS.coach, 'POST', `/api/coach/athletes/${IDS.athlete}/routines`, routine);
  assert.equal(result.status, 201, JSON.stringify(result.body));
  const routineId = result.body.routine.id;
  assert.equal(result.body.routine.state, 'available');
  assert.equal(result.body.routine.coach.id, IDS.coach);
  assert.equal(result.body.routine.athlete.id, IDS.athlete);
  assert.equal(result.body.routine.routine.divisions.length, 3);
  assert.equal(result.body.routine.routine.divisions[0].exercises[0].restSeconds, 90);

  const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
  assert.equal(stored.coachPrescriptions.length, 1);
  assert.equal(stored.coachPrescriptions[0].routine.divisions[2].exercises[0].name, 'Agachamento');
  assert.equal(stored.coachPrescriptions[0].state, 'available');

  result = await request(server, IDS.coach, 'GET', `/api/coach/athletes/${IDS.athlete}/routines`);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.routines.map(item => item.id), [routineId]);

  result = await request(server, IDS.athlete, 'GET', '/api/athlete/prescriptions');
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.prescriptions.map(item => item.id), [routineId]);

  result = await request(server, IDS.athlete, 'POST', `/api/athlete/prescriptions/${routineId}/adopt`, {});
  assert.equal(result.status, 200);
  assert.equal(result.body.prescription.state, 'adopted');
  assert.ok(result.body.prescription.adoptedAt);
  assert.deepEqual(result.body.routineIds, result.body.prescription.adoptedRoutineIds);
  assert.equal(result.body.routineIds.length, 3);

  const adoptedStateFile = path.join(dataDir, `state-${IDS.athlete}.json`);
  const adoptedState = JSON.parse(fs.readFileSync(adoptedStateFile, 'utf8'));
  assert.equal(adoptedState._rev, 8);
  assert.notEqual(adoptedState._wid, 'wid-before');
  assert.deepEqual(adoptedState._wids, ['wid-ancestor', 'wid-before']);
  assert.deepEqual(adoptedState.routines[0], existingRoutine);
  assert.equal(adoptedState.routines.length, 4);
  const adopted = result.body.routineIds.map(id => adoptedState.routines.find(item => item.id === id));
  assert.deepEqual(adopted.map(item => item.name), ['A — Peito e tríceps', 'B — Costas e bíceps', 'C — Pernas']);
  assert.ok(adopted.every(item => item.prescriptionId === routineId));
  assert.deepEqual(adopted[0].ex[0], {
    id: '0025', sets: 4, reps: 10, repsMin: 8, weight: 60, mode: 'reps', restSec: 90, note: 'RIR 2',
  });
  assert.equal(adopted[0].ex[1].sets, 3);
  assert.equal(adopted[0].ex[1].reps, 12);
  assert.equal(adopted[0].ex[1].weight, 25);
  assert.equal(adopted[0].ex[1].restSec, 60);
  assert.equal(adopted[1].ex[0].id, existingCustom.id);
  assert.equal(adopted[1].ex[0].note, 'Segurar 1 s');
  assert.equal(adopted[2].ex[0].repsMin, 6);
  assert.equal(adopted[2].ex[0].reps, 8);
  assert.equal(adopted[2].ex[0].weight, 80);
  assert.equal(adoptedState.customEx.filter(item => item.prescriptionId === routineId).length, 2);

  const stateAfterFirstAdoption = fs.readFileSync(adoptedStateFile, 'utf8');
  const adoptedAt = result.body.prescription.adoptedAt;
  result = await request(server, IDS.athlete, 'POST', `/api/athlete/prescriptions/${routineId}/adopt`, {});
  assert.equal(result.status, 200);
  assert.equal(result.body.prescription.adoptedAt, adoptedAt);
  assert.deepEqual(result.body.routineIds, adopted.map(item => item.id));
  assert.equal(fs.readFileSync(adoptedStateFile, 'utf8'), stateAfterFirstAdoption);

  const otherAthlete = await request(server, IDS.otherAthlete, 'POST', `/api/athlete/prescriptions/${routineId}/adopt`, {});
  assert.deepEqual([otherAthlete.status, otherAthlete.body.code], [404, 'routine_not_found']);

  await stop(server);
  server = await launch(dataDir);
  result = await request(server, IDS.athlete, 'GET', '/api/athlete/prescriptions');
  assert.equal(result.body.prescriptions[0].state, 'adopted');

  result = await request(server, IDS.coach, 'DELETE', `/api/coach/athletes/${IDS.athlete}/routines/${routineId}`);
  assert.equal(result.status, 200);
  assert.equal(result.body.routine.state, 'withdrawn');

  result = await request(server, IDS.athlete, 'GET', '/api/athlete/prescriptions');
  assert.deepEqual(result.body.prescriptions, []);

  const afterDelete = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
  assert.equal(afterDelete.coachPrescriptions[0].state, 'withdrawn');
  assert.ok(afterDelete.coachPrescriptions[0].withdrawnAt);

  const audit = fs.readFileSync(path.join(dataDir, 'audit.log'), 'utf8');
  for (const event of ['b2b2c.prescription.create', 'b2b2c.prescription.adopt', 'b2b2c.prescription.withdraw']) {
    assert.match(audit, new RegExp(event));
  }
  assert.match(audit, /scope_forbidden/);
  assert.match(audit, /relationship_not_found/);
});

test('adoption refuses an unreadable state without replacing it', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-prescriptions-corrupt-'));
  seed(dataDir);
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let server = await launch(dataDir);
  t.after(async () => stop(server));

  const created = await request(server, IDS.coach, 'POST', `/api/coach/athletes/${IDS.athlete}/routines`, routine);
  assert.equal(created.status, 201);
  const file = path.join(dataDir, `state-${IDS.athlete}.json`);
  const corrupt = '{"routines":[';
  fs.writeFileSync(file, corrupt);

  const result = await request(server, IDS.athlete, 'POST', `/api/athlete/prescriptions/${created.body.routine.id}/adopt`, {});
  assert.deepEqual([result.status, result.body.code], [503, 'state_unreadable']);
  assert.equal(fs.readFileSync(file, 'utf8'), corrupt);
  const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
  assert.equal(stored.coachPrescriptions[0].state, 'available');
});

test('adoption fails closed when the training relationship is no longer active', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-prescriptions-inactive-'));
  seed(dataDir);
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let server = await launch(dataDir);
  t.after(async () => stop(server));

  const created = await request(server, IDS.coach, 'POST', `/api/coach/athletes/${IDS.athlete}/routines`, routine);
  assert.equal(created.status, 201);
  await stop(server);
  const dbFile = path.join(dataDir, 'db.json');
  const stored = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
  stored.coachAthleteLinks.find(link => link.id === 'cal_training').status = 'suspended';
  fs.writeFileSync(dbFile, JSON.stringify(stored, null, 2));
  server = await launch(dataDir);

  const result = await request(server, IDS.athlete, 'POST', `/api/athlete/prescriptions/${created.body.routine.id}/adopt`, {});
  assert.equal(result.status, 403);
  assert.equal(fs.existsSync(path.join(dataDir, `state-${IDS.athlete}.json`)), false);
});
