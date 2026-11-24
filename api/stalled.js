// Stalled-athlete detection, shared by the coach's list and the athlete's re-engagement push.
// Pure: it reads one athlete's state document and a local date, and answers how long it has been
// since a workout was logged. No I/O, so it is unit-tested without booting the server.
import { excusedOn } from './nudge.js';

export const STALLED_DEFAULT_DAYS = 7;
export const STALLED_MIN_DAYS = 2;
export const STALLED_MAX_DAYS = 60;

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86400000;
const dayNumber = iso => Math.floor(Date.parse(iso + 'T12:00:00Z') / DAY_MS);

/** A threshold from user input, clamped to a sane range; anything unusable is the default. */
export function stalledDaysFrom(value) {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return STALLED_DEFAULT_DAYS;
  const n = Number(value);
  if (!Number.isInteger(n)) return STALLED_DEFAULT_DAYS;
  return Math.min(STALLED_MAX_DAYS, Math.max(STALLED_MIN_DAYS, n));
}

/**
 * Where an athlete stands today.
 *  - `active`   a workout within the threshold
 *  - `stalled`  the last workout is older than the threshold
 *  - `never`    nothing logged yet; `daysSince` then counts from `since` (the link's acceptance)
 *  - `excused`  today carries a day note (sick, away, rest, injured, or free text): not a stall
 * Workouts dated after today are ignored, so a wrong clock cannot hide a stall.
 */
export function stalledStatus(state, todayIso, { thresholdDays = STALLED_DEFAULT_DAYS, since = null } = {}) {
  const days = stalledDaysFrom(thresholdDays);
  if (!ISO.test(todayIso || '')) return { status: 'unknown', lastWorkoutDate: null, daysSince: null, thresholdDays: days };
  const workouts = Array.isArray(state?.workouts) ? state.workouts : [];
  let last = '';
  for (const w of workouts) {
    if (w && typeof w.d === 'string' && ISO.test(w.d) && w.d <= todayIso && w.d > last) last = w.d;
  }
  const out = { lastWorkoutDate: last || null, daysSince: null, thresholdDays: days };
  if (excusedOn(state, todayIso)) return { ...out, daysSince: last ? dayNumber(todayIso) - dayNumber(last) : null, status: 'excused' };
  if (!last) {
    const from = typeof since === 'string' ? since.slice(0, 10) : '';
    const age = ISO.test(from) ? Math.max(0, dayNumber(todayIso) - dayNumber(from)) : null;
    return { ...out, daysSince: age, status: age != null && age >= days ? 'never' : 'active' };
  }
  const gap = dayNumber(todayIso) - dayNumber(last);
  return { ...out, daysSince: gap, status: gap > days ? 'stalled' : 'active' };
}

export const STALLED_PUSH_MAX = 3;       // at most this many pushes for one stall
export const STALLED_PUSH_HOUR_MIN = 18 * 60;   // sent from 18:00 local...
export const STALLED_PUSH_WINDOW_MIN = 3 * 60;  // ...until 21:00, once per date, so a restart in the evening still sends it

const hhmmToMin = v => {
  const m = /^(\d{2}):(\d{2})$/.exec(v || '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
};

/** Is `hhmm` (the athlete's local time) inside the short window the stalled push is sent in? */
export function stalledPushWindowOpen(hhmm) {
  const now = hhmmToMin(hhmm);
  return now >= STALLED_PUSH_HOUR_MIN && now <= STALLED_PUSH_HOUR_MIN + STALLED_PUSH_WINDOW_MIN;
}

/**
 * Whether a stalled athlete is owed a push today, given what was sent before (`sent`:
 * { date, count, lastWorkout }). Rules: only for status `stalled` (never `never`, `excused`, `active`);
 * never twice on one date; a new stall (a different last workout) starts the count again; at most
 * STALLED_PUSH_MAX per stall, each one a full threshold after the previous (the gap grows, it never
 * becomes daily).
 */
export function stalledPushOwed(sent, status, todayIso) {
  if (status?.status !== 'stalled') return false;
  const same = sent && sent.lastWorkout === status.lastWorkoutDate;
  const count = same ? Number(sent.count) || 0 : 0;
  if (count >= STALLED_PUSH_MAX) return false;
  if (same && sent.date === todayIso) return false;
  if (!same || !ISO.test(sent.date || '')) return true;
  return dayNumber(todayIso) - dayNumber(sent.date) >= status.thresholdDays;
}

export const stalledPushMark = (sent, status, todayIso) => {
  const same = sent && sent.lastWorkout === status.lastWorkoutDate;
  return { date: todayIso, count: (same ? Number(sent.count) || 0 : 0) + 1, lastWorkout: status.lastWorkoutDate };
};
