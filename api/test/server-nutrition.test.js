import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers.mjs';
import { removeB2B2CUser, validateMealPlan } from '../b2b2c.js';
import { assertSchema, schemaAt } from './openapi-schema-helper.mjs';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'http://localhost:8080';
const SECRET = crypto.randomBytes(32).toString('hex');
const IDS = { coachA: 'u_nutrition_a', coachB: 'u_nutrition_b', athleteA: 'u_athlete_a', athleteB: 'u_athlete_b' };

function mintSession(uid) {
  const payload = `${uid}:${Date.now() + 86400000}:0:c`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}

function seed(dataDir) {
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
    schemaVersion: 4,
    users: [
      { id: IDS.coachA, name: 'Nutri A', profile: { kind: 'coach', coachSpecialties: ['nutrition'] } },
      { id: IDS.coachB, name: 'Nutri B', profile: { kind: 'coach', coachSpecialties: ['nutrition'] } },
      { id: IDS.athleteA, name: 'Athlete A' },
      { id: IDS.athleteB, name: 'Athlete B' },
    ],
    creds: [], subs: [], invites: [], coachInvites: [], coachPrescriptions: [], coachAssessments: [],
    coachAthleteLinks: [
      { id: 'cal_a_a', coachId: IDS.coachA, athleteId: IDS.athleteA, scopes: ['nutrition'], status: 'active', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' },
      { id: 'cal_b_a', coachId: IDS.coachB, athleteId: IDS.athleteA, scopes: ['nutrition'], status: 'active', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' },
      { id: 'cal_a_b', coachId: IDS.coachA, athleteId: IDS.athleteB, scopes: ['training'], status: 'active', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' },
    ],
  }, null, 2));
}

async function launch(dataDir, env = {}) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN, RP_ID: 'localhost', AUDIT_LOG: '1',
      B2B2C_MEAL_PLANS_PER_ATHLETE: '2', B2B2C_MAX_MEAL_PLANS: '5',
      B2B2C_DB_FAIL_FILE: path.join(dataDir, 'fail-db-write'), ...env,
    },
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

const plan = {
  title: 'Plano Hipertrofia 2800 kcal', status: 'active', targetCalories: 2800,
  targetMacros: { protein: 180, carbs: 350, fats: 70, fiber: 35, waterMl: 3500 },
  meals: [{
    name: 'Café da Manhã', time: '07:30', items: [{
      name: 'Cardápio diário', portion: 'porções prescritas', calories: 2800, protein: 180, carbs: 350, fats: 70, fiber: 35,
      substitutes: [{ name: 'Whey + pasta de amendoim', portion: '30g + 15g' }],
    }],
  }],
  notes: 'Beber 500ml de água ao acordar.',
};

