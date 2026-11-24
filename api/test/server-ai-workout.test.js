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
import {
  validateAnswer, resolveRequest, collectAthleteFacts, buildAiWorkout, normaliseRequest, buildOutboundPayload,
  assertClosedPayload, buildMessages, allowedExercisesFor, limitsFor, parseLimitations, reviewFlags,
} from '../ai-workout.js';

const KNEE = AI_CATALOGUE.filter(x => x.knee).map(x => x.id);
const SAFE = AI_CATALOGUE.filter(x => !x.knee && !x.shoulder && !x.lumbar).map(x => x.id);
const URL_AI = id => `/api/coach/athletes/${id}/ai-workout`;
const row = id => [id, 3, '12-15', 60];
const answer = (divs, extra = {}) => JSON.stringify({ divisions: divs.map(ids => ({ ex: ids.map(row) })), ...extra });
const PPL = [[SAFE[0], SAFE[1], SAFE[2]], [SAFE[3], SAFE[4], SAFE[5]], [SAFE[6], SAFE[7], SAFE[8]]];

// Everything the athlete or the coach could type that must never reach the gateway.
const SECRETS = ['emagrecer', 'dor no joelho', 'prefere halteres', 'Ana', IDS.athlete, '92', '90.5', 'Coach Treino', 'u_training_coach'];

// A fake OpenAI-compatible gateway. `handler` decides how it misbehaves.
async function gateway(t, handler) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      seen.push({ auth: req.headers.authorization, body, raw });
      handler(req, res, body);
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => { srv.closeAllConnections?.(); srv.close(r); }));
  return { url: `http://127.0.0.1:${srv.address().port}/v1`, seen };
}
const ok = text => (req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ model: 'fake-1', choices: [{ message: { content: text } }] })); };
const aiEnv = gw => ({ AI_WORKOUT_BASE_URL: gw.url, AI_WORKOUT_API_KEY: 'test-token-not-real', AI_WORKOUT_TIMEOUT_MS: '3000' });

