/* AI workout builder for coaches.
 *
 *   POST /api/coach/athletes/{athleteId}/ai-workout
 *
 * Reads what the platform knows about the linked athlete locally and asks an OpenAI-compatible
 * gateway (the omniroute) for a routine made ONLY of catalogue ids, sets, reps and rest.
 *
 * Privacy / safety contract (all enforced in code, covered by test/server-ai-workout.test.js):
 *  - The outbound payload is a CLOSED allowlist (buildOutboundPayload + assertClosedPayload): canonical
 *    objective/level/split, bounded days and session length, canonical equipment, aggregate training
 *    history counts, limits and the catalogue lines that survived LOCAL filtering. No names/ids, no
 *    free text (coach note, athlete goal/experience/limitations), no body weight, no assessments, no
 *    restriction labels. Injury signals only filter the catalogue locally.
 *  - The answer is parsed strictly (validateAnswer): exact division count, ids must be in the allowed
 *    list, repetition-free, level/objective-safe sets/reps/rest. Anything out of bounds REJECTS the
 *    whole answer (source 'rules'); nothing is clamped. Model free text is never forwarded: name,
 *    rationale and division names are generated locally.
 *  - Constraints we cannot map to a catalogue flag (unrecognised athlete limitation) set manualReview
 *    and rulesBlocked with an empty allowedExerciseIds, and the gateway is not called. A coach note is
 *    never sent: it sets manualReview only.
 *  - Every response carries allowedExerciseIds (authoritative catalogue ids safe for this athlete) so the
 *    client can restrict the rule-based preview identically on success and on fallback.
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
const CATALOGUE_EQUIPMENT = ['Barra', 'Halteres', 'Cabo', 'Máquina', 'Peso corporal'];
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const clip = (value, max) => (typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const plain = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

export const AI_WORKOUT_DEFAULTS = Object.freeze({ model: 'auto/smart', timeoutMs: 40000 });

const SPLIT_COUNT = Object.freeze({ ppl: 3, upper_lower: 2, full_body: 1 });
const DIVISION_NAMES = Object.freeze({
  ppl: ['Treino A - Empurrar', 'Treino B - Puxar', 'Treino C - Pernas'],
  upper_lower: ['Treino A - Superior', 'Treino B - Inferior'],
  full_body: ['Treino A - Corpo inteiro'],
});

// Safe prescription envelope. The model answer must sit INSIDE the intersection of the level and the
// objective bounds; outside it the whole answer is rejected, never clamped.
const LEVEL_LIMITS = Object.freeze({
  iniciante: { sets: [2, 3], exercises: [3, 6], rest: [30, 180], totalSets: 18, repsLo: 5 },
  intermediario: { sets: [2, 4], exercises: [4, 8], rest: [30, 180], totalSets: 24, repsLo: 3 },
  avancado: { sets: [2, 5], exercises: [4, 10], rest: [30, 240], totalSets: 30, repsLo: 1 },
});
const OBJECTIVE_LIMITS = Object.freeze({
  hipertrofia: { reps: [6, 15], rest: [45, 150] },
  emagrecimento: { reps: [10, 20], rest: [30, 90] },
  forca: { reps: [3, 8], rest: [90, 240] },
  condicionamento: { reps: [12, 25], rest: [20, 75] },
});

/** Numeric bounds for one resolved request (also what the model is told). */
export function limitsFor(resolved) {
  const lv = LEVEL_LIMITS[resolved.level] || LEVEL_LIMITS.intermediario;
  const ob = OBJECTIVE_LIMITS[resolved.objective] || OBJECTIVE_LIMITS.hipertrofia;
  const minutes = Number.isInteger(resolved.sessionMin) ? resolved.sessionMin : null;
  const maxEx = minutes ? Math.max(3, Math.min(lv.exercises[1], Math.floor(minutes / 8))) : lv.exercises[1];
  return {
    divisions: SPLIT_COUNT[resolved.split] || 1,
    exercises: [Math.min(lv.exercises[0], maxEx), maxEx],
    sets: lv.sets,
    reps: [Math.max(ob.reps[0], lv.repsLo), ob.reps[1]],
    rest: [Math.max(ob.rest[0], lv.rest[0]), Math.min(ob.rest[1], lv.rest[1])],
    totalSets: lv.totalSets,
  };
}

