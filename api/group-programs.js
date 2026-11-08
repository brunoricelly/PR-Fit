import crypto from 'node:crypto';
import { createWindow } from './rate-limit.js';
import { activeTrainingLink } from './challenges.js';

const ID_RE = /^[A-Za-z0-9_-]{1,120}$/;
const PROGRAM_KEYS = new Set(['id', 'seriesId', 'coachId', 'groupId', 'templateId', 'prescriptionId', 'title', 'version', 'status', 'routine', 'createdAt', 'updatedAt', 'publishedAt', 'archivedAt']);
const ADOPTION_KEYS = new Set(['id', 'programId', 'seriesId', 'version', 'coachId', 'groupId', 'athleteId', 'prescriptionId', 'routineIds', 'status', 'adoptedAt', 'updatedAt']);
const record = value => !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => record(value) && Object.keys(value).every(key => keys.has(key));
const date = value => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  && Number.isFinite(Date.parse(value));
const nullableDate = value => value === null || date(value);
const clean = (value, max, required = false) => {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string') return null;
  const out = value.trim(); return (required && !out) || out.length > max ? null : out;
};
const makeId = (prefix, rows) => {
  const used = new Set(rows.map(row => row?.id)); let id;
  do { id = `${prefix}_${crypto.randomBytes(12).toString('base64url')}`; } while (used.has(id));
  return id;
};

function cursorCodec(secret) {
  const signature = text => crypto.createHmac('sha256', secret).update(text).digest('base64url');
  return {
    encode(payload) { const text = Buffer.from(JSON.stringify(payload)).toString('base64url'); return `${text}.${signature(text)}`; },
    decode(value, tenant, kind) {
      if (!value) return 0;
      const [text, sig, extra] = String(value).split('.');
      if (!text || !sig || extra || signature(text) !== sig) return null;
      try { const payload = JSON.parse(Buffer.from(text, 'base64url')); return payload.tenant === tenant && payload.kind === kind && Number.isInteger(payload.offset) && payload.offset >= 0 ? payload.offset : null; } catch { return null; }
    },
  };
}

function paginate(req, rows, codec, tenant, kind) {
  const query = new URL(req.url, 'http://x').searchParams, raw = query.get('limit'), limit = raw === null ? 50 : Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return { error: 'limit must be between 1 and 100' };
  const offset = codec.decode(query.get('cursor'), tenant, kind); if (offset === null) return { error: 'invalid cursor' };
  const items = rows.slice(offset, offset + limit), next = offset + items.length;
  return { items, page: { limit, hasMore: next < rows.length, nextCursor: next < rows.length ? codec.encode({ tenant, kind, offset: next }) : null } };
}

export const GROUP_PROGRAM_LIMITS = Object.freeze({ maxGroupPrograms: 10000, maxGroupProgramsPerCoach: 200, maxGroupProgramAdoptions: 200000 });

function validRoutine(routine) {
  if (!exact(routine, new Set(['name', 'notes', 'divisions'])) || !clean(routine.name, 120, true) || clean(routine.notes, 1000) === null || !Array.isArray(routine.divisions) || !routine.divisions.length || routine.divisions.length > 12) return false;
  return routine.divisions.every((division, divisionIndex) => exact(division, new Set(['id', 'name', 'exercises'])) && division.id === `division_${divisionIndex + 1}` && clean(division.name, 80, true)
    && Array.isArray(division.exercises) && division.exercises.length && division.exercises.length <= 40
    && division.exercises.every((exercise, exerciseIndex) => exact(exercise, new Set(['id', 'catalogueId', 'name', 'sets', 'reps', 'load', 'restSeconds', 'notes'])) && exercise.id === `exercise_${divisionIndex + 1}_${exerciseIndex + 1}`
      && clean(exercise.name, 120, true) && Number.isInteger(exercise.sets) && exercise.sets >= 1 && exercise.sets <= 20
      && clean(exercise.reps, 40, true) && clean(exercise.load, 40) !== null && Number.isInteger(exercise.restSeconds) && exercise.restSeconds >= 0 && exercise.restSeconds <= 3600
      && clean(exercise.notes, 500) !== null && (exercise.catalogueId === undefined || typeof exercise.catalogueId === 'string')));
}

