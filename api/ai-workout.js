/* AI workout builder for coaches.
 *
 *   POST /api/coach/athletes/{athleteId}/ai-workout
 *
 * Reads what the platform really knows about the linked athlete (profile intake, training history,
 * body weight, latest assessment when the link includes that scope), asks an OpenAI-compatible
 * gateway (the omniroute) for a routine, and VALIDATES the answer before the coach ever sees it:
 * every exercise must be on the allow-list (ai-workout-catalogue.js), joint restrictions are
 * enforced here and not left to the model, sets/reps/rest are clamped. When the gateway is off,
 * slow, or answers garbage, the caller gets `source: 'rules'` and the front end keeps using the
 * rule-based generator, so the screen never hangs.
 *
 * Configuration (env only; the token is never logged or returned):
 *   AI_WORKOUT_BASE_URL   e.g. https://omniroute.example/v1   (absent => the route answers source 'rules')
 *   AI_WORKOUT_API_KEY
 *   AI_WORKOUT_MODEL      default auto/smart
 *   AI_WORKOUT_TIMEOUT_MS default 40000
 */
import { AI_CATALOGUE } from './ai-workout-catalogue.js';

const BY_ID = new Map(AI_CATALOGUE.map(item => [item.id, item]));
const OBJECTIVES = ['hipertrofia', 'emagrecimento', 'forca', 'condicionamento'];
const LEVELS = ['iniciante', 'intermediario', 'avancado'];
const RESTRICTIONS = ['joelho', 'ombro', 'lombar'];
const SPLITS = ['ppl', 'upper_lower', 'full_body', 'auto'];
const RESTRICTION_FLAG = { joelho: 'knee', ombro: 'shoulder', lombar: 'lumbar' };
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const clip = (value, max) => (typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');

export const AI_WORKOUT_DEFAULTS = Object.freeze({ model: 'auto/smart', timeoutMs: 40000, maxDivisions: 6, maxPerDivision: 10 });

/** What the coach asked for, normalised. Unknown values fall back to a safe default. */
export function normaliseRequest(body) {
  const b = body && typeof body === 'object' ? body : {};
  const restrictions = Array.isArray(b.restrictions) ? [...new Set(b.restrictions.filter(item => RESTRICTIONS.includes(item)))] : [];
  return {
    objective: OBJECTIVES.includes(b.objective) ? b.objective : null,
    level: LEVELS.includes(b.level) ? b.level : null,
    split: SPLITS.includes(b.split) ? b.split : 'auto',
    daysPerWeek: Number.isInteger(b.daysPerWeek) && b.daysPerWeek >= 1 && b.daysPerWeek <= 7 ? b.daysPerWeek : null,
    restrictions,
    note: clip(b.note, 400),
  };
}

const dayNumber = iso => Math.floor(Date.parse(iso + 'T00:00:00Z') / 86400000);
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Facts about the athlete, from data the coach is already allowed to see. `state` is the athlete's own
 *  saved state; fields absent there are simply absent here (never invented). */
export function collectAthleteFacts({ state, link, assessments = [], todayIso }) {
  const S = state && typeof state === 'object' ? state : {};
  const intake = S.coach?.profile && typeof S.coach.profile === 'object' ? S.coach.profile : {};
  const workouts = (Array.isArray(S.workouts) ? S.workouts : []).filter(w => w && typeof w.d === 'string' && ISO.test(w.d));
  const dates = [...new Set(workouts.map(w => w.d))].sort();
  const today = ISO.test(todayIso || '') ? todayIso : new Date().toISOString().slice(0, 10);
  const since = n => dates.filter(d => dayNumber(today) - dayNumber(d) <= n).length;
  const weights = (Array.isArray(S.bodyweight) ? S.bodyweight : []).filter(item => item && Number.isFinite(item.w)).slice(-12);
  const count = {};
  for (const w of workouts.slice(-30)) {
    for (const entry of (Array.isArray(w.entries) ? w.entries : Array.isArray(w.ex) ? w.ex : [])) {
      const id = String(entry?.id ?? entry?.exId ?? '');
      if (BY_ID.has(id)) count[id] = (count[id] || 0) + 1;
    }
  }
  const facts = {
    goal: clip(intake.goal, 60) || null,
    experience: clip(intake.experience, 60) || null,
    daysPerWeek: Number.isInteger(intake.daysPerWeek) ? intake.daysPerWeek : null,
    sessionMin: Number.isInteger(intake.sessionMin) ? intake.sessionMin : null,
    equipment: Array.isArray(intake.equipment) ? intake.equipment.map(e => clip(String(e), 40)).filter(Boolean).slice(0, 12) : [],
    limitations: clip(intake.limitations, 300) || null,
    history: {
      totalSessions: dates.length,
      lastSessionDate: dates.at(-1) || null,
      daysSinceLast: dates.length ? dayNumber(today) - dayNumber(dates.at(-1)) : null,
      sessionsLast28Days: since(28),
      recentExerciseIds: Object.entries(count).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([id]) => id),
    },
    bodyWeightKg: weights.length ? { first: weights[0].w, last: weights.at(-1).w, entries: weights.length } : null,
  };
  const latest = link?.scopes?.includes('assessments') ? assessments[0] : null;
  if (latest) {
    facts.assessment = {
      assessedAt: latest.assessedAt || null,
      weightKg: Number.isFinite(latest.weightKg) ? latest.weightKg : null,
      heightCm: Number.isFinite(latest.heightCm) ? latest.heightCm : null,
      bodyFatPercent: Number.isFinite(latest.results?.bodyFatPercent) ? latest.results.bodyFatPercent : null,
    };
  }
  return facts;
}

