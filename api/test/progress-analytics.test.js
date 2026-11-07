import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildProgressSummary, calculateGoalProgress, compactProgressState, migrateProgressState,
  parseProgressPeriod, progressReportCsv, validateProgressGoal,
} from '../progress-analytics.js';
import { compactB2B2C } from '../b2b2c.js';

const link = {
  id: 'cal_progress', coachId: 'u_coach', athleteId: 'u_athlete',
  scopes: ['training', 'nutrition', 'assessments'], status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};

function goal(over = {}) {
  return {
    id: 'pgoal_1', linkId: link.id, coachId: link.coachId, athleteId: link.athleteId,
    metric: 'body_weight', direction: 'decrease', baselineValue: 90, targetValue: 80,
    tolerance: 0.5, unit: 'kg', startDate: '2026-01-01', targetDate: '2026-12-31', timezone: 'UTC',
    status: 'active', _rev: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    achievedAt: null, archivedAt: null, archiveReason: null, ...over,
  };
}

function db(over = {}) {
  return {
    coachAthleteLinks: [link], coachAssessments: [], mealPlans: [], mealAdherence: [],
    coachHabits: [], habitCheckins: [], progressGoals: [], progressReports: [], ...over,
  };
}

test('strict goals calculate increase, decrease and maintain without cross-unit comparisons', () => {
  const links = new Map([[link.id, link]]);
  assert.equal(validateProgressGoal(goal(), links), true);
  assert.equal(validateProgressGoal({ ...goal(), extra: true }, links), false);
  assert.equal(validateProgressGoal(goal({ direction: 'increase', baselineValue: 90, targetValue: 80 }), links), false);
  const metric = { available: true, currentValue: 84, coverage: { observed: 2 }, freshness: { status: 'fresh' } };
  assert.deepEqual(calculateGoalProgress(goal(), metric, '2026-06-01').percent, 60);
  assert.equal(calculateGoalProgress(goal({ direction: 'increase', baselineValue: 10, targetValue: 20 }), { ...metric, currentValue: 20 }, '2026-06-01').state, 'achieved');
  const maintained = calculateGoalProgress(goal({ direction: 'maintain', baselineValue: 80, targetValue: 80, tolerance: 1, targetDate: '2026-05-01' }),
    { ...metric, currentValue: 80.5, points: [{ date: '2026-01-01', value: 80 }, { date: '2026-05-01', value: 80.5 }] }, '2026-06-01');
  assert.deepEqual([maintained.state, maintained.percent], ['achieved', 100]);
  const unavailable = calculateGoalProgress(goal(), { available: false, currentValue: null, unavailableReason: 'no_measurements' }, '2026-06-01');
  assert.deepEqual([unavailable.state, unavailable.currentValue, unavailable.percent], ['unavailable', null, null]);
});

test('goal completion is explicit for stale, zero coverage and longitudinal maintain data', () => {
  const fresh = { available: true, currentValue: 80, coverage: { observed: 1 }, freshness: { status: 'fresh' }, points: [{ date: '2026-05-01', value: 80 }] };
  assert.equal(calculateGoalProgress(goal(), { ...fresh, freshness: { status: 'stale' } }, '2027-01-01').state, 'stale');
  assert.equal(calculateGoalProgress(goal(), { ...fresh, coverage: { observed: 0 } }, '2027-01-01').state, 'insufficient_data');
  const maintainGoal = goal({ direction: 'maintain', baselineValue: 80, targetValue: 80, tolerance: 1, targetDate: '2026-05-01' });
  assert.equal(calculateGoalProgress(maintainGoal, fresh, '2026-06-01').state, 'insufficient_data');
  const enough = { ...fresh, points: [{ date: '2026-01-01', value: 80 }, { date: '2026-05-01', value: 80 }] };
  const result = calculateGoalProgress(maintainGoal, enough, '2026-06-01');
  assert.equal(result.state, 'achieved');
  assert.deepEqual(result.evaluationPolicy.maintain, { minObservations: 2, distinctDates: true, spanStartDate: '2026-01-01', spanTargetDate: '2026-05-01' });
});

test('7/30/90 day boundaries use the requested IANA timezone', () => {
  const instant = Date.parse('2026-11-07T12:30:00.000Z');
  for (const zone of ['America/Sao_Paulo', 'Asia/Tokyo', 'Pacific/Kiritimati']) {
    const seven = parseProgressPeriod(new URLSearchParams('period=7'), zone, instant);
    const thirty = parseProgressPeriod(new URLSearchParams('period=30'), zone, instant);
    const ninety = parseProgressPeriod(new URLSearchParams('period=90'), zone, instant);
    assert.deepEqual([seven.days, thirty.days, ninety.days], [7, 30, 90]);
    assert.equal(Date.parse(`${seven.to}T00:00:00Z`) - Date.parse(`${seven.from}T00:00:00Z`), 6 * 86400000);
  }
  assert.equal(parseProgressPeriod(new URLSearchParams('from=2025-01-01&to=2026-12-31'), 'UTC', instant), null);
});