test('nutrition plans and daily adherence are isolated, bounded and atomic', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-nutrition-'));
  seed(dataDir);
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let server = await launch(dataDir);
  t.after(async () => stop(server));

  let stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
  assert.equal(stored.schemaVersion, 7);
  assert.deepEqual(stored.mealPlans, []);
  assert.deepEqual(stored.mealAdherence, []);

  let result = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/meal-plans`, {
    ...plan, targetCalories: -1,
  });
  assert.deepEqual([result.status, result.body.code], [400, 'invalid_meal_plan']);
  result = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteB}/meal-plans`, plan);
  assert.deepEqual([result.status, result.body.code], [403, 'scope_forbidden']);

  const diskBeforeFailure = fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8');
  fs.writeFileSync(path.join(dataDir, 'fail-db-write'), 'once');
  result = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/meal-plans`, plan);
  assert.deepEqual([result.status, result.body.code], [503, 'storage_unavailable']);
  assert.equal(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'), diskBeforeFailure);
  assert.deepEqual((await request(server, IDS.coachA, 'GET', `/api/coach/athletes/${IDS.athleteA}/meal-plans`)).body.mealPlans, []);

  result = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/meal-plans`, plan);
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assertSchema(assert, schemaAt('#/components/schemas/MealPlanCreateInput'), plan, 'POST input validates against OpenAPI');
  assertSchema(assert, schemaAt('#/components/schemas/MealPlanResponse'), result.body.mealPlan, 'actual POST response validates against OpenAPI');
  const planId = result.body.mealPlan.id;
  const mealId = result.body.mealPlan.meals[0].id;
  assert.equal(result.body.mealPlan.coach.name, 'Nutri A');
  assert.equal(result.body.mealPlan.targetMacros.fiber, 35);
  assert.equal(result.body.mealPlan.meals[0].items[0].fiber, 35);

  const crossCoach = await request(server, IDS.coachB, 'GET', `/api/coach/athletes/${IDS.athleteA}/meal-plans/${planId}`);
  assert.deepEqual([crossCoach.status, crossCoach.body.code], [403, 'meal_plan_forbidden']);
  assert.equal((await request(server, IDS.athleteB, 'GET', '/api/athlete/meal-plan')).body.mealPlan, null);
  assert.equal((await request(server, IDS.athleteA, 'GET', '/api/athlete/meal-plan')).body.mealPlan.id, planId);
  assertSchema(assert, schemaAt('#/components/schemas/MealPlanResponse'),
    (await request(server, IDS.coachA, 'GET', `/api/coach/athletes/${IDS.athleteA}/meal-plans/${planId}`)).body.mealPlan,
    'actual GET response validates against OpenAPI');

  result = await request(server, IDS.athleteA, 'POST', '/api/athlete/meal-adherence', {
    mealPlanId: planId, date: '2026-11-06', mealUpdate: { mealId: 'not-a-meal', checked: true },
  });
  assert.deepEqual([result.status, result.body.code], [400, 'invalid_adherence']);
  result = await request(server, IDS.athleteA, 'POST', '/api/athlete/meal-adherence', {
    mealPlanId: planId, date: '2026-11-06', mealUpdate: { mealId, checked: true },
  });
  assert.equal(result.status, 201);
  const adherenceId = result.body.adherence.id;
  result = await request(server, IDS.athleteA, 'POST', '/api/athlete/meal-adherence', {
    mealPlanId: planId, date: '2026-11-06', waterDrunkMl: 3000, notes: 'Atualizado.',
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.adherence.id, adherenceId);
  assert.equal((await request(server, IDS.athleteA, 'GET', '/api/athlete/meal-adherence?date=2026-11-06')).body.adherence.waterDrunkMl, 3000);
  assert.deepEqual((await request(server, IDS.coachA, 'GET', `/api/coach/athletes/${IDS.athleteA}/meal-adherence`)).body.adherence.map(item => item.id), [adherenceId]);
  assert.deepEqual((await request(server, IDS.coachB, 'GET', `/api/coach/athletes/${IDS.athleteA}/meal-adherence`)).body.adherence, []);

  result = await request(server, IDS.coachA, 'PATCH', `/api/coach/athletes/${IDS.athleteA}/meal-plans/${planId}`, { title: 'Plano revisado' });
  assert.equal(result.status, 200);
  assertSchema(assert, schemaAt('#/components/schemas/MealPlanPatchInput'), { title: 'Plano revisado' }, 'PATCH input validates against OpenAPI');
  assertSchema(assert, schemaAt('#/components/schemas/MealPlanResponse'), result.body.mealPlan, 'actual PATCH response validates against OpenAPI');
  assert.equal(result.body.mealPlan.title, 'Plano revisado');
  assert.equal(result.body.mealPlan.meals[0].id, mealId);

  const replacementMeal = {
    id: 'm_replacement', name: 'Dia completo revisado', time: '08:00', items: [{
      id: 'it_replacement', name: 'Cardápio revisado', portion: 'porções prescritas',
      calories: 2800, protein: 180, carbs: 350, fats: 70, fiber: 35, substitutes: [],
    }],
  };
  const beforeReconcileFailure = fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8');
  fs.writeFileSync(path.join(dataDir, 'fail-db-write'), 'once');
  result = await request(server, IDS.coachA, 'PATCH', `/api/coach/athletes/${IDS.athleteA}/meal-plans/${planId}`, { meals: [replacementMeal] });
  assert.deepEqual([result.status, result.body.code], [503, 'storage_unavailable']);
  assert.equal(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'), beforeReconcileFailure);
  assert.deepEqual((await request(server, IDS.athleteA, 'GET', '/api/athlete/meal-adherence?date=2026-11-06')).body.adherence.mealsChecked, [mealId]);
  result = await request(server, IDS.coachA, 'PATCH', `/api/coach/athletes/${IDS.athleteA}/meal-plans/${planId}`, { meals: [replacementMeal] });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  let reconciled = (await request(server, IDS.athleteA, 'GET', '/api/athlete/meal-adherence?date=2026-11-06')).body.adherence;
  assert.deepEqual(reconciled.mealsChecked, []);
  assert.equal(reconciled.waterDrunkMl, 3000);
  assert.equal(reconciled.notes, 'Atualizado.');
  await stop(server);
  server = await launch(dataDir);
  assert.equal((await request(server, IDS.athleteA, 'GET', '/api/athlete/meal-plan')).body.mealPlan.id, planId);
  reconciled = (await request(server, IDS.athleteA, 'GET', '/api/athlete/meal-adherence?date=2026-11-06')).body.adherence;
  assert.deepEqual(reconciled.mealsChecked, [], 'reconciled state survives a healthy restart');

  result = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/meal-plans`, { ...plan, title: 'Rascunho', status: 'draft' });
  assert.equal(result.status, 201);
  result = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/meal-plans`, { ...plan, title: 'Excedente', status: 'draft' });
  assert.deepEqual([result.status, result.body.code], [409, 'meal_plan_capacity']);

  fs.writeFileSync(path.join(dataDir, 'fail-db-write'), 'once');
  result = await request(server, IDS.coachA, 'DELETE', `/api/coach/athletes/${IDS.athleteA}/meal-plans/${planId}`);
  assert.deepEqual([result.status, result.body.code], [503, 'storage_unavailable']);
  assert.equal((await request(server, IDS.athleteA, 'GET', '/api/athlete/meal-plan')).body.mealPlan.id, planId);
  result = await request(server, IDS.coachA, 'DELETE', `/api/coach/athletes/${IDS.athleteA}/meal-plans/${planId}`);
  assert.equal(result.status, 200);
  stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
  assert.equal(stored.mealPlans.some(item => item.id === planId), false);
  assert.equal(stored.mealAdherence.some(item => item.mealPlanId === planId), false);

  const audit = fs.readFileSync(path.join(dataDir, 'audit.log'), 'utf8');
  for (const event of ['b2b2c.meal-plan.create', 'b2b2c.meal-plan.update', 'b2b2c.meal-plan.delete', 'b2b2c.meal-adherence.update']) {
    assert.match(audit, new RegExp(event));
  }
});

