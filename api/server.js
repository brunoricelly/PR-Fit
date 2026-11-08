/* opengym-api — passkey (WebAuthn) auth + per-user state storage for openGym
   No framework, JSON-file storage, signed session cookies.               */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { pipeline } from 'node:stream/promises';
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse
} from '@simplewebauthn/server';
import webpush from 'web-push';
import * as coachConfig from './coach/config.js';
import * as coachJobs from './coach/jobs.js';
import { coachRoutes } from './coach/routes.js';
import { startCadence } from './coach/cadence.js';
import { startWarmup } from './coach/warmup.js';
import { appointmentReminderPush, dayReminderPush, nudgePush, restTimerPush, testPush } from './push-messages.js';
import { verifyError, isMisconfigured, originHint } from './verify-error.js';
import {
  hashPassword, verifyPassword, needsRehash, passwordProblem, passwordLength, nameKey, BusyError,
  MIN_LENGTH, MAX_LENGTH, makeResetCode, hashResetCode, resetCodeMatches, RESET_TTL_MS, warmUp,
  normalizeEmail, maskEmail
} from './password.js';
import { createBackoff, createWindow } from './rate-limit.js';
import {
  listPasskeys, addPasskeyRecord, renamePasskeyRecord, removePasskeyRecord, passkeyRemovalRefused, MAX_PASSKEYS,
  transportsOf,
} from './passkeys-store.js';
import { createDeviceLink, findDeviceLink, burnDeviceLink, dropDeviceLinks, recoveryLinkOf, RECOVERY_TTL_MS } from './device-link.js';
import {
  createWatchCode, takeWatchCode, dropWatchCodes, createWatchLink, findWatchLink, touchWatchLink, listWatchLinks,
  dropWatchLinks, boxOf, putSnapshot, pushEvents, queuedEvents, ackEvents
} from './watch-relay.js';
import { startAdminSocket } from './admin-socket.js';
import { createMediaStore, mediaLimits, mediaConfig, MediaError, HASH_RE, referencedHashes } from './media.js';
import { effectiveRoutineId } from './queue.js';
import { stampPut } from './sync-stamps.js';
import { atomicWrite as durableWrite, syncDir } from './durable.js';
import { adoptPrescriptionState, prescriptionStateReadable } from './prescription-adoption.js';
import { StateWriteQueue, StateWriteQueueFullError } from './state-write-queue.js';
import { ipv6Groups, guardedLookup, pushEndpointError, MAX_PUSH_ENDPOINT } from './net-guard.js';
import { createIntegrations } from './integrations/index.js';
import { integrationRoutes } from './integrations/routes.js';
import { excusedOn, nudgeFor, nudgeWindowOpen, toneOf } from './nudge.js';
import { wrappedPushYear, wrappedSummary, wrappedPushOwed, wrappedPush } from './wrapped.js';
import {
  B2B2CDataError, B2B2C_LIMITS as B2B2C_DEFAULT_LIMITS, migrateB2B2C, compactB2B2C, profileOf, validateProfile, validateScopes,
  capabilitiesFor, makeOpaqueInvite, hashInviteToken, makeEntityId, linkForActor, serializeLink,
  authorizeAthleteAccess, validatePrescriptionRoutine, serializePrescription, validateAssessment, removeB2B2CUser,
  validateMealPlan, validateMealAdherence, validateNutritionState, serializeMealPlan,
  PARQ_QUESTIONS, PARQ_VERSION,
} from './b2b2c.js';
import {
  COMMUNICATION_HABITS_LIMITS, createCommunicationHabitsRoutes, validateCommunicationHabitsLimits,
} from './communication-habits.js';
import {
  calculateAssessmentResults, createProgressRoutes, PROGRESS_LIMITS, reconcileProgressScopes, validateProgressState,
} from './progress-analytics.js';
import {
  cancelFutureAppointmentsForLink, createSchedulingRoutes, reconcileAppointmentReminders, SCHEDULING_LIMITS, validateSchedulingState,
} from './scheduling.js';
import { createReminderDispatcher, REMINDER_DISPATCH_DEFAULTS } from './reminder-dispatcher.js';
import { SerialWriteQueue } from './serial-write-queue.js';
import { createInterprocessLock, mergeDbCandidate } from './db-coordinator.js';

const PORT = +(process.env.PORT || 3000);
const DATA = process.env.DATA_DIR || '/data';
const RP_ID = process.env.RP_ID || 'localhost';
const ORIGIN = process.env.ORIGIN || 'http://localhost:8080';
const RP_NAME = process.env.RP_NAME || 'openGym';
// Admin dashboard (issue): admins are matched by uid (or the admin flag FIRST_USER_ADMIN sets);
// INVITE_ONLY gates new signups behind a code the admin generates. Off by default, so a fresh
// self-hosted instance stays open.
const ADMIN_UIDS = (process.env.ADMIN_UIDS || '').split(',').map(s => s.trim()).filter(Boolean);
const INVITE_ONLY = /^(1|true|yes|on)$/i.test(process.env.INVITE_ONLY || '');
// The first profile made on an instance with no profiles at all becomes its admin (#328), so a
// fresh install has someone who can open the admin dashboard without editing ADMIN_UIDS and
// restarting. Stored on the user record (user.admin), which isAdmin already honours. It is
// decided at the moment of registration only: an instance that already has profiles changes
// nothing on upgrade. Default OFF: an existing instance with no profiles yet (guest-only, or phones
// kept local) would otherwise hand admin to whoever signs up first after the upgrade.
// FIRST_USER_ADMIN=1 turns it on for a fresh install.
const FIRST_USER_ADMIN = /^(1|true|yes|on)$/i.test(process.env.FIRST_USER_ADMIN || '');
// Checked synchronously right before db.users.push, with no await in between, so two
// registrations racing each other cannot both see an empty instance.
function claimFirstAdmin(req, user) {
  if (!FIRST_USER_ADMIN || db.users.length !== 0) return;
  user.admin = true;
  user.owner = true;
  audit(req, 'admin.first-user', { user });
}
// Guest mode ("Continue without account") keeps everything in the browser and never touches this
// server — but on an instance meant for a known set of people, an entrance nobody can walk back
// out of is still the wrong front door (#42). Default ON, so existing instances are unchanged;
// the polarity is inverted from INVITE_ONLY because the safe default here is the permissive one.
const ALLOW_GUEST = !/^(0|false|no|off)$/i.test(process.env.ALLOW_GUEST || '');
// Name-and-password sign-in next to passkeys (#118). Off by default: it adds a second way into
// every account that opts in, so an instance has to ask for it. While it is off every password
// route answers 404 and the app shows none of it; hashes already stored stay where they are.
const PASSWORD_LOGIN = /^(1|true|yes|on)$/i.test(process.env.PASSWORD_LOGIN || '');
// The language the sign-in screen, and every profile that never picked one, starts in (#303) —
// for an instance whose people share a language. Only a tag's shape is checked here; the app
// matches it against the languages it has and ignores one it does not know. Unset, it is left
// out of /api/config and the app behaves as before.
const DEFAULT_LANG = (() => {
  const v = String(process.env.DEFAULT_LANG || '').trim();
  if (!v) return '';
  if (/^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})?$/.test(v)) return v;
  console.warn(`DEFAULT_LANG "${v.slice(0, 40)}" is not a language tag such as pt-BR or de — ignored`);
  return '';
})();
// Whether the address a request came from may be read from the headers a proxy sets. Only the
// sign-in throttle asks (limitAddress below); the bundled compose file sets it, because the API
// is reachable there only through the web container, which overwrites those headers.
const TRUST_PROXY = /^(1|true|yes|on)$/i.test(process.env.TRUST_PROXY || '');
const envInt = (name, fallback, { min = 0, max = 1000000 } = {}) => {
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
};
const B2B2C_LIMITS = {
  pendingPerCoach: envInt('B2B2C_PENDING_INVITES_PER_COACH', 10, { min: 1, max: 1000 }),
  maxInvites: envInt('B2B2C_MAX_INVITES', 5000, { min: 10, max: 1000000 }),
  maxLinks: envInt('B2B2C_MAX_LINKS', 5000, { min: 1, max: 1000000 }),
  maxPrescriptions: envInt('B2B2C_MAX_PRESCRIPTIONS', 5000, { min: 10, max: 1000000 }),
  prescriptionsPerAthlete: envInt('B2B2C_PRESCRIPTIONS_PER_ATHLETE', 100, { min: 1, max: 10000 }),
  maxAssessmentsPerAthlete: envInt('B2B2C_ASSESSMENTS_PER_ATHLETE', B2B2C_DEFAULT_LIMITS.maxAssessmentsPerAthlete, { min: 1, max: 10000 }),
  maxAssessments: envInt('B2B2C_MAX_ASSESSMENTS', B2B2C_DEFAULT_LIMITS.maxAssessments, { min: 1, max: 1000000 }),
  assessmentRetentionDays: envInt('B2B2C_ASSESSMENT_RETENTION_DAYS', B2B2C_DEFAULT_LIMITS.assessmentRetentionDays, { min: 30, max: 36500 }),
  maxMealPlansPerAthlete: envInt('B2B2C_MEAL_PLANS_PER_ATHLETE', B2B2C_DEFAULT_LIMITS.maxMealPlansPerAthlete, { min: 1, max: 1000 }),
  maxMealPlans: envInt('B2B2C_MAX_MEAL_PLANS', B2B2C_DEFAULT_LIMITS.maxMealPlans, { min: 1, max: 1000000 }),
  maxMealAdherencePerAthlete: envInt('B2B2C_MEAL_ADHERENCE_PER_ATHLETE', B2B2C_DEFAULT_LIMITS.maxMealAdherencePerAthlete, { min: 1, max: 10000 }),
  maxMealAdherence: envInt('B2B2C_MAX_MEAL_ADHERENCE', B2B2C_DEFAULT_LIMITS.maxMealAdherence, { min: 1, max: 1000000 }),
  mealAdherenceRetentionDays: envInt('B2B2C_MEAL_ADHERENCE_RETENTION_DAYS', B2B2C_DEFAULT_LIMITS.mealAdherenceRetentionDays, { min: 1, max: 36500 }),
  maxMessagesPerLink: envInt('B2B2C_MESSAGES_PER_LINK', COMMUNICATION_HABITS_LIMITS.maxMessagesPerLink, { min: 1, max: 10000 }),
  maxMessages: envInt('B2B2C_MAX_MESSAGES', COMMUNICATION_HABITS_LIMITS.maxMessages, { min: 1, max: 1000000 }),
  messageRetentionDays: envInt('B2B2C_MESSAGE_RETENTION_DAYS', COMMUNICATION_HABITS_LIMITS.messageRetentionDays, { min: 1, max: 36500 }),
  maxHabitsPerLink: envInt('B2B2C_HABITS_PER_LINK', COMMUNICATION_HABITS_LIMITS.maxHabitsPerLink, { min: 1, max: 1000 }),
  maxHabits: envInt('B2B2C_MAX_HABITS', COMMUNICATION_HABITS_LIMITS.maxHabits, { min: 1, max: 1000000 }),
  archivedHabitRetentionDays: envInt('B2B2C_ARCHIVED_HABIT_RETENTION_DAYS', COMMUNICATION_HABITS_LIMITS.archivedHabitRetentionDays, { min: 1, max: 36500 }),
  maxCheckinsPerHabit: envInt('B2B2C_CHECKINS_PER_HABIT', COMMUNICATION_HABITS_LIMITS.maxCheckinsPerHabit, { min: 1, max: 10000 }),
  maxCheckinsPerLink: envInt('B2B2C_CHECKINS_PER_LINK', COMMUNICATION_HABITS_LIMITS.maxCheckinsPerLink, { min: 1, max: 100000 }),
  maxCheckins: envInt('B2B2C_MAX_CHECKINS', COMMUNICATION_HABITS_LIMITS.maxCheckins, { min: 1, max: 1000000 }),
  checkinRetentionDays: envInt('B2B2C_CHECKIN_RETENTION_DAYS', COMMUNICATION_HABITS_LIMITS.checkinRetentionDays, { min: 1, max: 36500 }),
  maxGoalsPerLink: envInt('B2B2C_PROGRESS_GOALS_PER_LINK', PROGRESS_LIMITS.maxGoalsPerLink, { min: 1, max: 1000 }),
  maxGoals: envInt('B2B2C_MAX_PROGRESS_GOALS', PROGRESS_LIMITS.maxGoals, { min: 1, max: 1000000 }),
  maxTerminalGoals: envInt('B2B2C_MAX_TERMINAL_PROGRESS_GOALS', PROGRESS_LIMITS.maxTerminalGoals, { min: 1, max: 5000000 }),
  goalRetentionDays: envInt('B2B2C_PROGRESS_GOAL_RETENTION_DAYS', PROGRESS_LIMITS.goalRetentionDays, { min: 1, max: 36500 }),
  maxReportsPerLink: envInt('B2B2C_PROGRESS_REPORTS_PER_LINK', PROGRESS_LIMITS.maxReportsPerLink, { min: 1, max: 10000 }),
  maxReports: envInt('B2B2C_MAX_PROGRESS_REPORTS', PROGRESS_LIMITS.maxReports, { min: 1, max: 1000000 }),
  maxTerminalReports: envInt('B2B2C_MAX_TERMINAL_PROGRESS_REPORTS', PROGRESS_LIMITS.maxTerminalReports, { min: 1, max: 5000000 }),
  reportRetentionDays: envInt('B2B2C_PROGRESS_REPORT_RETENTION_DAYS', PROGRESS_LIMITS.reportRetentionDays, { min: 1, max: 36500 }),
  maxReportBytes: envInt('B2B2C_PROGRESS_REPORT_MAX_BYTES', PROGRESS_LIMITS.maxReportBytes, { min: 16384, max: 5 * 1024 * 1024 }),
  maxPendingAccountCleanupJobs: envInt('B2B2C_MAX_PENDING_ACCOUNT_CLEANUP_JOBS', B2B2C_DEFAULT_LIMITS.maxPendingAccountCleanupJobs, { min: 1, max: 1000000 }),
  maxCompleteAccountCleanupJobs: envInt('B2B2C_MAX_COMPLETE_ACCOUNT_CLEANUP_JOBS', B2B2C_DEFAULT_LIMITS.maxCompleteAccountCleanupJobs, { min: 1, max: 1000000 }),
  maxFailedAccountCleanupJobs: envInt('B2B2C_MAX_FAILED_ACCOUNT_CLEANUP_JOBS', B2B2C_DEFAULT_LIMITS.maxFailedAccountCleanupJobs, { min: 1, max: 1000000 }),
  accountCleanupCompleteRetentionDays: envInt('B2B2C_ACCOUNT_CLEANUP_COMPLETE_RETENTION_DAYS', B2B2C_DEFAULT_LIMITS.accountCleanupCompleteRetentionDays, { min: 1, max: 3650 }),
  accountCleanupFailedRetentionDays: envInt('B2B2C_ACCOUNT_CLEANUP_FAILED_RETENTION_DAYS', B2B2C_DEFAULT_LIMITS.accountCleanupFailedRetentionDays, { min: 1, max: 3650 }),
  terminalInvitesKeep: envInt('B2B2C_TERMINAL_INVITES_KEEP', 1000, { max: 100000 }),
  terminalLinksKeep: envInt('B2B2C_TERMINAL_LINKS_KEEP', 1000, { max: 100000 }),
  terminalPrescriptionsKeep: envInt('B2B2C_TERMINAL_PRESCRIPTIONS_KEEP', 1000, { max: 100000 }),
  terminalRetentionDays: envInt('B2B2C_TERMINAL_RETENTION_DAYS', 90, { max: 3650 }),
  maxActiveAppointmentsPerLink: envInt('B2B2C_ACTIVE_APPOINTMENTS_PER_LINK', SCHEDULING_LIMITS.maxActiveAppointmentsPerLink, { min: 1, max: 100000 }),
  maxActiveAppointments: envInt('B2B2C_MAX_ACTIVE_APPOINTMENTS', SCHEDULING_LIMITS.maxActiveAppointments, { min: 1, max: 1000000 }),
  maxTerminalAppointmentsPerLink: envInt('B2B2C_TERMINAL_APPOINTMENTS_PER_LINK', SCHEDULING_LIMITS.maxTerminalAppointmentsPerLink, { min: 1, max: 1000000 }),
  maxTerminalAppointments: envInt('B2B2C_MAX_TERMINAL_APPOINTMENTS', SCHEDULING_LIMITS.maxTerminalAppointments, { min: 1, max: 5000000 }),
  appointmentRetentionDays: envInt('B2B2C_APPOINTMENT_RETENTION_DAYS', SCHEDULING_LIMITS.appointmentRetentionDays, { min: 1, max: 36500 }),
  reminderRetentionDays: envInt('B2B2C_SCHEDULING_REMINDER_RETENTION_DAYS', SCHEDULING_LIMITS.reminderRetentionDays, { min: 1, max: 3650 }),
  maxReminderStates: envInt('B2B2C_MAX_APPOINTMENT_REMINDER_STATES', SCHEDULING_LIMITS.maxReminderStates, { min: 1, max: 5000000 }),
  maxReminderOutbox: envInt('B2B2C_MAX_SCHEDULING_REMINDER_OUTBOX', SCHEDULING_LIMITS.maxReminderOutbox, { min: 1, max: 5000000 }),
};
validateCommunicationHabitsLimits(B2B2C_LIMITS);
const B2B2C_RATE = {
  windowMs: envInt('B2B2C_RATE_WINDOW_MS', 3600000, { min: 1000, max: 86400000 }),
  createAccount: envInt('B2B2C_INVITE_CREATE_ACCOUNT_MAX', 20, { min: 1, max: 10000 }),
  createIp: envInt('B2B2C_INVITE_CREATE_IP_MAX', 100, { min: 1, max: 100000 }),
  acceptAccount: envInt('B2B2C_INVITE_ACCEPT_ACCOUNT_MAX', 30, { min: 1, max: 10000 }),
  acceptIp: envInt('B2B2C_INVITE_ACCEPT_IP_MAX', 200, { min: 1, max: 100000 }),
  assessmentAccount: envInt('B2B2C_ASSESSMENT_CREATE_ACCOUNT_MAX', 60, { min: 1, max: 10000 }),
  assessmentIp: envInt('B2B2C_ASSESSMENT_CREATE_IP_MAX', 300, { min: 1, max: 100000 }),
  mealPlanAccount: envInt('B2B2C_MEAL_PLAN_MUTATION_ACCOUNT_MAX', envInt('B2B2C_MEAL_PLAN_CREATE_ACCOUNT_MAX', 120, { min: 1, max: 10000 }), { min: 1, max: 10000 }),
  mealPlanIp: envInt('B2B2C_MEAL_PLAN_MUTATION_IP_MAX', envInt('B2B2C_MEAL_PLAN_CREATE_IP_MAX', 600, { min: 1, max: 100000 }), { min: 1, max: 100000 }),
  mealAdherenceAccount: envInt('B2B2C_MEAL_ADHERENCE_MUTATION_ACCOUNT_MAX', 600, { min: 1, max: 10000 }),
  mealAdherenceIp: envInt('B2B2C_MEAL_ADHERENCE_MUTATION_IP_MAX', 3000, { min: 1, max: 100000 }),
  messageAccount: envInt('B2B2C_MESSAGE_MUTATION_ACCOUNT_MAX', 120, { min: 1, max: 10000 }),
  messageIp: envInt('B2B2C_MESSAGE_MUTATION_IP_MAX', 600, { min: 1, max: 100000 }),
  checkinAccount: envInt('B2B2C_HABIT_CHECKIN_ACCOUNT_MAX', 600, { min: 1, max: 10000 }),
  checkinIp: envInt('B2B2C_HABIT_CHECKIN_IP_MAX', 3000, { min: 1, max: 100000 }),
  habitAccount: envInt('B2B2C_HABIT_MUTATION_ACCOUNT_MAX', 120, { min: 1, max: 10000 }),
  habitIp: envInt('B2B2C_HABIT_MUTATION_IP_MAX', 600, { min: 1, max: 100000 }),
  readAccount: envInt('B2B2C_MESSAGE_READ_ACCOUNT_MAX', 600, { min: 1, max: 10000 }),
  readIp: envInt('B2B2C_MESSAGE_READ_IP_MAX', 3000, { min: 1, max: 100000 }),
  progressMutationAccount: envInt('B2B2C_PROGRESS_MUTATION_ACCOUNT_MAX', 120, { min: 1, max: 10000 }),
  progressMutationIp: envInt('B2B2C_PROGRESS_MUTATION_IP_MAX', 600, { min: 1, max: 100000 }),
  progressExportAccount: envInt('B2B2C_PROGRESS_EXPORT_ACCOUNT_MAX', 120, { min: 1, max: 10000 }),
  progressExportIp: envInt('B2B2C_PROGRESS_EXPORT_IP_MAX', 600, { min: 1, max: 100000 }),
  schedulingMutationAccount: envInt('B2B2C_SCHEDULING_MUTATION_ACCOUNT_MAX', 60, { min: 1, max: 10000 }),
  schedulingMutationIp: envInt('B2B2C_SCHEDULING_MUTATION_IP_MAX', 300, { min: 1, max: 100000 }),
  schedulingStatusAccount: envInt('B2B2C_SCHEDULING_REMINDER_STATUS_ACCOUNT_MAX', 120, { min: 1, max: 10000 }),
  schedulingStatusIp: envInt('B2B2C_SCHEDULING_REMINDER_STATUS_IP_MAX', 600, { min: 1, max: 100000 }),
  schedulingReadAccount: envInt('B2B2C_SCHEDULING_READ_ACCOUNT_MAX', 600, { min: 1, max: 10000 }),
  schedulingReadIp: envInt('B2B2C_SCHEDULING_READ_IP_MAX', 3000, { min: 1, max: 100000 }),
};
const REMINDER_DISPATCH_CONFIG = Object.freeze({
  tickMs: envInt('B2B2C_SCHEDULING_REMINDER_TICK_MS', REMINDER_DISPATCH_DEFAULTS.tickMs, { min: 50, max: 3600000 }),
  leaseMs: envInt('B2B2C_SCHEDULING_REMINDER_LEASE_MS', REMINDER_DISPATCH_DEFAULTS.leaseMs, { min: 1000, max: 86400000 }),
  baseRetryMs: envInt('B2B2C_SCHEDULING_REMINDER_RETRY_BASE_MS', REMINDER_DISPATCH_DEFAULTS.baseRetryMs, { min: 1000, max: 86400000 }),
  maxRetryMs: envInt('B2B2C_SCHEDULING_REMINDER_RETRY_MAX_MS', REMINDER_DISPATCH_DEFAULTS.maxRetryMs, { min: 1000, max: 7 * 86400000 }),
  maxAttempts: envInt('B2B2C_SCHEDULING_REMINDER_MAX_ATTEMPTS', REMINDER_DISPATCH_DEFAULTS.maxAttempts, { min: 1, max: 100 }),
  batchSize: envInt('B2B2C_SCHEDULING_REMINDER_BATCH_SIZE', REMINDER_DISPATCH_DEFAULTS.batchSize, { min: 1, max: 10000 }),
  lockLeaseMs: envInt('B2B2C_SCHEDULING_REMINDER_LOCK_LEASE_MS', REMINDER_DISPATCH_DEFAULTS.lockLeaseMs, { min: 1000, max: 300000 }),
  lockTimeoutMs: envInt('B2B2C_SCHEDULING_REMINDER_LOCK_TIMEOUT_MS', REMINDER_DISPATCH_DEFAULTS.lockTimeoutMs, { min: 50, max: 300000 }),
  lockRetryMs: envInt('B2B2C_SCHEDULING_REMINDER_LOCK_RETRY_MS', REMINDER_DISPATCH_DEFAULTS.lockRetryMs, { min: 1, max: 10000 }),
});
const ASSESSMENT_FUTURE_SKEW_MS = envInt('B2B2C_ASSESSMENT_FUTURE_SKEW_SECONDS', 300, { min: 0, max: 3600 }) * 1000;
const ASSESSMENT_MAX_AGE_YEARS = envInt('B2B2C_ASSESSMENT_MAX_AGE_YEARS', 100, { min: 1, max: 150 });
// 90 days keeps someone who trains a few times a week permanently signed in without a stolen
// cookie staying good for a year. Overridable because a family instance and one on the open
// internet don't want the same number. Only affects cookies minted from now on — the expiry is
// baked into each cookie when it's issued, so lowering this never cuts an existing session short.
const SESSION_DAYS = Math.max(1, +(process.env.SESSION_DAYS || 90) || 90);
const MAX_BODY = 5 * 1024 * 1024;
// Secure cookies require HTTPS; over plain http://localhost the flag would drop the cookie
const SECURE = /^https:/i.test(ORIGIN) ? ' Secure;' : '';

fs.mkdirSync(DATA, { recursive: true });
/* The secrets are locked down file by file rather than by sealing the whole directory.
 *
 * A blanket `chmod 0700` on DATA looks stronger and is worse: ./data is a host bind mount and
 * this container runs as root, so it lands on the host as root-owned 0700 and anything else
 * the owner runs against their own data directory — a backup script, the MCP server in #19,
 * their own `jq` — gets EACCES on files that are theirs. Locking the four files that actually
 * hold secrets keeps the Coach runtime out of them without taking the directory hostage.
 *
 * Best-effort throughout: a bind-mounted host filesystem may refuse chmod, and that is not a
 * reason to refuse to boot. The privilege drop in adapters/spawn.js is the control that does
 * fail closed. */
const lock = f => { try { fs.chmodSync(path.join(DATA, f), 0o600); } catch { /* not present yet, or host says no */ } };
['secret', 'db.json', 'coach.json'].forEach(lock);

/* ---------- secret + db ---------- */
const secretFile = path.join(DATA, 'secret');
if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
const SECRET = fs.readFileSync(secretFile, 'utf8').trim();
// Integrations (integrations/, docs/INTEGRATIONS.md): off unless INTEGRATIONS names some. Their
// connections live in DATA_DIR/integrations/, sealed with a key derived from SECRET.
const integrations = createIntegrations({ dataDir: DATA, secret: SECRET, version: '1' });

