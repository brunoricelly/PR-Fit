import crypto from 'node:crypto';
import { LIBRARY, LIB_BY_ID } from './coach/core/library.js';
import { highestStamp, stampEntry, stampPut } from './sync-stamps.js';

const NAME_KEY = value => String(value || '')
  .normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

const LIBRARY_NAME_IDS = (() => {
  const ids = new Map();
  const ambiguous = new Set();
  for (const exercise of LIBRARY) {
    const key = NAME_KEY(exercise.n);
    if (!key) continue;
    if (ids.has(key) && ids.get(key) !== exercise.id) ambiguous.add(key);
    else ids.set(key, exercise.id);
  }
  for (const key of ambiguous) ids.delete(key);
  return ids;
})();

const record = value => !!value && typeof value === 'object' && !Array.isArray(value);
const list = value => (Array.isArray(value) ? value : []);
const roundLoad = value => Math.round(value * 1000) / 1000;
const hashId = (prefix, value) => `${prefix}_${crypto.createHash('sha256').update(value).digest('hex').slice(0, 12)}`;

function freeId(base, used) {
  if (!used.has(base)) { used.add(base); return base; }
  for (let suffix = 2; ; suffix++) {
    const candidate = `${base}_${suffix}`;
    if (!used.has(candidate)) { used.add(candidate); return candidate; }
  }
}

function repsConfig(value) {
  const text = String(value || '').trim();
  const range = /^(\d+)\s*[-–—]\s*(\d+)$/.exec(text);
  if (range) {
    const low = Number(range[1]), high = Number(range[2]);
    if (low > 0 && high >= low) return { config: { reps: high, repsMin: low }, fallback: '' };
  }
  if (/^\d+$/.test(text) && Number(text) > 0) return { config: { reps: Number(text) }, fallback: '' };
  const first = /\d+/.exec(text);
  return { config: { reps: first ? Math.max(1, Number(first[0])) : 1 }, fallback: text ? `Reps: ${text}` : '' };
}

function loadConfig(value, unit) {
  const text = String(value || '').trim();
  if (!text) return { weight: 0, fallback: '' };
  const match = /^([0-9]+(?:[.,][0-9]+)?)\s*(kg|kgs?|lb|lbs?)?$/i.exec(text);
  if (!match) return { weight: 0, fallback: `Load: ${text}` };
  let weight = Number(match[1].replace(',', '.'));
  const source = /^lb/i.test(match[2] || '') ? 'lb' : /^kg/i.test(match[2] || '') ? 'kg' : unit;
  if (source !== unit) weight = source === 'kg' ? weight / 0.45359237 : weight * 0.45359237;
  return { weight: roundLoad(weight), fallback: '' };
}

function exerciseNote(exercise, fallbacks) {
  return [String(exercise.notes || '').trim(), ...fallbacks.filter(Boolean)].filter(Boolean).join('\n').slice(0, 500);
}

function resolveExerciseId(state, prescription, division, exercise, customByName, usedExerciseIds, stamp) {
  if (exercise.catalogueId && LIB_BY_ID.has(exercise.catalogueId)) return exercise.catalogueId;
  const catalogueId = LIBRARY_NAME_IDS.get(NAME_KEY(exercise.name));
  if (catalogueId) return catalogueId;

  const key = NAME_KEY(exercise.name);
  const same = customByName.get(key);
  if (same && same.length === 1) return same[0].id;

  const id = freeId(hashId('cprx', `${prescription.id}\0${division.id}\0${exercise.id}`), usedExerciseIds);
  const custom = {
    id, n: exercise.name, bp: 'full body', eq: 'custom', tg: '', desc: '', custom: true,
    prescriptionId: prescription.id,
  };
  stampEntry(null, custom, stamp);
  state.customEx.push(custom);
  const entries = customByName.get(key) || [];
  entries.push(custom);
  customByName.set(key, entries);
  return id;
}

function routineEntry(state, prescription, division, stamp, usedExerciseIds, customByName) {
  const unit = state.unit === 'lb' ? 'lb' : 'kg';
  const exercises = division.exercises.map(exercise => {
    const id = resolveExerciseId(state, prescription, division, exercise, customByName, usedExerciseIds, stamp);
    const reps = repsConfig(exercise.reps);
    const load = loadConfig(exercise.load, unit);
    const catalogue = LIB_BY_ID.get(id);
    const note = exerciseNote(exercise, [reps.fallback, load.fallback]);
    return {
      id, sets: exercise.sets, ...reps.config, weight: load.weight, mode: 'reps',
      ...(catalogue?.eq === 'body weight' ? { bodyweight: true } : {}),
      ...(exercise.restSeconds > 0 ? { restSec: exercise.restSeconds } : { restSec: 0, restOff: true }),
      ...(note ? { note } : {}),
    };
  });
  const routine = {
    id: '', name: division.name, ex: exercises,
    prescriptionId: prescription.id, prescriptionDivisionId: division.id,
    ...(prescription.routine.notes ? { note: prescription.routine.notes.slice(0, 1000) } : {}),
  };
  stampEntry(null, routine, stamp);
  return routine;
}

export function prescriptionStateReadable(state) {
  if (state == null) return true;
  if (!record(state)) return false;
  return ['routines', 'customEx', 'workouts'].every(key => state[key] == null || Array.isArray(state[key]));
}

export function adoptPrescriptionState(current, prescription, { now = Date.now() } = {}) {
  const original = current || null;
  const existingRoutines = list(original?.routines);
  const byDivision = new Map(existingRoutines
    .filter(routine => routine?.prescriptionId === prescription.id && routine.prescriptionDivisionId)
    .map(routine => [routine.prescriptionDivisionId, routine]));
  const complete = prescription.routine.divisions.every(division => byDivision.has(division.id));
  if (complete) {
    return {
      changed: false,
      state: original,
      routineIds: prescription.routine.divisions.map(division => byDivision.get(division.id).id),
    };
  }

  const state = original ? structuredClone(original) : { workouts: [], routines: [], customEx: [] };
  state.routines = list(state.routines);
  state.customEx = list(state.customEx);
  if (!Array.isArray(state.workouts)) state.workouts = [];

  const stamp = Math.max(Number(now) || 0, highestStamp(original) + 1);
  const usedRoutineIds = new Set(state.routines.map(routine => routine?.id).filter(Boolean));
  const usedExerciseIds = new Set([...LIB_BY_ID.keys(), ...state.customEx.map(exercise => exercise?.id).filter(Boolean)]);
  const customByName = new Map();
  for (const exercise of state.customEx) {
    if (!exercise?.id) continue;
    const key = NAME_KEY(exercise.n);
    const entries = customByName.get(key) || [];
    entries.push(exercise);
    customByName.set(key, entries);
  }

  const routineIds = [];
  for (const division of prescription.routine.divisions) {
    const existing = byDivision.get(division.id);
    if (existing) { routineIds.push(existing.id); continue; }
    const routine = routineEntry(state, prescription, division, stamp, usedExerciseIds, customByName);
    routine.id = freeId(hashId('cprr', `${prescription.id}\0${division.id}`), usedRoutineIds);
    state.routines.push(routine);
    routineIds.push(routine.id);
  }

  state._ts = stamp;
  stampPut(original, state, { stamped: true, now: stamp });
  const currentRev = Number(original?._rev) || 0;
  state._rev = currentRev + 1;
  state._wids = [...list(original?._wids), ...(original?._wid ? [original._wid] : [])]
    .filter(value => typeof value === 'string').slice(-50);
  state._wid = crypto.randomBytes(8).toString('hex');
  return { changed: true, state, routineIds };
}