test('one global active plan is enforced across authorized professionals', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-nutrition-global-'));
  seed(dataDir);
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const server = await launch(dataDir);
  t.after(async () => stop(server));

  const first = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/meal-plans`, { ...plan, title: 'Plano A' });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  fs.writeFileSync(path.join(dataDir, 'fail-db-write'), 'once');
  let second = await request(server, IDS.coachB, 'POST', `/api/coach/athletes/${IDS.athleteA}/meal-plans`, { ...plan, title: 'Plano B' });
  assert.deepEqual([second.status, second.body.code], [503, 'storage_unavailable']);
  assert.equal((await request(server, IDS.athleteA, 'GET', '/api/athlete/meal-plan')).body.mealPlan.id, first.body.mealPlan.id);

  second = await request(server, IDS.coachB, 'POST', `/api/coach/athletes/${IDS.athleteA}/meal-plans`, { ...plan, title: 'Plano B' });
  assert.equal(second.status, 201, JSON.stringify(second.body));
  const firstAfter = await request(server, IDS.coachA, 'GET', `/api/coach/athletes/${IDS.athleteA}/meal-plans/${first.body.mealPlan.id}`);
  assert.equal(firstAfter.body.mealPlan.status, 'archived');
  let active = (await request(server, IDS.athleteA, 'GET', '/api/athlete/meal-plan')).body.mealPlan;
  assert.equal(active.id, second.body.mealPlan.id);
  assert.equal(active.coach.name, 'Nutri B');

  const draft = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/meal-plans`, { ...plan, title: 'Rascunho A', status: 'draft' });
  assert.equal(draft.status, 201, JSON.stringify(draft.body));
  const editedDraft = await request(server, IDS.coachA, 'PATCH', `/api/coach/athletes/${IDS.athleteA}/meal-plans/${draft.body.mealPlan.id}`, { title: 'Rascunho editado' });
  assert.equal(editedDraft.status, 200);
  active = (await request(server, IDS.athleteA, 'GET', '/api/athlete/meal-plan')).body.mealPlan;
  assert.equal(active.id, second.body.mealPlan.id, 'editing a draft never changes the global active plan');
});

