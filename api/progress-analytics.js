import crypto from 'node:crypto';
import { createWindow } from './rate-limit.js';
import { StateWriteQueue } from './state-write-queue.js';
import { dateInTimeZone, habitSummary, validIsoDate, validTimeZone } from './communication-habits.js';
import {
  bodyComposition, faulkner4, pollock3Men, pollock3Women, pollock7Men, pollock7Women, siri,
} from './anthropometrics.js';

const DAY_MS = 86400000;
const ID_RE = /^[A-Za-z0-9_-]{1,120}$/;
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;
const GOAL_METRICS = Object.freeze([
  'body_weight',
  'body_fat_percent',
  'workouts_per_week',
  'nutrition_adherence_percent',
  'habit_adherence_percent',
]);
const GOAL_DIRECTIONS = new Set(['increase', 'decrease', 'maintain']);
const GOAL_STATUSES = new Set(['active', 'achieved', 'archived']);
const METRIC_SCOPES = Object.freeze({
  body_weight: 'assessments',
  body_fat_percent: 'assessments',
  workouts_per_week: 'training',
  nutrition_adherence_percent: 'nutrition',
  habit_adherence_percent: 'training',
});
const METRIC_UNITS = Object.freeze({
  body_weight: 'kg',
  body_fat_percent: 'percent',
  workouts_per_week: 'workouts_per_week',
  nutrition_adherence_percent: 'percent',
  habit_adherence_percent: 'percent',
});
const METRIC_CATALOG = Object.freeze({
  body_weight: { unit: 'kg', pointKind: 'instant', pointSemantics: { source: 'measurement_source' }, directions: ['increase', 'decrease', 'maintain'], scope: 'assessments', labelKey: 'progress.metric.body_weight', labelPtBr: 'Peso corporal' },
  body_fat_percent: { unit: 'percent', pointKind: 'instant', pointSemantics: { source: 'assessment_method' }, directions: ['increase', 'decrease', 'maintain'], scope: 'assessments', labelKey: 'progress.metric.body_fat_percent', labelPtBr: 'Percentual de gordura' },
  workouts_per_week: { unit: 'workouts_per_week', pointKind: 'interval', pointSemantics: { numerator: 'completed_workouts', denominator: 'calendar_days' }, directions: ['increase', 'decrease', 'maintain'], scope: 'training', labelKey: 'progress.metric.workouts_per_week', labelPtBr: 'Treinos por semana', volume: { unit: 'source_weight_repetitions', labelPtBr: 'Soma de carga da fonte multiplicada por repetições' } },
  nutrition_adherence_percent: { unit: 'percent', pointKind: 'instant', pointSemantics: { numerator: 'completed_meals', denominator: 'recorded_meal_opportunities' }, directions: ['increase', 'decrease', 'maintain'], scope: 'nutrition', labelKey: 'progress.metric.nutrition_adherence_percent', labelPtBr: 'Adesão nutricional' },
  habit_adherence_percent: { unit: 'percent', pointKind: 'instant', pointSemantics: { numerator: 'completed_checkins', denominator: 'recorded_checkins' }, directions: ['increase', 'decrease', 'maintain'], scope: 'training', labelKey: 'progress.metric.habit_adherence_percent', labelPtBr: 'Adesão a hábitos' },
});
const UNAVAILABLE_REASONS = Object.freeze([
  'outside_relationship_period',
  'no_measurements',
  'training_state_unavailable',
  'no_adherence_records',
  'no_meal_plan',
  'no_habits',
  'no_scheduled_habit_days',
]);
const GOAL_PROGRESS_REASONS = Object.freeze([
  ...UNAVAILABLE_REASONS,
  'insufficient_data',
  'zero_coverage',
  'stale_data',
  'insufficient_longitudinal_coverage',
]);
const TREND_REASONS = Object.freeze(['insufficient_observations']);
const GOAL_KEYS = [
  'id', 'linkId', 'coachId', 'athleteId', 'metric', 'direction', 'baselineValue', 'targetValue',
  'tolerance', 'unit', 'startDate', 'targetDate', 'timezone', 'status', '_rev', 'createdAt', 'updatedAt',
  'achievedAt', 'archivedAt', 'archiveReason',
];
const REPORT_KEYS = [
  'id', 'linkId', 'coachId', 'athleteId', 'interval', 'timezone', 'metrics', 'summary', 'snapshot',
  'createdAt', 'revokedAt', 'revocation',
];

export const PROGRESS_LIMITS = Object.freeze({
  maxGoalsPerLink: 50,
  maxGoals: 10000,
  maxTerminalGoals: 50000,
  goalRetentionDays: 730,
  maxReportsPerLink: 100,
  maxReports: 20000,
  maxTerminalReports: 50000,
  reportRetentionDays: 1095,
  maxReportBytes: 1024 * 1024,
});

const record = value => !!value && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => record(value)
  && Object.keys(value).length === keys.length
  && Object.keys(value).every(key => keys.includes(key));
const finite = value => typeof value === 'number' && Number.isFinite(value);
const finiteMetric = value => finite(value) && value >= -1000000 && value <= 1000000;
const round = (value, digits = 2) => Number(Number(value).toFixed(digits));
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const isoTimestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
  && new Date(Date.parse(value)).toISOString() === value;
const validId = value => typeof value === 'string' && ID_RE.test(value);
function civilUtcMs(date) {
  const [year, month, day] = date.split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}
function shiftDate(date, days) {
  const shifted = new Date(civilUtcMs(date) + days * DAY_MS);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
const inclusiveDays = (from, to) => Math.floor((civilUtcMs(to) - civilUtcMs(from)) / DAY_MS) + 1;
const cleanText = (value, max) => typeof value === 'string' && value.length <= max && !CONTROL_RE.test(value) ? value : null;
const timestampOf = value => finite(value) ? value : Date.parse(value);
const newest = (left, right) => Date.parse(right.updatedAt || right.createdAt) - Date.parse(left.updatedAt || left.createdAt)
  || String(right.id).localeCompare(String(left.id));

export function scopeForProgressMetric(metric) {
  return METRIC_SCOPES[metric] || null;
}

export function calculateAssessmentResults(assessment) {
  let density;
  let bodyFatPercent;
  const skinfolds = assessment?.skinfolds;
  if (skinfolds?.protocol) {
    const { protocol, sex, age, ...measurements } = skinfolds;
    if (protocol === 'pollock3') density = sex === 'male'
      ? pollock3Men(measurements, age)
      : pollock3Women(measurements, age);
    if (protocol === 'pollock7') density = sex === 'male'
      ? pollock7Men(measurements, age)
      : pollock7Women(measurements, age);
    if (protocol === 'faulkner4') bodyFatPercent = faulkner4(measurements);
    else if (density !== undefined) bodyFatPercent = siri(density);
  } else if (assessment?.bioimpedance?.bodyFatPercent !== undefined) {
    bodyFatPercent = assessment.bioimpedance.bodyFatPercent;
  }
  if (bodyFatPercent === undefined) return undefined;
  if (!finite(bodyFatPercent) || bodyFatPercent < 0 || bodyFatPercent > 100
      || (density !== undefined && (!finite(density) || density <= 0))) return null;
  let composition = {};
  try { if (assessment.weightKg !== undefined) composition = bodyComposition(assessment.weightKg, bodyFatPercent); }
  catch { return null; }
  return { ...(density === undefined ? {} : { density }), bodyFatPercent, ...composition };
}

function validGoalDirection(goal) {
  if (goal.direction === 'increase') return goal.targetValue > goal.baselineValue;
  if (goal.direction === 'decrease') return goal.targetValue < goal.baselineValue;
  return goal.targetValue === goal.baselineValue;
}

export function validateProgressGoal(goal, links = null) {
  if (!exactKeys(goal, GOAL_KEYS) || !validId(goal.id) || !validId(goal.linkId)
      || !validId(goal.coachId) || !validId(goal.athleteId) || !GOAL_METRICS.includes(goal.metric)
      || !GOAL_DIRECTIONS.has(goal.direction) || !finiteMetric(goal.baselineValue)
      || !finiteMetric(goal.targetValue) || !(goal.tolerance === null || finite(goal.tolerance) && goal.tolerance >= 0 && goal.tolerance <= 1000000)
      || goal.unit !== METRIC_UNITS[goal.metric] || !Number.isSafeInteger(goal._rev) || goal._rev < 1
      || !validIsoDate(goal.startDate) || !validIsoDate(goal.targetDate) || goal.targetDate < goal.startDate
      || inclusiveDays(goal.startDate, goal.targetDate) > 3660 || !validTimeZone(goal.timezone)
      || !GOAL_STATUSES.has(goal.status) || !isoTimestamp(goal.createdAt) || !isoTimestamp(goal.updatedAt)
      || Date.parse(goal.updatedAt) < Date.parse(goal.createdAt)
      || !(goal.achievedAt === null || isoTimestamp(goal.achievedAt))
      || !(goal.archivedAt === null || isoTimestamp(goal.archivedAt))
      || !(goal.archiveReason === null || ['manual', 'scope_revoked'].includes(goal.archiveReason))
      || goal.status === 'active' && (goal.achievedAt !== null || goal.archivedAt !== null)
      || goal.status === 'achieved' && (goal.achievedAt === null || goal.archivedAt !== null)
      || goal.status === 'archived' && goal.archivedAt === null
      || !validGoalDirection(goal)) return false;
  const link = links?.get(goal.linkId);
  return !links || !!link && link.coachId === goal.coachId && link.athleteId === goal.athleteId
    ;
}

function safeSnapshot(value, depth = 0) {
  if (depth > 12) return false;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return typeof value !== 'string' || value.length <= 20000;
  if (finite(value)) return true;
  if (Array.isArray(value)) return value.length <= 10000 && value.every(item => safeSnapshot(item, depth + 1));
  if (!record(value)) return false;
  return Object.keys(value).length <= 200 && Object.entries(value).every(([key, item]) => {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(key) || ['messages', 'message', 'content', 'privateMessages'].includes(key)) return false;
    return safeSnapshot(item, depth + 1);
  });
}

