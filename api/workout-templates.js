// Coach workout template library + bulk assignment.
//
// A template is a coach-owned, reusable `routine` (the same shape validatePrescriptionRoutine
// normalises). Assigning one to an athlete writes an ordinary coachPrescriptions row that carries
// its own deep copy of the routine plus `templateId`, so:
//   * prior assignments are immutable snapshots: editing or deleting the template never touches
//     them, and the athlete flow (list / adopt / withdraw) is the existing prescription flow;
//   * the "one live assignment per template and athlete" rule is a query over coachPrescriptions
//     (state !== 'withdrawn'), evaluated inside the same serialized db transaction that writes.
import crypto from 'node:crypto';
import { createWindow } from './rate-limit.js';

const ID_RE = /^[A-Za-z0-9_-]{1,120}$/;
const TEMPLATE_KEYS = new Set(['id', 'coachId', 'routine', 'createdAt', 'updatedAt']);
const MAX_ASSIGN_TARGETS = 50;
const record = value => !!value && typeof value === 'object' && !Array.isArray(value);
const date = value => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  && Number.isFinite(Date.parse(value));

export const WORKOUT_TEMPLATE_LIMITS = Object.freeze({ maxWorkoutTemplates: 5000, maxWorkoutTemplatesPerCoach: 100, maxWorkoutTemplateAssignTargets: MAX_ASSIGN_TARGETS });

/**
 * Throws on any structural problem. `validateRoutine` is validatePrescriptionRoutine (injected: it
 * lives in b2b2c.js, which imports this file). A stored routine must be exactly what that function
 * would produce from it, so a hand-edited db.json cannot smuggle a shape the routes would refuse.
 */
export function validateWorkoutTemplatesState(db, limits = WORKOUT_TEMPLATE_LIMITS, validateRoutine = null) {
  if (!Array.isArray(db.workoutTemplates)) throw new Error('workoutTemplates must be an array');
  const maxTotal = limits.maxWorkoutTemplates ?? WORKOUT_TEMPLATE_LIMITS.maxWorkoutTemplates;
  const maxPerCoach = limits.maxWorkoutTemplatesPerCoach ?? WORKOUT_TEMPLATE_LIMITS.maxWorkoutTemplatesPerCoach;
  if (db.workoutTemplates.length > maxTotal) throw new Error('workout template quota exceeded');
  const users = new Set((db.users || []).map(user => user.id));
  const ids = new Set(), perCoach = new Map();
  for (const row of db.workoutTemplates) {
    if (!record(row) || !Object.keys(row).every(key => TEMPLATE_KEYS.has(key)) || Object.keys(row).length !== TEMPLATE_KEYS.size
        || typeof row.id !== 'string' || !ID_RE.test(row.id) || ids.has(row.id)
        || typeof row.coachId !== 'string' || !users.has(row.coachId)
        || !date(row.createdAt) || !date(row.updatedAt)) throw new Error('workoutTemplates contains invalid data');
    if (validateRoutine) {
      // A stored routine is already normalised (it carries generated division/exercise ids, which the
      // input validator refuses). Strip those, re-run the input validator, and the result must be
      // identical: the ids must be exactly the deterministic positional ones.
      const normalized = record(row.routine) ? validateRoutine({ routine: withoutIds(row.routine) }) : null;
      if (!normalized || !isEqualJson(normalized, row.routine)) throw new Error('workoutTemplates contains invalid data');
    } else if (!record(row.routine)) throw new Error('workoutTemplates contains invalid data');
    ids.add(row.id);
    perCoach.set(row.coachId, (perCoach.get(row.coachId) || 0) + 1);
  }
  if ([...perCoach.values()].some(count => count > maxPerCoach)) throw new Error('coach workout template quota exceeded');
  // One live (non-withdrawn) assignment per template and athlete.
  const live = new Set();
  for (const item of db.coachPrescriptions || []) {
    if (item.templateId === undefined) continue;
    if (typeof item.templateId !== 'string' || !ID_RE.test(item.templateId)) throw new Error('coachPrescriptions contains an invalid templateId');
    if (item.state === 'withdrawn') continue;
    const key = `${item.coachId}\0${item.templateId}\0${item.athleteId}`;
    if (live.has(key)) throw new Error('duplicate live workout template assignment');
    live.add(key);
  }
  return true;
}

