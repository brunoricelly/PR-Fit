import crypto from 'node:crypto';

export const B2B2C_SCHEMA_VERSION = 4;
export const COACH_SCOPES = ['training', 'nutrition', 'assessments'];
export const B2B2C_LIMITS = {
  maxAssessmentsPerAthlete: 200,
  maxAssessments: 10000,
  assessmentRetentionDays: 3650,
};

export const PARQ_VERSION = '2024.1';
export const PARQ_QUESTIONS = Object.freeze([
  { id: 'heart_condition', text: 'Has a doctor ever said that you have a heart condition and should only do physical activity recommended by a doctor?' },
  { id: 'chest_pain_activity', text: 'Do you feel pain in your chest when you do physical activity?' },
  { id: 'chest_pain_rest', text: 'In the past month, have you had chest pain when you were not doing physical activity?' },
  { id: 'balance_consciousness', text: 'Do you lose your balance because of dizziness or have you ever lost consciousness?' },
  { id: 'bone_joint', text: 'Do you have a bone or joint problem that could be made worse by a change in physical activity?' },
  { id: 'blood_pressure_medicine', text: 'Is a doctor currently prescribing medication for your blood pressure or heart condition?' },
  { id: 'other_reason', text: 'Do you know of any other reason why you should not do physical activity?' },
]);

export class B2B2CDataError extends Error {
  constructor(message) {
    super(message);
    this.name = 'B2B2CDataError';
  }
}

const record = value => !!value && typeof value === 'object' && !Array.isArray(value);
const uniqueAllowed = (value, allowed) => {
  if (!Array.isArray(value)) return null;
  const out = [];
  for (const item of value) {
    if (!allowed.includes(item)) return null;
    if (!out.includes(item)) out.push(item);
  }
  return out;
};

export function migrateB2B2C(db) {
  let changed = false;
  if (db.schemaVersion === undefined) {
    db.schemaVersion = B2B2C_SCHEMA_VERSION;
    changed = true;
  } else {
    if (!Number.isInteger(db.schemaVersion)) throw new B2B2CDataError('schemaVersion must be an integer');
    if (db.schemaVersion > B2B2C_SCHEMA_VERSION) {
      throw new B2B2CDataError(`schemaVersion ${db.schemaVersion} is newer than supported version ${B2B2C_SCHEMA_VERSION}`);
    }
    if (![1, 2, 3, B2B2C_SCHEMA_VERSION].includes(db.schemaVersion)) {
      throw new B2B2CDataError(`schemaVersion ${db.schemaVersion} is not a known migration source`);
    }
    if (db.schemaVersion < B2B2C_SCHEMA_VERSION) {
      db.schemaVersion = B2B2C_SCHEMA_VERSION;
      changed = true;
    }
  }
  for (const key of ['coachInvites', 'coachAthleteLinks', 'coachPrescriptions', 'coachAssessments']) {
    if (db[key] === undefined) { db[key] = []; changed = true; continue; }
    if (!Array.isArray(db[key])) throw new B2B2CDataError(`${key} must be an array`);
  }
  for (const item of db.coachAssessments) {
    if (!record(item) || typeof item.id !== 'string' || typeof item.coachId !== 'string' || typeof item.athleteId !== 'string') {
      throw new B2B2CDataError('coachAssessments contains an invalid record');
    }
    if (!Number.isFinite(Date.parse(item.assessedAt)) || !Number.isFinite(Date.parse(item.createdAt))) {
      throw new B2B2CDataError('coachAssessments contains an invalid date');
    }
    if (item.parq?.answers?.every(answer => typeof answer === 'boolean')) {
      if (item.parq.answers.length !== PARQ_QUESTIONS.length) throw new B2B2CDataError('coachAssessments contains an invalid PAR-Q');
      item.parq = {
        version: PARQ_VERSION,
        answers: PARQ_QUESTIONS.map((question, index) => ({ questionId: question.id, answer: item.parq.answers[index] })),
        notes: typeof item.parq.notes === 'string' ? item.parq.notes : '',
        acknowledged: false,
      };
      item.requiresMedicalClearance = item.parq.answers.some(answer => answer.answer);
      changed = true;
    }
    const {
      id, coachId, athleteId, createdAt, updatedAt, results, requiresMedicalClearance,
      medicalAdviceAcknowledgedAt, photoOwnerId, ...payload
    } = item;
    if (!validateAssessment(payload, { allowStoredDate: true })) {
      throw new B2B2CDataError('coachAssessments contains invalid assessment data');
    }
  }
  return changed;
}