test('nutrition validation rejects non-finite, incoherent, duplicate and false-equivalent data', () => {
  assert.ok(validateMealPlan(plan));
  assert.equal(validateMealPlan({ ...plan, targetCalories: Number.NaN }), null);
  assert.equal(validateMealPlan({ ...plan, targetCalories: Number.POSITIVE_INFINITY }), null);
  assert.equal(validateMealPlan({ ...plan, targetCalories: 9000 }), null, 'target calories must agree broadly with target macros and foods');
  assert.equal(validateMealPlan({ ...plan, meals: [{ ...plan.meals[0], items: [{ ...plan.meals[0].items[0], calories: 5000, protein: 500, carbs: 1000, fats: 500, fiber: 200 }] }] }), null);
  assert.equal(validateMealPlan({ ...plan, meals: [
    { ...plan.meals[0], id: 'same' }, { ...plan.meals[0], id: 'same' },
  ] }), null, 'meal ids are unique inside a plan');
  assert.equal(validateMealPlan({ ...plan, meals: [{ ...plan.meals[0], items: [
    { ...plan.meals[0].items[0], id: 'same' }, { ...plan.meals[0].items[0], id: 'same' },
  ] }] }), null, 'item ids are unique inside a plan');
  const badSubstitute = structuredClone(plan);
  badSubstitute.meals[0].items[0].substitutes[0].calories = 10;
  assert.equal(validateMealPlan(badSubstitute), null, 'supplied substitute nutrition must be equivalent within tolerance');
  const checkedSubstitute = structuredClone(plan);
  Object.assign(checkedSubstitute.meals[0].items[0].substitutes[0], { calories: 2750, protein: 175, carbs: 345, fats: 68, fiber: 33 });
  assert.ok(validateMealPlan(checkedSubstitute));
});

test('defensive account cascade uses athlete plus plan id when corrupt ids collide', () => {
  const db = {
    coachInvites: [], coachAthleteLinks: [], coachPrescriptions: [], coachAssessments: [],
    mealPlans: [
      { id: 'mp_collision', coachId: 'u_coach_a', athleteId: 'u_athlete_a' },
      { id: 'mp_collision', coachId: 'u_coach_b', athleteId: 'u_athlete_b' },
    ],
    mealAdherence: [
      { id: 'adh_a', athleteId: 'u_athlete_a', mealPlanId: 'mp_collision' },
      { id: 'adh_b', athleteId: 'u_athlete_b', mealPlanId: 'mp_collision' },
    ],
  };
  removeB2B2CUser(db, 'u_coach_a');
  assert.deepEqual(db.mealPlans.map(item => item.athleteId), ['u_athlete_b']);
  assert.deepEqual(db.mealAdherence.map(item => item.id), ['adh_b']);
});