export function validateProgressReport(report, links = null, limits = PROGRESS_LIMITS) {
  if (!exactKeys(report, REPORT_KEYS) || !validId(report.id) || !validId(report.linkId)
      || !validId(report.coachId) || !validId(report.athleteId)
      || !record(report.interval) || !exactKeys(report.interval, ['from', 'to'])
      || !validIsoDate(report.interval.from) || !validIsoDate(report.interval.to)
      || report.interval.from > report.interval.to || inclusiveDays(report.interval.from, report.interval.to) > 366
      || !validTimeZone(report.timezone) || !Array.isArray(report.metrics) || !report.metrics.length
      || report.metrics.length > GOAL_METRICS.length || new Set(report.metrics).size !== report.metrics.length
      || report.metrics.some(metric => !GOAL_METRICS.includes(metric)) || cleanText(report.summary, 2000) === null
      || !record(report.snapshot) || report.snapshot.version !== 1 || !safeSnapshot(report.snapshot)
      || Buffer.byteLength(JSON.stringify(report.snapshot)) > limits.maxReportBytes
      || !isoTimestamp(report.createdAt) || !(report.revokedAt === null || isoTimestamp(report.revokedAt))
      || !(report.revocation === null || exactKeys(report.revocation, ['reason', 'scope', 'actorId', 'at'])
        && report.revocation.reason === 'scope_revoked' && validId(report.revocation.actorId)
        && ['training', 'nutrition', 'assessments'].includes(report.revocation.scope)
        && isoTimestamp(report.revocation.at) && report.revocation.at === report.revokedAt)) return false;
  const link = links?.get(report.linkId);
  return !links || !!link && link.coachId === report.coachId && link.athleteId === report.athleteId
    ;
}

export function validateProgressState(db, limits = PROGRESS_LIMITS) {
  if (!Array.isArray(db.progressGoals) || !Array.isArray(db.progressReports)) throw new Error('progress collections must be arrays');
  const links = new Map((db.coachAthleteLinks || []).map(link => [link.id, link]));
  const goalIds = new Set();
  for (const goal of db.progressGoals) {
    if (!validateProgressGoal(goal, links) || goalIds.has(goal.id)) throw new Error('progressGoals contains a duplicate id or invalid record');
    goalIds.add(goal.id);
  }
  const reportIds = new Set();
  for (const report of db.progressReports) {
    if (!validateProgressReport(report, links, limits) || reportIds.has(report.id)) throw new Error('progressReports contains a duplicate id or invalid record');
    reportIds.add(report.id);
  }
  return true;
}

export function migrateProgressState(db) {
  let changed = false;
  for (const key of ['progressGoals', 'progressReports']) {
    if (db[key] === undefined) { db[key] = []; changed = true; }
    else if (!Array.isArray(db[key])) throw new Error(`${key} must be an array`);
  }
  for (const goal of db.progressGoals) {
    if (goal.unit === undefined) { goal.unit = METRIC_UNITS[goal.metric]; changed = true; }
    if (goal._rev === undefined) { goal._rev = 1; changed = true; }
    if (goal.archiveReason === undefined) { goal.archiveReason = goal.status === 'archived' ? 'manual' : null; changed = true; }
  }
  for (const report of db.progressReports) {
    if (report.revocation === undefined) { report.revocation = null; changed = true; }
  }
  validateProgressState(db);
  return changed;
}

export function reconcileProgressScopes(candidate, { linkId, removedScopes, actorId, at }) {
  const removed = new Set(removedScopes);
  for (const goal of candidate.progressGoals || []) {
    if (goal.linkId !== linkId || goal.status === 'archived' || !removed.has(scopeForProgressMetric(goal.metric))) continue;
    goal.status = 'archived';
    goal.updatedAt = at;
    goal.archivedAt = at;
    goal.achievedAt = null;
    goal.archiveReason = 'scope_revoked';
    goal._rev += 1;
  }
  for (const report of candidate.progressReports || []) {
    const scope = report.metrics.map(scopeForProgressMetric).find(item => removed.has(item));
    if (report.linkId !== linkId || report.revokedAt || !scope) continue;
    report.revokedAt = at;
    report.revocation = { reason: 'scope_revoked', scope, actorId, at };
  }
  validateProgressState(candidate);
}

export function compactProgressState(db, configuredLimits = PROGRESS_LIMITS, now = Date.now()) {
  const limits = { ...PROGRESS_LIMITS, ...configuredLimits };
  const before = [db.progressGoals.length, db.progressReports.length];
  const goalCutoff = now - limits.goalRetentionDays * DAY_MS;
  const reportCutoff = now - limits.reportRetentionDays * DAY_MS;
  db.progressGoals = db.progressGoals.filter(goal => goal.status !== 'archived' || Date.parse(goal.archivedAt) >= goalCutoff);
  db.progressReports = db.progressReports.filter(report => Date.parse(report.createdAt) >= reportCutoff);
  const activeGoals = db.progressGoals.filter(goal => goal.status !== 'archived');
  const terminalGoals = db.progressGoals.length - activeGoals.length;
  const activeReports = db.progressReports.filter(report => !report.revokedAt);
  const terminalReports = db.progressReports.length - activeReports.length;
  if (activeGoals.length > limits.maxGoals) throw new Error(`active progressGoals exceed configured limit ${limits.maxGoals}`);
  if (terminalGoals > limits.maxTerminalGoals) throw new Error(`terminal progressGoals exceed configured limit ${limits.maxTerminalGoals}`);
  if (activeReports.length > limits.maxReports) throw new Error(`active progressReports exceed configured limit ${limits.maxReports}`);
  if (terminalReports > limits.maxTerminalReports) throw new Error(`terminal progressReports exceed configured limit ${limits.maxTerminalReports}`);
  const goalCounts = new Map();
  for (const goal of activeGoals) {
    const count = (goalCounts.get(goal.linkId) || 0) + 1;
    if (count > limits.maxGoalsPerLink) throw new Error(`progressGoals link exceeds configured limit ${limits.maxGoalsPerLink}`);
    goalCounts.set(goal.linkId, count);
  }
  const reportCounts = new Map();
  for (const report of activeReports) {
    const count = (reportCounts.get(report.linkId) || 0) + 1;
    if (count > limits.maxReportsPerLink) throw new Error(`progressReports link exceeds configured limit ${limits.maxReportsPerLink}`);
    reportCounts.set(report.linkId, count);
  }
  validateProgressState(db, limits);
  return { changed: before[0] !== db.progressGoals.length || before[1] !== db.progressReports.length };
}

