import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
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



import { AI_CATALOGUE } from '../ai-workout-catalogue.js';
import { validateAnswer, resolveRequest, collectAthleteFacts, buildAiWorkout, normaliseRequest } from '../ai-workout.js';

const KNEE = AI_CATALOGUE.filter(x => x.knee).map(x => x.id);
const SAFE = AI_CATALOGUE.filter(x => !x.knee && !x.shoulder && !x.lumbar).map(x => x.id);
const URL_AI = id => `/api/coach/athletes/${id}/ai-workout`;
const answer = (divs, extra = {}) => JSON.stringify({ name: 'Ficha IA', notes: 'n', rationale: 'Porque sim.', divisions: divs.map((ids, i) => ({ name: 'Treino ' + 'ABC'[i], exercises: ids.map(id => ({ id, sets: 3, reps: '8-12', restSeconds: 60, notes: '' })) })), ...extra });

// A fake OpenAI-compatible gateway. `mode` decides how it misbehaves.
async function gateway(t, handler) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      seen.push({ auth: req.headers.authorization, body });
      handler(req, res, body);
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => { srv.closeAllConnections?.(); srv.close(r); }));
  return { url: `http://127.0.0.1:${srv.address().port}/v1`, seen };
}
const ok = text => (req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ model: 'fake-1', choices: [{ message: { content: text } }] })); };
const aiEnv = gw => ({ AI_WORKOUT_BASE_URL: gw.url, AI_WORKOUT_API_KEY: 'test-token-not-real', AI_WORKOUT_TIMEOUT_MS: '3000' });

