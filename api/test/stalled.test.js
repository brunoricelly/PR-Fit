import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { stalledStatus, stalledDaysFrom, STALLED_DEFAULT_DAYS } from '../stalled.js';

const w = (...ds) => ({ workouts: ds.map(d => ({ d })) });

describe('stalledStatus', () => {
  it('is active when the last workout is within the threshold', () => {
    const r = stalledStatus(w('2026-11-20', '2026-11-18'), '2026-11-24');
    assert.equal(r.status, 'active');
    assert.equal(r.lastWorkoutDate, '2026-11-20');
    assert.equal(r.daysSince, 4);
  });
  it('is active on exactly the threshold day and stalled one day after', () => {
    assert.equal(stalledStatus(w('2026-11-17'), '2026-11-24').status, 'active');   // 7 days
    assert.equal(stalledStatus(w('2026-11-16'), '2026-11-24').status, 'stalled');  // 8 days
  });
  it('honours a custom threshold', () => {
    assert.equal(stalledStatus(w('2026-11-20'), '2026-11-24', { thresholdDays: 3 }).status, 'stalled');
    assert.equal(stalledStatus(w('2026-11-20'), '2026-11-24', { thresholdDays: 4 }).status, 'active');
  });
  it('ignores workouts dated in the future', () => {
    const r = stalledStatus(w('2026-12-30', '2026-11-01'), '2026-11-24');
    assert.equal(r.lastWorkoutDate, '2026-11-01');
    assert.equal(r.status, 'stalled');
  });
  it('ignores malformed entries without throwing', () => {
    const r = stalledStatus({ workouts: [null, 5, { d: 'x' }, { d: '2026-11-23' }, {}] }, '2026-11-24');
    assert.equal(r.lastWorkoutDate, '2026-11-23');
    assert.equal(stalledStatus(null, '2026-11-24').status, 'active');
    assert.equal(stalledStatus({ workouts: 'nope' }, '2026-11-24').lastWorkoutDate, null);
  });
  it('a brand-new athlete with nothing logged is not stalled until the link is old enough', () => {
    assert.equal(stalledStatus({}, '2026-11-24', { since: '2026-11-22T10:00:00Z' }).status, 'active');
    const r = stalledStatus({}, '2026-11-24', { since: '2026-11-10T10:00:00Z' });
    assert.equal(r.status, 'never');
    assert.equal(r.daysSince, 14);
    assert.equal(r.lastWorkoutDate, null);
  });
  it('a day note excuses the stall (sick, away, free text)', () => {
    const sick = { ...w('2026-11-01'), dayNotes: { '2026-11-24': { tag: 'sick' } } };
    assert.equal(stalledStatus(sick, '2026-11-24').status, 'excused');
    const text = { ...w('2026-11-01'), dayNotes: { '2026-11-24': { text: 'viagem' } } };
    assert.equal(stalledStatus(text, '2026-11-24').status, 'excused');
    const old = { ...w('2026-11-01'), dayNotes: { '2026-11-10': { tag: 'sick' } } };
    assert.equal(stalledStatus(old, '2026-11-24').status, 'stalled');
  });
  it('an unusable date is unknown, never a false alarm', () => {
    assert.equal(stalledStatus(w('2026-11-01'), 'amanha').status, 'unknown');
    assert.equal(stalledStatus(w('2026-11-01'), undefined).status, 'unknown');
  });
});

describe('stalledDaysFrom', () => {
  it('clamps and defaults', () => {
    assert.equal(stalledDaysFrom(undefined), STALLED_DEFAULT_DAYS);
    assert.equal(stalledDaysFrom(null), STALLED_DEFAULT_DAYS);
    assert.equal(stalledDaysFrom(''), STALLED_DEFAULT_DAYS);
    assert.equal(stalledDaysFrom('abc'), STALLED_DEFAULT_DAYS);
    assert.equal(stalledDaysFrom('3.5'), STALLED_DEFAULT_DAYS);
    assert.equal(stalledDaysFrom('0'), 2);
    assert.equal(stalledDaysFrom('999'), 60);
    assert.equal(stalledDaysFrom('10'), 10);
  });
});

import { stalledPushOwed, stalledPushMark, stalledPushWindowOpen } from '../stalled.js';
describe('stalled push rules', () => {
  const st = (last, days = 7) => ({ status: 'stalled', lastWorkoutDate: last, thresholdDays: days });
  it('is owed the first time a stall is seen', () => {
    assert.equal(stalledPushOwed(null, st('2026-11-10'), '2026-11-24'), true);
  });
  it('is never owed for active, excused or never-trained athletes', () => {
    for (const status of ['active', 'excused', 'never', 'unknown']) {
      assert.equal(stalledPushOwed(null, { status, lastWorkoutDate: null, thresholdDays: 7 }, '2026-11-24'), false);
    }
  });
  it('is not repeated on the same day or before a full threshold has passed', () => {
    const sent = stalledPushMark(null, st('2026-11-10'), '2026-11-24');
    assert.equal(stalledPushOwed(sent, st('2026-11-10'), '2026-11-24'), false);
    assert.equal(stalledPushOwed(sent, st('2026-11-10'), '2026-11-30'), false);
    assert.equal(stalledPushOwed(sent, st('2026-11-10'), '2026-12-01'), true);
  });
  it('stops after three pushes for the same stall', () => {
    let sent = null;
    let day = 24;
    for (let i = 0; i < 3; i++) { sent = stalledPushMark(sent, st('2026-11-10'), `2026-11-${day}`); day += 7; }
    assert.equal(sent.count, 3);
    assert.equal(stalledPushOwed(sent, st('2026-11-10'), '2026-12-30'), false);
  });
  it('a new stall after training again starts over', () => {
    const sent = { date: '2026-11-24', count: 3, lastWorkout: '2026-11-10' };
    assert.equal(stalledPushOwed(sent, st('2026-12-02'), '2026-12-15'), true);
    assert.equal(stalledPushMark(sent, st('2026-12-02'), '2026-12-15').count, 1);
  });
  it('is sent only inside the evening window', () => {
    assert.equal(stalledPushWindowOpen('17:59'), false);
    assert.equal(stalledPushWindowOpen('18:00'), true);
    assert.equal(stalledPushWindowOpen('20:59'), true);
    assert.equal(stalledPushWindowOpen('21:01'), false);
    assert.equal(stalledPushWindowOpen('xx'), false);
  });
});