export function removeProgressUser(db, userId) {
  db.progressGoals = (db.progressGoals || []).filter(goal => goal.coachId !== userId && goal.athleteId !== userId);
  db.progressReports = (db.progressReports || []).filter(report => report.coachId !== userId && report.athleteId !== userId);
}

export function progressDependentLinkIds(db) {
  return [
    ...(db.progressGoals || []).map(goal => goal.linkId),
    ...(db.progressReports || []).map(report => report.linkId),
  ];
}

function parseMetrics(raw, scopes, { required = false } = {}) {
  const values = raw === null || raw === undefined || raw === '' ? [] : String(raw).split(',').map(item => item.trim()).filter(Boolean);
  if (!values.length) {
    if (required) return null;
    return GOAL_METRICS.filter(metric => scopes.includes(scopeForProgressMetric(metric)));
  }
  if (new Set(values).size !== values.length || values.some(metric => !GOAL_METRICS.includes(metric))) return null;
  return values;
}

export function parseProgressPeriod(searchParams, timeZone, now = Date.now()) {
  if (!validTimeZone(timeZone)) return null;
  const today = dateInTimeZone(now, timeZone);
  const from = searchParams.get('from');
  const to = searchParams.get('to');
  const requestedPeriod = searchParams.get('period');
  if (requestedPeriod !== null && (from !== null || to !== null)) return null;
  if (from !== null || to !== null) {
    if (!validIsoDate(from) || !validIsoDate(to) || from > to || inclusiveDays(from, to) > 366) return null;
    return { from, to, days: inclusiveDays(from, to), preset: null };
  }
  const raw = requestedPeriod || '30';
  const days = Number(raw);
  if (![7, 30, 90].includes(days)) return null;
  return { from: shiftDate(today, -(days - 1)), to: today, days, preset: days };
}

function linkTime(link) {
  return Date.parse(link.updatedAt || link.createdAt || '') || 0;
}

export function resolveProgressLink(db, actor, { athleteId = null, linkId = null, write = false } = {}) {
  if (!actor) return { ok: false, code: 'not_signed_in' };
  let links;
  if (athleteId !== null) links = db.coachAthleteLinks.filter(link => link.status !== 'pending'
    && link.coachId === actor.id && link.athleteId === athleteId);
  else links = db.coachAthleteLinks.filter(link => link.status !== 'pending' && link.athleteId === actor.id);
  links.sort((left, right) => linkTime(right) - linkTime(left) || String(right.id).localeCompare(String(left.id)));
  if (linkId !== null) {
    if (!validId(linkId)) return { ok: false, code: 'relationship_not_found' };
    const link = links.find(item => item.id === linkId);
    if (!link) return { ok: false, code: 'relationship_not_found' };
    if (write && link.status !== 'active') return { ok: false, code: 'relationship_inactive', link };
    return { ok: true, link, readOnly: link.status !== 'active' };
  }
  const active = links.filter(link => link.status === 'active');
  if (athleteId === null && active.length > 1) return { ok: false, code: 'link_id_required' };
  const link = active[0] || links[0];
  if (!link) return { ok: false, code: 'relationship_not_found' };
  if (write && link.status !== 'active') return { ok: false, code: 'relationship_inactive', link };
  return { ok: true, link, readOnly: link.status !== 'active' };
}

function relationshipPeriod(link, timeZone) {
  const startAt = Date.parse(link.acceptedAt || link.createdAt);
  const terminal = link.status === 'active' ? null : link.suspendedAt || link.endedAt || link.updatedAt;
  return {
    from: dateInTimeZone(startAt, timeZone),
    to: terminal ? dateInTimeZone(Date.parse(terminal), timeZone) : null,
  };
}

function effectivePeriod(period, link, timeZone) {
  const relationship = relationshipPeriod(link, timeZone);
  const from = relationship.from && relationship.from > period.from ? relationship.from : period.from;
  const to = relationship.to && relationship.to < period.to ? relationship.to : period.to;
  return { ...period, from, to, days: from <= to ? inclusiveDays(from, to) : 0, relationship };
}

function freshness(latestDate, periodTo, staleAfterDays) {
  if (!latestDate) return { status: 'none', latestDate: null, ageDays: null, staleAfterDays };
  const ageDays = Math.max(0, inclusiveDays(latestDate, periodTo) - 1);
  return { status: ageDays <= staleAfterDays ? 'fresh' : 'stale', latestDate, ageDays, staleAfterDays };
}

function trend(points) {
  if (points.length < 2) return { available: false, change: null, direction: null, reason: 'insufficient_observations' };
  const change = round(points.at(-1).value - points[0].value);
  return { available: true, change, direction: change > 0 ? 'increase' : change < 0 ? 'decrease' : 'stable', reason: null };
}

function unavailableMetric(metric, period, reason) {
  return {
    metric, unit: METRIC_UNITS[metric], available: false, currentValue: null, unavailableReason: reason,
    points: [],
    coverage: { observed: 0, expected: null, percent: null, periodDays: period.days },
    freshness: freshness(null, period.to, metric.startsWith('body_') ? 30 : 7),
  };
}

function bodyWeightMetric(state, assessments, period) {
  const points = [];
  if (record(state) && Array.isArray(state.bodyweight)) {
    const unit = state.unit === 'lb' ? 'lb' : 'kg';
    for (const row of state.bodyweight) {
      if (!validIsoDate(row?.d) || !finite(row?.w) || row.d < period.from || row.d > period.to) continue;
      const value = unit === 'lb' ? row.w * 0.45359237 : row.w;
      if (value > 0 && value <= 1000) points.push({ kind: 'instant', date: row.d, value: round(value), source: 'bodyweight_log', unit: 'kg',
        coverage: { observed: 1, expected: 1, percent: 100 }, freshness: freshness(row.d, period.to, 30) });
    }
  }
  for (const assessment of assessments) {
    const date = assessment.localDate;
    if (finite(assessment.weightKg) && date >= period.from && date <= period.to) {
      points.push({ kind: 'instant', date, value: round(assessment.weightKg), source: 'assessment', unit: 'kg',
        coverage: { observed: 1, expected: 1, percent: 100 }, freshness: freshness(date, period.to, 30) });
    }
  }
  points.sort((left, right) => left.date.localeCompare(right.date) || left.source.localeCompare(right.source));
  if (!points.length) return unavailableMetric('body_weight', period, 'no_measurements');
  return {
    metric: 'body_weight', unit: 'kg', available: true, currentValue: points.at(-1).value, unavailableReason: null,
    points, trend: trend(points), coverage: { observed: points.length, expected: null, percent: null, periodDays: period.days },
    freshness: freshness(points.at(-1).date, period.to, 30),
  };
}

function bodyFatMetric(assessments, period) {
  const points = assessments.flatMap(assessment => {
    const results = calculateAssessmentResults(assessment);
    return results?.bodyFatPercent !== undefined && assessment.localDate >= period.from && assessment.localDate <= period.to
      ? [{ kind: 'instant', date: assessment.localDate, value: round(results.bodyFatPercent), source: assessment.skinfolds?.protocol || 'bioimpedance', unit: 'percent',
        coverage: { observed: 1, expected: 1, percent: 100 }, freshness: freshness(assessment.localDate, period.to, 30) }]
      : [];
  }).sort((left, right) => left.date.localeCompare(right.date));
  if (!points.length) return unavailableMetric('body_fat_percent', period, 'no_measurements');
  return {
    metric: 'body_fat_percent', unit: 'percent', available: true, currentValue: points.at(-1).value, unavailableReason: null,
    points, trend: trend(points), coverage: { observed: points.length, expected: null, percent: null, periodDays: period.days },
    freshness: freshness(points.at(-1).date, period.to, 30),
  };
}

