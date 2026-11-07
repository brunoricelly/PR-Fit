import crypto from 'node:crypto';
import { createWindow } from './rate-limit.js';

const ID_RE = /^[A-Za-z0-9_-]{1,120}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;
const APPOINTMENT_TYPES = new Set(['in_person', 'online']);
const APPOINTMENT_STATUSES = new Set(['scheduled', 'completed', 'canceled', 'no_show']);
const ATTENDANCE_STATES = new Set(['attended', 'missed']);
const LINK_STATUSES = new Set(['pending', 'active', 'suspended', 'ended']);
const REMINDER_OFFSETS = new Set([5, 10, 15, 30, 60, 120, 1440, 2880, 10080]);
const TERMINAL_STATUSES = new Set(['completed', 'canceled', 'no_show']);

export const SCHEDULING_LIMITS = Object.freeze({
  maxActiveAppointmentsPerLink: 500,
  maxActiveAppointments: 50000,
  maxTerminalAppointmentsPerLink: 5000,
  maxTerminalAppointments: 200000,
  appointmentRetentionDays: 730,
  reminderRetentionDays: 30,
  maxReminderStates: 400000,
  maxReminderOutbox: 400000,
  minSessionDurationMinutes: 15,
  maxSessionDurationMinutes: 480,
  minBufferMinutes: 0,
  maxBufferMinutes: 240,
  minNoticeHoursMax: 720,
  maxAdvanceDaysMax: 365,
  maxAvailabilityExceptions: 730,
});

const record = value => !!value && typeof value === 'object' && !Array.isArray(value);
const validId = value => typeof value === 'string' && ID_RE.test(value);
const clone = value => structuredClone(value);
const allowedKeys = (value, allowed) => record(value) && Object.keys(value).every(key => allowed.has(key));
const iso = value => new Date(value).toISOString();

function parseDate(value) {
  if (typeof value !== 'string') return null;
  const match = DATE_RE.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null;
  return { year, month, day, value };
}

