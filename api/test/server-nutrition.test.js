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
      { id: 'cal_a_a', coachId: IDS.coachA, athleteId: IDS.athleteA, scopes: ['nutrition'], status: 'active', createdAt: '2026-11-01T00:00:00.000Z', acceptedAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' },
      { id: 'cal_b_a', coachId: IDS.coachB, athleteId: IDS.athleteA, scopes: ['nutrition'], status: 'active', createdAt: '2026-11-01T00:00:00.000Z', acceptedAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' },
      { id: 'cal_a_b', coachId: IDS.coachA, athleteId: IDS.athleteB, scopes: ['training'], status: 'active', createdAt: '2026-11-01T00:00:00.000Z', acceptedAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' },
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
  assert.equal(stored.schemaVersion, 10);
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
  const originalSnapshot = structuredClone(result.body.adherence.planSnapshot);
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
  assert.deepEqual(reconciled.mealsChecked, [mealId]);
  assert.equal(reconciled.waterDrunkMl, 3000);
  assert.equal(reconciled.notes, 'Atualizado.');
  assert.deepEqual(reconciled.planSnapshot, originalSnapshot, 'plan edits never rewrite the historical denominator');
  await stop(server);
  server = await launch(dataDir);
  assert.equal((await request(server, IDS.athleteA, 'GET', '/api/athlete/meal-plan')).body.mealPlan.id, planId);
  reconciled = (await request(server, IDS.athleteA, 'GET', '/api/athlete/meal-adherence?date=2026-11-06')).body.adherence;
  assert.deepEqual(reconciled.mealsChecked, [mealId], 'immutable historical state survives a healthy restart');
  assert.deepEqual(reconciled.planSnapshot, originalSnapshot);

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
  assert.equal(stored.mealPlanTombstones.some(item => item.id === planId), true);
  assert.equal(stored.mealAdherence.some(item => item.mealPlanId === planId), true);
  const preserved = await request(server, IDS.coachA, 'GET', `/api/coach/athletes/${IDS.athleteA}/meal-adherence`);
  assert.equal(preserved.status, 200);
  assert.deepEqual(preserved.body.adherence.find(item => item.id === adherenceId)?.planSnapshot, originalSnapshot);
  assert.deepEqual((await request(server, IDS.coachB, 'GET', `/api/coach/athletes/${IDS.athleteA}/meal-adherence`)).body.adherence, []);
  await stop(server);
  server = await launch(dataDir);
  assert.deepEqual((await request(server, IDS.coachA, 'GET', `/api/coach/athletes/${IDS.athleteA}/meal-adherence`)).body.adherence
    .find(item => item.id === adherenceId)?.planSnapshot, originalSnapshot, 'deleted-plan history survives restart');

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

  const coverage = ratio => ({
    ...plan,
    meals: [{ ...plan.meals[0], items: [{
      ...plan.meals[0].items[0],
      calories: plan.targetCalories * ratio,
      protein: plan.targetMacros.protein * ratio,
      carbs: plan.targetMacros.carbs * ratio,
      fats: plan.targetMacros.fats * ratio,
      fiber: plan.targetMacros.fiber * ratio,
    }] }],
  });
  assert.equal(validateMealPlan(coverage(0.79)), null, 'food coverage below the lower boundary is rejected');
  assert.ok(validateMealPlan(coverage(0.5), { contractVersion: 1 }), 'migrated legacy plans retain their historical validation contract');
  assert.ok(validateMealPlan(coverage(0.8)), 'food coverage accepts the lower boundary');
  assert.ok(validateMealPlan(coverage(1)), 'food coverage accepts the target');
  assert.ok(validateMealPlan(coverage(1.2)), 'food coverage accepts the upper boundary');
  assert.equal(validateMealPlan(coverage(1.21)), null, 'food coverage above the upper boundary is rejected');
  assert.equal(validateMealPlan({ ...plan, targetMacros: { ...plan.targetMacros, protein: -1 } }), null);
  assert.equal(validateMealPlan({ ...plan, targetMacros: { ...plan.targetMacros, protein: Number.NaN } }), null);
  assert.equal(validateMealPlan({ ...plan, targetMacros: { ...plan.targetMacros, protein: Number.POSITIVE_INFINITY } }), null);
});

test('a started day keeps its original plan snapshot while future days use the edited plan', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-nutrition-current-day-'));
  seed(dataDir);
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const server = await launch(dataDir);
  t.after(async () => stop(server));
  const created = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/meal-plans`, plan);
  const planId = created.body.mealPlan.id;
  const oldMealId = created.body.mealPlan.meals[0].id;
  const date = new Date().toISOString().slice(0, 10);
  let saved = await request(server, IDS.athleteA, 'POST', '/api/athlete/meal-adherence', {
    mealPlanId: planId, date, waterDrunkMl: 500,
  });
  assert.equal(saved.status, 201);
  const snapshot = structuredClone(saved.body.adherence.planSnapshot);
  const updatedAt = saved.body.adherence.updatedAt;
  const replacementMeal = {
    id: 'm_tomorrow', name: 'Plano de amanhã', time: '09:00', items: [{
      id: 'it_tomorrow', name: 'Cardápio amanhã', portion: 'porções prescritas',
      calories: 2800, protein: 180, carbs: 350, fats: 70, fiber: 35, substitutes: [],
    }],
  };
  const patched = await request(server, IDS.coachA, 'PATCH', `/api/coach/athletes/${IDS.athleteA}/meal-plans/${planId}`, {
    meals: [replacementMeal], targetMacros: { ...plan.targetMacros, waterMl: 4200 },
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  saved = await request(server, IDS.athleteA, 'GET', `/api/athlete/meal-adherence?date=${date}`);
  assert.equal(saved.body.adherence.updatedAt, updatedAt, 'PATCH does not touch the check-in timestamp');
  assert.deepEqual(saved.body.adherence.planSnapshot, snapshot);
  assert.equal((await request(server, IDS.athleteA, 'GET', `/api/athlete/meal-plan?date=${date}`)).body.mealPlan.meals[0].id, oldMealId);
  assert.equal((await request(server, IDS.athleteA, 'POST', '/api/athlete/meal-adherence', {
    mealPlanId: planId, date, mealUpdate: { mealId: oldMealId, checked: true },
  })).status, 200, 'the already-started day remains writable against its snapshot');
  assert.equal((await request(server, IDS.athleteA, 'POST', '/api/athlete/meal-adherence', {
    mealPlanId: planId, date, mealUpdate: { mealId: replacementMeal.id, checked: true },
  })).status, 400, 'new meal ids do not leak into the already-started day');
  const tomorrow = new Date(Date.parse(`${date}T00:00:00.000Z`) + 86400000).toISOString().slice(0, 10);
  const future = await request(server, IDS.athleteA, 'POST', '/api/athlete/meal-adherence', {
    mealPlanId: planId, date: tomorrow, mealUpdate: { mealId: replacementMeal.id, checked: true },
  });
  assert.equal(future.status, 201, JSON.stringify(future.body));
  assert.equal(future.body.adherence.planSnapshot.meals[0].id, replacementMeal.id);
  assert.equal(future.body.adherence.planSnapshot.targetMacros.waterMl, 4200);
  const replacementPlan = await request(server, IDS.coachB, 'POST', `/api/coach/athletes/${IDS.athleteA}/meal-plans`, { ...plan, title: 'Novo plano ativo' });
  assert.equal(replacementPlan.status, 201, JSON.stringify(replacementPlan.body));
  const currentDayPlan = (await request(server, IDS.athleteA, 'GET', `/api/athlete/meal-plan?date=${date}`)).body.mealPlan;
  assert.equal(currentDayPlan.id, planId, 'activating another plan does not replace a day already started');
  assert.equal(currentDayPlan.meals[0].id, oldMealId);
});

test('former nutrition relationships keep read-only access to owned retained history', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-nutrition-history-access-'));
  const oldRetention = process.env.B2B2C_TERMINAL_RETENTION_DAYS;
  process.env.B2B2C_TERMINAL_RETENTION_DAYS = '1';
  seed(dataDir);
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  t.after(() => {
    if (oldRetention === undefined) delete process.env.B2B2C_TERMINAL_RETENTION_DAYS;
    else process.env.B2B2C_TERMINAL_RETENTION_DAYS = oldRetention;
  });
  const server = await launch(dataDir);
  t.after(async () => stop(server));
  const created = await request(server, IDS.coachA, 'POST', `/api/coach/athletes/${IDS.athleteA}/meal-plans`, plan);
  const planId = created.body.mealPlan.id;
  const date = new Date().toISOString().slice(0, 10);
  assert.equal((await request(server, IDS.athleteA, 'POST', '/api/athlete/meal-adherence', {
    mealPlanId: planId, date, waterDrunkMl: 500,
  })).status, 201);
  assert.equal((await request(server, IDS.coachA, 'POST', '/api/coach/links/status', { linkId: 'cal_a_a', status: 'ended' })).status, 200);
  assert.equal((await request(server, IDS.coachA, 'GET', `/api/coach/athletes/${IDS.athleteA}/meal-plans`)).status, 403);
  const history = await request(server, IDS.coachA, 'GET', `/api/coach/athletes/${IDS.athleteA}/meal-adherence`);
  assert.equal(history.status, 200);
  assert.equal(history.body.adherence.length, 1);
  assert.equal((await request(server, IDS.coachB, 'GET', `/api/coach/athletes/${IDS.athleteA}/meal-adherence`)).body.adherence.length, 0);
  await stop(server);
  const aged = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
  const endedLink = aged.coachAthleteLinks.find(item => item.id === 'cal_a_a');
  endedLink.updatedAt = '2020-01-01T00:00:00.000Z';
  endedLink.endedAt = '2020-01-01T00:00:00.000Z';
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify(aged));
  const restarted = await launch(dataDir);
  t.after(async () => stop(restarted));
  assert.equal((await request(restarted, IDS.coachA, 'GET', `/api/coach/athletes/${IDS.athleteA}/meal-adherence`)).status, 200,
    'retained nutrition history protects the ended relationship tombstone across restart');

  const pendingDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-nutrition-pending-history-'));
  t.after(() => fs.rmSync(pendingDataDir, { recursive: true, force: true }));
  seed(pendingDataDir);
  const stored = JSON.parse(fs.readFileSync(path.join(pendingDataDir, 'db.json'), 'utf8'));
  stored.coachAthleteLinks.push({
    id: 'cal_pending', coachId: IDS.coachA, athleteId: IDS.athleteB, scopes: ['nutrition'], status: 'ended',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:01:00.000Z',
    endedAt: '2026-01-01T00:01:00.000Z', endedBy: IDS.coachA,
  });
  fs.writeFileSync(path.join(pendingDataDir, 'db.json'), JSON.stringify(stored));
  const pendingServer = await launch(pendingDataDir);
  t.after(async () => stop(pendingServer));
  assert.equal((await request(pendingServer, IDS.coachA, 'GET', `/api/coach/athletes/${IDS.athleteB}/meal-adherence`)).status, 404,
    'an invite ended before acceptance never grants historical nutrition access');
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