function workoutMetric(db, link, state, period, timeZone) {
  const prescribedRoutines = (db.coachPrescriptions || []).filter(item => item.coachId === link.coachId && item.athleteId === link.athleteId
    && item.state !== 'withdrawn' && dateInTimeZone(timestampOf(item.createdAt), timeZone) >= period.relationship.from
    && dateInTimeZone(timestampOf(item.createdAt), timeZone) <= period.to).length;
  if (!record(state) || !Array.isArray(state.workouts)) return {
    ...unavailableMetric('workouts_per_week', period, 'training_state_unavailable'),
    prescriptions: { availableRoutines: prescribedRoutines, historicalWeeklyScheduleAvailable: false },
  };
  const workouts = state.workouts.filter(item => validIsoDate(item?.d) && item.d >= period.from && item.d <= period.to);
  const volumeRows = workouts.filter(item => finite(item.vol) && item.vol >= 0);
  const currentValue = period.days ? round(workouts.length * 7 / period.days) : null;
  const latest = workouts.map(item => item.d).sort().at(-1) || null;
  const buckets = new Map();
  for (const workout of workouts) {
    const offset = inclusiveDays(period.from, workout.d) - 1;
    const from = shiftDate(period.from, Math.floor(offset / 7) * 7);
    const to = shiftDate(from, Math.min(6, inclusiveDays(from, period.to) - 1));
    const key = `${from}:${to}`;
    const bucket = buckets.get(key) || { from, to, numerator: 0, denominator: inclusiveDays(from, to), latest: workout.d };
    bucket.numerator += 1;
    if (workout.d > bucket.latest) bucket.latest = workout.d;
    buckets.set(key, bucket);
  }
  const points = [...buckets.values()].sort((left, right) => left.from.localeCompare(right.from)).map(bucket => ({
    kind: 'interval', from: bucket.from, to: bucket.to, value: round(bucket.numerator * 7 / bucket.denominator),
    numerator: bucket.numerator, denominator: bucket.denominator, unit: 'workouts_per_week',
    coverage: { observed: bucket.denominator, expected: bucket.denominator, percent: 100 }, freshness: freshness(bucket.latest, period.to, 7),
  }));
  return {
    metric: 'workouts_per_week', unit: 'workouts_per_week', available: period.days > 0, currentValue,
    unavailableReason: period.days ? null : 'outside_relationship_period', workoutsCompleted: workouts.length,
    volume: { value: volumeRows.length ? round(volumeRows.reduce((sum, item) => sum + item.vol, 0)) : null, unit: 'source_weight_repetitions', observedWorkouts: volumeRows.length },
    prescriptions: { availableRoutines: prescribedRoutines, historicalWeeklyScheduleAvailable: false },
    denominator: { days: period.days },
    points,
    coverage: { observed: period.days, expected: period.days, percent: period.days ? 100 : null, periodDays: period.days },
    freshness: freshness(latest, period.to, 7),
  };
}

function nutritionMetric(db, link, period, timeZone) {
  const plans = db.mealPlans.filter(plan => plan.coachId === link.coachId && plan.athleteId === link.athleteId
    && dateInTimeZone(timestampOf(plan.createdAt), timeZone) >= period.relationship.from
    && dateInTimeZone(timestampOf(plan.createdAt), timeZone) <= period.to);
  const planIds = new Set(plans.map(plan => plan.id));
  const plansById = new Map(plans.map(plan => [plan.id, plan]));
  const rows = db.mealAdherence.filter(item => item.athleteId === link.athleteId && planIds.has(item.mealPlanId)
    && item.date >= period.from && item.date <= period.to);
  let numerator = 0;
  let denominator = 0;
  const daily = new Map();
  for (const row of rows) {
    const plan = plansById.get(row.mealPlanId);
    const mealIds = new Set((plan?.meals || []).map(meal => meal.id));
    const completed = (row.mealsChecked || []).filter(mealId => mealIds.has(mealId)).length;
    denominator += mealIds.size;
    numerator += completed;
    const point = daily.get(row.date) || { numerator: 0, denominator: 0 };
    point.numerator += completed; point.denominator += mealIds.size; daily.set(row.date, point);
  }
  if (!denominator) return unavailableMetric('nutrition_adherence_percent', period, plans.length ? 'no_adherence_records' : 'no_meal_plan');
  const uniqueDays = new Set(rows.map(row => row.date));
  const latest = [...uniqueDays].sort().at(-1) || null;
  return {
    metric: 'nutrition_adherence_percent', unit: 'percent', available: true,
    currentValue: round(numerator / denominator * 100, 1), unavailableReason: null,
    numerator: { completedMeals: numerator }, denominator: { recordedMealOpportunities: denominator },
    points: [...daily].sort(([left], [right]) => left.localeCompare(right)).map(([date, point]) => ({
      kind: 'instant', date, value: round(point.numerator / point.denominator * 100, 1), ...point, unit: 'percent',
      coverage: { observed: 1, expected: 1, percent: 100 }, freshness: freshness(date, period.to, 7),
    })),
    coverage: { observed: uniqueDays.size, expected: period.days, percent: period.days ? round(uniqueDays.size / period.days * 100, 1) : null, periodDays: period.days },
    freshness: freshness(latest, period.to, 7),
    methodology: 'Only days with an adherence record enter the meal denominator; missing days are coverage gaps, not zero adherence.',
  };
}

function habitMetric(db, link, period, timeZone) {
  const habits = db.coachHabits.filter(item => item.linkId === link.id);
  if (!habits.length) return unavailableMetric('habit_adherence_percent', period, 'no_habits');
  const habitIds = new Set(habits.map(item => item.id));
  const checkins = db.habitCheckins.filter(item => item.linkId === link.id && habitIds.has(item.habitId)
    && item.date >= period.from && item.date <= period.to);
  const summary = habitSummary(habits, checkins, period.to, period.days, timeZone, period.from);
  if (!summary.scheduledDays) return unavailableMetric('habit_adherence_percent', period, 'no_scheduled_habit_days');
  const checkedDays = new Set(checkins.map(item => `${item.habitId}\0${item.date}`)).size;
  const latest = checkins.map(item => item.date).sort().at(-1) || null;
  const daily = new Map();
  for (const checkin of checkins) {
    const point = daily.get(checkin.date) || { numerator: 0, denominator: 0 };
    point.denominator += 1;
    if (checkin.completed !== false) point.numerator += 1;
    daily.set(checkin.date, point);
  }
  return {
    metric: 'habit_adherence_percent', unit: 'percent', available: true, currentValue: summary.adherencePercent,
    unavailableReason: null, numerator: { completedScheduledDays: summary.completedDays },
    denominator: { scheduledHabitDays: summary.scheduledDays },
    points: [...daily].sort(([left], [right]) => left.localeCompare(right)).map(([date, point]) => ({
      kind: 'instant', date, value: round(point.numerator / point.denominator * 100, 1), ...point, unit: 'percent',
      coverage: { observed: point.denominator, expected: point.denominator, percent: 100 }, freshness: freshness(date, period.to, 7),
    })),
    coverage: { observed: checkedDays, expected: summary.scheduledDays, percent: round(checkedDays / summary.scheduledDays * 100, 1), periodDays: period.days },
    freshness: freshness(latest, period.to, 7), habits: summary.habits,
  };
}