const rowTime = row => {
  for (const value of [row.updatedAt, row.endedAt, row.acceptedAt, row.expiredAt, row.closedAt, row.createdAt]) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
};
const newestFirst = (left, right) => rowTime(right) - rowTime(left) || String(left.id).localeCompare(String(right.id));
const oldestFirst = (left, right) => rowTime(left) - rowTime(right) || String(left.id).localeCompare(String(right.id));

function closePending(link, invite, nowIso, reason) {
  if (link.status !== 'pending') return false;
  link.status = 'ended';
  link.updatedAt = nowIso;
  link.endedAt = nowIso;
  link.endedReason = reason;
  if (invite) {
    if (reason === 'invite_expired') invite.expiredAt ||= nowIso;
    else {
      invite.closedAt ||= nowIso;
      invite.closedReason ||= reason;
    }
  }
  return true;
}

export function compactB2B2C(db, limits, nowMs = Date.now()) {
  const maxPrescriptions = limits.maxPrescriptions ?? 5000;
  const terminalPrescriptionsKeep = limits.terminalPrescriptionsKeep ?? 1000;
  const nowIso = new Date(nowMs).toISOString();
  const cutoff = nowMs - limits.terminalRetentionDays * 86400000;
  let changed = false;
  let linksById = new Map(db.coachAthleteLinks.map(link => [link.id, link]));

  for (const invite of db.coachInvites) {
    const link = linksById.get(invite.linkId);
    if (!link || invite.acceptedAt) continue;
    const expiry = Date.parse(invite.expiresAt);
    if (!Number.isFinite(expiry) || expiry <= nowMs || link.status !== 'pending') {
      changed = closePending(link, invite, nowIso, 'invite_expired') || changed;
      if (!invite.expiredAt) { invite.expiredAt = nowIso; changed = true; }
    }
  }

  const inviteForLink = new Map(db.coachInvites.map(invite => [invite.linkId, invite]));
  const pendingLinks = () => db.coachAthleteLinks.filter(link => link.status === 'pending').sort(oldestFirst);
  const pendingInvites = () => db.coachInvites.filter(invite => linksById.get(invite.linkId)?.status === 'pending');

  while (pendingInvites().length > limits.maxInvites) {
    const link = pendingLinks()[0];
    if (!link) break;
    changed = closePending(link, inviteForLink.get(link.id), nowIso, 'storage_capacity') || changed;
  }
  while (db.coachAthleteLinks.filter(link => link.status !== 'ended').length > limits.maxLinks) {
    const link = pendingLinks()[0];
    if (!link) break;
    changed = closePending(link, inviteForLink.get(link.id), nowIso, 'storage_capacity') || changed;
  }

  const liveLinks = db.coachAthleteLinks.filter(link => link.status !== 'ended');
  if (liveLinks.length > limits.maxLinks) {
    throw new B2B2CDataError(`live coachAthleteLinks exceed configured limit ${limits.maxLinks}`);
  }

  const terminalSlots = Math.max(0, limits.maxLinks - liveLinks.length);
  const terminalLinks = db.coachAthleteLinks
    .filter(link => link.status === 'ended' && limits.terminalRetentionDays > 0 && rowTime(link) >= cutoff)
    .sort(newestFirst)
    .slice(0, Math.min(limits.terminalLinksKeep, terminalSlots));
  const keptLinks = [...liveLinks, ...terminalLinks];
  const keptLinkIds = new Set(keptLinks.map(link => link.id));
  if (keptLinks.length !== db.coachAthleteLinks.length) changed = true;
  db.coachAthleteLinks = keptLinks;
  linksById = new Map(keptLinks.map(link => [link.id, link]));

  const pending = db.coachInvites
    .filter(invite => linksById.get(invite.linkId)?.status === 'pending')
    .sort(newestFirst);
  if (pending.length > limits.maxInvites) throw new B2B2CDataError(`pending coachInvites exceed configured limit ${limits.maxInvites}`);
  const remaining = Math.max(0, limits.maxInvites - pending.length);
  const acceptedLive = db.coachInvites
    .filter(invite => invite.acceptedAt && keptLinkIds.has(invite.linkId) && linksById.get(invite.linkId)?.status !== 'ended')
    .sort(newestFirst)
    .slice(0, remaining);
  const terminalRemaining = Math.max(0, remaining - acceptedLive.length);
  const terminalInvites = db.coachInvites
    .filter(invite => linksById.get(invite.linkId)?.status === 'ended'
      && limits.terminalRetentionDays > 0 && rowTime(invite) >= cutoff)
    .sort(newestFirst)
    .slice(0, Math.min(limits.terminalInvitesKeep, terminalRemaining));
  const keptInvites = [...pending, ...acceptedLive, ...terminalInvites];
  if (keptInvites.length !== db.coachInvites.length) changed = true;
  db.coachInvites = keptInvites;

  const livePrescriptions = db.coachPrescriptions.filter(item => item.state !== 'withdrawn');
  if (livePrescriptions.length > maxPrescriptions) {
    throw new B2B2CDataError(`live coachPrescriptions exceed configured limit ${maxPrescriptions}`);
  }
  const prescriptionSlots = Math.max(0, maxPrescriptions - livePrescriptions.length);
  const withdrawnPrescriptions = db.coachPrescriptions
    .filter(item => item.state === 'withdrawn' && limits.terminalRetentionDays > 0 && rowTime(item) >= cutoff)
    .sort(newestFirst)
    .slice(0, Math.min(terminalPrescriptionsKeep, prescriptionSlots));
  const keptPrescriptions = [...livePrescriptions, ...withdrawnPrescriptions];
  if (keptPrescriptions.length !== db.coachPrescriptions.length) changed = true;
  db.coachPrescriptions = keptPrescriptions;
  const assessmentRetentionDays = limits.assessmentRetentionDays ?? B2B2C_LIMITS.assessmentRetentionDays;
  let expiredAssessments = [];
  if (assessmentRetentionDays > 0) {
    const assessmentCutoff = nowMs - assessmentRetentionDays * 86400000;
    expiredAssessments = db.coachAssessments.filter(item => Date.parse(item.assessedAt) < assessmentCutoff);
    const keptAssessments = db.coachAssessments.filter(item => Date.parse(item.assessedAt) >= assessmentCutoff);
    if (keptAssessments.length !== db.coachAssessments.length) changed = true;
    db.coachAssessments = keptAssessments;
  }
  if (db.coachAssessments.length > (limits.maxAssessments ?? B2B2C_LIMITS.maxAssessments)) {
    throw new B2B2CDataError(`coachAssessments exceed configured limit ${limits.maxAssessments ?? B2B2C_LIMITS.maxAssessments}`);
  }
  const pairCounts = new Map();
  for (const assessment of db.coachAssessments) {
    const key = `${assessment.coachId}\0${assessment.athleteId}`;
    const count = (pairCounts.get(key) || 0) + 1;
    if (count > (limits.maxAssessmentsPerAthlete ?? B2B2C_LIMITS.maxAssessmentsPerAthlete)) {
      throw new B2B2CDataError(`coachAssessments pair exceeds configured limit ${limits.maxAssessmentsPerAthlete ?? B2B2C_LIMITS.maxAssessmentsPerAthlete}`);
    }
    pairCounts.set(key, count);
  }
  return {
    changed, invites: keptInvites.length, links: keptLinks.length,
    prescriptions: keptPrescriptions.length, assessments: db.coachAssessments.length,
    expiredAssessments,
  };
}