/** Which of the athlete's facts say something the coach did not already tick. */
export function inferredHints(facts) {
  const hints = { level: null, daysPerWeek: null, objective: null, restrictions: [] };
  const exp = (facts.experience || '').toLowerCase();
  if (/inici|begin|novat|nunca|zero/.test(exp)) hints.level = 'iniciante';
  else if (/avan|advanc|expert/.test(exp)) hints.level = 'avancado';
  else if (/inter/.test(exp)) hints.level = 'intermediario';
  else if (facts.history.totalSessions >= 80) hints.level = 'intermediario';
  else if (facts.history.totalSessions > 0 && facts.history.totalSessions < 12) hints.level = 'iniciante';
  const goal = (facts.goal || '').toLowerCase();
  if (/emagre|perder|queim|defin|fat|weight loss|cut/.test(goal)) hints.objective = 'emagrecimento';
  else if (/for[cç]a|strength/.test(goal)) hints.objective = 'forca';
  else if (/hipert|massa|ganho|muscle|bulk/.test(goal)) hints.objective = 'hipertrofia';
  else if (/condic|resist|cardio|endur/.test(goal)) hints.objective = 'condicionamento';
  hints.daysPerWeek = facts.daysPerWeek;
  const lim = (facts.limitations || '').toLowerCase();
  if (/joelho|knee|menisc|patel/.test(lim)) hints.restrictions.push('joelho');
  if (/ombro|shoulder|manguito/.test(lim)) hints.restrictions.push('ombro');
  if (/lombar|coluna|h[ée]rnia|back|disco/.test(lim)) hints.restrictions.push('lombar');
  return hints;
}