export function validateGroupProgramsState(db, limits = GROUP_PROGRAM_LIMITS) {
  for (const key of ['groupPrograms', 'groupProgramAdoptions']) if (!Array.isArray(db[key])) throw new Error(`${key} must be an array`);
  if (db.groupPrograms.length > (limits.maxGroupPrograms ?? 10000) || db.groupProgramAdoptions.length > (limits.maxGroupProgramAdoptions ?? 200000)) throw new Error('group program quota exceeded');
  const groups = new Map(db.coachGroups.map(row => [row.id, row])), users = new Map(db.users.map(row => [row.id, row]));
  const programs = new Map(), prescriptions = new Set(), seriesVersions = new Set(), perCoach = new Map();
  for (const program of db.groupPrograms) {
    const group = groups.get(program.groupId), pair = `${program.seriesId}\0${program.version}`;
    if (!exact(program, PROGRAM_KEYS) || typeof program.id !== 'string' || !ID_RE.test(program.id) || programs.has(program.id)
        || typeof program.seriesId !== 'string' || !ID_RE.test(program.seriesId) || seriesVersions.has(pair)
        || users.get(program.coachId)?.profile?.kind !== 'coach' || !group || group.coachId !== program.coachId
        || !(program.templateId === null || typeof program.templateId === 'string' && ID_RE.test(program.templateId))
        || typeof program.prescriptionId !== 'string' || !ID_RE.test(program.prescriptionId) || prescriptions.has(program.prescriptionId) || !clean(program.title, 120, true)
        || !Number.isInteger(program.version) || program.version < 1 || !['draft', 'published', 'archived'].includes(program.status)
        || !validRoutine(program.routine) || !date(program.createdAt) || !date(program.updatedAt) || !nullableDate(program.publishedAt) || !nullableDate(program.archivedAt)
        || program.status === 'draft' && (program.publishedAt !== null || program.archivedAt !== null)
        || program.status === 'published' && (!date(program.publishedAt) || program.archivedAt !== null)
        || program.status === 'archived' && !date(program.archivedAt)) throw new Error('groupPrograms contains invalid data');
    programs.set(program.id, program); prescriptions.add(program.prescriptionId); seriesVersions.add(pair); perCoach.set(program.coachId, (perCoach.get(program.coachId) || 0) + 1);
  }
  if ([...perCoach.values()].some(count => count > (limits.maxGroupProgramsPerCoach ?? 200))) throw new Error('coach group program quota exceeded');
  const adoptionIds = new Set(), adoptionPairs = new Set();
  for (const adoption of db.groupProgramAdoptions) {
    const program = programs.get(adoption.programId), pair = `${adoption.programId}\0${adoption.athleteId}`;
    if (!exact(adoption, ADOPTION_KEYS) || typeof adoption.id !== 'string' || !ID_RE.test(adoption.id) || adoptionIds.has(adoption.id) || adoptionPairs.has(pair)
        || !program || adoption.seriesId !== program.seriesId || adoption.version !== program.version || adoption.coachId !== program.coachId || adoption.groupId !== program.groupId
        || adoption.prescriptionId !== program.prescriptionId || !users.has(adoption.athleteId)
        || !Array.isArray(adoption.routineIds) || !adoption.routineIds.length || adoption.routineIds.some(id => typeof id !== 'string' || !ID_RE.test(id))
        || !['active', 'revoked'].includes(adoption.status) || !date(adoption.adoptedAt) || !date(adoption.updatedAt)) throw new Error('groupProgramAdoptions contains invalid data');
    adoptionIds.add(adoption.id); adoptionPairs.add(pair);
  }
  return true;
}

export function compactGroupProgramsState(db) { return { changed: false }; }

export function removeGroupProgramsUser(db, userId) {
  db.groupPrograms ||= [];
  db.groupProgramAdoptions ||= [];
  const programIds = new Set(db.groupPrograms.filter(row => row.coachId === userId).map(row => row.id));
  db.groupPrograms = db.groupPrograms.filter(row => row.coachId !== userId);
  db.groupProgramAdoptions = db.groupProgramAdoptions.filter(row => !programIds.has(row.programId) && row.athleteId !== userId);
}