test('analytics exposes real points, explicit denominators, coverage and freshness', () => {
  const now = Date.parse('2026-11-07T12:00:00.000Z');
  const state = {
    unit: 'kg',
    bodyweight: [{ d: '2026-11-01', w: 90 }, { d: '2026-11-07', w: 88 }],
    workouts: [{ id: 'w1', d: '2026-11-02', vol: 1000 }, { id: 'w2', d: '2026-11-06', vol: 1200 }],
  };
  const data = db({
    coachAssessments: [{
      id: 'cas_1', coachId: link.coachId, athleteId: link.athleteId,
      assessedAt: '2026-11-05T12:00:00.000Z', weightKg: 88.5,
      bioimpedance: { bodyFatPercent: 20 }, createdAt: '2026-11-05T12:00:00.000Z', updatedAt: '2026-11-05T12:00:00.000Z',
    }],
    mealPlans: [{ id: 'mp_1', coachId: link.coachId, athleteId: link.athleteId, createdAt: '2026-10-01T00:00:00.000Z', meals: [{ id: 'm1' }, { id: 'm2' }] }],
    mealAdherence: [{ id: 'adh_1', athleteId: link.athleteId, mealPlanId: 'mp_1', date: '2026-11-06', mealsChecked: ['m1'], updatedAt: now }],
    coachHabits: [{ id: 'hab_1', linkId: link.id, title: 'Water', frequency: 'daily', createdAt: Date.parse('2026-10-01T00:00:00Z'), archivedAt: null }],
    habitCheckins: [{ id: 'hchk_1', linkId: link.id, habitId: 'hab_1', date: '2026-11-06', completed: true }],
  });
  const summary = buildProgressSummary({
    db: data, link, state, period: { from: '2026-11-01', to: '2026-11-07', days: 7, preset: 7 },
    timeZone: 'UTC', metrics: ['body_weight', 'body_fat_percent', 'workouts_per_week', 'nutrition_adherence_percent', 'habit_adherence_percent'], now,
  });
  assert.deepEqual(summary.metrics.body_weight.points.map(point => point.value), [90, 88.5, 88]);
  assert.equal(summary.metrics.body_weight.trend.change, -2);
  assert.deepEqual([summary.metrics.workouts_per_week.currentValue, summary.metrics.workouts_per_week.volume.value], [2, 2200]);
  assert.deepEqual(summary.metrics.nutrition_adherence_percent.denominator, { recordedMealOpportunities: 2 });
  assert.deepEqual([summary.metrics.nutrition_adherence_percent.currentValue, summary.metrics.nutrition_adherence_percent.coverage.percent], [50, 14.3]);
  assert.deepEqual([summary.metrics.habit_adherence_percent.denominator.scheduledHabitDays, summary.metrics.habit_adherence_percent.coverage.observed], [7, 1]);
  assert.equal(summary.metrics.body_fat_percent.freshness.status, 'fresh');
  for (const metric of Object.values(summary.metrics)) {
    assert.ok(Array.isArray(metric.points));
    for (const point of metric.points) {
      assert.ok(point.date || point.from && point.to);
      assert.equal(typeof point.value, 'number');
      assert.ok(point.coverage && point.freshness && point.unit);
    }
  }
});

test('missing sources remain unavailable instead of becoming fabricated zeroes', () => {
  const summary = buildProgressSummary({
    db: db(), link, state: null, period: { from: '2026-11-01', to: '2026-11-07', days: 7, preset: 7 },
    timeZone: 'UTC', metrics: ['body_weight', 'body_fat_percent', 'workouts_per_week', 'nutrition_adherence_percent', 'habit_adherence_percent'],
    now: Date.parse('2026-11-07T12:00:00Z'),
  });
  for (const result of Object.values(summary.metrics)) {
    assert.equal(result.available, false);
    assert.equal(result.currentValue, null);
    assert.ok(result.unavailableReason);
    assert.deepEqual(result.points, []);
  }
});