test('nutrition mutation throttles are audited and recover after their window', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-nutrition-rate-'));
  seed(dataDir);
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const server = await launch(dataDir, {
    B2B2C_RATE_WINDOW_MS: '1000',
    B2B2C_MEAL_PLAN_MUTATION_ACCOUNT_MAX: '2', B2B2C_MEAL_PLAN_MUTATION_IP_MAX: '20',
    B2B2C_MEAL_ADHERENCE_MUTATION_ACCOUNT_MAX: '2', B2B2C_MEAL_ADHERENCE_MUTATION_IP_MAX: '20',
  });
  t.after(async () => stop(server));
  const created = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/meal-plans`, plan);
  const planId = created.body.mealPlan.id;
  const mealId = created.body.mealPlan.meals[0].id;
  assert.equal((await request(server, IDS.coachA, 'PATCH', `/api/coach/athletes/${IDS.athleteA}/meal-plans/${planId}`, { title: 'dois' })).status, 200);
  let limited = await request(server, IDS.coachA, 'PATCH', `/api/coach/athletes/${IDS.athleteA}/meal-plans/${planId}`, { title: 'três' });
  assert.deepEqual([limited.status, limited.body.code], [429, 'rate_limited']);
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal((await request(server, IDS.coachA, 'PATCH', `/api/coach/athletes/${IDS.athleteA}/meal-plans/${planId}`, { title: 'recuperado' })).status, 200);

  const date = new Date().toISOString().slice(0, 10);
  assert.equal((await request(server, IDS.athleteA, 'POST', '/api/athlete/meal-adherence', { mealPlanId: planId, date, mealUpdate: { mealId, checked: true } })).status, 201);
  assert.equal((await request(server, IDS.athleteA, 'POST', '/api/athlete/meal-adherence', { mealPlanId: planId, date, waterDrunkMl: 1000 })).status, 200);
  limited = await request(server, IDS.athleteA, 'POST', '/api/athlete/meal-adherence', { mealPlanId: planId, date, waterDrunkMl: 1200 });
  assert.deepEqual([limited.status, limited.body.code], [429, 'rate_limited']);
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal((await request(server, IDS.athleteA, 'POST', '/api/athlete/meal-adherence', { mealPlanId: planId, date, waterDrunkMl: 1400 })).status, 200);
  const audit = fs.readFileSync(path.join(dataDir, 'audit.log'), 'utf8');
  assert.match(audit, /b2b2c\.meal-plan\.update\.throttled/);
  assert.match(audit, /b2b2c\.meal-adherence\.update\.throttled/);
});

test('coach adherence history is cursor-paginated and old rows compact before quota checks', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-nutrition-pages-'));
  seed(dataDir);
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const server = await launch(dataDir);
  t.after(async () => stop(server));
  const created = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/meal-plans`, plan);
  const planId = created.body.mealPlan.id;
  const mealId = created.body.mealPlan.meals[0].id;
  const current = new Date();
  const today = current.toISOString().slice(0, 10);
  const yesterday = new Date(current.getTime() - 86400000).toISOString().slice(0, 10);
  for (const date of ['2020-01-01', yesterday, today]) {
    const saved = await request(server, IDS.athleteA, 'POST', '/api/athlete/meal-adherence', { mealPlanId: planId, date, mealUpdate: { mealId, checked: true } });
    assert.ok([200, 201].includes(saved.status), JSON.stringify(saved.body));
  }
  let page = await request(server, IDS.coachA, 'GET', `/api/coach/athletes/${IDS.athleteA}/meal-adherence?limit=1`);
  assert.equal(page.status, 200);
  assert.deepEqual(page.body.adherence.map(item => item.date), [today]);
  assert.equal(page.body.page.hasMore, true);
  assert.equal(page.body.quota.used, 2, 'expired history was compacted instead of consuming quota forever');
  page = await request(server, IDS.coachA, 'GET', `/api/coach/athletes/${IDS.athleteA}/meal-adherence?limit=1&cursor=${encodeURIComponent(page.body.page.nextCursor)}`);
  assert.deepEqual(page.body.adherence.map(item => item.date), [yesterday]);
  assert.equal(page.body.page.hasMore, false);
  assert.deepEqual([(await request(server, IDS.coachA, 'GET', `/api/coach/athletes/${IDS.athleteA}/meal-adherence?limit=0`)).status,
    (await request(server, IDS.coachA, 'GET', `/api/coach/athletes/${IDS.athleteA}/meal-adherence?cursor=bad`)).status], [400, 400]);
});