async function bootAi(t, env, profile) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-aiw-'));
  seed(dataDir);
  fs.writeFileSync(path.join(dataDir, `state-${IDS.athlete}.json`), JSON.stringify({
    _rev: 1, reminder: { tz: 'UTC' },
    coach: { profile: profile || { goal: 'emagrecer', experience: 'iniciante', daysPerWeek: 3, sessionMin: 45, equipment: ['dumbbell', 'cable'], limitations: 'dor no joelho direito' } },
    workouts: [{ id: 'w1', d: '2026-11-10', entries: [{ id: SAFE[0] }] }, { id: 'w2', d: '2026-11-12', entries: [{ id: SAFE[0] }] }],
    bodyweight: [{ d: '2026-11-01', w: 92 }, { d: '2026-11-20', w: 90.5 }],
  }));
  const server = await launch(dataDir, env);
  t.after(async () => { await stop(server); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return server;
}

const FACTS = (profile = {}, extra = {}) => collectAthleteFacts({ state: { coach: { profile }, workouts: [], ...extra }, link: { scopes: ['training', 'assessments'] }, assessments: [{ weightKg: 83.4, heightCm: 171, results: { bodyFatPercent: 22.2 } }], todayIso: '2026-11-24' });
const resolvedOf = (profile, req = {}) => { const facts = FACTS(profile); return { facts, resolved: resolveRequest(normaliseRequest(req), facts) }; };

test('ai-workout unit: outbound payload is a closed allowlist with no raw athlete/coach strings or numbers', () => {
  const profile = { goal: 'perder gordura SEGREDO-GOAL', experience: 'iniciante SEGREDO-EXP', daysPerWeek: 3, sessionMin: 45, equipment: ['dumbbell', 'cable', 'minha-garagem'], limitations: 'dor no joelho SEGREDO-LIM' };
  const { facts, resolved } = resolvedOf(profile, { note: 'SEGREDO-NOTA prefere halteres' });
  const allowed = allowedExercisesFor(resolved, facts);
  const payload = buildOutboundPayload({ resolved, facts, allowed });
  assert.deepEqual(Object.keys(payload).sort(), ['exerciseIds', 'history', 'params']);
  assert.deepEqual(Object.keys(payload.params).sort(), ['daysPerWeek', 'equipment', 'level', 'limits', 'objective', 'sessionMin', 'split']);
  assert.deepEqual(Object.keys(payload.history).sort(), ['daysSinceLast', 'sessionsLast28Days', 'totalSessions']);
  const text = buildMessages(payload).map(m => m.content).join('\n');
  for (const s of ['SEGREDO', 'joelho', 'lombar', 'restric', 'limita', 'minha-garagem', '83.4', '171', '22.2', 'bodyWeight', 'assessment', 'goal', 'note', 'observa']) {
    assert.equal(text.toLowerCase().includes(s.toLowerCase()), false, `outbound text must not contain ${s}`);
  }
  const requestPart = text.slice(text.indexOf('PEDIDO'), text.indexOf('EXERCÍCIOS PERMITIDOS'));
  assert.equal(/ombro|joelho|lombar/i.test(requestPart), false, 'no restriction label in the request (catalogue names may mention muscles)');
  assert.deepEqual(payload.params.equipment, ['Halteres', 'Cabo', 'Peso corporal']);
  assert.equal(payload.exerciseIds.some(id => KNEE.includes(id)), false, 'injury signal filtered the catalogue locally');
  assert.equal(allowed.every(x => ['Halteres', 'Cabo', 'Peso corporal'].includes(x.equipment)), true);
  // The guard rejects anything outside the allowlist.
  const bad = (mutate) => { const c = JSON.parse(JSON.stringify(payload)); mutate(c); return c; };
  assert.throws(() => assertClosedPayload(bad(c => { c.note = 'x'; })), /not_closed/);
  assert.throws(() => assertClosedPayload(bad(c => { c.params.goal = 'emagrecer'; })), /not_closed/);
  assert.throws(() => assertClosedPayload(bad(c => { c.params.equipment = ['minha-garagem']; })), /not_closed/);
  assert.throws(() => assertClosedPayload(bad(c => { c.params.level = 'qualquer coisa'; })), /not_closed/);
  assert.throws(() => assertClosedPayload(bad(c => { c.params.daysPerWeek = 12; })), /not_closed/);
  assert.throws(() => assertClosedPayload(bad(c => { c.history.totalSessions = 5000; })), /not_closed/);
  assert.throws(() => assertClosedPayload(bad(c => { c.exerciseIds.push('INVENTADO'); })), /not_closed/);
  assert.throws(() => assertClosedPayload(bad(c => { c.history.bodyWeightKg = 92; })), /not_closed/);
});

test('ai-workout unit: limitations are parsed locally and fail closed on anything unrecognised', () => {
  assert.deepEqual(parseLimitations('dor no joelho direito'), { restrictions: ['joelho'], unrecognised: false });
  assert.deepEqual(parseLimitations('hérnia de disco lombar e ombro'), { restrictions: ['ombro', 'lombar'], unrecognised: false });
  assert.deepEqual(parseLimitations(''), { restrictions: [], unrecognised: false });
  assert.equal(parseLimitations('diabetes tipo 2').unrecognised, true);
  assert.equal(parseLimitations('joelho e pressão alta').unrecognised, true, 'a known joint does not excuse an unknown condition');
  assert.equal(parseLimitations('cirurgia no tornozelo').unrecognised, true);
  assert.equal(parseLimitations({ a: 1 }).unrecognised, true);
  assert.deepEqual(parseLimitations('tendinite no ombro'), { restrictions: ['ombro'], unrecognised: false });
  assert.equal(parseLimitations('tendinite').unrecognised, true, 'a descriptor without a joint is not enough');
  const { facts } = resolvedOf({ limitations: 'gestante' });
  const flags = reviewFlags(normaliseRequest({}), facts);
  assert.deepEqual([flags.manualReview, flags.rulesBlocked, flags.manualReviewReasons.includes('limitation_unrecognised')], [true, true, true]);
  assert.equal(reviewFlags(normaliseRequest({ note: 'qualquer coisa' }), FACTS({ goal: 'forca', limitations: 'joelho' })).rulesBlocked, false, 'a coach note asks for review but does not block');
  assert.equal(reviewFlags(normaliseRequest({ note: 'qualquer coisa' }), FACTS({ goal: 'forca' })).manualReview, true);
});

test('ai-workout unit: validateAnswer enforces split count, allowed ids and safe prescription; nothing is clamped', () => {
  const { resolved, facts } = resolvedOf({ goal: 'emagrecer', experience: 'iniciante', daysPerWeek: 3, sessionMin: 60, equipment: ['dumbbell', 'cable'], limitations: 'joelho' }, { split: 'ppl' });
  const allowedIds = allowedExercisesFor(resolved, facts).map(x => x.id);
  assert.deepEqual(resolved.restrictions, ['joelho']);
  const mk = (divs, extra) => answer(divs, extra);
  const good = validateAnswer(mk(PPL.map(d => d.filter(id => allowedIds.includes(id)))), resolved, allowedIds);
  const P = allowedIds.slice(0, 9); const T = [P.slice(0, 3), P.slice(3, 6), P.slice(6, 9)];
  const okRes = validateAnswer(mk(T), resolved, allowedIds);
  assert.equal(okRes.ok, true, JSON.stringify(okRes));
  assert.equal(good.ok === true || good.ok === false, true);
  assert.deepEqual(okRes.routine.divisions.map(d => d.name), ['Treino A - Empurrar', 'Treino B - Puxar', 'Treino C - Pernas']);
  assert.equal(validateAnswer('```json\n' + mk(T) + '\n```', resolved, allowedIds).ok, true, 'fenced JSON is accepted');
  assert.equal(validateAnswer('desculpe, não consigo', resolved, allowedIds).reason, 'not_json');
  assert.equal(validateAnswer('texto antes ' + mk(T), resolved, allowedIds).reason, 'not_json', 'prose-wrapped JSON is rejected');
  // exact split count
  assert.equal(validateAnswer(mk(T.slice(0, 2)), resolved, allowedIds).reason, 'too_few_divisions');
  assert.equal(validateAnswer(mk([...T, T[0]]), resolved, allowedIds).reason, 'wrong_division_count');
  const lower = { ...resolved, split: 'full_body' };
  assert.equal(validateAnswer(mk(T), lower, allowedIds).reason, 'wrong_division_count', 'one division asked, three answered');
  // ids: invented, restricted (knee), outside owned equipment, duplicate
  const swap = (id) => mk([[id, ...T[0].slice(1)], T[1], T[2]]);
  assert.equal(validateAnswer(swap('INVENTADO'), resolved, allowedIds).reason, 'invalid_exercise');
  assert.equal(validateAnswer(swap(KNEE[0]), resolved, allowedIds).reason, 'invalid_exercise');
  const barbell = AI_CATALOGUE.find(x => x.equipment === 'Barra' && !x.knee).id;
  assert.equal(validateAnswer(swap(barbell), resolved, allowedIds).reason, 'invalid_exercise', 'equipment the athlete does not own');
  assert.equal(validateAnswer(mk([[T[0][0], T[0][0], T[0][2]], T[1], T[2]]), resolved, allowedIds).reason, 'duplicate_exercise');
  // prescription: out-of-envelope values reject, never clamp
  const withRow = r => JSON.stringify({ divisions: [{ ex: [r, row(T[0][1]), row(T[0][2])] }, { ex: T[1].map(row) }, { ex: T[2].map(row) }] });
  const lim = limitsFor(resolved);
  assert.deepEqual([lim.sets, lim.reps, lim.rest], [[2, 3], [10, 20], [30, 90]]);
  for (const bad of [[T[0][0], 99, '12-15', 60], [T[0][0], 3, 'abc', 60], [T[0][0], 3, '12-15', -5], [T[0][0], 3, '12-15', 600], [T[0][0], 3, '12-15', 5], [T[0][0], 1, '12-15', 60], [T[0][0], 3.5, '12-15', 60], [T[0][0], '3', '12-15', 60], [T[0][0], 3, '3-5', 60], [T[0][0], 3, '15-10', 60], [T[0][0], 3, 12, 60], [T[0][0], 3, '12-15'], [T[0][0], NaN, '12-15', 60]]) {
    assert.equal(validateAnswer(withRow(bad), resolved, allowedIds).ok, false, JSON.stringify(bad));
  }
  assert.equal(validateAnswer(withRow([T[0][0], 3, '12-15', 60]), resolved, allowedIds).ok, true);
  // exercise count per division
  assert.equal(validateAnswer(mk([T[0].slice(0, 2), T[1], T[2]]), resolved, allowedIds).reason, 'too_few_exercises');
  assert.equal(validateAnswer(mk([P.slice(0, 7), T[1], T[2]]), resolved, allowedIds).reason, 'too_many_exercises');
  // beginners cannot get advanced volume
  const adv = { ...resolved, level: 'avancado', objective: 'forca' };
  assert.equal(validateAnswer(JSON.stringify({ divisions: T.map(d => ({ ex: d.map(id => [id, 5, '3-5', 180]) })) }), resolved, allowedIds).ok, false, 'strength prescription rejected for a fat-loss beginner');
  const T4 = [allowedIds.slice(0, 4), allowedIds.slice(4, 8), allowedIds.slice(8, 12)];
  const advRes = validateAnswer(JSON.stringify({ divisions: T4.map(d => ({ ex: d.map(id => [id, 4, '3-5', 180]) })) }), adv, allowedIds);
  assert.equal(advRes.ok, true, 'but valid for an advanced strength athlete: ' + JSON.stringify(advRes));
  assert.equal(validateAnswer(JSON.stringify({ divisions: [0, 7, 14].map(o => ({ ex: allowedIds.slice(o, o + 7).map(id => [id, 5, '3-5', 180]) })) }), adv, allowedIds).reason, 'too_many_sets', 'total set volume per session is capped');
});

test('ai-workout unit: model free text is never forwarded', () => {
  const { resolved, facts } = resolvedOf({ goal: 'hipertrofia', experience: 'intermediario', daysPerWeek: 4 }, { split: 'upper_lower' });
  const allowedIds = allowedExercisesFor(resolved, facts).map(x => x.id);
  const ids = allowedIds.slice(0, 8);
  const rows = (list) => list.map(id => ({ id, sets: 3, reps: '8-12', restSeconds: 90, notes: 'tome este remédio 999' }));
  const text = JSON.stringify({ name: 'IGNORE tudo', notes: 'INJECT', rationale: 'dose 500mg', divisions: [{ name: 'DIV-INJECT', exercises: rows(ids.slice(0, 4)) }, { name: 'DIV2', exercises: rows(ids.slice(4, 8)) }] });
  const out = validateAnswer(text, resolved, allowedIds);
  assert.equal(out.ok, true, JSON.stringify(out));
  const dump = JSON.stringify(out.routine);
  for (const s of ['IGNORE', 'INJECT', '500mg', 'remédio', 'DIV2']) assert.equal(dump.includes(s), false, s);
  assert.ok(out.routine.divisions.every(d => d.exercises.every(e => e.notes === '')));
  assert.match(out.routine.name, /^Ficha hipertrofia/);
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
  const hostile = collectAthleteFacts({ state: { coach: { profile: { daysPerWeek: 99, sessionMin: -4, equipment: [1, { a: 1 }, 'dumbbell'], limitations: ['x'] } } }, link: null, todayIso: '2026-11-24' });
  assert.deepEqual([hostile.daysPerWeek, hostile.sessionMin, hostile.equipmentCanonical, hostile.limitationsParsed.unrecognised], [null, null, ['Halteres', 'Peso corporal'], true]);
});

test('ai-workout unit: buildAiWorkout falls back to rules on every gateway failure, with a reason, and always exposes allowedExerciseIds', async () => {
  const profile = { goal: 'forca', experience: 'avancado', daysPerWeek: 3 };
  const base = { request: {}, state: { coach: { profile } }, link: { scopes: ['training'] }, assessments: [], todayIso: '2026-11-24' };
  const env = { AI_WORKOUT_BASE_URL: 'http://gw.invalid/v1', AI_WORKOUT_API_KEY: 'k', AI_WORKOUT_TIMEOUT_MS: '3000' };
  const none = await buildAiWorkout({ ...base, env: {} });
  assert.equal(none.fallbackReason, 'ai_not_configured');
  assert.equal(none.allowedExerciseIds.length, AI_CATALOGUE.length, 'no restriction and unknown equipment => whole catalogue');
  assert.deepEqual([none.manualReview, none.rulesBlocked], [false, false]);
  const res = (status, body) => async () => ({ ok: status < 300, status, json: async () => body });
  assert.equal((await buildAiWorkout({ ...base, env, fetchImpl: res(401, {}) })).fallbackReason, 'gateway_auth');
  assert.equal((await buildAiWorkout({ ...base, env, fetchImpl: res(429, {}) })).fallbackReason, 'gateway_busy');
  const failed = await buildAiWorkout({ ...base, env, fetchImpl: res(500, {}) });
  assert.equal(failed.fallbackReason, 'gateway_error');
  assert.deepEqual(failed.allowedExerciseIds, none.allowedExerciseIds, 'fallback carries the same authoritative list');
  assert.equal((await buildAiWorkout({ ...base, env, fetchImpl: res(200, { choices: [] }) })).fallbackReason, 'empty');
  assert.equal((await buildAiWorkout({ ...base, env, fetchImpl: async () => { throw new Error('boom'); } })).fallbackReason, 'network');
  assert.equal((await buildAiWorkout({ ...base, env, fetchImpl: res(200, { choices: [{ message: { content: 'sem json' } }] }) })).fallbackReason, 'not_json');
  const hang = (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
  const started = Date.now();
  const slow = await buildAiWorkout({ ...base, env, fetchImpl: hang });
  assert.equal(slow.fallbackReason, 'timeout');
  assert.ok(Date.now() - started < 5000, 'a hung gateway is cut at the timeout');
  // success carries the same list
  const T = [none.allowedExerciseIds.slice(0, 4), none.allowedExerciseIds.slice(4, 8), none.allowedExerciseIds.slice(8, 12)];
  const good = await buildAiWorkout({ ...base, env, fetchImpl: res(200, { model: 'gateway-claims-x', choices: [{ message: { content: JSON.stringify({ divisions: T.map(d => ({ ex: d.map(id => [id, 4, '3-5', 180]) })) }) } }] }) });
  assert.equal(good.source, 'ai', JSON.stringify(good).slice(0, 300));
  assert.deepEqual(good.allowedExerciseIds, none.allowedExerciseIds);
  assert.equal(good.model, 'auto/smart', 'model label is config, not gateway text');
});

test('ai-workout unit: unrecognised limitation blocks the rules path and never calls the gateway', async () => {
  let calls = 0;
  const out = await buildAiWorkout({
    request: {}, state: { coach: { profile: { goal: 'forca', limitations: 'diabetes e pressão alta' } } }, link: { scopes: ['training'] }, assessments: [], todayIso: '2026-11-24',
    env: { AI_WORKOUT_BASE_URL: 'http://gw.invalid/v1', AI_WORKOUT_API_KEY: 'k' }, fetchImpl: async () => { calls++; throw new Error('must not be called'); },
  });
  assert.equal(calls, 0);
  assert.deepEqual([out.source, out.fallbackReason, out.manualReview, out.rulesBlocked, out.allowedExerciseIds], ['rules', 'manual_review_required', true, true, []]);
  assert.ok(out.manualReviewReasons.includes('limitation_unrecognised'));
  assert.equal(out.routine, undefined);
  // too few safe exercises left for the split (only body weight owned, all joints restricted) also blocks
  const tight = await buildAiWorkout({
    request: { restrictions: ['joelho', 'ombro', 'lombar'] }, state: { coach: { profile: { equipment: ['kettlebell'] } } }, link: { scopes: ['training'] }, assessments: [], todayIso: '2026-11-24',
    env: { AI_WORKOUT_BASE_URL: 'http://gw.invalid/v1', AI_WORKOUT_API_KEY: 'k' }, fetchImpl: async () => { calls++; throw new Error('must not be called'); },
  });
  assert.equal(calls, 0);
  assert.deepEqual([tight.rulesBlocked, tight.manualReview, tight.allowedExerciseIds, tight.manualReviewReasons], [true, true, [], ['insufficient_safe_exercises']]);
});

test('ai-workout route: auth, role, scope and ownership come before any AI call', async t => {
  const gw = await gateway(t, ok(answer(PPL)));
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

test('ai-workout route: only canonical values reach the model, injuries filter locally, AI answer is validated', async t => {
  // The gateway answers with a valid routine built from the ids it was offered, plus hostile free text.
  let offered = [];
  const gw = await gateway(t, (req, res, body) => {
    offered = body.messages[1].content.split('\n').filter(l => /^[A-Za-z0-9_-]+\|/.test(l)).map(l => l.split('|')[0]);
    const pick = offered.slice(0, 9);
    ok(JSON.stringify({ name: 'MODEL-NAME', rationale: 'MODEL-RATIONALE', divisions: [pick.slice(0, 3), pick.slice(3, 6), pick.slice(6, 9)].map(d => ({ name: 'MODEL-DIV', ex: d.map(row) })) }))(req, res);
  });
  const server = await bootAi(t, aiEnv(gw));
  const res = await request(server, IDS.coach, 'POST', URL_AI(IDS.athlete), { split: 'ppl', note: 'prefere halteres' });
  assert.equal(res.status, 200);
  assert.equal(res.body.source, 'ai', JSON.stringify(res.body).slice(0, 400));
  assert.equal(res.body.model, 'auto/smart');
  assert.deepEqual([res.body.resolved.objective, res.body.resolved.level], ['emagrecimento', 'iniciante'], 'completed from the athlete intake');
  assert.deepEqual(res.body.resolved.restrictions, ['joelho'], 'knee inferred from \"dor no joelho\"');
  assert.equal(res.body.manualReview, true, 'a coach note cannot be sent, so it asks for review');
  assert.ok(res.body.manualReviewReasons.includes('coach_note_not_sent'));
  assert.equal(res.body.rulesBlocked, false);
  const ids = res.body.routine.divisions.flatMap(d => d.exercises.map(e => e.catalogueId));
  assert.equal(ids.length, 9);
  assert.equal(ids.every(id => res.body.allowedExerciseIds.includes(id)), true);
  assert.equal(res.body.allowedExerciseIds.some(id => KNEE.includes(id)), false);
  assert.equal(res.body.allowedExerciseIds.every(id => ['Halteres', 'Cabo', 'Peso corporal'].includes(AI_CATALOGUE.find(x => x.id === id).equipment)), true, 'owned equipment only');
  assert.deepEqual(offered.sort(), [...res.body.allowedExerciseIds].sort(), 'the model was offered exactly the authoritative list');
  const dump = JSON.stringify(res.body.routine);
  for (const s of ['MODEL-NAME', 'MODEL-RATIONALE', 'MODEL-DIV']) assert.equal(dump.includes(s), false, 'model text is not forwarded');
  assert.equal(res.body.facts.hasIntake, true);
  assert.equal(res.body.facts.totalSessions, 2);
  // What the gateway received.
  assert.equal(gw.seen.length, 1);
  const sent = gw.seen[0];
  assert.equal(sent.auth, 'Bearer test-token-not-real');
  const wire = sent.raw;
  const prompt = sent.body.messages.map(m => m.content).join('\n');
  for (const s of SECRETS) assert.equal(wire.includes(s), false, `outbound body must not contain ${JSON.stringify(s)}`);
  for (const s of ['joelho', 'knee', 'restri', 'limita', 'bodyWeight', 'assessment']) assert.equal(prompt.toLowerCase().includes(s.toLowerCase()), false, s);
  assert.deepEqual(Object.keys(sent.body).sort(), ['max_tokens', 'messages', 'model', 'response_format']);
  assert.equal(JSON.stringify(res.body).includes('test-token-not-real'), false, 'the token never leaves the server');
});

test('ai-workout route: gateway answers that break the rules fall back to rules with the authoritative list', async t => {
  let mode = 'down';
  const gw = await gateway(t, (req, res, body) => {
    if (mode === 'down') { res.statusCode = 502; return res.end('{}'); }
    if (mode === 'garbage') return ok('não sei montar')(req, res);
    if (mode === 'knee') return ok(answer([[SAFE[0], KNEE[0], SAFE[1]], [SAFE[2], SAFE[3], SAFE[4]], [SAFE[5], SAFE[6], SAFE[7]]]))(req, res);
    if (mode === 'two') return ok(answer(PPL.slice(0, 2)))(req, res);
    if (mode === 'hang') return; // never answers
  });
  const server = await bootAi(t, { ...aiEnv(gw), AI_WORKOUT_TIMEOUT_MS: '3000' });
  const down = await request(server, IDS.coach, 'POST', URL_AI(IDS.athlete), {});
  assert.deepEqual([down.status, down.body.source, down.body.fallbackReason], [200, 'rules', 'gateway_error']);
  assert.equal(down.body.routine, undefined);
  assert.equal(down.body.resolved.level, 'iniciante', 'the coach still gets the resolved parameters for the rules generator');
  assert.ok(down.body.allowedExerciseIds.length > 0 && !down.body.allowedExerciseIds.some(id => KNEE.includes(id)));
  assert.equal(down.body.manualReview, false);
  mode = 'garbage';
  assert.equal((await request(server, IDS.coach, 'POST', URL_AI(IDS.athlete), {})).body.fallbackReason, 'not_json');
  mode = 'knee';
  const knee = await request(server, IDS.coach, 'POST', URL_AI(IDS.athlete), {});
  assert.deepEqual([knee.body.source, knee.body.fallbackReason, knee.body.routine], ['rules', 'invalid_exercise', undefined], 'a knee exercise is rejected, not silently dropped');
  mode = 'two';
  assert.equal((await request(server, IDS.coach, 'POST', URL_AI(IDS.athlete), { split: 'ppl' })).body.fallbackReason, 'too_few_divisions');
  mode = 'hang';
  const t0 = Date.now();
  const hung = await request(server, IDS.coach, 'POST', URL_AI(IDS.athlete), {});
  assert.equal(hung.body.fallbackReason, 'timeout');
  assert.ok(Date.now() - t0 < 6000);
});

test('ai-workout route: an unrecognised limitation blocks generation without calling the gateway', async t => {
  const gw = await gateway(t, ok(answer(PPL)));
  const server = await bootAi(t, aiEnv(gw), { goal: 'forca', experience: 'iniciante', daysPerWeek: 3, limitations: 'diabetes e pressão alta' });
  const res = await request(server, IDS.coach, 'POST', URL_AI(IDS.athlete), {});
  assert.equal(res.status, 200);
  assert.deepEqual([res.body.source, res.body.fallbackReason, res.body.manualReview, res.body.rulesBlocked, res.body.allowedExerciseIds], ['rules', 'manual_review_required', true, true, []]);
  assert.equal(gw.seen.length, 0, 'nothing about this athlete left the server');
});

test('ai-workout route: without gateway configuration it answers rules instead of failing', async t => {
  const server = await bootAi(t, {});
  const res = await request(server, IDS.coach, 'POST', URL_AI(IDS.athlete), {});
  assert.deepEqual([res.status, res.body.source, res.body.fallbackReason], [200, 'rules', 'ai_not_configured']);
  assert.ok(Array.isArray(res.body.allowedExerciseIds) && res.body.allowedExerciseIds.length > 0);
});