test('progress migration, retention and CSV escaping are fail-closed', () => {
  const data = { coachAthleteLinks: [link] };
  assert.equal(migrateProgressState(data), true);
  assert.deepEqual([data.progressGoals, data.progressReports], [[], []]);
  data.progressGoals.push(goal({ status: 'archived', archivedAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z' }));
  assert.equal(compactProgressState(data, { ...{
    maxGoalsPerLink: 50, maxGoals: 100, goalRetentionDays: 1, maxReportsPerLink: 50,
    maxReports: 100, reportRetentionDays: 1, maxReportBytes: 1024 * 1024,
  } }, Date.parse('2026-11-07T00:00:00Z')).changed, true);
  const csv = progressReportCsv({
    interval: { from: '2026-11-01', to: '2026-11-07' }, timezone: 'UTC',
    metrics: ['body_weight'], snapshot: { metrics: { body_weight: {
      available: false, currentValue: null, unit: 'kg', numerator: null, denominator: null,
      coverage: { percent: null }, freshness: { status: 'none' }, unavailableReason: '=HYPERLINK("bad")',
    } } },
  });
  assert.match(csv, /'=HYPERLINK/);
  assert.match(csv, /""bad""/);
});

test('progress dependencies preserve terminal link tombstones and global limits fail closed', () => {
  const ended = { ...link, status: 'ended', updatedAt: '2020-01-02T00:00:00.000Z', endedAt: '2020-01-02T00:00:00.000Z' };
  const progressGoal = goal({ updatedAt: '2026-11-01T00:00:00.000Z' });
  const report = {
    id: 'prep_1', linkId: link.id, coachId: link.coachId, athleteId: link.athleteId,
    interval: { from: '2026-11-01', to: '2026-11-06' }, timezone: 'UTC', metrics: ['workouts_per_week'],
    summary: 'workouts_per_week: unavailable.', snapshot: { version: 1, metrics: {} },
    createdAt: '2026-11-06T00:00:00.000Z', revokedAt: null, revocation: null,
  };
  const state = {
    coachInvites: [], coachAthleteLinks: [ended], coachPrescriptions: [], coachAssessments: [], mealPlans: [], mealAdherence: [],
    coachMessages: [], coachHabits: [], habitCheckins: [], progressGoals: [progressGoal], progressReports: [report],
  };
  compactB2B2C(state, {
    maxInvites: 10, maxLinks: 1, maxPrescriptions: 10, terminalPrescriptionsKeep: 0,
    terminalInvitesKeep: 0, terminalLinksKeep: 0, terminalRetentionDays: 0,
    maxAssessments: 10, maxAssessmentsPerAthlete: 10, assessmentRetentionDays: 3650,
    maxMealPlans: 10, maxMealPlansPerAthlete: 10, maxMealAdherence: 10, maxMealAdherencePerAthlete: 10, mealAdherenceRetentionDays: 730,
    maxMessages: 10, maxMessagesPerLink: 10, messageRetentionDays: 365, maxHabits: 10, maxHabitsPerLink: 10,
    archivedHabitRetentionDays: 365, maxCheckins: 10, maxCheckinsPerHabit: 10, maxCheckinsPerLink: 10, checkinRetentionDays: 365,
    maxGoals: 10, maxGoalsPerLink: 10, goalRetentionDays: 730, maxReports: 10, maxReportsPerLink: 10,
    reportRetentionDays: 1095, maxReportBytes: 1024 * 1024,
  }, Date.parse('2026-11-07T00:00:00Z'));
  assert.deepEqual([state.coachAthleteLinks.length, state.coachAthleteLinks[0].tombstone], [1, true]);
  assert.deepEqual([state.progressGoals[0].linkId, state.progressReports[0].linkId], [link.id, link.id]);
});

test('relationship tombstones preserve acceptedAt and historical summary boundaries', () => {
  const acceptedAt = '2026-02-03T23:30:00.000Z';
  const ended = { ...link, acceptedAt, status: 'ended', updatedAt: '2026-03-10T00:00:00.000Z', endedAt: '2026-03-10T00:00:00.000Z' };
  const state = db({ coachInvites: [], coachAthleteLinks: [ended], coachPrescriptions: [], coachMessages: [],
    accountCleanupJobs: [], progressGoals: [goal({ linkId: ended.id })] });
  const args = { db: state, link: ended, state: { unit: 'kg', bodyweight: [] }, period: { from: '2026-01-01', to: '2026-03-31', days: 90, preset: 90 }, timeZone: 'Asia/Tokyo', metrics: ['body_weight'], now: Date.parse('2026-03-31T00:00:00Z') };
  const before = buildProgressSummary(args).period;
  compactB2B2C(state, {
    maxInvites: 10, maxLinks: 1, maxPrescriptions: 10, terminalPrescriptionsKeep: 0, terminalInvitesKeep: 0, terminalLinksKeep: 0, terminalRetentionDays: 0,
    maxAssessments: 10, maxAssessmentsPerAthlete: 10, assessmentRetentionDays: 3650, maxMealPlans: 10, maxMealPlansPerAthlete: 10,
    maxMealAdherence: 10, maxMealAdherencePerAthlete: 10, mealAdherenceRetentionDays: 730, maxMessages: 10, maxMessagesPerLink: 10,
    messageRetentionDays: 365, maxHabits: 10, maxHabitsPerLink: 10, archivedHabitRetentionDays: 365, maxCheckins: 10,
    maxCheckinsPerHabit: 10, maxCheckinsPerLink: 10, checkinRetentionDays: 365, maxGoals: 10, maxGoalsPerLink: 10,
    goalRetentionDays: 730, maxReports: 10, maxReportsPerLink: 10, reportRetentionDays: 1095, maxReportBytes: 1024 * 1024,
  }, Date.parse('2026-11-07T00:00:00Z'));
  assert.equal(state.coachAthleteLinks[0].acceptedAt, acceptedAt);
  const after = buildProgressSummary({ ...args, link: state.coachAthleteLinks[0] }).period;
  assert.deepEqual(after, before);
});