async function bootAi(t, env) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-aiw-'));
  seed(dataDir);
  fs.writeFileSync(path.join(dataDir, `state-${IDS.athlete}.json`), JSON.stringify({
    _rev: 1, reminder: { tz: 'UTC' },
    coach: { profile: { goal: 'emagrecer', experience: 'iniciante', daysPerWeek: 3, sessionMin: 45, equipment: ['halteres', 'cabo'], limitations: 'dor no joelho direito' } },
    workouts: [{ id: 'w1', d: '2026-11-10', entries: [{ id: SAFE[0] }] }, { id: 'w2', d: '2026-11-12', entries: [{ id: SAFE[0] }] }],
    bodyweight: [{ d: '2026-11-01', w: 92 }, { d: '2026-11-20', w: 90.5 }],
  }));
  const server = await launch(dataDir, env);
  t.after(async () => { await stop(server); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return server;
}

test('ai-workout unit: validateAnswer drops invented ids, repeats and restricted exercises, clamps numbers', () => {
  const resolved = { objective: 'hipertrofia', level: 'iniciante', split: 'upper_lower', restrictions: ['joelho'] };
  const out = validateAnswer(answer([[SAFE[0], SAFE[1], 'INVENTADO', SAFE[1], KNEE[0]], [SAFE[2], SAFE[3]]]), resolved);
  assert.equal(out.ok, true);
  assert.equal(out.dropped, 3);
  assert.deepEqual(out.routine.divisions[0].exercises.map(e => e.catalogueId), [SAFE[0], SAFE[1]]);
  const clamped = JSON.parse(answer([[SAFE[0], SAFE[1]], [SAFE[2], SAFE[3]]]));
  clamped.divisions[0].exercises[0] = { id: SAFE[0], sets: 99, reps: 'abc', restSeconds: -5 };
  const c = validateAnswer(JSON.stringify(clamped), resolved).routine.divisions[0].exercises[0];
  assert.deepEqual([c.sets, c.reps, c.restSeconds], [8, '8-12', 15]);
  assert.equal(validateAnswer('```json\n' + answer([[SAFE[0], SAFE[1]], [SAFE[2], SAFE[3]]]) + '\n```', resolved).ok, true, 'fenced JSON is accepted');
  assert.equal(validateAnswer('desculpe, não consigo', resolved).reason, 'not_json');
  assert.equal(validateAnswer(answer([['X1', 'X2']]), resolved).reason, 'no_valid_exercises');
  assert.equal(validateAnswer(answer([[SAFE[0], SAFE[1]]]), resolved).reason, 'too_few_divisions', 'AB asked, one division answered');
});

test('ai-workout unit: athlete facts complete what the coach left open and never invent', () => {
  const facts = collectAthleteFacts({ state: { coach: { profile: { goal: 'quero emagrecer', experience: 'iniciante', daysPerWeek: 5, limitations: 'hérnia de disco lombar e ombro' } }, workouts: [] }, link: { scopes: ['training'] }, todayIso: '2026-11-24' });
  const r = resolveRequest(normaliseRequest({}), facts);
  assert.deepEqual([r.objective, r.level, r.split, r.daysPerWeek], ['emagrecimento', 'iniciante', 'ppl', 5]);
  const blank = resolveRequest(normaliseRequest({}), collectAthleteFacts({ state: {}, link: null, todayIso: '2026-11-24' }));
  assert.deepEqual([blank.level, blank.sources.level], ['intermediario', 'default'], 'a lead with no data is not labelled as known');
  assert.deepEqual(r.restrictions.sort(), ['lombar', 'ombro']);
  assert.equal(r.sources.objective, 'athlete');
  const coachWins = resolveRequest(normaliseRequest({ objective: 'forca', level: 'avancado', split: 'full_body', daysPerWeek: 2 }), facts);
  assert.deepEqual([coachWins.objective, coachWins.level, coachWins.split, coachWins.daysPerWeek], ['forca', 'avancado', 'full_body', 2]);
  const empty = collectAthleteFacts({ state: null, link: null, todayIso: '2026-11-24' });
  assert.equal(empty.goal, null);
  assert.equal(empty.assessment, undefined, 'no assessment scope => no assessment data');
  const noScope = collectAthleteFacts({ state: {}, link: { scopes: ['training'] }, assessments: [{ weightKg: 80 }], todayIso: '2026-11-24' });
  assert.equal(noScope.assessment, undefined);
});

test('ai-workout unit: buildAiWorkout falls back to rules on every gateway failure, with a reason', async () => {
  const base = { request: {}, state: {}, link: { scopes: ['training'] }, assessments: [], todayIso: '2026-11-24' };
  const env = { AI_WORKOUT_BASE_URL: 'http://gw.invalid/v1', AI_WORKOUT_API_KEY: 'k', AI_WORKOUT_TIMEOUT_MS: '3000' };
  assert.equal((await buildAiWorkout({ ...base, env: {} })).fallbackReason, 'ai_not_configured');
  const res = (status, body) => async () => ({ ok: status < 300, status, json: async () => body });
  assert.equal((await buildAiWorkout({ ...base, env, fetchImpl: res(401, {}) })).fallbackReason, 'gateway_auth');
  assert.equal((await buildAiWorkout({ ...base, env, fetchImpl: res(429, {}) })).fallbackReason, 'gateway_busy');
  assert.equal((await buildAiWorkout({ ...base, env, fetchImpl: res(500, {}) })).fallbackReason, 'gateway_error');
  assert.equal((await buildAiWorkout({ ...base, env, fetchImpl: res(200, { choices: [] }) })).fallbackReason, 'empty');
  assert.equal((await buildAiWorkout({ ...base, env, fetchImpl: async () => { throw new Error('boom'); } })).fallbackReason, 'network');
  assert.equal((await buildAiWorkout({ ...base, env, fetchImpl: res(200, { choices: [{ message: { content: 'sem json' } }] }) })).fallbackReason, 'not_json');
  const hang = (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
  const started = Date.now();
  const slow = await buildAiWorkout({ ...base, env: { ...env, AI_WORKOUT_TIMEOUT_MS: '3000' }, fetchImpl: hang });
  assert.equal(slow.fallbackReason, 'timeout');
  assert.ok(Date.now() - started < 5000, 'a hung gateway is cut at the timeout');
});

test('ai-workout route: auth, role, scope and ownership come before any AI call', async t => {
  const gw = await gateway(t, ok(answer([[SAFE[0], SAFE[1]], [SAFE[2], SAFE[3]]])));
  const { api } = await bootAi(t, aiEnv(gw));
  const server = { api };
  const anon = await fetch(api + URL_AI(IDS.athlete), { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(anon.status, 401);
  assert.equal((await request(server, IDS.athlete, 'POST', URL_AI(IDS.athlete), {})).status, 403, 'an athlete is not a coach');
  assert.equal((await request(server, IDS.nutritionCoach, 'POST', URL_AI(IDS.athlete), {})).status, 403, 'nutrition coach lacks training capability');
  const stranger = await request(server, IDS.otherCoach, 'POST', URL_AI(IDS.athlete), {});
  const missing = await request(server, IDS.otherCoach, 'POST', URL_AI('u_nobody'), {});
  assert.equal(stranger.status, 404);
  assert.deepEqual(stranger.body, missing.body, 'another coach cannot tell a linked athlete from a missing one');
  assert.equal((await request(server, IDS.coach, 'POST', URL_AI(IDS.pausedAthlete), {})).status, 403, 'paused link');
  assert.equal((await request(server, IDS.coach, 'POST', URL_AI(IDS.nutritionOnly), {})).status, 403, 'link without training scope');
  assert.equal(gw.seen.length, 0, 'no refused request reached the gateway');
});

test('ai-workout route: real athlete data reaches the model, joint restriction is enforced, token stays server-side', async t => {
  // The model "forgets" the knee: it returns knee-stressing and invented exercises anyway.
  const gw = await gateway(t, ok(answer([[SAFE[0], KNEE[0], 'INVENTADO', SAFE[1], SAFE[4]], [SAFE[2], SAFE[3], KNEE[1]], [SAFE[5], SAFE[6]]])));
  const server = await bootAi(t, aiEnv(gw));
  const res = await request(server, IDS.coach, 'POST', URL_AI(IDS.athlete), { split: 'ppl', note: 'prefere halteres' });
  assert.equal(res.status, 200);
  assert.equal(res.body.source, 'ai');
  assert.equal(res.body.model, 'fake-1');
  assert.deepEqual([res.body.resolved.objective, res.body.resolved.level], ['emagrecimento', 'iniciante'], 'completed from the athlete intake');
  assert.deepEqual(res.body.resolved.restrictions, ['joelho'], 'knee inferred from "dor no joelho"');
  const ids = res.body.routine.divisions.flatMap(d => d.exercises.map(e => e.catalogueId));
  assert.equal(ids.some(id => KNEE.includes(id) || id === 'INVENTADO'), false);
  assert.ok(res.body.droppedExercises >= 3);
  assert.equal(res.body.facts.hasIntake, true);
  assert.equal(res.body.facts.totalSessions, 2);
  // What the gateway received.
  const sent = gw.seen[0];
  assert.equal(sent.auth, 'Bearer test-token-not-real');
  const prompt = sent.body.messages.map(m => m.content).join('\n');
  assert.match(prompt, /emagrecer/);
  assert.match(prompt, /dor no joelho/);
  assert.match(prompt, /prefere halteres/);
  assert.match(prompt, /"first":92,"last":90\.5/);
  assert.equal(KNEE.some(id => new RegExp('^' + id + '\\|', 'm').test(prompt)), false, 'knee-stressing exercises are not even offered');
  assert.equal(JSON.stringify(res.body).includes('test-token-not-real'), false, 'the token never leaves the server');
  assert.equal(prompt.includes('Ana') || prompt.includes(IDS.athlete), false, 'name and id are not sent to the model');
});

test('ai-workout route: gateway down, slow or confused answers fall back to rules, fast', async t => {
  let mode = 'down';
  const gw = await gateway(t, (req, res) => {
    if (mode === 'down') { res.statusCode = 502; return res.end('{}'); }
    if (mode === 'garbage') return ok('não sei montar')(req, res);
    if (mode === 'hang') return; // never answers
  });
  const server = await bootAi(t, { ...aiEnv(gw), AI_WORKOUT_TIMEOUT_MS: '3000' });
  const down = await request(server, IDS.coach, 'POST', URL_AI(IDS.athlete), {});
  assert.deepEqual([down.status, down.body.source, down.body.fallbackReason], [200, 'rules', 'gateway_error']);
  assert.equal(down.body.routine, undefined);
  assert.equal(down.body.resolved.level, 'iniciante', 'the coach still gets the resolved parameters for the rules generator');
  mode = 'garbage';
  assert.equal((await request(server, IDS.coach, 'POST', URL_AI(IDS.athlete), {})).body.fallbackReason, 'not_json');
  mode = 'hang';
  const t0 = Date.now();
  const hung = await request(server, IDS.coach, 'POST', URL_AI(IDS.athlete), {});
  assert.equal(hung.body.fallbackReason, 'timeout');
  assert.ok(Date.now() - t0 < 6000);
});

test('ai-workout route: without gateway configuration it answers rules instead of failing', async t => {
  const server = await bootAi(t, {});
  const res = await request(server, IDS.coach, 'POST', URL_AI(IDS.athlete), {});
  assert.deepEqual([res.status, res.body.source, res.body.fallbackReason], [200, 'rules', 'ai_not_configured']);
});
