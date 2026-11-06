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
        { name: 'Supino reto', sets: 4, reps: '8-10', load: '60 kg', restSeconds: 90, notes: 'RIR 2' },
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