const withoutIds = routine => ({
  ...routine,
  divisions: Array.isArray(routine.divisions) ? routine.divisions.map(division => record(division) ? {
    name: division.name,
    ...(Array.isArray(division.exercises) ? { exercises: division.exercises.map(exercise => { if (!record(exercise)) return exercise; const { id, ...rest } = exercise; return rest; }) } : {}),
    ...Object.fromEntries(Object.entries(division).filter(([key]) => !['id', 'name', 'exercises'].includes(key))),
  } : division) : routine.divisions,
});
const isEqualJson = (a, b) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
const sortKeys = value => Array.isArray(value) ? value.map(sortKeys)
  : record(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])])) : value;

export function compactWorkoutTemplatesState(db, limits, _nowMs, validateRoutine) {
  db.workoutTemplates ||= [];
  validateWorkoutTemplatesState(db, limits, validateRoutine);
  return { changed: false };
}

export function removeWorkoutTemplatesUser(db, userId) {
  db.workoutTemplates = (db.workoutTemplates || []).filter(row => row.coachId !== userId);
}

const publicTemplate = row => ({ id: row.id, routine: structuredClone(row.routine), createdAt: row.createdAt, updatedAt: row.updatedAt });
const failure = (status, code, message, headers) => ({ status, code, message, headers });
const makeId = (prefix, rows) => {
  const used = new Set(rows.map(row => row?.id)); let id;
  do { id = `${prefix}_${crypto.randomBytes(12).toString('base64url')}`; } while (used.has(id));
  return id;
};