/** Final parameters = what the coach chose, completed from what the athlete told us. */
export function resolveRequest(request, facts) {
  const hints = inferredHints(facts);
  const restrictions = [...new Set([...request.restrictions, ...hints.restrictions])];
  const daysPerWeek = request.daysPerWeek || hints.daysPerWeek || 3;
  const split = request.split !== 'auto' ? request.split : daysPerWeek >= 5 ? 'ppl' : daysPerWeek === 4 ? 'upper_lower' : daysPerWeek <= 2 ? 'full_body' : 'ppl';
  return {
    objective: request.objective || hints.objective || 'hipertrofia',
    level: request.level || hints.level || 'intermediario',
    split, daysPerWeek, restrictions,
    sources: {
      objective: request.objective ? 'coach' : hints.objective ? 'athlete' : 'default',
      level: request.level ? 'coach' : hints.level ? 'athlete' : 'default',
      daysPerWeek: request.daysPerWeek ? 'coach' : hints.daysPerWeek ? 'athlete' : 'default',
      restrictions: hints.restrictions.length ? (request.restrictions.length ? 'coach+athlete' : 'athlete') : request.restrictions.length ? 'coach' : 'none',
    },
  };
}

const allowedFor = restrictions => AI_CATALOGUE.filter(item => !restrictions.some(r => item[RESTRICTION_FLAG[r]]));

export function buildMessages({ resolved, facts, note }) {
  const allowed = allowedFor(resolved.restrictions);
  const catalogue = allowed.map(item => `${item.id}|${item.name}|${item.muscle}|${item.equipment}|${item.compound ? 'composto' : 'isolado'}`).join('\n');
  const system = [
    'Você é um preparador físico experiente que monta fichas de musculação para um treinador revisar.',
    'Use SOMENTE exercícios da lista fornecida, citando o id exato. Nunca invente exercício.',
    'Adapte volume, intensidade, descanso e escolha de exercícios aos dados reais do aluno. Respeite o equipamento disponível quando informado.',
    'Aluno iniciante: menos exercícios por sessão e execuções simples. Se o aluno está parado há muito tempo, comece mais leve.',
    'Cada divisão deve cobrir grupos musculares coerentes com a divisão pedida, sem repetir exercício na mesma divisão.',
    'Seja BREVE: sem texto fora do JSON, sem observação por exercício.',
    'Responda APENAS com JSON compacto: {"name":string,"rationale":string,"divisions":[{"name":string,"ex":[[id,sets,reps,restSeconds],...]}]}.',
    'Exemplo de linha de exercício: ["0289",3,"8-12",60]. id é string; sets e restSeconds são inteiros; reps é string.',
    '"rationale" explica em no máximo 2 frases curtas, em português, por que a ficha serve para ESTE aluno (cite os dados usados).',
  ].join('\n');
  const user = [
    'DADOS DO ALUNO (reais; campos ausentes = desconhecidos, não suponha):',
    JSON.stringify(facts),
    '',
    'PEDIDO:',
    JSON.stringify({ objetivo: resolved.objective, nivel: resolved.level, divisao: resolved.split, diasPorSemana: resolved.daysPerWeek, restricoes: resolved.restrictions, observacaoDoTreinador: note || null }),
    '',
    'EXERCÍCIOS PERMITIDOS (id|nome|músculo|equipamento|tipo):',
    catalogue,
  ].join('\n');
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

const SPLIT_COUNT = { ppl: 3, upper_lower: 2, full_body: 1 };
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** Parse + validate a model answer. Returns { ok:true, routine, dropped } or { ok:false, reason }. */
export function validateAnswer(text, resolved, limits = AI_WORKOUT_DEFAULTS) {
  let data;
  const raw = typeof text === 'string' ? text.trim() : '';
  const body = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { data = JSON.parse(body); } catch {
    const m = /\{[\s\S]*\}/.exec(body);
    try { data = m ? JSON.parse(m[0]) : null; } catch { data = null; }
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.divisions) || !data.divisions.length) return { ok: false, reason: 'not_json' };
  const blocked = new Set(resolved.restrictions.map(r => RESTRICTION_FLAG[r]));
  let dropped = 0;
  const divisions = [];
  for (const division of data.divisions.slice(0, limits.maxDivisions)) {
    const list = division && (Array.isArray(division.ex) ? division.ex : division.exercises);
    if (!Array.isArray(list)) continue;
    const seen = new Set();
    const exercises = [];
    for (const raw of list) {
      // Compact rows [id, sets, reps, rest] (what the prompt asks for); the object form is still accepted.
      const entry = Array.isArray(raw) ? { id: raw[0], sets: raw[1], reps: raw[2], restSeconds: raw[3] } : raw;
      const id = String(entry?.id ?? '');
      const known = BY_ID.get(id);
      if (!known || seen.has(id) || [...blocked].some(flag => known[flag])) { dropped++; continue; }
      seen.add(id);
      const reps = typeof entry.reps === 'string' || Number.isFinite(entry.reps) ? clip(String(entry.reps), 20) : '';
      exercises.push({
        catalogueId: id,
        id,
        name: known.name,
        sets: clamp(Number.isFinite(+entry.sets) ? Math.round(+entry.sets) : 3, 1, 8),
        reps: /\d/.test(reps) ? reps : '8-12',
        load: '',
        restSeconds: clamp(Number.isFinite(+entry.restSeconds) ? Math.round(+entry.restSeconds) : 60, 15, 300),
        notes: clip(entry.notes, 240),
        targetMuscle: known.muscle,
        equipment: known.equipment,
      });
      if (exercises.length >= limits.maxPerDivision) break;
    }
    if (exercises.length >= 2) divisions.push({ name: clip(division.name, 70) || `Treino ${String.fromCharCode(65 + divisions.length)}`, exercises });
  }
  const wanted = SPLIT_COUNT[resolved.split] || 1;
  if (!divisions.length) return { ok: false, reason: 'no_valid_exercises' };
  if (divisions.length < Math.min(wanted, 2) && wanted > 1) return { ok: false, reason: 'too_few_divisions' };
  return {
    ok: true,
    dropped,
    routine: {
      name: clip(data.name, 100) || `Treino ${resolved.objective}`,
      notes: clip(data.notes, 600),
      rationale: clip(data.rationale, 600),
      divisions,
    },
  };
}

