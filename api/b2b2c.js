import crypto from 'node:crypto';
import {
  compactCommunicationHabits, removeCommunicationHabitsUser, validateCommunicationHabitsState,
} from './communication-habits.js';
import {
  compactProgressState, migrateProgressState, progressDependentLinkIds, removeProgressUser,
} from './progress-analytics.js';
import {
  compactSchedulingState, migrateSchedulingState, removeSchedulingUser, validateSchedulingState,
} from './scheduling.js';
import {
  compactChallengesState, removeChallengesUser, validateChallengesState, CHALLENGE_LIMITS,
} from './challenges.js';
import {
  compactGroupProgramsState, removeGroupProgramsUser, validateGroupProgramsState, GROUP_PROGRAM_LIMITS,
} from './group-programs.js';
import {
  LEGACY_NUTRITION_CONTRACT_VERSION, NUTRITION_CONTRACT_VERSION, NUTRITION_TOLERANCES,
  nutritionPlanIssues, nutritionTolerances,
} from './nutrition-contract.js';

export const B2B2C_SCHEMA_VERSION = 10;
export const COACH_SCOPES = ['training', 'nutrition', 'assessments'];
export const B2B2C_LIMITS = {
  maxAssessmentsPerAthlete: 200,
  maxAssessments: 10000,
  assessmentRetentionDays: 3650,
  maxMealPlansPerAthlete: 20,
  maxMealPlans: 10000,
  maxMealAdherencePerAthlete: 1000,
  maxMealAdherence: 50000,
  mealAdherenceRetentionDays: 730,
  maxGoalsPerLink: 50,
  maxGoals: 10000,
  maxTerminalGoals: 50000,
  goalRetentionDays: 730,
  maxReportsPerLink: 100,
  maxReports: 20000,
  maxTerminalReports: 50000,
  reportRetentionDays: 1095,
  maxReportBytes: 1024 * 1024,
  maxPendingAccountCleanupJobs: 1000,
  maxCompleteAccountCleanupJobs: 10000,
  maxFailedAccountCleanupJobs: 10000,
  accountCleanupCompleteRetentionDays: 90,
  accountCleanupFailedRetentionDays: 365,
  ...CHALLENGE_LIMITS,
  ...GROUP_PROGRAM_LIMITS,
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
  constructor(message, code = 'invalid_b2b2c_data') {
    super(message);
    this.name = 'B2B2CDataError';
    this.code = code;
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
  const sourceVersion = db.schemaVersion;
  if (db.schemaVersion === undefined) {
    db.schemaVersion = B2B2C_SCHEMA_VERSION;
    changed = true;
  } else {
    if (!Number.isInteger(db.schemaVersion)) throw new B2B2CDataError('schemaVersion must be an integer');
    if (db.schemaVersion > B2B2C_SCHEMA_VERSION) {
      throw new B2B2CDataError(`schemaVersion ${db.schemaVersion} is newer than supported version ${B2B2C_SCHEMA_VERSION}`);
    }
    if (![1, 2, 3, 4, 5, 6, 7, 8, 9, B2B2C_SCHEMA_VERSION].includes(db.schemaVersion)) {
      throw new B2B2CDataError(`schemaVersion ${db.schemaVersion} is not a known migration source`);
    }
    if (db.schemaVersion < B2B2C_SCHEMA_VERSION) {
      db.schemaVersion = B2B2C_SCHEMA_VERSION;
      changed = true;
    }
  }
  for (const key of ['coachInvites', 'coachAthleteLinks', 'coachPrescriptions', 'coachAssessments', 'mealPlans', 'mealPlanTombstones', 'mealAdherence', 'coachMessages', 'coachHabits', 'habitCheckins', 'accountCleanupJobs', 'coachAvailability', 'coachAppointments', 'coachGroups', 'groupMembers', 'groupInvites', 'challenges', 'challengeScores', 'challengeActivityFeed', 'groupPrograms', 'groupProgramAdoptions']) {
    if (db[key] === undefined) { db[key] = []; changed = true; continue; }
    if (!Array.isArray(db[key])) throw new B2B2CDataError(`${key} must be an array`);
  }
  for (const job of db.accountCleanupJobs) {
    if (!record(job)) throw new B2B2CDataError('accountCleanupJobs contains an invalid record');
    if (job.nextAttemptAt === undefined) { job.nextAttemptAt = job.status === 'pending' ? job.updatedAt : null; changed = true; }
    if (job.terminalAt === undefined) { job.terminalAt = job.status === 'complete' ? job.updatedAt : null; changed = true; }
    if (typeof job.id !== 'string' || typeof job.subject !== 'string'
        || !['pending', 'complete', 'failed', 'manual_review'].includes(job.status) || !Number.isSafeInteger(job.attempts) || job.attempts < 0
        || !Number.isFinite(Date.parse(job.createdAt)) || !Number.isFinite(Date.parse(job.updatedAt))
        || !record(job.steps) || Object.values(job.steps).some(value => !['pending', 'complete'].includes(value))
        || !(job.lastError === null || typeof job.lastError === 'string' && job.lastError.length <= 160)
        || !(job.nextAttemptAt === null || Number.isFinite(Date.parse(job.nextAttemptAt)))
        || !(job.terminalAt === null || Number.isFinite(Date.parse(job.terminalAt)))) {
      throw new B2B2CDataError('accountCleanupJobs contains an invalid record');
    }
  }
  // Nutrition did not exist before schema 5. If a pre-release schema 4 fixture already contains
  // plans, converge it on the phase-4 rule deterministically instead of keeping two active plans.
  if (sourceVersion !== undefined && sourceVersion < 5) {
    const newestActiveByAthlete = new Map();
    for (const plan of db.mealPlans) {
      if (plan?.status !== 'active') continue;
      const current = newestActiveByAthlete.get(plan.athleteId);
      if (!current || plan.updatedAt > current.updatedAt
          || (plan.updatedAt === current.updatedAt && String(plan.id).localeCompare(String(current.id)) > 0)) {
        newestActiveByAthlete.set(plan.athleteId, plan);
      }
    }
    for (const plan of db.mealPlans) {
      if (plan?.status === 'active' && newestActiveByAthlete.get(plan.athleteId) !== plan) {
        plan.status = 'archived';
        changed = true;
      }
    }
  }
  if (sourceVersion === undefined || sourceVersion < 10) {
    const plansByIdentity = new Map();
    for (const plan of db.mealPlans) {
      if (!record(plan)) throw new B2B2CDataError('mealPlans contains an invalid record');
      if (plan.nutritionContractVersion === undefined) {
        plan.nutritionContractVersion = LEGACY_NUTRITION_CONTRACT_VERSION;
        changed = true;
      }
      plansByIdentity.set(`${plan.athleteId}\0${plan.id}`, plan);
    }
    for (const adherence of db.mealAdherence) {
      if (!record(adherence)) throw new B2B2CDataError('mealAdherence contains an invalid record');
      if (adherence.planSnapshot !== undefined) continue;
      const plan = plansByIdentity.get(`${adherence.athleteId}\0${adherence.mealPlanId}`);
      if (!plan) throw new B2B2CDataError('legacy mealAdherence cannot be migrated without its meal plan');
      adherence.planSnapshot = createMealPlanSnapshot(plan);
      changed = true;
    }
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
  validateNutritionState(db.mealPlans, db.mealAdherence, db.mealPlanTombstones);
  try { validateCommunicationHabitsState(db); }
  catch (error) { throw new B2B2CDataError(error.message); }
  try { changed = migrateProgressState(db) || changed; }
  catch (error) { throw new B2B2CDataError(error.message); }
  try { changed = migrateSchedulingState(db) || changed; }
  catch (error) { throw new B2B2CDataError(error.message); }
  try { validateChallengesState(db, B2B2C_LIMITS); }
  catch (error) { throw new B2B2CDataError(error.message); }
  try { validateGroupProgramsState(db, B2B2C_LIMITS); }
  catch (error) { throw new B2B2CDataError(error.message); }
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
  // migrateB2B2C initializes these in production; defaults keep the policy helper usable with
  // focused legacy fixtures that predate the nutrition collections.
  db.mealPlans ||= [];
  db.mealPlanTombstones ||= [];
  db.mealAdherence ||= [];
  db.coachMessages ||= [];
  db.coachHabits ||= [];
  db.habitCheckins ||= [];
  db.progressGoals ||= [];
  db.progressReports ||= [];
  db.accountCleanupJobs ||= [];
  db.coachAvailability ||= [];
  db.coachAppointments ||= [];
  db.coachGroups ||= [];
  db.groupMembers ||= [];
  db.groupInvites ||= [];
  db.challenges ||= [];
  db.challengeScores ||= [];
  db.challengeActivityFeed ||= [];
  db.groupPrograms ||= [];
  db.groupProgramAdoptions ||= [];
  const maxPrescriptions = limits.maxPrescriptions ?? 5000;
  const terminalPrescriptionsKeep = limits.terminalPrescriptionsKeep ?? 1000;
  const nowIso = new Date(nowMs).toISOString();
  const cutoff = nowMs - limits.terminalRetentionDays * 86400000;
  let changed = false;
  const completeCleanupCutoff = nowMs - (limits.accountCleanupCompleteRetentionDays ?? 90) * 86400000;
  const failedCleanupCutoff = nowMs - (limits.accountCleanupFailedRetentionDays ?? 365) * 86400000;
  const cleanupBefore = db.accountCleanupJobs.length;
  db.accountCleanupJobs = db.accountCleanupJobs.filter(job => {
    if (job.status === 'complete') return Date.parse(job.terminalAt || job.updatedAt) >= completeCleanupCutoff;
    if (job.status === 'failed' || job.status === 'manual_review') return Date.parse(job.terminalAt || job.updatedAt) >= failedCleanupCutoff;
    return true;
  });
  changed = changed || cleanupBefore !== db.accountCleanupJobs.length;
  const pendingCleanupJobs = db.accountCleanupJobs.filter(job => job.status === 'pending').length;
  const completeCleanupJobs = db.accountCleanupJobs.filter(job => job.status === 'complete').length;
  const failedCleanupJobs = db.accountCleanupJobs.length - pendingCleanupJobs - completeCleanupJobs;
  if (pendingCleanupJobs > (limits.maxPendingAccountCleanupJobs ?? 1000)) throw new B2B2CDataError(`pending accountCleanupJobs exceed configured limit ${limits.maxPendingAccountCleanupJobs ?? 1000}`);
  if (completeCleanupJobs > (limits.maxCompleteAccountCleanupJobs ?? 10000)) throw new B2B2CDataError(`complete accountCleanupJobs exceed configured limit ${limits.maxCompleteAccountCleanupJobs ?? 10000}`);
  if (failedCleanupJobs > (limits.maxFailedAccountCleanupJobs ?? 10000)) throw new B2B2CDataError(`failed accountCleanupJobs exceed configured limit ${limits.maxFailedAccountCleanupJobs ?? 10000}`);
  let progress;
  try { progress = compactProgressState(db, limits, nowMs); }
  catch (error) { throw new B2B2CDataError(error.message); }
  changed = changed || progress.changed;
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

  const dependentLinkIds = new Set([
    ...db.coachMessages.map(item => item.linkId),
    ...db.coachHabits.map(item => item.linkId),
    ...db.habitCheckins.map(item => item.linkId),
    ...db.coachAppointments.map(item => item.linkId),
    ...progressDependentLinkIds(db),
  ]);
  const nutritionHistoryPairs = new Set([...db.mealPlans, ...db.mealPlanTombstones]
    .filter(plan => db.mealAdherence.some(item => item.athleteId === plan.athleteId && item.mealPlanId === plan.id))
    .map(plan => `${plan.coachId}\0${plan.athleteId}`));
  for (const link of db.coachAthleteLinks) {
    if (link.acceptedAt && link.scopes.includes('nutrition') && nutritionHistoryPairs.has(`${link.coachId}\0${link.athleteId}`)) {
      dependentLinkIds.add(link.id);
    }
  }
  const protectedTerminalSource = db.coachAthleteLinks
    .filter(link => link.status === 'ended' && dependentLinkIds.has(link.id));
  if (liveLinks.length + protectedTerminalSource.length > limits.maxLinks) {
    throw new B2B2CDataError(
      `protected coachAthleteLinks exceed configured limit ${limits.maxLinks}`,
      'relationship_capacity',
    );
  }
  const protectedTerminalLinks = protectedTerminalSource
    .map(link => {
      if (rowTime(link) >= cutoff) return link;
      const tombstone = {
        id: link.id,
        coachId: link.coachId,
        athleteId: link.athleteId,
        scopes: [...link.scopes],
        status: 'ended',
        createdAt: link.createdAt,
        ...(link.acceptedAt ? { acceptedAt: link.acceptedAt } : {}),
        updatedAt: link.updatedAt,
        endedAt: link.endedAt || link.updatedAt,
        ...(link.suspendedAt ? { suspendedAt: link.suspendedAt } : {}),
        tombstone: true,
      };
      if (Object.keys(link).length !== Object.keys(tombstone).length || !link.tombstone) changed = true;
      return tombstone;
    });
  const protectedIds = new Set(protectedTerminalLinks.map(link => link.id));
  const terminalSlots = Math.max(0, limits.maxLinks - liveLinks.length - protectedTerminalLinks.length);
  const terminalLinks = db.coachAthleteLinks
    .filter(link => link.status === 'ended' && limits.terminalRetentionDays > 0 && rowTime(link) >= cutoff)
    .filter(link => !protectedIds.has(link.id))
    .sort(newestFirst)
    .slice(0, Math.min(limits.terminalLinksKeep, terminalSlots));
  const keptLinks = [...liveLinks, ...protectedTerminalLinks, ...terminalLinks];
  if (keptLinks.length > limits.maxLinks) {
    throw new B2B2CDataError(
      `coachAthleteLinks exceed configured limit ${limits.maxLinks}`,
      'relationship_capacity',
    );
  }
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
  const mealAdherenceRetentionDays = limits.mealAdherenceRetentionDays ?? B2B2C_LIMITS.mealAdherenceRetentionDays;
  if (mealAdherenceRetentionDays > 0) {
    const adherenceCutoff = new Date(nowMs - mealAdherenceRetentionDays * 86400000).toISOString().slice(0, 10);
    const keptAdherence = db.mealAdherence.filter(item => item.date >= adherenceCutoff);
    if (keptAdherence.length !== db.mealAdherence.length) changed = true;
    db.mealAdherence = keptAdherence;
  }
  const retainedPlanKeys = new Set(db.mealAdherence.map(item => `${item.athleteId}\0${item.mealPlanId}`));
  const keptMealPlanTombstones = db.mealPlanTombstones.filter(item => retainedPlanKeys.has(`${item.athleteId}\0${item.id}`));
  if (keptMealPlanTombstones.length !== db.mealPlanTombstones.length) changed = true;
  db.mealPlanTombstones = keptMealPlanTombstones;
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
  if (db.mealPlans.length > (limits.maxMealPlans ?? B2B2C_LIMITS.maxMealPlans)) {
    throw new B2B2CDataError(`mealPlans exceed configured limit ${limits.maxMealPlans ?? B2B2C_LIMITS.maxMealPlans}`);
  }
  const mealPlanPairCounts = new Map();
  for (const plan of db.mealPlans) {
    const key = `${plan.coachId}\0${plan.athleteId}`;
    const count = (mealPlanPairCounts.get(key) || 0) + 1;
    if (count > (limits.maxMealPlansPerAthlete ?? B2B2C_LIMITS.maxMealPlansPerAthlete)) {
      throw new B2B2CDataError(`mealPlans pair exceeds configured limit ${limits.maxMealPlansPerAthlete ?? B2B2C_LIMITS.maxMealPlansPerAthlete}`);
    }
    mealPlanPairCounts.set(key, count);
  }
  if (db.mealAdherence.length > (limits.maxMealAdherence ?? B2B2C_LIMITS.maxMealAdherence)) {
    throw new B2B2CDataError(`mealAdherence exceeds configured limit ${limits.maxMealAdherence ?? B2B2C_LIMITS.maxMealAdherence}`);
  }
  if (db.mealPlanTombstones.length > db.mealAdherence.length) {
    throw new B2B2CDataError('mealPlanTombstones exceed retained meal adherence references');
  }
  const adherenceCounts = new Map();
  for (const adherence of db.mealAdherence) {
    const count = (adherenceCounts.get(adherence.athleteId) || 0) + 1;
    if (count > (limits.maxMealAdherencePerAthlete ?? B2B2C_LIMITS.maxMealAdherencePerAthlete)) {
      throw new B2B2CDataError(`mealAdherence athlete exceeds configured limit ${limits.maxMealAdherencePerAthlete ?? B2B2C_LIMITS.maxMealAdherencePerAthlete}`);
    }
    adherenceCounts.set(adherence.athleteId, count);
  }
  let communication;
  try { communication = compactCommunicationHabits(db, limits, nowMs); }
  catch (error) { throw new B2B2CDataError(error.message); }
  changed = changed || communication.changed;
  let scheduling;
  try { scheduling = compactSchedulingState(db, limits, nowMs); }
  catch (error) { throw new B2B2CDataError(error.message); }
  changed = changed || scheduling.changed;
  let challenges;
  try { challenges = compactChallengesState(db, limits, nowMs); }
  catch (error) { throw new B2B2CDataError(error.message); }
  changed = changed || challenges.changed;
  let programs;
  try { programs = compactGroupProgramsState(db, limits, nowMs); }
  catch (error) { throw new B2B2CDataError(error.message); }
  changed = changed || programs.changed;
  return {
    changed, invites: keptInvites.length, links: keptLinks.length,
    prescriptions: keptPrescriptions.length, assessments: db.coachAssessments.length,
    mealPlans: db.mealPlans.length, mealPlanTombstones: db.mealPlanTombstones.length, mealAdherence: db.mealAdherence.length,
    messages: db.coachMessages.length, habits: db.coachHabits.length, checkins: db.habitCheckins.length,
    goals: db.progressGoals.length, reports: db.progressReports.length,
    availability: db.coachAvailability.length, appointments: db.coachAppointments.length,
    groups: db.coachGroups.length, members: db.groupMembers.length, groupPrograms: db.groupPrograms.length,
    challenges: db.challenges.length, scores: db.challengeScores.length,
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

const mealNumber = (value, min, max) => (
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null
);
const mealId = (value, fallback) => (
  value === undefined ? fallback : typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value) ? value : null
);

/** Strictly normalize the client-editable portion of a nutrition plan. */
export { NUTRITION_TOLERANCES };

export function validateMealPlan(payload, { contractVersion = NUTRITION_CONTRACT_VERSION } = {}) {
  const tolerances = nutritionTolerances(contractVersion);
  if (!tolerances) return null;
  if (!record(payload) || Object.keys(payload).some(key => !['meals', 'notes', 'status', 'targetCalories', 'targetMacros', 'title'].includes(key))) return null;
  const title = cleanText(payload.title, 120, { required: true });
  const notes = cleanText(payload.notes, 2000);
  if (!title || notes === null || !['active', 'archived', 'draft'].includes(payload.status)) return null;
  const targetCalories = mealNumber(payload.targetCalories, 1, 10000);
  if (targetCalories === null || !record(payload.targetMacros)
      || Object.keys(payload.targetMacros).some(key => !['carbs', 'fats', 'fiber', 'protein', 'waterMl'].includes(key))) return null;
  const targetMacros = {
    protein: mealNumber(payload.targetMacros.protein, 1, 500),
    carbs: mealNumber(payload.targetMacros.carbs, 1, 1200),
    fats: mealNumber(payload.targetMacros.fats, 1, 500),
    fiber: mealNumber(payload.targetMacros.fiber, 0, 200),
    waterMl: mealNumber(payload.targetMacros.waterMl, 1, 15000),
  };
  if (Object.values(targetMacros).some(value => value === null)) return null;
  if (!Array.isArray(payload.meals) || !payload.meals.length || payload.meals.length > 20) return null;

  const meals = [];
  const mealIds = new Set();
  const itemIds = new Set();
  for (let mealIndex = 0; mealIndex < payload.meals.length; mealIndex++) {
    const input = payload.meals[mealIndex];
    if (!record(input) || Object.keys(input).some(key => !['id', 'items', 'name', 'time'].includes(key))) return null;
    const id = mealId(input.id, `m_${mealIndex + 1}`);
    const name = cleanText(input.name, 100, { required: true });
    if (!id || mealIds.has(id) || !name || typeof input.time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.time)
        || !Array.isArray(input.items) || !input.items.length || input.items.length > 50) return null;
    mealIds.add(id);
    const items = [];
    for (let itemIndex = 0; itemIndex < input.items.length; itemIndex++) {
      const item = input.items[itemIndex];
      if (!record(item) || Object.keys(item).some(key => !['calories', 'carbs', 'fats', 'fiber', 'id', 'name', 'portion', 'protein', 'substitutes'].includes(key))) return null;
      const itemId = mealId(item.id, `it_${mealIndex + 1}_${itemIndex + 1}`);
      const itemName = cleanText(item.name, 120, { required: true });
      const portion = cleanText(item.portion, 120, { required: true });
      const nutrients = {
        calories: mealNumber(item.calories, 0, 5000),
        protein: mealNumber(item.protein, 0, 500),
        carbs: mealNumber(item.carbs, 0, 1000),
        fats: mealNumber(item.fats, 0, 500),
        fiber: mealNumber(item.fiber, 0, 200),
      };
      if (!itemId || itemIds.has(itemId) || !itemName || !portion || Object.values(nutrients).some(value => value === null)
          || !Array.isArray(item.substitutes) || item.substitutes.length > 20) return null;
      itemIds.add(itemId);
      const substitutes = [];
      for (const substitute of item.substitutes) {
        const nutrientKeys = ['calories', 'protein', 'carbs', 'fats', 'fiber'];
        if (!record(substitute) || Object.keys(substitute).some(key => !['name', 'portion', ...nutrientKeys].includes(key))) return null;
        const substituteName = cleanText(substitute.name, 120, { required: true });
        const substitutePortion = cleanText(substitute.portion, 120, { required: true });
        if (!substituteName || !substitutePortion) return null;
        const normalizedSubstitute = { name: substituteName, portion: substitutePortion };
        for (const key of nutrientKeys) {
          if (substitute[key] === undefined) continue;
          const value = mealNumber(substitute[key], 0, key === 'calories' ? 5000 : key === 'carbs' ? 1000 : key === 'fiber' ? 200 : 500);
          const absolute = key === 'calories' ? 100 : 5;
          if (value === null || Math.abs(value - nutrients[key]) > Math.max(absolute, nutrients[key] * tolerances.substitutePercent)) return null;
          normalizedSubstitute[key] = value;
        }
        substitutes.push(normalizedSubstitute);
      }
      items.push({ id: itemId, name: itemName, portion, ...nutrients, substitutes });
    }
    meals.push({ id, name, time: input.time, items });
  }
  const normalized = { title, status: payload.status, targetCalories, targetMacros, meals, notes };
  if (nutritionPlanIssues(normalized, contractVersion).length) return null;
  return normalized;
}

export function createMealPlanSnapshot(plan) {
  return {
    version: 1,
    nutritionContractVersion: plan.nutritionContractVersion ?? NUTRITION_CONTRACT_VERSION,
    title: plan.title,
    targetCalories: plan.targetCalories,
    targetMacros: structuredClone(plan.targetMacros),
    meals: structuredClone(plan.meals),
    notes: plan.notes,
  };
}

export function validateMealPlanSnapshot(snapshot) {
  if (!record(snapshot) || Object.keys(snapshot).some(key => !['meals', 'notes', 'nutritionContractVersion', 'targetCalories', 'targetMacros', 'title', 'version'].includes(key))
      || snapshot.version !== 1 || !Number.isInteger(snapshot.nutritionContractVersion)) return null;
  const normalized = validateMealPlan({
    title: snapshot.title, status: 'archived', targetCalories: snapshot.targetCalories,
    targetMacros: snapshot.targetMacros, meals: snapshot.meals, notes: snapshot.notes,
  }, { contractVersion: snapshot.nutritionContractVersion });
  if (!normalized) return null;
  return createMealPlanSnapshot({ ...normalized, nutritionContractVersion: snapshot.nutritionContractVersion });
}

export function validateMealAdherence(payload, plan) {
  if (!record(payload) || Object.keys(payload).some(key => !['athleteId', 'date', 'id', 'mealPlanId', 'mealsChecked', 'notes', 'planSnapshot', 'updatedAt', 'waterDrunkMl'].includes(key))) return null;
  if (typeof payload.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(payload.date)
      || new Date(`${payload.date}T00:00:00.000Z`).toISOString().slice(0, 10) !== payload.date
      || !Array.isArray(payload.mealsChecked) || payload.mealsChecked.length > 20) return null;
  const mealsChecked = [...new Set(payload.mealsChecked)];
  if (mealsChecked.length !== payload.mealsChecked.length || mealsChecked.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(id))) return null;
  if (plan) {
    const allowed = new Set(plan.meals.map(meal => meal.id));
    if (mealsChecked.some(id => !allowed.has(id))) return null;
  }
  const waterDrunkMl = mealNumber(payload.waterDrunkMl, 0, 20000);
  const notes = cleanText(payload.notes, 1000);
  if (waterDrunkMl === null || notes === null) return null;
  return { date: payload.date, mealsChecked, waterDrunkMl, notes };
}

/** Validate the nutrition collections as one persistence unit. Throws on any ambiguity. */
export function validateNutritionState(mealPlans, mealAdherence, mealPlanTombstones = []) {
  if (!Array.isArray(mealPlans) || !Array.isArray(mealAdherence) || !Array.isArray(mealPlanTombstones)) {
    throw new B2B2CDataError('nutrition collections must be arrays');
  }
  const plansByIdentity = new Map();
  const planIds = new Set();
  const activeAthletes = new Set();
  for (const item of mealPlans) {
    if (!record(item) || typeof item.id !== 'string' || !item.id || planIds.has(item.id)
        || typeof item.coachId !== 'string' || typeof item.athleteId !== 'string'
        || !Number.isFinite(item.createdAt) || !Number.isFinite(item.updatedAt)) {
      throw new B2B2CDataError('mealPlans contains a duplicate id or invalid record');
    }
    const { id, coachId, athleteId, createdAt, updatedAt, nutritionContractVersion, ...payload } = item;
    if (!Number.isInteger(nutritionContractVersion)
        || !validateMealPlan(payload, { contractVersion: nutritionContractVersion })) throw new B2B2CDataError('mealPlans contains invalid meal plan data');
    if (item.status === 'active' && activeAthletes.has(item.athleteId)) {
      throw new B2B2CDataError('mealPlans contains more than one active plan for an athlete');
    }
    planIds.add(item.id);
    if (item.status === 'active') activeAthletes.add(item.athleteId);
    plansByIdentity.set(`${item.athleteId}\0${item.id}`, item);
  }
  for (const item of mealPlanTombstones) {
    if (!record(item) || Object.keys(item).some(key => !['athleteId', 'coachId', 'createdAt', 'deletedAt', 'id', 'updatedAt'].includes(key))
        || typeof item.id !== 'string' || !item.id || planIds.has(item.id)
        || typeof item.coachId !== 'string' || typeof item.athleteId !== 'string'
        || !Number.isFinite(item.createdAt) || !Number.isFinite(item.updatedAt) || !Number.isFinite(item.deletedAt)) {
      throw new B2B2CDataError('mealPlanTombstones contains a duplicate id or invalid record');
    }
    planIds.add(item.id);
    plansByIdentity.set(`${item.athleteId}\0${item.id}`, item);
  }
  const adherenceIds = new Set();
  const adherenceKeys = new Set();
  for (const item of mealAdherence) {
    const plan = plansByIdentity.get(`${item?.athleteId}\0${item?.mealPlanId}`);
    const snapshot = validateMealPlanSnapshot(item?.planSnapshot);
    const adherenceKey = `${item?.athleteId}\0${item?.mealPlanId}\0${item?.date}`;
    if (!record(item) || typeof item.id !== 'string' || !item.id || adherenceIds.has(item.id)
        || typeof item.athleteId !== 'string' || typeof item.mealPlanId !== 'string'
        || !Number.isFinite(item.updatedAt) || !plan || !snapshot || adherenceKeys.has(adherenceKey)
        || !validateMealAdherence(item, snapshot)) {
      throw new B2B2CDataError('mealAdherence contains a duplicate id, duplicate day, or invalid record');
    }
    adherenceIds.add(item.id);
    adherenceKeys.add(adherenceKey);
  }
  return true;
}

export function serializeMealPlan(db, plan) {
  return {
    id: plan.id,
    coach: safeProfileUser(db.users.find(user => user.id === plan.coachId)),
    athlete: safeProfileUser(db.users.find(user => user.id === plan.athleteId), { includeProfile: false }),
    title: plan.title,
    status: plan.status,
    targetCalories: plan.targetCalories,
    targetMacros: structuredClone(plan.targetMacros),
    meals: structuredClone(plan.meals),
    notes: plan.notes,
    nutritionContractVersion: plan.nutritionContractVersion,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  };
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
  removeCommunicationHabitsUser(db, userId);
  removeProgressUser(db, userId);
  removeSchedulingUser(db, userId);
  removeChallengesUser(db, userId);
  removeGroupProgramsUser(db, userId);
  db.coachInvites = db.coachInvites.filter(invite => invite.coachId !== userId && invite.acceptedBy !== userId);
  db.coachAthleteLinks = db.coachAthleteLinks.filter(link => link.coachId !== userId && link.athleteId !== userId);
  db.coachPrescriptions = db.coachPrescriptions.filter(item => item.coachId !== userId && item.athleteId !== userId);
  db.coachAssessments = db.coachAssessments.filter(item => item.coachId !== userId && item.athleteId !== userId);
  const removedPlans = new Set([...db.mealPlans, ...(db.mealPlanTombstones || [])]
    .filter(item => item.coachId === userId || item.athleteId === userId)
    .map(item => `${item.athleteId}\0${item.id}`));
  db.mealPlans = db.mealPlans.filter(item => item.coachId !== userId && item.athleteId !== userId);
  db.mealPlanTombstones = (db.mealPlanTombstones || []).filter(item => item.coachId !== userId && item.athleteId !== userId);
  db.mealAdherence = db.mealAdherence.filter(item => item.athleteId !== userId
    && !removedPlans.has(`${item.athleteId}\0${item.mealPlanId}`));
}