const dbFile = path.join(DATA, 'db.json');
const dbWriteLock = createInterprocessLock({
  lockPath: dbFile + '.lock',
  leaseMs: REMINDER_DISPATCH_CONFIG.lockLeaseMs,
  acquireTimeoutMs: REMINDER_DISPATCH_CONFIG.lockTimeoutMs,
  retryMs: REMINDER_DISPATCH_CONFIG.lockRetryMs,
});
const dbTxnFile = dbFile + '.txn';
const dbTxnOldFile = dbFile + '.txn.old';
const dbTxnNewFile = dbFile + '.txn.new';
function removeDbTransactionFiles({ strict = false } = {}) {
  for (const file of [dbTxnFile, dbTxnOldFile, dbTxnNewFile, dbFile + '.next', dbFile + '.bak.next']) {
    try { fs.unlinkSync(file); }
    catch (error) {
      if (error.code === 'ENOENT') continue;
      if (strict) throw error;
      console.error('db transaction cleanup failed', path.basename(file), error.message);
    }
  }
  syncDir(DATA);
}
function reconcileDbTransaction() {
  if (!fs.existsSync(dbTxnFile)) return;
  const transaction = JSON.parse(fs.readFileSync(dbTxnFile, 'utf8'));
  if (!transaction || !['prepared', 'committed'].includes(transaction.phase)) throw new Error('invalid db transaction journal');
  const source = transaction.phase === 'committed' ? dbTxnNewFile : dbTxnOldFile;
  const snapshot = JSON.parse(fs.readFileSync(source, 'utf8'));
  if (!snapshot || typeof snapshot.exists !== 'boolean' || typeof snapshot.text !== 'string') throw new Error('invalid db transaction snapshot');
  if (snapshot.exists) {
    atomicWrite(dbFile, snapshot.text, 0o600);
    atomicWrite(dbFile + '.bak', snapshot.text, 0o600);
  } else {
    for (const file of [dbFile, dbFile + '.bak']) {
      try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    syncDir(DATA);
  }
  removeDbTransactionFiles({ strict: true });
}
// Every account, passkey and invite. Only a missing file starts empty: an unreadable one (a write
// cut short by a power loss, a damaged restore) used to boot with no users at all, and the first
// save then replaced it — every profile locked out, every training history orphaned, and with
// FIRST_USER_ADMIN the first visitor made admin. Now the damaged file is kept aside and the copy
// saveDb keeps of each version it writes (db.json.bak) is used; with neither readable the server
// refuses to start, saying why, rather than start as a new instance.
function loadDb() {
  reconcileDbTransaction();
  let raw;
  try { raw = fs.readFileSync(dbFile, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return { users: [], creds: [], subs: [], invites: [] }; throw e; }
  const parse = text => { const v = JSON.parse(text); if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object'); return v; };
  try { return parse(raw); } catch (err) {
    const aside = `${dbFile}.unreadable-${Date.now()}`;
    try { fs.copyFileSync(dbFile, aside); } catch { /* the original stays where it is anyway */ }
    console.error(`db.json cannot be read (${err.message}); kept a copy as ${path.basename(aside)}`);
    try {
      const bak = parse(fs.readFileSync(dbFile + '.bak', 'utf8'));
      console.error('db.json: using db.json.bak, the copy of the last save');
      return bak;
    } catch {
      console.error('db.json: no readable db.json.bak either. Refusing to start: restore db.json from a backup.');
      process.exit(1);
    }
  }
}
let db = dbWriteLock.withLockSync(() => loadDb());
let persistedDb = structuredClone(db);
let b2b2cMigrated = false;
try {
  for (const key of ['users', 'creds', 'subs', 'invites', 'deviceLinks']) {
    if (db[key] === undefined) { db[key] = []; b2b2cMigrated = true; continue; }
    if (!Array.isArray(db[key])) throw new B2B2CDataError(`${key} must be an array`);
  }
  b2b2cMigrated = migrateB2B2C(db) || b2b2cMigrated;
  b2b2cMigrated = compactB2B2C(db, B2B2C_LIMITS).changed || b2b2cMigrated;
} catch (error) {
  if (!(error instanceof B2B2CDataError)) throw error;
  console.error(`db.json B2B2C data is invalid (${error.message}). Refusing to start; db.json and db.json.bak were not changed.`);
  process.exit(1);
}
const isAdmin = user => !!user && (user.admin === true || ADMIN_UIDS.includes(user.id));
// One owner per instance, any number of admins. Admins run the place day to day (users, invites,
// the Coach); the owner is the one admin the others cannot act on: only the owner appoints or
// removes admins, deletes an admin's account, hands the role on, or clears the activity log.
// Without this any admin could delete every other admin and then wipe the log of having done it.
// The owner is whoever carries `owner: true` (the first profile under FIRST_USER_ADMIN, or a
// handover); an instance from before the role has none, so it falls to the first ADMIN_UIDS entry
// that has a profile, then to the oldest admin record. Decided on every call, never cached, so a
// deleted or demoted owner cannot leave the instance without one.
function ownerId() {
  const flagged = db.users.find(u => u.owner === true && isAdmin(u));
  if (flagged) return flagged.id;
  const fromEnv = ADMIN_UIDS.find(id => db.users.some(u => u.id === id));
  if (fromEnv) return fromEnv;
  return db.users.find(isAdmin)?.id || null;
}
const isOwner = user => !!user && isAdmin(user) && user.id === ownerId();
// 0600: db.json holds passkey credential material. It used to be covered by a blanket 0700 on
// the whole directory; now that the directory stays traversable, the file carries its own mode.
// Once the new version is on disk, a second copy of it goes to db.json.bak, the same durable
// way: loadDb falls back to it. A copy of the version being replaced, as it used to be, lost
// whatever the last save wrote (a profile just created) when db.json was later found unreadable.
// A write cut short leaves the previous db.json.bak whole (temporary file and rename).
function saveDbUnlocked(candidate = db) {
  const failMarker = process.env.B2B2C_DB_FAIL_FILE;
  if (failMarker && fs.existsSync(failMarker)) {
    fs.unlinkSync(failMarker);
    throw new Error('injected db write failure');
  }
  const text = JSON.stringify(candidate, null, 2);
  const previous = fs.existsSync(dbFile) ? fs.readFileSync(dbFile, 'utf8') : '';
  atomicWrite(dbTxnOldFile, JSON.stringify({ exists: fs.existsSync(dbFile), text: previous }), 0o600);
  atomicWrite(dbTxnNewFile, JSON.stringify({ exists: true, text }), 0o600);
  atomicWrite(dbTxnFile, JSON.stringify({ phase: 'prepared' }), 0o600);
  atomicWrite(dbFile + '.next', text, 0o600);
  const backupFailMarker = process.env.B2B2C_DB_BACKUP_FAIL_FILE;
  if (backupFailMarker && fs.existsSync(backupFailMarker)) {
    fs.unlinkSync(backupFailMarker);
    throw new Error('injected db backup write failure');
  }
  atomicWrite(dbFile + '.bak.next', text, 0o600);
  fs.renameSync(dbFile + '.bak.next', dbFile + '.bak');
  syncDir(DATA);
  fs.renameSync(dbFile + '.next', dbFile);
  syncDir(DATA);
  atomicWrite(dbTxnFile, JSON.stringify({ phase: 'committed' }), 0o600);
  removeDbTransactionFiles();
}
function replaceDbObject(target, source) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, structuredClone(source));
}
function saveDb(candidate = db) {
  return dbWriteLock.withLockSync(() => {
    saveDbUnlocked(candidate);
    persistedDb = structuredClone(candidate);
  });
}
function publishDb(candidate) {
  replaceDbObject(db, candidate);
  persistedDb = structuredClone(candidate);
}
if (b2b2cMigrated) saveDb();
// Flushed before and after the rename (durable.js): a host reset must not bring back the file
// the client was told had been replaced.
function atomicWrite(file, content, mode) { durableWrite(file, content, mode); }
// How many earlier write ids a document keeps (`_wids`, see PUT /api/data): a device that last
// synced more writes ago than this merges on its next pull instead of taking the server's copy.
const WID_KEEP = 50;
const stateFile = uid => path.join(DATA, 'state-' + uid.replace(/[^a-zA-Z0-9_-]/g, '') + '.json');
// Every read/transform/write of a profile document shares this queue. Entries exist only while a
// user has an active or waiting write, so an instance that sees many users does not retain a lock
// per user forever.
const stateWrites = new StateWriteQueue({
  perKeyLimit: envInt('STATE_WRITE_PER_USER_MAX', 4, { min: 1, max: 100 }),
  globalLimit: envInt('STATE_WRITE_GLOBAL_MAX', 128, { min: 1, max: 10000 }),
});
function withStateWrite(uid, req, task) {
  const controller = new AbortController();
  const abort = () => controller.abort(Object.assign(new Error('client disconnected'), { clientGone: true }));
  req.once('aborted', abort);
  return stateWrites.run(stateFile(uid), task, { signal: controller.signal })
    .finally(() => req.removeListener('aborted', abort));
}
const STATE_WRITE_TEST_DIR = process.env.STATE_WRITE_TEST_DIR || '';
const stateWriteTestName = (point, uid) => path.join(STATE_WRITE_TEST_DIR, `${point}-${uid.replace(/[^a-zA-Z0-9_-]/g, '')}`);
function stateWriteTestMark(point, uid) {
  if (!STATE_WRITE_TEST_DIR) return;
  const name = stateWriteTestName(point, uid);
  if (fs.existsSync(name + '.watch')) fs.writeFileSync(name + '.reached', '');
}
async function stateWriteTestWait(point, uid) {
  if (!STATE_WRITE_TEST_DIR) return;
  const name = stateWriteTestName(point, uid);
  if (!fs.existsSync(name + '.wait')) return;
  fs.writeFileSync(name + '.reached', '');
  const deadline = Date.now() + 30000;
  while (!fs.existsSync(name + '.release')) {
    if (Date.now() >= deadline) throw new Error(`state write test barrier timed out: ${point}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
function stateWriteTestFail(point, uid) {
  if (!STATE_WRITE_TEST_DIR) return;
  const marker = stateWriteTestName(point, uid) + '.fail-once';
  if (!fs.existsSync(marker)) return;
  fs.unlinkSync(marker);
  throw new Error(`injected state write failure: ${point}`);
}
// The watch relay's mailbox of a profile (watch-relay.js): the page's last snapshot and what its
// Zepp OS watches sent. Small, rewritten whole like the state file.
const watchFile = uid => path.join(DATA, 'watch-' + uid.replace(/[^a-zA-Z0-9_-]/g, '') + '.json');
// When a profile last fetched its document (GET /api/data). The document's own `_ts` moves only
// on a push, so a device that only ever read — a second phone, a profile that trains elsewhere
// and just looks — showed "last sync never" in the admin dashboard (QA 1.3.9). Kept on the user
// record and written at most every ten minutes per profile, since every foreground return pulls.
const PULL_NOTE_MS = 10 * 60 * 1000;
function notePull(user, now = Date.now()) {
  if (user.lastPull && now - user.lastPull < PULL_NOTE_MS) return;
  user.lastPull = now;
  try { saveDb(); } catch (e) { console.error('db save failed', e.message); }
}
// The later of the last push and the last pull.
const lastSyncOf = (u, S) => Math.max(S?._ts || 0, u?.lastPull || 0) || null;
function readState(uid) {
  try { return JSON.parse(fs.readFileSync(stateFile(uid), 'utf8')); } catch { return null; }
}
// GET and PUT /api/data tell a profile with no state yet from one whose file cannot be read: the
// second answers 503 instead of an empty profile, which a device would adopt, or a write would
// replace, losing what a restore could still bring back.
const UNREADABLE = Symbol('unreadable');
function readStateStrict(uid) {
  let raw;
  try { raw = fs.readFileSync(stateFile(uid), 'utf8'); }
  catch (e) { return e.code === 'ENOENT' ? null : UNREADABLE; }
  try { return JSON.parse(raw); } catch { return UNREADABLE; }
}
// A stored document as a client gets it: without the server's own notes `_unstamped` and `_prior`.
function forClient(S) {
  if (!S || typeof S !== 'object' || !('_unstamped' in S || '_prior' in S)) return S;
  const { _unstamped, _prior, ...rest } = S;
  return rest;
}
// An entry is an object a reader can dereference, and `records` is every entry of a stored
// list. PUT /api/data drops the rest on the way in — a null workout, a routine that is a
// number — and refuses a list that is not an array at all, but a file written before it did
// answers to nobody, and the readers below walk those lists (`r.id`, `w.d`, `.slice()`). One
// throw inside an admin route is a 500 for that whole profile: the drill-down never leaves
// "Loading…", the Disable button lives inside it, and the account an operator opened the
// dashboard to stop is exactly the one they then cannot. Answering with the entries that are
// there is the honest reading of such a file — what was dropped carried nothing to show.
const record = x => !!x && typeof x === 'object' && !Array.isArray(x);
const records = v => (Array.isArray(v) ? v.filter(record) : []);

/* ---------- push notifications (Web Push / VAPID) ---------- */
const vapidFile = path.join(DATA, 'vapid.json');
let vapid;
try { vapid = JSON.parse(fs.readFileSync(vapidFile, 'utf8')); }
catch { vapid = webpush.generateVAPIDKeys(); fs.writeFileSync(vapidFile, JSON.stringify(vapid), { mode: 0o600 }); }
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || (SECURE ? ORIGIN : 'mailto:admin@localhost');
webpush.setVapidDetails(VAPID_SUBJECT, vapid.publicKey, vapid.privateKey);

/* A push subscription's `endpoint` is a URL this server connects out to, chosen by whoever is
   signed in — so without a check /api/push/* is a request-forgery lever, and the api container
   sits on the same Docker network as the rest of the self-hoster's stack. Three limits below:

   1. PUSH_AGENT rejects any connection to a private/loopback/link-local address at the moment
      the socket is opened. Validating the URL alone would leave a DNS-rebinding window — the
      name is resolved a second time inside web-push — so the check has to live in the lookup
      the request itself uses, not in a prior pass. A literal IP address never goes through
      that lookup at all — Node hands it straight to connect() — so literals are judged by
      pushEndpointError instead: at subscribe, and again in sendPush for an endpoint that got
      into db.json some other way.
   2. PUSH_TIMEOUT_MS: an endpoint that accepts TCP and then stalls used to hang the request
      handler that awaited it, indefinitely. web-push sets no timeout of its own.
   3. PUSH_CONCURRENCY: one small request must not turn into an unbounded burst of outbound
      connections (with MAX_SUBS_PER_USER below, that is the other half of the same problem). */
const PUSH_TIMEOUT_MS = 10000;
const PUSH_CONCURRENCY = 6;
const MAX_SUBS_PER_USER = 20;

// Same shape as dns.lookup (net-guard.js guardedLookup), so https.Agent can use it directly.
const PUSH_AGENT = new https.Agent({ lookup: guardedLookup, keepAlive: false });

// Real push services hand out endpoints of a few hundred characters (FCM, Mozilla, Apple are all
// well under 1 KB) and keys of 87 (p256dh, a 65-byte point) and 22 (auth, 16 bytes) base64url
// characters. Everything here lands in db.json, which every save rewrites whole, so nothing bigger
// is ever stored (GHSA-g65f-rj2m-6wj9).
// MAX_PUSH_ENDPOINT comes from net-guard.js, next to the endpoint check itself.
const MAX_PUSH_KEY = 256;
const PUSH_KEY_RE = /^[A-Za-z0-9_\-+/]+={0,2}$/;
function pushKeyError(v) {
  if (typeof v !== 'string' || !v || v.length > MAX_PUSH_KEY || !PUSH_KEY_RE.test(v)) return 'invalid subscription keys';
  return null;
}

// A db.json from before these limits may already carry an oversized row: drop it once at boot,
// before the next save has to write it again.
if (Array.isArray(db.subs)) {
  const n = db.subs.length;
  const tooBig = v => typeof v === 'string' && v.length > MAX_PUSH_KEY;
  // Only size decides here: a row is never dropped for its format, just for being too big to keep.
  db.subs = db.subs.filter(s => !(String(s?.endpoint ?? '').length > MAX_PUSH_ENDPOINT
    || tooBig(s?.keys?.p256dh) || tooBig(s?.keys?.auth)));
  if (db.subs.length !== n) { console.error(`push: dropped ${n - db.subs.length} oversized subscription(s)`); saveDb(); }
}

// `deviceId` narrows the send to the subscriptions one browser registered (the rest-timer alert
// belongs to the device that started the rest, #348); a subscription stored without one (an
// older client) still gets everything, as before. A resting device with no subscription of its
// own gets nothing: the phone in the bag must not ring for a rest timed on the desktop. The
// client re-sends its subscription with its id on every boot, so an id that changed heals there.
async function sendPush(userId, payload, deviceId) {
  let subs = db.subs.filter(s => s.userId === userId);
  if (deviceId) subs = subs.filter(s => !s.deviceId || s.deviceId === deviceId);
  if (!subs.length) return { status: 'unavailable', delivered: 0 };
  const body = JSON.stringify(payload);
  let dirty = false;
  let next = 0;
  let delivered = 0;
  let transientFailures = 0;
  const worker = async () => {
    while (next < subs.length) {
      const sub = subs[next++];
      // Re-judged before every send: PUSH_AGENT never sees a literal address, so an endpoint
      // that is private (however it got into db.json) is dropped here rather than connected to.
      const bad = pushEndpointError(sub.endpoint);
      if (bad) {
        console.error('push endpoint refused', bad);
        db.subs = db.subs.filter(s => s.endpoint !== sub.endpoint); dirty = true;
        continue;
      }
      // urgency 'high' is the one lever we have over delivery speed — iOS/Android throttle
      // low-urgency background push more aggressively under battery-saving modes. TTL is left
      // at the library default (long) so a briefly-offline device still gets it once reconnected,
      // rather than risking it being dropped for the sake of shaving off latency that TTL doesn't
      // actually control anyway.
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, body,
          { urgency: 'high', timeout: PUSH_TIMEOUT_MS, agent: PUSH_AGENT });
        delivered++;
      } catch (e) {
        console.error('push send failed', e.statusCode || 'network');
        // 404/410: the push service says the subscription is gone. 403: it refuses our VAPID
        // signature — a subscription made against a key this instance no longer has (data/vapid.json
        // regenerated). Neither will ever deliver again; keeping them only hides the fact from the
        // Settings toggle, which reads the browser's side. The client re-subscribes on its next boot.
        if (e.statusCode === 404 || e.statusCode === 410 || e.statusCode === 403) {
          db.subs = db.subs.filter(s => s.endpoint !== sub.endpoint); dirty = true;
        } else transientFailures++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PUSH_CONCURRENCY, subs.length) }, worker));
  // Pruning dead subscriptions is bookkeeping, not the send. Most callers do not await this
  // function at all (the rest-timer setTimeout, the Coach proposal hook), so a ./data that cannot
  // be written right now — disk full, read-only mount, EIO — would turn the throw into an
  // unhandled rejection and take the process down. The row is already gone from db.subs in
  // memory, so only the copy on disk lags: the next saveDb() that succeeds, from any route,
  // writes it out, and a restart re-reads the old file and prunes it again on the next send.
  if (dirty) { try { saveDb(); } catch (e) { console.error('push: could not save db.json', e.message); } }
  if (delivered) return { status: 'delivered', delivered };
  return { status: transientFailures ? 'retry' : 'unavailable', delivered: 0 };
}

// Rest-timer alerts: client schedules on start/extend, cancels on skip or on-screen completion —
// this only fires when the tab was backgrounded/suspended and never got to cancel it itself.
// One timer per device, not per account: a phone resting in the gym and a desktop tab at home
// each carry their own, so the tab's on-screen completion (which cancels) cannot silence the
// phone's alert. A client that sends no device id gets the old account-wide behaviour.
// In memory only — an API restart drops whatever is pending.
const restTimers = new Map(); // `${userId}:${deviceId}` -> Timeout
const restKey = (userId, deviceId) => `${userId}:${deviceId || ''}`;
// A browser holds one device id, so a person has a timer or two pending, never more than the
// devices they train with. Each request with a new id used to leave another hour-long timer (and
// its push to every id-less subscription) behind, without limit; past this many, the oldest goes.
const MAX_REST_TIMERS_PER_USER = 5;
function scheduleRestTimer(userId, deviceId, sec, lang) {
  const k = restKey(userId, deviceId);
  const t = restTimers.get(k);
  if (t) clearTimeout(t);
  restTimers.delete(k);                     // re-inserted below, so the map stays oldest first
  const mine = [...restTimers.keys()].filter(x => x.startsWith(userId + ':'));
  for (const old of mine.slice(0, Math.max(0, mine.length - MAX_REST_TIMERS_PER_USER + 1))) {
    clearTimeout(restTimers.get(old)); restTimers.delete(old);
  }
  restTimers.set(k, setTimeout(() => {
    restTimers.delete(k);
    sendPush(userId, restTimerPush(lang), deviceId);
  }, sec * 1000));
}
function cancelRestTimer(userId, deviceId) {
  // no device id: an older client — clear everything the account has pending, as it always did
  for (const [k, t] of restTimers) {
    if (deviceId ? k === restKey(userId, deviceId) : k.startsWith(userId + ':')) { clearTimeout(t); restTimers.delete(k); }
  }
}
// A device id is what the browser made up for itself (lib/push.js): one short token per browser
// profile, nothing identifying. Anything else is treated as absent.
const deviceIdOf = v => (typeof v === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(v) ? v : undefined);

// "Workout planned today" reminder — one per user per day, at their chosen time.
// effectiveRoutineId (queue-aware) lives in ./queue.js — see there for the DONE RULE.
// Computes "now" in an arbitrary IANA zone (e.g. "Europe/Lisbon") instead of the server's own —
// each user's reminder fires by their own clock, wherever they and their phone actually are.
function userNow(tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    }).formatToParts(new Date());
    const g = t => parts.find(p => p.type === t)?.value;
    const date = `${g('year')}-${g('month')}-${g('day')}`;
    // Weekday is derived from the zone's own date, not the server's — a Sunday-evening review
    // has to be Sunday where the user is, which is what the reminder already assumes for time.
    return { date, hhmm: `${g('hour')}:${g('minute')}`, weekday: new Date(date + 'T12:00:00Z').getUTCDay() };
  } catch { return null; } // unknown/invalid tz string — skip this user rather than guess
}
// The tick used to want the exact minute: `reminder.time === now.hhmm`, checked every 10 s. Any
// restart, redeploy or stalled event loop across that one minute lost the whole day's reminder —
// "sometimes it just doesn't come". A reminder that is due is now sent for up to this many
// minutes after its time, once per local date (`user.lastReminder`); later than that it is
// skipped rather than delivered at a time nobody asked for.
const REMINDER_WINDOW_MIN = 15;
// How often the tick looks. 10 s keeps a reminder within ~9 s of its minute; the tests shorten it.
const REMINDER_TICK_MS = Math.max(50, +(process.env.REMINDER_TICK_MS || 10000));
const hhmmToMin = v => {
  const m = /^(\d{2}):(\d{2})$/.exec(v || '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
};
// Minutes since the reminder's time on the user's clock; negative before it, NaN when either
// side does not parse. Same-day only — a 23:55 reminder is not owed at 00:05 the next day.
const minutesLate = (time, now) => hhmmToMin(now.hhmm) - hhmmToMin(time);
// The tick reads every subscribed user's state file every 10 s. Most of those files do not
// change between ticks; a stat is far cheaper than a read and a parse of a state that can be
// megabytes, and it keeps the tick short — a slow tick was one more way to miss the minute.
//
// What it holds is a whole parsed state per user, and a state can be megabytes, so the two
// bounds below are what keep it a cache rather than a leak on an instance with more than one
// person on it: an entry nobody has touched for ten minutes is dropped, and the map never holds
// more than STATE_CACHE_MAX users. Map iteration order is insertion order, so re-inserting on
// every hit makes the first key the least recently hit one — which is the one to evict.
const STATE_CACHE_MAX = 64;
// Ten minutes: far longer than the gap between a client's polls (30 s) or the reminder tick's
// (10 s), so nobody who is actually using the instance is ever evicted by age; the tests shorten
// it, as they do REMINDER_TICK_MS.
const STATE_CACHE_TTL_MS = Math.max(50, +(process.env.STATE_CACHE_TTL_MS || 600000) || 600000);
const stateCache = new Map(); // uid -> { mtimeMs, size, hitAt, S }
function readStateCached(uid) {
  let st;
  try { st = fs.statSync(stateFile(uid)); } catch { stateCache.delete(uid); return null; }
  const now = Date.now();
  for (const [k, v] of stateCache) if (now - v.hitAt > STATE_CACHE_TTL_MS) stateCache.delete(k);
  const hit = stateCache.get(uid);
  stateCache.delete(uid);                       // re-inserted below, so the map stays in hit order
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
    hit.hitAt = now;
    stateCache.set(uid, hit);
    return hit.S;
  }
  const S = readState(uid);
  stateCache.set(uid, { mtimeMs: st.mtimeMs, size: st.size, hitAt: now, S });
  while (stateCache.size > STATE_CACHE_MAX) stateCache.delete(stateCache.keys().next().value);
  return S;
}
function commitState(uid, previous, next, text) {
  atomicWrite(stateFile(uid), text);
  // mtime granularity and equal-sized revisions can otherwise leave this cache on the old copy.
  stateCache.delete(uid);
  if (MEDIA_ON) {
    try { MEDIA.noteState(uid, next); } catch (error) { console.error('media noteState', error); }
  }
  try { integrations.onStateWrite(uid, previous, next); } catch (error) { console.error('integrations onStateWrite', error); }
}

const ADOPTION_JOURNAL_PREFIX = 'prescription-adoption-';
const adoptionJournalFile = (uid, prescriptionId) => path.join(DATA,
  `${ADOPTION_JOURNAL_PREFIX}${uid.replace(/[^a-zA-Z0-9_-]/g, '')}-${prescriptionId.replace(/[^a-zA-Z0-9_-]/g, '')}.json`);
function readAdoptionJournal(file) {
  const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (journal?.version !== 1 || typeof journal.tx !== 'string' || typeof journal.uid !== 'string' ||
      typeof journal.prescriptionId !== 'string' || !Array.isArray(journal.routineIds) ||
      journal.routineIds.some(id => typeof id !== 'string') || typeof journal.at !== 'string') {
    throw new Error(`invalid prescription adoption journal ${path.basename(file)}`);
  }
  return journal;
}
function adoptionJournalFor(uid, prescriptionId, routineIds) {
  const file = adoptionJournalFile(uid, prescriptionId);
  try { return { file, journal: readAdoptionJournal(file) }; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const journal = {
    version: 1,
    tx: crypto.randomBytes(12).toString('hex'),
    uid,
    prescriptionId,
    routineIds: [...routineIds],
    at: new Date().toISOString(),
  };
  atomicWrite(file, JSON.stringify(journal), 0o600);
  return { file, journal };
}
function finishAdoptionJournal(file, journal, req) {
  const prescription = db.coachPrescriptions.find(item => item.id === journal.prescriptionId && item.athleteId === journal.uid);
  if (!prescription) throw new Error(`prescription ${journal.prescriptionId} from adoption journal is missing`);
  const coach = db.users.find(user => user.id === prescription.coachId);
  const current = readStateStrict(journal.uid);
  if (current === UNREADABLE || !prescriptionStateReadable(current)) throw new Error(`state unreadable for ${journal.uid}`);
  const adoption = adoptPrescriptionState(current, prescription, { now: Date.parse(journal.at) });
  if (adoption.routineIds.length !== journal.routineIds.length ||
      adoption.routineIds.some((id, index) => id !== journal.routineIds[index])) {
    throw new Error(`prescription adoption journal ${journal.tx} no longer matches state`);
  }
  if (adoption.changed) {
    const text = JSON.stringify(adoption.state);
    commitState(journal.uid, current, adoption.state, text);
    stateWriteTestFail('adoption-after-state', journal.uid);
  }

  const before = {
    state: prescription.state,
    updatedAt: prescription.updatedAt,
    adoptedAt: prescription.adoptedAt,
    adoptedRoutineIds: prescription.adoptedRoutineIds,
  };
  prescription.state = 'adopted';
  prescription.updatedAt = journal.at;
  prescription.adoptedAt ||= journal.at;
  prescription.adoptedRoutineIds = [...journal.routineIds];
  try { saveDb(); }
  catch (error) {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete prescription[key];
      else prescription[key] = value;
    }
    throw error;
  }

  const alreadyAudited = AUDIT_ON && auditLines().some(row => row.ev === 'b2b2c.prescription.adopt' && row.tx === journal.tx);
  if (!alreadyAudited && !audit(req, 'b2b2c.prescription.adopt', { user: db.users.find(user => user.id === journal.uid), target: coach, msg: prescription.id, tx: journal.tx })) {
    throw new Error(`could not audit prescription adoption ${journal.tx}`);
  }
  fs.unlinkSync(file);
  return { prescription, routineIds: [...journal.routineIds] };
}
function recoverAdoptionJournals() {
  const files = fs.readdirSync(DATA).filter(name => name.startsWith(ADOPTION_JOURNAL_PREFIX) && name.endsWith('.json')).sort();
  for (const name of files) {
    const file = path.join(DATA, name);
    const journal = readAdoptionJournal(file);
    finishAdoptionJournal(file, journal, { headers: {}, socket: {} });
    console.log('recovered prescription adoption', journal.prescriptionId, journal.uid);
  }
}
// Missed-workout nudge (nudge.js): opt-in on top of the reminder, so it needs everything the
// reminder does (a push subscription, the reminder on, a zone). Owed from 20:00 — or 2 h after the
// reminder — until 21:30 on the user's clock, the same catch-up idea as the reminder's window: a
// restart inside the evening still sends it. Once per local date (`user.lastNudge`), never while
// a workout is on screen, and nudgeFor() decides the day and the back-off.
function nudgeTick(user, S, now) {
  if (!S.reminder.nudge || user.lastNudge === now.date) return;
  if (!nudgeWindowOpen(S.reminder.time, now.hhmm)) return;
  if (livePresence(user.id)) return; // a session is under way — today's workout in the making
  const rid = nudgeFor(S, now.date);
  if (!rid) return;
  const routine = (S.routines || []).find(r => r?.id === rid);
  console.log('nudge firing', user.id, rid);
  user.lastNudge = now.date;
  saveDb();
  sendPush(user.id, nudgePush(S.lang, toneOf(S.reminder), routine, now.date));
}
// What the tick needs to know before it reads a whole state: the reminder settings and whether
// the Coach was agreed to, kept per user against the state file's mtime and size. The state cache
// above holds at most STATE_CACHE_MAX documents, and the tick walks every subscribed user in the
// same order, so past that many it missed on every lookup and parsed every state every 10 s: a
// handful of accounts with multi-megabyte states stalled the instance for everyone. A summary is
// a few bytes, so there is one for every user, and a full read happens only while one of that
// user's windows is open and something could still be sent.
const stateSummaries = new Map(); // uid -> { mtimeMs, size, rem, consent, settled }
function stateSummary(uid) {
  let st;
  try { st = fs.statSync(stateFile(uid)); } catch { stateSummaries.delete(uid); return null; }
  const had = stateSummaries.get(uid);
  if (had && had.mtimeMs === st.mtimeMs && had.size === st.size) return had;
  const S = readStateCached(uid);
  const r = S?.reminder;
  const sum = {
    mtimeMs: st.mtimeMs, size: st.size,
    rem: r && typeof r === 'object' ? { on: !!r.on, tz: r.tz, time: r.time, nudge: !!r.nudge } : { on: false },
    consent: !!S?.coach?.consent?.agreedAt,
    settled: '',   // a local date the reminder was found to owe nothing on, for this file
    wrapped: wrappedSummary(S),   // the December push (wrapped.js): a flag, a year, a few years
  };
  stateSummaries.set(uid, sum);
  return sum;
}
// "Your year in openGym" (wrapped.js): once per user and year, on Dec 1 from 18:00 server time.
// The year it went out for is written to db.json before the send, so a crash after it, a restart
// or the next tick cannot send it twice. Read from the summary only: no state is parsed for it.
function wrappedTick(user, sum, year) {
  if (!wrappedPushOwed(user, sum.wrapped, year)) return;
  console.log('wrapped push firing', user.id, year);
  user.wrappedPush = year;
  saveDb();
  sendPush(user.id, wrappedPush(sum.wrapped.lang, year));
}
setInterval(() => {
  // Server time, read through Date.now() so the tests' clock moves it too.
  const wrappedYear = wrappedPushYear(new Date(Date.now()));
  for (const user of db.users) {
    if (user.disabled) continue;            // locked out everywhere, reminders included
    if (!db.subs.some(s => s.userId === user.id)) continue;
    // One user's state file is one user's problem: a shape this tick cannot read is logged and
    // skipped, not allowed to take the process — and everyone else's reminders — down with it.
    // PUT /api/data refuses the obvious shapes, but a file already on disk answers to nobody.
    try {
      const sum = stateSummary(user.id);
      if (wrappedYear && sum && user.wrappedPush !== wrappedYear) wrappedTick(user, sum, wrappedYear);
      if (!sum?.rem.on) continue;
      const now = userNow(sum.rem.tz || 'UTC');
      if (!now) continue;
      const late = minutesLate(sum.rem.time, now);
      const reminderOpen = late >= 0 && late <= REMINDER_WINDOW_MIN && user.lastReminder !== now.date && sum.settled !== now.date;
      const nudgeOpen = sum.rem.nudge && user.lastNudge !== now.date && nudgeWindowOpen(sum.rem.time, now.hhmm);
      if (!reminderOpen && !nudgeOpen) continue;
      const S = readStateCached(user.id);
      if (!S?.reminder?.on) continue;
      if (nudgeOpen) nudgeTick(user, S, now);
      if (!reminderOpen) continue;
      // Nothing below depends on anything but the file, so an answer of "nothing owed today"
      // holds until the file changes (which drops the summary) or the date does.
      if ((S.workouts || []).some(w => w?.d === now.date)) { sum.settled = now.date; continue; }
      if (excusedOn(S, now.date)) { sum.settled = now.date; continue; } // noted as sick, away, … (nudge.js excusedOn)
      const rid = effectiveRoutineId(S, now.date);
      if (!rid) { sum.settled = now.date; continue; } // rest day — nothing planned
      const routine = (S.routines || []).find(r => r?.id === rid);
      console.log('reminder firing', user.id, rid);
      user.lastReminder = now.date;
      saveDb();
      sendPush(user.id, dayReminderPush(S.lang, routine));
    } catch (e) {
      console.error('reminder tick', user.id, e);
    }
  }
// Checked every 10s (not 60s) — ticks aren't aligned to the top of the minute, so a 60s
// interval could sit on your target minute for up to 59s before noticing. 10s caps that at ~9s.
}, REMINDER_TICK_MS).unref();

/* ---------- sessions (signed cookie) ---------- */
function sign(payload) {
  const mac = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return payload + '.' + mac;
}
function verifySig(token) {
  const i = token.lastIndexOf('.');
  if (i < 0) return null;
  const payload = token.slice(0, i), mac = token.slice(i + 1);
  const expect = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  try {
    if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
  } catch { return null; }
  return payload;
}
// Session payload is `<uid>:<expiry>:<version>`, where the version is the user's `sv` counter.
// Bumping `sv` (POST /api/logout/all) makes every cookie ever handed out for that account stop
// verifying, which is the only revocation there was before short of deleting ./data/secret and
// signing out the whole instance. Cookies minted before `sv` existed have no third field and are
// read as version 0, matching a user who has never bumped — they stay valid until they expire.
const sessionVersion = user => user.sv || 0;
// A fourth field says what the token was made for: `c` a browser's cookie, `b` a paired phone's
// bearer. Both verify the same way and either works in either place, but only a phone's token is
// renewed (GET /api/me): a cookie value replayed as a bearer used to be traded for a fresh 90-day
// token whenever it was past half its life, so a stolen cookie never had to expire. Tokens from
// before the field have none and are renewed as before; the cookies among them expire on their own.
function makeSession(user, kind = 'b') {
  const exp = Date.now() + SESSION_DAYS * 86400000;
  return sign(user.id + ':' + exp + ':' + sessionVersion(user) + ':' + kind);
}
// With the __Host- prefix the *browser* guarantees the cookie is host-only (no Domain attribute
// is even allowed) — which is what stops a sibling subdomain, e.g. anything-else.example.com
// against gym.example.com, from planting a second session cookie for the shared parent domain
// and having it shadow the real one. The prefix also requires Secure, so it only works on an
// https ORIGIN; over plain http://localhost the old name stays, and localhost has no sibling
// subdomains to worry about. Both names are accepted on the way in, so upgrading an instance
// does not sign anybody out — they move onto the prefixed cookie at their next sign-in.
const COOKIE = SECURE ? '__Host-gymsid' : 'gymsid';
const LEGACY_COOKIE = 'gymsid';
// Every value for a given name, in the order the browser sent them. Not an object: reducing
// duplicates to one entry silently picks a winner, and picking the *last* one handed a shadowing
// cookie the session outright.
function cookieValues(req, name) {
  const out = [];
  for (const c of (req.headers.cookie || '').split(';')) {
    const i = c.indexOf('=');
    if (i < 0) continue;
    if (c.slice(0, i).trim() === name) out.push(c.slice(i + 1).trim());
  }
  return out;
}
function cookieToken(req) {
  for (const name of (COOKIE === LEGACY_COOKIE ? [COOKIE] : [COOKIE, LEGACY_COOKIE])) {
    const vals = cookieValues(req, name);
    if (!vals.length) continue;
    // Two different values under one name is not something a browser does on its own — it means
    // somebody else got to set one. There is no safe way to guess which is the real session, so
    // refuse both: a signed-out user signs back in, a shadowing attempt gets nothing.
    if (vals.some(v => v !== vals[0])) return null;
    return vals[0];
  }
  return null;
}
// The session behind a request: { user, exp, bearer } — `bearer` when it came in an Authorization
// header (a paired phone) rather than the cookie — or null for no valid session at all.
function sessionOf(req) {
  // The paired mobile app has no cookie jar shared with the API's origin, so it carries the same
  // signed token in an Authorization header instead — same payload, same verification below.
  const auth = req.headers.authorization || '';
  const cookie = cookieToken(req);
  const tok = cookie || (auth.startsWith('Bearer ') ? auth.slice(7).trim() : null);
  const s = sessionUser(tok);
  return s && { ...s, bearer: !cookie };
}
// The session a token (a cookie value or a bearer) stands for — { user, exp } — or null. Split
// out of sessionOf so the origin check can ask whether a bearer authenticates on its own.
function sessionUser(tok) {
  if (!tok) return null;
  const payload = verifySig(tok);
  if (!payload) return null;
  const [uid, exp, ver, kind] = payload.split(':');
  if (!uid || +exp < Date.now()) return null;
  const user = db.users.find(u => u.id === uid) || null;
  if (!user) return null;
  if (user.disabled) return null;           // disabled accounts are locked out everywhere
  // Missing third field = pre-versioning cookie = version 0. Anything non-numeric is a malformed
  // payload (it still had to pass the HMAC, so this is belt-and-braces) and is refused outright.
  const claimed = ver === undefined ? 0 : Number(ver);
  if (!Number.isInteger(claimed) || claimed !== sessionVersion(user)) return null;
  return { user, exp: +exp, kind: kind || null };
}
function readSession(req) {
  return sessionOf(req)?.user || null;
}
// Guard for /api/admin/* — resolves the caller and 401/403s if they aren't an admin.
function requireAdmin(req, res) {
  const user = readSession(req);
  if (!user) { json(res, 401, { error: 'not signed in' }); return null; }
  // Only the 403 is recorded: a 401 is any unauthenticated bot poking /api/admin/*, and
  // logging those would bury the events an operator actually wants to see.
  if (!isAdmin(user)) { audit(req, 'admin.denied', { ok: false, user }); json(res, 403, { error: 'forbidden' }); return null; }
  return user;
}
function requireOwner(req, res) {
  const user = requireAdmin(req, res); if (!user) return null;
  if (!isOwner(user)) { audit(req, 'admin.denied', { ok: false, user }); json(res, 403, { error: 'only the owner can do this' }); return null; }
  return user;
}
const expireCookie = name => `${name}=; Path=/; Max-Age=0; HttpOnly;${SECURE} SameSite=Lax`;
function sessionCookie(user) {
  const fresh = `${COOKIE}=${makeSession(user, 'c')}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly;${SECURE} SameSite=Lax`;
  // Signing in also retires any pre-upgrade cookie, so nobody is left carrying an unprefixed one
  // (or a shadowing copy of it) alongside the new session.
  return COOKIE === LEGACY_COOKIE ? [fresh] : [fresh, expireCookie(LEGACY_COOKIE)];
}
const clearCookie = COOKIE === LEGACY_COOKIE
  ? [expireCookie(LEGACY_COOKIE)]
  : [expireCookie(COOKIE), expireCookie(LEGACY_COOKIE)];

/* ---------- CSRF ---------- */
// SameSite=Lax keeps the session cookie off a genuinely cross-*site* request. It does not keep it
// off a *sibling subdomain*: gym.example.com and anything-else.example.com are the same site, and
// that is the ordinary self-hosting layout — one domain, one reverse proxy, several apps. Nothing
// else in a request was being checked either; readBody() JSON.parse's the body whatever the
// Content-Type claims, so a hostile page could reach the state-changing routes with a form-style
// POST that needs no CORS preflight at all.
//
// So a state-changing request that came from a browser has to come from ORIGIN, the passkey
// routes included. They used to be exempt on the grounds that the challenge id is a credential,
// but it is the attacker's credential: /api/login/options hands a `cid` to anyone, the challenge
// is bound to nothing else, and the attacker's own passkey can sign it — so a form on another site
// could complete their sign-in in the victim's browser, and the Set-Cookie on that response
// replaced the victim's session with one for the attacker's account. No legitimate caller is
// cross-origin: a passkey only verifies against ORIGIN, so the mobile WebView could never use
// these routes anyway.
//
// pair/redeem is the one exemption, and it has to be: the paired app calls it from its own
// WebView origin, which is never ORIGIN. It is not a hole. The pairing code in the body is the
// credential, and the answer sets no cookie: the token comes back in the body, which a
// cross-site form or a no-cors fetch cannot read.
//
// The password routes are deliberately NOT exempt. A name and a password are a credential too,
// but one a hostile page can know — its own — so an exempt POST /api/login/password would let
// any site sign a visitor into the attacker's account and collect what they log (login CSRF).
// The watch relay's two routes for the watch are the same kind: the code in the body, or a watch
// token in the Authorization header, which no browser attaches on its own.
const CSRF_EXEMPT = new Set(['POST /api/pair/redeem', 'POST /api/watch/redeem', 'POST /api/watch/box']);
// The routes that answer to the credential in the body and never to a Bearer. No Bearer is the
// credential that acts there, so none buys the shortcut below: any valid token would do, the
// attacker's own included.
const PASSKEY_ROUTES = new Set([
  'POST /api/register/options', 'POST /api/register/verify',
  'POST /api/login/options', 'POST /api/login/verify'
]);
// The other ways in are the same kind of route: the name and password, the reset code or the
// device code in the body is the credential, never a Bearer.
const SIGN_IN_ROUTES = new Set([
  'POST /api/login/password', 'POST /api/register/password', 'POST /api/login/password-reset',
  'POST /api/device-link/options', 'POST /api/device-link/verify'
]);
// A verify error as the answer's body: a passkey made at an address that is not ORIGIN/RP_ID gets
// the same `code` as the origin check's 403, so the app explains both alike.
const verifyAnswer = e => ({
  error: verifyError(e, { rpId: RP_ID, origin: ORIGIN }),
  ...(isMisconfigured(e) ? { code: 'origin-mismatch', expected: ORIGIN } : {})
});
const originsMatch = (a, b) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
// Whether a Bearer is the credential that would act on this request: it verifies, and no session
// cookie sits beside it (readSession takes the cookie first, so a cookie is what would act then).
function bearerAuthenticates(req) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ') || cookieToken(req)) return false;
  return !!sessionUser(auth.slice(7).trim());
}
function csrfOk(req, key) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return true;
  if (CSRF_EXEMPT.has(key)) return true;
  // The paired mobile app authenticates with a Bearer token. A browser never attaches one on its
  // own, so there is no ambient authority for a hostile page to borrow and no origin to check.
  // That holds only when the Bearer is the credential that acts, so it has to authenticate by
  // itself: a header that merely starts with "Bearer " used to switch the check off, and then
  // readSession acted on the session cookie next to it — safe only because the CORS preflight
  // never allows credentials. And it buys nothing on the sign-in routes, where the body carries
  // the credential and a Bearer never is.
  if (!PASSKEY_ROUTES.has(key) && !SIGN_IN_ROUTES.has(key) && bearerAuthenticates(req)) return true;
  // Sec-Fetch-Site is set by the browser itself and no page can forge it, and it states exactly
  // the property wanted here — more precisely than comparing origins can. 'same-origin' is the
  // app talking to its own backend; a hostile page reports 'cross-site'; a sibling subdomain,
  // the case SameSite=Lax misses entirely, reports 'same-site'. It is also what keeps the Vite
  // dev server working, where the page is on another port and its Origin is legitimately not
  // ORIGIN. Absent on older Safari and on proxies that strip it, hence the fallback below.
  const site = req.headers['sec-fetch-site'];
  if (site) return site === 'same-origin' || site === 'none';
  const origin = req.headers.origin;
  // No Origin header at all means no browser sent this — curl, a script, a monitoring check.
  // Browsers put an Origin on every state-changing request and a page cannot suppress it, so the
  // forgery this exists to stop always carries one.
  if (!origin) return true;
  return originsMatch(origin, ORIGIN);
}

/* ---------- challenge store (in-memory, 5 min TTL) ---------- */
// Every challenge says which ceremony it was handed out for (`kind`), and every route that takes
// one back accepts only its own kind. Four ceremonies share this store — signing up, signing in,
// adding a passkey in Settings and redeeming a device link (#95) — and the last two carry a `uid`
// exactly like a sign-up's. When /api/register/verify asked only for a uid, the challenge that
// POST /api/device-link/options hands to anyone holding a code finished a *sign-up* instead: a
// passkey on the owner's profile and a session for it, without using the code up, as often as
// wanted, and past "sign out everywhere".
const challenges = new Map(); // cid -> {kind, challenge, name?, uid?, exp}
// POST /api/login/options is anonymous and unthrottled, and every call leaves a challenge here
// for five minutes, so the Map has a ceiling: past it the oldest goes. A ceremony takes seconds,
// so only a flood far beyond any real sign-in traffic reaches back far enough to cost one.
const MAX_CHALLENGES = 20000;
function putChallenge(data) {
  while (challenges.size >= MAX_CHALLENGES) challenges.delete(challenges.keys().next().value);
  const cid = crypto.randomBytes(16).toString('base64url');
  challenges.set(cid, { ...data, exp: Date.now() + 5 * 60000 });
  return cid;
}
function takeChallenge(cid) {
  const c = challenges.get(cid);
  challenges.delete(cid);
  if (!c || c.exp < Date.now()) return null;
  return c;
}
setInterval(() => { for (const [k, v] of challenges) if (v.exp < Date.now()) challenges.delete(k); }, 60000).unref();

// ---------- device pairing (mobile app "connect to my server", no WebAuthn ceremony) ----------
// A passkey ceremony can't run inside the app's WebView (its origin never matches RP_ID), so the
// app authenticates by redeeming a short code minted from an already signed-in browser tab —
// same 5-min-TTL/one-shot shape as the WebAuthn challenge store above.
const pairings = new Map(); // code -> {uid, exp}
const PAIR_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I — read off a screen
function makePairCode() {
  let code;
  do {
    code = Array.from(crypto.randomBytes(8)).map(b => PAIR_CODE_ALPHABET[b % PAIR_CODE_ALPHABET.length]).join('');
  } while (pairings.has(code));
  return code;
}
setInterval(() => { for (const [k, v] of pairings) if (v.exp < Date.now()) pairings.delete(k); }, 60000).unref();

/* ---------- the watch relay (watch-relay.js, docs/ZEPP_OS.md) ---------- */
// Pairing codes for watches, in memory like the phone's: hashed, one per profile, ten minutes.
const watchCodes = new Map();
setInterval(() => { const now = Date.now(); for (const [k, v] of watchCodes) if (v.exp <= now) watchCodes.delete(k); }, 60000).unref();
const readBox = uid => { try { return boxOf(JSON.parse(fs.readFileSync(watchFile(uid), 'utf8'))); } catch { return boxOf(null); } };
const writeBox = (uid, box) => durableWrite(watchFile(uid), JSON.stringify(box), 0o600);
// The watch link a request carries (`Authorization: Bearer ogw_…`), or null. Never a session: an
// account that may not sign in, or whose sessions were all ended since, has no live links either.
function watchLinkFor(req) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return null;
  const link = findWatchLink(db, auth.slice(7).trim(), uid => {
    const u = db.users.find(x => x.id === uid);
    return u && !u.disabled ? sessionVersion(u) : null;
  });
  if (link && touchWatchLink(link)) saveDb();
  return link;
}

/* ---------- helpers ---------- */
function json(res, code, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(extraHeaders || {}) });
  res.end(body);
}
// A request the caller got wrong. The catch-all at the bottom answers it with this status and
// message and does not log it: three of the routes below are reachable without a session, and a
// stack trace per malformed body would let anyone fill the container log with noise that looks
// like a crash. Anything else that escapes a handler is still a real 500 and still logged.
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0, over = false; const chunks = [];
    req.on('data', d => {
      size += d.length;
      if (over) {
        // The 413 is already on its way. The rest of the upload is read and thrown away rather
        // than the socket destroyed under it: closing with unread bytes on the wire makes the
        // kernel send a reset, and a client (node's own http client included) that hits the
        // reset before it has parsed the answer reports a dropped connection instead of the
        // 413. A client that keeps streaming past twice the cap is not a mistaken one, and is
        // cut off.
        if (size > 2 * MAX_BODY) req.destroy();
        return;
      }
      if (size > MAX_BODY) {
        over = true; chunks.length = 0;
        reject(new HttpError(413, 'body too large'));
        return;
      }
      chunks.push(d);
    });
    req.on('end', () => {
      if (over) return;
      if (!chunks.length) return resolve({});
      // A body has to say it is JSON. The three types a form can send, and the ones a no-cors
      // fetch can send, are exactly the ones that need no CORS preflight; parsing them anyway
      // let another site's form reach any route that reads a body, and on the passkey sign-in
      // that meant setting the victim's session to an account the attacker holds. Every client
      // in the tree already sends application/json (lib/api.js, sw.js).
      if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] || '')) {
        return reject(new HttpError(415, 'content-type must be application/json'));
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return reject(new HttpError(400, 'invalid json')); }
      // Every handler reads fields off the result, so a JSON `null`, string, number or array is
      // as much a client mistake as unparseable text — refused once here rather than dereferenced
      // (and turned into a TypeError) in each route.
      if (!body || typeof body !== 'object' || Array.isArray(body)) return reject(new HttpError(400, 'invalid json'));
      resolve(body);
    });
    // A browser hanging up mid-body — which is what pagehide does to an in-flight sync — is not
    // the caller getting a request wrong, it is nobody being left to answer. Marked so the
    // catch-all at the bottom says one line instead of a stack trace and a 500 into a dead socket.
    req.on('error', e => reject(Object.assign(e, { clientGone: true })));
  });
}
// A caller-supplied field that is meant to be text. String() alone is not safe on a parsed body:
// `{"code":{"toString":1}}` is valid JSON and String() throws on it.
const text = v => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const b64uToBuf = s => Buffer.from(s, 'base64url');

/* ---------- live presence (in-memory) ---------- */
// Clients heartbeat /api/activity while a workout is on screen; the admin dashboard reads who's
// live. Purely ephemeral — never persisted. Expires shortly after the last ping.
const presence = new Map();               // uid -> { name, exIdx, exTotal, setsDone, setsTotal, startedAt, updatedAt, hiddenAt? }
const PRESENCE_TTL = 70000;               // ~3.5× the 20s client heartbeat
// A "left" signal with reason `hidden` (the workout page went to the background) marks the row
// away at that moment instead of dropping it. A phone locked between sets keeps the page running
// and heartbeating, and the next heartbeat clears the mark, so the athlete never blinks off the
// dashboard; an iOS home-screen app swiped away sends `hidden` and nothing after it, so it is gone
// this long after instead of the full TTL. Two heartbeat intervals and 5 s: browsers throttle a
// hidden page's timers, so its first heartbeat after the hide can run late, and one late
// heartbeat must not take a locked phone off the list.
const PRESENCE_HIDDEN_GRACE = 45000;
// Whether a row counts as "training now". The one place that decides it: the admin list and the
// sweep below both ask here.
const presenceListed = (p, now) =>
  now - p.updatedAt < PRESENCE_TTL && (p.hiddenAt === undefined || now - p.hiddenAt < PRESENCE_HIDDEN_GRACE);
function livePresence(uid) {
  const p = presence.get(uid);
  if (!p) return null;
  if (!presenceListed(p, Date.now())) { presence.delete(uid); return null; }
  const { hiddenAt: _away, ...live } = p;   // the mark is bookkeeping; the dashboard gets the row it always did
  return live;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of presence) if (!presenceListed(v, now)) presence.delete(k); }, 30000).unref();

/* ---------- audit log ---------- */
// Who signed in, who tried and failed, and what an admin changed. One JSON object per line in
// ./data/audit.log, appended and never rewritten in place. It deliberately does not live in
// db.json: that file is rewritten whole on every save, and the login/register handshakes are
// unauthenticated and unthrottled by design (see SECURITY.md; only the optional password routes
// are throttled, below), so an audit trail in there would turn one bogus request into a full
// db.json rewrite. A line torn by a crash costs one event and is dropped on read.
//
// On by default. It records strictly less than the instance already holds — every account is in
// db.json and every workout is in state-<uid>.json, both readable by any admin — and a security
// feature that ships switched off protects nobody. IP addresses are the exception: off unless you
// ask for them, because they are the one field here that says where somebody physically is.
const AUDIT_ON = !/^(0|false|no|off)$/i.test(process.env.AUDIT_LOG || '');
const AUDIT_MAX = Math.max(0, +(process.env.AUDIT_MAX || 5000) || 0);     // 0 = no count cap
const AUDIT_DAYS = Math.max(0, +(process.env.AUDIT_DAYS || 90) || 0);     // 0 = no age cap
const AUDIT_IP = /^full$/i.test(process.env.AUDIT_IP || '') ? 'full'
  : /^(1|true|yes|on|net)$/i.test(process.env.AUDIT_IP || '') ? 'net' : 'off';
const auditFile = path.join(DATA, 'audit.log');
let auditSeq = 0;      // never reset, not even by a clear — a wiped log leaves a visible id gap
let auditCount = 0;

// Which header holds the caller depends on what is in front of the API. CF-Connecting-IP comes
// first because a Cloudflare tunnel does NOT forward the client in X-Forwarded-For — that header
// then only carries the tunnel's own container, which looks like a valid answer and isn't. After
// that, the first entry of X-Forwarded-For is the client and everything behind it is our own hops.
// All three are only as trustworthy as the proxy in front: it has to overwrite them rather than
// pass a client-supplied one through. In 'net' mode only the network survives — enough to tell
// one source from another, not enough to point at a person.
function clientIp(req) {
  if (AUDIT_IP === 'off') return null;
  const raw = String(req.headers['cf-connecting-ip'] || '').trim()
    || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || String(req.headers['x-real-ip'] || '').trim()
    // Nothing in front at all: the socket peer is the client, and it cannot be forged. Behind
    // the bundled web container a header always wins before this is reached.
    || String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '').trim();
  const ip = raw.replace(/^\[|\]$/g, '').slice(0, 45);
  if (!/^[0-9a-fA-F:.]{3,45}$/.test(ip)) return null;    // never store a header verbatim
  if (AUDIT_IP === 'full') return ip;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip.replace(/\.\d{1,3}$/, '.0/24');
  const g = ip.split(':').filter(Boolean).slice(0, 3).join(':');
  return g ? g + '::/48' : null;
}

function auditLines() {
  let text;
  try { text = fs.readFileSync(auditFile, 'utf8'); } catch { return []; }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { const r = JSON.parse(line); if (r && r.id && r.ev) rows.push(r); } catch { /* torn line */ }
  }
  return rows;
}
// Retention is a cap, not an archive: age first, then the newest AUDIT_MAX of what's left.
function auditKeep(rows) {
  let out = rows;
  if (AUDIT_DAYS) { const cut = Date.now() - AUDIT_DAYS * 86400000; out = out.filter(r => r.ts >= cut); }
  if (AUDIT_MAX && out.length > AUDIT_MAX) out = out.slice(out.length - AUDIT_MAX);
  return out;
}
function compactAudit() {
  const rows = auditLines();
  for (const r of rows) if (+r.id > auditSeq) auditSeq = +r.id;
  const keep = auditKeep(rows);
  auditCount = keep.length;
  if (keep.length === rows.length) return;
  try { atomicWrite(auditFile, keep.map(r => JSON.stringify(r)).join('\n') + (keep.length ? '\n' : '')); }
  catch (e) { console.error('audit compact failed', e.message); }
}

// Never throws: a log that can't be written must not break signing in.
function audit(req, ev, f = {}) {
  if (!AUDIT_ON) return true;
  const rec = { id: ++auditSeq, ts: Date.now(), ev, ok: f.ok !== false };
  if (f.user) { rec.uid = f.user.id; rec.name = String(f.user.name || '').slice(0, 40); }
  else {
    if (f.uid) rec.uid = f.uid;
    if (f.name) rec.name = String(f.name).slice(0, 40);
  }
  if (f.target) { rec.tgt = f.target.id; rec.tname = String(f.target.name || '').slice(0, 40); }
  if (f.msg) rec.msg = String(f.msg).slice(0, 120);
  if (f.tx) rec.tx = String(f.tx).slice(0, 64);
  // What a failed proof of ownership was guarding (proveOwner): 'email', 'passkey-add', …
  if (f.act) rec.act = String(f.act).slice(0, 40);
  const ip = clientIp(req);
  if (ip) rec.ip = ip;
  try { fs.appendFileSync(auditFile, JSON.stringify(rec) + '\n'); }
  catch (e) { console.error('audit write failed', e.message); return false; }
  // Amortized: a 5000-event cap rewrites the file once per ~1250 events.
  if (AUDIT_MAX && ++auditCount > AUDIT_MAX * 1.25) compactAudit();
  return true;
}
if (AUDIT_ON) {
  compactAudit();                                // prune on boot, seed auditSeq/auditCount
  setInterval(compactAudit, 3600000).unref();    // honour AUDIT_DAYS on an idle instance too
}
try { recoverAdoptionJournals(); }
catch (error) {
  console.error('prescription adoption recovery failed:', error.message);
  process.exit(1);
}

/* ---------- sign-in throttle ---------- */
// The password routes are counted (rate-limit.js) — only on an instance with PASSWORD_LOGIN on,
// since none of them exists otherwise — and so are the two that redeem a device link (#95).
// Passkey sign-in, passkey registration and phone pairing stay out of it, as they always were:
// nothing there is worth guessing (an assertion is a signature, an invite code 64 random bits, a
// pairing code 40 bits that live five minutes, one per profile), and behind a proxy that hands the
// API one address for every visitor a per-address count on them would let one stranger pause
// everybody's way in. Their failures are still written to the audit log, but only a few per
// address a minute (auditFail below), so a flood of junk cannot push everything else out of it. A
// device-link code is 60 bits that live ten minutes, no more worth guessing than a pairing code,
// but it is counted the way a reset code is: every wrong one is a guess at a way into somebody's
// profile, and the pause it can start only ever stops link redemption, never a sign-in.
// Three counts:
//
//   AUTH_BURST   every request to a counted route, 60 a minute per address. Enough for a
//                household behind one proxy; not enough to run scrypt as fast as one client
//                can ask.
//   ADDR_FAILS   wrong answers per address and per kind (a password or reset code, an invite
//                code on password signup, a device-link code): 20 free, then a pause of 30 s
//                that doubles up to 15 min.
//   ACCOUNT_FAILS  wrong passwords per *account*, whoever sends them: 5 free, then 1 min
//                doubling up to 1 h, forgotten after a day without one or on the next success.
//                This is the one that protects a password — an address is cheap to change, an
//                account is not. It is keyed by the account the name or e-mail resolves to
//                (`acct:<id>`), so typing the e-mail after the name was paused meets the same
//                pause; an identifier that resolves to nobody is counted as typed (`id:<fold>`),
//                so a pause looks the same whether an account is there or not. The count of an
//                account with a password is never evicted to make room for others. Passkeys
//                are never paused by it.
//
// A password check is counted against the name and the address the moment it starts, not when
// its answer comes back (passwordAttempt below): scrypt takes a tenth of a second, and counting
// afterwards let a burst sent at once be checked in full under a single allowance.
//
// Behind a proxy every request can come from the same address (the bundled web container passes
// the real one on; a second proxy in front of it may not). Then the per-address counts act for
// the whole instance: one client can pause *password* sign-in for everybody for a while, and the
// per-name pause is what still protects each password.
const AUTH_BURST = createWindow({ max: 60, windowMs: 60000 });
const ADDR_FAILS = createBackoff({ free: 20, baseMs: 30000, maxMs: 15 * 60000, forgetMs: 3600000 });
const ACCOUNT_FAILS = createBackoff({
  free: 5, baseMs: 60000, maxMs: 3600000, forgetMs: 24 * 3600000,
  // At most one per profile with a password, so this cannot grow without bound.
  keep: k => k.startsWith('acct:') && hasPassword(db.users.find(u => u.id === k.slice(5)))
});
setInterval(() => { AUTH_BURST.sweep(); ADDR_FAILS.sweep(); ACCOUNT_FAILS.sweep(); }, 60000).unref();

// Route -> the kind of failure it can count. Every route listed here also spends the burst
// budget; `null` spends only that.
const THROTTLED = {
  'POST /api/login/password': 'password', 'POST /api/login/password-reset': 'password',
  'POST /api/register/password': 'signup',
  'POST /api/account/password': 'password', 'DELETE /api/account/password': null,
  // Setting an e-mail only spends the budget and asks the address's e-mail pause; an address
  // already in use counts against it (see POST /api/account/email).
  'POST /api/account/email': 'email', 'DELETE /api/account/email': null,
  // Redeeming a device link (#95). Adding or removing a passkey and making a link only spend the
  // budget: the password that may prove them counts its own failures (passwordAttempt).
  'POST /api/device-link/options': 'link', 'POST /api/device-link/verify': 'link',
  'POST /api/account/passkeys/options': null, 'POST /api/account/device-link': null,
  // Pairing a phone: the same, for the password that may prove it.
  'POST /api/pair/create': null,
  // A watch's pairing code (watch-relay.js): a wrong one counts like a wrong device link.
  'POST /api/watch/redeem': 'watch', 'POST /api/watch/pair': null,
  'DELETE /api/account/passkeys': null,
  // Deleting the account: the same, for the password that may prove it.
  'POST /api/account/delete': null
};

// Which address the throttle counts against. Unlike clientIp() above, which only labels a log
// line, this decides who is refused, so a header is believed only when TRUST_PROXY says the API
// sits behind a proxy that sets it. X-Forwarded-For is read from the right: the last entry is
// the one the trusted proxy added, anything before it is whatever the client claimed. An IPv6
// client is counted by its /64, which is what one household or one VPS is handed — counting the
// full address would give an attacker 2^64 fresh starts.
function limitAddress(req) {
  const sock = String(req.socket?.remoteAddress || '');
  let raw = sock;
  if (TRUST_PROXY) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(v => v.trim()).filter(Boolean);
    raw = String(req.headers['cf-connecting-ip'] || '').trim() || xff[xff.length - 1]
      || String(req.headers['x-real-ip'] || '').trim() || sock;
  }
  raw = raw.replace(/^\[|\]$/g, '');
  const g = ipv6Groups(raw.toLowerCase());
  if (g) {
    if (g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff) return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
    return g.slice(0, 4).map(x => x.toString(16)).join(':') + '::/64';
  }
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(raw) ? raw : 'unknown';
}
function tooMany(res, secs) {
  json(res, 429, { error: 'too many attempts, try again later', code: 'locked', retryAfter: secs }, { 'Retry-After': String(secs) });
}
// Whether the caller's address is paused for `kind`, answering 429 when it is. A route asks this
// again right before the check it guards, with no await in between: the dispatcher asked before
// the body was read, and requests sent at once all pass that one together.
function addressPaused(req, res, kind) {
  const wait = ADDR_FAILS.retryAfter(kind + '|' + limitAddress(req));
  if (wait) tooMany(res, wait);
  return wait > 0;
}
// One wrong answer against the caller's address. The pause it starts, if any, is recorded once
// — not every refused request after it, which anyone could use to fill the log.
function strikeAddress(req, kind) {
  const lock = ADDR_FAILS.fail(kind + '|' + limitAddress(req));
  if (lock) audit(req, 'auth.throttled', { ok: false, msg: kind });
}

// A failure on a route anyone can call without a session (passkey sign-in and sign-up, pairing)
// is audited like any other, but only the first few per address and event a minute, and only so
// many from everybody together. The log keeps the newest AUDIT_MAX rows, so without this a few
// thousand junk requests (no Origin needed: these routes are CSRF-exempt) pushed every sign-in,
// admin action and deletion out of it in seconds. Nobody is refused anything here: what is
// dropped is a row that says the same thing as the ten before it.
const FAIL_AUDIT = createWindow({ max: 10, windowMs: 60000 });
const FAIL_AUDIT_ALL = createWindow({ max: 120, windowMs: 60000 });
setInterval(() => { FAIL_AUDIT.sweep(); FAIL_AUDIT_ALL.sweep(); }, 60000).unref();
function auditFail(req, ev, f) {
  if (FAIL_AUDIT.take(ev + '|' + limitAddress(req)) || FAIL_AUDIT_ALL.take(ev)) return;
  audit(req, ev, f);
}

const B2B2C_CREATE_ACCOUNT = createWindow({ max: B2B2C_RATE.createAccount, windowMs: B2B2C_RATE.windowMs });
const B2B2C_CREATE_IP = createWindow({ max: B2B2C_RATE.createIp, windowMs: B2B2C_RATE.windowMs });
const B2B2C_ACCEPT_ACCOUNT = createWindow({ max: B2B2C_RATE.acceptAccount, windowMs: B2B2C_RATE.windowMs });
const B2B2C_ACCEPT_IP = createWindow({ max: B2B2C_RATE.acceptIp, windowMs: B2B2C_RATE.windowMs });
const B2B2C_ASSESSMENT_ACCOUNT = createWindow({ max: B2B2C_RATE.assessmentAccount, windowMs: B2B2C_RATE.windowMs });
const B2B2C_ASSESSMENT_IP = createWindow({ max: B2B2C_RATE.assessmentIp, windowMs: B2B2C_RATE.windowMs });
const B2B2C_MEAL_PLAN_ACCOUNT = createWindow({ max: B2B2C_RATE.mealPlanAccount, windowMs: B2B2C_RATE.windowMs });
const B2B2C_MEAL_PLAN_IP = createWindow({ max: B2B2C_RATE.mealPlanIp, windowMs: B2B2C_RATE.windowMs });
const B2B2C_MEAL_ADHERENCE_ACCOUNT = createWindow({ max: B2B2C_RATE.mealAdherenceAccount, windowMs: B2B2C_RATE.windowMs });
const B2B2C_MEAL_ADHERENCE_IP = createWindow({ max: B2B2C_RATE.mealAdherenceIp, windowMs: B2B2C_RATE.windowMs });
setInterval(() => {
  B2B2C_CREATE_ACCOUNT.sweep(); B2B2C_CREATE_IP.sweep();
  B2B2C_ACCEPT_ACCOUNT.sweep(); B2B2C_ACCEPT_IP.sweep();
  B2B2C_ASSESSMENT_ACCOUNT.sweep(); B2B2C_ASSESSMENT_IP.sweep();
  B2B2C_MEAL_PLAN_ACCOUNT.sweep(); B2B2C_MEAL_PLAN_IP.sweep();
  B2B2C_MEAL_ADHERENCE_ACCOUNT.sweep(); B2B2C_MEAL_ADHERENCE_IP.sweep();
}, Math.min(B2B2C_RATE.windowMs, 60000)).unref();

function b2b2cThrottle(req, res, user, action) {
  const accountWindow = action === 'create' ? B2B2C_CREATE_ACCOUNT : B2B2C_ACCEPT_ACCOUNT;
  const ipWindow = action === 'create' ? B2B2C_CREATE_IP : B2B2C_ACCEPT_IP;
  const wait = Math.max(accountWindow.take(user.id), ipWindow.take(limitAddress(req)));
  if (!wait) return false;
  auditFail(req, `b2b2c.invite.${action}.throttled`, { ok: false, user, msg: 'rate_limited' });
  b2bError(res, 429, 'rate_limited', 'too many relationship attempts, try again later', { 'Retry-After': String(wait) });
  return true;
}

function assessmentThrottle(req, res, user) {
  const wait = Math.max(B2B2C_ASSESSMENT_ACCOUNT.take(user.id), B2B2C_ASSESSMENT_IP.take(limitAddress(req)));
  if (!wait) return false;
  auditFail(req, 'b2b2c.assessment.create.throttled', { ok: false, user, msg: 'rate_limited' });
  b2bError(res, 429, 'rate_limited', 'too many assessment attempts, try again later', { 'Retry-After': String(wait) });
  return true;
}

function mealPlanThrottle(req, res, user, action) {
  const wait = Math.max(B2B2C_MEAL_PLAN_ACCOUNT.take(user.id), B2B2C_MEAL_PLAN_IP.take(limitAddress(req)));
  if (!wait) return false;
  auditFail(req, `b2b2c.meal-plan.${action}.throttled`, { ok: false, user, msg: 'rate_limited' });
  b2bError(res, 429, 'rate_limited', 'too many meal plan attempts, try again later', { 'Retry-After': String(wait) });
  return true;
}

function mealAdherenceThrottle(req, res, user) {
  const wait = Math.max(B2B2C_MEAL_ADHERENCE_ACCOUNT.take(user.id), B2B2C_MEAL_ADHERENCE_IP.take(limitAddress(req)));
  if (!wait) return false;
  auditFail(req, 'b2b2c.meal-adherence.update.throttled', { ok: false, user, msg: 'rate_limited' });
  b2bError(res, 429, 'rate_limited', 'too many meal adherence attempts, try again later', { 'Retry-After': String(wait) });
  return true;
}

function commitAssessmentCollection(next) {
  const previous = db.coachAssessments;
  db.coachAssessments = next;
  try { saveDb(); }
  catch (error) {
    db.coachAssessments = previous;
    throw error;
  }
}

function commitNutrition(nextPlans, nextAdherence = db.mealAdherence) {
  const previousPlans = db.mealPlans;
  const previousAdherence = db.mealAdherence;
  db.mealPlans = nextPlans;
  db.mealAdherence = nextAdherence;
  try {
    validateNutritionState(db.mealPlans, db.mealAdherence);
    saveDb();
  }
  catch (error) {
    db.mealPlans = previousPlans;
    db.mealAdherence = previousAdherence;
    throw error;
  }
}

const adherenceNewestFirst = (left, right) => right.date.localeCompare(left.date)
  || right.updatedAt - left.updatedAt || String(right.id).localeCompare(String(left.id));
const adherenceCursor = item => Buffer.from(JSON.stringify([item.date, item.updatedAt, item.id])).toString('base64url');
function parseAdherenceCursor(value) {
  if (!value) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!Array.isArray(decoded) || decoded.length !== 3 || typeof decoded[0] !== 'string'
        || !Number.isFinite(decoded[1]) || typeof decoded[2] !== 'string') return false;
    return { date: decoded[0], updatedAt: decoded[1], id: decoded[2] };
  } catch { return false; }
}
function retainedMealAdherence(now = Date.now()) {
  const cutoff = new Date(now - B2B2C_LIMITS.mealAdherenceRetentionDays * 86400000).toISOString().slice(0, 10);
  return db.mealAdherence.filter(item => item.date >= cutoff);
}

function commitAssessmentConsent(link, scopes, now, actorId) {
  const candidate = structuredClone(db);
  const candidateLink = candidate.coachAthleteLinks.find(item => item.id === link.id);
  const removedScopes = candidateLink.scopes.filter(scope => !scopes.includes(scope));
  candidateLink.scopes = scopes;
  candidateLink.updatedAt = now;
  reconcileProgressScopes(candidate, { linkId: link.id, removedScopes, actorId, at: now });
  validateProgressState(candidate, PROGRESS_LIMITS);
  saveDb(candidate);
  publishDb(candidate);
}

function compactRelationships() {
  const candidate = structuredClone(db);
  const result = compactB2B2C(candidate, B2B2C_LIMITS);
  if (result.changed) {
    saveDb(candidate);
    publishDb(candidate);
  }
  if (result?.expiredAssessments?.length) {
    for (const item of result.expiredAssessments) removeOrphanedAssessmentPhotos(item);
  }
  return result;
}

function auditB2B2CDenied(req, event, user, reason, target) {
  auditFail(req, event, { ok: false, user, ...(target ? { target } : {}), msg: reason });
}

const assessmentResults = calculateAssessmentResults;

function serializeAssessment(item) {
  const { coachId, athleteId, photoOwnerId, ...assessment } = item;
  const coach = db.users.find(user => user.id === coachId);
  const athlete = db.users.find(user => user.id === athleteId);
  return {
    ...structuredClone(assessment),
    coach: coach ? { name: coach.name } : { name: 'Unavailable account' },
    athlete: athlete ? { name: athlete.name } : { name: 'Unavailable account' },
    ...(Array.isArray(assessment.photos) ? { photos: assessment.photos.map(photo => ({
      ...photo, url: `/api/assessments/${assessment.id}/photos/${photo.hash}`,
    })) } : {}),
    ...(assessment.parq ? { parq: {
      ...structuredClone(assessment.parq),
      answers: assessment.parq.answers.map(answer => ({
        ...answer,
        text: PARQ_QUESTIONS.find(question => question.id === answer.questionId)?.text || answer.questionId,
      })),
    } } : {}),
    ...(assessment.requiresMedicalClearance ? {
      medicalClearanceNotice: 'One or more PAR-Q answers require evaluation and clearance by a qualified health professional before physical activity. This is not a diagnosis.',
    } : {}),
  };
}

/* ---------- password sign-in (#118) ---------- */
// Optional, per instance (PASSWORD_LOGIN) and per profile: nobody has a password until they set
// one. Passkeys stay the default and the recommended way in. What a password needs that a
// passkey does not — hashing, a policy, the throttle above, a reset an admin can hand out — lives
// in password.js and rate-limit.js; the routes are here because they share the session, invite
// and audit machinery of the passkey routes.
//
// The name someone signs in with is their profile name, compared the way nameKey() folds it.
// Profile names were never unique, so the rule is narrower than that: no two profiles *with a
// password* may share a name. Setting one is refused while the name is taken that way, which is
// also re-checked after every await, where another request could have taken it meanwhile.
//
// An unused reset code holds its profile's name too. The reset has already removed the old
// password, and a name another profile took in the meantime would make the code impossible to
// redeem — there is no rename — and leave that profile locked out. Sign-in itself only ever
// looks at profiles that have a password (passwordHolder).
const hasPassword = u => !!(u && u.pw && typeof u.pw.h === 'string');
// A password that counts for anything: one the instance still lets people sign in with. With
// PASSWORD_LOGIN off, a password kept from when it was on neither signs in nor proves anything
// (proveOwner), and does not keep a profile's last passkey in place.
const passwordWayIn = u => PASSWORD_LOGIN && hasPassword(u);
const passwordHolder = k => db.users.find(u => hasPassword(u) && nameKey(u.name) === k) || null;
const holdsName = u => hasPassword(u) || !!(u.pwReset && u.pwReset.exp > Date.now());
// An e-mail is a second name to sign in with (see "e-mail as a sign-in name" below), so a name
// is also taken by another profile's e-mail — only ever relevant for a name with an "@" in it.
const nameTaken = (name, exceptId) => {
  const k = nameKey(name);
  return db.users.some(u => u.id !== exceptId && ((holdsName(u) && nameKey(u.name) === k) || u.email === k));
};

/* ---------- e-mail as a sign-in name ----------
   Optional, per profile, and only while PASSWORD_LOGIN is on: an address someone may type at the
   password sign-in instead of their profile name. Nothing is ever sent to it — no verification,
   no reset mail; resets stay the admin's one-time code — so the address is never proven to be
   theirs, and it does not need to be: it is only an identifier that points at an account, and the
   password is still what opens it. Stored as `u.email`, folded by normalizeEmail() (password.js).

   It is unique across every profile, and no profile's address may be another password-holding
   profile's name (nameTaken above says the same the other way round), so an identifier never
   points at two accounts. That uniqueness is the one thing an address reveals: setting one that
   is in use answers 409. The route could be made to hide it — accept the address silently and
   leave it pointing nowhere — but then someone who typed their own address on a second profile
   would be told it was saved and find it did not sign in, which is worse. So it answers, and the
   answer is made expensive instead: in Settings only a signed-in owner can ask (session +
   proveOwner, a passkey prompt or a checked password per try), an address already in use counts
   against the caller's address and account (20 free, then 30 s doubling to 15 min), and profile
   creation with a password and an address counts the same way against the caller's address.
   Signup needs no session, so it is the cheaper place to ask: it answers only after hashing the
   new password and, on an invite-only instance, only to someone holding a valid invite code
   (a refusal does not use it up); an open instance answers anyone. What that leaves is what the name-taken answer already gives
   away for names — "some profile here uses this", never which one — at a few tries an hour.

   Sign-in takes it in the same field as the name (loginTarget): an identifier with an "@" is
   looked up as an address first, then as a name, so a profile name that happens to contain an
   "@" still signs in. Wrong passwords count against the account the identifier resolves to, so
   switching between name and address does not reset the pause. The full address is never
   written to the audit log or the console (maskEmail), is not part of /api/me, the Coach, the
   MCP bridge or anything shared, and only its owner (GET /api/account/password) and an admin
   (the user list) ever see it. */
const emailHolder = e => db.users.find(u => hasPassword(u) && u.email === e) || null;
const emailTaken = (e, exceptId) => db.users.some(u => u.id !== exceptId && (u.email === e || (holdsName(u) && nameKey(u.name) === e)));
const EMAIL_ERRORS = {
  invalid: { error: 'that is not an e-mail address', code: 'email-invalid' },
  taken: { error: 'another profile already uses this e-mail address', code: 'email-taken' }
};
// Who a sign-in body names: `identifier` (what the app sends), `name` (what it sent before, and
// what older clients still send — an address typed there works too) or `email` (only an address).
// `key` is what wrong passwords are counted against: the account when there is one, otherwise the
// identifier as folded, so an unknown one is paused exactly like a known one.
function loginTarget(body) {
  const onlyEmail = body.identifier === undefined && body.name === undefined;
  const k = nameKey(text(body.identifier ?? body.name ?? body.email).slice(0, 300));
  if (!k) return null;
  const resolve = () => (k.includes('@') ? emailHolder(k) : null) || (onlyEmail ? null : passwordHolder(k));
  const user = resolve();
  return { k, user, resolve, email: k.includes('@'), key: user ? acctKey(user) : 'id:' + k };
}
const acctKey = u => 'acct:' + u.id;
const passkeyCount = u => db.creds.filter(c => c.userId === u.id).length;
const publicUser = u => ({
  id: u.id, name: u.name, admin: isAdmin(u), ...(isOwner(u) ? { owner: true } : {}),
  ...(u.profile ? { profile: profileOf(u), capabilities: capabilitiesFor(u) } : {}),
});
const b2bError = (res, status, code, error, headers) => json(res, status, { error, code }, headers);
const POLICY_ERRORS = {
  'too-short': `the password needs at least ${MIN_LENGTH} characters`,
  'too-long': `the password can have at most ${MAX_LENGTH} characters`,
  'too-common': 'this password is too easy to guess'
};
const policyError = (res, problem) => json(res, 400, { error: POLICY_ERRORS[problem], code: problem });
const WRONG = { error: 'wrong name or password', code: 'bad-credentials' };

// A new password ends every other session of the account, the way "sign out everywhere" does,
// pending pairing codes and device links included; the caller's own is re-issued by the route.
// Always a new record, never an edit of the old one: a check still running against the old one
// tells the two apart by that (see POST /api/login/password).
function setPassword(user, h) {
  user.pw = { h, set: new Date().toISOString() };
  delete user.pwReset;
  user.sv = sessionVersion(user) + 1;
  for (const [k, v] of pairings) if (v.uid === user.id) pairings.delete(k);
  dropDeviceLinks(db, user.id);
}

// A passkey assertion made just now by the signed-in account itself — how someone who has no
// password yet proves it is them before setting one. A session alone is not enough for that:
// it may be a cookie someone walked off with, and a password would turn it into a way in that
// outlives "sign out everywhere". Same ceremony as /api/login/verify, and the credential has
// to belong to this account.
async function passkeyStepUp(user, body) {
  const c = takeChallenge(body.cid);
  const cred = c?.kind === 'login' && db.creds.find(x => x.id === body.credential?.id && x.userId === user.id);
  if (!cred) return false;
  try {
    const v = await verifyAuthenticationResponse({
      response: body.credential, expectedChallenge: c.challenge, expectedOrigin: ORIGIN, expectedRPID: RP_ID,
      requireUserVerification: false,
      credential: { id: cred.id, publicKey: b64uToBuf(cred.publicKey), counter: cred.counter, transports: cred.transports }
    });
    if (!v.verified) return false;
    cred.counter = v.authenticationInfo.newCounter;
    cred.lastUsed = new Date().toISOString();
    return true;
  } catch { return false; }
}

// One password check against the account key `k` (loginTarget), counted as a failure for it and for the caller's
// address before it runs, so that checks sent side by side cannot all start under the same
// allowance (see the throttle above). Answers 429 itself and returns null when either is paused.
// The caller settles it once: failed() for a wrong password, ok() for a right one, void() when the
// answer says nothing against the password — the queue was full, the account is disabled, or the
// password changed while it was being checked.
function passwordAttempt(req, res, k) {
  const addr = 'password|' + limitAddress(req);
  const wait = ACCOUNT_FAILS.retryAfter(k) || ADDR_FAILS.retryAfter(addr);
  if (wait) { tooMany(res, wait); return null; }
  const byName = ACCOUNT_FAILS.attempt(k);
  const byAddr = ADDR_FAILS.attempt(addr);
  const settle = () => { byName.undo(); byAddr.undo(); };
  return {
    // Every slot and the queue behind them taken (BusyError) is not a wrong password.
    async verify(pw, stored) {
      // Longer than any password that can be set: wrong, without hashing a megabyte to find out.
      try { return passwordLength(pw) <= MAX_LENGTH && await verifyPassword(pw, stored); }
      catch (e) { settle(); throw e; }
    },
    // The audit line names the account only when there is one — what someone typed into the
    // name field is sometimes their password. `ev`/`act` are for a password that was not a
    // sign-in at all: the current one, proving a change (proveOwner) is logged as that change.
    failed(user, msg, unknown = 'unknown-name', { ev = 'auth.password.fail', act } = {}) {
      audit(req, ev, user ? { ok: false, user, msg, act } : { ok: false, msg: unknown, act });
      if (byName.lock) audit(req, 'auth.password.locked', user ? { ok: false, user } : { ok: false, msg: unknown });
      if (byAddr.lock) audit(req, 'auth.throttled', { ok: false, msg: 'password' });
    },
    // A right password starts the name over; the address keeps whatever else it has run up.
    ok() { ACCOUNT_FAILS.clear(k); byAddr.undo(); },
    void: settle
  };
}

// Proof that whoever holds this session is the account's owner right now, for the changes that
// add or take away a lasting way in — setting a password, adding a passkey, making a device link,
// removing a passkey or the password. A session on its own is not enough for those: it may be a
// cookie someone walked off with. An addition would outlive "sign out everywhere"; a removal
// would let whoever holds the cookie choose which of the owner's ways in is left — an old
// security key rather than the phone the owner carries — or take away the password that signs
// them in where passkeys do not work.
//
// Either a passkey assertion made for this request (`cid` from /api/login/options, `credential`
// signed by one of this account's passkeys), or the current password — only while the instance
// offers password sign-in. With PASSWORD_LOGIN off, a password kept from when it was on is a
// secret nothing else checks any more, possibly an old or reused one, so it proves nothing either:
// a stolen cookie and a guessed password must not add a passkey on an instance that switched
// passwords off. A profile that only ever had a password is moved onto a passkey while the flag
// is still on (docs/SELF_HOSTING.md). Answers the refusal itself and returns null, or says which
// proof it was ('passkey' | 'password'). Wrong passwords count toward the sign-in pause.
// `act` names the change being confirmed ('email', 'password-set', 'passkey-remove', …): a failed
// proof is logged as `auth.proof.fail` for that change, not as a failed sign-in — the owner was
// signed in all along, and "Password sign-in failed" sent an admin looking for the wrong thing.
async function proveOwner(req, res, user, body, act) {
  if (body.credential) {
    if (await passkeyStepUp(user, body)) return 'passkey';
    audit(req, 'auth.proof.fail', { ok: false, user, msg: 'step-up-failed', act });
    json(res, 403, { error: 'the passkey could not be verified', code: 'passkey' });
    return null;
  }
  if (!passwordWayIn(user)) {
    json(res, 403, { error: 'confirm with your passkey first', code: 'passkey-required' });
    return null;
  }
  const current = typeof body.current === 'string' ? body.current : '';
  const wrongCurrent = () => { json(res, 403, { error: 'your current password is not right', code: 'current-wrong' }); return null; };
  if (!current) {
    json(res, 403, { error: 'enter your current password', code: 'current-required' });
    return null;
  }
  const check = passwordAttempt(req, res, acctKey(user));
  if (!check) return null;
  const rec = user.pw;
  if (!(await check.verify(current, rec.h))) {
    check.failed(user, 'bad-current', undefined, { ev: 'auth.proof.fail', act });
    return wrongCurrent();
  }
  // Changed or removed while it was being checked: it is no longer the current password.
  if (user.pw !== rec) { check.void(); return wrongCurrent(); }
  check.ok();
  return 'password';
}

if (PASSWORD_LOGIN) warmUp();

// Taking the address away: the profile then signs in by its name only. Asks the same proof as
// setting one; a profile without an address gets 200 with none asked.
async function removeEmail(req, res, user, body) {
  if (!user.email) return json(res, 200, { ok: true, email: null });
  const proof = await proveOwner(req, res, user, body, 'email-remove');
  if (!proof) return;
  if (readSession(req) !== user) return json(res, 401, { error: 'not signed in' });
  delete user.email;
  saveDb();
  audit(req, 'auth.email.remove', { user, msg: proof });
  json(res, 200, { ok: true, email: null });
}

const cleanupKey = crypto.createHash('sha256').update(`${SECRET}:account-cleanup`).digest();
const cleanupRetryBaseMs = envInt('ACCOUNT_CLEANUP_RETRY_BASE_MS', 30000, { min: 10, max: 86400000 });
const cleanupRetryMaxMs = envInt('ACCOUNT_CLEANUP_RETRY_MAX_MS', Math.max(3600000, cleanupRetryBaseMs), { min: cleanupRetryBaseMs, max: 604800000 });
const cleanupMaxAttempts = envInt('ACCOUNT_CLEANUP_MAX_ATTEMPTS', 8, { min: 1, max: 100 });
const cleanupReadWindowMs = envInt('ACCOUNT_CLEANUP_READ_WINDOW_MS', 60000, { min: 1000, max: 86400000 });
const cleanupReadAccount = createWindow({ max: envInt('ACCOUNT_CLEANUP_READ_ACCOUNT_MAX', 120, { min: 1, max: 10000 }), windowMs: cleanupReadWindowMs });
const cleanupReadIp = createWindow({ max: envInt('ACCOUNT_CLEANUP_READ_IP_MAX', 600, { min: 1, max: 100000 }), windowMs: cleanupReadWindowMs });
let cleanupRetryTimer = null;
setInterval(() => { cleanupReadAccount.sweep(); cleanupReadIp.sweep(); }, Math.min(cleanupReadWindowMs, 60000)).unref();
function sealCleanupSubject(userId) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', cleanupKey, iv);
  const encrypted = Buffer.concat([cipher.update(userId, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}
function openCleanupSubject(subject) {
  const bytes = Buffer.from(subject, 'base64url');
  const decipher = crypto.createDecipheriv('aes-256-gcm', cleanupKey, bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
}
const cleanupStepNames = ['state', 'watch', 'coachAuth', 'media', 'integrations'];
const cleanupStatuses = new Set(['pending', 'complete', 'failed', 'manual_review']);
const cleanupIdPattern = /^acj_[A-Za-z0-9_-]{16}$/;
function sanitizeCleanupError(value) {
  if (value === null) return null;
  if (value === 'subject:invalid') return value;
  if (/^(state|watch|coachAuth|media|integrations):(EACCES|EIO|EPERM|external_error)$/.test(value)) return value;
  return 'external_error';
}
function serializeCleanupJob(job) {
  const values = Object.values(job.steps);
  const complete = values.filter(value => value === 'complete').length;
  return {
    id: job.id,
    status: job.status,
    steps: { total: values.length, pending: values.length - complete, complete },
    attempts: job.attempts,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    nextAttemptAt: job.nextAttemptAt,
    terminalAt: job.terminalAt,
    lastError: sanitizeCleanupError(job.lastError),
  };
}
function cleanupReadThrottle(req, res, admin) {
  const wait = Math.max(cleanupReadAccount.take(admin.id), cleanupReadIp.take(limitAddress(req)));
  if (!wait) return false;
  auditFail(req, 'admin.account-cleanup.throttled', { ok: false, user: admin, msg: 'rate_limited' });
  json(res, 429, { error: 'too many requests', code: 'rate_limited' }, { 'Retry-After': String(wait) });
  return true;
}
function cleanupCursor(payload) {
  const text = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', cleanupKey).update(`cleanup-list:${text}`).digest('base64url');
  return `${text}.${mac}`;
}
function readCleanupCursor(raw, status) {
  if (!raw) return null;
  try {
    const [text, mac, extra] = raw.split('.');
    const expected = crypto.createHmac('sha256', cleanupKey).update(`cleanup-list:${text || ''}`).digest('base64url');
    if (extra || !text || !mac || mac.length !== expected.length
        || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return false;
    const value = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
    return value && value.status === status && cleanupIdPattern.test(value.id) && typeof value.updatedAt === 'string' ? value : false;
  } catch { return false; }
}
function cleanupUnlink(file) {
  try { fs.unlinkSync(file); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
function persistCleanupJob(updated) {
  const candidate = structuredClone(db);
  const index = candidate.accountCleanupJobs.findIndex(item => item.id === updated.id);
  if (index < 0) return;
  candidate.accountCleanupJobs[index] = updated;
  saveDb(candidate);
  publishDb(candidate);
}
function cleanupRetryDelay(attempts) {
  return Math.min(cleanupRetryMaxMs, cleanupRetryBaseMs * (2 ** Math.max(0, attempts - 1)));
}
function settleCleanupAttempt(updated, timestamp) {
  if (Object.values(updated.steps).every(value => value === 'complete')) {
    updated.status = 'complete';
    updated.nextAttemptAt = null;
    updated.terminalAt = timestamp;
    return;
  }
  if (updated.attempts >= cleanupMaxAttempts) {
    updated.status = 'manual_review';
    updated.nextAttemptAt = null;
    updated.terminalAt = timestamp;
    console.warn('account cleanup requires manual review:', updated.id, updated.lastError || 'incomplete');
    return;
  }
  updated.status = 'pending';
  updated.nextAttemptAt = new Date(Date.parse(timestamp) + cleanupRetryDelay(updated.attempts)).toISOString();
  updated.terminalAt = null;
}
function executeAccountCleanup(job) {
  const updated = structuredClone(job);
  updated.attempts += 1;
  updated.updatedAt = new Date().toISOString();
  updated.lastError = null;
  let userId;
  try { userId = openCleanupSubject(updated.subject); }
  catch {
    updated.lastError = 'subject:invalid';
    settleCleanupAttempt(updated, updated.updatedAt);
    persistCleanupJob(updated);
    return updated;
  }
  const actions = {
    state: () => cleanupUnlink(stateFile(userId)),
    watch: () => cleanupUnlink(watchFile(userId)),
    coachAuth: () => coachConfig.clearProfileAuth(userId),
    media: () => MEDIA.removeUser(userId),
    integrations: () => integrations.removeUser(userId),
  };
  const injected = new Set((process.env.ACCOUNT_CLEANUP_FAIL_STEP || '').split(',').map(value => value.trim()).filter(Boolean));
  const failFile = process.env.ACCOUNT_CLEANUP_FAIL_FILE
    ? (path.isAbsolute(process.env.ACCOUNT_CLEANUP_FAIL_FILE) ? process.env.ACCOUNT_CLEANUP_FAIL_FILE : path.join(DATA, process.env.ACCOUNT_CLEANUP_FAIL_FILE)) : null;
  if (failFile && fs.existsSync(failFile)) {
    for (const value of fs.readFileSync(failFile, 'utf8').split(',')) if (value.trim()) injected.add(value.trim());
    fs.unlinkSync(failFile);
  }
  for (const step of cleanupStepNames) {
    if (updated.steps[step] === 'complete') continue;
    try {
      if (injected.has(step)) { const error = new Error('injected cleanup failure'); error.code = 'EIO'; throw error; }
      actions[step]();
      updated.steps[step] = 'complete';
    } catch (error) {
      updated.lastError = `${step}:${['EACCES', 'EIO', 'EPERM'].includes(error.code) ? error.code : 'external_error'}`;
    }
  }
  settleCleanupAttempt(updated, updated.updatedAt);
  persistCleanupJob(updated);
  return updated;
}
function retryAccountCleanupJobs({ force = false } = {}) {
  const timestamp = Date.now();
  let persistenceFailed = false;
  for (const job of [...(db.accountCleanupJobs || [])]) {
    if (job.status === 'pending' && (force || !job.nextAttemptAt || Date.parse(job.nextAttemptAt) <= timestamp)) {
      try { executeAccountCleanup(job); }
      catch (error) { persistenceFailed = true; console.error('account cleanup retry could not be persisted:', error.message); }
    }
  }
  scheduleAccountCleanupRetries(persistenceFailed ? cleanupRetryBaseMs : 0);
}
function scheduleAccountCleanupRetries(minimumDelay = 0) {
  if (cleanupRetryTimer) clearTimeout(cleanupRetryTimer);
  cleanupRetryTimer = null;
  const next = (db.accountCleanupJobs || []).filter(job => job.status === 'pending')
    .map(job => Date.parse(job.nextAttemptAt || job.updatedAt)).filter(Number.isFinite).sort((left, right) => left - right)[0];
  if (next === undefined) return;
  const delay = Math.max(10, minimumDelay, Math.min(cleanupRetryMaxMs, next - Date.now()));
  cleanupRetryTimer = setTimeout(() => {
    cleanupRetryTimer = null;
    retryAccountCleanupJobs();
  }, delay);
  cleanupRetryTimer.unref();
}

// Everything of an account, gone for good: durable access removal first, then observable,
// idempotent cleanup of external artifacts. The admin's delete and the account's own both end here.
function removeAccount(u) {
  const candidate = structuredClone(db);
  candidate.users = candidate.users.filter(x => x.id !== u.id);
  candidate.creds = (candidate.creds || []).filter(c => c.userId !== u.id);
  candidate.subs = (candidate.subs || []).filter(x => x.userId !== u.id);
  removeB2B2CUser(candidate, u.id);
  dropDeviceLinks(candidate, u.id);
  dropWatchLinks(candidate, u.id);
  const timestamp = new Date().toISOString();
  const job = {
    id: `acj_${crypto.randomBytes(12).toString('base64url')}`, subject: sealCleanupSubject(u.id), status: 'pending',
    steps: Object.fromEntries(cleanupStepNames.map(step => [step, 'pending'])), attempts: 0, lastError: null,
    createdAt: timestamp, updatedAt: timestamp, nextAttemptAt: timestamp, terminalAt: null,
  };
  candidate.accountCleanupJobs.push(job);
  compactB2B2C(candidate, B2B2C_LIMITS);
  saveDb(candidate);
  publishDb(candidate);
  dropWatchCodes(watchCodes, u.id);
  presence.delete(u.id);
  try { return executeAccountCleanup(job); }
  finally { scheduleAccountCleanupRetries(cleanupRetryBaseMs); }
}

const passwordRoutes = {
  'POST /api/login/password': async (req, res) => {
    const body = await readBody(req);
    const target = loginTarget(body);
    const pw = typeof body.password === 'string' ? body.password : '';
    if (!target || !pw) return json(res, 400, { error: 'name and password required', code: 'missing' });
    const check = passwordAttempt(req, res, target.key);
    if (!check) return;
    const { user } = target;
    const rec = user?.pw;
    if (!(await check.verify(pw, rec?.h))) {
      check.failed(user, 'bad-password', target.email ? 'unknown-email' : 'unknown-name');
      return json(res, 401, WRONG);
    }
    // Right for the password read before the await — which a change, an admin reset or a removal
    // may have replaced since (each puts a new record in user.pw or none; only a rehash edits it
    // in place). A session signed now would carry the account's *new* session version and outlive
    // the "signed out everywhere" that came with it, so the old password gets nothing; it is not
    // counted as a wrong one either.
    const still = () => hasPassword(user) && user.pw === rec && target.resolve() === user;
    if (!still()) {
      check.void();
      return json(res, 401, WRONG);
    }
    if (user.disabled) {
      check.void();
      audit(req, 'auth.password.fail', { ok: false, user, msg: 'account-disabled' });
      return json(res, 403, { error: 'this account has been disabled', code: 'disabled' });
    }
    check.ok();
    // A hash made with older parameters is replaced now, while the password is at hand.
    if (needsRehash(rec.h)) {
      try {
        const h = await hashPassword(pw);
        if (still()) { rec.h = h; saveDb(); }
      } catch (e) { if (!(e instanceof BusyError)) throw e; }
      // The same question again: the password may have changed while the new hash was made.
      if (!still()) return json(res, 401, WRONG);
    }
    audit(req, 'auth.password.ok', { user });
    json(res, 200, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(user) });
  },

  // For browsers that cannot make a passkey at all: plain http on a LAN address, some Firefox
  // setups. Same invite rules as /api/register/*, checked again and burned after the hash.
  'POST /api/register/password': async (req, res) => {
    const body = await readBody(req);
    const name = text(body.name).trim().slice(0, 40);
    if (!name) return json(res, 400, { error: 'name required', code: 'missing' });
    const code = text(body.code).trim().toUpperCase();
    const invite = () => db.invites.find(i => i.code === code && !i.usedBy && !i.revoked);
    if (INVITE_ONLY && addressPaused(req, res, 'signup')) return;
    if (INVITE_ONLY && !invite()) {
      audit(req, 'auth.register.denied', { ok: false, name, msg: 'invite-rejected' });
      strikeAddress(req, 'signup');
      return json(res, 403, { error: 'a valid invite code is required', code: 'invite' });
    }
    const problem = passwordProblem(body.password, name);
    if (problem) return policyError(res, problem);
    const taken = () => json(res, 409, { error: 'another profile already signs in with this name', code: 'name-taken' });
    // A name is also matched against every sign-in e-mail (nameTaken), so a name that is an
    // address is the e-mail question asked through the name field: it waits for the hash below
    // and counts against the address like the e-mail field does, or it would answer "in use" for
    // any address at once and without limit.
    const nameIsAddress = name.includes('@');
    if (nameIsAddress && addressPaused(req, res, 'email')) return;
    if (!nameIsAddress && nameTaken(name)) return taken();
    // An e-mail is optional here. One already in use counts against the address, the way it
    // does in Settings: this route needs no session, so it is the cheaper place to ask. Whether
    // it is in use is only answered after the hash and the invite check that follows it, so on
    // an invite-only instance nobody without a valid code learns anything about addresses.
    const hasEmail = typeof body.email === 'string' && body.email.trim() !== '';
    const email = hasEmail ? normalizeEmail(body.email) : null;
    if (hasEmail && !email) return json(res, 400, EMAIL_ERRORS.invalid);
    const emailRefused = () => {
      strikeAddress(req, 'email');
      audit(req, 'auth.register.fail', { ok: false, name, msg: 'email-taken' });
      return json(res, 409, EMAIL_ERRORS.taken);
    };
    if (email && addressPaused(req, res, 'email')) return;
    const h = await hashPassword(body.password);
    let inv = null;
    if (INVITE_ONLY) {
      inv = invite();
      if (!inv) {
        audit(req, 'auth.register.fail', { ok: false, name, msg: 'invite-invalid' });
        return json(res, 403, { error: 'invite code is no longer valid, ask for a new one', code: 'invite' });
      }
    }
    if (nameTaken(name)) {
      // No name in the row: it is an address, and the log keeps none (maskEmail is for owners).
      if (nameIsAddress) { strikeAddress(req, 'email'); audit(req, 'auth.register.fail', { ok: false, msg: 'email-taken' }); }
      return taken();
    }
    // No await from here to the push: nothing can take the address between this check and it.
    if (email && emailTaken(email)) return emailRefused();
    const created = new Date().toISOString();
    const user = { id: crypto.randomBytes(12).toString('base64url'), name, created, pw: { h, set: created }, ...(email ? { email } : {}) };
    if (inv) { user.invitedBy = inv.code; inv.usedBy = user.id; inv.usedAt = created; }
    claimFirstAdmin(req, user);
    db.users.push(user);
    saveDb();
    audit(req, 'auth.register.ok', { user, msg: inv ? inv.code + ' · password' : 'password' });
    json(res, 200, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(user) });
  },

  // What Settings shows: whether a password is set, and whether it could be removed.
  'GET /api/account/password': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    json(res, 200, {
      set: hasPassword(user), setAt: user.pw?.set || null, passkeys: passkeyCount(user),
      name: user.name, nameTaken: nameTaken(user.name, user.id),
      // Only the owner's own session is ever handed their address.
      email: user.email || null
    });
  },

  // Set or change. Proof first: the current password when there is one, or a passkey assertion
  // made for this request (which is also how a forgotten password is replaced by its owner).
  'POST /api/account/password': async (req, res) => {
    const s = sessionOf(req);
    if (!s) return json(res, 401, { error: 'not signed in' });
    const { user } = s;
    const body = await readBody(req);
    const problem = passwordProblem(body.next, user.name);
    if (problem) return policyError(res, problem);
    const taken = () => json(res, 409, { error: 'another profile already signs in with this name', code: 'name-taken' });
    if (nameTaken(user.name, user.id)) return taken();
    const proof = await proveOwner(req, res, user, body, 'password');
    if (!proof) return;
    const h = await hashPassword(body.next);
    // Everything above awaited: an admin reset, a disable or "sign out everywhere" may have ended
    // this session in the meantime, and a password set now would outlive that.
    if (sessionOf(req)?.user !== user) return json(res, 401, { error: 'not signed in' });
    if (nameTaken(user.name, user.id)) return taken();
    const first = !hasPassword(user);
    setPassword(user, h);
    // Whatever pause wrong guesses put on this account was about a password that no longer exists.
    ACCOUNT_FAILS.clear(acctKey(user));
    saveDb();
    audit(req, first ? 'auth.password.set' : 'auth.password.change', { user, msg: proof });
    // This session carries on under the new version: a new cookie, or a new token for a phone.
    if (s.bearer) return json(res, 200, { ok: true, token: makeSession(user) });
    json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(user) });
  },

  // Never the last way in: a profile with no passkey keeps its password, because nothing else
  // could sign it in again. Same proof as setting one (proveOwner) — the password itself, or a
  // passkey assertion made for this request — asked only once the removal could go ahead, so a
  // refusal the profile's state already decides spends no passkey prompt and no password check.
  // Existing sessions are left alone; "sign out everywhere" ends them.
  'DELETE /api/account/password': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    const lastWayIn = () => json(res, 409, { error: 'the password is the only way into this profile', code: 'last-way-in' });
    if (!hasPassword(user)) return json(res, 200, { ok: true });
    if (!passkeyCount(user)) return lastWayIn();
    const proof = await proveOwner(req, res, user, body, 'password-remove');
    if (!proof) return;
    // Everything above awaited: the session may have ended, and the profile's last passkey may
    // have been removed by a request that ran alongside this one.
    if (readSession(req) !== user) return json(res, 401, { error: 'not signed in' });
    if (proof === 'passkey') saveDb();   // the confirming passkey's counter and last use
    if (!hasPassword(user)) return json(res, 200, { ok: true });
    if (!passkeyCount(user)) return lastWayIn();
    delete user.pw;
    saveDb();
    audit(req, 'auth.password.remove', { user });
    json(res, 200, { ok: true });
  },

  // Set, change (`email`) or remove (`email` empty or null, or DELETE) the address this profile
  // may sign in with. The same proof as a password (proveOwner): an address that points at the
  // account is part of how someone gets in, and a copied session must not choose it. An address
  // already in use is refused only after the proof, and counts against the caller's address and
  // account, so asking whether an address is in use costs a passkey prompt or a password check
  // and runs out after a few tries (see "e-mail as a sign-in name" above).
  'POST /api/account/email': async (req, res) => {
    const s = sessionOf(req);
    if (!s) return json(res, 401, { error: 'not signed in' });
    const { user } = s;
    const body = await readBody(req);
    if (body.email == null || (typeof body.email === 'string' && body.email.trim() === '')) return removeEmail(req, res, user, body);
    const email = normalizeEmail(body.email);
    if (!email) return json(res, 400, EMAIL_ERRORS.invalid);
    if (email === user.email) return json(res, 200, { ok: true, email });
    const acct = 'email|' + acctKey(user);
    const paused = () => {
      const wait = ADDR_FAILS.retryAfter(acct);
      if (wait) tooMany(res, wait);
      return wait > 0 || addressPaused(req, res, 'email');
    };
    if (paused()) return;
    const proof = await proveOwner(req, res, user, body, 'email');
    if (!proof) return;
    if (sessionOf(req)?.user !== user) return json(res, 401, { error: 'not signed in' });
    if (paused()) return;
    if (emailTaken(email, user.id)) {
      if (proof === 'passkey') saveDb();   // the confirming passkey's counter and last use
      strikeAddress(req, 'email');
      ADDR_FAILS.fail(acct);
      audit(req, 'auth.email.fail', { ok: false, user, msg: 'email-taken' });
      return json(res, 409, EMAIL_ERRORS.taken);
    }
    const first = !user.email;
    user.email = email;
    saveDb();
    audit(req, first ? 'auth.email.set' : 'auth.email.change', { user, msg: proof + ' · ' + maskEmail(email) });
    json(res, 200, { ok: true, email });
  },
  'DELETE /api/account/email': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    removeEmail(req, res, user, await readBody(req));
  },

  // An admin hands out a one-time code; the person redeems it below with a password of their
  // choosing. Issuing it ends the old password and every session of the account at once: a
  // reset is asked for when access is lost or in doubt, and a password someone else may know
  // should not keep working for the day the code is valid. Passkeys are left alone. The code is
  // shown once and stored only as a hash. Admin accounts are refused, as they are by disable —
  // one admin must not be able to take over another's login.
  'POST /api/admin/user/password-reset': async (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    const body = await readBody(req);
    const u = db.users.find(x => x.id === body.id);
    if (!u) return json(res, 404, { error: 'no such user' });
    if (isAdmin(u)) return json(res, 400, { error: 'an admin sets their own password in Settings' });
    if (nameTaken(u.name, u.id)) return json(res, 409, { error: 'another profile already signs in with this name', code: 'name-taken' });
    const code = makeResetCode();
    delete u.pw;
    u.pwReset = { h: hashResetCode(code), exp: Date.now() + RESET_TTL_MS, by: admin.id };
    u.sv = sessionVersion(u) + 1;
    for (const [k, v] of pairings) if (v.uid === u.id) pairings.delete(k);
    dropDeviceLinks(db, u.id);
    presence.delete(u.id);
    saveDb();
    audit(req, 'admin.password.reset', { user: admin, target: u });
    json(res, 200, { ok: true, name: u.name, code, expires: u.pwReset.exp });
  },

  'POST /api/login/password-reset': async (req, res) => {
    const body = await readBody(req);
    // The name or the e-mail, in the same fields sign-in takes them (loginTarget).
    const k = nameKey(text(body.identifier ?? body.name ?? body.email).slice(0, 300));
    const code = text(body.code).slice(0, 64);
    if (!k || !code) return json(res, 400, { error: 'name and code required', code: 'missing' });
    // Wrong codes count against the address only. A per-name pause would add nothing against a
    // 60-bit code that lives a day, and would let anyone who knows the name keep the real code
    // refused for that whole day — after the reset has already removed the old password.
    if (addressPaused(req, res, 'password')) return;
    const find = () => db.users.find(u => u.pwReset && (nameKey(u.name) === k || u.email === k) && resetCodeMatches(code, u.pwReset)) || null;
    const user = find();
    const invalid = () => json(res, 400, { error: 'that reset code is wrong or has expired', code: 'reset-invalid' });
    const taken = () => json(res, 409, { error: 'another profile already signs in with this name', code: 'name-taken' });
    if (!user) {
      strikeAddress(req, 'password');
      audit(req, 'auth.password.reset', { ok: false, msg: 'reset-invalid' });
      return invalid();
    }
    if (user.disabled) {
      audit(req, 'auth.password.reset', { ok: false, user, msg: 'account-disabled' });
      return json(res, 403, { error: 'this account has been disabled', code: 'disabled' });
    }
    // The code is good and stays good until a password is actually set with it.
    const problem = passwordProblem(body.next, user.name);
    if (problem) return policyError(res, problem);
    if (nameTaken(user.name, user.id)) return taken();
    const h = await hashPassword(body.next);
    // Single use: a second request that raced this one through the hash finds the code gone.
    if (find() !== user) return invalid();
    if (nameTaken(user.name, user.id)) return taken();
    setPassword(user, h);
    ACCOUNT_FAILS.clear(acctKey(user));
    saveDb();
    audit(req, 'auth.password.reset', { user });
    json(res, 200, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(user) });
  }
};

/* ---------- more than one passkey, and one-time device links (#95) ---------- */
// A passkey lives where it was made — Windows Hello on one PC, one phone's keychain, one security
// key — so a profile that only had the passkey it was created with could not be reached from a
// second device, and "Create profile" there made a new, empty one. Two ways to add another:
//
//   Settings → Passkeys → Add: a registration ceremony in the signed-in browser, for any other
//   authenticator it can reach — a security key, a password manager, a phone through the
//   browser's own QR prompt.
//
//   A device link: the signed-in device shows a one-time code (device-link.js), and the other
//   device redeems it by creating a passkey of its own, which is what then signs it in. The code
//   never opens a session by itself: whoever redeems it leaves a passkey on the profile, listed
//   in Settings where the owner sees it and can remove it.
//
// Either way the new passkey is a way into the profile that outlives "sign out everywhere", so
// both ask for the proof a first password does (proveOwner). So does removing one: a stolen
// cookie must not choose which of the owner's passkeys is left. Removing one never leaves a
// profile without a way in: its last passkey stays unless a password can sign in instead.
//
// Sessions are not tied to the passkey that opened them — a session is `uid:expiry:version`,
// nothing more — so removing a passkey stops it signing in again but does not end a session it
// already opened. "Sign out everywhere" does that, and Settings says so where a passkey is removed.
// The last admin may not delete their own profile while anyone else is on the instance: nobody
// could run it from the app afterwards. Alone on it, they may go.
const lastAdminLeaving = u => isAdmin(u) && db.users.length > 1 && db.users.filter(isAdmin).length <= 1;
// Makes a recovery code for `target` (#584): a device link that lives a day and says who made it
// (`by`: the admin, or null for the server's own command). Making it signs the profile out
// everywhere, as a password reset does: it is asked for when the devices are lost, and a lost phone
// should not stay signed in for the day the code is good. Pairing codes and device links go too.
// Passkeys and the password are left alone; the person removes the lost device's passkey in
// Settings once they are back. Saved and audited here, whoever asked.
function issueRecovery(req, target, by) {
  target.sv = sessionVersion(target) + 1;
  for (const [k, v] of pairings) if (v.uid === target.id) pairings.delete(k);
  dropDeviceLinks(db, target.id);
  presence.delete(target.id);
  const made = createDeviceLink(db, target.id, Date.now(), RECOVERY_TTL_MS, { kind: 'recovery', by: by ? by.id : 'server' });
  saveDb();
  audit(req, by ? 'admin.recovery.create' : 'server.recovery.create', { ...(by ? { user: by } : {}), target, msg: by ? null : 'recover.js' });
  return made;
}

const passkeyState = u => {
  const passkeys = listPasskeys(db, u.id);
  // `password`: whether the password can confirm an addition or a removal (proveOwner) — only
  // while password sign-in is on. `lastWayIn`: whether removing any one passkey would be refused.
  return { passkeys, password: passwordWayIn(u), lastWayIn: passkeys.length + (passwordWayIn(u) ? 1 : 0) <= 1 };
};
const LIMIT = { error: `a profile can have at most ${MAX_PASSKEYS} passkeys`, code: 'passkey-limit' };
const LINK_INVALID = { error: 'that code is wrong, used or expired', code: 'link-invalid' };
const notSignedIn = res => json(res, 401, { error: 'not signed in' });

// Creation options for another passkey of `user`. The user handle is the profile's id, exactly as
// at sign-up, so an authenticator files the new passkey under the same account; the passkeys the
// profile has already are excluded, so an authenticator that holds one of them says so instead of
// making a second.
const moreOptions = user => generateRegistrationOptions({
  rpName: RP_NAME, rpID: RP_ID,
  userID: Buffer.from(user.id), userName: user.name, userDisplayName: user.name,
  attestationType: 'none',
  authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
  excludeCredentials: db.creds.filter(c => c.userId === user.id).map(c => ({ id: c.id, transports: c.transports || [] }))
});

// The second half of either ceremony: the new passkey as a db.creds row, or null once the
// refusal has been answered and audited as `ev`.
async function newPasskey(req, res, c, body, ev, user) {
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: body.credential, expectedChallenge: c.challenge, expectedOrigin: ORIGIN, expectedRPID: RP_ID,
      requireUserVerification: false
    });
  } catch (e) {
    // e.message can echo attacker-supplied response fields, so only the reason code is kept.
    audit(req, ev, { ok: false, user, msg: 'verify-error' });
    json(res, 400, verifyAnswer(e));
    return null;
  }
  if (!verification.verified) {
    audit(req, ev, { ok: false, user, msg: 'not-verified' });
    json(res, 400, { error: 'not verified' });
    return null;
  }
  const { credential } = verification.registrationInfo;
  return {
    id: credential.id,
    publicKey: Buffer.from(credential.publicKey).toString('base64url'),
    counter: credential.counter || 0,
    transports: body.credential?.response?.transports,
    name: body.name
  };
}

const passkeyRoutes = {
  'GET /api/account/passkeys': async (req, res) => {
    const user = readSession(req);
    if (!user) return notSignedIn(res);
    // `deleteBlocked`: the profile's own delete would be refused before any proof is looked at,
    // so the delete sheet says so up front instead of after a passkey or password prompt.
    json(res, 200, { ...passkeyState(user), ...(lastAdminLeaving(user) ? { deleteBlocked: 'last-admin' } : {}) });
  },

  // Adding one from Settings, step one: the proof, then the options. The proof is spent here; the
  // challenge that comes back is good for five minutes, for this profile, under this session
  // version — "sign out everywhere" in between ends the ceremony with everything else.
  'POST /api/account/passkeys/options': async (req, res) => {
    const user = readSession(req);
    if (!user) return notSignedIn(res);
    const body = await readBody(req);
    if (passkeyCount(user) >= MAX_PASSKEYS) return json(res, 409, LIMIT);
    const proof = await proveOwner(req, res, user, body, 'passkey-add');
    if (!proof) return;
    // Awaited: a sign-out everywhere, a disable or an admin reset may have ended this session.
    if (readSession(req) !== user) return notSignedIn(res);
    if (proof === 'passkey') saveDb();   // the confirming passkey's counter and last use
    const options = await moreOptions(user);
    const cid = putChallenge({ challenge: options.challenge, uid: user.id, kind: 'add', sv: sessionVersion(user), proof });
    json(res, 200, { cid, options });
  },

  'POST /api/account/passkeys/verify': async (req, res) => {
    const user = readSession(req);
    if (!user) return notSignedIn(res);
    const body = await readBody(req);
    const c = takeChallenge(text(body.cid));
    if (!c || c.kind !== 'add' || c.uid !== user.id) {
      audit(req, 'auth.passkey.fail', { ok: false, user, msg: 'challenge-expired' });
      return json(res, 400, { error: 'challenge expired, try again', code: 'challenge-expired' });
    }
    const cred = await newPasskey(req, res, c, body, 'auth.passkey.fail', user);
    if (!cred) return;
    if (readSession(req) !== user || sessionVersion(user) !== c.sv) return notSignedIn(res);
    const added = addPasskeyRecord(db, user.id, cred);
    if (added.error) {
      audit(req, 'auth.passkey.fail', { ok: false, user, msg: added.code });
      return json(res, 409, { error: added.error, code: added.code });
    }
    saveDb();
    audit(req, 'auth.passkey.add', { user, msg: c.proof });
    json(res, 200, { ok: true, ...passkeyState(user) });
  },

  'POST /api/account/passkeys/rename': async (req, res) => {
    const user = readSession(req);
    if (!user) return notSignedIn(res);
    const body = await readBody(req);
    const r = renamePasskeyRecord(db, user.id, text(body.id), body.name);
    if (r.error) return json(res, 404, { error: r.error, code: r.code });
    saveDb();
    json(res, 200, { ok: true, ...passkeyState(user) });
  },

  // `?id=` — the credential id from the list; the body carries the same proof adding one takes
  // (proveOwner), asked only once the removal could go ahead, so a refusal the list already
  // decides spends no passkey prompt and no password check. The last one is never removed
  // (removePasskeyRecord), checked again after the proof, since a request running alongside may
  // have removed another passkey or the password meanwhile. An unused device code goes with it: a
  // passkey is removed because it is lost or not trusted, and a code made with it just before — by
  // whoever holds it — would otherwise add a fresh one right after.
  'DELETE /api/account/passkeys': async (req, res) => {
    const user = readSession(req);
    if (!user) return notSignedIn(res);
    const id = new URL(req.url, 'http://x').searchParams.get('id') || '';
    const body = await readBody(req);
    const refuse = r => json(res, r.code === 'last-way-in' ? 409 : 404, { error: r.error, code: r.code });
    const refused = passkeyRemovalRefused(db, user.id, id, passwordWayIn(user) ? 1 : 0);
    if (refused) return refuse(refused);
    const proof = await proveOwner(req, res, user, body, 'passkey-remove');
    if (!proof) return;
    if (readSession(req) !== user) return notSignedIn(res);
    if (proof === 'passkey') saveDb();   // the confirming passkey's counter and last use
    const r = removePasskeyRecord(db, user.id, id, passwordWayIn(user) ? 1 : 0);
    if (r.error) return refuse(r);
    dropDeviceLinks(db, user.id);
    saveDb();
    audit(req, 'auth.passkey.remove', { user, msg: r.row.name || null });
    json(res, 200, { ok: true, ...passkeyState(user) });
  },

  // Makes the code another device redeems below. Same proof as adding a passkey here, because the
  // code is how a passkey gets added there.
  'POST /api/account/device-link': async (req, res) => {
    const user = readSession(req);
    if (!user) return notSignedIn(res);
    const body = await readBody(req);
    if (passkeyCount(user) >= MAX_PASSKEYS) return json(res, 409, LIMIT);
    const proof = await proveOwner(req, res, user, body, 'device-link');
    if (!proof) return;
    if (readSession(req) !== user) return notSignedIn(res);
    const { code, link } = createDeviceLink(db, user.id);
    saveDb();
    audit(req, 'auth.link.create', { user, msg: proof });
    json(res, 200, { code, expires: link.exp });
  },

  // Redeeming, from the other device, which has no session: the code is the credential. Step one
  // checks it and hands back creation options for the profile it belongs to, and that profile's
  // name and id, so the screen can say where this device is being added — and tell it apart from
  // the profile this browser is signed in as by the id, since names are not unique and whoever
  // sends a code chooses the name of theirs. The id is the options' user handle anyway, so it
  // tells the holder of the code nothing new. It does not use the code up —
  // a passkey prompt dismissed by mistake can be tried again — and wrong codes pause the address.
  // Not CSRF-exempt: only the app's own origin can create a passkey for it anyway, and a code
  // redeemed from anywhere else is not one the owner meant to hand over.
  'POST /api/device-link/options': async (req, res) => {
    const body = await readBody(req);
    if (addressPaused(req, res, 'link')) return;
    const link = findDeviceLink(db, text(body.code));
    if (!link) {
      strikeAddress(req, 'link');
      audit(req, 'auth.link.fail', { ok: false, msg: 'link-invalid' });
      return json(res, 400, LINK_INVALID);
    }
    const user = db.users.find(u => u.id === link.userId);
    if (!user || user.disabled) {
      audit(req, 'auth.link.fail', { ok: false, uid: link.userId, msg: 'user-unavailable' });
      return json(res, 400, LINK_INVALID);
    }
    // A recovery code still works on a profile full of passkeys: the oldest unused one makes room
    // (verify below). The lost devices' passkeys are what fill it.
    if (link.kind !== 'recovery' && passkeyCount(user) >= MAX_PASSKEYS) return json(res, 409, LIMIT);
    const options = await moreOptions(user);
    const cid = putChallenge({ challenge: options.challenge, uid: user.id, kind: 'link', lh: link.h });
    json(res, 200, { cid, options, id: user.id, name: user.name, ...(link.kind === 'recovery' ? { recovery: true } : {}) });
  },

  // Step two: the new passkey is stored, the code is burned, and this device is signed in by the
  // passkey it just made — the same cookie a passkey sign-in sets. Of two requests racing with one
  // code, the first to finish wins and the other finds it gone.
  'POST /api/device-link/verify': async (req, res) => {
    const body = await readBody(req);
    if (addressPaused(req, res, 'link')) return;
    const code = text(body.code);
    const c = takeChallenge(text(body.cid));
    const link = findDeviceLink(db, code);
    if (!link) {
      strikeAddress(req, 'link');
      audit(req, 'auth.link.fail', { ok: false, msg: 'link-invalid' });
      return json(res, 400, LINK_INVALID);
    }
    if (!c || c.kind !== 'link' || c.lh !== link.h || c.uid !== link.userId) {
      audit(req, 'auth.link.fail', { ok: false, uid: link.userId, msg: 'challenge-expired' });
      return json(res, 400, { error: 'challenge expired, try again', code: 'challenge-expired' });
    }
    const owner = db.users.find(u => u.id === link.userId);
    const cred = await newPasskey(req, res, c, body, 'auth.link.fail', owner || { id: link.userId });
    if (!cred) return;
    // Everything above awaited: the code may have been used, replaced or dropped since (a sign-out
    // everywhere, a new password, a disable), and the profile may be gone or locked.
    const user = db.users.find(u => u.id === link.userId);
    if (findDeviceLink(db, code) !== link || !user || user.disabled) {
      audit(req, 'auth.link.fail', { ok: false, uid: link.userId, msg: 'link-invalid' });
      return json(res, 400, LINK_INVALID);
    }
    const recovery = link.kind === 'recovery';
    // Recovery on a full profile: the passkey used longest ago goes, to make room for this one.
    let dropped = null;
    if (recovery && passkeyCount(user) >= MAX_PASSKEYS) {
      const oldest = listPasskeys(db, user.id).slice().sort((a, b) => String(a.lastUsed || a.created || '').localeCompare(String(b.lastUsed || b.created || '')))[0];
      if (oldest && !removePasskeyRecord(db, user.id, oldest.id, 1).error) dropped = oldest;
    }
    const added = addPasskeyRecord(db, user.id, cred);
    if (added.error) {
      audit(req, 'auth.link.fail', { ok: false, user, msg: added.code });
      return json(res, 409, { error: added.error, code: added.code });
    }
    added.row.lastUsed = added.row.created;
    burnDeviceLink(db, link);
    saveDb();
    audit(req, recovery ? 'auth.recovery.ok' : 'auth.link.ok', { user, msg: [added.row.name, dropped && `replaced ${dropped.name || 'a passkey'}`].filter(Boolean).join(', ') || null });
    json(res, 200, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(user) });
  }
};

/* ---------- photos & videos of custom exercises (api/media.js) ---------- */
// One photo, GIF or short video per custom exercise, stored per profile and named by its sha256.
// The state only ever carries a small ref; the bytes arrive and leave through the routes below.
// MEDIA_UPLOADS=0 takes the routes and the /api/config block away, but the store is created
// either way: an admin deleting a profile must still remove files uploaded while it was on.
const MEDIA_LIMITS = mediaLimits(process.env);
const MEDIA_ON = MEDIA_LIMITS.enabled;
const readStateWithAssessmentMedia = uid => {
  const state = readState(uid);
  const assessmentMedia = db.coachAssessments
    .filter(item => item.photoOwnerId === uid && Array.isArray(item.photos))
    .flatMap(item => item.photos)
    .map(media => ({ media }));
  if (!assessmentMedia.length) return state;
  const base = state && typeof state === 'object' && !Array.isArray(state) ? state : {};
  return { ...base, customEx: [...(Array.isArray(base.customEx) ? base.customEx : []), ...assessmentMedia] };
};
const MEDIA = createMediaStore({ dir: path.join(DATA, 'uploads'), limits: MEDIA_LIMITS, readState: readStateWithAssessmentMedia });
function removeOrphanedAssessmentPhotos(item) {
  if (!item?.photoOwnerId || !Array.isArray(item.photos)) return;
  const stateRefs = referencedHashes(readState(item.photoOwnerId));
  for (const photo of item.photos) {
    const stillAssessed = db.coachAssessments.some(assessment => assessment.photoOwnerId === item.photoOwnerId
      && assessment.photos?.some(candidate => candidate.hash === photo.hash));
    if (!stillAssessed && !stateRefs.has(photo.hash)) {
      try { MEDIA.remove(item.photoOwnerId, photo.hash); }
      catch (error) { console.error('assessment media cleanup failed', error.message); }
    }
  }
}
// Leftovers of uploads the previous process was receiving when it stopped.
try { MEDIA.cleanTmp(); } catch (e) { console.error('media: boot cleanup failed', e.message); }
// Per profile, not per address: every upload is signed in, and behind a proxy one address can be
// a whole household. The hourly budget is generous (an import of a backup re-uploads everything
// at once); the two-in-flight cap in media.js is what keeps one phone from holding many sockets.
const MEDIA_BURST = createWindow({ max: MEDIA_LIMITS.uploadsPerHour, windowMs: 3600000 });
// Deleting everything unreferenced is what "Reset everything" does; ten an hour is plenty.
const MEDIA_SWEEPS = createWindow({ max: 10, windowMs: 3600000 });
// Uid -> until when its throttle has already been recorded, so a client hammering a closed
// window writes one audit line per window, not one per request.
const mediaThrottleNoted = new Map();
setInterval(() => {
  MEDIA_BURST.sweep(); MEDIA_SWEEPS.sweep();
  for (const [k, until] of mediaThrottleNoted) if (until < Date.now()) mediaThrottleNoted.delete(k);
}, 600000).unref();
// Every one of these makes the server send pushes, one per subscription of the account. A
// person taps "send test" a few times and starts a rest after each set; a loop does neither.
const PUSH_TESTS = createWindow({ max: 10, windowMs: 600000 });
const REST_TIMER_SETS = createWindow({ max: 60, windowMs: 60000 });
setInterval(() => { PUSH_TESTS.sweep(); REST_TIMER_SETS.sweep(); }, 600000).unref();
function pushThrottled(res, win, user) {
  const wait = win.take(user.id);
  if (!wait) return false;
  json(res, 429, { error: 'too many requests, try again later', code: 'locked', retryAfter: wait }, { 'Retry-After': String(wait) });
  return true;
}
function mediaThrottle(req, user, win) {
  const wait = win.take(user.id);
  if (!wait) return;
  if ((mediaThrottleNoted.get(user.id) || 0) < Date.now()) {
    mediaThrottleNoted.set(user.id, Date.now() + wait * 1000);
    audit(req, 'media.throttled', { ok: false, user, msg: win === MEDIA_SWEEPS ? 'sweep' : 'upload' });
  }
  throw new MediaError(429, 'locked', { retryAfter: wait }, { 'Retry-After': String(wait) });
}
// Removes files that no profile's readable state has referenced for MEDIA_GC_GRACE_DAYS. Only
// profiles in db.json are swept, and only when their state parses (see media.js for why a
// missing anything never means "delete"). First pass a few minutes after boot, so an instance
// that is redeployed more often than hourly still gets one.
function mediaSweepAll() {
  try {
    const r = MEDIA.sweepAll({ uids: db.users.map(u => u.id) });
    if (r.removed || r.tmp) console.log(`media: swept ${r.removed} unreferenced file(s), ${(r.freedBytes / 1048576).toFixed(1)} MB, ${r.tmp} stale upload(s)`);
  } catch (e) { console.error('media: sweep failed', e); }
}
if (MEDIA_ON) {
  setInterval(mediaSweepAll, 3600000).unref();
  setTimeout(mediaSweepAll, 5 * 60000).unref();
}

// A stored file, streamed. The headers are the point: the bytes were chosen by a user, so the
// answer must never be something a browser would run. The Content-Type comes from the sniffed
// extension (never text/* or SVG), nosniff stops a browser second-guessing it, the sandbox CSP
// neuters it even if opened as a page, CORP keeps other sites from embedding it, and no-store
// keeps a copy out of the HTTP cache — the app's own media store is the only client cache, and
// an HTTP-cache copy would outlive the sign-out purge. No Range and no ETag: nothing asks.
async function sendMediaFile(res, f, hash) {
  let fd;
  try { fd = fs.openSync(f.path, 'r'); }
  catch { throw new MediaError(404, 'media-missing'); }   // swept between the lookup and here
  const size = fs.fstatSync(fd).size;
  res.writeHead(200, {
    'Content-Type': f.mime,
    'Content-Length': String(size),
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Disposition': `inline; filename="${hash}.${f.ext}"`,
    'X-Robots-Tag': 'noindex',
    // The paired phone reads the length before the body to refuse an oversized answer; it is
    // CORS-safelisted already, this only spells it out for older WebViews.
    'Access-Control-Expose-Headers': 'Content-Length'
  });
  try { await pipeline(fs.createReadStream(null, { fd }), res); }
  catch { res.destroy(); }   // the client went away mid-download; nothing left to answer
}

const mediaRoutes = {
  // The raw bytes of one file, named by the sha256 the client computed. media.js checks the
  // hash, the magic bytes, the caps, the quota and the free disk; this route only adds the
  // session and the hourly budget.
  'PUT /api/media/{hash}': async (req, res) => {
    const user = readSession(req);
    if (!user) { MEDIA.discard(req); return json(res, 401, { error: 'not signed in' }); }
    try { mediaThrottle(req, user, MEDIA_BURST); } catch (e) { MEDIA.discard(req); throw e; }
    req.allowSlowBody?.();   // a signed-in upload within its budget may take the half hour
    const r = await MEDIA.receive(user.id, req.mediaHash, req);
    json(res, r.status, r.body);
  },
  'GET /api/media/{hash}': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    // Only ever the caller's own folder: another profile's file is exactly as missing as one
    // that was never uploaded.
    const f = MEDIA.file(user.id, req.mediaHash);
    if (!f) throw new MediaError(404, 'media-missing');
    await sendMediaFile(res, f, req.mediaHash);
  },
  // Which of these the server does not have, so a device uploads only those. Answered from the
  // in-memory list of the caller's own folder.
  'POST /api/media/missing': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    const hashes = body.hashes;
    if (!Array.isArray(hashes) || hashes.length > 1000 || !hashes.every(h => typeof h === 'string' && HASH_RE.test(h))) {
      throw new MediaError(400, 'bad-request', { error: 'hashes must be a list of at most 1000 lowercase sha256 hex strings' });
    }
    json(res, 200, MEDIA.missing(user.id, hashes));
  },
  // "Reset everything": every file the caller's current state does not reference goes now,
  // without the grace. A state that cannot be read removes nothing.
  'POST /api/media/sweep': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    await readBody(req);
    mediaThrottle(req, user, MEDIA_SWEEPS);
    const r = MEDIA.sweep(user.id, { graceMs: 0 });
    audit(req, 'media.sweep', { user, msg: `${r.removed} file(s), ${(r.freedBytes / 1048576).toFixed(1)} MB${r.skipped ? ', state unreadable' : ''}` });
    json(res, 200, { removed: r.removed, freedBytes: r.freedBytes, usage: MEDIA.usage(user.id) });
  }
};

/* ---------- routes ---------- */
// A health check that only proves the port answers is the one that lies on the day it matters:
// a full disk, or a bind mount that came back read-only, leaves every write path in here broken
// — no sync, no sign-in, no audit line — while the process sits there perfectly alive and the
// container stays "healthy". So the check writes: one empty file under DATA, removed again.
// Cheap next to what it proves, and it is the same directory every real write goes to.
// One probe per window, not one per request: this route is unauthenticated, so a create and an
// unlink on every call is a disk write anyone who can reach the port may ask for as fast as they
// like. The container polls every five minutes (api/Dockerfile), so a five-second window is free
// to the check that matters and caps a flood at one probe per five seconds. The cost is that a
// poll can be up to five seconds stale — a mount that went read-only a second ago still reads
// healthy, and the poll after that does not.
const DATA_PROBE_MS = 5000;
let dataProbe = { at: 0, ok: false };
function dataWritable() {
  const now = Date.now();
  if (dataProbe.at && now - dataProbe.at < DATA_PROBE_MS) return dataProbe.ok;
  const probe = path.join(DATA, '.health-' + process.pid);
  let ok;
  try {
    fs.writeFileSync(probe, '');
    ok = true;
  } catch (e) {
    console.error('health: cannot write to', DATA + ':', e.message);
    ok = false;
  } finally {
    try { fs.unlinkSync(probe); } catch { /* never got created */ }
  }
  dataProbe = { at: now, ok };
  return ok;
}

const communicationHabitsRoutes = createCommunicationHabitsRoutes({
  audit, auditDenied: auditB2B2CDenied, b2bError, db, json, limitAddress, limits: B2B2C_LIMITS,
  makeEntityId, profileOf, readBody, readSession, rate: B2B2C_RATE, saveDb,
});
const progressRoutes = createProgressRoutes({
  audit, auditDenied: auditB2B2CDenied, b2bError, db, json, limitAddress, limits: B2B2C_LIMITS,
  readBody, readSession, readState, isCoach: user => profileOf(user).kind === 'coach',
  coachScopes: user => profileOf(user).coachSpecialties,
  cursorSecret: SECRET,
  commitCandidate: candidate => { saveDb(candidate); publishDb(candidate); },
  rate: {
    windowMs: B2B2C_RATE.windowMs,
    mutationAccount: B2B2C_RATE.progressMutationAccount,
    mutationIp: B2B2C_RATE.progressMutationIp,
    exportAccount: B2B2C_RATE.progressExportAccount,
    exportIp: B2B2C_RATE.progressExportIp,
  },
});
const schedulingDbWrites = new SerialWriteQueue();
const schedulingCollections = [
  'coachAvailability', 'coachAppointments', 'schedulingReminderPreferences', 'appointmentReminderStates', 'schedulingReminderOutbox',
];
const latestSchedulingDb = () => {
  const latest = loadDb();
  migrateB2B2C(latest);
  compactB2B2C(latest, B2B2C_LIMITS);
  return latest;
};
const withSchedulingDbTransaction = transform => schedulingDbWrites.run(() => dbWriteLock.withLock(async () => {
  const latest = latestSchedulingDb();
  const result = transform(latest);
  if (result?.changed) {
    validateSchedulingState(latest, B2B2C_LIMITS);
    saveDbUnlocked(latest);
    publishDb(latest);
  }
  return result;
}));
const commitSchedulingDb = (candidate, base = persistedDb, keys = schedulingCollections) => schedulingDbWrites.run(() => dbWriteLock.withLock(async () => {
  const latest = latestSchedulingDb();
  const merged = mergeDbCandidate(latest, base, candidate, { keys });
  validateSchedulingState(merged, B2B2C_LIMITS);
  saveDbUnlocked(merged);
  publishDb(merged);
}));
const schedulingRoutes = createSchedulingRoutes({
  audit, auditDenied: auditB2B2CDenied, b2bError, db, json, limitAddress, limits: B2B2C_LIMITS,
  makeEntityId, profileOf, readBody, readSession, rate: B2B2C_RATE, saveDb, publishDb, cursorSecret: SECRET,
  commitCandidate: commitSchedulingDb,
});
const appointmentReminderDispatcher = createReminderDispatcher({
  transaction: withSchedulingDbTransaction,
  deliver: async ({ userId, idempotencyKey }) => {
    const result = await sendPush(userId, appointmentReminderPush(idempotencyKey));
    if (result.status === 'delivered') return result;
    if (result.status === 'unavailable') return { status: 'retry', confirmed: true };
    return { status: 'uncertain' };
  },
  logger: { error: message => console.error(message) },
  config: REMINDER_DISPATCH_CONFIG,
});
const REMINDER_STATUS_ACCOUNT = createWindow({ max: B2B2C_RATE.schedulingStatusAccount, windowMs: B2B2C_RATE.windowMs });
const REMINDER_STATUS_IP = createWindow({ max: B2B2C_RATE.schedulingStatusIp, windowMs: B2B2C_RATE.windowMs });
const reminderBacklog = (nowMs = Date.now()) => {
  const backlog = {};
  let oldestDue = null;
  let activeLeases = 0;
  let expiredLeases = 0;
  for (const item of db.schedulingReminderOutbox) {
    backlog[item.status] = (backlog[item.status] || 0) + 1;
    if ((item.status === 'pending' || item.status === 'retry') && Date.parse(item.nextAttemptAt || item.scheduledFor) <= nowMs) {
      const due = Date.parse(item.nextAttemptAt || item.scheduledFor);
      oldestDue = oldestDue === null ? due : Math.min(oldestDue, due);
    }
    if (item.status === 'processing' || item.status === 'delivery_started') {
      if (Date.parse(item.leaseExpiresAt) > nowMs) activeLeases++;
      else expiredLeases++;
    }
  }
  for (const status of ['pending', 'processing', 'delivery_started', 'retry', 'delivered', 'delivery_uncertain', 'failed', 'canceled']) backlog[status] ||= 0;
  return {
    backlog,
    oldestDueAgeSeconds: oldestDue === null ? null : Math.max(0, Math.floor((nowMs - oldestDue) / 1000)),
    leases: { active: activeLeases, expired: expiredLeases },
    totals: { retry: backlog.retry, failed: backlog.failed, delivery_uncertain: backlog.delivery_uncertain },
  };
};
const reminderHealth = () => {
  const summary = reminderBacklog();
  return summary.backlog.delivery_uncertain > 0 || summary.leases.expired > 0 ? 'degraded' : 'ok';
};

setImmediate(() => retryAccountCleanupJobs({ force: true }));

const routes = {
  ...communicationHabitsRoutes,
  ...progressRoutes,
  ...schedulingRoutes,
  // 503 rather than a flag in a 200: the container healthcheck is `wget --spider`, which reads
  // the status and nothing else, and an instance that cannot write its data directory is exactly
  // what "unhealthy" is for. The 200 keeps the shape it had, plus the flag it is now asserting.
  'GET /api/health': async (req, res) => {
    if (!dataWritable()) return json(res, 503, { ok: false, writable: false });
    json(res, 200, { ok: true, users: db.users.length, writable: true, schedulingReminders: reminderHealth() });
  },

  'GET /api/admin/scheduling-reminders/status': async (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    const wait = Math.max(REMINDER_STATUS_ACCOUNT.take(admin.id), REMINDER_STATUS_IP.take(limitAddress(req)));
    if (wait) {
      auditFail(req, 'admin.scheduling-reminders.status.throttled', { ok: false, user: admin, msg: 'rate_limited' });
      return json(res, 429, { error: 'too many requests', code: 'rate_limited' }, { 'Retry-After': String(wait) });
    }
    const summary = reminderBacklog();
    const storageLock = await dbWriteLock.inspect();
    audit(req, 'admin.scheduling-reminders.status', { user: admin, msg: reminderHealth() });
    json(res, 200, {
      dispatcher: appointmentReminderDispatcher.status(),
      ...summary,
      storageLock,
      config: {
        tickMs: REMINDER_DISPATCH_CONFIG.tickMs,
        deliveryLeaseMs: REMINDER_DISPATCH_CONFIG.leaseMs,
        lockLeaseMs: REMINDER_DISPATCH_CONFIG.lockLeaseMs,
        lockTimeoutMs: REMINDER_DISPATCH_CONFIG.lockTimeoutMs,
        lockRetryMs: REMINDER_DISPATCH_CONFIG.lockRetryMs,
        retryBaseMs: REMINDER_DISPATCH_CONFIG.baseRetryMs,
        retryMaxMs: REMINDER_DISPATCH_CONFIG.maxRetryMs,
        maxAttempts: REMINDER_DISPATCH_CONFIG.maxAttempts,
        batchSize: REMINDER_DISPATCH_CONFIG.batchSize,
        retentionDays: B2B2C_LIMITS.reminderRetentionDays,
        maxStates: B2B2C_LIMITS.maxReminderStates,
        maxOutbox: B2B2C_LIMITS.maxReminderOutbox,
        statusRateAccount: B2B2C_RATE.schedulingStatusAccount,
        statusRateIp: B2B2C_RATE.schedulingStatusIp,
        rateWindowMs: B2B2C_RATE.windowMs,
      },
    });
  },

  // Public config the login screen needs before anyone is signed in. `coach` is absent unless
  // the instance has both switched the Coach on and successfully connected a provider — the
  // single flag every piece of Coach UI hangs off, so an unconfigured instance is byte-for-byte
  // the app it was before the feature existed.
  'GET /api/config': async (req, res) => {
    // The Coach block names the provider this instance is wired to — the same fact
    // /api/coach/disclosure refuses to hand out without a session, and for the same reason: on an
    // invite-only instance, which model this box talks to is nobody's business who has not been
    // let in. The two flags above it are what the login screen and the pre-login boot read
    // (invite code field, "continue without account"), so those stay public.
    //
    // Every Coach consumer on the client side already requires a signed-in user before it looks
    // at this block (lib/coach.js coachAvailable), so nothing that could render loses anything.
    //
    // A signed-in caller always gets the key, even on an instance with no Coach, where it is
    // null. The client caches this answer for the page load and has to know whether the copy it
    // holds was made for a session: without the key it cannot tell "no Coach here" from "you
    // were not signed in when you asked", and would re-ask on every sign-in on every instance
    // that has no Coach. The key's absence is that answer.
    json(res, 200, {
      invite_only: INVITE_ONLY, allow_guest: ALLOW_GUEST,
      // Only when on, so an instance without passwords answers exactly as it did before (#118).
      ...(PASSWORD_LOGIN ? { password_login: true } : {}),
      // Public: the sign-in screen is the first thing that reads it.
      ...(DEFAULT_LANG ? { default_lang: DEFAULT_LANG } : {}),
      // Public like the two flags above: the caps are not a secret, and the absence of the
      // block is how the app knows this server does not take photos and videos at all.
      ...(MEDIA_ON ? { media: mediaConfig(MEDIA_LIMITS) } : {}),
      ...(readSession(req) ? { coach: coachConfig.publicConfig() } : {}),
      // Which integrations this server offers (only to a session, like the Coach block). Absent
      // with INTEGRATIONS unset, which is how the app knows to show the server cards as off.
      ...(readSession(req) && integrations.publicConfig() ? { integrations: integrations.publicConfig() } : {})
    });
  },

  // A paired phone's token was minted once, at pairing, and nothing ever renewed it: after
  // SESSION_DAYS the server refused a phone that had been in use every day. The phone asks this
  // on every start, so once its token is past half its life the answer carries a new one
  // (`token`), which the phone saves in place of the old. makeSession() writes the account's
  // current session version into it, so "sign out everywhere" ends a renewed token exactly as it
  // ended the old one — and a revoked token never gets this far. A browser's cookie is left
  // alone: signing in renews it, as before.
  'GET /api/me': async (req, res) => {
    const s = sessionOf(req);
    if (!s) return json(res, 401, { error: 'not signed in' });
    const { user } = s;
    const renew = s.bearer && s.kind !== 'c' && s.exp - Date.now() < SESSION_DAYS * 86400000 / 2;
    json(res, 200, { user: publicUser(user), ...(renew ? { token: makeSession(user) } : {}) });
  },

  'POST /api/profile': async (req, res) => {
    const user = readSession(req);
    if (!user) return b2bError(res, 401, 'not_signed_in', 'not signed in');
    const body = await readBody(req);
    const profile = validateProfile(body);
    if (!profile) return b2bError(res, 400, 'invalid_profile', 'invalid profile');
    const previous = profileOf(user);
    const incompatibleLink = db.coachAthleteLinks.some(link => link.coachId === user.id && link.status !== 'ended'
      && link.scopes.some(scope => !profile.coachSpecialties.includes(scope)));
    if (incompatibleLink) {
      auditB2B2CDenied(req, 'b2b2c.profile.update.denied', user, 'relationships_active');
      return b2bError(res, 409, 'relationships_active', 'end professional relationships before removing their specialties');
    }
    user.profile = profile;
    saveDb();
    audit(req, 'b2b2c.profile.update', {
      user,
      msg: `${previous.kind}[${previous.coachSpecialties.join(',')}]->${profile.kind}[${profile.coachSpecialties.join(',')}]`,
    });
    json(res, 200, { user: publicUser(user) });
  },

  'POST /api/coach/invites': async (req, res) => {
    const coach = readSession(req);
    if (!coach) return b2bError(res, 401, 'not_signed_in', 'not signed in');
    const profile = profileOf(coach);
    if (profile.kind !== 'coach') return b2bError(res, 403, 'role_forbidden', 'professional profile required');
    if (b2b2cThrottle(req, res, coach, 'create')) return;
    compactRelationships();
    const body = await readBody(req);
    const scopes = validateScopes(body.scopes, profile.coachSpecialties);
    if (!scopes) return b2bError(res, 400, 'invalid_scope', 'invalid relationship scope');
    const expiresInDays = body.expiresInDays === undefined ? 7 : body.expiresInDays;
    if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 30) {
      return b2bError(res, 400, 'invalid_expiry', 'expiry must be from 1 to 30 days');
    }
    const pendingForCoach = db.coachAthleteLinks.filter(link => link.coachId === coach.id && link.status === 'pending').length;
    if (pendingForCoach >= B2B2C_LIMITS.pendingPerCoach) {
      auditB2B2CDenied(req, 'b2b2c.invite.create.denied', coach, 'pending_invite_limit');
      return b2bError(res, 409, 'pending_invite_limit', 'too many pending invitations');
    }
    const pendingInvites = db.coachInvites.filter(invite => db.coachAthleteLinks.some(link => link.id === invite.linkId && link.status === 'pending')).length;
    if (db.coachAthleteLinks.length >= B2B2C_LIMITS.maxLinks || pendingInvites >= B2B2C_LIMITS.maxInvites) {
      auditB2B2CDenied(req, 'b2b2c.invite.create.denied', coach, 'relationship_capacity');
      return b2bError(res, 409, 'relationship_capacity', 'relationship storage capacity reached');
    }
    const now = new Date();
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + expiresInDays * 86400000).toISOString();
    const link = {
      id: makeEntityId('cal', db.coachAthleteLinks), coachId: coach.id, athleteId: null,
      scopes, status: 'pending', createdAt, updatedAt: createdAt,
    };
    const opaque = makeOpaqueInvite();
    const invite = {
      id: makeEntityId('cai', db.coachInvites), linkId: link.id, coachId: coach.id,
      tokenHash: opaque.tokenHash, createdAt, expiresAt, acceptedAt: null, acceptedBy: null,
    };
    const candidate = structuredClone(db);
    candidate.coachAthleteLinks.push(link);
    candidate.coachInvites.push(invite);
    const compactionResult = compactB2B2C(candidate, B2B2C_LIMITS);
    saveDb(candidate);
    publishDb(candidate);
    if (compactionResult?.expiredAssessments?.length) {
      for (const item of compactionResult.expiredAssessments) removeOrphanedAssessmentPhotos(item);
    }
    audit(req, 'b2b2c.invite.create', { user: coach, msg: `${link.id}:${scopes.join(',')}` });
    json(res, 201, { invite: { id: invite.id, linkId: link.id, token: opaque.token, scopes, expiresAt } });
  },

  'POST /api/coach/invites/accept': async (req, res) => {
    const athlete = readSession(req);
    if (!athlete) return b2bError(res, 401, 'not_signed_in', 'not signed in');
    if (b2b2cThrottle(req, res, athlete, 'accept')) return;
    compactRelationships();
    const body = await readBody(req);
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    if (!token || token.length > 256) {
      auditB2B2CDenied(req, 'b2b2c.invite.accept.denied', athlete, 'invite_invalid');
      return b2bError(res, 410, 'invite_invalid', 'invite is invalid or expired');
    }
    const invite = db.coachInvites.find(item => item.tokenHash === hashInviteToken(token));
    if (!invite) {
      auditB2B2CDenied(req, 'b2b2c.invite.accept.denied', athlete, 'invite_invalid');
      return b2bError(res, 410, 'invite_invalid', 'invite is invalid or expired');
    }
    const link = db.coachAthleteLinks.find(item => item.id === invite.linkId);
    if (!link) {
      auditB2B2CDenied(req, 'b2b2c.invite.accept.denied', athlete, 'invite_invalid');
      return b2bError(res, 410, 'invite_invalid', 'invite is invalid or expired');
    }
    if (invite.acceptedAt) {
      if (invite.acceptedBy !== athlete.id) {
        auditB2B2CDenied(req, 'b2b2c.invite.accept.denied', athlete, 'invite_used');
        return b2bError(res, 409, 'invite_used', 'invite was already used');
      }
      return json(res, 200, { link: serializeLink(db, link, athlete) });
    }
    if (Date.parse(invite.expiresAt) <= Date.now() || link.status !== 'pending') {
      if (link.status === 'pending') {
        const now = new Date().toISOString();
        link.status = 'ended'; link.updatedAt = now; link.endedAt = now;
        invite.expiredAt = now;
        saveDb();
      }
      const reason = invite.expiredAt || Date.parse(invite.expiresAt) <= Date.now() ? 'invite_expired' : 'invite_invalid';
      auditB2B2CDenied(req, 'b2b2c.invite.accept.denied', athlete, reason);
      return b2bError(res, 410, 'invite_invalid', 'invite is invalid or expired');
    }
    if (link.coachId === athlete.id) {
      auditB2B2CDenied(req, 'b2b2c.invite.accept.denied', athlete, 'self_relationship');
      return b2bError(res, 409, 'self_relationship', 'a professional cannot accept their own invite');
    }
    if (db.coachAthleteLinks.some(item => item.id !== link.id && item.coachId === link.coachId && item.athleteId === athlete.id && item.status !== 'ended')) {
      auditB2B2CDenied(req, 'b2b2c.invite.accept.denied', athlete, 'relationship_exists');
      return b2bError(res, 409, 'relationship_exists', 'a relationship already exists');
    }
    const candidate = structuredClone(db);
    const candidateLink = candidate.coachAthleteLinks.find(item => item.id === link.id);
    const candidateInvite = candidate.coachInvites.find(item => item.id === invite.id);
    const now = new Date().toISOString();
    candidateLink.athleteId = athlete.id;
    candidateLink.status = 'active';
    candidateLink.acceptedAt = now;
    candidateLink.updatedAt = now;
    candidateInvite.acceptedAt = now;
    candidateInvite.acceptedBy = athlete.id;
    const compactionResult = compactB2B2C(candidate, B2B2C_LIMITS);
    saveDb(candidate);
    publishDb(candidate);
    if (compactionResult?.expiredAssessments?.length) {
      for (const item of compactionResult.expiredAssessments) removeOrphanedAssessmentPhotos(item);
    }
    const publishedLink = db.coachAthleteLinks.find(item => item.id === link.id);
    const coach = db.users.find(user => user.id === publishedLink.coachId);
    audit(req, 'b2b2c.invite.accept', { user: athlete, target: coach, msg: publishedLink.id });
    json(res, 200, { link: serializeLink(db, publishedLink, athlete) });
  },

  'GET /api/coach/athletes': async (req, res) => {
    const coach = readSession(req);
    if (!coach) return b2bError(res, 401, 'not_signed_in', 'not signed in');
    if (profileOf(coach).kind !== 'coach') return b2bError(res, 403, 'role_forbidden', 'professional profile required');
    compactRelationships();
    const links = db.coachAthleteLinks.filter(link => link.coachId === coach.id).map(link => {
      const out = serializeLink(db, link, coach);
      const invite = db.coachInvites.find(item => item.linkId === link.id);
      return invite ? { ...out, expiresAt: invite.expiresAt } : out;
    });
    json(res, 200, { links });
  },

  'GET /api/athlete/coaches': async (req, res) => {
    const athlete = readSession(req);
    if (!athlete) return b2bError(res, 401, 'not_signed_in', 'not signed in');
    compactRelationships();
    const links = db.coachAthleteLinks.filter(link => link.athleteId === athlete.id).map(link => serializeLink(db, link, athlete));
    json(res, 200, { links });
  },

  'GET /api/coach/athletes/{athleteId}/routines': async (req, res) => {
    const coach = readSession(req);
    if (!coach) return b2bError(res, 401, 'not_signed_in', 'not signed in');
    if (profileOf(coach).kind !== 'coach') return b2bError(res, 403, 'role_forbidden', 'professional profile required');
    const access = authorizeAthleteAccess(db, coach, req.athleteId, 'athlete:training:read');
    if (!access.ok) {
      auditB2B2CDenied(req, 'b2b2c.prescription.list.denied', coach, access.code);
      const status = access.code === 'relationship_not_found' ? 404 : 403;
      return b2bError(res, status, access.code, 'training relationship required');
    }
    const routines = db.coachPrescriptions
      .filter(item => item.coachId === coach.id && item.athleteId === req.athleteId && item.state !== 'withdrawn')
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .map(item => serializePrescription(db, item));
    json(res, 200, { routines });
  },

  'POST /api/coach/athletes/{athleteId}/routines': async (req, res) => {
    const coach = readSession(req);
    if (!coach) return b2bError(res, 401, 'not_signed_in', 'not signed in');
    if (profileOf(coach).kind !== 'coach') return b2bError(res, 403, 'role_forbidden', 'professional profile required');
    const access = authorizeAthleteAccess(db, coach, req.athleteId, 'athlete:training:write');
    if (!access.ok) {
      auditB2B2CDenied(req, 'b2b2c.prescription.create.denied', coach, access.code);
      const status = access.code === 'relationship_not_found' ? 404 : 403;
      return b2bError(res, status, access.code, 'active training relationship required');
    }
    const routine = validatePrescriptionRoutine(await readBody(req));
    if (!routine) return b2bError(res, 400, 'invalid_routine', 'invalid prescribed routine');
    const activeForAthlete = db.coachPrescriptions.filter(item => item.athleteId === req.athleteId && item.state !== 'withdrawn').length;
    if (activeForAthlete >= B2B2C_LIMITS.prescriptionsPerAthlete || db.coachPrescriptions.filter(item => item.state !== 'withdrawn').length >= B2B2C_LIMITS.maxPrescriptions) {
      auditB2B2CDenied(req, 'b2b2c.prescription.create.denied', coach, 'prescription_capacity');
      return b2bError(res, 409, 'prescription_capacity', 'prescription storage capacity reached');
    }
    const now = new Date().toISOString();
    const prescription = {
      id: makeEntityId('cpr', db.coachPrescriptions),
      coachId: coach.id,
      athleteId: req.athleteId,
      routine,
      state: 'available',
      createdAt: now,
      updatedAt: now,
    };
    const candidate = structuredClone(db);
    candidate.coachPrescriptions.push(prescription);
    const compactionResult = compactB2B2C(candidate, B2B2C_LIMITS);
    saveDb(candidate);
    publishDb(candidate);
    if (compactionResult?.expiredAssessments?.length) {
      for (const item of compactionResult.expiredAssessments) removeOrphanedAssessmentPhotos(item);
    }
    audit(req, 'b2b2c.prescription.create', { user: coach, target: db.users.find(user => user.id === req.athleteId), msg: prescription.id });
    json(res, 201, { routine: serializePrescription(db, prescription) });
  },

  'DELETE /api/coach/athletes/{athleteId}/routines/{routineId}': async (req, res) => {
    const coach = readSession(req);
    if (!coach) return b2bError(res, 401, 'not_signed_in', 'not signed in');
    if (profileOf(coach).kind !== 'coach') return b2bError(res, 403, 'role_forbidden', 'professional profile required');
    const access = authorizeAthleteAccess(db, coach, req.athleteId, 'athlete:training:write');
    if (!access.ok) {
      auditB2B2CDenied(req, 'b2b2c.prescription.withdraw.denied', coach, access.code);
      const status = access.code === 'relationship_not_found' ? 404 : 403;
      return b2bError(res, status, access.code, 'active training relationship required');
    }
    const prescription = db.coachPrescriptions.find(item => item.id === req.routineId && item.coachId === coach.id && item.athleteId === req.athleteId);
    if (!prescription) {
      auditB2B2CDenied(req, 'b2b2c.prescription.withdraw.denied', coach, 'routine_not_found');
      return b2bError(res, 404, 'routine_not_found', 'prescribed routine not found');
    }
    if (prescription.state !== 'withdrawn') {
      const candidate = structuredClone(db);
      const candidatePrescription = candidate.coachPrescriptions.find(item => item.id === prescription.id);
      const now = new Date().toISOString();
      candidatePrescription.state = 'withdrawn';
      candidatePrescription.updatedAt = now;
      candidatePrescription.withdrawnAt = now;
      const compactionResult = compactB2B2C(candidate, B2B2C_LIMITS);
      saveDb(candidate);
      publishDb(candidate);
      if (compactionResult?.expiredAssessments?.length) {
        for (const item of compactionResult.expiredAssessments) removeOrphanedAssessmentPhotos(item);
      }
      audit(req, 'b2b2c.prescription.withdraw', { user: coach, target: db.users.find(user => user.id === req.athleteId), msg: prescription.id });
    }
    json(res, 200, { routine: serializePrescription(db, db.coachPrescriptions.find(item => item.id === prescription.id) || prescription) });
  },

  'GET /api/coach/athletes/{athleteId}/meal-plans': async (req, res) => {
    const coach = readSession(req);
    if (!coach) return b2bError(res, 401, 'not_signed_in', 'not signed in');
    if (profileOf(coach).kind !== 'coach') return b2bError(res, 403, 'role_forbidden', 'professional profile required');
    const access = authorizeAthleteAccess(db, coach, req.athleteId, 'athlete:nutrition:read');
    if (!access.ok) {
      auditB2B2CDenied(req, 'b2b2c.meal-plan.list.denied', coach, access.code);
      return b2bError(res, access.code === 'relationship_not_found' ? 404 : 403, access.code, 'active nutrition relationship required');
    }
    const mealPlans = db.mealPlans.filter(plan => plan.coachId === coach.id && plan.athleteId === req.athleteId)
      .sort((left, right) => right.updatedAt - left.updatedAt).map(plan => serializeMealPlan(db, plan));
    audit(req, 'b2b2c.meal-plan.list', { user: coach, target: db.users.find(user => user.id === req.athleteId), msg: String(mealPlans.length) });
    json(res, 200, { mealPlans, quota: { used: mealPlans.length, limit: B2B2C_LIMITS.maxMealPlansPerAthlete } });
  },

  'POST /api/coach/athletes/{athleteId}/meal-plans': async (req, res) => {
    const coach = readSession(req);
    if (!coach) return b2bError(res, 401, 'not_signed_in', 'not signed in');
    if (profileOf(coach).kind !== 'coach') return b2bError(res, 403, 'role_forbidden', 'professional profile required');
    if (mealPlanThrottle(req, res, coach, 'create')) return;
    const access = authorizeAthleteAccess(db, coach, req.athleteId, 'athlete:nutrition:write');
    if (!access.ok) {
      auditB2B2CDenied(req, 'b2b2c.meal-plan.create.denied', coach, access.code);
      return b2bError(res, access.code === 'relationship_not_found' ? 404 : 403, access.code, 'active nutrition relationship required');
    }
    const normalized = validateMealPlan(await readBody(req));
    if (!normalized) {
      auditB2B2CDenied(req, 'b2b2c.meal-plan.create.denied', coach, 'invalid_meal_plan');
      return b2bError(res, 400, 'invalid_meal_plan', 'invalid meal plan');
    }
    const pairCount = db.mealPlans.filter(plan => plan.coachId === coach.id && plan.athleteId === req.athleteId).length;
    if (pairCount >= B2B2C_LIMITS.maxMealPlansPerAthlete || db.mealPlans.length >= B2B2C_LIMITS.maxMealPlans) {
      auditB2B2CDenied(req, 'b2b2c.meal-plan.create.denied', coach, 'meal_plan_capacity');
      return b2bError(res, 409, 'meal_plan_capacity', 'meal plan storage capacity reached');
    }
    const now = Date.now();
    const row = { id: makeEntityId('mp', db.mealPlans), coachId: coach.id, athleteId: req.athleteId, ...normalized, createdAt: now, updatedAt: now };
    let next = db.mealPlans;
    if (row.status === 'active') {
      next = next.map(plan => plan.athleteId === req.athleteId && plan.status === 'active'
        ? { ...plan, status: 'archived', updatedAt: now } : plan);
    }
    try { commitNutrition([...next, row]); }
    catch { return b2bError(res, 503, 'storage_unavailable', 'meal plan could not be saved'); }
    audit(req, 'b2b2c.meal-plan.create', { user: coach, target: db.users.find(user => user.id === req.athleteId), msg: row.id });
    json(res, 201, { mealPlan: serializeMealPlan(db, row) });
  },

  'GET /api/coach/athletes/{athleteId}/meal-plans/{planId}': async (req, res) => {
    const coach = readSession(req);
    if (!coach) return b2bError(res, 401, 'not_signed_in', 'not signed in');
    if (profileOf(coach).kind !== 'coach') return b2bError(res, 403, 'role_forbidden', 'professional profile required');
    const access = authorizeAthleteAccess(db, coach, req.athleteId, 'athlete:nutrition:read');
    if (!access.ok) return b2bError(res, access.code === 'relationship_not_found' ? 404 : 403, access.code, 'active nutrition relationship required');
    const candidate = db.mealPlans.find(plan => plan.id === req.planId && plan.athleteId === req.athleteId);
    if (candidate && candidate.coachId !== coach.id) {
      auditB2B2CDenied(req, 'b2b2c.meal-plan.read.denied', coach, 'meal_plan_forbidden');
      return b2bError(res, 403, 'meal_plan_forbidden', 'meal plan belongs to another professional');
    }
    if (!candidate) return b2bError(res, 404, 'meal_plan_not_found', 'meal plan not found');
    audit(req, 'b2b2c.meal-plan.read', { user: coach, target: db.users.find(user => user.id === req.athleteId), msg: candidate.id });
    json(res, 200, { mealPlan: serializeMealPlan(db, candidate) });
  },

  'PATCH /api/coach/athletes/{athleteId}/meal-plans/{planId}': async (req, res) => {
    const coach = readSession(req);
    if (!coach) return b2bError(res, 401, 'not_signed_in', 'not signed in');
    if (profileOf(coach).kind !== 'coach') return b2bError(res, 403, 'role_forbidden', 'professional profile required');
    if (mealPlanThrottle(req, res, coach, 'update')) return;
    const access = authorizeAthleteAccess(db, coach, req.athleteId, 'athlete:nutrition:write');
    if (!access.ok) return b2bError(res, access.code === 'relationship_not_found' ? 404 : 403, access.code, 'active nutrition relationship required');
    const index = db.mealPlans.findIndex(plan => plan.id === req.planId && plan.athleteId === req.athleteId);
    if (index < 0) return b2bError(res, 404, 'meal_plan_not_found', 'meal plan not found');
    if (db.mealPlans[index].coachId !== coach.id) {
      auditB2B2CDenied(req, 'b2b2c.meal-plan.update.denied', coach, 'meal_plan_forbidden');
      return b2bError(res, 403, 'meal_plan_forbidden', 'meal plan belongs to another professional');
    }
    const body = await readBody(req);
    if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.keys(body).length
        || Object.keys(body).some(key => !['meals', 'notes', 'status', 'targetCalories', 'targetMacros', 'title'].includes(key))) {
      return b2bError(res, 400, 'invalid_meal_plan', 'invalid meal plan');
    }
    const current = db.mealPlans[index];
    const normalized = validateMealPlan({
      title: current.title, status: current.status, targetCalories: current.targetCalories,
      targetMacros: current.targetMacros, meals: current.meals, notes: current.notes, ...body,
    });
    if (!normalized) return b2bError(res, 400, 'invalid_meal_plan', 'invalid meal plan');
    const now = Date.now();
    const updated = { ...current, ...normalized, updatedAt: now };
    let next = db.mealPlans.map((plan, planIndex) => planIndex === index ? updated : plan);
    if (updated.status === 'active') {
      next = next.map(plan => plan.id !== updated.id && plan.athleteId === req.athleteId && plan.status === 'active'
        ? { ...plan, status: 'archived', updatedAt: now } : plan);
    }
    const allowedMealIds = new Set(updated.meals.map(meal => meal.id));
    const nextAdherence = db.mealAdherence.map(item => item.athleteId === updated.athleteId && item.mealPlanId === updated.id
      ? { ...item, mealsChecked: item.mealsChecked.filter(mealId => allowedMealIds.has(mealId)), updatedAt: now }
      : item);
    try { commitNutrition(next, nextAdherence); }
    catch { return b2bError(res, 503, 'storage_unavailable', 'meal plan could not be saved'); }
    audit(req, 'b2b2c.meal-plan.update', { user: coach, target: db.users.find(user => user.id === req.athleteId), msg: updated.id });
    json(res, 200, { mealPlan: serializeMealPlan(db, updated) });
  },

  'DELETE /api/coach/athletes/{athleteId}/meal-plans/{planId}': async (req, res) => {
    const coach = readSession(req);
    if (!coach) return b2bError(res, 401, 'not_signed_in', 'not signed in');
    if (profileOf(coach).kind !== 'coach') return b2bError(res, 403, 'role_forbidden', 'professional profile required');
    if (mealPlanThrottle(req, res, coach, 'delete')) return;
    const access = authorizeAthleteAccess(db, coach, req.athleteId, 'athlete:nutrition:write');
    if (!access.ok) return b2bError(res, access.code === 'relationship_not_found' ? 404 : 403, access.code, 'active nutrition relationship required');
    const plan = db.mealPlans.find(item => item.id === req.planId && item.athleteId === req.athleteId);
    if (!plan) return b2bError(res, 404, 'meal_plan_not_found', 'meal plan not found');
    if (plan.coachId !== coach.id) {
      auditB2B2CDenied(req, 'b2b2c.meal-plan.delete.denied', coach, 'meal_plan_forbidden');
      return b2bError(res, 403, 'meal_plan_forbidden', 'meal plan belongs to another professional');
    }
    try {
      commitNutrition(
        db.mealPlans.filter(item => !(item.id === plan.id && item.athleteId === plan.athleteId)),
        db.mealAdherence.filter(item => !(item.athleteId === plan.athleteId && item.mealPlanId === plan.id)),
      );
    } catch { return b2bError(res, 503, 'storage_unavailable', 'meal plan could not be deleted'); }
    audit(req, 'b2b2c.meal-plan.delete', { user: coach, target: db.users.find(user => user.id === req.athleteId), msg: plan.id });
    json(res, 200, { deleted: true, mealPlan: serializeMealPlan(db, plan) });
  },

  'GET /api/athlete/meal-plan': async (req, res) => {
    const athlete = readSession(req);
    if (!athlete) return b2bError(res, 401, 'not_signed_in', 'not signed in');
    const active = db.mealPlans.filter(plan => plan.athleteId === athlete.id && plan.status === 'active'
      && db.coachAthleteLinks.some(link => link.coachId === plan.coachId && link.athleteId === athlete.id
        && link.status === 'active' && link.scopes.includes('nutrition')))
      .sort((left, right) => right.updatedAt - left.updatedAt)[0] || null;
    audit(req, 'b2b2c.meal-plan.athlete-read', { user: athlete, msg: active?.id || 'none' });
    json(res, 200, { mealPlan: active ? serializeMealPlan(db, active) : null });
  },

  'GET /api/athlete/meal-adherence': async (req, res) => {
    const athlete = readSession(req);
    if (!athlete) return b2bError(res, 401, 'not_signed_in', 'not signed in');
    const date = new URL(req.url, 'http://x').searchParams.get('date');
    if (!date || !validateMealAdherence({ date, mealsChecked: [], waterDrunkMl: 0, notes: '' })) {
      return b2bError(res, 400, 'invalid_adherence', 'date must use YYYY-MM-DD');
    }
    const activePlanIds = new Set(db.mealPlans.filter(plan => plan.athleteId === athlete.id && plan.status === 'active'
      && db.coachAthleteLinks.some(link => link.coachId === plan.coachId && link.athleteId === athlete.id
        && link.status === 'active' && link.scopes.includes('nutrition'))).map(plan => plan.id));
    const rows = db.mealAdherence.filter(item => item.athleteId === athlete.id && item.date === date && activePlanIds.has(item.mealPlanId))
      .sort((left, right) => right.updatedAt - left.updatedAt).map(item => structuredClone(item));
    json(res, 200, { adherence: rows[0] || null, adherenceRecords: rows });
  },

  'POST /api/athlete/meal-adherence': async (req, res) => {
    const athlete = readSession(req);
    if (!athlete) return b2bError(res, 401, 'not_signed_in', 'not signed in');
    if (mealAdherenceThrottle(req, res, athlete)) return;
    const body = await readBody(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).some(key => !['date', 'mealPlanId', 'mealUpdate', 'notes', 'waterDrunkMl'].includes(key))
        || typeof body.mealPlanId !== 'string' || typeof body.date !== 'string'
        || !['mealUpdate', 'notes', 'waterDrunkMl'].some(key => Object.hasOwn(body, key))) {
      return b2bError(res, 400, 'invalid_adherence', 'invalid meal adherence mutation');
    }
    const plan = db.mealPlans.find(item => item.id === body.mealPlanId && item.athleteId === athlete.id && item.status === 'active');
    const allowed = plan && db.coachAthleteLinks.some(link => link.coachId === plan.coachId && link.athleteId === athlete.id
      && link.status === 'active' && link.scopes.includes('nutrition'));
    if (!allowed) return b2bError(res, 404, 'meal_plan_not_found', 'active meal plan not found');
    if (body.mealUpdate !== undefined && (!body.mealUpdate || typeof body.mealUpdate !== 'object' || Array.isArray(body.mealUpdate)
        || Object.keys(body.mealUpdate).some(key => !['checked', 'mealId'].includes(key))
        || typeof body.mealUpdate.mealId !== 'string' || typeof body.mealUpdate.checked !== 'boolean'
        || !plan.meals.some(meal => meal.id === body.mealUpdate.mealId))) {
      return b2bError(res, 400, 'invalid_adherence', 'invalid meal adherence mutation');
    }
    const retained = retainedMealAdherence();
    const existingIndex = retained.findIndex(item => item.athleteId === athlete.id && item.mealPlanId === plan.id && item.date === body.date);
    const current = existingIndex < 0 ? {
      date: body.date, mealsChecked: [], waterDrunkMl: 0, notes: '',
    } : retained[existingIndex];
    const checked = new Set(current.mealsChecked);
    if (body.mealUpdate) {
      if (body.mealUpdate.checked) checked.add(body.mealUpdate.mealId);
      else checked.delete(body.mealUpdate.mealId);
    }
    const normalized = validateMealAdherence({
      date: body.date,
      mealsChecked: [...checked],
      waterDrunkMl: Object.hasOwn(body, 'waterDrunkMl') ? body.waterDrunkMl : current.waterDrunkMl,
      notes: Object.hasOwn(body, 'notes') ? body.notes : current.notes,
    }, plan);
    if (!normalized) return b2bError(res, 400, 'invalid_adherence', 'invalid meal adherence');
    if (existingIndex < 0 && (retained.filter(item => item.athleteId === athlete.id).length >= B2B2C_LIMITS.maxMealAdherencePerAthlete
        || retained.length >= B2B2C_LIMITS.maxMealAdherence)) {
      return b2bError(res, 409, 'meal_adherence_capacity', 'meal adherence storage capacity reached');
    }
    const now = Date.now();
    const row = existingIndex < 0
      ? { id: makeEntityId('adh', retained), athleteId: athlete.id, mealPlanId: plan.id, ...normalized, updatedAt: now }
      : { ...retained[existingIndex], ...normalized, updatedAt: now };
    const next = existingIndex < 0 ? [...retained, row]
      : retained.map((item, index) => index === existingIndex ? row : item);
    try { commitNutrition(db.mealPlans, next); }
    catch { return b2bError(res, 503, 'storage_unavailable', 'meal adherence could not be saved'); }
    audit(req, 'b2b2c.meal-adherence.update', { user: athlete, target: db.users.find(user => user.id === plan.coachId), msg: row.id });
    json(res, existingIndex < 0 ? 201 : 200, { adherence: structuredClone(row) });
  },

  'GET /api/coach/athletes/{athleteId}/meal-adherence': async (req, res) => {
    const coach = readSession(req);
    if (!coach) return b2bError(res, 401, 'not_signed_in', 'not signed in');
    if (profileOf(coach).kind !== 'coach') return b2bError(res, 403, 'role_forbidden', 'professional profile required');
    const access = authorizeAthleteAccess(db, coach, req.athleteId, 'athlete:nutrition:read');
    if (!access.ok) return b2bError(res, access.code === 'relationship_not_found' ? 404 : 403, access.code, 'active nutrition relationship required');
    const url = new URL(req.url, 'http://x');
    const rawLimit = url.searchParams.get('limit');
    const limit = rawLimit === null ? 50 : Number(rawLimit);
    const cursor = parseAdherenceCursor(url.searchParams.get('cursor'));
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || cursor === false) {
      return b2bError(res, 400, 'invalid_pagination', 'limit must be 1-100 and cursor must be valid');
    }
    const planIds = new Set(db.mealPlans.filter(plan => plan.coachId === coach.id && plan.athleteId === req.athleteId).map(plan => plan.id));
    let rows = db.mealAdherence.filter(item => item.athleteId === req.athleteId && planIds.has(item.mealPlanId)).sort(adherenceNewestFirst);
    if (cursor) rows = rows.filter(item => adherenceNewestFirst(item, cursor) > 0);
    const hasMore = rows.length > limit;
    const adherence = rows.slice(0, limit).map(item => structuredClone(item));
    const nextCursor = hasMore ? adherenceCursor(rows[limit - 1]) : null;
    audit(req, 'b2b2c.meal-adherence.list', { user: coach, target: db.users.find(user => user.id === req.athleteId), msg: String(adherence.length) });
    json(res, 200, {
      adherence,
      page: { limit, hasMore, nextCursor },
      quota: {
        used: db.mealAdherence.filter(item => item.athleteId === req.athleteId).length,
        limit: B2B2C_LIMITS.maxMealAdherencePerAthlete,
        retentionDays: B2B2C_LIMITS.mealAdherenceRetentionDays,
      },
    });
  },

  'GET /api/assessments/config': async (req, res) => {
    if (!readSession(req)) return b2bError(res, 401, 'not_signed_in', 'not signed in');
    json(res, 200, {
      parq: { version: PARQ_VERSION, questions: PARQ_QUESTIONS },
      limits: { photos: 6, futureSkewSeconds: ASSESSMENT_FUTURE_SKEW_MS / 1000, maxAgeYears: ASSESSMENT_MAX_AGE_YEARS },
    });
  },

  'POST /api/athlete/coaches/{linkId}/assessment-consent': async (req, res) => {
    const athlete = readSession(req);
    if (!athlete) return b2bError(res, 401, 'not_signed_in', 'not signed in');
    const body = await readBody(req);
    if (typeof body.granted !== 'boolean' || Object.keys(body).some(key => key !== 'granted')) {
      return b2bError(res, 400, 'invalid_consent', 'granted must be a boolean');
    }
    const link = db.coachAthleteLinks.find(item => item.id === req.linkId && item.athleteId === athlete.id);
    if (!link) return b2bError(res, 404, 'relationship_not_found', 'relationship not found');
    if (link.status !== 'active') return b2bError(res, 409, 'relationship_inactive', 'relationship is not active');
    const coach = db.users.find(user => user.id === link.coachId);
    if (body.granted && !profileOf(coach).coachSpecialties.includes('assessments')) {
      return b2bError(res, 409, 'coach_not_eligible', 'professional profile does not offer assessments');
    }
    const now = new Date().toISOString();
    const scopes = body.granted ? [...new Set([...link.scopes, 'assessments'])] : link.scopes.filter(scope => scope !== 'assessments');
    try { commitAssessmentConsent(link, scopes, now, athlete.id); }
    catch { return b2bError(res, 503, 'storage_unavailable', 'consent could not be saved'); }
    audit(req, body.granted ? 'b2b2c.assessment.consent.grant' : 'b2b2c.assessment.consent.revoke', { user: athlete, target: coach, msg: link.id });
    json(res, 200, { link: serializeLink(db, db.coachAthleteLinks.find(item => item.id === link.id), athlete) });
  },

  'GET /api/coach/athletes/{athleteId}/assessments': async (req, res) => {
    const coach = readSession(req);
    if (!coach) return b2bError(res, 401, 'not_signed_in', 'not signed in');
    if (profileOf(coach).kind !== 'coach') {
      auditB2B2CDenied(req, 'b2b2c.assessment.list.denied', coach, 'role_forbidden');
      return b2bError(res, 403, 'role_forbidden', 'professional profile required');
    }
    const access = authorizeAthleteAccess(db, coach, req.athleteId, 'athlete:assessments:read');
    if (!access.ok) {
      auditB2B2CDenied(req, 'b2b2c.assessment.list.denied', coach, access.code);
      return b2bError(res, access.code === 'relationship_not_found' ? 404 : 403, access.code, 'assessment consent required');
    }
    const assessments = db.coachAssessments
      .filter(item => item.coachId === coach.id && item.athleteId === req.athleteId)
      .sort((left, right) => Date.parse(right.assessedAt) - Date.parse(left.assessedAt))
      .map(serializeAssessment);
    audit(req, 'b2b2c.assessment.list', { user: coach, target: db.users.find(user => user.id === req.athleteId), msg: String(assessments.length) });
    json(res, 200, { assessments });
  },

  'POST /api/coach/athletes/{athleteId}/assessments': async (req, res) => {
    const coach = readSession(req);
    if (!coach) return b2bError(res, 401, 'not_signed_in', 'not signed in');
    if (profileOf(coach).kind !== 'coach') {
      auditB2B2CDenied(req, 'b2b2c.assessment.create.denied', coach, 'role_forbidden');
      return b2bError(res, 403, 'role_forbidden', 'professional profile required');
    }
    if (assessmentThrottle(req, res, coach)) return;
    const access = authorizeAthleteAccess(db, coach, req.athleteId, 'athlete:assessments:write');
    if (!access.ok) {
      auditB2B2CDenied(req, 'b2b2c.assessment.create.denied', coach, access.code);
      return b2bError(res, access.code === 'relationship_not_found' ? 404 : 403, access.code, 'assessment consent required');
    }
    const assessment = validateAssessment(await readBody(req), {
      futureSkewMs: ASSESSMENT_FUTURE_SKEW_MS, maxAgeYears: ASSESSMENT_MAX_AGE_YEARS,
    });
    if (!assessment) {
      auditB2B2CDenied(req, 'b2b2c.assessment.create.denied', coach, 'invalid_assessment');
      return b2bError(res, 400, 'invalid_assessment', 'invalid physical assessment');
    }
    const forRelationship = db.coachAssessments.filter(item => item.coachId === coach.id && item.athleteId === req.athleteId).length;
    if (forRelationship >= B2B2C_LIMITS.maxAssessmentsPerAthlete || db.coachAssessments.length >= B2B2C_LIMITS.maxAssessments) {
      auditB2B2CDenied(req, 'b2b2c.assessment.create.denied', coach, 'assessment_capacity');
      return b2bError(res, 409, 'assessment_capacity', 'assessment storage capacity reached');
    }
    const now = new Date().toISOString();
    const results = assessmentResults(assessment);
    if (results === null) {
      auditB2B2CDenied(req, 'b2b2c.assessment.create.denied', coach, 'invalid_assessment');
      return b2bError(res, 400, 'invalid_assessment', 'calculated result is outside the supported clinical domain');
    }
    for (const photo of assessment.photos || []) {
      const stored = MEDIA_ON && MEDIA.file(coach.id, photo.hash);
      if (!stored || stored.mime !== photo.mime || stored.size !== photo.size) {
        return b2bError(res, 400, 'invalid_assessment_photo', 'assessment photo is missing or does not match');
      }
    }
    const requiresMedicalClearance = assessment.parq?.answers.some(answer => answer.answer) || false;
    if (requiresMedicalClearance && !assessment.parq?.acknowledged) {
      auditB2B2CDenied(req, 'b2b2c.assessment.' + (req.assessmentId ? 'correct' : 'create') + '.denied', coach, 'medical_clearance_unacknowledged');
      return b2bError(res, 400, 'invalid_assessment', 'medical clearance guidance must be acknowledged when PAR-Q is positive');
    }
    const row = {
      id: makeEntityId('cas', db.coachAssessments),
      coachId: coach.id,
      athleteId: req.athleteId,
      ...assessment,
      assessedAt: assessment.assessedAt || now,
      ...(results ? { results } : {}),
      ...(assessment.photos?.length ? { photoOwnerId: coach.id } : {}),
      requiresMedicalClearance,
      ...(requiresMedicalClearance && assessment.parq.acknowledged ? { medicalAdviceAcknowledgedAt: now } : {}),
      createdAt: now,
      updatedAt: now,
    };
    try { commitAssessmentCollection([...db.coachAssessments, row]); }
    catch { return b2bError(res, 503, 'storage_unavailable', 'assessment could not be saved'); }
    audit(req, 'b2b2c.assessment.create', { user: coach, target: db.users.find(user => user.id === req.athleteId), msg: row.id });
    json(res, 201, { assessment: serializeAssessment(row) });
  },

  'GET /api/coach/athletes/{athleteId}/assessments/{assessmentId}': async (req, res) => {
    const coach = readSession(req);
    if (!coach) return b2bError(res, 401, 'not_signed_in', 'not signed in');
    if (profileOf(coach).kind !== 'coach') {
      auditB2B2CDenied(req, 'b2b2c.assessment.read.denied', coach, 'role_forbidden');
      return b2bError(res, 403, 'role_forbidden', 'professional profile required');
    }
    const access = authorizeAthleteAccess(db, coach, req.athleteId, 'athlete:assessments:read');
    if (!access.ok) {
      auditB2B2CDenied(req, 'b2b2c.assessment.read.denied', coach, access.code);
      return b2bError(res, access.code === 'relationship_not_found' ? 404 : 403, access.code, 'assessment consent required');
    }
    const item = db.coachAssessments.find(assessment => assessment.id === req.assessmentId
      && assessment.coachId === coach.id && assessment.athleteId === req.athleteId);
    if (!item) {
      auditB2B2CDenied(req, 'b2b2c.assessment.read.denied', coach, 'assessment_not_found');
      return b2bError(res, 404, 'assessment_not_found', 'physical assessment not found');
    }
    audit(req, 'b2b2c.assessment.read', { user: coach, target: db.users.find(user => user.id === req.athleteId), msg: item.id });
    json(res, 200, { assessment: serializeAssessment(item) });
  },

  'PATCH /api/coach/athletes/{athleteId}/assessments/{assessmentId}': async (req, res) => {
    const coach = readSession(req);
    if (!coach) return b2bError(res, 401, 'not_signed_in', 'not signed in');
    if (profileOf(coach).kind !== 'coach') {
      auditB2B2CDenied(req, 'b2b2c.assessment.correct.denied', coach, 'role_forbidden');
      return b2bError(res, 403, 'role_forbidden', 'professional profile required');
    }
    const access = authorizeAthleteAccess(db, coach, req.athleteId, 'athlete:assessments:write');
    if (!access.ok) {
      auditB2B2CDenied(req, 'b2b2c.assessment.correct.denied', coach, access.code);
      return b2bError(res, access.code === 'relationship_not_found' ? 404 : 403, access.code, 'assessment consent required');
    }
    const index = db.coachAssessments.findIndex(item => item.id === req.assessmentId && item.coachId === coach.id && item.athleteId === req.athleteId);
    if (index < 0) {
      auditB2B2CDenied(req, 'b2b2c.assessment.correct.denied', coach, 'assessment_not_found');
      return b2bError(res, 404, 'assessment_not_found', 'physical assessment not found');
    }
    const assessment = validateAssessment(await readBody(req), {
      futureSkewMs: ASSESSMENT_FUTURE_SKEW_MS, maxAgeYears: ASSESSMENT_MAX_AGE_YEARS,
    });
    if (!assessment) return b2bError(res, 400, 'invalid_assessment', 'invalid physical assessment');
    const results = assessmentResults(assessment);
    if (results === null) return b2bError(res, 400, 'invalid_assessment', 'calculated result is outside the supported clinical domain');
    for (const photo of assessment.photos || []) {
      const stored = MEDIA_ON && MEDIA.file(coach.id, photo.hash);
      if (!stored || stored.mime !== photo.mime || stored.size !== photo.size) return b2bError(res, 400, 'invalid_assessment_photo', 'assessment photo is missing or does not match');
    }
    const previous = db.coachAssessments[index];
    const now = new Date().toISOString();
    const requiresMedicalClearance = assessment.parq?.answers.some(answer => answer.answer) || false;
    if (requiresMedicalClearance && !assessment.parq?.acknowledged) {
      auditB2B2CDenied(req, 'b2b2c.assessment.' + (req.assessmentId ? 'correct' : 'create') + '.denied', coach, 'medical_clearance_unacknowledged');
      return b2bError(res, 400, 'invalid_assessment', 'medical clearance guidance must be acknowledged when PAR-Q is positive');
    }
    const row = {
      id: previous.id, coachId: previous.coachId, athleteId: previous.athleteId, ...assessment,
      assessedAt: assessment.assessedAt || previous.assessedAt,
      ...(results ? { results } : {}),
      ...(assessment.photos?.length ? { photoOwnerId: coach.id } : {}),
      requiresMedicalClearance,
      ...(requiresMedicalClearance && assessment.parq.acknowledged ? { medicalAdviceAcknowledgedAt: previous.medicalAdviceAcknowledgedAt || now } : {}),
      createdAt: previous.createdAt, updatedAt: now,
    };
    const next = [...db.coachAssessments]; next[index] = row;
    try { commitAssessmentCollection(next); }
    catch { return b2bError(res, 503, 'storage_unavailable', 'assessment correction could not be saved'); }
    removeOrphanedAssessmentPhotos(previous);
    audit(req, 'b2b2c.assessment.correct', { user: coach, target: db.users.find(user => user.id === req.athleteId), msg: row.id });
    json(res, 200, { assessment: serializeAssessment(row) });
  },

  'DELETE /api/coach/athletes/{athleteId}/assessments/{assessmentId}': async (req, res) => {
    const coach = readSession(req);
    if (!coach) return b2bError(res, 401, 'not_signed_in', 'not signed in');
    if (profileOf(coach).kind !== 'coach') {
      auditB2B2CDenied(req, 'b2b2c.assessment.delete.denied', coach, 'role_forbidden');
      return b2bError(res, 403, 'role_forbidden', 'professional profile required');
    }
    const access = authorizeAthleteAccess(db, coach, req.athleteId, 'athlete:assessments:write');
    if (!access.ok) {
      auditB2B2CDenied(req, 'b2b2c.assessment.delete.denied', coach, access.code);
      return b2bError(res, access.code === 'relationship_not_found' ? 404 : 403, access.code, 'assessment consent required');
    }
    const index = db.coachAssessments.findIndex(assessment => assessment.id === req.assessmentId
      && assessment.coachId === coach.id && assessment.athleteId === req.athleteId);
    if (index < 0) {
      auditB2B2CDenied(req, 'b2b2c.assessment.delete.denied', coach, 'assessment_not_found');
      return b2bError(res, 404, 'assessment_not_found', 'physical assessment not found');
    }
    const item = db.coachAssessments[index];
    try { commitAssessmentCollection(db.coachAssessments.filter((_, itemIndex) => itemIndex !== index)); }
    catch { return b2bError(res, 503, 'storage_unavailable', 'assessment could not be deleted'); }
    removeOrphanedAssessmentPhotos(item);
    audit(req, 'b2b2c.assessment.delete', { user: coach, target: db.users.find(user => user.id === req.athleteId), msg: item.id });
    json(res, 200, { assessment: serializeAssessment(item) });
  },

  'GET /api/athlete/assessments': async (req, res) => {
    const athlete = readSession(req);
    if (!athlete) return b2bError(res, 401, 'not_signed_in', 'not signed in');
    const assessments = db.coachAssessments
      .filter(item => item.athleteId === athlete.id)
      .sort((left, right) => Date.parse(right.assessedAt) - Date.parse(left.assessedAt))
      .map(serializeAssessment);
    audit(req, 'b2b2c.assessment.athlete-list', { user: athlete, msg: String(assessments.length) });
    json(res, 200, { assessments });
  },

  'DELETE /api/athlete/assessments/{assessmentId}': async (req, res) => {
    const athlete = readSession(req);
    if (!athlete) return b2bError(res, 401, 'not_signed_in', 'not signed in');
    const body = await readBody(req);
    if (body.confirmation !== req.assessmentId || Object.keys(body).some(key => key !== 'confirmation')) {
      return b2bError(res, 400, 'confirmation_required', 'assessment id confirmation required');
    }
    const index = db.coachAssessments.findIndex(item => item.id === req.assessmentId && item.athleteId === athlete.id);
    if (index < 0) return b2bError(res, 404, 'assessment_not_found', 'physical assessment not found');
    const item = db.coachAssessments[index];
    try { commitAssessmentCollection(db.coachAssessments.filter((_, itemIndex) => itemIndex !== index)); }
    catch { return b2bError(res, 503, 'storage_unavailable', 'assessment could not be deleted'); }
    removeOrphanedAssessmentPhotos(item);
    audit(req, 'b2b2c.assessment.athlete-delete', { user: athlete, target: db.users.find(user => user.id === item.coachId), msg: item.id });
    json(res, 200, { deleted: true, assessment: serializeAssessment(item) });
  },

  'GET /api/assessments/{assessmentId}/photos/{hash}': async (req, res) => {
    const user = readSession(req);
    if (!user) return b2bError(res, 401, 'not_signed_in', 'not signed in');
    const item = db.coachAssessments.find(assessment => assessment.id === req.assessmentId
      && assessment.photos?.some(photo => photo.hash === req.mediaHash));
    if (!item) throw new MediaError(404, 'media-missing');
    const own = item.athleteId === user.id;
    const coachAccess = item.coachId === user.id && authorizeAthleteAccess(db, user, item.athleteId, 'athlete:assessments:read').ok;
    if (!own && !coachAccess) throw new MediaError(404, 'media-missing');
    const file = MEDIA.file(item.photoOwnerId, req.mediaHash);
    if (!file) throw new MediaError(404, 'media-missing');
    await sendMediaFile(res, file, req.mediaHash);
  },

  'GET /api/athlete/prescriptions': async (req, res) => {
    const athlete = readSession(req);
    if (!athlete) return b2bError(res, 401, 'not_signed_in', 'not signed in');
    const activeTrainingCoaches = new Set(db.coachAthleteLinks
      .filter(link => link.athleteId === athlete.id && link.status === 'active' && link.scopes.includes('training'))
      .map(link => link.coachId));
    const prescriptions = db.coachPrescriptions
      .filter(item => item.athleteId === athlete.id && item.state !== 'withdrawn' && activeTrainingCoaches.has(item.coachId))
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .map(item => serializePrescription(db, item));
    json(res, 200, { prescriptions });
  },

  'POST /api/athlete/prescriptions/{routineId}/adopt': async (req, res) => {
    const athlete = readSession(req);
    if (!athlete) return b2bError(res, 401, 'not_signed_in', 'not signed in');
    const result = await withStateWrite(athlete.id, req, async () => {
      const prescription = db.coachPrescriptions.find(item => item.id === req.routineId && item.athleteId === athlete.id && item.state !== 'withdrawn');
      if (!prescription) return { status: 404, code: 'routine_not_found', message: 'prescribed routine not found' };
      const coach = db.users.find(user => user.id === prescription.coachId);
      const access = authorizeAthleteAccess(db, coach, athlete.id, 'athlete:training:write');
      if (!access.ok) return { status: 403, code: access.code, message: 'active training relationship required' };
      const current = readStateStrict(athlete.id);
      if (STATE_WRITE_TEST_DIR) await stateWriteTestWait('adoption-after-read', athlete.id);
      if (current === UNREADABLE || !prescriptionStateReadable(current)) {
        console.error('state file unreadable for', athlete.id);
        return { status: 503, code: 'state_unreadable', message: 'state unreadable' };
      }
      let adoption;
      try { adoption = adoptPrescriptionState(current, prescription); }
      catch (error) {
        if (error instanceof RangeError) return { status: 503, code: 'state_unreadable', message: 'state unreadable' };
        throw error;
      }
      const sameRoutineIds = Array.isArray(prescription.adoptedRoutineIds) &&
        prescription.adoptedRoutineIds.length === adoption.routineIds.length &&
        prescription.adoptedRoutineIds.every((id, index) => id === adoption.routineIds[index]);
      if (!adoption.changed && prescription.state === 'adopted' && sameRoutineIds &&
          !fs.existsSync(adoptionJournalFile(athlete.id, prescription.id))) {
        return { status: 200, prescription, routineIds: [...prescription.adoptedRoutineIds] };
      }
      let transaction;
      try { transaction = adoptionJournalFor(athlete.id, prescription.id, adoption.routineIds); }
      catch (error) {
        console.error('could not create prescription adoption journal', error);
        return { status: 503, code: 'adoption_pending', message: 'adoption could not be committed; retry' };
      }
      try {
        const completed = finishAdoptionJournal(transaction.file, transaction.journal, req);
        return { status: 200, ...completed };
      } catch (error) {
        console.error('prescription adoption pending recovery', transaction.journal.tx, error);
        return { status: 503, code: 'adoption_pending', message: 'adoption is pending recovery; retry' };
      }
    });
    if (result.status !== 200) {
      if (result.code !== 'adoption_pending') auditB2B2CDenied(req, 'b2b2c.prescription.adopt.denied', athlete, result.code);
      return b2bError(res, result.status, result.code, result.message);
    }
    json(res, 200, { prescription: serializePrescription(db, result.prescription), routineIds: result.routineIds });
  },

  'POST /api/coach/links/status': async (req, res) => {
    const actor = readSession(req);
    if (!actor) return b2bError(res, 401, 'not_signed_in', 'not signed in');
    const body = await readBody(req);
    const link = linkForActor(db, actor, typeof body.linkId === 'string' ? body.linkId : '');
    if (!link) {
      auditB2B2CDenied(req, 'b2b2c.link.transition.denied', actor, 'relationship_not_found');
      return b2bError(res, 404, 'relationship_not_found', 'relationship not found');
    }
    if (!['suspended', 'ended'].includes(body.status)) {
      auditB2B2CDenied(req, 'b2b2c.link.transition.denied', actor, 'invalid_status');
      return b2bError(res, 400, 'invalid_status', 'invalid relationship status');
    }
    if (link.status === body.status) return json(res, 200, { link: serializeLink(db, link, actor) });
    const allowed = (body.status === 'suspended' && link.status === 'active')
      || (body.status === 'ended' && ['pending', 'active', 'suspended'].includes(link.status));
    if (!allowed) {
      auditB2B2CDenied(req, 'b2b2c.link.transition.denied', actor, 'invalid_transition');
      return b2bError(res, 409, 'invalid_transition', 'invalid relationship transition');
    }
    const candidate = structuredClone(db);
    const candidateLink = candidate.coachAthleteLinks.find(item => item.id === link.id);
    const now = new Date().toISOString();
    candidateLink.status = body.status;
    candidateLink.updatedAt = now;
    if (body.status === 'suspended') { candidateLink.suspendedAt = now; candidateLink.suspendedBy = actor.id; }
    if (body.status === 'ended') { candidateLink.endedAt = now; candidateLink.endedBy = actor.id; }
    if (['suspended', 'ended'].includes(body.status)) {
      cancelFutureAppointmentsForLink(candidate, link.id, 'relationship_' + body.status, actor.id, Date.parse(now));
    }
    const compactionResult = compactB2B2C(candidate, B2B2C_LIMITS);
    try { saveDb(candidate); }
    catch { return b2bError(res, 503, 'storage_unavailable', 'relationship transition could not be saved'); }
    publishDb(candidate);
    if (compactionResult?.expiredAssessments?.length) {
      for (const item of compactionResult.expiredAssessments) removeOrphanedAssessmentPhotos(item);
    }
    const publishedLink = db.coachAthleteLinks.find(item => item.id === link.id);
    const targetId = actor.id === publishedLink.coachId ? publishedLink.athleteId : publishedLink.coachId;
    audit(req, body.status === 'suspended' ? 'b2b2c.link.suspend' : 'b2b2c.link.end', {
      user: actor, target: db.users.find(user => user.id === targetId), msg: publishedLink.id,
    });
    json(res, 200, { link: serializeLink(db, publishedLink, actor) });
  },

  'POST /api/register/options': async (req, res) => {
    const body = await readBody(req);
    const name = text(body.name).trim().slice(0, 40);
    if (!name) return json(res, 400, { error: 'name required' });
    const code = text(body.code).trim().toUpperCase();
    if (INVITE_ONLY && !db.invites.some(i => i.code === code && !i.usedBy && !i.revoked)) {
      // The rejected code itself is never recorded — a near-miss guess in the log is a liability.
      audit(req, 'auth.register.denied', { ok: false, name, msg: 'invite-rejected' });
      return json(res, 403, { error: 'a valid invite code is required', code: 'invite' });
    }
    const uid = crypto.randomBytes(12).toString('base64url');
    const options = await generateRegistrationOptions({
      rpName: RP_NAME, rpID: RP_ID,
      userID: Buffer.from(uid), userName: name, userDisplayName: name,
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
      excludeCredentials: []
    });
    const cid = putChallenge({ kind: 'register', challenge: options.challenge, name, uid, code });
    json(res, 200, { cid, options });
  },

  'POST /api/register/verify': async (req, res) => {
    const body = await readBody(req);
    const c = takeChallenge(body.cid);
    if (!c || c.kind !== 'register' || !c.uid) {
      auditFail(req, 'auth.register.fail', { ok: false, msg: 'challenge-expired' });
      return json(res, 400, { error: 'challenge expired, try again', code: 'challenge-expired' });
    }
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: body.credential,
        expectedChallenge: c.challenge,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
        requireUserVerification: false
      });
    } catch (e) {
      // e.message can echo attacker-supplied response fields, so only the reason code is kept.
      auditFail(req, 'auth.register.fail', { ok: false, name: c.name, msg: 'verify-error' });
      return json(res, 400, verifyAnswer(e));
    }
    if (!verification.verified) {
      auditFail(req, 'auth.register.fail', { ok: false, name: c.name, msg: 'not-verified' });
      return json(res, 400, { error: 'not verified' });
    }
    const { credential } = verification.registrationInfo;
    if (db.creds.find(x => x.id === credential.id)) {
      audit(req, 'auth.register.fail', { ok: false, name: c.name, msg: 'credential-exists' });
      return json(res, 409, { error: 'credential already registered' });
    }
    // Re-check the invite at the last moment (it may have been used/revoked since options), then burn it.
    let invite = null;
    if (INVITE_ONLY) {
      invite = db.invites.find(i => i.code === c.code && !i.usedBy && !i.revoked);
      if (!invite) {
        audit(req, 'auth.register.fail', { ok: false, name: c.name, msg: 'invite-invalid' });
        return json(res, 403, { error: 'invite code is no longer valid, ask for a new one', code: 'invite' });
      }
    }
    const user = { id: c.uid, name: c.name, created: new Date().toISOString() };
    if (invite) { user.invitedBy = invite.code; invite.usedBy = user.id; invite.usedAt = user.created; }
    claimFirstAdmin(req, user);
    db.users.push(user);
    db.creds.push({
      id: credential.id, userId: user.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter || 0,
      transports: transportsOf(body.credential?.response?.transports),
      // What Settings → Passkeys shows (#95); a passkey from before then has neither.
      created: user.created, lastUsed: user.created
    });
    saveDb();
    audit(req, 'auth.register.ok', { user, msg: invite ? invite.code : null });
    json(res, 200, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(user) });
  },

  'POST /api/login/options': async (req, res) => {
    const options = await generateAuthenticationOptions({
      rpID: RP_ID, userVerification: 'preferred', allowCredentials: []
    });
    const cid = putChallenge({ kind: 'login', challenge: options.challenge });
    json(res, 200, { cid, options });
  },

  'POST /api/login/verify': async (req, res) => {
    const body = await readBody(req);
    const c = takeChallenge(body.cid);
    if (c?.kind !== 'login') {
      auditFail(req, 'auth.login.fail', { ok: false, msg: 'challenge-expired' });
      return json(res, 400, { error: 'challenge expired, try again', code: 'challenge-expired' });
    }
    const cred = db.creds.find(x => x.id === body.credential?.id);
    if (!cred) {
      // No credential id goes in the log: it is a stable handle for one passkey, and recording it
      // would let an admin correlate an unknown device across attempts. Nothing here identifies
      // the caller beyond the timestamp (and the network, if AUDIT_IP is on).
      auditFail(req, 'auth.login.fail', { ok: false, msg: 'unknown-credential' });
      return json(res, 404, { error: 'unknown passkey, create a profile first', code: 'unknown-credential' });
    }
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: body.credential,
        expectedChallenge: c.challenge,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
        requireUserVerification: false,
        credential: {
          id: cred.id,
          publicKey: b64uToBuf(cred.publicKey),
          counter: cred.counter,
          transports: cred.transports
        }
      });
    } catch (e) {
      auditFail(req, 'auth.login.fail', { ok: false, user: db.users.find(u => u.id === cred.userId), uid: cred.userId, msg: 'verify-error' });
      return json(res, 400, verifyAnswer(e));
    }
    if (!verification.verified) {
      auditFail(req, 'auth.login.fail', { ok: false, user: db.users.find(u => u.id === cred.userId), uid: cred.userId, msg: 'not-verified' });
      return json(res, 400, { error: 'not verified' });
    }
    cred.counter = verification.authenticationInfo.newCounter;
    cred.lastUsed = new Date().toISOString();
    saveDb();
    const user = db.users.find(u => u.id === cred.userId);
    if (!user) {
      audit(req, 'auth.login.fail', { ok: false, uid: cred.userId, msg: 'user-missing' });
      return json(res, 500, { error: 'user missing' });
    }
    if (user.disabled) {
      audit(req, 'auth.login.fail', { ok: false, user, msg: 'account-disabled' });
      return json(res, 403, { error: 'this account has been disabled', code: 'disabled' });
    }
    audit(req, 'auth.login.ok', { user });
    json(res, 200, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(user) });
  },

  // Reads the session purely so the sign-out can be recorded; the cookie is cleared either way.
  // A logout with no valid cookie is a no-op and isn't worth an entry.
  'POST /api/logout': async (req, res) => {
    const user = readSession(req);
    if (user) audit(req, 'auth.logout', { user });
    json(res, 200, { ok: true }, { 'Set-Cookie': clearCookie });
  },

  // "Sign out everywhere" — bumps this user's session version, which invalidates every cookie
  // ever issued for the account, on every device, including a copy someone else walked off with.
  // The caller's own cookie is cleared here too, so the browser doing it doesn't sit on a token
  // it no longer accepts. Passkeys are untouched: signing back in works immediately.
  'POST /api/logout/all': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    user.sv = sessionVersion(user) + 1;
    // An unredeemed pairing code is a session-in-waiting for this account; it goes too, and so
    // does an unused device link.
    for (const [k, v] of pairings) if (v.uid === user.id) pairings.delete(k);
    dropDeviceLinks(db, user.id);
    saveDb();
    audit(req, 'auth.logout.all', { user });
    json(res, 200, { ok: true }, { 'Set-Cookie': clearCookie });
  },

  // The account's own delete (App Store rule 5.1.1(v): an app you can sign up in lets you leave
  // it too). Everything goes, exactly as when an admin deletes it (removeAccount). Two things
  // stand in front of it: the account's name, typed back by its owner, so a stray request does
  // nothing; and the same proof the other changes to a way in ask (proveOwner), since a session
  // on its own may be a cookie someone walked off with. The proof is asked only once the delete
  // could go ahead, so a refusal the request already decides spends no passkey prompt and no
  // password check. One exception: the paired phone (a Bearer token) cannot hold a passkey for
  // this server, its origin being the app's own, so for a profile with no password that counts
  // the pairing itself is the proof ('device'). The app asks the phone's own lock (Face ID, a
  // fingerprint, the passcode) before it sends. With a password, the phone sends it like
  // everyone else. A browser's cookie never gets this. The last admin is refused while anyone
  // else is left, since nobody could then run the instance from the app; alone on it, they may
  // go. The session ends with the account: its cookie is cleared here, and any other session
  // stops verifying since the user is gone.
  'POST /api/account/delete': async (req, res) => {
    const s = sessionOf(req);
    if (!s) return json(res, 401, { error: 'not signed in' });
    const { user } = s;
    const body = await readBody(req);
    if (sessionOf(req)?.user !== user) return json(res, 401, { error: 'not signed in' });
    if (typeof body.name !== 'string' || body.name.trim() !== user.name) {
      return json(res, 400, { error: 'type the account name to confirm', code: 'confirm-name' });
    }
    const lastAdmin = () => lastAdminLeaving(user);
    const refuseLastAdmin = () => json(res, 409, { error: 'the last admin cannot leave while other profiles remain', code: 'last-admin' });
    if (lastAdmin()) return refuseLastAdmin();
    // The pairing is the proof only for a token the pairing made: a browser's cookie value
    // replayed in an Authorization header is a Bearer too, and is told apart by its kind (`c`,
    // makeSession). Without this a cookie someone walked off with deleted a passkey-only profile
    // with no proof at all, the one case this route exists to refuse.
    const paired = s.bearer && s.kind !== 'c';
    const proof = paired && !passwordWayIn(user) ? 'device' : await proveOwner(req, res, user, body, 'account-delete');
    if (!proof) return;
    // Everything above awaited: the session may have ended, and another admin may have left.
    if (readSession(req) !== user) return json(res, 401, { error: 'not signed in' });
    if (lastAdmin()) return refuseLastAdmin();
    const cleanup = removeAccount(user);
    audit(req, 'auth.account.delete', { user, msg: proof });
    json(res, 200, cleanup.status === 'complete' ? { ok: true }
      : { ok: true, status: 'cleanup_pending', cleanupJobId: cleanup.id }, { 'Set-Cookie': clearCookie });
  },

  // Mobile app pairing: called from an already signed-in browser tab (Settings → "Pair the
  // mobile app") to mint a short code the phone can redeem below. The code turns into a phone's
  // token, which /api/me renews for as long as it is used and which gets the device pass on the
  // account's own delete, so it asks the proof a device link asks (proveOwner): a session alone
  // may be a cookie someone walked off with, and minting a phone token is how that cookie would
  // stop having to expire.
  'POST /api/pair/create': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    const proof = await proveOwner(req, res, user, body, 'pair');
    if (!proof) return;
    // Awaited: a sign-out everywhere, a disable or an admin reset may have ended this session.
    if (readSession(req) !== user) return json(res, 401, { error: 'not signed in' });
    if (proof === 'passkey') saveDb();   // the confirming passkey's counter and last use
    // One live code per profile: the newest is the one on screen. Keeping every code minted
    // let one session grow this Map without limit for five minutes at a time.
    for (const [k, v] of pairings) if (v.uid === user.id) pairings.delete(k);
    const code = makePairCode();
    pairings.set(code, { uid: user.id, exp: Date.now() + 5 * 60000 });
    audit(req, 'auth.pair.create', { user, msg: proof });
    json(res, 200, { code });
  },

  // Called from the mobile app itself with the code shown in the browser. No session required —
  // the code IS the credential, one-shot and 5-minute-lived like a WebAuthn challenge.
  'POST /api/pair/redeem': async (req, res) => {
    const body = await readBody(req);
    const code = text(body.code).trim().toUpperCase();
    const p = pairings.get(code);
    if (p) pairings.delete(code);
    if (!p || p.exp < Date.now()) {
      auditFail(req, 'auth.pair.fail', { ok: false, msg: 'code-invalid' });
      return json(res, 400, { error: 'invalid or expired code', code: 'pair-invalid' });
    }
    const user = db.users.find(u => u.id === p.uid);
    if (!user || user.disabled) {
      audit(req, 'auth.pair.fail', { ok: false, uid: p.uid, msg: 'user-unavailable' });
      return json(res, 400, { error: 'invalid or expired code', code: 'pair-invalid' });
    }
    audit(req, 'auth.pair.ok', { user });
    json(res, 200, { token: makeSession(user), user: publicUser(user) });
  },

  // The watch relay (watch-relay.js, docs/ZEPP_OS.md). A signed-in device asks for a code, the
  // Zepp app's settings page for openGym redeems it for a watch token, and from then on the page
  // and the watch's Side Service meet in this profile's mailbox. A watch token opens the two
  // /api/watch/box routes and nothing else, so a session is all that minting one asks; "sign out
  // everywhere" and a new password end every watch link with the sessions (their version).
  'POST /api/watch/pair': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const { code, exp } = createWatchCode(watchCodes, user.id);
    audit(req, 'auth.watch.pair', { user });
    json(res, 200, { code, exp });
  },
  'POST /api/watch/redeem': async (req, res) => {
    const body = await readBody(req);
    if (addressPaused(req, res, 'watch')) return;
    const uid = takeWatchCode(watchCodes, text(body.code));
    const user = uid && db.users.find(u => u.id === uid);
    if (!user || user.disabled) {
      strikeAddress(req, 'watch');
      auditFail(req, 'auth.watch.fail', { ok: false, msg: 'code-invalid' });
      return json(res, 400, { error: 'invalid or expired code', code: 'pair-invalid' });
    }
    const { token, link } = createWatchLink(db, user.id, sessionVersion(user), text(body.name));
    saveDb();
    audit(req, 'auth.watch.ok', { user, msg: link.name });
    json(res, 200, { token, id: link.id, name: user.name || '' });
  },
  'GET /api/watch/links': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    json(res, 200, { links: listWatchLinks(db, user.id) });
  },
  'POST /api/watch/unlink': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    const id = text(body.id) || null;
    if (dropWatchLinks(db, user.id, id)) saveDb();
    // The last watch gone: nothing is left to read the mailbox.
    if (!listWatchLinks(db, user.id).length) { try { fs.unlinkSync(watchFile(user.id)); } catch { /* none */ } }
    audit(req, 'auth.watch.unlink', { user });
    json(res, 200, { ok: true, links: listWatchLinks(db, user.id) });
  },
  // The page's side: its snapshot for the watches, and what they sent.
  'PUT /api/watch/snapshot': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    if (!listWatchLinks(db, user.id).length) return json(res, 409, { error: 'no watch paired', code: 'no-watch' });
    const box = readBox(user.id);
    if (!putSnapshot(box, body.json)) return json(res, 400, { error: 'not a snapshot' });
    writeBox(user.id, box);
    json(res, 200, { ok: true });
  },
  'GET /api/watch/events': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const links = listWatchLinks(db, user.id);
    const seen = links.reduce((m, l) => Math.max(m, l.seen || 0), 0);
    json(res, 200, { events: links.length ? queuedEvents(readBox(user.id)) : [], paired: links.length, seen });
  },
  'POST /api/watch/ack': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    const box = readBox(user.id);
    if (ackEvents(box, body.ids)) writeBox(user.id, box);
    json(res, 200, { ok: true });
  },
  // The watch's side (its Side Service, with the watch token): the snapshot, and its events.
  'GET /api/watch/box': async (req, res) => {
    const link = watchLinkFor(req);
    if (!link) return json(res, 401, { error: 'not paired', code: 'watch-unpaired' });
    const box = readBox(link.userId);
    json(res, 200, { json: box.snapshot, at: box.snapAt });
  },
  'POST /api/watch/box': async (req, res) => {
    const link = watchLinkFor(req);
    if (!link) return json(res, 401, { error: 'not paired', code: 'watch-unpaired' });
    const body = await readBody(req);
    const box = readBox(link.userId);
    const accepted = pushEvents(box, body.events);
    if (accepted.length) writeBox(link.userId, box);
    json(res, 200, { accepted, json: box.snapshot, at: box.snapAt });
  },

  // Absent entirely while PASSWORD_LOGIN is off, so each of them is a plain 404.
  ...(PASSWORD_LOGIN ? passwordRoutes : {}),

  // Always there: more passkeys and device links need nothing an instance has to switch on.
  ...passkeyRoutes,

  // `rev` is the server's own count of writes to this profile (also stored inside the document as
  // `_rev`, so every other reader of the file — reminder tick, admin, Coach, MCP — is unaffected).
  // A client pushes it back as `baseRev`, and a write over a document it never saw is refused.
  // `_unstamped` is the server's note of what it stamped for an older app's last push
  // (sync-stamps.js ownRecord), `_prior` what each field held before (notePrior): read back only
  // by the next PUT, never sent to a client.
  'GET /api/data': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const state = readStateStrict(user.id);
    if (state === UNREADABLE) { console.error('state file unreadable for', user.id); return json(res, 503, { error: 'state unreadable' }); }
    notePull(user);
    json(res, 200, { state: forClient(state), rev: state?._rev || 0 });
  },
  // Just the revision: the client asks this every half minute while it is open and on every
  // return to the foreground, and fetches the document only when the number moved — a signed-in
  // device is meant to show what the server has, and this is what keeps that cheap.
  // Cheap means the stat cache the reminder tick already uses: parsing a megabytes-long document
  // to read one number off it cost 31 ms per poll on a 2.4 MB state, all of it on the event loop.
  // Every write goes through atomicWrite's rename, so the cache can never hand out a stale rev.
  'GET /api/data/rev': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const doc = readStateCached(user.id);
    json(res, 200, { rev: doc?._rev || 0, ...(doc?._wid ? { wid: doc._wid } : {}) });
  },

  // The phone app's background check before a missed-day nudge or a workout-day reminder it
  // scheduled on itself (frontend lib/nudge-check.js, the native NudgeCheck plugin): whether the
  // day was trained or excused somewhere else since the phone last synced. A few bytes instead of
  // the whole document, which can be megabytes, because iOS gives a background refresh some
  // seconds and the phone pays for every byte of it: `done` (a workout dated that day, or a day
  // note), `nudge` (whether the server's copy of the nudge rule, api/nudge.js, would still nudge
  // that day; a plan changed on another device moves it too) and the revision. Nothing of the
  // workouts themselves.
  'GET /api/nudge-check': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const date = new URL(req.url, 'http://x').searchParams.get('date') || '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date + 'T00:00:00Z'))) {
      return json(res, 400, { error: 'date must be YYYY-MM-DD', code: 'date-invalid' });
    }
    const doc = readStateCached(user.id) || {};
    const workouts = Array.isArray(doc.workouts) ? doc.workouts : [];
    const done = workouts.some(w => w && w.d === date) || excusedOn(doc, date);
    let nudge = false;
    try { nudge = !done && !!nudgeFor(doc, date); } catch { nudge = true; }   // unreadable: keep what the phone planned
    json(res, 200, { date, done, nudge, rev: doc._rev || 0 });
  },

  'PUT /api/data': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    // Conditional writes and server-side mutations share one per-user critical section: adoption
    // cannot replace a sync that landed after its read, and a sync cannot compare against a copy
    // that adoption is still transforming. Admission happens before readBody retains up to 5 MiB:
    // rejected backlog never holds a parsed state or executes this callback.
    stateWriteTestMark('put-before-lock', user.id);
    const result = await withStateWrite(user.id, req, async () => {
      const body = await readBody(req);
      if (!body.state || typeof body.state !== 'object') return { status: 400, body: { error: 'state required' } };
      // An object with nothing of the profile in it empties the document with the counter left
      // intact: what lands on disk is `{"_rev":n+1}`, every routine, workout and weigh-in gone, and
      // the next poll reports a revision the client accepts as its own. `_rev` and `_ts` do not
      // count towards "something of the profile" — both are bookkeeping this route writes or echoes
      // itself, so `{}` and `{"_rev":5}` are the same push and get the same refusal.
      if (!Array.isArray(body.state) && !Object.keys(body.state).some(k => k !== '_rev' && k !== '_ts')) {
        return { status: 400, body: { error: 'state required' } };
      }
      const list = value => value == null || Array.isArray(value);
      if (Array.isArray(body.state) || !list(body.state.workouts) || !list(body.state.routines)) {
        return { status: 400, body: { error: 'invalid state' } };
      }
      for (const key of ['workouts', 'routines']) if (Array.isArray(body.state[key])) body.state[key] = records(body.state[key]);
      const cur = readStateStrict(user.id);
      if (STATE_WRITE_TEST_DIR) await stateWriteTestWait('put-after-read', user.id);
      if (cur === UNREADABLE) {
        console.error('state file unreadable for', user.id);
        return { status: 503, body: { error: 'state unreadable' } };
      }
      const curRev = cur?._rev || 0;
      // Revision-less writes remain compatible only for the first document. Once anything has
      // persisted — including a server-side prescription adoption — accepting a writer that does
      // not name what it read would silently erase newer work. Return the current copy so updated
      // callers can merge exactly as they do for a stale revision.
      if (body.baseRev == null && cur !== null) {
        return { status: 428, body: { error: 'revision required', code: 'revision-required', rev: curRev, state: forClient(cur) } };
      }
      // `_rev` is a counter, so after the data directory went back in time (a restored backup, a
      // write lost to a power cut) the same number names a different document. Every write also gets
      // a write id (`_wid`) and keeps its ancestors' (`_wids`): a client quoting the id it last saw
      // (`baseWid`) is refused when the stored document is not that one, whatever the numbers say,
      // and a client reading a document can tell whether it descends from its own (useStore pullState).
      if ((body.baseRev != null && body.baseRev !== curRev) ||
          (body.baseRev != null && typeof body.baseWid === 'string' && cur?._wid && body.baseWid !== cur._wid)) {
        return { status: 409, body: { error: 'conflict', rev: curRev, state: forClient(cur) } };
      }
      delete body.state.active;              // in-progress workouts stay device-local
      // "Reset everything" stamps the profile (`resetAt`, with `resetIds`: what it wiped). The stamp
      // only moves forward: a write without it, or with an older one — a client from before it, a
      // backup restored over the profile — keeps the stored stamp. Otherwise every device that saw
      // the reset would take that copy for one older than the reset, and wipe it again on its next
      // merge (frontend/src/lib/sync-merge.js).
      const storedReset = Number(cur?.resetAt) || 0;
      if (storedReset > (Number(body.state.resetAt) || 0)) {
        body.state.resetAt = cur.resetAt;
        if (cur.resetIds && typeof cur.resetIds === 'object') body.state.resetIds = cur.resetIds;
        else delete body.state.resetIds;
      }
      // The records of removals and edits only grow, and what a writer that does not stamp its own
      // changes (an older app, an API script) changed is stamped here, so it is neither wiped nor
      // undone by the next device that merges (sync-stamps.js).
      // A document nested too deep to compare is the bad request the stringify below refuses too.
      const report = {};
      try { stampPut(cur, body.state, { overRead: body.baseRev != null && body.baseRev === curRev, stamped: body.stamped === true, report }); }
      catch (e) { if (e instanceof RangeError) return { status: 400, body: { error: 'invalid state' } }; throw e; }
      body.state._rev = curRev + 1;          // server-owned; whatever the client sent is ignored
      // A writer that does not stamp (an older app) takes the revision it is told for the document it
      // sent, and only reads the profile again once the revision moves. When the server put back
      // something it left out or set back (sync-stamps.js), the document stored is not that one: it
      // goes in one revision further, so the writer's next check of the revision (every half minute)
      // finds it moved and reads it, and its next push over the one it was told is a conflict to merge.
      if (report.changed) body.state._rev = curRev + 2;
      body.state._wids = [...(Array.isArray(cur?._wids) ? cur._wids : []), ...(cur?._wid ? [cur._wid] : [])]
        .filter(x => typeof x === 'string').slice(-WID_KEEP);
      body.state._wid = crypto.randomBytes(8).toString('hex');
      // JSON.parse takes any nesting, JSON.stringify recurses and runs out of stack on a document
      // nested some thousands deep. No client builds one; it is a bad request, not a server error.
      let text;
      try { text = JSON.stringify(body.state); }
      catch (e) { if (e instanceof RangeError) return { status: 400, body: { error: 'invalid state' } }; throw e; }
      commitState(user.id, cur, body.state, text);
      return { status: 200, body: { ok: true, ts: body.state._ts || null, rev: curRev + 1, wid: body.state._wid } };
    });
    json(res, result.status, result.body);
  },

  'GET /api/push/public-key': async (req, res) => json(res, 200, { key: vapid.publicKey }),

  'POST /api/push/subscribe': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    const sub = body.subscription;
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) return json(res, 400, { error: 'invalid subscription' });
    const bad = pushEndpointError(sub.endpoint) || pushKeyError(sub.keys.p256dh) || pushKeyError(sub.keys.auth);
    if (bad) return json(res, 400, { error: bad });
    // Only the two keys the push protocol needs are kept: `sub` is caller-supplied and would
    // otherwise put arbitrary fields into db.json, which every admin route reads back out.
    const keys = { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) };
    const deviceId = deviceIdOf(body.deviceId);
    // An upsert: the client re-sends its subscription on every boot (lib/push.js) so a row this
    // instance lost — pruned after a dead send, a rebuilt db.json — comes back without anyone
    // touching Settings. The same endpoint sent again keeps its original `created`.
    //
    // A row filed under another account moves only for a caller that sends its keys. The endpoint
    // alone is a URL, and whoever learned it could otherwise re-file it as theirs: the owner's
    // device stops getting their alerts, and the caller's are sent to it instead, encrypted to
    // keys of the caller's choosing. The keys are what the browser holds (the auth secret never
    // leaves it and this server), and the legitimate move carries them: a shared browser signed
    // into a second account re-registers the same subscription on boot, and the row should
    // follow the person now using it. Refusing that, or keeping both rows, would leave the first
    // account's reminders arriving on a device somebody else is using.
    const keyDigest = k => crypto.createHash('sha256').update(`${k?.p256dh}\n${k?.auth}`).digest();
    const sameKeys = k => crypto.timingSafeEqual(keyDigest(k), keyDigest(keys));
    if (db.subs.some(s => s.endpoint === sub.endpoint && s.userId !== user.id && !sameKeys(s.keys))) {
      return json(res, 409, { error: 'this subscription belongs to another account' });
    }
    const prev = db.subs.find(s => s.endpoint === sub.endpoint);
    // No usable id in the request (none, or not a short token) leaves the id the row already
    // has: the request is a re-send, not a request to forget which device the row is.
    const storedDevice = deviceId || prev?.deviceId;
    db.subs = db.subs.filter(s => s.endpoint !== sub.endpoint);
    // A browser holds one subscription per device, so this cap is far above real use. Without
    // it a single account could pile up endpoints without limit — every one of them a target
    // sendPush() would then contact, and a whole rewrite of db.json per addition.
    const mine = db.subs.filter(s => s.userId === user.id);
    if (mine.length >= MAX_SUBS_PER_USER) {
      const drop = new Set(mine.slice(0, mine.length - MAX_SUBS_PER_USER + 1).map(s => s.endpoint));
      db.subs = db.subs.filter(s => !drop.has(s.endpoint));
    }
    db.subs.push({ userId: user.id, endpoint: sub.endpoint, keys, ...(storedDevice ? { deviceId: storedDevice } : {}), created: prev?.created || new Date().toISOString() });
    saveDb();
    json(res, 200, { ok: true });
  },

  // Whether this instance still holds the caller's subscription for `endpoint`. The browser's
  // side (PushManager.getSubscription) says nothing about ours — a row pruned after a dead send
  // leaves the browser subscribed to nowhere — so Settings asks here before it shows "on".
  // A stored row also says which device it is filed under, `null` for none: a row from before
  // device ids, or one the worker re-sent without its id, sends that device's rest-timer alert
  // to every device of the account (sendPush), and the client re-sends its subscription with its
  // id when this is not its own.
  'GET /api/push/status': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const endpoint = new URL(req.url, 'http://x').searchParams.get('endpoint') || '';
    const row = db.subs.find(s => s.userId === user.id && s.endpoint === endpoint);
    json(res, 200, row ? { subscribed: true, deviceId: row.deviceId || null } : { subscribed: false });
  },

  'POST /api/push/unsubscribe': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    db.subs = db.subs.filter(s => !(s.userId === user.id && s.endpoint === body.endpoint));
    saveDb();
    json(res, 200, { ok: true });
  },

  'POST /api/push/test': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    if (pushThrottled(res, PUSH_TESTS, user)) return;
    await sendPush(user.id, testPush(readStateCached(user.id)?.lang));
    json(res, 200, { ok: true });
  },

  'POST /api/push/rest-timer': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    if (pushThrottled(res, REST_TIMER_SETS, user)) return;
    const body = await readBody(req);
    // Validated before it is clamped: the clamp used to run first, which turned a missing or
    // unusable value into a 1-second push and made the 400 below unreachable. `Number()` only
    // on a number or a string — on an object it can throw.
    const raw = body.seconds;
    const n = typeof raw === 'number' || typeof raw === 'string' ? Number(raw) : NaN;
    if (!(n >= 1)) return json(res, 400, { error: 'seconds required' });
    const sec = Math.min(3600, Math.round(n));
    scheduleRestTimer(user.id, deviceIdOf(body.deviceId), sec, readStateCached(user.id)?.lang);
    json(res, 200, { ok: true });
  },

  'POST /api/push/rest-timer/cancel': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    cancelRestTimer(user.id, deviceIdOf(body.deviceId));
    json(res, 200, { ok: true });
  },

  // Live-workout heartbeat: client pings while a workout is on screen; { active:false } drops it,
  // except with reason `hidden`, which marks it away (see PRESENCE_HIDDEN_GRACE). `navigated`,
  // `closed`, and no reason at all (older clients), drop it at once.
  'POST /api/activity': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    if (body.active) {
      // a fresh row, which also clears any hidden mark
      presence.set(user.id, {
        name: text(body.name).slice(0, 60),
        exIdx: +body.exIdx || 0, exTotal: +body.exTotal || 0,
        setsDone: +body.setsDone || 0, setsTotal: +body.setsTotal || 0,
        startedAt: +body.startedAt || Date.now(),
        updatedAt: Date.now()
      });
    } else if (body.reason === 'hidden') {
      // The first mark stands: a repeat without a heartbeat between cannot stretch the grace.
      const p = presence.get(user.id);
      if (p && p.hiddenAt === undefined) p.hiddenAt = Date.now();
    } else presence.delete(user.id);
    json(res, 200, { ok: true });
  },

  /* ---------- admin dashboard ---------- */
  // One row per user, cheap enough for a personal instance (reads each state file once).
  'GET /api/admin/users': async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const users = db.users.map(u => {
      const S = readState(u.id) || {};
      const workouts = records(S.workouts);
      const last = workouts[workouts.length - 1];
      return {
        id: u.id, name: u.name, created: u.created || null,
        disabled: !!u.disabled, admin: isAdmin(u), owner: isOwner(u), invitedBy: u.invitedBy || null,
        workouts: workouts.length,
        lastWorkout: last ? last.d : null,
        lastSync: lastSyncOf(u, S),
        hasPush: db.subs.some(s => s.userId === u.id),
        live: livePresence(u.id),
        // The sign-in e-mail is an admin's to see (to hand out a reset code, to tell two
        // profiles apart), and only while the instance takes passwords at all.
        ...(PASSWORD_LOGIN ? { password: hasPassword(u), email: u.email || null } : {})
      };
    });
    json(res, 200, { users, invite_only: INVITE_ONLY, ...(PASSWORD_LOGIN ? { password_login: true } : {}), now: Date.now() });
  },

  // Drill-down: full workout history + body-weight log for one user.
  'GET /api/admin/user': async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const id = new URL(req.url, 'http://x').searchParams.get('id');
    const u = db.users.find(x => x.id === id);
    if (!u) return json(res, 404, { error: 'no such user' });
    const S = readState(u.id) || {};
    json(res, 200, {
      user: {
        id: u.id, name: u.name, created: u.created || null, disabled: !!u.disabled, admin: isAdmin(u), owner: isOwner(u), invitedBy: u.invitedBy || null,
        // Only on an instance with password sign-in: whether they have one, and until when an
        // unused reset code is good.
        ...(PASSWORD_LOGIN ? { password: hasPassword(u), email: u.email || null, resetUntil: u.pwReset?.exp > Date.now() ? u.pwReset.exp : null } : {}),
        // Until when an unused recovery code is good (#584), on every instance.
        recoveryUntil: recoveryLinkOf(db, u.id)?.exp || null
      },
      unit: S.unit || 'kg',
      lastSync: lastSyncOf(u, S),
      routines: records(S.routines).map(r => ({ id: r.id, name: r.name, emoji: r.emoji, count: records(r.ex).length })),
      bodyweight: records(S.bodyweight),
      // records() already copied, so this reverse is ours: newest first for display. A workout's
      // photos and videos are the owner's own: the admin view gets no refs to them.
      workouts: records(S.workouts).reverse().map(({ media, ...w }) => w)
    });
  },

  // A recovery code (#584): for someone who lost every way in, on any instance, password sign-in
  // or not. The person enters it on the sign-in screen, and the device they use gets a new passkey
  // for the profile (POST /api/device-link/*, the same redemption a device link has). Who may make
  // one for whom: any admin for a profile that is not an admin; the owner for an admin; nobody here
  // for the owner, who uses the server's own command (recover.js), since no one else may take over
  // the owner's login. Not for oneself, and not for a disabled profile. See issueRecovery.
  'POST /api/admin/user/recovery': async (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    const body = await readBody(req);
    const u = db.users.find(x => x.id === body.id);
    if (!u) return json(res, 404, { error: 'no such user' });
    if (u.id === admin.id) return json(res, 400, { error: 'you are signed in: add a passkey in Settings instead', code: 'self' });
    if (isOwner(u)) return json(res, 403, { error: 'the owner recovers with the server command (recover.js)', code: 'owner' });
    if (isAdmin(u) && !isOwner(admin)) { audit(req, 'admin.denied', { ok: false, user: admin, target: u, msg: 'recovery' }); return json(res, 403, { error: 'only the owner can make a recovery code for an admin' }); }
    if (u.disabled) return json(res, 400, { error: 'enable the account first', code: 'disabled' });
    const { code, link } = issueRecovery(req, u, admin);
    json(res, 200, { ok: true, name: u.name, code, expires: link.exp });
  },

  'POST /api/admin/user/disable': async (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    const body = await readBody(req);
    const u = db.users.find(x => x.id === body.id);
    if (!u) return json(res, 404, { error: 'no such user' });
    if (isAdmin(u)) return json(res, 400, { error: 'cannot disable an admin' });
    const candidate = structuredClone(db);
    const candidateUser = candidate.users.find(x => x.id === u.id);
    candidateUser.disabled = !!body.disabled;
    if (candidateUser.disabled) presence.delete(candidateUser.id);   // drop them off "training now" at once
    // A device link made before the lock would otherwise still be waiting when it is lifted.
    if (candidateUser.disabled) dropDeviceLinks(candidate, candidateUser.id);
    const nowMs = Date.now();
    for (const appointment of candidate.coachAppointments.filter(item => item.coachId === candidateUser.id || item.athleteId === candidateUser.id)) {
      reconcileAppointmentReminders(candidate, appointment, nowMs, { userId: candidateUser.id });
    }
    try { await commitSchedulingDb(candidate, persistedDb, [...schedulingCollections, 'users', 'deviceLinks']); }
    catch { return json(res, 503, { error: 'account status could not be saved', code: 'storage_unavailable' }); }
    const published = db.users.find(x => x.id === candidateUser.id);
    audit(req, published.disabled ? 'admin.user.disable' : 'admin.user.enable', { user: admin, target: published });
    json(res, 200, { ok: true, id: published.id, disabled: published.disabled });
  },

  // Disable locks an account out; this removes it. The one destructive action in the app, so the
  // client asks twice and this end refuses the two cases that cannot be undone from the UI
  // afterwards: an admin deleting themselves, and the last admin standing (issue #107).
  // The invite code that let them in stays burned — it was used, and freeing it would quietly
  // widen an invite-only instance. `GET /api/admin/user` is the export: the dashboard offers it
  // before the confirm, so the training history can be kept if anyone wants it.
  'POST /api/admin/user/delete': async (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    const body = await readBody(req);
    const u = db.users.find(x => x.id === body.id);
    if (!u) return json(res, 404, { error: 'no such user' });
    if (u.id === admin.id) return json(res, 400, { error: 'you cannot delete your own account' });
    if (isAdmin(u) && db.users.filter(isAdmin).length <= 1) return json(res, 400, { error: 'cannot delete the last admin' });
    if (isOwner(u)) return json(res, 400, { error: 'the owner cannot be deleted; hand the role to another admin first' });
    if (isAdmin(u) && !isOwner(admin)) { audit(req, 'admin.denied', { ok: false, user: admin, target: u }); return json(res, 403, { error: 'only the owner can delete an admin' }); }
    const name = u.name;
    const cleanup = removeAccount(u);
    // Logged with the name, because the id is about to mean nothing to anyone reading this back.
    audit(req, 'admin.user.delete', { user: admin, msg: name });
    json(res, 200, cleanup.status === 'complete' ? { ok: true, id: u.id }
      : { ok: true, id: u.id, status: 'cleanup_pending', cleanupJobId: cleanup.id });
  },

  'GET /api/admin/account-cleanup': async (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    if (cleanupReadThrottle(req, res, admin)) return;
    const query = new URL(req.url, 'http://x').searchParams;
    const status = query.get('status');
    if (status && !cleanupStatuses.has(status)) return json(res, 400, { error: 'invalid status', code: 'invalid_status' });
    const rawLimit = query.get('limit');
    const limit = rawLimit === null ? 25 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return json(res, 400, { error: 'invalid limit', code: 'invalid_limit' });
    const cursor = readCleanupCursor(query.get('cursor'), status || '');
    if (cursor === false) return json(res, 400, { error: 'invalid cursor', code: 'invalid_cursor' });
    const rows = (db.accountCleanupJobs || []).filter(job => !status || job.status === status)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id));
    let start = 0;
    if (cursor) {
      start = rows.findIndex(job => job.id === cursor.id && job.updatedAt === cursor.updatedAt) + 1;
      if (!start) return json(res, 400, { error: 'invalid cursor', code: 'invalid_cursor' });
    }
    const selected = rows.slice(start, start + limit);
    const hasMore = start + selected.length < rows.length;
    const last = selected.at(-1);
    json(res, 200, {
      items: selected.map(serializeCleanupJob),
      limit,
      hasMore,
      nextCursor: hasMore ? cleanupCursor({ status: status || '', id: last.id, updatedAt: last.updatedAt }) : null,
    });
  },

  'GET /api/admin/account-cleanup/{cleanupJobId}': async (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    if (cleanupReadThrottle(req, res, admin)) return;
    const job = cleanupIdPattern.test(req.cleanupJobId)
      ? (db.accountCleanupJobs || []).find(item => item.id === req.cleanupJobId)
      : null;
    if (!job) return json(res, 404, { error: 'not found' });
    json(res, 200, serializeCleanupJob(job));
  },

  // Appoint or remove an admin. Owner only, never on themselves, and not for an admin named in
  // ADMIN_UIDS: that one comes back on the next restart whatever db.json says, so the switch
  // would lie. A disabled account is enabled first, so nobody is promoted while locked out.
  'POST /api/admin/user/role': async (req, res) => {
    const owner = requireOwner(req, res); if (!owner) return;
    const body = await readBody(req);
    const u = db.users.find(x => x.id === body.id);
    if (!u) return json(res, 404, { error: 'no such user' });
    if (u.id === owner.id) return json(res, 400, { error: 'the owner stays an admin' });
    if (typeof body.admin !== 'boolean') return json(res, 400, { error: 'admin must be true or false' });
    if (ADMIN_UIDS.includes(u.id)) return json(res, 400, { error: 'this admin is set in ADMIN_UIDS on the server' });
    if (body.admin && u.disabled) return json(res, 400, { error: 'enable the account first' });
    if (body.admin) u.admin = true; else { delete u.admin; delete u.owner; }
    saveDb();
    audit(req, body.admin ? 'admin.role.grant' : 'admin.role.revoke', { user: owner, target: u });
    json(res, 200, { ok: true, id: u.id, admin: isAdmin(u) });
  },

  // Hand the owner role to another admin. The old owner stays an admin.
  'POST /api/admin/owner': async (req, res) => {
    const owner = requireOwner(req, res); if (!owner) return;
    const body = await readBody(req);
    const u = db.users.find(x => x.id === body.id);
    if (!u) return json(res, 404, { error: 'no such user' });
    if (u.id === owner.id) return json(res, 400, { error: 'you already are the owner' });
    if (!isAdmin(u) || u.disabled) return json(res, 400, { error: 'make them an admin first' });
    for (const x of db.users) delete x.owner;
    u.owner = true;
    saveDb();
    audit(req, 'admin.owner.transfer', { user: owner, target: u });
    json(res, 200, { ok: true, id: u.id });
  },

  'GET /api/admin/invites': async (req, res) => {
    if (!requireAdmin(req, res)) return;
    // resolve usedBy uid → name for display
    const invites = db.invites.map(i => ({
      ...i, usedByName: i.usedBy ? (db.users.find(u => u.id === i.usedBy) || {}).name || null : null
    }));
    json(res, 200, { invites, invite_only: INVITE_ONLY });
  },

  'POST /api/admin/invites/new': async (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    const body = await readBody(req);
    let code;
    // 16 hex chars = 64 bits, up from 8 chars / 32 bits. Passkey signup has no rate limiting by
    // design (that's the reverse proxy's job) and /api/register/options tells a caller whether a
    // code is good, so the code itself has to be the thing that isn't worth guessing. Codes already
    // in db.json keep working — validation is an exact string compare, never a length or format check.
    do { code = crypto.randomBytes(8).toString('hex').toUpperCase(); } while (db.invites.some(i => i.code === code));
    const invite = { code, note: text(body.note).slice(0, 60), createdBy: admin.id, created: new Date().toISOString() };
    db.invites.push(invite);
    saveDb();
    audit(req, 'admin.invite.create', { user: admin, msg: code });
    json(res, 200, { invite });
  },

  'POST /api/admin/invites/revoke': async (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    const body = await readBody(req);
    const inv = db.invites.find(i => i.code === text(body.code).toUpperCase());
    if (!inv) return json(res, 404, { error: 'no such code' });
    if (inv.usedBy) return json(res, 400, { error: 'already used, cannot revoke' });
    db.invites = db.invites.filter(i => i.code !== inv.code);
    saveDb();
    audit(req, 'admin.invite.revoke', { user: admin, msg: inv.code });
    json(res, 200, { ok: true });
  },

  /* ---------- activity log ---------- */
  // Newest first, paged by id. Not by offset: the log grows at the front of this view, so an
  // offset cursor would repeat a row whenever an event lands between two pages; and not by
  // timestamp, because two events can share a millisecond. auditKeep() runs on read as well as
  // on the hourly compaction, so nothing past its retention is ever served.
  'GET /api/admin/audit': async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const q = new URL(req.url, 'http://x').searchParams;
    const limit = Math.max(1, Math.min(200, +q.get('limit') || 100));
    const before = +q.get('before') || Infinity;
    const cat = q.get('cat') || '';
    let rows = auditKeep(auditLines()).reverse();
    if (cat === 'fail') rows = rows.filter(r => !r.ok);
    else if (cat) rows = rows.filter(r => String(r.ev).startsWith(cat + '.'));
    const page = rows.filter(r => r.id < before).slice(0, limit);
    json(res, 200, {
      events: page,
      total: rows.length,
      nextBefore: page.length === limit ? page[page.length - 1].id : null,
      enabled: AUDIT_ON, ip_mode: AUDIT_IP,
      retention: { max: AUDIT_MAX, days: AUDIT_DAYS },
      now: Date.now()
    });
  },

  // Deleting the log is itself logged, and auditSeq is not reset — so a clear always leaves a
  // visible gap in the ids and can't be used to quietly erase a trace. There is no export route:
  // ./data/audit.log already is the export, in a format jq reads directly.
  // Owner only: an admin who could clear it could erase the trace of what they did.
  'POST /api/admin/audit/clear': async (req, res) => {
    const admin = requireOwner(req, res); if (!admin) return;
    try { fs.unlinkSync(auditFile); } catch { /* nothing logged yet */ }
    auditCount = 0;
    audit(req, 'admin.audit.clear', { user: admin });
    json(res, 200, { ok: true });
  },

  /* ---------- AI Coach ---------- */
  // Routes live in coach/routes.js and are handed the helpers above rather than importing
  // them: they are closures over db and SECRET, and passing them in keeps that module free of
  // a cycle. Every one of them is inert while the feature is unconfigured.
  ...coachRoutes({ json, readBody, readSession, requireAdmin }),

  /* ---------- integrations ---------- */
  // integrations/routes.js, handed the same helpers. With INTEGRATIONS unset they answer an empty
  // list (GET) or 404 "off", so the routes exist on every server and the app can tell.
  ...integrationRoutes({ json, readBody, readSession, hub: integrations, audit }),

  /* ---------- photos & videos ---------- */
  // Absent, not refusing, when MEDIA_UPLOADS=0: a 404 is what a server from before the feature
  // answers, and the client already treats that as "this server does not store them".
  ...(MEDIA_ON ? mediaRoutes : {})
};

/* ---------- Coach: boot recovery, notifications, scheduled reviews ---------- */
// A job that was running when the process died is not coming back; say so rather than leaving
// a spinner that never resolves.
coachJobs.recoverOnBoot();
// A ready proposal is the one Coach event worth a notification. Failures and "nothing to
// change" stay silent on purpose (FR-38/E4).
coachJobs.setProposalHook((uid, pending) => {
  const n = (pending?.changes || []).length;
  if (!n) return;
  sendPush(uid, {
    title: 'Your Coach has been reading',
    body: n === 1 ? '1 suggestion after this week' : `${n} suggestions after this week`,
    tag: 'coach-proposal', url: '#/coach'
  });
});
integrations.start();
startCadence({ users: () => db.users.filter(u => !u.disabled), userNow, skip: uid => !stateSummary(uid)?.consent });
startWarmup();

// node's requestTimeout is one number for every route, and it is half an hour (below) for the
// sake of one: a video uploaded over a slow uplink. Every other request keeps node's old five
// minutes to finish sending its body — readBody has no timer of its own, and a trickled body on
// any route, the unauthenticated CSRF-exempt POSTs included, would otherwise hold its socket six
// times as long. The upload route lifts it (req.allowSlowBody) only once the session and the
// hourly budget have let the upload in; from there media.js's own idle timer takes over. The
// tests shorten it, as they do REMINDER_TICK_MS.
const BODY_TIMEOUT_MS = Math.max(50, +(process.env.BODY_TIMEOUT_MS || 300000) || 300000);
function bodyDeadline(req) {
  if (req.complete) return;
  // The socket itself, not req: a route that answered without reading the body has finished its
  // response, and node has already closed req (a no-op to destroy again) while the body trickles
  // on. Only 'end' clears it — 'close' also fires at that early answer.
  const socket = req.socket;
  const timer = setTimeout(() => { if (!req.complete) socket.destroy(); }, BODY_TIMEOUT_MS);
  timer.unref();
  const clear = () => clearTimeout(timer);
  req.once('end', clear);
  req.allowSlowBody = clear;
}

// The Capacitor WebView origins of the Android and iOS app.
const APP_ORIGINS = new Set(['https://localhost', 'capacitor://localhost', 'http://localhost']);

const server = http.createServer(async (req, res) => {
  bodyDeadline(req);
  // Same-origin (the deployed nginx-proxied web app) never triggers CORS, so this only matters
  // for the paired mobile app calling in from its own WebView origin. It carries no cookie
  // (auth is the Authorization header instead), so Allow-Credentials is deliberately never set —
  // reflecting the origin here can't expose the cookie session to anyone.
  const origin = req.headers.origin;
  if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
  if (req.method === 'OPTIONS') {
    // Chrome's Private Network Access asks before a page reaches a LAN address (a phone pairing
    // with 192.168.x.x); an answer without this header is refused like a CORS failure (#329).
    // Only the app's own WebView origins get it, so an arbitrary website still can't reach a
    // LAN-only instance through the visitor's browser.
    const pna = String(req.headers['access-control-request-private-network'] || '').toLowerCase() === 'true'
      && APP_ORIGINS.has(origin);
    res.writeHead(204, {
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      // The CF-Access-* pair: a phone's Cloudflare Access service token (frontend lib/cf-access.js),
      // for an Access application that passes OPTIONS through to the origin.
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, CF-Access-Client-Id, CF-Access-Client-Secret',
      'Access-Control-Max-Age': '86400',
      ...(pna ? { 'Access-Control-Allow-Private-Network': 'true' } : {})
    });
    return res.end();
  }
  // A target that does not parse (`//`, `//api%2Fhealth`) is a bad request, not a server error —
  // and the try below only covers the route handler, so it is refused here.
  let url;
  try { url = new URL(req.url, 'http://x'); }
  catch { return json(res, 400, { error: 'bad request' }); }
  // The path routed on has to be the path that was sent. The URL parser turns a backslash into a
  // slash and resolves dot segments; nginx does neither, so `/api/media/..\data` matched nginx's
  // media block (its body size and buffering) and reached `/api/data` here. Any rule the proxy
  // keys on the path could be stepped around the same way. No client sends such a path.
  const sent = req.url.split('?')[0];
  if (sent.startsWith('/') && sent !== url.pathname) return json(res, 400, { error: 'bad request' });
  let key = req.method + ' ' + url.pathname;
  // Parameterized routes are mapped onto template keys here so the table above stays a plain
  // lookup, and so csrfOk and the catch-all see one name for every concrete resource.
  const mm = /^\/api\/media\/([0-9a-f]{64})$/.exec(url.pathname);
  if (mm) { key = req.method + ' /api/media/{hash}'; req.mediaHash = mm[1]; }
  const accountCleanup = /^\/api\/admin\/account-cleanup\/(acj_[A-Za-z0-9_-]+)$/.exec(url.pathname);
  if (accountCleanup) {
    key = req.method + ' /api/admin/account-cleanup/{cleanupJobId}';
    req.cleanupJobId = accountCleanup[1];
  }
  const coachRoutine = /^\/api\/coach\/athletes\/([A-Za-z0-9_-]+)\/routines$/.exec(url.pathname);
  if (coachRoutine) {
    key = req.method + ' /api/coach/athletes/{athleteId}/routines';
    req.athleteId = coachRoutine[1];
  }
  const coachRoutineItem = /^\/api\/coach\/athletes\/([A-Za-z0-9_-]+)\/routines\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
  if (coachRoutineItem) {
    key = req.method + ' /api/coach/athletes/{athleteId}/routines/{routineId}';
    req.athleteId = coachRoutineItem[1];
    req.routineId = coachRoutineItem[2];
  }
  const coachProgressGoals = /^\/api\/coach\/athletes\/([A-Za-z0-9_-]+)\/progress-goals$/.exec(url.pathname);
  if (coachProgressGoals) {
    key = req.method + ' /api/coach/athletes/{athleteId}/progress-goals';
    req.athleteId = coachProgressGoals[1];
  }
  const coachProgressGoal = /^\/api\/coach\/athletes\/([A-Za-z0-9_-]+)\/progress-goals\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
  if (coachProgressGoal) {
    key = req.method + ' /api/coach/athletes/{athleteId}/progress-goals/{goalId}';
    req.athleteId = coachProgressGoal[1];
    req.goalId = coachProgressGoal[2];
  }
  const coachProgressSummary = /^\/api\/coach\/athletes\/([A-Za-z0-9_-]+)\/progress-summary$/.exec(url.pathname);
  if (coachProgressSummary) {
    key = req.method + ' /api/coach/athletes/{athleteId}/progress-summary';
    req.athleteId = coachProgressSummary[1];
  }
  const coachProgressReports = /^\/api\/coach\/athletes\/([A-Za-z0-9_-]+)\/progress-reports$/.exec(url.pathname);
  if (coachProgressReports) {
    key = req.method + ' /api/coach/athletes/{athleteId}/progress-reports';
    req.athleteId = coachProgressReports[1];
  }
  const coachProgressReportRevoke = /^\/api\/coach\/athletes\/([A-Za-z0-9_-]+)\/progress-reports\/([A-Za-z0-9_-]+)\/revoke$/.exec(url.pathname);
  if (coachProgressReportRevoke) {
    key = req.method + ' /api/coach/athletes/{athleteId}/progress-reports/{reportId}/revoke';
    req.athleteId = coachProgressReportRevoke[1];
    req.reportId = coachProgressReportRevoke[2];
  }
  const coachProgressReportExport = /^\/api\/coach\/athletes\/([A-Za-z0-9_-]+)\/progress-reports\/([A-Za-z0-9_-]+)\/export$/.exec(url.pathname);
  if (coachProgressReportExport) {
    key = req.method + ' /api/coach/athletes/{athleteId}/progress-reports/{reportId}/export';
    req.athleteId = coachProgressReportExport[1];
    req.reportId = coachProgressReportExport[2];
  }
  const coachProgressReport = /^\/api\/coach\/athletes\/([A-Za-z0-9_-]+)\/progress-reports\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
  if (coachProgressReport) {
    key = req.method + ' /api/coach/athletes/{athleteId}/progress-reports/{reportId}';
    req.athleteId = coachProgressReport[1];
    req.reportId = coachProgressReport[2];
  }
  if (url.pathname === '/api/progress/metrics') key = req.method + ' /api/progress/metrics';
  if (url.pathname === '/api/athlete/progress-reports') key = req.method + ' /api/athlete/progress-reports';
  const athleteProgressReportExport = /^\/api\/athlete\/progress-reports\/([A-Za-z0-9_-]+)\/export$/.exec(url.pathname);
  if (athleteProgressReportExport) {
    key = req.method + ' /api/athlete/progress-reports/{reportId}/export';
    req.reportId = athleteProgressReportExport[1];
  }
  const athleteProgressReport = /^\/api\/athlete\/progress-reports\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
  if (athleteProgressReport) {
    key = req.method + ' /api/athlete/progress-reports/{reportId}';
    req.reportId = athleteProgressReport[1];
  }
  const coachAssessment = /^\/api\/coach\/athletes\/([A-Za-z0-9_-]+)\/assessments$/.exec(url.pathname);
  if (coachAssessment) {
    key = req.method + ' /api/coach/athletes/{athleteId}/assessments';
    req.athleteId = coachAssessment[1];
  }
  const coachAssessmentItem = /^\/api\/coach\/athletes\/([A-Za-z0-9_-]+)\/assessments\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
  if (coachAssessmentItem) {
    key = req.method + ' /api/coach/athletes/{athleteId}/assessments/{assessmentId}';
    req.athleteId = coachAssessmentItem[1];
    req.assessmentId = coachAssessmentItem[2];
  }
  const coachMealPlan = /^\/api\/coach\/athletes\/([A-Za-z0-9_-]+)\/meal-plans$/.exec(url.pathname);
  if (coachMealPlan) {
    key = req.method + ' /api/coach/athletes/{athleteId}/meal-plans';
    req.athleteId = coachMealPlan[1];
  }
  const coachMealPlanItem = /^\/api\/coach\/athletes\/([A-Za-z0-9_-]+)\/meal-plans\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
  if (coachMealPlanItem) {
    key = req.method + ' /api/coach/athletes/{athleteId}/meal-plans/{planId}';
    req.athleteId = coachMealPlanItem[1];
    req.planId = coachMealPlanItem[2];
  }
  const coachMealAdherence = /^\/api\/coach\/athletes\/([A-Za-z0-9_-]+)\/meal-adherence$/.exec(url.pathname);
  if (coachMealAdherence) {
    key = req.method + ' /api/coach/athletes/{athleteId}/meal-adherence';
    req.athleteId = coachMealAdherence[1];
  }
  const coachMessages = /^\/api\/coach\/athletes\/([A-Za-z0-9_-]+)\/messages$/.exec(url.pathname);
  if (coachMessages) {
    key = req.method + ' /api/coach/athletes/{athleteId}/messages';
    req.athleteId = coachMessages[1];
  }
  const athleteMessages = /^\/api\/athlete\/messages\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
  if (athleteMessages) {
    key = req.method + ' /api/athlete/messages/{coachId}';
    req.coachId = athleteMessages[1];
  }
  const messageRead = /^\/api\/messages\/([A-Za-z0-9_-]+)\/read$/.exec(url.pathname);
  if (messageRead) {
    key = req.method + ' /api/messages/{messageId}/read';
    req.messageId = messageRead[1];
  }
  const coachHabits = /^\/api\/coach\/athletes\/([A-Za-z0-9_-]+)\/habits$/.exec(url.pathname);
  if (coachHabits) {
    key = req.method + ' /api/coach/athletes/{athleteId}/habits';
    req.athleteId = coachHabits[1];
  }
  const coachHabitItem = /^\/api\/coach\/athletes\/([A-Za-z0-9_-]+)\/habits\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
  if (coachHabitItem) {
    key = req.method + ' /api/coach/athletes/{athleteId}/habits/{habitId}';
    req.athleteId = coachHabitItem[1];
    req.habitId = coachHabitItem[2];
  }
  const coachHabitSummary = /^\/api\/coach\/athletes\/([A-Za-z0-9_-]+)\/habits-summary$/.exec(url.pathname);
  if (coachHabitSummary) {
    key = req.method + ' /api/coach/athletes/{athleteId}/habits-summary';
    req.athleteId = coachHabitSummary[1];
  }
  const coachCheckins = /^\/api\/coach\/athletes\/([A-Za-z0-9_-]+)\/checkins$/.exec(url.pathname);
  if (coachCheckins) {
    key = req.method + ' /api/coach/athletes/{athleteId}/checkins';
    req.athleteId = coachCheckins[1];
  }
  const athleteAssessment = /^\/api\/athlete\/assessments\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
  if (athleteAssessment) {
    key = req.method + ' /api/athlete/assessments/{assessmentId}';
    req.assessmentId = athleteAssessment[1];
  }
  const assessmentPhoto = /^\/api\/assessments\/([A-Za-z0-9_-]+)\/photos\/([0-9a-f]{64})$/.exec(url.pathname);
  if (assessmentPhoto) {
    key = req.method + ' /api/assessments/{assessmentId}/photos/{hash}';
    req.assessmentId = assessmentPhoto[1];
    req.mediaHash = assessmentPhoto[2];
  }
  const assessmentConsent = /^\/api\/athlete\/coaches\/([A-Za-z0-9_-]+)\/assessment-consent$/.exec(url.pathname);
  if (assessmentConsent) {
    key = req.method + ' /api/athlete/coaches/{linkId}/assessment-consent';
    req.linkId = assessmentConsent[1];
  }
  const athletePrescription = /^\/api\/athlete\/prescriptions\/([A-Za-z0-9_-]+)\/adopt$/.exec(url.pathname);
  if (athletePrescription) {
    key = req.method + ' /api/athlete/prescriptions/{routineId}/adopt';
    req.routineId = athletePrescription[1];
  }
  if (url.pathname === '/api/coach/availability') key = req.method + ' /api/coach/availability';
  if (url.pathname === '/api/coach/appointments') key = req.method + ' /api/coach/appointments';
  const coachAppointments = /^\/api\/coach\/athletes\/([A-Za-z0-9_-]+)\/appointments$/.exec(url.pathname);
  if (coachAppointments) {
    key = req.method + ' /api/coach/athletes/{athleteId}/appointments';
    req.athleteId = coachAppointments[1];
  }
  const coachAvailabilitySlots = /^\/api\/coach\/athletes\/([A-Za-z0-9_-]+)\/availability-slots$/.exec(url.pathname);
  if (coachAvailabilitySlots) {
    key = req.method + ' /api/coach/athletes/{athleteId}/availability-slots';
    req.athleteId = coachAvailabilitySlots[1];
  }
  const coachAppointmentAttendance = /^\/api\/coach\/appointments\/([A-Za-z0-9_-]+)\/attendance$/.exec(url.pathname);
  if (coachAppointmentAttendance) {
    key = req.method + ' /api/coach/appointments/{appointmentId}/attendance';
    req.appointmentId = coachAppointmentAttendance[1];
  }
  const coachAppointmentReschedule = /^\/api\/coach\/appointments\/([A-Za-z0-9_-]+)\/reschedule$/.exec(url.pathname);
  if (coachAppointmentReschedule) {
    key = req.method + ' /api/coach/appointments/{appointmentId}/reschedule';
    req.appointmentId = coachAppointmentReschedule[1];
  }
  const coachAppointmentCancel = /^\/api\/coach\/appointments\/([A-Za-z0-9_-]+)\/cancel$/.exec(url.pathname);
  if (coachAppointmentCancel) {
    key = req.method + ' /api/coach/appointments/{appointmentId}/cancel';
    req.appointmentId = coachAppointmentCancel[1];
  }
  const coachAppointmentItem = /^\/api\/coach\/appointments\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
  if (coachAppointmentItem) {
    key = req.method + ' /api/coach/appointments/{appointmentId}';
    req.appointmentId = coachAppointmentItem[1];
  }
  const athleteAvailabilitySlots = /^\/api\/athlete\/coaches\/([A-Za-z0-9_-]+)\/availability-slots$/.exec(url.pathname);
  if (athleteAvailabilitySlots) {
    key = req.method + ' /api/athlete/coaches/{coachId}/availability-slots';
    req.coachId = athleteAvailabilitySlots[1];
  }
  if (url.pathname === '/api/athlete/appointments') key = req.method + ' /api/athlete/appointments';
  const athleteCoachAppointments = /^\/api\/athlete\/coaches\/([A-Za-z0-9_-]+)\/appointments$/.exec(url.pathname);
  if (athleteCoachAppointments) {
    key = req.method + ' /api/athlete/coaches/{coachId}/appointments';
    req.coachId = athleteCoachAppointments[1];
  }
  const athleteAppointmentCancel = /^\/api\/athlete\/appointments\/([A-Za-z0-9_-]+)\/cancel$/.exec(url.pathname);
  if (athleteAppointmentCancel) {
    key = req.method + ' /api/athlete/appointments/{appointmentId}/cancel';
    req.appointmentId = athleteAppointmentCancel[1];
  }
  const athleteAppointmentReschedule = /^\/api\/athlete\/appointments\/([A-Za-z0-9_-]+)\/reschedule$/.exec(url.pathname);
  if (athleteAppointmentReschedule) {
    key = req.method + ' /api/athlete/appointments/{appointmentId}/reschedule';
    req.appointmentId = athleteAppointmentReschedule[1];
  }
  const athleteAppointmentItem = /^\/api\/athlete\/appointments\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
  if (athleteAppointmentItem) {
    key = req.method + ' /api/athlete/appointments/{appointmentId}';
    req.appointmentId = athleteAppointmentItem[1];
  }
  if (url.pathname === '/api/scheduling/reminder-preferences') {
    key = req.method + ' /api/scheduling/reminder-preferences';
  }

  const handler = routes[key];
  if (!handler) return json(res, 404, { error: 'not found' });
  if (!csrfOk(req, key)) {
    // A Bearer that does not verify and no cookie beside it: nothing ambient is in play, the caller
    // is simply not signed in. That is the paired app once its token is revoked or expired, and it
    // needs the 401 to know it (lib/api.js callers and the boot path act on the status), not a 403
    // and a log line that blames ORIGIN. Still refused before any handler runs.
    if ((req.headers.authorization || '').startsWith('Bearer ') && !cookieToken(req) && !bearerAuthenticates(req)) {
      return json(res, 401, { error: 'not signed in' });
    }
    // Logged, not audited: this is reachable without a session, and an audit entry per attempt
    // would let anyone fill the log. An operator who has genuinely mis-set ORIGIN needs to see
    // the mismatch, and the container log is where they will look.
    // The answer carries ORIGIN too (the app shows it, see passkeyError in lib/api.js): it is no
    // secret, and a hostile page cannot read a response CORS never allowed it.
    console.warn(originHint(key, req.headers.origin, ORIGIN, req.headers['sec-fetch-site']));
    return json(res, 403, { error: 'cross-origin request refused', code: 'origin-mismatch', expected: ORIGIN });
  }
  // After the origin check, so a forged request spends nobody's budget. The password routes only
  // (see the sign-in throttle above).
  if (key in THROTTLED) {
    const addr = limitAddress(req);
    const kind = THROTTLED[key];
    const wait = AUTH_BURST.take(addr) || (kind ? ADDR_FAILS.retryAfter(kind + '|' + addr) : 0);
    if (wait) return tooMany(res, wait);
  }
  try { await handler(req, res); }
  catch (e) {
    if (e?.clientGone) { console.warn(key, 'client went away mid-body:', e.message); return; }
    if (e instanceof HttpError) {
      if (!res.headersSent) json(res, e.status, { error: e.message });
      return;
    }
    if (e instanceof StateWriteQueueFullError) {
      // The body was deliberately not read: drain it without retaining chunks so this connection
      // can receive the bounded-backlog response and be reused.
      req.on('error', () => {});
      req.resume();
      const status = e.scope === 'key' ? 429 : 503;
      if (!res.headersSent) json(res, status, {
        error: e.scope === 'key' ? 'too many state writes for this profile' : 'the server is busy, try again in a moment',
        code: e.scope === 'key' ? 'state-write-busy' : 'busy',
      }, { 'Retry-After': '1' });
      return;
    }
    // A refused upload or a missing file: the caller's to act on, never a logged 500.
    if (e instanceof MediaError) {
      if (!res.headersSent) json(res, e.status, { error: e.message, code: e.code, ...e.extra }, e.headers);
      return;
    }
    // Every scrypt slot and the short queue behind them are taken (password.js).
    if (e instanceof BusyError) {
      if (!res.headersSent) json(res, 503, { error: 'the server is busy, try again in a moment', code: 'busy' }, { 'Retry-After': '2' });
      return;
    }
    console.error(key, e);
    if (!res.headersSent) json(res, 500, { error: 'server error' });
  }
});
// Node's default of 300 s for a whole request would answer 408 to a 40 MB video on a ~1 Mbit/s
// uplink. Half an hour covers that; a stalled upload is cut much sooner by its own 60 s idle
// timer in media.js, a client that never finishes its headers still meets headersTimeout, and
// every other route's body still has to arrive within five minutes (bodyDeadline above).
server.requestTimeout = 30 * 60000;
server.headersTimeout = 60000;
// The port is read back off the listener rather than echoed from PORT, so the line states the
// port that was actually bound: with PORT=0 the OS picks one, and a caller that did not choose it
// (the tests spawn the server that way, and so does anyone running two instances on one box) has
// no other way to learn it.
server.listen(PORT, () => {
  console.log(`gym-api on :${server.address().port} (rpID=${RP_ID}, origin=${ORIGIN})`);
  appointmentReminderDispatcher.start();
  appointmentReminderDispatcher.startTick();
});

let shuttingDown = false;
async function shutdownServer() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  try { await appointmentReminderDispatcher.stop(); }
  finally { process.exit(0); }
}
process.once('SIGTERM', shutdownServer);
process.once('SIGINT', shutdownServer);

// The server's own command for a locked-out owner or admin (#584, recover.js): asked over a local
// socket only this process's user can open (admin-socket.js explains why not by editing db.json).
// One command: a recovery code for a profile named, or picked by id when several share the name.
const CLI_REQ = { headers: {}, socket: {} };
startAdminSocket({
  handle: async msg => {
    if (!msg || msg.cmd !== 'recover') return { error: 'unknown command' };
    const id = typeof msg.id === 'string' ? msg.id : null;
    const k = nameKey(typeof msg.name === 'string' ? msg.name : '');
    const found = id ? db.users.filter(u => u.id === id) : k ? db.users.filter(u => nameKey(u.name) === k || u.email === k) : [];
    const row = u => ({ id: u.id, name: u.name, created: u.created || null, admin: isAdmin(u), owner: isOwner(u) });
    if (!found.length) return { error: id ? 'no profile with that id' : 'no profile with that name' };
    if (found.length > 1) return { error: 'several profiles have that name: pick one with --id', matches: found.map(row) };
    const u = found[0];
    if (u.disabled) return { error: 'that profile is disabled: enable it in the admin dashboard first' };
    const { code, link } = issueRecovery(CLI_REQ, u, null);
    return { ...row(u), code, expires: link.exp };
  }
});