export function profileOf(user) {
  const profile = record(user?.profile) ? user.profile : null;
  if (profile?.kind !== 'coach') return { kind: 'athlete', coachSpecialties: [] };
  const specialties = uniqueAllowed(profile.coachSpecialties, COACH_SCOPES) || [];
  if (!specialties.length) return { kind: 'athlete', coachSpecialties: [] };
  return { kind: 'coach', coachSpecialties: specialties };
}

export function validateProfile(body) {
  if (!record(body)) return null;
  const keys = Object.keys(body).sort();
  if (keys.some(key => !['coachSpecialties', 'kind'].includes(key))) return null;
  if (body.kind === 'athlete') {
    const specialties = body.coachSpecialties === undefined ? [] : uniqueAllowed(body.coachSpecialties, COACH_SCOPES);
    return specialties?.length === 0 ? { kind: 'athlete', coachSpecialties: [] } : null;
  }
  if (body.kind !== 'coach') return null;
  const specialties = uniqueAllowed(body.coachSpecialties, COACH_SCOPES);
  return specialties?.length ? { kind: 'coach', coachSpecialties: specialties } : null;
}

export function validateScopes(scopes, specialties) {
  const normalized = uniqueAllowed(scopes, COACH_SCOPES);
  if (!normalized?.length) return null;
  return normalized.every(scope => specialties.includes(scope)) ? normalized : null;
}