const publicProgram = program => ({ id: program.id, seriesId: program.seriesId, groupId: program.groupId, templateId: program.templateId, title: program.title,
  version: program.version, status: program.status, routine: structuredClone(program.routine), createdAt: program.createdAt, updatedAt: program.updatedAt,
  publishedAt: program.publishedAt, archivedAt: program.archivedAt });
const failure = (status, code, message, headers) => ({ status, code, message, headers });

export function createGroupProgramRoutes(context) {
  const { audit, adoptProgram, b2bError, db, json, limitAddress, limits = GROUP_PROGRAM_LIMITS, profileOf, readBody, readSession, transaction, validatePrescriptionRoutine, rate = {}, now = Date.now, cursorSecret = 'group-program-cursor' } = context;
  const codec = cursorCodec(cursorSecret);
  const accountWindow = createWindow({ max: rate.groupProgramMutationAccount ?? 60, windowMs: rate.windowMs ?? 3600000 });
  const ipWindow = createWindow({ max: rate.groupProgramMutationIp ?? 300, windowMs: rate.windowMs ?? 3600000 });
  const throttle = (req, res, actor) => { const waits = [accountWindow.take(actor.id), ipWindow.take(limitAddress(req))].filter(Boolean); if (!waits.length) return false; const wait = Math.max(...waits); b2bError(res, 429, 'rate_limited', 'too many group program requests', { 'Retry-After': String(wait) }); return true; };
  const coachOnly = (req, res) => { const user = readSession(req); if (!user) { b2bError(res, 401, 'not_signed_in', 'not signed in'); return null; } if (profileOf(user).kind !== 'coach') { b2bError(res, 403, 'role_forbidden', 'coach role required'); return null; } return user; };
  const athleteOnly = (req, res) => { const user = readSession(req); if (!user) { b2bError(res, 401, 'not_signed_in', 'not signed in'); return null; } return user; };
  const run = async (req, res, operation, status = 200) => { try { const result = await transaction(operation); if (result.error) return b2bError(res, result.error.status, result.error.code, result.error.message, result.error.headers); if (result.audit) audit?.(req, result.audit.event, result.audit.data); json(res, status, result.value); } catch (error) { b2bError(res, 503, 'storage_unavailable', error.message); } };
  const owned = (state, id, coachId) => { const program = state.groupPrograms.find(row => row.id === id); return !program ? { error: failure(404, 'program_not_found', 'program not found') } : program.coachId !== coachId ? { error: failure(403, 'access_denied', 'access denied') } : { program }; };
  const eligible = (state, program, athleteId) => state.groupMembers.some(row => row.groupId === program.groupId && row.athleteId === athleteId && row.status === 'active') && !!activeTrainingLink(state, program.coachId, athleteId);
  const routes = {};

  routes['POST /api/coach/group-programs'] = async (req, res) => {
    const coach = coachOnly(req, res); if (!coach || throttle(req, res, coach)) return; const body = await readBody(req);
    if (!exact(body, new Set(['groupId', 'templateId', 'title', 'routine'])) || typeof body.groupId !== 'string' || !ID_RE.test(body.groupId) || !(body.templateId === undefined || typeof body.templateId === 'string' && ID_RE.test(body.templateId)) || !clean(body.title, 120, true)) return b2bError(res, 400, 'invalid_program', 'invalid program request');
    const routine = validatePrescriptionRoutine({ routine: body.routine }); if (!routine) return b2bError(res, 400, 'invalid_program', 'invalid prescription routine');
    await run(req, res, state => {
      const group = state.coachGroups.find(row => row.id === body.groupId); if (!group) return { changed: false, error: failure(404, 'group_not_found', 'group not found') }; if (group.coachId !== coach.id) return { changed: false, error: failure(403, 'access_denied', 'access denied') }; if (group.archivedAt) return { changed: false, error: failure(410, 'group_archived', 'group is archived') };
      if (state.groupPrograms.length >= (limits.maxGroupPrograms ?? 10000) || state.groupPrograms.filter(row => row.coachId === coach.id).length >= (limits.maxGroupProgramsPerCoach ?? 200)) return { changed: false, error: failure(409, 'program_limit_reached', 'program quota reached') };
      const stamp = new Date(now()).toISOString(), id = makeId('gprg', state.groupPrograms), seriesId = makeId('gprs', state.groupPrograms);
      const program = { id, seriesId, coachId: coach.id, groupId: group.id, templateId: body.templateId ?? null, prescriptionId: `gprx_${crypto.randomBytes(12).toString('base64url')}`, title: body.title.trim(), version: 1, status: 'draft', routine, createdAt: stamp, updatedAt: stamp, publishedAt: null, archivedAt: null };
      state.groupPrograms.push(program); return { changed: true, value: { program: publicProgram(program) }, audit: { event: 'coach.group-program.create', data: { user: coach, programId: program.id, groupId: group.id } } };
    }, 201);
  };

  routes['GET /api/coach/group-programs'] = async (req, res) => { const coach = coachOnly(req, res); if (!coach) return; const result = paginate(req, db.groupPrograms.filter(row => row.coachId === coach.id).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id)).map(publicProgram), codec, coach.id, 'coach-group-programs'); if (result.error) return b2bError(res, 400, 'invalid_pagination', result.error); json(res, 200, { programs: result.items, page: result.page }); };
  routes['GET /api/coach/group-programs/{programId}'] = async (req, res) => { const coach = coachOnly(req, res); if (!coach) return; const result = owned(db, req.programId, coach.id); if (result.error) return b2bError(res, result.error.status, result.error.code, result.error.message); json(res, 200, { program: publicProgram(result.program) }); };

  routes['PUT /api/coach/group-programs/{programId}'] = async (req, res) => {
    const coach = coachOnly(req, res); if (!coach || throttle(req, res, coach)) return; const body = await readBody(req);
    if (!exact(body, new Set(['title', 'templateId', 'routine']))) return b2bError(res, 400, 'invalid_program', 'unknown program field');
    const routine = body.routine === undefined ? undefined : validatePrescriptionRoutine({ routine: body.routine }); if (body.routine !== undefined && !routine) return b2bError(res, 400, 'invalid_program', 'invalid prescription routine');
    await run(req, res, state => { const result = owned(state, req.programId, coach.id); if (result.error) return { changed: false, error: result.error }; const program = result.program; if (program.status !== 'draft') return { changed: false, error: failure(409, 'program_immutable', 'published program versions are immutable') };
      if (body.title !== undefined) { const title = clean(body.title, 120, true); if (!title) return { changed: false, error: failure(400, 'invalid_title', 'invalid title') }; program.title = title; }
      if (body.templateId !== undefined) { if (!(body.templateId === null || typeof body.templateId === 'string' && ID_RE.test(body.templateId))) return { changed: false, error: failure(400, 'invalid_template', 'invalid templateId') }; program.templateId = body.templateId; }
      if (routine) program.routine = routine; program.updatedAt = new Date(now()).toISOString(); return { changed: true, value: { program: publicProgram(program) }, audit: { event: 'coach.group-program.update', data: { user: coach, programId: program.id } } }; });
  };

  routes['POST /api/coach/group-programs/{programId}/publish'] = async (req, res) => { const coach = coachOnly(req, res); if (!coach || throttle(req, res, coach)) return; await run(req, res, state => { const result = owned(state, req.programId, coach.id); if (result.error) return { changed: false, error: result.error }; const program = result.program; if (program.status !== 'draft') return { changed: false, error: failure(409, 'invalid_transition', 'only drafts can be published') }; const group = state.coachGroups.find(row => row.id === program.groupId); if (group?.archivedAt) return { changed: false, error: failure(410, 'group_archived', 'group is archived') }; const stamp = new Date(now()).toISOString(); Object.assign(program, { status: 'published', publishedAt: stamp, updatedAt: stamp }); return { changed: true, value: { program: publicProgram(program) }, audit: { event: 'coach.group-program.publish', data: { user: coach, programId: program.id } } }; }); };

  routes['POST /api/coach/group-programs/{programId}/versions'] = async (req, res) => { const coach = coachOnly(req, res); if (!coach || throttle(req, res, coach)) return; await run(req, res, state => { const result = owned(state, req.programId, coach.id); if (result.error) return { changed: false, error: result.error }; const source = result.program; if (source.status !== 'published') return { changed: false, error: failure(409, 'invalid_transition', 'new versions require a published source') }; if (state.groupPrograms.some(row => row.seriesId === source.seriesId && row.status === 'draft')) return { changed: false, error: failure(409, 'draft_version_exists', 'a draft version already exists') }; const stamp = new Date(now()).toISOString(), version = Math.max(...state.groupPrograms.filter(row => row.seriesId === source.seriesId).map(row => row.version)) + 1; const program = { ...structuredClone(source), id: makeId('gprg', state.groupPrograms), prescriptionId: `gprx_${crypto.randomBytes(12).toString('base64url')}`, version, status: 'draft', createdAt: stamp, updatedAt: stamp, publishedAt: null, archivedAt: null }; state.groupPrograms.push(program); return { changed: true, value: { program: publicProgram(program) }, audit: { event: 'coach.group-program.version', data: { user: coach, programId: program.id } } }; }, 201); };

  routes['POST /api/coach/group-programs/{programId}/archive'] = async (req, res) => { const coach = coachOnly(req, res); if (!coach || throttle(req, res, coach)) return; await run(req, res, state => { const result = owned(state, req.programId, coach.id); if (result.error) return { changed: false, error: result.error }; const program = result.program; if (program.status === 'archived') return { changed: false, error: failure(410, 'program_archived', 'program is archived') }; const stamp = new Date(now()).toISOString(); Object.assign(program, { status: 'archived', archivedAt: stamp, updatedAt: stamp }); return { changed: true, value: { program: publicProgram(program) }, audit: { event: 'coach.group-program.archive', data: { user: coach, programId: program.id } } }; }); };

  routes['GET /api/athlete/group-programs'] = async (req, res) => { const athlete = athleteOnly(req, res); if (!athlete) return; const rows = db.groupPrograms.filter(program => program.status === 'published' && eligible(db, program, athlete.id)).sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt) || b.version - a.version || a.id.localeCompare(b.id)).map(program => ({ ...publicProgram(program), adopted: db.groupProgramAdoptions.some(row => row.programId === program.id && row.athleteId === athlete.id && row.status === 'active') })); const result = paginate(req, rows, codec, athlete.id, 'athlete-group-programs'); if (result.error) return b2bError(res, 400, 'invalid_pagination', result.error); json(res, 200, { programs: result.items, page: result.page }); };
  routes['GET /api/athlete/group-programs/{programId}'] = async (req, res) => { const athlete = athleteOnly(req, res); if (!athlete) return; const program = db.groupPrograms.find(row => row.id === req.programId && row.status === 'published'); if (!program) return b2bError(res, 404, 'program_not_found', 'program not found'); if (!eligible(db, program, athlete.id)) return b2bError(res, 403, 'access_denied', 'active group membership and training relationship required'); json(res, 200, { program: { ...publicProgram(program), adopted: db.groupProgramAdoptions.some(row => row.programId === program.id && row.athleteId === athlete.id && row.status === 'active') } }); };
  routes['POST /api/athlete/group-programs/{programId}/adopt'] = async (req, res) => { const athlete = athleteOnly(req, res); if (!athlete || throttle(req, res, athlete)) return; const body = await readBody(req); if (!exact(body, new Set(['confirmExistingPlan'])) || body.confirmExistingPlan !== undefined && typeof body.confirmExistingPlan !== 'boolean') return b2bError(res, 400, 'invalid_request', 'confirmExistingPlan must be boolean'); try { const result = await adoptProgram({ req, athlete, programId: req.programId, confirmExistingPlan: body.confirmExistingPlan === true }); if (result.error) return b2bError(res, result.error.status, result.error.code, result.error.message); json(res, 200, result.value); } catch (error) { b2bError(res, 503, 'storage_unavailable', error.message); } };
  return routes;
}