export function parseInstant(value) {
  if (typeof value !== 'string') return null;
  const match = INSTANT_RE.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (!parseDate(`${match[1]}-${match[2]}-${match[3]}`) || hour > 23 || minute > 59 || second > 59) return null;
  if (match[8] !== 'Z') {
    const offsetHour = Number(match[8].slice(1, 3));
    const offsetMinute = Number(match[8].slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return null;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

export function validTimeZone(value) {
  if (typeof value !== 'string' || !value || value.length > 100) return false;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function parseMinutes(timeStr) {
  if (typeof timeStr !== 'string' || !TIME_RE.test(timeStr)) return null;
  const [hour, minute] = timeStr.split(':').map(Number);
  return hour * 60 + minute;
}

export function formatMinutes(totalMinutes) {
  const hour = Math.floor(totalMinutes / 60);
  const minute = totalMinutes % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

const zonedFormatterCache = new Map();
function zonedFormatter(timeZone) {
  let formatter = zonedFormatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
    zonedFormatterCache.set(timeZone, formatter);
  }
  return formatter;
}

export function getZonedParts(timestampMs, timeZone) {
  const parts = Object.fromEntries(zonedFormatter(timeZone).formatToParts(new Date(timestampMs)).map(part => [part.type, part.value]));
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const hour = parts.hour === '24' ? '00' : parts.hour.padStart(2, '0');
  const minute = parts.minute.padStart(2, '0');
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    dayOfWeek: weekdayMap[parts.weekday],
    timeStr: `${hour}:${minute}`,
    second: Number(parts.second),
    dateStr: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

function zonedWallEpoch(timestampMs, timeZone) {
  const parts = getZonedParts(timestampMs, timeZone);
  return Date.UTC(parts.year, parts.month - 1, parts.day, Number(parts.timeStr.slice(0, 2)), Number(parts.timeStr.slice(3, 5)), parts.second);
}

export function zonedTimeCandidates(dateStr, timeStr, timeZone) {
  const date = parseDate(dateStr);
  const minutes = parseMinutes(timeStr);
  if (!date || minutes === null || !validTimeZone(timeZone)) return [];
  const target = Date.UTC(date.year, date.month - 1, date.day, Math.floor(minutes / 60), minutes % 60, 0, 0);
  const offsets = new Set();
  for (let delta = -36; delta <= 36; delta += 6) {
    const sample = target + delta * 3600000;
    offsets.add(zonedWallEpoch(sample, timeZone) - sample);
  }
  const candidates = [];
  for (const offset of offsets) {
    const candidate = target - offset;
    const parts = getZonedParts(candidate, timeZone);
    if (parts.dateStr === dateStr && parts.timeStr === timeStr && parts.second === 0) candidates.push(candidate);
  }
  return [...new Set(candidates)].sort((left, right) => left - right);
}

export function zonedTimeToUtcMs(dateStr, timeStr, timeZone) {
  return zonedTimeCandidates(dateStr, timeStr, timeZone)[0] ?? null;
}

export function shiftDayString(dateStr, days) {
  const date = parseDate(dateStr);
  if (!date || !Number.isInteger(days)) return null;
  return new Date(Date.UTC(date.year, date.month - 1, date.day + days)).toISOString().slice(0, 10);
}

export function validateWindow(window) {
  if (!allowedKeys(window, new Set(['dayOfWeek', 'day', 'start', 'end']))) return null;
  const dayOfWeek = window.dayOfWeek ?? window.day;
  if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) return null;
  const start = parseMinutes(window.start);
  const end = parseMinutes(window.end);
  if (start === null || end === null || start >= end) return null;
  return { dayOfWeek, start: window.start, end: window.end };
}

function validateDatedWindow(window) {
  if (!allowedKeys(window, new Set(['start', 'end']))) return null;
  const start = parseMinutes(window.start);
  const end = parseMinutes(window.end);
  if (start === null || end === null || start >= end) return null;
  return { start: window.start, end: window.end };
}

function validateNonOverlapping(windows, validator, maximum) {
  if (!Array.isArray(windows) || windows.length > maximum) return null;
  const normalized = [];
  for (const value of windows) {
    const parsed = validator(value);
    if (!parsed) return null;
    normalized.push(parsed);
  }
  normalized.sort((left, right) => (left.dayOfWeek ?? 0) - (right.dayOfWeek ?? 0) || parseMinutes(left.start) - parseMinutes(right.start));
  for (let index = 0; index < normalized.length - 1; index++) {
    const current = normalized[index];
    const next = normalized[index + 1];
    if ((current.dayOfWeek ?? 0) === (next.dayOfWeek ?? 0) && parseMinutes(current.end) > parseMinutes(next.start)) return null;
  }
  return normalized;
}

export function validateWindowsList(windows) {
  return validateNonOverlapping(windows, validateWindow, 50);
}

export function validateAvailabilityExceptions(exceptions) {
  if (!Array.isArray(exceptions) || exceptions.length > SCHEDULING_LIMITS.maxAvailabilityExceptions) return null;
  const dates = new Set();
  const normalized = [];
  for (const exception of exceptions) {
    if (!record(exception) || !parseDate(exception.date) || dates.has(exception.date)) return null;
    dates.add(exception.date);
    if (exception.unavailable === true && allowedKeys(exception, new Set(['date', 'unavailable']))) {
      normalized.push({ date: exception.date, unavailable: true });
      continue;
    }
    if (!allowedKeys(exception, new Set(['date', 'windows']))) return null;
    const windows = validateNonOverlapping(exception.windows, validateDatedWindow, 20);
    if (!windows) return null;
    normalized.push({ date: exception.date, windows });
  }
  return normalized.sort((left, right) => left.date.localeCompare(right.date));
}

export function validateAvailabilityInput(body) {
  if (!record(body)) return null;
  const raw = record(body.availability) && Object.keys(body).length === 1 ? body.availability : body;
  const allowed = new Set(['_rev', 'timezone', 'timeZone', 'sessionDurationMinutes', 'durationMinutes', 'defaultDurationMinutes', 'bufferMinutes', 'minNoticeHours', 'maxAdvanceDays', 'windows', 'exceptions']);
  if (!allowedKeys(raw, allowed)) return null;
  const timeZone = raw.timeZone ?? raw.timezone ?? 'America/Sao_Paulo';
  if (!validTimeZone(timeZone)) return null;
  const sessionDurationMinutes = raw.sessionDurationMinutes ?? raw.durationMinutes ?? raw.defaultDurationMinutes ?? 60;
  if (!Number.isInteger(sessionDurationMinutes)
      || sessionDurationMinutes < SCHEDULING_LIMITS.minSessionDurationMinutes
      || sessionDurationMinutes > SCHEDULING_LIMITS.maxSessionDurationMinutes) return null;
  const bufferMinutes = raw.bufferMinutes ?? 0;
  if (!Number.isInteger(bufferMinutes) || bufferMinutes < SCHEDULING_LIMITS.minBufferMinutes || bufferMinutes > SCHEDULING_LIMITS.maxBufferMinutes) return null;
  const minNoticeHours = raw.minNoticeHours ?? 2;
  if (!Number.isInteger(minNoticeHours) || minNoticeHours < 0 || minNoticeHours > SCHEDULING_LIMITS.minNoticeHoursMax) return null;
  const maxAdvanceDays = raw.maxAdvanceDays ?? 30;
  if (!Number.isInteger(maxAdvanceDays) || maxAdvanceDays < 1 || maxAdvanceDays > SCHEDULING_LIMITS.maxAdvanceDaysMax) return null;
  const windows = validateWindowsList(raw.windows ?? []);
  const exceptions = validateAvailabilityExceptions(raw.exceptions ?? []);
  if (!windows || !exceptions) return null;
  if (raw._rev !== undefined && (!Number.isInteger(raw._rev) || raw._rev < 0)) return null;
  return {
    ...(raw._rev === undefined ? {} : { _rev: raw._rev }),
    timeZone, sessionDurationMinutes, bufferMinutes, minNoticeHours, maxAdvanceDays, windows, exceptions,
  };
}

export function validateAppointmentPayload(body, { defaultDuration = 60 } = {}) {
  if (!record(body)) return null;
  const raw = record(body.appointment) && Object.keys(body).length === 1 ? body.appointment : body;
  const allowed = new Set(['linkId', 'type', 'title', 'notes', 'location', 'meetingUrl', 'startAt', 'endAt']);
  if (!allowedKeys(raw, allowed) || typeof raw.startAt !== 'string') return null;
  if (raw.linkId !== undefined && !validId(raw.linkId)) return null;
  const type = raw.type ?? 'in_person';
  if (!APPOINTMENT_TYPES.has(type)) return null;
  const title = raw.title === undefined ? 'Sessão' : typeof raw.title === 'string' ? raw.title.trim() : '';
  if (!title || title.length > 120) return null;
  if (raw.notes !== undefined && typeof raw.notes !== 'string') return null;
  if (raw.location !== undefined && raw.location !== null && typeof raw.location !== 'string') return null;
  if (raw.meetingUrl !== undefined && raw.meetingUrl !== null && typeof raw.meetingUrl !== 'string') return null;
  if (!Number.isInteger(defaultDuration) || defaultDuration < 1) return null;
  const startMs = parseInstant(raw.startAt);
  if (startMs === null) return null;
  const derivedEndMs = startMs + defaultDuration * 60000;
  let endMs = derivedEndMs;
  if (raw.endAt !== undefined) {
    if (typeof raw.endAt !== 'string') return null;
    endMs = parseInstant(raw.endAt);
    if (endMs === null || endMs !== derivedEndMs) return null;
  }
  return {
    ...(raw.linkId ? { linkId: raw.linkId } : {}),
    type,
    title,
    notes: raw.notes?.trim().slice(0, 1000) ?? '',
    location: raw.location?.trim().slice(0, 200) || null,
    meetingUrl: raw.meetingUrl?.trim().slice(0, 500) || null,
    startAt: iso(startMs), endAt: iso(endMs), startMs, endMs, durationMinutes: defaultDuration,
  };
}

function validateReschedulePayload(body, durationMinutes) {
  if (!allowedKeys(body, new Set(['startAt', 'endAt'])) || Object.keys(body).length === 0 || typeof body.startAt !== 'string') return null;
  const startMs = parseInstant(body.startAt);
  if (startMs === null) return null;
  const endMs = startMs + durationMinutes * 60000;
  if (body.endAt !== undefined && (typeof body.endAt !== 'string' || parseInstant(body.endAt) !== endMs)) return null;
  return { startMs, endMs, startAt: iso(startMs), endAt: iso(endMs), durationMinutes };
}

function windowsForDate(availability, dateStr) {
  const exception = (availability.exceptions || []).find(item => item.date === dateStr);
  if (exception?.unavailable) return [];
  if (exception) return exception.windows.map(window => ({ ...window }));
  const date = parseDate(dateStr);
  if (!date) return [];
  const dayOfWeek = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
  return (availability.windows || []).filter(window => window.dayOfWeek === dayOfWeek).map(window => ({ start: window.start, end: window.end }));
}

export function isWithinAvailabilityWindows(startMs, endMs, availability, durationOverride = null) {
  const timeZone = availability?.timeZone ?? availability?.timezone;
  const durationMinutes = durationOverride ?? availability?.sessionDurationMinutes;
  if (!validTimeZone(timeZone) || !Number.isInteger(durationMinutes) || endMs - startMs !== durationMinutes * 60000) return false;
  const startParts = getZonedParts(startMs, timeZone);
  const endParts = getZonedParts(endMs, timeZone);
  if (startParts.dateStr !== endParts.dateStr || startParts.second !== 0 || endParts.second !== 0) return false;
  const startMinute = parseMinutes(startParts.timeStr);
  const endMinute = parseMinutes(endParts.timeStr);
  if (startMinute === null || endMinute !== startMinute + durationMinutes) return false;
  const step = durationMinutes + (availability.bufferMinutes || 0);
  return windowsForDate(availability, startParts.dateStr).some(window => {
    const windowStart = parseMinutes(window.start);
    const windowEnd = parseMinutes(window.end);
    return windowStart <= startMinute && endMinute <= windowEnd && (startMinute - windowStart) % step === 0;
  });
}

export function hasAppointmentConflict(appointments, { coachId, athleteId, startAtMs, endAtMs, bufferMinutes = 0, excludeAppointmentId = null }) {
  const bufferMs = Math.max(0, bufferMinutes) * 60000;
  for (const appointment of appointments || []) {
    if (appointment.id === excludeAppointmentId || appointment.status !== 'scheduled') continue;
    const appointmentStart = parseInstant(appointment.startAt);
    const appointmentEnd = parseInstant(appointment.endAt);
    if (appointmentStart === null || appointmentEnd === null) continue;
    if (appointment.coachId === coachId && startAtMs < appointmentEnd + bufferMs && endAtMs + bufferMs > appointmentStart) {
      return { conflict: true, reason: 'coach_conflict', conflictingId: appointment.id };
    }
    if (appointment.athleteId === athleteId && startAtMs < appointmentEnd && endAtMs > appointmentStart) {
      return { conflict: true, reason: 'athlete_conflict', conflictingId: appointment.id };
    }
  }
  return { conflict: false };
}

export function calculateAvailabilitySlots({ availability, appointments = [], athleteId = null, nowMs = Date.now(), fromDate = null, toDate = null, durationMinutes = null }) {
  const timeZone = availability?.timeZone ?? availability?.timezone;
  const duration = durationMinutes ?? availability?.sessionDurationMinutes;
  if (!validTimeZone(timeZone) || !Number.isInteger(duration) || duration < 1) return [];
  const minNoticeMs = nowMs + (availability.minNoticeHours ?? 2) * 3600000;
  const maxAdvanceMs = nowMs + (availability.maxAdvanceDays ?? 30) * 86400000;
  const today = getZonedParts(nowMs, timeZone).dateStr;
  if ((fromDate && !parseDate(fromDate)) || (toDate && !parseDate(toDate))) return [];
  const effectiveFrom = fromDate && fromDate > today ? fromDate : today;
  const horizon = shiftDayString(today, availability.maxAdvanceDays ?? 30);
  const effectiveTo = toDate && toDate < horizon ? toDate : horizon;
  if (!effectiveTo || effectiveFrom > effectiveTo) return [];
  const slots = [];
  const seen = new Set();
  for (let date = effectiveFrom; date <= effectiveTo; date = shiftDayString(date, 1)) {
    for (const window of windowsForDate(availability, date)) {
      const startMinute = parseMinutes(window.start);
      const endMinute = parseMinutes(window.end);
      const step = duration + (availability.bufferMinutes || 0);
      for (let current = startMinute; current + duration <= endMinute; current += step) {
        const localStart = formatMinutes(current);
        const expectedLocalEnd = formatMinutes(current + duration);
        const startMs = zonedTimeToUtcMs(date, localStart, timeZone);
        if (startMs === null) continue;
        const endMs = startMs + duration * 60000;
        const endParts = getZonedParts(endMs, timeZone);
        if (endParts.dateStr !== date || endParts.timeStr !== expectedLocalEnd || endParts.second !== 0) continue;
        if (startMs < minNoticeMs || startMs > maxAdvanceMs) continue;
        const conflict = hasAppointmentConflict(appointments, {
          coachId: availability.coachId, athleteId, startAtMs: startMs, endAtMs: endMs,
          bufferMinutes: availability.bufferMinutes || 0,
        });
        const startAt = iso(startMs);
        if (conflict.conflict || seen.has(startAt)) continue;
        seen.add(startAt);
        slots.push({ startAt, endAt: iso(endMs), timeZone, localDate: date, durationMinutes: duration });
      }
    }
  }
  return slots;
}

function profileKind(user) {
  return user?.profile?.kind === 'coach' && Array.isArray(user.profile.coachSpecialties) && user.profile.coachSpecialties.length ? 'coach' : 'athlete';
}

function validateCancellation(value) {
  return value === null || (allowedKeys(value, new Set(['actor', 'actorId', 'reason', 'canceledAt']))
    && ['coach', 'athlete', 'system'].includes(value.actor)
    && (value.actorId === null || validId(value.actorId))
    && typeof value.reason === 'string' && value.reason.length >= 1 && value.reason.length <= 500
    && parseInstant(value.canceledAt) !== null);
}

function validateAttendance(value) {
  return value === null || (allowedKeys(value, new Set(['state', 'recordedBy', 'recordedAt']))
    && ATTENDANCE_STATES.has(value.state) && validId(value.recordedBy) && parseInstant(value.recordedAt) !== null);
}

function validateReminderCollections(db) {
  const preferences = new Set();
  for (const preference of db.schedulingReminderPreferences) {
    if (!allowedKeys(preference, new Set(['userId', 'enabled', 'offsetsMinutes', 'timeZone', 'updatedAt']))
        || !validId(preference.userId) || preferences.has(preference.userId) || !db.users.some(user => user.id === preference.userId)
        || typeof preference.enabled !== 'boolean' || !validTimeZone(preference.timeZone)
        || !Array.isArray(preference.offsetsMinutes) || preference.offsetsMinutes.length > 5
        || preference.offsetsMinutes.some(offset => !REMINDER_OFFSETS.has(offset))
        || new Set(preference.offsetsMinutes).size !== preference.offsetsMinutes.length || parseInstant(preference.updatedAt) === null) {
      throw new Error('schedulingReminderPreferences contains an invalid record');
    }
    preferences.add(preference.userId);
  }
  const stateIds = new Set();
  for (const state of db.appointmentReminderStates) {
    if (!allowedKeys(state, new Set(['id', 'appointmentId', 'userId', 'offsetMinutes', 'scheduledFor', 'status', 'createdAt', 'updatedAt']))
        || !validId(state.id) || stateIds.has(state.id) || !db.coachAppointments.some(item => item.id === state.appointmentId)
        || !db.users.some(user => user.id === state.userId) || !REMINDER_OFFSETS.has(state.offsetMinutes)
        || !['pending', 'canceled', 'delivered'].includes(state.status) || parseInstant(state.scheduledFor) === null
        || parseInstant(state.createdAt) === null || parseInstant(state.updatedAt) === null) {
      throw new Error('appointmentReminderStates contains an invalid record');
    }
    stateIds.add(state.id);
  }
  const outboxIds = new Set();
  for (const item of db.schedulingReminderOutbox) {
    if (!allowedKeys(item, new Set(['id', 'reminderStateId', 'appointmentId', 'userId', 'deliverAt', 'status', 'payload', 'createdAt', 'updatedAt']))
        || !validId(item.id) || outboxIds.has(item.id) || !stateIds.has(item.reminderStateId)
        || !db.coachAppointments.some(appointment => appointment.id === item.appointmentId)
        || !db.users.some(user => user.id === item.userId) || parseInstant(item.deliverAt) === null
        || !['pending', 'canceled', 'delivered'].includes(item.status)
        || !allowedKeys(item.payload, new Set(['type', 'appointmentId'])) || item.payload.type !== 'appointment_reminder'
        || item.payload.appointmentId !== item.appointmentId || parseInstant(item.createdAt) === null || parseInstant(item.updatedAt) === null) {
      throw new Error('schedulingReminderOutbox contains an invalid record');
    }
    outboxIds.add(item.id);
  }
}

function rejectOverlaps(appointments, field) {
  const groups = new Map();
  for (const appointment of appointments) {
    if (appointment.status !== 'scheduled') continue;
    const list = groups.get(appointment[field]) || [];
    list.push(appointment);
    groups.set(appointment[field], list);
  }
  for (const list of groups.values()) {
    list.sort((left, right) => parseInstant(left.startAt) - parseInstant(right.startAt) || left.id.localeCompare(right.id));
    for (let index = 1; index < list.length; index++) {
      if (parseInstant(list[index].startAt) < parseInstant(list[index - 1].endAt)) {
        throw new Error(`coachAppointments scheduled overlap for ${field}`);
      }
    }
  }
}

export function validateSchedulingState(db, limits = SCHEDULING_LIMITS) {
  for (const key of ['users', 'coachAthleteLinks', 'coachAvailability', 'coachAppointments', 'schedulingReminderPreferences', 'appointmentReminderStates', 'schedulingReminderOutbox']) {
    if (!Array.isArray(db[key])) throw new Error(`${key} must be an array`);
  }
  const users = new Map(db.users.map(user => [user.id, user]));
  const links = new Map(db.coachAthleteLinks.map(link => [link.id, link]));
  const coachIds = new Set();
  for (const availability of db.coachAvailability) {
    const parsed = validateAvailabilityInput({
      _rev: availability._rev,
      timeZone: availability.timeZone,
      sessionDurationMinutes: availability.sessionDurationMinutes,
      bufferMinutes: availability.bufferMinutes,
      minNoticeHours: availability.minNoticeHours,
      maxAdvanceDays: availability.maxAdvanceDays,
      windows: availability.windows,
      exceptions: availability.exceptions,
    });
    const coach = users.get(availability.coachId);
    if (!record(availability) || !validId(availability.id) || !validId(availability.coachId) || coachIds.has(availability.coachId)
        || !coach || profileKind(coach) !== 'coach' || !parsed || !Number.isInteger(availability._rev) || availability._rev < 1
        || parseInstant(availability.createdAt) === null || parseInstant(availability.updatedAt) === null) {
      throw new Error('coachAvailability contains an invalid record or coach');
    }
    coachIds.add(availability.coachId);
  }
  const appointmentIds = new Set();
  const activeByLink = new Map();
  const terminalByLink = new Map();
  let activeCount = 0;
  let terminalCount = 0;
  for (const appointment of db.coachAppointments) {
    const link = links.get(appointment.linkId);
    const coach = users.get(appointment.coachId);
    const athlete = users.get(appointment.athleteId);
    const startMs = parseInstant(appointment.startAt);
    const endMs = parseInstant(appointment.endAt);
    if (!record(appointment) || !validId(appointment.id) || appointmentIds.has(appointment.id)
        || !validId(appointment.coachId) || !validId(appointment.athleteId) || !validId(appointment.linkId)
        || !coach || profileKind(coach) !== 'coach' || !athlete || profileKind(athlete) !== 'athlete'
        || !link || link.coachId !== appointment.coachId || link.athleteId !== appointment.athleteId
        || !Array.isArray(link.scopes) || !link.scopes.includes('training') || !LINK_STATUSES.has(link.status)
        || !APPOINTMENT_TYPES.has(appointment.type) || !APPOINTMENT_STATUSES.has(appointment.status)
        || typeof appointment.title !== 'string' || !appointment.title || appointment.title.length > 120
        || typeof appointment.notes !== 'string' || appointment.notes.length > 1000
        || !validTimeZone(appointment.timeZone) || !parseDate(appointment.localDate)
        || !Number.isInteger(appointment.durationMinutes) || appointment.durationMinutes < 1
        || startMs === null || endMs === null || endMs <= startMs || endMs - startMs !== appointment.durationMinutes * 60000
        || getZonedParts(startMs, appointment.timeZone).dateStr !== appointment.localDate
        || !validateCancellation(appointment.cancellation) || !validateAttendance(appointment.attendance)
        || parseInstant(appointment.createdAt) === null || parseInstant(appointment.updatedAt) === null) {
      throw new Error('coachAppointments contains an invalid record, participant, or link');
    }
    if (appointment.status === 'scheduled' && (appointment.cancellation !== null || appointment.attendance !== null)) throw new Error('coachAppointments contains incoherent scheduled status');
    if (appointment.status === 'canceled' && (appointment.cancellation === null || appointment.attendance !== null)) throw new Error('coachAppointments contains incoherent cancellation status');
    if (appointment.status === 'completed' && (appointment.cancellation !== null || appointment.attendance?.state !== 'attended')) throw new Error('coachAppointments contains incoherent completed status');
    if (appointment.status === 'no_show' && (appointment.cancellation !== null || appointment.attendance?.state !== 'missed')) throw new Error('coachAppointments contains incoherent no_show status');
    appointmentIds.add(appointment.id);
    if (appointment.status === 'scheduled') {
      activeCount++;
      activeByLink.set(appointment.linkId, (activeByLink.get(appointment.linkId) || 0) + 1);
    } else {
      terminalCount++;
      terminalByLink.set(appointment.linkId, (terminalByLink.get(appointment.linkId) || 0) + 1);
    }
  }
  if (activeCount > (limits.maxActiveAppointments ?? SCHEDULING_LIMITS.maxActiveAppointments)) throw new Error('coachAppointments active limit exceeded');
  if (terminalCount > (limits.maxTerminalAppointments ?? SCHEDULING_LIMITS.maxTerminalAppointments)) throw new Error('coachAppointments terminal limit exceeded');
  for (const count of activeByLink.values()) if (count > (limits.maxActiveAppointmentsPerLink ?? SCHEDULING_LIMITS.maxActiveAppointmentsPerLink)) throw new Error('coachAppointments active per-link limit exceeded');
  for (const count of terminalByLink.values()) if (count > (limits.maxTerminalAppointmentsPerLink ?? SCHEDULING_LIMITS.maxTerminalAppointmentsPerLink)) throw new Error('coachAppointments terminal per-link limit exceeded');
  rejectOverlaps(db.coachAppointments, 'coachId');
  rejectOverlaps(db.coachAppointments, 'athleteId');
  if (db.appointmentReminderStates.length > (limits.maxReminderStates ?? SCHEDULING_LIMITS.maxReminderStates)) throw new Error('appointmentReminderStates limit exceeded');
  if (db.schedulingReminderOutbox.length > (limits.maxReminderOutbox ?? SCHEDULING_LIMITS.maxReminderOutbox)) throw new Error('schedulingReminderOutbox limit exceeded');
  validateReminderCollections(db);
  return true;
}

function migrateAvailability(availability) {
  let changed = false;
  if (availability.timeZone === undefined && availability.timezone !== undefined) { availability.timeZone = availability.timezone; delete availability.timezone; changed = true; }
  if (availability.exceptions === undefined) { availability.exceptions = []; changed = true; }
  if (availability._rev === undefined) { availability._rev = 1; changed = true; }
  return changed;
}

function migrateAppointment(appointment, availabilityByCoach) {
  let changed = false;
  const startMs = parseInstant(appointment.startAt);
  const endMs = parseInstant(appointment.endAt);
  if (appointment.timeZone === undefined) { appointment.timeZone = availabilityByCoach.get(appointment.coachId)?.timeZone || 'UTC'; changed = true; }
  if (appointment.localDate === undefined && startMs !== null && validTimeZone(appointment.timeZone)) { appointment.localDate = getZonedParts(startMs, appointment.timeZone).dateStr; changed = true; }
  if (appointment.durationMinutes === undefined && startMs !== null && endMs !== null && (endMs - startMs) % 60000 === 0) { appointment.durationMinutes = (endMs - startMs) / 60000; changed = true; }
  if (appointment.cancellation === undefined) {
    appointment.cancellation = appointment.status === 'canceled' ? {
      actor: appointment.canceledBy || 'system', actorId: null,
      reason: appointment.cancelReason || 'legacy_cancellation', canceledAt: appointment.updatedAt,
    } : null;
    changed = true;
  }
  if (typeof appointment.attendance === 'string') {
    appointment.attendance = { state: appointment.attendance, recordedBy: appointment.coachId, recordedAt: appointment.updatedAt };
    changed = true;
  } else if (appointment.attendance === undefined) {
    appointment.attendance = null;
    changed = true;
  }
  for (const key of ['canceledBy', 'cancelReason', 'canceledAt']) {
    if (key in appointment) { delete appointment[key]; changed = true; }
  }
  return changed;
}

export function migrateSchedulingState(db) {
  let changed = false;
  for (const key of ['coachAvailability', 'coachAppointments', 'schedulingReminderPreferences', 'appointmentReminderStates', 'schedulingReminderOutbox']) {
    if (db[key] === undefined) { db[key] = []; changed = true; }
    else if (!Array.isArray(db[key])) throw new Error(`${key} must be an array`);
  }
  for (const availability of db.coachAvailability) changed = migrateAvailability(availability) || changed;
  const availabilityByCoach = new Map(db.coachAvailability.map(item => [item.coachId, item]));
  for (const appointment of db.coachAppointments) changed = migrateAppointment(appointment, availabilityByCoach) || changed;
  validateSchedulingState(db);
  return changed;
}

export function compactSchedulingState(db, limits = SCHEDULING_LIMITS, nowMs = Date.now()) {
  for (const key of ['coachAvailability', 'coachAppointments', 'schedulingReminderPreferences', 'appointmentReminderStates', 'schedulingReminderOutbox']) db[key] ||= [];
  let changed = false;
  const appointmentCutoff = nowMs - (limits.appointmentRetentionDays ?? SCHEDULING_LIMITS.appointmentRetentionDays) * 86400000;
  const keptAppointments = db.coachAppointments.filter(appointment => appointment.status === 'scheduled' || parseInstant(appointment.endAt) >= appointmentCutoff);
  if (keptAppointments.length !== db.coachAppointments.length) changed = true;
  db.coachAppointments = keptAppointments;
  const appointmentIds = new Set(keptAppointments.map(item => item.id));
  const reminderCutoff = nowMs - (limits.reminderRetentionDays ?? SCHEDULING_LIMITS.reminderRetentionDays) * 86400000;
  const keptStates = db.appointmentReminderStates.filter(state => appointmentIds.has(state.appointmentId)
    && (state.status === 'pending' || parseInstant(state.updatedAt) >= reminderCutoff));
  if (keptStates.length !== db.appointmentReminderStates.length) changed = true;
  db.appointmentReminderStates = keptStates;
  const stateIds = new Set(keptStates.map(item => item.id));
  const keptOutbox = db.schedulingReminderOutbox.filter(item => stateIds.has(item.reminderStateId)
    && (item.status === 'pending' || parseInstant(item.updatedAt) >= reminderCutoff));
  if (keptOutbox.length !== db.schedulingReminderOutbox.length) changed = true;
  db.schedulingReminderOutbox = keptOutbox;
  const hasSchedulingData = db.coachAvailability.length || db.coachAppointments.length
    || db.schedulingReminderPreferences.length || db.appointmentReminderStates.length || db.schedulingReminderOutbox.length;
  if (hasSchedulingData || Array.isArray(db.users) && Array.isArray(db.coachAthleteLinks)) validateSchedulingState(db, limits);
  return { changed, appointments: db.coachAppointments.length, availability: db.coachAvailability.length, reminders: db.appointmentReminderStates.length };
}

export function removeSchedulingUser(db, userId) {
  db.coachAvailability = (db.coachAvailability || []).filter(item => item.coachId !== userId);
  const removedAppointmentIds = new Set((db.coachAppointments || []).filter(item => item.coachId === userId || item.athleteId === userId).map(item => item.id));
  db.coachAppointments = (db.coachAppointments || []).filter(item => !removedAppointmentIds.has(item.id));
  db.schedulingReminderPreferences = (db.schedulingReminderPreferences || []).filter(item => item.userId !== userId);
  const removedStateIds = new Set((db.appointmentReminderStates || []).filter(item => item.userId === userId || removedAppointmentIds.has(item.appointmentId)).map(item => item.id));
  db.appointmentReminderStates = (db.appointmentReminderStates || []).filter(item => !removedStateIds.has(item.id));
  db.schedulingReminderOutbox = (db.schedulingReminderOutbox || []).filter(item => item.userId !== userId && !removedStateIds.has(item.reminderStateId));
}

function cancelReminderState(db, appointmentId, nowIso) {
  for (const state of db.appointmentReminderStates || []) {
    if (state.appointmentId === appointmentId && state.status === 'pending') { state.status = 'canceled'; state.updatedAt = nowIso; }
  }
  for (const item of db.schedulingReminderOutbox || []) {
    if (item.appointmentId === appointmentId && item.status === 'pending') { item.status = 'canceled'; item.updatedAt = nowIso; }
  }
}

export function cancelFutureAppointmentsForLink(db, linkId, reason = 'relationship_ended', actorId = null, cutoffMs = Date.now()) {
  let changed = false;
  const nowIso = iso(cutoffMs);
  for (const appointment of db.coachAppointments || []) {
    if (appointment.linkId !== linkId || appointment.status !== 'scheduled' || parseInstant(appointment.endAt) <= cutoffMs) continue;
    appointment.status = 'canceled';
    appointment.cancellation = { actor: 'system', actorId, reason, canceledAt: nowIso };
    appointment.updatedAt = nowIso;
    cancelReminderState(db, appointment.id, nowIso);
    changed = true;
  }
  return changed;
}

function validateReminderPreference(body) {
  if (!allowedKeys(body, new Set(['enabled', 'offsetsMinutes', 'timeZone'])) || typeof body.enabled !== 'boolean'
      || !Array.isArray(body.offsetsMinutes) || body.offsetsMinutes.length > 5
      || body.offsetsMinutes.some(offset => !REMINDER_OFFSETS.has(offset))
      || new Set(body.offsetsMinutes).size !== body.offsetsMinutes.length || !validTimeZone(body.timeZone)) return null;
  return { enabled: body.enabled, offsetsMinutes: [...body.offsetsMinutes].sort((a, b) => a - b), timeZone: body.timeZone };
}

function deterministicId(prefix, values) {
  return `${prefix}_${crypto.createHash('sha256').update(values.join('\0')).digest('base64url').slice(0, 24)}`;
}

export function reconcileAppointmentReminders(db, appointment, nowMs = Date.now()) {
  const nowIso = iso(nowMs);
  cancelReminderState(db, appointment.id, nowIso);
  if (appointment.status !== 'scheduled') return;
  for (const userId of [appointment.coachId, appointment.athleteId]) {
    const preference = (db.schedulingReminderPreferences || []).find(item => item.userId === userId);
    if (!preference?.enabled) continue;
    for (const offsetMinutes of preference.offsetsMinutes) {
      const deliverAtMs = parseInstant(appointment.startAt) - offsetMinutes * 60000;
      if (deliverAtMs <= nowMs) continue;
      const stateId = deterministicId('srem', [appointment.id, userId, offsetMinutes, appointment.startAt]);
      const outboxId = deterministicId('sout', [stateId]);
      if ((db.appointmentReminderStates || []).some(item => item.id === stateId)) continue;
      db.appointmentReminderStates.push({
        id: stateId, appointmentId: appointment.id, userId, offsetMinutes,
        scheduledFor: iso(deliverAtMs), status: 'pending', createdAt: nowIso, updatedAt: nowIso,
      });
      db.schedulingReminderOutbox.push({
        id: outboxId, reminderStateId: stateId, appointmentId: appointment.id, userId,
        deliverAt: iso(deliverAtMs), status: 'pending', payload: { type: 'appointment_reminder', appointmentId: appointment.id },
        createdAt: nowIso, updatedAt: nowIso,
      });
    }
  }
}

function cursorFilters(search, names) {
  return Object.fromEntries(names.map(name => [name, search.get(name) || null]));
}

function cursorToken(secret, payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function readCursor(secret, token, expected) {
  if (!token) return null;
  const [encoded, signature, extra] = token.split('.');
  if (!encoded || !signature || extra) return false;
  const wanted = crypto.createHmac('sha256', secret).update(encoded).digest();
  let actual;
  try { actual = Buffer.from(signature, 'base64url'); } catch { return false; }
  if (wanted.length !== actual.length || !crypto.timingSafeEqual(wanted, actual)) return false;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!record(payload) || payload.v !== 1 || payload.actor !== expected.actor || payload.route !== expected.route
        || payload.scope !== expected.scope || JSON.stringify(payload.filters) !== JSON.stringify(expected.filters)
        || !Array.isArray(payload.after) || payload.after.length !== 2) return false;
    return payload.after;
  } catch {
    return false;
  }
}

function participantSummary(user) {
  return { id: user.id, name: typeof user.name === 'string' ? user.name : '' };
}

function lifecycleOf(appointment, link, actor, nowMs) {
  const ended = parseInstant(appointment.endAt) <= nowMs;
  const historical = TERMINAL_STATUSES.has(appointment.status) || ended;
  const activeLink = link?.status === 'active';
  const allowedActions = [];
  if (activeLink && appointment.status === 'scheduled') {
    if (!ended) allowedActions.push('reschedule', 'cancel');
    else if (actor.id === appointment.coachId) allowedActions.push('attendance');
  }
  return { historical, readOnly: allowedActions.length === 0, allowedActions };
}

function serializeAppointment(db, appointment, actor, nowMs) {
  const link = db.coachAthleteLinks.find(item => item.id === appointment.linkId);
  return {
    ...clone(appointment),
    coach: participantSummary(db.users.find(user => user.id === appointment.coachId)),
    athlete: participantSummary(db.users.find(user => user.id === appointment.athleteId)),
    lifecycle: lifecycleOf(appointment, link, actor, nowMs),
  };
}

function appointmentPage({ db, actor, rows, limit, hasMore, nextCursor, relationship = null, nowMs }) {
  return {
    items: rows.map(item => serializeAppointment(db, item, actor, nowMs)),
    limit, hasMore, nextCursor,
    ...(relationship ? { relationship } : {}),
  };
}

export function createSchedulingRoutes(context) {
  const {
    audit, auditDenied, db, json, limitAddress, limits: configuredLimits = {}, makeEntityId,
    profileOf, readBody, readSession, rate = {}, saveDb, publishDb, commitCandidate,
    cursorSecret = 'scheduling-cursor-secret', now = () => Date.now(),
  } = context;
  const limits = { ...SCHEDULING_LIMITS, ...configuredLimits };
  const buckets = {};
  for (const [kind, accountMax, ipMax] of [
    ['mutation', rate.schedulingMutationAccount || 60, rate.schedulingMutationIp || 300],
    ['status', rate.schedulingStatusAccount || 120, rate.schedulingStatusIp || 600],
    ['read', rate.schedulingReadAccount || rate.readAccount || 600, rate.schedulingReadIp || rate.readIp || 3000],
  ]) {
    buckets[kind] = {
      account: createWindow({ max: accountMax, windowMs: rate.windowMs || 3600000 }),
      ip: createWindow({ max: ipMax, windowMs: rate.windowMs || 3600000 }),
    };
  }
  setInterval(() => Object.values(buckets).forEach(bucket => { bucket.account.sweep(); bucket.ip.sweep(); }), Math.min(rate.windowMs || 3600000, 60000)).unref();

  const fail = (res, status, code, message, violations = []) => json(res, status, { error: message, code, violations });
  const throttle = (req, res, user, kind) => {
    const bucket = buckets[kind];
    const wait = Math.max(bucket.account.take(user.id), bucket.ip.take(limitAddress(req)));
    if (!wait) return false;
    auditDenied(req, `b2b2c.scheduling.${kind}.throttled`, user, 'rate_limited');
    json(res, 429, { error: 'too many scheduling requests, try again later', code: 'rate_limited', violations: [] }, { 'Retry-After': String(wait) });
    return true;
  };
  const commit = candidate => {
    validateSchedulingState(candidate, limits);
    if (typeof commitCandidate === 'function') commitCandidate(candidate);
    else { saveDb(candidate); if (typeof publishDb === 'function') publishDb(candidate); }
  };
  const actorOnly = (req, res) => {
    const actor = readSession(req);
    if (!actor) { fail(res, 401, 'not_signed_in', 'not signed in'); return null; }
    return actor;
  };
  const coachOnly = (req, res) => {
    const coach = actorOnly(req, res);
    if (!coach) return null;
    if (profileOf(coach).kind !== 'coach') { fail(res, 403, 'role_forbidden', 'professional profile required'); return null; }
    return coach;
  };
  const athleteOnly = (req, res) => {
    const athlete = actorOnly(req, res);
    if (!athlete) return null;
    if (profileOf(athlete).kind === 'coach') { fail(res, 403, 'role_forbidden', 'athlete profile required'); return null; }
    return athlete;
  };
  const requestedLinkId = (req, body = null) => body?.linkId || new URL(req.url, 'http://x').searchParams.get('linkId');
  const resolveLink = (coachId, athleteId, req, body = null, requireActive = true) => {
    const pair = (db.coachAthleteLinks || []).filter(link => link.coachId === coachId && link.athleteId === athleteId);
    const linkId = requestedLinkId(req, body);
    let link;
    if (linkId) link = pair.find(item => item.id === linkId);
    else if (pair.length === 1) [link] = pair;
    else if (pair.length > 1) return { ok: false, status: 400, code: 'link_id_required', message: 'linkId is required when multiple relationships exist' };
    if (!link) return { ok: false, status: 404, code: 'relationship_not_found', message: 'relationship not found' };
    if (!link.scopes.includes('training')) return { ok: false, status: 403, code: 'scope_forbidden', message: 'training scope required' };
    if (requireActive && link.status !== 'active') return { ok: false, status: 403, code: 'relationship_inactive', message: 'active relationship required' };
    return { ok: true, link };
  };
  const accessFailure = (req, res, actor, event, access) => {
    auditDenied(req, event, actor, access.code);
    fail(res, access.status, access.code, access.message, access.code === 'link_id_required' ? [{ field: 'linkId', code: 'required' }] : []);
  };
  const availabilityFor = coachId => db.coachAvailability.find(item => item.coachId === coachId);
  const validateBooking = (availability, payload, coachId, athleteId, excludeAppointmentId = null) => {
    const nowMs = now();
    if (payload.startMs < nowMs) return { status: 400, code: 'past_appointment', message: 'appointment cannot be in the past' };
    if (payload.startMs < nowMs + availability.minNoticeHours * 3600000) return { status: 400, code: 'min_notice_violated', message: 'appointment does not meet minimum notice' };
    if (payload.startMs > nowMs + availability.maxAdvanceDays * 86400000) return { status: 400, code: 'max_advance_exceeded', message: 'appointment exceeds booking horizon' };
    if (!isWithinAvailabilityWindows(payload.startMs, payload.endMs, availability, payload.durationMinutes)) return { status: 400, code: 'invalid_slot', message: 'appointment must use an aligned available slot' };
    const conflict = hasAppointmentConflict(db.coachAppointments, {
      coachId, athleteId, startAtMs: payload.startMs, endAtMs: payload.endMs,
      bufferMinutes: availability.bufferMinutes, excludeAppointmentId,
    });
    if (conflict.conflict) return { status: 409, code: 'double_booking', message: 'schedule conflict detected' };
    return null;
  };
  const appointmentQuota = (candidate, linkId) => {
    const active = candidate.coachAppointments.filter(item => item.status === 'scheduled');
    if (active.length >= limits.maxActiveAppointments || active.filter(item => item.linkId === linkId).length >= limits.maxActiveAppointmentsPerLink) return false;
    return true;
  };
  const createAppointment = (candidate, link, payload, createdAt) => {
    const appointment = {
      id: makeEntityId('capp', candidate.coachAppointments), linkId: link.id,
      coachId: link.coachId, athleteId: link.athleteId, type: payload.type, title: payload.title,
      notes: payload.notes, startAt: payload.startAt, endAt: payload.endAt,
      timeZone: availabilityFor(link.coachId).timeZone,
      localDate: getZonedParts(payload.startMs, availabilityFor(link.coachId).timeZone).dateStr,
      durationMinutes: payload.durationMinutes, status: 'scheduled', cancellation: null,
      location: payload.location, meetingUrl: payload.meetingUrl, attendance: null,
      createdAt, updatedAt: createdAt,
    };
    candidate.coachAppointments.push(appointment);
    reconcileAppointmentReminders(candidate, appointment, Date.parse(createdAt));
    return appointment;
  };
  const findParticipantAppointment = (actor, appointmentId) => {
    const appointment = db.coachAppointments.find(item => item.id === appointmentId);
    return appointment && (appointment.coachId === actor.id || appointment.athleteId === actor.id) ? appointment : null;
  };
  const validateListFilters = search => {
    const status = search.get('status');
    const from = search.get('from');
    const to = search.get('to');
    const coachId = search.get('coachId');
    const linkId = search.get('linkId');
    if (status && !APPOINTMENT_STATUSES.has(status)) return { error: ['status', 'invalid'] };
    if (from && parseInstant(from) === null) return { error: ['from', 'invalid'] };
    if (to && parseInstant(to) === null) return { error: ['to', 'invalid'] };
    if (from && to && parseInstant(from) > parseInstant(to)) return { error: ['range', 'invalid'] };
    if (coachId && !validId(coachId)) return { error: ['coachId', 'invalid'] };
    if (linkId && !validId(linkId)) return { error: ['linkId', 'invalid'] };
    return { status, from, to, coachId, linkId };
  };
  const pageRows = (req, res, actor, route, scope, rows, filters, relationship = null) => {
    const search = new URL(req.url, 'http://x').searchParams;
    const limit = search.get('limit') === null ? 50 : Number(search.get('limit'));
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) { fail(res, 400, 'invalid_pagination', 'limit must be 1-100', [{ field: 'limit', code: 'invalid' }]); return; }
    const expected = { actor: actor.id, route, scope, filters };
    const after = readCursor(cursorSecret, search.get('cursor'), expected);
    if (after === false) { fail(res, 400, 'invalid_cursor', 'cursor is invalid for this query', [{ field: 'cursor', code: 'invalid' }]); return; }
    rows.sort((left, right) => parseInstant(right.startAt) - parseInstant(left.startAt) || right.id.localeCompare(left.id));
    if (after) rows = rows.filter(item => item.startAt < after[0] || (item.startAt === after[0] && item.id.localeCompare(after[1]) < 0));
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit);
    const nextCursor = hasMore ? cursorToken(cursorSecret, { v: 1, ...expected, after: [selected.at(-1).startAt, selected.at(-1).id] }) : null;
    json(res, 200, appointmentPage({ db, actor, rows: selected, limit, hasMore, nextCursor, relationship, nowMs: now() }));
  };
  const listAppointments = (req, res, actor, route, scope, baseRows, relationship = null) => {
    if (throttle(req, res, actor, 'read')) return;
    const search = new URL(req.url, 'http://x').searchParams;
    const filters = validateListFilters(search);
    if (filters.error) { fail(res, 400, 'invalid_filter', 'invalid appointment filter', [{ field: filters.error[0], code: filters.error[1] }]); return; }
    const filtered = baseRows.filter(item => (!filters.status || item.status === filters.status)
      && (!filters.from || parseInstant(item.startAt) >= parseInstant(filters.from))
      && (!filters.to || parseInstant(item.startAt) <= parseInstant(filters.to))
      && (!filters.coachId || item.coachId === filters.coachId)
      && (!filters.linkId || item.linkId === filters.linkId));
    pageRows(req, res, actor, route, scope, filtered, cursorFilters(search, ['status', 'from', 'to', 'coachId', 'linkId']), relationship);
  };
  const detail = (req, res, actor) => {
    if (throttle(req, res, actor, 'read')) return;
    const appointment = findParticipantAppointment(actor, req.appointmentId);
    if (!appointment) return fail(res, 404, 'appointment_not_found', 'appointment not found');
    json(res, 200, { appointment: serializeAppointment(db, appointment, actor, now()) });
  };
  const reschedule = async (req, res, actor) => {
    const existing = findParticipantAppointment(actor, req.appointmentId);
    if (!existing) return fail(res, 404, 'appointment_not_found', 'appointment not found');
    const link = db.coachAthleteLinks.find(item => item.id === existing.linkId);
    if (!link || link.status !== 'active' || !link.scopes.includes('training')) return fail(res, 403, 'relationship_inactive', 'active training relationship required');
    if (existing.status !== 'scheduled') return fail(res, 409, 'invalid_transition', 'only scheduled appointments can be rescheduled');
    const body = await readBody(req);
    const payload = validateReschedulePayload(body, existing.durationMinutes);
    if (!payload) return fail(res, 400, 'invalid_reschedule', 'reschedule requires only a valid startAt and optional matching endAt');
    if (throttle(req, res, actor, 'mutation')) return;
    const availability = availabilityFor(existing.coachId);
    if (!availability) return fail(res, 400, 'coach_availability_not_configured', 'coach availability is not configured');
    const problem = validateBooking(availability, payload, existing.coachId, existing.athleteId, existing.id);
    if (problem) return fail(res, problem.status, problem.code, problem.message);
    const candidate = clone(db);
    const target = candidate.coachAppointments.find(item => item.id === existing.id);
    target.startAt = payload.startAt;
    target.endAt = payload.endAt;
    target.timeZone = availability.timeZone;
    target.localDate = getZonedParts(payload.startMs, availability.timeZone).dateStr;
    target.updatedAt = iso(now());
    reconcileAppointmentReminders(candidate, target, now());
    try { commit(candidate); } catch { return fail(res, 503, 'storage_unavailable', 'appointment could not be rescheduled'); }
    audit(req, 'b2b2c.appointment.reschedule', { user: actor, msg: target.id });
    json(res, 200, { appointment: serializeAppointment(db, db.coachAppointments.find(item => item.id === target.id), actor, now()) });
  };
  const cancel = async (req, res, actor, role) => {
    const existing = findParticipantAppointment(actor, req.appointmentId);
    if (!existing || existing[`${role}Id`] !== actor.id) return fail(res, 404, 'appointment_not_found', 'appointment not found');
    const link = db.coachAthleteLinks.find(item => item.id === existing.linkId);
    if (!link || link.status !== 'active' || !link.scopes.includes('training')) return fail(res, 403, 'relationship_inactive', 'active training relationship required');
    const body = await readBody(req);
    if (!allowedKeys(body, new Set(['reason'])) || typeof body.reason !== 'string' || !body.reason.trim() || body.reason.trim().length > 500) return fail(res, 400, 'invalid_cancel', 'cancel requires a reason');
    if (existing.status === 'canceled') return json(res, 200, { appointment: serializeAppointment(db, existing, actor, now()) });
    if (existing.status !== 'scheduled' || parseInstant(existing.endAt) <= now()) return fail(res, 409, 'invalid_transition', 'ended or terminal appointments cannot be canceled');
    if (throttle(req, res, actor, 'status')) return;
    const candidate = clone(db);
    const target = candidate.coachAppointments.find(item => item.id === existing.id);
    const nowMs = now();
    target.status = 'canceled';
    target.cancellation = { actor: role, actorId: actor.id, reason: body.reason.trim(), canceledAt: iso(nowMs) };
    target.updatedAt = iso(nowMs);
    cancelReminderState(candidate, target.id, target.updatedAt);
    try { commit(candidate); } catch { return fail(res, 503, 'storage_unavailable', 'appointment could not be canceled'); }
    audit(req, `b2b2c.appointment.${role}-cancel`, { user: actor, msg: target.id });
    json(res, 200, { appointment: serializeAppointment(db, db.coachAppointments.find(item => item.id === target.id), actor, now()) });
  };

  return {
    'GET /api/coach/availability': async (req, res) => {
      const coach = coachOnly(req, res); if (!coach) return;
      if (throttle(req, res, coach, 'read')) return;
      const availability = availabilityFor(coach.id);
      json(res, 200, { availability: availability ? clone(availability) : null });
    },
    'PUT /api/coach/availability': async (req, res) => {
      const coach = coachOnly(req, res); if (!coach) return;
      const parsed = validateAvailabilityInput(await readBody(req));
      if (!parsed) return fail(res, 400, 'invalid_availability', 'invalid availability configuration');
      if (throttle(req, res, coach, 'mutation')) return;
      const existing = availabilityFor(coach.id);
      if (existing && parsed._rev === undefined) return fail(res, 400, 'revision_required', '_rev is required for availability updates', [{ field: '_rev', code: 'required' }]);
      if (existing && parsed._rev !== existing._rev) return fail(res, 409, 'revision_conflict', 'availability revision conflict', [{ field: '_rev', code: 'stale' }]);
      if (!existing && parsed._rev !== undefined && parsed._rev !== 0) return fail(res, 409, 'revision_conflict', 'new availability must use revision 0');
      const candidate = clone(db);
      const index = candidate.coachAvailability.findIndex(item => item.coachId === coach.id);
      const nowIso = iso(now());
      const next = {
        id: existing?.id || makeEntityId('cavl', candidate.coachAvailability), coachId: coach.id,
        timeZone: parsed.timeZone, sessionDurationMinutes: parsed.sessionDurationMinutes,
        bufferMinutes: parsed.bufferMinutes, minNoticeHours: parsed.minNoticeHours,
        maxAdvanceDays: parsed.maxAdvanceDays, windows: parsed.windows, exceptions: parsed.exceptions,
        _rev: (existing?._rev || 0) + 1, createdAt: existing?.createdAt || nowIso, updatedAt: nowIso,
      };
      if (index >= 0) candidate.coachAvailability[index] = next; else candidate.coachAvailability.push(next);
      const futureConflicts = candidate.coachAppointments.filter(item => item.coachId === coach.id && item.status === 'scheduled' && parseInstant(item.startAt) >= now()
        && !isWithinAvailabilityWindows(parseInstant(item.startAt), parseInstant(item.endAt), next, item.durationMinutes)).map(item => item.id);
      try { commit(candidate); } catch { return fail(res, 503, 'storage_unavailable', 'availability could not be saved'); }
      audit(req, 'b2b2c.availability.update', { user: coach, msg: next.id });
      json(res, 200, { availability: clone(next), futureConflicts });
    },
    'GET /api/coach/appointments': async (req, res) => {
      const coach = coachOnly(req, res); if (!coach) return;
      listAppointments(req, res, coach, 'coach-appointments', 'all', db.coachAppointments.filter(item => item.coachId === coach.id));
    },
    'GET /api/coach/athletes/{athleteId}/appointments': async (req, res) => {
      const coach = coachOnly(req, res); if (!coach) return;
      const access = resolveLink(coach.id, req.athleteId, req, null, false);
      if (!access.ok) return accessFailure(req, res, coach, 'b2b2c.appointment.list.denied', access);
      listAppointments(req, res, coach, 'coach-athlete-appointments', access.link.id,
        db.coachAppointments.filter(item => item.linkId === access.link.id), { linkId: access.link.id, status: access.link.status });
    },
    'GET /api/coach/athletes/{athleteId}/availability-slots': async (req, res) => {
      const coach = coachOnly(req, res); if (!coach) return;
      const access = resolveLink(coach.id, req.athleteId, req, null, true);
      if (!access.ok) return accessFailure(req, res, coach, 'b2b2c.slots.list.denied', access);
      if (throttle(req, res, coach, 'read')) return;
      const availability = availabilityFor(coach.id);
      if (!availability) return json(res, 200, { items: [], timeZone: 'UTC', relationship: { linkId: access.link.id, status: access.link.status } });
      const search = new URL(req.url, 'http://x').searchParams;
      const from = search.get('from') || search.get('date');
      const to = search.get('to') || search.get('date');
      if ((from && !parseDate(from)) || (to && !parseDate(to)) || (from && to && from > to)) return fail(res, 400, 'invalid_date', 'slot dates must be valid YYYY-MM-DD values');
      const items = calculateAvailabilitySlots({ availability, appointments: db.coachAppointments, athleteId: req.athleteId, nowMs: now(), fromDate: from, toDate: to });
      json(res, 200, { items, timeZone: availability.timeZone, relationship: { linkId: access.link.id, status: access.link.status } });
    },
    'POST /api/coach/athletes/{athleteId}/appointments': async (req, res) => {
      const coach = coachOnly(req, res); if (!coach) return;
      const body = await readBody(req);
      const access = resolveLink(coach.id, req.athleteId, req, body, true);
      if (!access.ok) return accessFailure(req, res, coach, 'b2b2c.appointment.create.denied', access);
      const availability = availabilityFor(coach.id);
      if (!availability) return fail(res, 400, 'coach_availability_not_configured', 'coach availability is not configured');
      const payload = validateAppointmentPayload(body, { defaultDuration: availability.sessionDurationMinutes });
      if (!payload) return fail(res, 400, 'invalid_appointment', 'invalid appointment data');
      if (throttle(req, res, coach, 'mutation')) return;
      const problem = validateBooking(availability, payload, coach.id, req.athleteId);
      if (problem) return fail(res, problem.status, problem.code, problem.message);
      const candidate = clone(db);
      if (!appointmentQuota(candidate, access.link.id)) return fail(res, 409, 'appointment_capacity', 'active appointment capacity reached');
      const appointment = createAppointment(candidate, access.link, payload, iso(now()));
      try { commit(candidate); } catch { return fail(res, 503, 'storage_unavailable', 'appointment could not be saved'); }
      audit(req, 'b2b2c.appointment.create', { user: coach, msg: appointment.id });
      json(res, 201, { appointment: serializeAppointment(db, db.coachAppointments.find(item => item.id === appointment.id), coach, now()) });
    },
    'GET /api/coach/appointments/{appointmentId}': async (req, res) => { const coach = coachOnly(req, res); if (coach) detail(req, res, coach); },
    'PATCH /api/coach/appointments/{appointmentId}': async (req, res) => {
      const coach = coachOnly(req, res); if (!coach) return;
      const appointment = findParticipantAppointment(coach, req.appointmentId);
      if (!appointment || appointment.coachId !== coach.id) return fail(res, 404, 'appointment_not_found', 'appointment not found');
      fail(res, 405, 'action_required', 'use explicit reschedule, cancel, or attendance actions');
    },
    'POST /api/coach/appointments/{appointmentId}/reschedule': async (req, res) => { const coach = coachOnly(req, res); if (coach) await reschedule(req, res, coach); },
    'POST /api/coach/appointments/{appointmentId}/cancel': async (req, res) => { const coach = coachOnly(req, res); if (coach) await cancel(req, res, coach, 'coach'); },
    'POST /api/coach/appointments/{appointmentId}/attendance': async (req, res) => {
      const coach = coachOnly(req, res); if (!coach) return;
      const existing = findParticipantAppointment(coach, req.appointmentId);
      if (!existing || existing.coachId !== coach.id) return fail(res, 404, 'appointment_not_found', 'appointment not found');
      const link = db.coachAthleteLinks.find(item => item.id === existing.linkId);
      if (!link || link.status !== 'active' || !link.scopes.includes('training')) return fail(res, 403, 'relationship_inactive', 'attendance requires an active training relationship');
      if (existing.status !== 'scheduled') return fail(res, 409, 'attendance_immutable', 'attendance is already terminal');
      if (now() < parseInstant(existing.endAt)) return fail(res, 400, 'session_not_ended', 'attendance can only be recorded after session end');
      const body = await readBody(req);
      if (!allowedKeys(body, new Set(['status'])) || !['completed', 'no_show'].includes(body.status)) return fail(res, 400, 'invalid_attendance', 'status must be completed or no_show');
      if (throttle(req, res, coach, 'status')) return;
      const candidate = clone(db);
      const target = candidate.coachAppointments.find(item => item.id === existing.id);
      const nowIso = iso(now());
      target.status = body.status;
      target.attendance = { state: body.status === 'completed' ? 'attended' : 'missed', recordedBy: coach.id, recordedAt: nowIso };
      target.updatedAt = nowIso;
      cancelReminderState(candidate, target.id, nowIso);
      try { commit(candidate); } catch { return fail(res, 503, 'storage_unavailable', 'attendance could not be saved'); }
      audit(req, 'b2b2c.appointment.attendance', { user: coach, msg: `${target.id}:${body.status}` });
      json(res, 200, { appointment: serializeAppointment(db, db.coachAppointments.find(item => item.id === target.id), coach, now()) });
    },
    'GET /api/athlete/coaches/{coachId}/availability-slots': async (req, res) => {
      const athlete = athleteOnly(req, res); if (!athlete) return;
      const access = resolveLink(req.coachId, athlete.id, req, null, true);
      if (!access.ok) return accessFailure(req, res, athlete, 'b2b2c.slots.list.denied', access);
      if (throttle(req, res, athlete, 'read')) return;
      const availability = availabilityFor(req.coachId);
      if (!availability) return json(res, 200, { items: [], timeZone: 'UTC', relationship: { linkId: access.link.id, status: access.link.status } });
      const search = new URL(req.url, 'http://x').searchParams;
      const from = search.get('from') || search.get('date');
      const to = search.get('to') || search.get('date');
      if ((from && !parseDate(from)) || (to && !parseDate(to)) || (from && to && from > to)) return fail(res, 400, 'invalid_date', 'slot dates must be valid YYYY-MM-DD values');
      const items = calculateAvailabilitySlots({ availability, appointments: db.coachAppointments, athleteId: athlete.id, nowMs: now(), fromDate: from, toDate: to });
      json(res, 200, { items, timeZone: availability.timeZone, relationship: { linkId: access.link.id, status: access.link.status } });
    },
    'GET /api/athlete/appointments': async (req, res) => {
      const athlete = athleteOnly(req, res); if (!athlete) return;
      listAppointments(req, res, athlete, 'athlete-appointments', 'all', db.coachAppointments.filter(item => item.athleteId === athlete.id));
    },
    'GET /api/athlete/coaches/{coachId}/appointments': async (req, res) => {
      const athlete = athleteOnly(req, res); if (!athlete) return;
      const access = resolveLink(req.coachId, athlete.id, req, null, false);
      if (!access.ok) return accessFailure(req, res, athlete, 'b2b2c.appointment.list.denied', access);
      listAppointments(req, res, athlete, 'athlete-coach-appointments', access.link.id,
        db.coachAppointments.filter(item => item.linkId === access.link.id), { linkId: access.link.id, status: access.link.status });
    },
    'POST /api/athlete/coaches/{coachId}/appointments': async (req, res) => {
      const athlete = athleteOnly(req, res); if (!athlete) return;
      const body = await readBody(req);
      const access = resolveLink(req.coachId, athlete.id, req, body, true);
      if (!access.ok) return accessFailure(req, res, athlete, 'b2b2c.appointment.athlete-create.denied', access);
      const availability = availabilityFor(req.coachId);
      if (!availability) return fail(res, 400, 'coach_availability_not_configured', 'coach availability is not configured');
      const payload = validateAppointmentPayload(body, { defaultDuration: availability.sessionDurationMinutes });
      if (!payload) return fail(res, 400, 'invalid_appointment', 'invalid appointment data');
      if (throttle(req, res, athlete, 'mutation')) return;
      const problem = validateBooking(availability, payload, req.coachId, athlete.id);
      if (problem) return fail(res, problem.status, problem.code, problem.message);
      const candidate = clone(db);
      if (!appointmentQuota(candidate, access.link.id)) return fail(res, 409, 'appointment_capacity', 'active appointment capacity reached');
      const appointment = createAppointment(candidate, access.link, payload, iso(now()));
      try { commit(candidate); } catch { return fail(res, 503, 'storage_unavailable', 'appointment could not be saved'); }
      audit(req, 'b2b2c.appointment.athlete-create', { user: athlete, msg: appointment.id });
      json(res, 201, { appointment: serializeAppointment(db, db.coachAppointments.find(item => item.id === appointment.id), athlete, now()) });
    },
    'GET /api/athlete/appointments/{appointmentId}': async (req, res) => { const athlete = athleteOnly(req, res); if (athlete) detail(req, res, athlete); },
    'POST /api/athlete/appointments/{appointmentId}/reschedule': async (req, res) => { const athlete = athleteOnly(req, res); if (athlete) await reschedule(req, res, athlete); },
    'POST /api/athlete/appointments/{appointmentId}/cancel': async (req, res) => { const athlete = athleteOnly(req, res); if (athlete) await cancel(req, res, athlete, 'athlete'); },
    'GET /api/scheduling/reminder-preferences': async (req, res) => {
      const actor = actorOnly(req, res); if (!actor) return;
      if (throttle(req, res, actor, 'read')) return;
      const preference = db.schedulingReminderPreferences.find(item => item.userId === actor.id)
        || { userId: actor.id, enabled: false, offsetsMinutes: [60], timeZone: 'UTC', updatedAt: null };
      const states = db.appointmentReminderStates.filter(item => item.userId === actor.id).map(clone);
      json(res, 200, { preferences: clone(preference), appointmentReminderStates: states });
    },
    'PUT /api/scheduling/reminder-preferences': async (req, res) => {
      const actor = actorOnly(req, res); if (!actor) return;
      const parsed = validateReminderPreference(await readBody(req));
      if (!parsed) return fail(res, 400, 'invalid_reminder_preferences', 'invalid reminder preferences');
      if (throttle(req, res, actor, 'mutation')) return;
      const candidate = clone(db);
      const nowMs = now();
      const preference = { userId: actor.id, ...parsed, updatedAt: iso(nowMs) };
      const index = candidate.schedulingReminderPreferences.findIndex(item => item.userId === actor.id);
      if (index >= 0) candidate.schedulingReminderPreferences[index] = preference; else candidate.schedulingReminderPreferences.push(preference);
      for (const appointment of candidate.coachAppointments.filter(item => item.status === 'scheduled' && (item.coachId === actor.id || item.athleteId === actor.id))) {
        reconcileAppointmentReminders(candidate, appointment, nowMs);
      }
      try { commit(candidate); } catch { return fail(res, 503, 'storage_unavailable', 'reminder preferences could not be saved'); }
      audit(req, 'b2b2c.scheduling.reminder-preferences.update', { user: actor, msg: String(parsed.enabled) });
      json(res, 200, { preferences: clone(preference) });
    },
  };
}