function config(env = process.env) {
  const base = clip(env.AI_WORKOUT_BASE_URL || '', 300).replace(/\/+$/, '');
  const key = env.AI_WORKOUT_API_KEY || '';
  if (!/^https?:\/\//.test(base) || !key) return null;
  return { base, key, model: clip(env.AI_WORKOUT_MODEL || '', 80) || AI_WORKOUT_DEFAULTS.model, timeoutMs: clamp(+env.AI_WORKOUT_TIMEOUT_MS || AI_WORKOUT_DEFAULTS.timeoutMs, 3000, 60000) };
}

/** One bounded call. Never throws: returns { ok, text } or { ok:false, reason }. */
export async function callGateway({ cfg, messages, fetchImpl = fetch }) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), cfg.timeoutMs);
  try {
    const res = await fetchImpl(cfg.base + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + cfg.key },
      body: JSON.stringify({ model: cfg.model, messages, max_tokens: 2500, response_format: { type: 'json_object' } }),
      signal: ctl.signal,
    });
    if (!res.ok) return { ok: false, reason: res.status === 401 || res.status === 403 ? 'gateway_auth' : res.status === 429 ? 'gateway_busy' : 'gateway_error' };
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    return typeof text === 'string' && text ? { ok: true, text, model: typeof data.model === 'string' ? data.model : cfg.model } : { ok: false, reason: 'empty' };
  } catch (error) {
    return { ok: false, reason: ctl.signal.aborted ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

/** Core, injectable for tests. */
export async function buildAiWorkout({ request, state, link, assessments, todayIso, env = process.env, fetchImpl = fetch }) {
  const facts = collectAthleteFacts({ state, link, assessments, todayIso });
  const resolved = resolveRequest(normaliseRequest(request), facts);
  const base = { resolved: { objective: resolved.objective, level: resolved.level, split: resolved.split, daysPerWeek: resolved.daysPerWeek, restrictions: resolved.restrictions, sources: resolved.sources }, facts: summarise(facts) };
  const cfg = config(env);
  if (!cfg) return { ...base, source: 'rules', fallbackReason: 'ai_not_configured' };
  const called = await callGateway({ cfg, messages: buildMessages({ resolved, facts, note: normaliseRequest(request).note }), fetchImpl });
  if (!called.ok) return { ...base, source: 'rules', fallbackReason: called.reason };
  const checked = validateAnswer(called.text, resolved);
  if (!checked.ok) return { ...base, source: 'rules', fallbackReason: checked.reason };
  return { ...base, source: 'ai', model: called.model, droppedExercises: checked.dropped, routine: checked.routine };
}

/** What the coach sees about the athlete (a subset of what went to the model). */
function summarise(facts) {
  return {
    goal: facts.goal, experience: facts.experience, daysPerWeek: facts.daysPerWeek, sessionMin: facts.sessionMin,
    limitations: facts.limitations, equipment: facts.equipment,
    totalSessions: facts.history.totalSessions, sessionsLast28Days: facts.history.sessionsLast28Days, daysSinceLast: facts.history.daysSinceLast,
    hasIntake: !!(facts.goal || facts.experience || facts.daysPerWeek || facts.limitations),
    hasAssessment: !!facts.assessment,
  };
}

export function createAiWorkoutRoutes(context) {
  const {
    b2bError, db, json, profileOf, readBody, readSession, authorizeAthleteAccess, audit, limitAddress,
    readAthleteState, userNow, listAssessments, env = process.env, fetchImpl = fetch, rate = {},
  } = context;
  const windowMs = rate.windowMs ?? 3600000;
  const hits = new Map();
  const take = (key, max) => {
    const now = Date.now();
    const list = (hits.get(key) || []).filter(t => now - t < windowMs);
    if (list.length >= max) { hits.set(key, list); return Math.ceil((windowMs - (now - list[0])) / 1000); }
    list.push(now); hits.set(key, list);
    return 0;
  };
  return {
    'POST /api/coach/athletes/{athleteId}/ai-workout': async (req, res) => {
      const coach = readSession(req);
      if (!coach) return b2bError(res, 401, 'not_signed_in', 'not signed in');
      if (profileOf(coach).kind !== 'coach') return b2bError(res, 403, 'role_forbidden', 'professional profile required');
      if (!ID_RE.test(String(req.athleteId || ''))) return b2bError(res, 400, 'invalid_athlete_id', 'invalid athlete id');
      const access = authorizeAthleteAccess(db, coach, req.athleteId, 'athlete:training:write');
      if (!access.ok) return b2bError(res, access.code === 'relationship_not_found' ? 404 : 403, access.code, 'active training relationship required');
      const wait = Math.max(take('c:' + coach.id, rate.accountMax ?? 30), take('i:' + limitAddress(req), rate.ipMax ?? 120));
      if (wait) return b2bError(res, 429, 'rate_limited', 'too many AI workout requests', { 'Retry-After': String(wait) });
      let body = {};
      try { body = await readBody(req); } catch { return b2bError(res, 400, 'invalid_body', 'invalid request body'); }
      const state = readAthleteState(req.athleteId) || {};
      const todayIso = userNow(state.reminder?.tz || 'UTC')?.date;
      const assessments = access.link?.scopes?.includes('assessments') ? listAssessments(coach.id, req.athleteId) : [];
      const started = Date.now();
      const result = await buildAiWorkout({ request: body, state, link: access.link, assessments, todayIso, env, fetchImpl });
      audit?.(req, 'b2b2c.ai_workout.' + result.source, { user: coach, target: db.users.find(u => u.id === req.athleteId), msg: `${result.fallbackReason || 'ok'} ${Date.now() - started}ms` });
      return json(res, 200, result);
    },
  };
}