export function capabilitiesFor(user) {
  const profile = profileOf(user);
  if (profile.kind !== 'coach') return [];
  const capabilities = ['relationships:invite', 'relationships:list', 'relationships:suspend', 'relationships:end'];
  for (const scope of profile.coachSpecialties) {
    capabilities.push(`athlete:${scope}:read`, `athlete:${scope}:write`);
  }
  return capabilities;
}

export function safeProfileUser(user, { includeProfile = true } = {}) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    ...(includeProfile ? { profile: profileOf(user) } : {}),
  };
}

export function makeOpaqueInvite() {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, tokenHash: hashInviteToken(token) };
}

export function hashInviteToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('base64url');
}

export function makeEntityId(prefix, rows) {
  let id;
  do { id = `${prefix}_${crypto.randomBytes(12).toString('base64url')}`; }
  while (rows.some(row => row.id === id));
  return id;
}

const cleanText = (value, max, { required = false } = {}) => {
  if (value === undefined || value === null) return required ? null : '';
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if ((required && !normalized) || normalized.length > max) return null;
  return normalized;
};

const assessmentNumber = (value, min, max) => (
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null
);

const normalizeNumberFields = (value, allowed, min, max) => {
  if (!record(value) || !Object.keys(value).length || Object.keys(value).some(key => !allowed.includes(key))) return null;
  const out = {};
  for (const [key, measurement] of Object.entries(value)) {
    const normalized = assessmentNumber(measurement, min, max);
    if (normalized === null) return null;
    out[key] = normalized;
  }
  return out;
};

const SKINFOLD_SITES = [
  'abdomen', 'biceps', 'calf', 'chest', 'midaxillary', 'subscapular', 'suprailiac', 'thigh', 'triceps',
];
const CIRCUMFERENCE_SITES = [
  'abdomen', 'ankle', 'arm', 'calf', 'chest', 'forearm', 'hip', 'neck', 'thigh', 'waist', 'wrist',
];
const BIOIMPEDANCE_FIELDS = [
  'bodyFatPercent', 'boneMassKg', 'bmrKcal', 'metabolicAge', 'muscleMassKg', 'visceralFat', 'waterPercent',
];
const SKINFOLD_PROTOCOLS = {
  pollock3: {
    male: ['chest', 'abdomen', 'thigh'],
    female: ['triceps', 'suprailiac', 'thigh'],
  },
  pollock7: {
    male: ['chest', 'midaxillary', 'triceps', 'subscapular', 'abdomen', 'suprailiac', 'thigh'],
    female: ['chest', 'midaxillary', 'triceps', 'subscapular', 'abdomen', 'suprailiac', 'thigh'],
  },
  faulkner4: ['triceps', 'subscapular', 'suprailiac', 'abdomen'],
};

function normalizeSkinfolds(value) {
  if (!record(value)) return null;
  const { protocol, sex, age, ...measurements } = value;
  if (protocol !== undefined && !Object.hasOwn(SKINFOLD_PROTOCOLS, protocol)) return null;
  if (sex !== undefined && !['male', 'female'].includes(sex)) return null;
  const normalizedAge = age === undefined ? undefined : assessmentNumber(age, 1, 120);
  if (age !== undefined && (!Number.isInteger(age) || normalizedAge === null)) return null;
  const normalized = normalizeNumberFields(measurements, SKINFOLD_SITES, 0.1, 100);
  if (!normalized) return null;
  if (protocol) {
    if (protocol !== 'faulkner4' && (!sex || normalizedAge === undefined)) return null;
    const requiredSites = protocol === 'faulkner4' ? SKINFOLD_PROTOCOLS.faulkner4 : SKINFOLD_PROTOCOLS[protocol][sex];
    if (!requiredSites.every(site => normalized[site] !== undefined)) return null;
  }
  return {
    ...(protocol ? { protocol } : {}),
    ...(sex ? { sex } : {}),
    ...(normalizedAge === undefined ? {} : { age: normalizedAge }),
    ...normalized,
  };
}