export function calculateGoalProgress(goal, metricResult, today) {
  const policy = {
    minObserved: 1, requireFresh: true,
    maintain: { minObservations: 2, distinctDates: true, spanStartDate: goal.startDate, spanTargetDate: goal.targetDate },
  };
  if (!metricResult?.available || !finite(metricResult.currentValue)) {
    return { goalId: goal.id, metric: goal.metric, storedStatus: goal.status, state: 'unavailable', currentValue: null,
      unit: METRIC_UNITS[goal.metric], percent: null, coverage: metricResult?.coverage || null,
      freshness: metricResult?.freshness || null, unavailableReason: metricResult?.unavailableReason || 'insufficient_data', evaluationPolicy: policy };
  }
  if (!metricResult.coverage || metricResult.coverage.observed <= 0) return {
    goalId: goal.id, metric: goal.metric, storedStatus: goal.status, state: 'insufficient_data', currentValue: metricResult.currentValue,
    unit: METRIC_UNITS[goal.metric], percent: null, coverage: metricResult.coverage, freshness: metricResult.freshness,
    unavailableReason: 'zero_coverage', evaluationPolicy: policy,
  };
  if (metricResult.freshness?.status !== 'fresh') return {
    goalId: goal.id, metric: goal.metric, storedStatus: goal.status, state: 'stale', currentValue: metricResult.currentValue,
    unit: METRIC_UNITS[goal.metric], percent: null, coverage: metricResult.coverage, freshness: metricResult.freshness,
    unavailableReason: 'stale_data', evaluationPolicy: policy,
  };
  const current = metricResult.currentValue;
  const tolerance = goal.tolerance ?? 0;
  let achieved = false;
  let percent;
  let state = 'in_progress';
  if (goal.direction === 'increase') {
    achieved = current >= goal.targetValue - tolerance;
    percent = clamp((current - goal.baselineValue) / (goal.targetValue - goal.baselineValue) * 100, 0, 100);
  } else if (goal.direction === 'decrease') {
    achieved = current <= goal.targetValue + tolerance;
    percent = clamp((goal.baselineValue - current) / (goal.baselineValue - goal.targetValue) * 100, 0, 100);
  } else {
    const starts = [...new Set((metricResult.points || []).map(point => point.date || point.from).filter(Boolean))].sort();
    const ends = [...new Set((metricResult.points || []).map(point => point.date || point.to).filter(Boolean))].sort();
    const longitudinal = starts.length >= 2 && starts[0] <= goal.startDate && ends.at(-1) >= goal.targetDate;
    const within = Math.abs(current - goal.targetValue) <= tolerance;
    achieved = within && today >= goal.targetDate && longitudinal;
    percent = within ? 100 : clamp(100 - Math.abs(current - goal.targetValue) / Math.max(Math.abs(goal.targetValue), 1) * 100, 0, 99.9);
    state = !longitudinal ? 'insufficient_data' : within ? 'within_tolerance' : 'outside_tolerance';
  }
  if (today < goal.startDate) state = 'not_started';
  else if (achieved || goal.status === 'achieved') state = 'achieved';
  else if (goal.status === 'archived') state = 'archived';
  return {
    goalId: goal.id, metric: goal.metric, storedStatus: goal.status, state, currentValue: current,
    unit: METRIC_UNITS[goal.metric], percent: round(percent, 1), coverage: metricResult.coverage,
    freshness: metricResult.freshness, unavailableReason: state === 'insufficient_data' ? 'insufficient_longitudinal_coverage' : null,
    evaluationPolicy: policy,
  };
}

export function buildProgressSummary({ db, link, state, period, timeZone, metrics, now = Date.now() }) {
  const effective = effectivePeriod(period, link, timeZone);
  const assessments = db.coachAssessments.filter(item => item.coachId === link.coachId && item.athleteId === link.athleteId)
    .map(item => ({ ...item, localDate: dateInTimeZone(Date.parse(item.assessedAt), timeZone) }))
    .filter(item => item.localDate >= effective.relationship.from && (!effective.relationship.to || item.localDate <= effective.relationship.to));
  const results = {};
  for (const metric of metrics) {
    if (!effective.days) results[metric] = unavailableMetric(metric, effective, 'outside_relationship_period');
    else if (metric === 'body_weight') results[metric] = bodyWeightMetric(state, assessments, effective);
    else if (metric === 'body_fat_percent') results[metric] = bodyFatMetric(assessments, effective);
    else if (metric === 'workouts_per_week') results[metric] = workoutMetric(db, link, state, effective, timeZone);
    else if (metric === 'nutrition_adherence_percent') results[metric] = nutritionMetric(db, link, effective, timeZone);
    else if (metric === 'habit_adherence_percent') results[metric] = habitMetric(db, link, effective, timeZone);
  }
  const goals = db.progressGoals.filter(goal => goal.linkId === link.id && metrics.includes(goal.metric))
    .sort(newest).map(goal => ({
      ...structuredClone(goal),
      progress: calculateGoalProgress(goal, results[goal.metric], dateInTimeZone(now, goal.timezone)),
    }));
  return {
    generatedAt: new Date(now).toISOString(), timezone: timeZone,
    period: { from: effective.from, to: effective.to, days: effective.days, requestedFrom: period.from, requestedTo: period.to, preset: period.preset },
    relationship: { linkId: link.id, status: link.status, readOnly: link.status !== 'active' },
    metrics: results, goals,
    disclaimer: 'Longitudinal factual summary only; it does not provide medical diagnosis, clinical prescription, or causal claims.',
  };
}

function goalInput(payload, current = null) {
  if (!record(payload)) return null;
  const allowed = ['baselineValue', 'direction', 'metric', 'startDate', 'status', 'targetDate', 'targetValue', 'timezone', 'tolerance'];
  if (Object.keys(payload).some(key => !allowed.includes(key))) return null;
  const merged = { ...(current || {}), ...payload };
  if (!GOAL_METRICS.includes(merged.metric) || !GOAL_DIRECTIONS.has(merged.direction)
      || !finiteMetric(merged.baselineValue) || !finiteMetric(merged.targetValue)
      || !(merged.tolerance === undefined || merged.tolerance === null || finite(merged.tolerance) && merged.tolerance >= 0 && merged.tolerance <= 1000000)
      || !validIsoDate(merged.startDate) || !validIsoDate(merged.targetDate) || merged.targetDate < merged.startDate
      || inclusiveDays(merged.startDate, merged.targetDate) > 3660 || !validTimeZone(merged.timezone)
      || merged.status !== undefined && !GOAL_STATUSES.has(merged.status)) return null;
  const directionCheck = { direction: merged.direction, baselineValue: merged.baselineValue, targetValue: merged.targetValue };
  if (!validGoalDirection(directionCheck)) return null;
  return {
    metric: merged.metric, direction: merged.direction, baselineValue: merged.baselineValue, targetValue: merged.targetValue,
    tolerance: merged.tolerance ?? null, startDate: merged.startDate, targetDate: merged.targetDate,
    timezone: merged.timezone, status: merged.status || 'active',
  };
}

function reportSummary(snapshot, metrics) {
  return metrics.map(metric => {
    const result = snapshot.metrics[metric];
    if (!result.available) return `${metric}: unavailable (${result.unavailableReason}).`;
    return `${metric}: ${result.currentValue} ${result.unit}; coverage ${result.coverage.percent ?? 'not applicable'}%.`;
  }).join(' ');
}

function serializeProgressReport(report) {
  if (report.revokedAt) return {
    id: report.id, linkId: report.linkId, interval: structuredClone(report.interval), timezone: report.timezone,
    metrics: [...report.metrics], summary: report.summary, createdAt: report.createdAt, revokedAt: report.revokedAt,
    revocation: report.revocation ? structuredClone(report.revocation) : null,
  };
  return structuredClone(report);
}