/** What the coach asked for, normalised. Unknown values fall back to a safe default. The free-text
 *  note is only used to flag manual review: it is never sent anywhere. */
export function normaliseRequest(body) {
  const b = body && typeof body === 'object' ? body : {};
  const restrictions = Array.isArray(b.restrictions) ? [...new Set(b.restrictions.filter(item => RESTRICTIONS.includes(item)))] : [];
  return {
    objective: OBJECTIVES.includes(b.objective) ? b.objective : null,
    level: LEVELS.includes(b.level) ? b.level : null,
    split: SPLITS.includes(b.split) ? b.split : 'auto',
    daysPerWeek: Number.isInteger(b.daysPerWeek) && b.daysPerWeek >= 1 && b.daysPerWeek <= 7 ? b.daysPerWeek : null,
    restrictions,
    hasNote: clip(b.note, 400).length > 0,
  };
}

const dayNumber = iso => Math.floor(Date.parse(iso + 'T00:00:00Z') / 86400000);
const ISO = /^\d{4}-\d{2}-\d{2}$/;

// Athlete equipment (free list from the app, English catalogue names or Portuguese) -> catalogue equipment.
const EQUIPMENT_ALIASES = Object.freeze({
  Barra: /^(barbell|ez barbell|olympic barbell|trap bar|barra|barra ez)$/,
  Halteres: /^(dumbbell|dumbbells|halter|halteres)$/,
  Cabo: /^(cable|cabo|cabos|polia)$/,
  'Máquina': /^(leverage machine|smith machine|sled machine|machine|maquina|maquinas)$/,
  'Peso corporal': /^(body weight|bodyweight|peso corporal)$/,
});
function canonicalEquipment(list) {
  const found = new Set(['Peso corporal']); // body weight is never taken away
  for (const raw of list) {
    const key = plain(raw).trim();
    for (const [label, re] of Object.entries(EQUIPMENT_ALIASES)) if (re.test(key)) found.add(label);
  }
  return CATALOGUE_EQUIPMENT.filter(label => found.has(label));
}

// Injury signals. These only ever filter the catalogue locally; the text and the labels stay here.
const JOINT_WORDS = Object.freeze({
  joelho: /^(joelh\w*|knee\w*|menisc\w*|patel\w*|cruzado|lca)$/,
  ombro: /^(ombr\w*|shoulder\w*|manguito|escapul\w*)$/,
  lombar: /^(lomb\w*|coluna|hernia|disco|back|ciatic\w*|lordose|escoliose)$/,
});
const FILLER_WORDS = new Set(['a', 'o', 'as', 'os', 'e', 'ou', 'de', 'do', 'da', 'dos', 'das', 'no', 'na', 'nos', 'nas', 'em', 'com', 'dor', 'dores', 'direito', 'direita', 'esquerdo', 'esquerda', 'ambos', 'ambas', 'leve', 'leves', 'lesao', 'lesoes', 'problema', 'problemas', 'tenho', 'minha', 'meu', 'sem', 'nenhum', 'nenhuma', 'nada', 'nao', 'tambem', 'the', 'my', 'pain', 'in', 'and', 'left', 'right', 'of']);

/** { restrictions, unrecognised }. Fail closed: any word that is neither a known joint nor filler
 *  (a condition, a drug, a surgery...) makes the limitation unrecognised and requires manual review. */
export function parseLimitations(value) {
  if (value === undefined || value === null || value === '') return { restrictions: [], unrecognised: false };
  if (typeof value !== 'string') return { restrictions: [], unrecognised: true };
  const restrictions = new Set();
  let unrecognised = value.length > 300;
  for (const word of plain(value).split(/[^a-z0-9]+/).filter(Boolean)) {
    const joint = Object.keys(JOINT_WORDS).find(name => JOINT_WORDS[name].test(word));
    if (joint) restrictions.add(joint);
    else if (!FILLER_WORDS.has(word)) unrecognised = true;
  }
  return { restrictions: RESTRICTIONS.filter(r => restrictions.has(r)), unrecognised };
}

/** Facts about the athlete, from data the coach is already allowed to see. LOCAL ONLY: facts are never
 *  sent to the gateway as such (see buildOutboundPayload). Absent fields stay absent. */