function normalizeBioimpedance(value) {
  const normalized = normalizeNumberFields(value, BIOIMPEDANCE_FIELDS, 0, 10000);
  if (!normalized) return null;
  for (const field of ['bodyFatPercent', 'waterPercent']) {
    if (normalized[field] !== undefined && normalized[field] > 100) return null;
  }
  if (normalized.metabolicAge !== undefined && (!Number.isInteger(normalized.metabolicAge) || normalized.metabolicAge > 120)) return null;
  if (normalized.visceralFat !== undefined && normalized.visceralFat > 100) return null;
  return normalized;
}

function normalizeParq(value) {
  if (!record(value) || Object.keys(value).some(key => !['acknowledged', 'answers', 'notes', 'version'].includes(key))) return null;
  if (!Array.isArray(value.answers) || value.answers.length !== PARQ_QUESTIONS.length) return null;
  let answers;
  if (value.answers.every(answer => typeof answer === 'boolean')) {
    answers = PARQ_QUESTIONS.map((question, index) => ({ questionId: question.id, answer: value.answers[index] }));
  } else {
    if (!value.answers.every(record)) return null;
    answers = PARQ_QUESTIONS.map(question => {
      const answer = value.answers.find(item => item.questionId === question.id);
      return answer && typeof answer.answer === 'boolean' && Object.keys(answer).every(key => ['answer', 'questionId'].includes(key))
        ? { questionId: question.id, answer: answer.answer } : null;
    });
    if (answers.some(answer => !answer) || value.answers.length !== answers.length) return null;
  }
  if (value.version !== undefined && value.version !== PARQ_VERSION) return null;
  if (value.acknowledged !== undefined && typeof value.acknowledged !== 'boolean') return null;
  const notes = cleanText(value.notes, 1000);
  if (notes === null) return null;
  return { version: PARQ_VERSION, answers, notes, acknowledged: value.acknowledged === true };
}

const ANAMNESIS_FIELDS = {
  healthHistory: 2000,
  injuries: 2000,
  medications: 1000,
  goals: 1000,
  contraindications: 1000,
};

function normalizeAnamnesis(value) {
  if (!record(value) || Object.keys(value).some(key => !Object.hasOwn(ANAMNESIS_FIELDS, key))) return null;
  const out = {};
  for (const [key, max] of Object.entries(ANAMNESIS_FIELDS)) {
    const normalized = cleanText(value[key], max);
    if (normalized === null) return null;
    out[key] = normalized;
  }
  return out;
}

function normalizePhotos(value) {
  if (!Array.isArray(value) || value.length > 6) return null;
  const seen = new Set();
  const out = [];
  for (const photo of value) {
    if (!record(photo) || Object.keys(photo).some(key => !['hash', 'height', 'kind', 'mime', 'size', 'width'].includes(key))) return null;
    if (photo.kind !== 'image' || !['image/jpeg', 'image/png', 'image/webp'].includes(photo.mime)) return null;
    if (typeof photo.hash !== 'string' || !/^[0-9a-f]{64}$/.test(photo.hash) || seen.has(photo.hash)) return null;
    if (!Number.isInteger(photo.size) || photo.size < 1 || photo.size > 20 * 1024 * 1024) return null;
    if (!Number.isInteger(photo.width) || photo.width < 1 || photo.width > 16384
        || !Number.isInteger(photo.height) || photo.height < 1 || photo.height > 16384) return null;
    seen.add(photo.hash);
    out.push({ kind: 'image', hash: photo.hash, mime: photo.mime, size: photo.size, width: photo.width, height: photo.height });
  }
  return out;
}