function csvCell(value) {
  let text = value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function progressReportCsv(report) {
  const headers = ['from', 'to', 'timezone', 'metric', 'available', 'currentValue', 'unit', 'numerator', 'denominator', 'coveragePercent', 'freshness', 'unavailableReason'];
  const rows = report.metrics.map(metric => {
    const result = report.snapshot.metrics[metric];
    return [report.interval.from, report.interval.to, report.timezone, metric, result.available, result.currentValue, result.unit, result.numerator || null, result.denominator || null,
      result.coverage?.percent ?? null, result.freshness?.status ?? null, result.unavailableReason];
  });
  return [headers, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

function makeId(prefix, rows) {
  let id;
  do { id = `${prefix}_${crypto.randomBytes(12).toString('base64url')}`; } while (rows.some(row => row.id === id));
  return id;
}

function requestedLinkId(url) {
  const value = url.searchParams.get('linkId');
  return value === null ? null : validId(value) ? value : false;
}

function statusForAccess(code) {
  if (code === 'not_signed_in') return 401;
  if (code === 'relationship_not_found') return 404;
  if (code === 'link_id_required') return 400;
  return 403;
}

export function createProgressRoutes({
  db, readBody, readSession, readState, json, b2bError, audit, auditDenied, commitCandidate,
  isCoach, coachScopes = () => [], limitAddress, cursorSecret = 'progress-cursor', limits = PROGRESS_LIMITS, rate = {}, now = () => Date.now(),
}) {
  const mutations = new StateWriteQueue({ perKeyLimit: 16, globalLimit: 512 });
  const mutationAccount = createWindow({ max: rate.mutationAccount || 120, windowMs: rate.windowMs || 3600000 });
  const mutationIp = createWindow({ max: rate.mutationIp || 600, windowMs: rate.windowMs || 3600000 });
  const exportAccount = createWindow({ max: rate.exportAccount || 120, windowMs: rate.windowMs || 3600000 });
  const exportIp = createWindow({ max: rate.exportIp || 600, windowMs: rate.windowMs || 3600000 });
  setInterval(() => {
    mutationAccount.sweep(); mutationIp.sweep(); exportAccount.sweep(); exportIp.sweep();
  }, Math.min(rate.windowMs || 3600000, 60000)).unref();
  const throttle = (req, res, actor, kind) => {
    const account = kind === 'export' ? exportAccount : mutationAccount;
    const ip = kind === 'export' ? exportIp : mutationIp;
    const wait = Math.max(account.take(actor.id), ip.take(limitAddress(req)));
    if (!wait) return false;
    auditDenied(req, `b2b2c.progress.${kind}.throttled`, actor, 'rate_limited');
    b2bError(res, 429, 'rate_limited', 'too many progress operations, try again later', { 'Retry-After': String(wait) });
    return true;
  };
  const actorAndLink = (req, res, { athleteId = null, write = false, coachOnly = false } = {}) => {
    const actor = readSession(req);
    if (!actor) { b2bError(res, 401, 'not_signed_in', 'not signed in'); return null; }
    if (coachOnly && !isCoach(actor)) { b2bError(res, 403, 'role_forbidden', 'professional profile required'); return null; }
    const url = new URL(req.url, 'http://x');
    const linkId = requestedLinkId(url);
    if (linkId === false) { b2bError(res, 400, 'invalid_link_id', 'linkId must be valid'); return null; }
    const access = resolveProgressLink(db, actor, { athleteId, linkId, write });
    if (!access.ok) {
      auditDenied(req, 'b2b2c.progress.denied', actor, access.code, athleteId ? db.users.find(user => user.id === athleteId) : null);
      b2bError(res, statusForAccess(access.code), access.code, 'progress relationship access denied');
      return null;
    }
    return { actor, access, url };
  };
  const requireMetrics = (res, actor, link, url, { required = false, bodyMetrics = null } = {}) => {
    const metrics = bodyMetrics === null ? parseMetrics(url.searchParams.get('metrics'), link.scopes, { required }) : [...bodyMetrics];
    if (metrics && (new Set(metrics).size !== metrics.length || metrics.some(metric => !GOAL_METRICS.includes(metric)))) {
      b2bError(res, 400, 'invalid_metrics', 'metrics must be unique supported progress metrics'); return null;
    }
    if (!metrics || !metrics.length) { b2bError(res, 400, 'invalid_metrics', 'at least one valid metric is required'); return null; }
    const forbidden = metrics.find(metric => !link.scopes.includes(scopeForProgressMetric(metric)));
    if (forbidden) { b2bError(res, 403, 'scope_forbidden', `relationship scope does not permit ${forbidden}`); return null; }
    const unsupported = actor.id === link.coachId
      ? metrics.find(metric => !coachScopes(actor).includes(scopeForProgressMetric(metric))) : null;
    if (unsupported) { b2bError(res, 403, 'scope_forbidden', `professional profile does not permit ${unsupported}`); return null; }
    return metrics;
  };
  const summaryFor = (res, link, url, metrics) => {
    const requestedTimeZone = url.searchParams.get('timezone');
    const athleteTimeZone = db.users.find(user => user.id === link.athleteId)?.profile?.timezone;
    const timeZone = requestedTimeZone || link.timezone || athleteTimeZone || 'UTC';
    if (!validTimeZone(timeZone)) { b2bError(res, 400, 'invalid_timezone', 'timezone must be a valid IANA timezone'); return null; }
    const period = parseProgressPeriod(url.searchParams, timeZone, now());
    if (!period) { b2bError(res, 400, 'invalid_period', 'period must be 7, 30 or 90 days, or an interval up to 366 days'); return null; }
    return buildProgressSummary({ db, link, state: readState(link.athleteId), period, timeZone, metrics, now: now() });
  };
  const commit = candidate => {
    compactProgressState(candidate, limits, now());
    commitCandidate(candidate);
  };
  const cursorMac = text => crypto.createHmac('sha256', cursorSecret).update(text).digest('base64url');
  const encodeCursor = payload => {
    const text = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${text}.${cursorMac(text)}`;
  };
  const decodeCursor = (raw, expected) => {
    if (!raw) return null;
    try {
      const [text, mac, extra] = raw.split('.');
      const expectedMac = cursorMac(text || '');
      if (extra || !text || !mac || mac.length !== expectedMac.length
          || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expectedMac))) return false;
      const value = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
      return record(value) && value.kind === expected.kind && value.linkId === expected.linkId
        && value.filters === expected.filters && typeof value.id === 'string' && typeof value.at === 'string' ? value : false;
    } catch { return false; }
  };
  const page = (res, rows, context, kind, serialize = item => structuredClone(item)) => {
    const rawLimit = context.url.searchParams.get('limit');
    const limit = rawLimit === null ? 25 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) { b2bError(res, 400, 'invalid_limit', 'limit must be between 1 and 100'); return null; }
    const filters = [...context.url.searchParams].filter(([key]) => !['cursor', 'limit', 'linkId'].includes(key))
      .sort().map(([key, value]) => `${key}=${value}`).join('&');
    const cursor = decodeCursor(context.url.searchParams.get('cursor'), { kind, linkId: context.access.link.id, filters });
    if (cursor === false) { b2bError(res, 400, 'invalid_cursor', 'cursor is invalid for this relationship or filter'); return null; }
    let start = 0;
    if (cursor) {
      start = rows.findIndex(item => (item.updatedAt || item.createdAt) === cursor.at && item.id === cursor.id) + 1;
      if (!start) { b2bError(res, 400, 'invalid_cursor', 'cursor no longer identifies this result set'); return null; }
    }
    const selected = rows.slice(start, start + limit);
    const hasMore = start + selected.length < rows.length;
    const last = selected.at(-1);
    return { items: selected.map(serialize), limit, hasMore, nextCursor: hasMore
      ? encodeCursor({ kind, linkId: context.access.link.id, filters, id: last.id, at: last.updatedAt || last.createdAt }) : null };
  };
  const listPeriod = (res, url) => {
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    if (from === null && to === null) return null;
    if (!validIsoDate(from) || !validIsoDate(to) || from > to || inclusiveDays(from, to) > 3660) {
      b2bError(res, 400, 'invalid_period', 'from and to must be valid dates in order'); return false;
    }
    return { from, to };
  };

  const listGoals = (req, res, options) => {
    const context = actorAndLink(req, res, options); if (!context) return;
    const actorScopes = context.actor.id === context.access.link.coachId ? coachScopes(context.actor) : context.access.link.scopes;
    const status = context.url.searchParams.get('status');
    if (status && !GOAL_STATUSES.has(status)) return b2bError(res, 400, 'invalid_status', 'status is invalid');
    const period = listPeriod(res, context.url); if (period === false) return;
    const goals = db.progressGoals.filter(goal => goal.linkId === context.access.link.id && (!status || goal.status === status)
        && (!period || goal.startDate <= period.to && goal.targetDate >= period.from))
      .filter(goal => context.access.link.scopes.includes(scopeForProgressMetric(goal.metric))
        && actorScopes.includes(scopeForProgressMetric(goal.metric))).sort(newest);
    const result = page(res, goals, context, 'goals'); if (!result) return;
    json(res, 200, { ...result, relationship: { linkId: context.access.link.id, status: context.access.link.status, readOnly: context.access.readOnly } });
  };
  const getSummary = (req, res, options) => {
    const context = actorAndLink(req, res, options); if (!context) return;
    const metrics = requireMetrics(res, context.actor, context.access.link, context.url); if (!metrics) return;
    const summary = summaryFor(res, context.access.link, context.url, metrics); if (!summary) return;
    audit(req, 'b2b2c.progress.summary', { user: context.actor, msg: `${context.access.link.id}:${metrics.join(',')}` });
    json(res, 200, { summary });
  };
  const reportMetadata = report => ({
    id: report.id, linkId: report.linkId, interval: structuredClone(report.interval), timezone: report.timezone,
    metrics: [...report.metrics], summary: report.summary, createdAt: report.createdAt, revokedAt: report.revokedAt,
    ...(report.revokedAt ? { revocation: report.revocation ? structuredClone(report.revocation) : null } : {}),
  });
  const listReports = (req, res, options) => {
    const context = actorAndLink(req, res, options); if (!context) return;
    const status = context.url.searchParams.get('status');
    if (status && !['active', 'revoked'].includes(status)) return b2bError(res, 400, 'invalid_status', 'status is invalid');
    const period = listPeriod(res, context.url); if (period === false) return;
    const reports = db.progressReports.filter(report => report.linkId === context.access.link.id
        && (!status || (status === 'revoked' ? !!report.revokedAt : !report.revokedAt))
        && (!period || report.interval.from <= period.to && report.interval.to >= period.from))
      .filter(report => report.metrics.every(metric => context.access.link.scopes.includes(scopeForProgressMetric(metric))))
      .filter(report => context.actor.id !== context.access.link.coachId
        || report.metrics.every(metric => coachScopes(context.actor).includes(scopeForProgressMetric(metric))))
      .sort(newest);
    const result = page(res, reports, context, 'reports', reportMetadata); if (!result) return;
    json(res, 200, { ...result,
      relationship: { linkId: context.access.link.id, status: context.access.link.status, readOnly: context.access.readOnly } });
  };
  const serveReport = (req, res, options, explicitExport = false) => {
    const context = actorAndLink(req, res, options); if (!context) return;
    const report = db.progressReports.find(item => item.id === req.reportId && item.linkId === context.access.link.id);
    if (!report) return b2bError(res, 404, 'report_not_found', 'progress report not found');
    if (report.revokedAt) return b2bError(res, 410, 'report_revoked', 'progress report was revoked');
    if (report.metrics.some(metric => !context.access.link.scopes.includes(scopeForProgressMetric(metric)))) {
      return b2bError(res, 403, 'scope_forbidden', 'relationship scope does not permit this report');
    }
    if (context.actor.id === context.access.link.coachId
        && report.metrics.some(metric => !coachScopes(context.actor).includes(scopeForProgressMetric(metric)))) {
      return b2bError(res, 403, 'scope_forbidden', 'professional profile does not permit this report');
    }
    const format = context.url.searchParams.get('format');
    if ((explicitExport || format) && !['json', 'csv'].includes(format)) return b2bError(res, 400, 'invalid_format', 'format must be json or csv');
    if (explicitExport || format) {
      if (throttle(req, res, context.actor, 'export')) return;
      const body = format === 'csv' ? progressReportCsv(report) : JSON.stringify({ report: serializeProgressReport(report) }, null, 2) + '\n';
      res.writeHead(200, {
        'Content-Type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="progress-report-${report.id}.${format}"`,
        'Cache-Control': 'private, no-store', 'Content-Length': Buffer.byteLength(body),
      });
      res.end(body);
      audit(req, 'b2b2c.progress.report.export', { user: context.actor, msg: `${report.id}:${format}` });
      return;
    }
    if (throttle(req, res, context.actor, 'export')) return;
    json(res, 200, { report: serializeProgressReport(report) });
  };

  return {
    'GET /api/progress/metrics': (req, res) => {
      const actor = readSession(req);
      if (!actor) return b2bError(res, 401, 'not_signed_in', 'not signed in');
      json(res, 200, { metrics: METRIC_CATALOG, states: ['not_started', 'in_progress', 'within_tolerance', 'outside_tolerance', 'achieved', 'archived', 'insufficient_data', 'stale', 'unavailable'],
        unavailableReasons: UNAVAILABLE_REASONS,
        goalProgressReasons: GOAL_PROGRESS_REASONS,
        trendReasons: TREND_REASONS });
    },
    'GET /api/coach/athletes/{athleteId}/progress-goals': (req, res) => listGoals(req, res, { athleteId: req.athleteId, coachOnly: true }),
    'GET /api/coach/athletes/{athleteId}/progress-goals/{goalId}': (req, res) => {
      const context = actorAndLink(req, res, { athleteId: req.athleteId, coachOnly: true }); if (!context) return;
      const goal = db.progressGoals.find(item => item.id === req.goalId && item.linkId === context.access.link.id);
      if (!goal) return b2bError(res, 404, 'goal_not_found', 'progress goal not found');
      const scope = scopeForProgressMetric(goal.metric);
      if (!context.access.link.scopes.includes(scope) || !coachScopes(context.actor).includes(scope)) {
        return b2bError(res, 403, 'scope_forbidden', 'current relationship and professional scope do not permit this goal');
      }
      json(res, 200, { goal });
    },
    'POST /api/coach/athletes/{athleteId}/progress-goals': async (req, res) => {
      const context = actorAndLink(req, res, { athleteId: req.athleteId, coachOnly: true, write: true }); if (!context) return;
      if (throttle(req, res, context.actor, 'mutation')) return;
      return mutations.run(context.access.link.id, async () => {
        const normalized = goalInput(await readBody(req));
        if (!normalized) return b2bError(res, 400, 'invalid_goal', 'invalid progress goal');
        const scope = scopeForProgressMetric(normalized.metric);
        if (!context.access.link.scopes.includes(scope) || !coachScopes(context.actor).includes(scope)) return b2bError(res, 403, 'scope_forbidden', `relationship scope ${scope} is required`);
        const candidate = structuredClone(db); compactProgressState(candidate, limits, now());
        const active = candidate.progressGoals.filter(goal => goal.status !== 'archived');
        const perLink = active.filter(goal => goal.linkId === context.access.link.id).length;
        if (perLink >= limits.maxGoalsPerLink || active.length >= limits.maxGoals) return b2bError(res, 409, 'goal_capacity', 'progress goal capacity reached');
        const timestamp = new Date(now()).toISOString();
        const goal = {
          id: makeId('pgoal', candidate.progressGoals), linkId: context.access.link.id, coachId: context.access.link.coachId,
          athleteId: context.access.link.athleteId, ...normalized, unit: METRIC_UNITS[normalized.metric], _rev: 1,
          createdAt: timestamp, updatedAt: timestamp,
          achievedAt: normalized.status === 'achieved' ? timestamp : null,
          archivedAt: normalized.status === 'archived' ? timestamp : null,
          archiveReason: normalized.status === 'archived' ? 'manual' : null,
        };
        candidate.progressGoals.push(goal);
        try { commit(candidate); } catch { return b2bError(res, 503, 'storage_unavailable', 'progress goal could not be saved'); }
        audit(req, 'b2b2c.progress.goal.create', { user: context.actor, target: db.users.find(user => user.id === req.athleteId), msg: goal.id });
        json(res, 201, { goal });
      });
    },
    'PATCH /api/coach/athletes/{athleteId}/progress-goals/{goalId}': async (req, res) => {
      const context = actorAndLink(req, res, { athleteId: req.athleteId, coachOnly: true, write: true }); if (!context) return;
      if (throttle(req, res, context.actor, 'mutation')) return;
      return mutations.run(context.access.link.id, async () => {
        const body = await readBody(req);
        const goal = db.progressGoals.find(item => item.id === req.goalId && item.linkId === context.access.link.id);
        if (!goal) return b2bError(res, 404, 'goal_not_found', 'progress goal not found');
        if (!record(body) || !Object.keys(body).length || !Number.isSafeInteger(body._rev)) return b2bError(res, 400, 'precondition_required', '_rev is required');
        if (body._rev !== goal._rev) return b2bError(res, 409, 'stale_version', 'goal version is stale');
        const { _rev, ...changes } = body;
        const normalized = goalInput(changes, goal);
        if (!normalized) return b2bError(res, 400, 'invalid_goal', 'invalid progress goal');
        const scope = scopeForProgressMetric(normalized.metric);
        if (!context.access.link.scopes.includes(scope) || !coachScopes(context.actor).includes(scope)) return b2bError(res, 403, 'scope_forbidden', `relationship scope ${scope} is required`);
        const timestamp = new Date(now()).toISOString();
        const updated = { ...goal, ...normalized, unit: METRIC_UNITS[normalized.metric], _rev: goal._rev + 1, updatedAt: timestamp };
        if (normalized.status === 'active') { updated.achievedAt = null; updated.archivedAt = null; updated.archiveReason = null; }
        if (normalized.status === 'achieved') { updated.achievedAt = goal.achievedAt || timestamp; updated.archivedAt = null; updated.archiveReason = null; }
        if (normalized.status === 'archived') { updated.archivedAt = goal.archivedAt || timestamp; updated.archiveReason = 'manual'; }
        const candidate = structuredClone(db);
        candidate.progressGoals[candidate.progressGoals.findIndex(item => item.id === goal.id)] = updated;
        try { commit(candidate); } catch { return b2bError(res, 503, 'storage_unavailable', 'progress goal could not be saved'); }
        audit(req, 'b2b2c.progress.goal.update', { user: context.actor, target: db.users.find(user => user.id === req.athleteId), msg: goal.id });
        json(res, 200, { goal: updated });
      });
    },
    'DELETE /api/coach/athletes/{athleteId}/progress-goals/{goalId}': async (req, res) => {
      const context = actorAndLink(req, res, { athleteId: req.athleteId, coachOnly: true, write: true }); if (!context) return;
      if (throttle(req, res, context.actor, 'mutation')) return;
      return mutations.run(context.access.link.id, async () => {
        const body = await readBody(req);
        const header = req.headers['if-match'];
        const match = typeof header === 'string' ? /^"?(\d+)"?$/.exec(header.trim()) : null;
        const revision = Number.isSafeInteger(body?._rev) ? body._rev : match ? Number(match[1]) : null;
        if (!record(body) || Object.keys(body).some(key => key !== '_rev') || !Number.isSafeInteger(revision)) {
          return b2bError(res, 400, 'precondition_required', '_rev body or If-Match header is required');
        }
        const goal = db.progressGoals.find(item => item.id === req.goalId && item.linkId === context.access.link.id);
        if (!goal) return b2bError(res, 404, 'goal_not_found', 'progress goal not found');
        if (revision !== goal._rev) return b2bError(res, 409, 'stale_version', 'goal version is stale');
        const timestamp = new Date(now()).toISOString();
        const updated = { ...goal, status: 'archived', _rev: goal._rev + 1, updatedAt: timestamp,
          archivedAt: goal.archivedAt || timestamp, archiveReason: goal.archiveReason || 'manual' };
        const candidate = structuredClone(db);
        candidate.progressGoals[candidate.progressGoals.findIndex(item => item.id === goal.id)] = updated;
        try { commit(candidate); } catch { return b2bError(res, 503, 'storage_unavailable', 'progress goal could not be archived'); }
        audit(req, 'b2b2c.progress.goal.archive', { user: context.actor, target: db.users.find(user => user.id === req.athleteId), msg: goal.id });
        json(res, 200, { goal: updated, archived: true });
      });
    },
    'GET /api/coach/athletes/{athleteId}/progress-summary': (req, res) => getSummary(req, res, { athleteId: req.athleteId, coachOnly: true }),
    'GET /api/athlete/progress-goals': (req, res) => listGoals(req, res, {}),
    'GET /api/athlete/progress-summary': (req, res) => getSummary(req, res, {}),
    'GET /api/coach/athletes/{athleteId}/progress-reports': (req, res) => listReports(req, res, { athleteId: req.athleteId, coachOnly: true }),
    'GET /api/athlete/progress-reports': (req, res) => listReports(req, res, {}),
    'POST /api/coach/athletes/{athleteId}/progress-reports': async (req, res) => {
      const context = actorAndLink(req, res, { athleteId: req.athleteId, coachOnly: true, write: true }); if (!context) return;
      if (throttle(req, res, context.actor, 'mutation')) return;
      return mutations.run(context.access.link.id, async () => {
        const body = await readBody(req);
        if (!record(body) || Object.keys(body).some(key => !['from', 'to', 'period', 'timezone', 'metrics'].includes(key))) {
          return b2bError(res, 400, 'invalid_report', 'invalid progress report request');
        }
        const reportUrl = new URL(req.url, 'http://x');
        for (const key of ['from', 'to', 'period', 'timezone']) if (body[key] !== undefined) reportUrl.searchParams.set(key, String(body[key]));
        const metrics = Array.isArray(body.metrics) && body.metrics.every(metric => typeof metric === 'string')
          ? body.metrics : null;
        if (!metrics) return b2bError(res, 400, 'invalid_metrics', 'report metrics are required');
        const selected = requireMetrics(res, context.actor, context.access.link, reportUrl, { required: true, bodyMetrics: metrics }); if (!selected) return;
        const snapshotSummary = summaryFor(res, context.access.link, reportUrl, selected); if (!snapshotSummary) return;
        const candidate = structuredClone(db); compactProgressState(candidate, limits, now());
        const active = candidate.progressReports.filter(report => !report.revokedAt);
        const perLink = active.filter(report => report.linkId === context.access.link.id).length;
        if (perLink >= limits.maxReportsPerLink || active.length >= limits.maxReports) return b2bError(res, 409, 'report_capacity', 'progress report capacity reached');
        const createdAt = new Date(now()).toISOString();
        const snapshot = {
          version: 1, generatedAt: snapshotSummary.generatedAt, period: snapshotSummary.period,
          relationship: { status: snapshotSummary.relationship.status }, metrics: snapshotSummary.metrics,
          goals: snapshotSummary.goals.map(goal => ({ id: goal.id, metric: goal.metric, direction: goal.direction,
            baselineValue: goal.baselineValue, targetValue: goal.targetValue, tolerance: goal.tolerance,
            startDate: goal.startDate, targetDate: goal.targetDate, progress: goal.progress })),
          disclaimer: snapshotSummary.disclaimer,
        };
        const report = {
          id: makeId('prep', candidate.progressReports), linkId: context.access.link.id, coachId: context.access.link.coachId,
          athleteId: context.access.link.athleteId, interval: { from: snapshotSummary.period.from, to: snapshotSummary.period.to },
          timezone: snapshotSummary.timezone, metrics: [...selected], summary: reportSummary(snapshot, selected), snapshot,
          createdAt, revokedAt: null, revocation: null,
        };
        if (!validateProgressReport(report, new Map([[context.access.link.id, context.access.link]]), limits)) {
          return b2bError(res, 400, 'invalid_report', 'report snapshot could not be validated');
        }
        candidate.progressReports.push(report);
        try { commit(candidate); } catch { return b2bError(res, 503, 'storage_unavailable', 'progress report could not be saved'); }
        audit(req, 'b2b2c.progress.report.create', { user: context.actor, target: db.users.find(user => user.id === req.athleteId), msg: report.id });
        json(res, 201, { report: serializeProgressReport(report) });
      });
    },
    'GET /api/coach/athletes/{athleteId}/progress-reports/{reportId}': (req, res) => serveReport(req, res, { athleteId: req.athleteId, coachOnly: true }),
    'GET /api/coach/athletes/{athleteId}/progress-reports/{reportId}/export': (req, res) => serveReport(req, res, { athleteId: req.athleteId, coachOnly: true }, true),
    'GET /api/athlete/progress-reports/{reportId}': (req, res) => serveReport(req, res, {}),
    'GET /api/athlete/progress-reports/{reportId}/export': (req, res) => serveReport(req, res, {}, true),
    'POST /api/coach/athletes/{athleteId}/progress-reports/{reportId}/revoke': async (req, res) => {
      const context = actorAndLink(req, res, { athleteId: req.athleteId, coachOnly: true }); if (!context) return;
      if (throttle(req, res, context.actor, 'mutation')) return;
      return mutations.run(context.access.link.id, async () => {
        const report = db.progressReports.find(item => item.id === req.reportId && item.linkId === context.access.link.id);
        if (!report) return b2bError(res, 404, 'report_not_found', 'progress report not found');
        if (report.revokedAt) return b2bError(res, 410, 'report_revoked', 'progress report was revoked');
        const updated = { ...report, revokedAt: new Date(now()).toISOString(), revocation: null };
        const candidate = structuredClone(db);
        candidate.progressReports[candidate.progressReports.findIndex(item => item.id === report.id)] = updated;
        try { commit(candidate); } catch { return b2bError(res, 503, 'storage_unavailable', 'progress report could not be revoked'); }
        audit(req, 'b2b2c.progress.report.revoke', { user: context.actor, target: db.users.find(user => user.id === req.athleteId), msg: report.id });
        json(res, 200, { report: serializeProgressReport(updated) });
      });
    },
  };
}

export const PROGRESS_METRICS = GOAL_METRICS;