export function createWorkoutTemplateRoutes(context) {
  const {
    audit, b2bError, db, json, limitAddress, limits = WORKOUT_TEMPLATE_LIMITS, profileOf, readBody, readSession,
    transaction, validatePrescriptionRoutine, capabilitiesFor, authorizeAthleteAccess, makeEntityId, rate = {}, now = Date.now,
    prescriptionLimits = {},
  } = context;
  const maxTotal = limits.maxWorkoutTemplates ?? WORKOUT_TEMPLATE_LIMITS.maxWorkoutTemplates;
  const maxPerCoach = limits.maxWorkoutTemplatesPerCoach ?? WORKOUT_TEMPLATE_LIMITS.maxWorkoutTemplatesPerCoach;
  const windowMs = rate.windowMs ?? 3600000;
  const mutationAccount = createWindow({ max: rate.workoutTemplateMutationAccount ?? 60, windowMs });
  const mutationIp = createWindow({ max: rate.workoutTemplateMutationIp ?? 300, windowMs });
  const assignAccount = createWindow({ max: rate.workoutTemplateAssignAccount ?? 30, windowMs });
  const assignIp = createWindow({ max: rate.workoutTemplateAssignIp ?? 150, windowMs });
  const readAccount = createWindow({ max: rate.readAccount ?? 600, windowMs });
  const readIp = createWindow({ max: rate.readIp ?? 3000, windowMs });

  const throttle = (req, res, actor, accountWindow, ipWindow) => {
    const waits = [accountWindow.take(actor.id), ipWindow.take(limitAddress(req))].filter(Boolean);
    if (!waits.length) return false;
    b2bError(res, 429, 'rate_limited', 'too many workout template requests', { 'Retry-After': String(Math.max(...waits)) });
    return true;
  };
  // 401 / 403 before anything about templates is looked at. Training capability is the coach's
  // `training` specialty (capabilitiesFor), the same gate the per-athlete prescription routes use.
  const coachFor = (req, res, capability) => {
    const user = readSession(req);
    if (!user) { b2bError(res, 401, 'not_signed_in', 'not signed in'); return null; }
    if (profileOf(user).kind !== 'coach') { b2bError(res, 403, 'role_forbidden', 'professional profile required'); return null; }
    if (!capabilitiesFor(user).includes(capability)) { b2bError(res, 403, 'scope_forbidden', 'training scope required'); return null; }
    return user;
  };
  const validId = (res, id) => {
    if (typeof id === 'string' && ID_RE.test(id)) return true;
    b2bError(res, 400, 'invalid_template_id', 'invalid template id');
    return false;
  };
  // The transaction (server.js) re-reads the latest db under the write lock, applies `operation`
  // to that copy and persists it with ONE saveDbUnlocked. If persistence throws, nothing was
  // published and nothing was answered as a success: the caller gets a 503, never a result.
  const run = async (req, res, operation, status = 200) => {
    let result;
    try { result = await transaction(operation); }
    catch (error) {
      console.error('workout template write failed:', error?.message || error);
      return b2bError(res, 503, 'storage_unavailable', 'storage unavailable, retry');
    }
    if (result.error) return b2bError(res, result.error.status, result.error.code, result.error.message, result.error.headers);
    if (result.audit) audit?.(req, result.audit.event, result.audit.data);
    return json(res, status, result.value);
  };
  const own = (state, id, coachId) => state.workoutTemplates.find(row => row.id === id && row.coachId === coachId) || null;
  const missing = () => failure(404, 'template_not_found', 'workout template not found');
  const routes = {};

  routes['GET /api/coach/workout-templates'] = async (req, res) => {
    const coach = coachFor(req, res, 'athlete:training:read'); if (!coach) return;
    if (throttle(req, res, coach, readAccount, readIp)) return;
    const templates = db.workoutTemplates.filter(row => row.coachId === coach.id)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id)).map(publicTemplate);
    json(res, 200, { templates });
  };

  routes['POST /api/coach/workout-templates'] = async (req, res) => {
    const coach = coachFor(req, res, 'athlete:training:write'); if (!coach) return;
    if (throttle(req, res, coach, mutationAccount, mutationIp)) return;
    const routine = validatePrescriptionRoutine(await readBody(req));
    if (!routine) return b2bError(res, 400, 'invalid_routine', 'invalid workout routine');
    await run(req, res, state => {
      if (state.workoutTemplates.length >= maxTotal || state.workoutTemplates.filter(row => row.coachId === coach.id).length >= maxPerCoach) {
        return { changed: false, error: failure(409, 'template_limit_reached', 'workout template quota reached') };
      }
      const stamp = new Date(now()).toISOString();
      const row = { id: makeId('wtpl', state.workoutTemplates), coachId: coach.id, routine, createdAt: stamp, updatedAt: stamp };
      state.workoutTemplates.push(row);
      return { changed: true, value: { template: publicTemplate(row) }, audit: { event: 'b2b2c.workout-template.create', data: { user: coach, msg: row.id } } };
    }, 201);
  };

  routes['PUT /api/coach/workout-templates/{templateId}'] = async (req, res) => {
    const coach = coachFor(req, res, 'athlete:training:write'); if (!coach) return;
    if (throttle(req, res, coach, mutationAccount, mutationIp)) return;
    if (!validId(res, req.templateId)) return;
    const routine = validatePrescriptionRoutine(await readBody(req));
    if (!routine) return b2bError(res, 400, 'invalid_routine', 'invalid workout routine');
    await run(req, res, state => {
      const row = own(state, req.templateId, coach.id);
      if (!row) return { changed: false, error: missing() };
      row.routine = routine;
      row.updatedAt = new Date(now()).toISOString();
      return { changed: true, value: { template: publicTemplate(row) }, audit: { event: 'b2b2c.workout-template.update', data: { user: coach, msg: row.id } } };
    });
  };

  routes['DELETE /api/coach/workout-templates/{templateId}'] = async (req, res) => {
    const coach = coachFor(req, res, 'athlete:training:write'); if (!coach) return;
    if (throttle(req, res, coach, mutationAccount, mutationIp)) return;
    if (!validId(res, req.templateId)) return;
    await run(req, res, state => {
      const row = own(state, req.templateId, coach.id);
      if (!row) return { changed: false, error: missing() };
      // Only the library entry goes. Assignments already made are prescriptions with their own copy.
      state.workoutTemplates = state.workoutTemplates.filter(item => item !== row);
      return { changed: true, value: { template: publicTemplate(row) }, audit: { event: 'b2b2c.workout-template.delete', data: { user: coach, msg: row.id } } };
    });
  };

  routes['POST /api/coach/workout-templates/{templateId}/assign'] = async (req, res) => {
    const coach = coachFor(req, res, 'athlete:training:write'); if (!coach) return;
    if (throttle(req, res, coach, assignAccount, assignIp)) return;
    if (!validId(res, req.templateId)) return;
    const body = await readBody(req);
    const ids = body.athleteIds;
    if (!record(body) || Object.keys(body).some(key => key !== 'athleteIds') || !Array.isArray(ids)
        || !ids.length || ids.length > (limits.maxWorkoutTemplateAssignTargets ?? MAX_ASSIGN_TARGETS)
        || ids.some(id => typeof id !== 'string' || !ID_RE.test(id))) {
      return b2bError(res, 400, 'invalid_request', `athleteIds must list 1-${MAX_ASSIGN_TARGETS} valid athlete ids`);
    }
    const athleteIds = [...new Set(ids)];
    const maxPerAthlete = prescriptionLimits.prescriptionsPerAthlete ?? 100;
    const maxLive = prescriptionLimits.maxPrescriptions ?? 5000;
    await run(req, res, state => {
      const template = own(state, req.templateId, coach.id);
      if (!template) return { changed: false, error: missing() };
      const stamp = new Date(now()).toISOString();
      const liveRows = state.coachPrescriptions.filter(item => item.state !== 'withdrawn');
      const existing = new Map(); // athleteId -> prescription already assigned from this template
      const perAthlete = new Map();
      for (const item of liveRows) {
        perAthlete.set(item.athleteId, (perAthlete.get(item.athleteId) || 0) + 1);
        if (item.templateId === template.id && item.coachId === coach.id) existing.set(item.athleteId, item);
      }
      let live = liveRows.length;
      const results = [];
      let assigned = 0;
      for (const athleteId of athleteIds) {
        // Never says more than "not your athlete": a stranger, a missing account and yourself look alike.
        const access = athleteId === coach.id ? { ok: false, code: 'relationship_not_found' } : authorizeAthleteAccess(state, coach, athleteId, 'athlete:training:write');
        if (!access.ok) { results.push({ athleteId, status: 'skipped', code: access.code }); continue; }
        const prior = existing.get(athleteId);
        if (prior) { results.push({ athleteId, status: 'skipped', code: 'already_assigned', prescriptionId: prior.id }); continue; }
        if ((perAthlete.get(athleteId) || 0) >= maxPerAthlete || live >= maxLive) {
          results.push({ athleteId, status: 'skipped', code: 'prescription_capacity' }); continue;
        }
        const prescription = {
          id: makeEntityId('cpr', state.coachPrescriptions), coachId: coach.id, athleteId,
          routine: structuredClone(template.routine), state: 'available', createdAt: stamp, updatedAt: stamp, templateId: template.id,
        };
        state.coachPrescriptions.push(prescription);
        perAthlete.set(athleteId, (perAthlete.get(athleteId) || 0) + 1);
        live += 1; assigned += 1;
        results.push({ athleteId, status: 'assigned', prescriptionId: prescription.id });
      }
      return {
        changed: assigned > 0, value: { results },
        audit: { event: 'b2b2c.workout-template.assign', data: { user: coach, msg: `${template.id}:${assigned}/${athleteIds.length}` } },
      };
    });
  };

  return routes;
}