export function validateAssessment(payload, {
  nowMs = Date.now(), futureSkewMs = 5 * 60000, maxAgeYears = 100, allowStoredDate = false,
} = {}) {
  if (!record(payload)) return null;
  const allowed = ['anamnesis', 'assessedAt', 'bioimpedance', 'circumferences', 'heightCm', 'notes', 'parq', 'photos', 'skinfolds', 'weightKg'];
  if (Object.keys(payload).some(key => !allowed.includes(key))) return null;
  const assessedAt = payload.assessedAt === undefined ? undefined : cleanText(payload.assessedAt, 40, { required: true });
  if (assessedAt === null || (assessedAt !== undefined && !Number.isFinite(Date.parse(assessedAt)))) return null;
  if (assessedAt !== undefined && !allowStoredDate) {
    const timestamp = Date.parse(assessedAt);
    const oldest = nowMs - maxAgeYears * 365.2425 * 86400000;
    if (timestamp > nowMs + futureSkewMs || timestamp < oldest) return null;
  }
  const notes = cleanText(payload.notes, 2000);
  if (notes === null) return null;
  const weightKg = payload.weightKg === undefined ? undefined : assessmentNumber(payload.weightKg, 1, 500);
  const heightCm = payload.heightCm === undefined ? undefined : assessmentNumber(payload.heightCm, 30, 300);
  if ((payload.weightKg !== undefined && weightKg === null) || (payload.heightCm !== undefined && heightCm === null)) return null;

  const skinfolds = payload.skinfolds === undefined ? undefined : normalizeSkinfolds(payload.skinfolds);
  const circumferences = payload.circumferences === undefined
    ? undefined
    : normalizeNumberFields(payload.circumferences, CIRCUMFERENCE_SITES, 1, 300);
  const bioimpedance = payload.bioimpedance === undefined ? undefined : normalizeBioimpedance(payload.bioimpedance);
  const parq = payload.parq === undefined ? undefined : normalizeParq(payload.parq);
  const anamnesis = payload.anamnesis === undefined ? undefined : normalizeAnamnesis(payload.anamnesis);
  const photos = payload.photos === undefined ? undefined : normalizePhotos(payload.photos);
  if ((payload.skinfolds !== undefined && !skinfolds)
      || (payload.circumferences !== undefined && !circumferences)
      || (payload.bioimpedance !== undefined && !bioimpedance)
      || (payload.parq !== undefined && !parq)
      || (payload.anamnesis !== undefined && !anamnesis)
      || (payload.photos !== undefined && !photos)) return null;
  if (!skinfolds && !circumferences && !bioimpedance && !parq && weightKg === undefined && heightCm === undefined) return null;

  return {
    ...(assessedAt === undefined ? {} : { assessedAt: new Date(assessedAt).toISOString() }),
    ...(weightKg === undefined ? {} : { weightKg }),
    ...(heightCm === undefined ? {} : { heightCm }),
    ...(skinfolds ? { skinfolds } : {}),
    ...(circumferences ? { circumferences } : {}),
    ...(bioimpedance ? { bioimpedance } : {}),
    ...(parq ? { parq } : {}),
    ...(anamnesis ? { anamnesis } : {}),
    ...(photos ? { photos } : {}),
    notes,
  };
}

export function validatePrescriptionRoutine(body) {
  if (!record(body) || !record(body.routine)) return null;
  if (Object.keys(body).some(key => key !== 'routine')) return null;
  const routine = body.routine;
  if (Object.keys(routine).some(key => !['divisions', 'name', 'notes'].includes(key))) return null;
  const name = cleanText(routine.name, 120, { required: true });
  const notes = cleanText(routine.notes, 1000);
  if (!name || notes === null || !Array.isArray(routine.divisions) || !routine.divisions.length || routine.divisions.length > 12) return null;

  const divisions = [];
  for (let divisionIndex = 0; divisionIndex < routine.divisions.length; divisionIndex++) {
    const input = routine.divisions[divisionIndex];
    if (!record(input) || Object.keys(input).some(key => !['exercises', 'name'].includes(key))) return null;
    const divisionName = cleanText(input.name, 80, { required: true });
    if (!divisionName || !Array.isArray(input.exercises) || !input.exercises.length || input.exercises.length > 40) return null;
    const exercises = [];
    for (let exerciseIndex = 0; exerciseIndex < input.exercises.length; exerciseIndex++) {
      const exercise = input.exercises[exerciseIndex];
      if (!record(exercise) || Object.keys(exercise).some(key => !['catalogueId', 'load', 'name', 'notes', 'reps', 'restSeconds', 'sets'].includes(key))) return null;
      const exerciseName = cleanText(exercise.name, 120, { required: true });
      const catalogueId = cleanText(exercise.catalogueId, 64);
      const reps = cleanText(exercise.reps, 40, { required: true });
      const load = cleanText(exercise.load, 40);
      const exerciseNotes = cleanText(exercise.notes, 500);
      if (!exerciseName || catalogueId === null || !reps || load === null || exerciseNotes === null) return null;
      if (!Number.isInteger(exercise.sets) || exercise.sets < 1 || exercise.sets > 20) return null;
      if (!Number.isInteger(exercise.restSeconds) || exercise.restSeconds < 0 || exercise.restSeconds > 3600) return null;
      exercises.push({
        id: `exercise_${divisionIndex + 1}_${exerciseIndex + 1}`,
        ...(catalogueId ? { catalogueId } : {}),
        name: exerciseName,
        sets: exercise.sets,
        reps,
        load,
        restSeconds: exercise.restSeconds,
        notes: exerciseNotes,
      });
    }
    divisions.push({ id: `division_${divisionIndex + 1}`, name: divisionName, exercises });
  }
  return { name, notes, divisions };
}