export function collectAthleteFacts({ state, link, assessments = [], todayIso }) {
  const S = state && typeof state === 'object' ? state : {};
  const intake = S.coach?.profile && typeof S.coach.profile === 'object' ? S.coach.profile : {};
  const workouts = (Array.isArray(S.workouts) ? S.workouts : []).filter(w => w && typeof w.d === 'string' && ISO.test(w.d));
  const dates = [...new Set(workouts.map(w => w.d))].sort();
  const today = ISO.test(todayIso || '') ? todayIso : new Date().toISOString().slice(0, 10);
  const since = n => dates.filter(d => dayNumber(today) - dayNumber(d) <= n).length;
  const weights = (Array.isArray(S.bodyweight) ? S.bodyweight : []).filter(item => item && Number.isFinite(item.w)).slice(-12);
  const equipmentList = Array.isArray(intake.equipment) ? intake.equipment.filter(e => typeof e === 'string').map(e => clip(e, 40)).filter(Boolean).slice(0, 20) : [];
  const limitations = typeof intake.limitations === 'string' ? clip(intake.limitations, 300) || null : null;
  const facts = {
    goal: clip(intake.goal, 60) || null,
    experience: clip(intake.experience, 60) || null,
    daysPerWeek: Number.isInteger(intake.daysPerWeek) && intake.daysPerWeek >= 1 && intake.daysPerWeek <= 7 ? intake.daysPerWeek : null,
    sessionMin: Number.isInteger(intake.sessionMin) && intake.sessionMin >= 10 && intake.sessionMin <= 180 ? intake.sessionMin : null,
    equipment: equipmentList,
    equipmentKnown: equipmentList.length > 0,
    equipmentCanonical: canonicalEquipment(equipmentList),
    limitations,
    limitationsParsed: parseLimitations(intake.limitations),
    history: {
      totalSessions: dates.length,
      lastSessionDate: dates.at(-1) || null,
      daysSinceLast: dates.length ? dayNumber(today) - dayNumber(dates.at(-1)) : null,
      sessionsLast28Days: since(28),
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
  const exp = plain(facts.experience);
  if (/inici|begin|novat|nunca|zero|\bnew\b/.test(exp)) hints.level = 'iniciante';
  else if (/avan|advanc|expert/.test(exp)) hints.level = 'avancado';
  else if (/inter/.test(exp)) hints.level = 'intermediario';
  else if (facts.history.totalSessions >= 80) hints.level = 'intermediario';
  else if (facts.history.totalSessions > 0 && facts.history.totalSessions < 12) hints.level = 'iniciante';
  const goal = plain(facts.goal);
  if (/emagre|perder|queim|defin|fat|weight loss|cut/.test(goal)) hints.objective = 'emagrecimento';
  else if (/forca|strength/.test(goal)) hints.objective = 'forca';
  else if (/hipert|massa|ganho|muscle|bulk/.test(goal)) hints.objective = 'hipertrofia';
  else if (/condic|resist|cardio|endur/.test(goal)) hints.objective = 'condicionamento';
  hints.daysPerWeek = facts.daysPerWeek;
  hints.restrictions = facts.limitationsParsed?.restrictions || [];
  return hints;
}

/** Final parameters = what the coach chose, completed from what the athlete told us. */
export function resolveRequest(request, facts) {
  const hints = inferredHints(facts);
  const restrictions = RESTRICTIONS.filter(r => request.restrictions.includes(r) || hints.restrictions.includes(r));
  const daysPerWeek = request.daysPerWeek || hints.daysPerWeek || 3;
  const split = request.split !== 'auto' ? request.split : daysPerWeek >= 5 ? 'ppl' : daysPerWeek === 4 ? 'upper_lower' : daysPerWeek <= 2 ? 'full_body' : 'ppl';
  return {
    objective: request.objective || hints.objective || 'hipertrofia',
    level: request.level || hints.level || 'intermediario',
    split, daysPerWeek, restrictions,
    sessionMin: facts.sessionMin,
    sources: {
      objective: request.objective ? 'coach' : hints.objective ? 'athlete' : 'default',
      level: request.level ? 'coach' : hints.level ? 'athlete' : 'default',
      daysPerWeek: request.daysPerWeek ? 'coach' : hints.daysPerWeek ? 'athlete' : 'default',
      restrictions: hints.restrictions.length ? (request.restrictions.length ? 'coach+athlete' : 'athlete') : request.restrictions.length ? 'coach' : 'none',
    },
  };
}

/** Catalogue ids that are safe for this athlete: joint flags and, when known, owned equipment. */
export function allowedExercisesFor(resolved, facts) {
  const owned = facts.equipmentKnown ? new Set(facts.equipmentCanonical) : null;
  return AI_CATALOGUE.filter(item => !resolved.restrictions.some(r => item[RESTRICTION_FLAG[r]]) && (!owned || owned.has(item.equipment)));
}

/** Constraints this module cannot translate into a catalogue filter. */
export function reviewFlags(request, facts) {
  const reasons = [];
  if (facts.limitationsParsed.unrecognised) reasons.push('limitation_unrecognised');
  if (request.hasNote) reasons.push('coach_note_not_sent');
  if (!facts.goal && !facts.experience && !facts.daysPerWeek && !facts.limitations && !facts.equipmentKnown) reasons.push('no_athlete_intake');
  return { manualReview: reasons.length > 0, manualReviewReasons: reasons, rulesBlocked: reasons.includes('limitation_unrecognised') };
}

// ---------------------------------------------------------------------------------------------
// Outbound payload: a closed allowlist. Nothing from the athlete or the coach enters the prompt
// except the canonical, bounded values below.
// ---------------------------------------------------------------------------------------------
const PAYLOAD_PARAM_KEYS = ['daysPerWeek', 'equipment', 'level', 'limits', 'objective', 'sessionMin', 'split'];
const PAYLOAD_LIMIT_KEYS = ['divisions', 'exercises', 'reps', 'rest', 'sets', 'totalSets'];
const PAYLOAD_HISTORY_KEYS = ['daysSinceLast', 'sessionsLast28Days', 'totalSessions'];
const sameKeys = (obj, keys) => obj && typeof obj === 'object' && !Array.isArray(obj) && JSON.stringify(Object.keys(obj).sort()) === JSON.stringify([...keys].sort());
const intIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const pairIn = (v, lo, hi) => Array.isArray(v) && v.length === 2 && intIn(v[0], lo, hi) && intIn(v[1], lo, hi) && v[0] <= v[1];

export function buildOutboundPayload({ resolved, facts, allowed }) {
  return {
    params: {
      objective: resolved.objective, level: resolved.level, split: resolved.split, daysPerWeek: resolved.daysPerWeek,
      sessionMin: Number.isInteger(resolved.sessionMin) ? resolved.sessionMin : null,
      equipment: facts.equipmentKnown ? [...facts.equipmentCanonical] : null,
      limits: limitsFor(resolved),
    },
    history: {
      totalSessions: Math.min(facts.history.totalSessions, 999),
      sessionsLast28Days: Math.min(facts.history.sessionsLast28Days, 28),
      daysSinceLast: facts.history.daysSinceLast === null ? null : clamp(facts.history.daysSinceLast, 0, 365),
    },
    exerciseIds: allowed.map(item => item.id),
  };
}

/** Throws unless the payload is exactly the allowlisted shape with in-range canonical values. */
export function assertClosedPayload(payload) {
  const fail = why => { throw new Error('ai_payload_not_closed:' + why); };
  if (!sameKeys(payload, ['exerciseIds', 'history', 'params'])) fail('root');
  const { params: p, history: h, exerciseIds } = payload;
  if (!sameKeys(p, PAYLOAD_PARAM_KEYS)) fail('params');
  if (!OBJECTIVES.includes(p.objective) || !LEVELS.includes(p.level) || !SPLIT_COUNT[p.split]) fail('enum');
  if (!intIn(p.daysPerWeek, 1, 7)) fail('days');
  if (p.sessionMin !== null && !intIn(p.sessionMin, 10, 180)) fail('sessionMin');
  if (p.equipment !== null && !(Array.isArray(p.equipment) && p.equipment.length <= CATALOGUE_EQUIPMENT.length && p.equipment.every(e => CATALOGUE_EQUIPMENT.includes(e)))) fail('equipment');
  const l = p.limits;
  if (!sameKeys(l, PAYLOAD_LIMIT_KEYS) || !intIn(l.divisions, 1, 3) || !pairIn(l.exercises, 1, 12) || !pairIn(l.sets, 1, 8) || !pairIn(l.reps, 1, 30) || !pairIn(l.rest, 10, 300) || !intIn(l.totalSets, 1, 60)) fail('limits');
  if (!sameKeys(h, PAYLOAD_HISTORY_KEYS) || !intIn(h.totalSessions, 0, 999) || !intIn(h.sessionsLast28Days, 0, 28) || !(h.daysSinceLast === null || intIn(h.daysSinceLast, 0, 365))) fail('history');
  if (!Array.isArray(exerciseIds) || !exerciseIds.length || exerciseIds.some(id => typeof id !== 'string' || !BY_ID.has(id)) || new Set(exerciseIds).size !== exerciseIds.length) fail('exerciseIds');
  return payload;
}

const SYSTEM_PROMPT = [
  'Você é um preparador físico que monta fichas de musculação para um treinador revisar.',
  'Use SOMENTE exercícios da lista fornecida, citando o id exato. Nunca invente exercício.',
  'Respeite exatamente o número de divisões, as faixas de exercícios, séries, repetições e descanso do pedido.',
  'Cada divisão deve cobrir grupos musculares coerentes com a divisão pedida, sem repetir exercício na mesma divisão.',
  'Seja BREVE: sem texto fora do JSON, sem comentários por exercício.',
  'Responda APENAS com JSON compacto: {"divisions":[{"ex":[[id,sets,reps,restSeconds],...]}]}.',
  'Exemplo de linha de exercício: ["0289",3,"8-12",60]. id é string; sets e restSeconds são inteiros; reps é string no formato "8-12" ou "10".',
].join('\n');

export function buildMessages(payload) {
  assertClosedPayload(payload);
  const catalogue = payload.exerciseIds.map(id => { const x = BY_ID.get(id); return `${x.id}|${x.name}|${x.muscle}|${x.equipment}|${x.compound ? 'composto' : 'isolado'}`; }).join('\n');
  const user = [
    'PEDIDO (valores canônicos):',
    JSON.stringify({ params: payload.params, history: payload.history }),
    '',
    'EXERCÍCIOS PERMITIDOS (id|nome|músculo|equipamento|tipo):',
    catalogue,
  ].join('\n');
  return [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: user }];
}

const REPS_RE = /^(\d{1,2})(?:-(\d{1,2}))?$/;

/** Parse + validate a model answer against the resolved request and the allowed catalogue slice.
 *  Strict: any unknown/disallowed/duplicate exercise or out-of-envelope prescription rejects the whole
 *  answer ({ ok:false, reason }). Model free text (name, rationale, notes, division names) is ignored and
 *  replaced by locally generated text. */
export function validateAnswer(text, resolved, allowedIds) {
  const raw = typeof text === 'string' ? text.trim() : '';
  const body = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let data;
  try { data = JSON.parse(body); } catch { return { ok: false, reason: 'not_json' }; }
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.divisions)) return { ok: false, reason: 'not_json' };
  const allowed = new Set(allowedIds || allowedExercisesFor(resolved, { equipmentKnown: false }).map(x => x.id));
  const lim = limitsFor(resolved);
  if (data.divisions.length < lim.divisions) return { ok: false, reason: 'too_few_divisions' };
  if (data.divisions.length > lim.divisions) return { ok: false, reason: 'wrong_division_count' };
  const names = DIVISION_NAMES[resolved.split] || DIVISION_NAMES.full_body;
  const divisions = [];
  let totalSets = 0;
  for (const [index, division] of data.divisions.entries()) {
    const list = division && typeof division === 'object' ? (Array.isArray(division.ex) ? division.ex : division.exercises) : null;
    if (!Array.isArray(list)) return { ok: false, reason: 'invalid_shape' };
    if (list.length < lim.exercises[0]) return { ok: false, reason: 'too_few_exercises' };
    if (list.length > lim.exercises[1]) return { ok: false, reason: 'too_many_exercises' };
    const seen = new Set();
    const exercises = [];
    for (const row of list) {
      let entry;
      if (Array.isArray(row)) entry = row.length === 4 ? { id: row[0], sets: row[1], reps: row[2], restSeconds: row[3] } : null;
      else entry = row && typeof row === 'object' ? row : null;
      if (!entry || typeof entry.id !== 'string') return { ok: false, reason: 'invalid_shape' };
      const known = BY_ID.get(entry.id);
      if (!known || !allowed.has(entry.id)) return { ok: false, reason: 'invalid_exercise' };
      if (seen.has(entry.id)) return { ok: false, reason: 'duplicate_exercise' };
      seen.add(entry.id);
      if (!intIn(entry.sets, lim.sets[0], lim.sets[1]) || !intIn(entry.restSeconds, lim.rest[0], lim.rest[1])) return { ok: false, reason: 'invalid_prescription' };
      const m = typeof entry.reps === 'string' ? REPS_RE.exec(entry.reps.trim()) : null;
      const lo = m ? +m[1] : NaN; const hi = m ? +(m[2] ?? m[1]) : NaN;
      if (!m || lo > hi || lo < lim.reps[0] || hi > lim.reps[1]) return { ok: false, reason: 'invalid_prescription' };
      totalSets += entry.sets;
      exercises.push({
        catalogueId: known.id, id: known.id, name: known.name, sets: entry.sets, reps: entry.reps.trim(), load: '',
        restSeconds: entry.restSeconds, notes: '', targetMuscle: known.muscle, equipment: known.equipment,
      });
    }
    divisions.push({ name: names[index] || `Treino ${String.fromCharCode(65 + index)}`, exercises });
  }
  if (totalSets > lim.totalSets * lim.divisions) return { ok: false, reason: 'too_many_sets' };
  if (divisions.some(d => d.exercises.reduce((n, e) => n + e.sets, 0) > lim.totalSets)) return { ok: false, reason: 'too_many_sets' };
  return {
    ok: true,
    dropped: 0,
    routine: {
      name: `Ficha ${resolved.objective} (${resolved.split})`,
      notes: '',
      rationale: `Ficha de ${resolved.objective}, nível ${resolved.level}, ${resolved.daysPerWeek}x por semana, montada só com exercícios do catálogo compatíveis com os dados do aluno. Revise antes de aplicar.`,
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
    // The reported model is configuration, not gateway text.
    return typeof text === 'string' && text ? { ok: true, text, model: cfg.model } : { ok: false, reason: 'empty' };
  } catch (error) {
    return { ok: false, reason: ctl.signal.aborted ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

/** Core, injectable for tests. */
export async function buildAiWorkout({ request, state, link, assessments, todayIso, env = process.env, fetchImpl = fetch }) {
  const facts = collectAthleteFacts({ state, link, assessments, todayIso });
  const normalised = normaliseRequest(request);
  const resolved = resolveRequest(normalised, facts);
  const review = reviewFlags(normalised, facts);
  const lim = limitsFor(resolved);
  let allowed = review.rulesBlocked ? [] : allowedExercisesFor(resolved, facts);
  if (!review.rulesBlocked && allowed.length < lim.exercises[0] * lim.divisions) {
    // Too few safe exercises left (restrictions + owned equipment) to fill the split: neither path can build a routine.
    review.manualReview = true; review.rulesBlocked = true; review.manualReviewReasons.push('insufficient_safe_exercises'); allowed = [];
  }
  const base = {
    resolved: { objective: resolved.objective, level: resolved.level, split: resolved.split, daysPerWeek: resolved.daysPerWeek, restrictions: resolved.restrictions, sources: resolved.sources },
    facts: summarise(facts),
    allowedExerciseIds: allowed.map(item => item.id),
    manualReview: review.manualReview,
    manualReviewReasons: review.manualReviewReasons,
    rulesBlocked: review.rulesBlocked,
  };
  if (review.rulesBlocked) return { ...base, source: 'rules', fallbackReason: 'manual_review_required' };
  const cfg = config(env);
  if (!cfg) return { ...base, source: 'rules', fallbackReason: 'ai_not_configured' };
  let messages;
  try { messages = buildMessages(buildOutboundPayload({ resolved, facts, allowed })); } catch { return { ...base, source: 'rules', fallbackReason: 'payload_rejected' }; }
  const called = await callGateway({ cfg, messages, fetchImpl });
  if (!called.ok) return { ...base, source: 'rules', fallbackReason: called.reason };
  const checked = validateAnswer(called.text, resolved, base.allowedExerciseIds);
  if (!checked.ok) return { ...base, source: 'rules', fallbackReason: checked.reason };
  return { ...base, source: 'ai', model: called.model, droppedExercises: 0, routine: checked.routine };
}

/** What the coach sees about the athlete (local only; none of it goes to the gateway). */
function summarise(facts) {
  return {
    goal: facts.goal, experience: facts.experience, daysPerWeek: facts.daysPerWeek, sessionMin: facts.sessionMin,
    limitations: facts.limitations, equipment: facts.equipment, equipmentKnown: facts.equipmentKnown,
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