export function serializePrescription(db, prescription) {
  return {
    id: prescription.id,
    coach: safeProfileUser(db.users.find(user => user.id === prescription.coachId)),
    athlete: safeProfileUser(db.users.find(user => user.id === prescription.athleteId), { includeProfile: false }),
    routine: structuredClone(prescription.routine),
    state: prescription.state,
    createdAt: prescription.createdAt,
    updatedAt: prescription.updatedAt,
    ...(prescription.adoptedAt ? { adoptedAt: prescription.adoptedAt } : {}),
    ...(Array.isArray(prescription.adoptedRoutineIds) ? { adoptedRoutineIds: [...prescription.adoptedRoutineIds] } : {}),
    ...(prescription.withdrawnAt ? { withdrawnAt: prescription.withdrawnAt } : {}),
  };
}

export function linkForActor(db, actor, linkId) {
  const link = db.coachAthleteLinks.find(item => item.id === linkId);
  if (!link) return null;
  return link.coachId === actor?.id || link.athleteId === actor?.id ? link : null;
}

export function authorizeAthleteAccess(db, actor, athleteId, capability) {
  if (!actor) return { ok: false, code: 'not_signed_in' };
  if (actor.id === athleteId) return { ok: true, own: true, link: null };
  if (profileOf(actor).kind !== 'coach') return { ok: false, code: 'relationship_not_found' };
  const match = /^athlete:(training|nutrition|assessments):(read|write)$/.exec(capability);
  if (!match || !capabilitiesFor(actor).includes(capability)) return { ok: false, code: 'scope_forbidden' };
  const links = db.coachAthleteLinks.filter(item => item.coachId === actor.id && item.athleteId === athleteId);
  const link = links.find(item => item.status === 'active') || links.find(item => item.status !== 'ended') || links.at(-1);
  if (!link) return { ok: false, code: 'relationship_not_found' };
  if (link.status !== 'active') return { ok: false, code: 'relationship_inactive', link };
  if (!link.scopes.includes(match[1])) return { ok: false, code: 'scope_forbidden', link };
  return { ok: true, own: false, link };
}

export function serializeLink(db, link, viewer) {
  const coach = db.users.find(user => user.id === link.coachId);
  const athlete = db.users.find(user => user.id === link.athleteId);
  const out = {
    id: link.id,
    scopes: [...link.scopes],
    status: link.status,
    createdAt: link.createdAt,
    updatedAt: link.updatedAt,
    ...(link.acceptedAt ? { acceptedAt: link.acceptedAt } : {}),
    ...(link.suspendedAt ? { suspendedAt: link.suspendedAt } : {}),
    ...(link.endedAt ? { endedAt: link.endedAt } : {}),
  };
  if (viewer?.id === link.coachId) out.athlete = safeProfileUser(athlete, { includeProfile: false });
  if (viewer?.id === link.athleteId) out.coach = safeProfileUser(coach);
  return out;
}

export function removeB2B2CUser(db, userId) {
  db.coachInvites = db.coachInvites.filter(invite => invite.coachId !== userId && invite.acceptedBy !== userId);
  db.coachAthleteLinks = db.coachAthleteLinks.filter(link => link.coachId !== userId && link.athleteId !== userId);
  db.coachPrescriptions = db.coachPrescriptions.filter(item => item.coachId !== userId && item.athleteId !== userId);
  db.coachAssessments = db.coachAssessments.filter(item => item.coachId !== userId && item.athleteId !== userId);
}
