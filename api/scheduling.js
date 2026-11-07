import { createWindow } from './rate-limit.js';

const ID_RE = /^[A-Za-z0-9_-]{1,120}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const APPOINTMENT_TYPES = new Set(['in_person', 'online']);
const APPOINTMENT_STATUSES = new Set(['scheduled', 'completed', 'canceled', 'no_show']);
const ATTENDANCE_STATUSES = new Set(['attended', 'missed']);

export const SCHEDULING_LIMITS = Object.freeze({
  maxAppointmentsPerLink: 500,
  maxAppointments: 50000,
  appointmentRetentionDays: 730,
  minSessionDurationMinutes: 15,
  maxSessionDurationMinutes: 480,
  minBufferMinutes: 0,
  maxBufferMinutes: 240,
  minNoticeHoursMax: 720,
  maxAdvanceDaysMax: 365,
});

const record = value => !!value && typeof value === 'object' && !Array.isArray(value);
const validId = value => typeof value === 'string' && ID_RE.test(value);
const clone = value => structuredClone(value);

const encodeCursor = values => Buffer.from(JSON.stringify(values)).toString('base64url');
function parseCursor(value, validate) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    return validate(parsed) ? parsed : false;
  } catch {
    return false;
  }
}

const appointmentCursor = item => encodeCursor([item.startAt, item.id]);
const parseAppointmentCursor = value => parseCursor(value, parsed => Array.isArray(parsed)
  && parsed.length === 2 && typeof parsed[0] === 'string' && typeof parsed[1] === 'string');

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
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

export function formatMinutes(totalMin) {
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function getZonedParts(timestampMs, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(timestampMs)).map(p => [p.type, p.value]));
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dayOfWeek = weekdayMap[parts.weekday];
  const hour = parts.hour === '24' ? '00' : parts.hour.padStart(2, '0');
  const minute = parts.minute.padStart(2, '0');
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    dayOfWeek,
    timeStr: `${hour}:${minute}`,
    dateStr: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

export function zonedTimeToUtcMs(dateStr, timeStr, timeZone) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const [hour, minute] = timeStr.split(':').map(Number);
  let utc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  for (let i = 0; i < 3; i++) {
    const zoned = getZonedParts(utc, timeZone);
    const targetMin = hour * 60 + minute;
    const zonedMin = Number(zoned.timeStr.slice(0, 2)) * 60 + Number(zoned.timeStr.slice(3, 5));
    const dayDiff = (Date.UTC(year, month - 1, day) - Date.UTC(zoned.year, zoned.month - 1, zoned.day)) / 86400000;
    const diffMin = (dayDiff * 1440) + (targetMin - zonedMin);
    if (diffMin === 0) break;
    utc += diffMin * 60000;
  }
  return utc;
}

export function shiftDayString(dateStr, days) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return d.toISOString().slice(0, 10);
}

export function validateWindow(window) {
  if (!record(window)) return null;
  const dayOfWeek = window.dayOfWeek ?? window.day;
  if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) return null;
  if (typeof window.start !== 'string' || !TIME_RE.test(window.start)) return null;
  if (typeof window.end !== 'string' || !TIME_RE.test(window.end)) return null;
  const startMin = parseMinutes(window.start);
  const endMin = parseMinutes(window.end);
  if (startMin === null || endMin === null || startMin >= endMin) return null;
  return { dayOfWeek, start: window.start, end: window.end };
}

export function validateWindowsList(windows) {
  if (!Array.isArray(windows) || windows.length > 50) return null;
  const normalized = [];
  const byDay = new Map();
  for (const item of windows) {
    const valid = validateWindow(item);
    if (!valid) return null;
    normalized.push(valid);
    const list = byDay.get(valid.dayOfWeek) || [];
    list.push(valid);
    byDay.set(valid.dayOfWeek, list);
  }
  for (const [, list] of byDay) {
    list.sort((left, right) => parseMinutes(left.start) - parseMinutes(right.start));
    for (let i = 0; i < list.length - 1; i++) {
      if (parseMinutes(list[i].end) > parseMinutes(list[i + 1].start)) return null;
    }
  }
  return normalized;
}

export function validateAvailabilityInput(body) {
  if (!record(body)) return null;
  const raw = body.availability && record(body.availability) ? body.availability : body;
  const timezone = raw.timezone ?? raw.timeZone ?? 'America/Sao_Paulo';
  if (!validTimeZone(timezone)) return null;

  const sessionDurationMinutes = raw.sessionDurationMinutes ?? raw.durationMinutes ?? raw.defaultDurationMinutes ?? 60;
  if (!Number.isInteger(sessionDurationMinutes)
      || sessionDurationMinutes < SCHEDULING_LIMITS.minSessionDurationMinutes
      || sessionDurationMinutes > SCHEDULING_LIMITS.maxSessionDurationMinutes) {
    return null;
  }

  const bufferMinutes = raw.bufferMinutes ?? 0;
  if (!Number.isInteger(bufferMinutes)
      || bufferMinutes < SCHEDULING_LIMITS.minBufferMinutes
      || bufferMinutes > SCHEDULING_LIMITS.maxBufferMinutes) {
    return null;
  }

  const minNoticeHours = raw.minNoticeHours ?? 2;
  if (!Number.isInteger(minNoticeHours) || minNoticeHours < 0
      || minNoticeHours > SCHEDULING_LIMITS.minNoticeHoursMax) {
    return null;
  }

  const maxAdvanceDays = raw.maxAdvanceDays ?? 30;
  if (!Number.isInteger(maxAdvanceDays) || maxAdvanceDays < 1
      || maxAdvanceDays > SCHEDULING_LIMITS.maxAdvanceDaysMax) {
    return null;
  }

  const windows = validateWindowsList(raw.windows ?? []);
  if (!windows) return null;

  return {
    timezone,
    sessionDurationMinutes,
    bufferMinutes,
    minNoticeHours,
    maxAdvanceDays,
    windows,
  };
}

export function validateAppointmentPayload(body, { defaultDuration = 60 } = {}) {
  if (!record(body)) return null;
  const raw = body.appointment && record(body.appointment) ? body.appointment : body;
  const type = raw.type ?? 'in_person';
  if (!APPOINTMENT_TYPES.has(type)) return null;

  const title = typeof raw.title === 'string' ? raw.title.trim().slice(0, 120) : 'Sessão';
  if (!title) return null;

  const notes = typeof raw.notes === 'string' ? raw.notes.trim().slice(0, 1000) : '';
  const location = typeof raw.location === 'string' ? raw.location.trim().slice(0, 200) || null : null;
  const meetingUrl = typeof raw.meetingUrl === 'string' ? raw.meetingUrl.trim().slice(0, 500) || null : null;

  if (typeof raw.startAt !== 'string') return null;
  const startMs = Date.parse(raw.startAt);
  if (!Number.isFinite(startMs)) return null;

  let endMs;
  if (raw.endAt !== undefined && raw.endAt !== null) {
    if (typeof raw.endAt !== 'string') return null;
    endMs = Date.parse(raw.endAt);
    if (!Number.isFinite(endMs)) return null;
  } else {
    endMs = startMs + defaultDuration * 60000;
  }

  if (startMs >= endMs) return null;

  return {
    type,
    title,
    notes,
    location,
    meetingUrl,
    startAt: new Date(startMs).toISOString(),
    endAt: new Date(endMs).toISOString(),
    startMs,
    endMs,
  };
}

export function isWithinAvailabilityWindows(startMs, endMs, availability) {
  if (!availability || !Array.isArray(availability.windows) || availability.windows.length === 0) {
    return false;
  }
  const startParts = getZonedParts(startMs, availability.timezone);
  const endParts = getZonedParts(endMs, availability.timezone);
  if (startParts.dateStr !== endParts.dateStr) return false;

  const startMin = parseMinutes(startParts.timeStr);
  const endMin = parseMinutes(endParts.timeStr);
  if (startMin === null || endMin === null || startMin >= endMin) return false;

  return availability.windows.some(window => {
    if (window.dayOfWeek !== startParts.dayOfWeek) return false;
    const wStart = parseMinutes(window.start);
    const wEnd = parseMinutes(window.end);
    return wStart !== null && wEnd !== null && wStart <= startMin && endMin <= wEnd;
  });
}

export function hasAppointmentConflict(appointments, { coachId, athleteId, startAtMs, endAtMs, bufferMinutes = 0, excludeAppointmentId = null }) {
  const bufferMs = Math.max(0, bufferMinutes) * 60000;
  for (const app of appointments || []) {
    if (app.id === excludeAppointmentId) continue;
    if (app.status === 'canceled') continue;
    const appStartMs = Date.parse(app.startAt);
    const appEndMs = Date.parse(app.endAt);
    if (!Number.isFinite(appStartMs) || !Number.isFinite(appEndMs)) continue;

    if (app.coachId === coachId) {
      if (startAtMs < appEndMs + bufferMs && endAtMs + bufferMs > appStartMs) {
        return { conflict: true, reason: 'coach_conflict', conflictingId: app.id };
      }
    }

    if (app.athleteId === athleteId) {
      if (startAtMs < appEndMs && endAtMs > appStartMs) {
        return { conflict: true, reason: 'athlete_conflict', conflictingId: app.id };
      }
    }
  }
  return { conflict: false };
}

export function calculateAvailabilitySlots({
  availability,
  appointments = [],
  athleteId = null,
  nowMs = Date.now(),
  fromDate = null,
  toDate = null,
}) {
  if (!availability || !Array.isArray(availability.windows) || availability.windows.length === 0) {
    return [];
  }
  const timezone = availability.timezone || 'America/Sao_Paulo';
  const duration = availability.sessionDurationMinutes || 60;
  const buffer = availability.bufferMinutes || 0;
  const minNoticeHours = availability.minNoticeHours ?? 2;
  const maxAdvanceDays = availability.maxAdvanceDays ?? 30;

  const minNoticeMs = nowMs + minNoticeHours * 3600000;
  const maxAdvanceMs = nowMs + maxAdvanceDays * 86400000;

  const todayStr = getZonedParts(nowMs, timezone).dateStr;
  const effectiveFrom = fromDate && fromDate >= todayStr ? fromDate : todayStr;
  const defaultTo = shiftDayString(todayStr, Math.min(maxAdvanceDays, 60));
  const effectiveTo = toDate && toDate <= defaultTo ? toDate : defaultTo;
  if (effectiveFrom > effectiveTo) return [];

  const slots = [];
  let curDate = effectiveFrom;
  while (curDate <= effectiveTo) {
    const noonMs = zonedTimeToUtcMs(curDate, '12:00', timezone);
    const parts = getZonedParts(noonMs, timezone);
    const dayOfWeek = parts.dayOfWeek;
    const dayWindows = availability.windows.filter(w => w.dayOfWeek === dayOfWeek)
      .sort((a, b) => parseMinutes(a.start) - parseMinutes(b.start));

    for (const window of dayWindows) {
      const wStart = parseMinutes(window.start);
      const wEnd = parseMinutes(window.end);
      if (wStart === null || wEnd === null) continue;

      let currentMin = wStart;
      while (currentMin + duration <= wEnd) {
        const slotStartStr = formatMinutes(currentMin);
        const slotEndStr = formatMinutes(currentMin + duration);
        const slotStartMs = zonedTimeToUtcMs(curDate, slotStartStr, timezone);
        const slotEndMs = zonedTimeToUtcMs(curDate, slotEndStr, timezone);

        if (slotStartMs >= minNoticeMs && slotStartMs <= maxAdvanceMs) {
          const conflict = hasAppointmentConflict(appointments, {
            coachId: availability.coachId,
            athleteId,
            startAtMs: slotStartMs,
            endAtMs: slotEndMs,
            bufferMinutes: buffer,
          });
          if (!conflict.conflict) {
            slots.push({
              startAt: new Date(slotStartMs).toISOString(),
              endAt: new Date(slotEndMs).toISOString(),
              durationMinutes: duration,
            });
          }
        }
        currentMin += duration + buffer;
      }
    }
    curDate = shiftDayString(curDate, 1);
  }
  return slots;
}

export function validateSchedulingState(db) {
  if (!Array.isArray(db.coachAvailability) || !Array.isArray(db.coachAppointments)) {
    throw new Error('scheduling collections must be arrays');
  }
  const coachIds = new Set();
  for (const item of db.coachAvailability) {
    if (!record(item) || typeof item.coachId !== 'string' || !validId(item.coachId) || coachIds.has(item.coachId)) {
      throw new Error('coachAvailability contains an invalid record or duplicate coach');
    }
    coachIds.add(item.coachId);
    if (!validTimeZone(item.timezone)) throw new Error('coachAvailability contains an invalid timezone');
    if (!Number.isInteger(item.sessionDurationMinutes) || item.sessionDurationMinutes < 15) {
      throw new Error('coachAvailability contains invalid session duration');
    }
    if (!validateWindowsList(item.windows)) throw new Error('coachAvailability contains invalid windows');
  }

  const appointmentIds = new Set();
  for (const item of db.coachAppointments) {
    if (!record(item) || typeof item.id !== 'string' || !validId(item.id) || appointmentIds.has(item.id)
        || typeof item.coachId !== 'string' || typeof item.athleteId !== 'string'
        || typeof item.linkId !== 'string' || !APPOINTMENT_TYPES.has(item.type)
        || !APPOINTMENT_STATUSES.has(item.status)
        || (item.attendance !== null && !ATTENDANCE_STATUSES.has(item.attendance))
        || (item.canceledBy !== null && !['coach', 'athlete', 'system'].includes(item.canceledBy))) {
      throw new Error('coachAppointments contains an invalid record');
    }
    appointmentIds.add(item.id);
    const startMs = Date.parse(item.startAt);
    const endMs = Date.parse(item.endAt);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) {
      throw new Error('coachAppointments contains invalid timestamps');
    }
  }
  return true;
}

export function migrateSchedulingState(db) {
  let changed = false;
  for (const key of ['coachAvailability', 'coachAppointments']) {
    if (db[key] === undefined) { db[key] = []; changed = true; }
    else if (!Array.isArray(db[key])) throw new Error(`${key} must be an array`);
  }
  validateSchedulingState(db);
  return changed;
}

export function compactSchedulingState(db, limits = SCHEDULING_LIMITS, nowMs = Date.now()) {
  db.coachAvailability ||= [];
  db.coachAppointments ||= [];
  let changed = false;
  const cutoff = nowMs - (limits.appointmentRetentionDays ?? 730) * 86400000;
  const initialLength = db.coachAppointments.length;
  db.coachAppointments = db.coachAppointments.filter(app => {
    if (app.status === 'scheduled') return true;
    const endMs = Date.parse(app.endAt || app.updatedAt);
    return !Number.isFinite(endMs) || endMs >= cutoff;
  });
  if (db.coachAppointments.length !== initialLength) changed = true;
  return { changed, appointments: db.coachAppointments.length, availability: db.coachAvailability.length };
}

export function removeSchedulingUser(db, userId) {
  if (Array.isArray(db.coachAvailability)) {
    db.coachAvailability = db.coachAvailability.filter(item => item.coachId !== userId);
  }
  if (Array.isArray(db.coachAppointments)) {
    db.coachAppointments = db.coachAppointments.filter(item => item.coachId !== userId && item.athleteId !== userId);
  }
}

export function cancelFutureAppointmentsForLink(db, linkId, reason = 'relationship_ended', actorId = null) {
  let changed = false;
  const now = new Date().toISOString();
  for (const app of db.coachAppointments || []) {
    if (app.linkId === linkId && app.status === 'scheduled') {
      app.status = 'canceled';
      app.canceledBy = 'system';
      app.cancelReason = reason;
      app.updatedAt = now;
      changed = true;
    }
  }
  return changed;
}

export function createSchedulingRoutes(context) {
  const {
    audit, auditDenied, b2bError, db, json, limitAddress, limits: configuredLimits = {},
    makeEntityId, profileOf, readBody, readSession, rate = {}, saveDb, publishDb, commitCandidate,
    now = () => Date.now(),
  } = context;

  const limits = { ...SCHEDULING_LIMITS, ...configuredLimits };

  const windows = {
    mutation: {
      account: createWindow({ max: rate.schedulingMutationAccount || rate.mutationAccount || 60, windowMs: rate.windowMs || 3600000 }),
      ip: createWindow({ max: rate.schedulingMutationIp || rate.mutationIp || 300, windowMs: rate.windowMs || 3600000 }),
    },
    status: {
      account: createWindow({ max: rate.schedulingStatusAccount || 120, windowMs: rate.windowMs || 3600000 }),
      ip: createWindow({ max: rate.schedulingStatusIp || 600, windowMs: rate.windowMs || 3600000 }),
    },
  };

  const sweepTimer = setInterval(() => {
    windows.mutation.account.sweep();
    windows.mutation.ip.sweep();
    windows.status.account.sweep();
    windows.status.ip.sweep();
  }, Math.min(rate.windowMs || 3600000, 60000)).unref();

  const throttle = (req, res, user, kind = 'mutation') => {
    const bucket = windows[kind] || windows.mutation;
    const wait = Math.max(bucket.account.take(user.id), bucket.ip.take(limitAddress(req)));
    if (!wait) return false;
    auditDenied(req, `b2b2c.scheduling.${kind}.throttled`, user, 'rate_limited');
    b2bError(res, 429, 'rate_limited', `too many scheduling attempts, try again later`, { 'Retry-After': String(wait) });
    return true;
  };

  const commit = candidate => {
    validateSchedulingState(candidate);
    if (typeof commitCandidate === 'function') {
      commitCandidate(candidate);
    } else {
      saveDb(candidate);
      if (typeof publishDb === 'function') publishDb(candidate);
    }
  };

  const coachOnly = (req, res) => {
    const coach = readSession(req);
    if (!coach) { b2bError(res, 401, 'not_signed_in', 'not signed in'); return null; }
    if (profileOf(coach).kind !== 'coach') {
      b2bError(res, 403, 'role_forbidden', 'professional profile required');
      return null;
    }
    return coach;
  };

  const athleteOnly = (req, res) => {
    const athlete = readSession(req);
    if (!athlete) { b2bError(res, 401, 'not_signed_in', 'not signed in'); return null; }
    if (profileOf(athlete).kind === 'coach') {
      b2bError(res, 403, 'role_forbidden', 'athlete profile required');
      return null;
    }
    return athlete;
  };

  const resolveLink = (coachId, athleteId, { requireActive = true } = {}) => {
    const link = (db.coachAthleteLinks || []).find(l => l.coachId === coachId && l.athleteId === athleteId);
    if (!link) return { ok: false, code: 'relationship_not_found', status: 404, message: 'relationship not found' };
    if (requireActive && link.status !== 'active') {
      return { ok: false, code: 'relationship_inactive', status: 403, message: 'active relationship required' };
    }
    return { ok: true, link };
  };

  return {
    'GET /api/coach/availability': async (req, res) => {
      const coach = coachOnly(req, res);
      if (!coach) return;
      const stored = (db.coachAvailability || []).find(a => a.coachId === coach.id);
      json(res, 200, { availability: stored ? clone(stored) : null });
    },

    'PUT /api/coach/availability': async (req, res) => {
      const coach = coachOnly(req, res);
      if (!coach) return;
      const body = await readBody(req);
      const validated = validateAvailabilityInput(body);
      if (!validated) {
        return b2bError(res, 400, 'invalid_availability', 'invalid availability configuration');
      }
      if (throttle(req, res, coach, 'mutation')) return;

      const candidate = clone(db);
      candidate.coachAvailability ||= [];
      const nowIso = new Date(now()).toISOString();
      const existingIdx = candidate.coachAvailability.findIndex(a => a.coachId === coach.id);
      const record = {
        id: existingIdx >= 0 ? candidate.coachAvailability[existingIdx].id : makeEntityId('cavl', candidate.coachAvailability),
        coachId: coach.id,
        ...validated,
        createdAt: existingIdx >= 0 ? candidate.coachAvailability[existingIdx].createdAt : nowIso,
        updatedAt: nowIso,
      };

      if (existingIdx >= 0) candidate.coachAvailability[existingIdx] = record;
      else candidate.coachAvailability.push(record);

      try {
        commit(candidate);
      } catch {
        return b2bError(res, 503, 'storage_unavailable', 'availability could not be saved');
      }

      audit(req, 'b2b2c.availability.update', { user: coach, msg: record.id });
      json(res, 200, { availability: clone(record) });
    },

    'GET /api/coach/athletes/{athleteId}/appointments': async (req, res) => {
      const coach = coachOnly(req, res);
      if (!coach) return;
      const athleteId = req.athleteId;
      const access = resolveLink(coach.id, athleteId, { requireActive: false });
      if (!access.ok) {
        auditDenied(req, 'b2b2c.appointment.list.denied', coach, access.code);
        return b2bError(res, access.status, access.code, access.message);
      }

      const url = new URL(req.url, 'http://x');
      const rawLimit = url.searchParams.get('limit');
      const limit = rawLimit === null ? 50 : Number(rawLimit);
      const cursor = parseAppointmentCursor(url.searchParams.get('cursor'));
      if (!Number.isInteger(limit) || limit < 1 || limit > 100 || cursor === false) {
        return b2bError(res, 400, 'invalid_pagination', 'limit must be 1-100 and cursor must be valid');
      }

      const statusFilter = url.searchParams.get('status');
      const fromFilter = url.searchParams.get('from');
      const toFilter = url.searchParams.get('to');

      let rows = (db.coachAppointments || []).filter(item => {
        if (item.coachId !== coach.id || item.athleteId !== athleteId) return false;
        if (statusFilter && item.status !== statusFilter) return false;
        if (fromFilter && item.startAt < fromFilter) return false;
        if (toFilter && item.startAt > toFilter) return false;
        return true;
      });

      rows.sort((a, b) => Date.parse(b.startAt) - Date.parse(a.startAt) || b.id.localeCompare(a.id));

      if (cursor) {
        rows = rows.filter(item => item.startAt < cursor[0]
          || (item.startAt === cursor[0] && item.id.localeCompare(cursor[1]) < 0));
      }

      const hasMore = rows.length > limit;
      const items = rows.slice(0, limit).map(clone);
      audit(req, 'b2b2c.appointment.list', { user: coach, msg: `${access.link.id}:${items.length}` });
      json(res, 200, {
        appointments: items,
        items,
        page: { limit, hasMore, nextCursor: hasMore ? appointmentCursor(rows[limit - 1]) : null },
        relationship: { linkId: access.link.id, status: access.link.status },
      });
    },

    'POST /api/coach/athletes/{athleteId}/appointments': async (req, res) => {
      const coach = coachOnly(req, res);
      if (!coach) return;
      const athleteId = req.athleteId;
      const access = resolveLink(coach.id, athleteId, { requireActive: true });
      if (!access.ok) {
        auditDenied(req, 'b2b2c.appointment.create.denied', coach, access.code);
        return b2bError(res, access.status, access.code, access.message);
      }

      const availability = (db.coachAvailability || []).find(a => a.coachId === coach.id);
      const defaultDuration = availability?.sessionDurationMinutes || 60;
      const payload = validateAppointmentPayload(await readBody(req), { defaultDuration });
      if (!payload) {
        return b2bError(res, 400, 'invalid_appointment', 'invalid appointment data');
      }

      if (throttle(req, res, coach, 'mutation')) return;

      if (availability) {
        if (!isWithinAvailabilityWindows(payload.startMs, payload.endMs, availability)) {
          return b2bError(res, 400, 'outside_availability', 'requested appointment time is outside availability windows');
        }
      }

      const conflict = hasAppointmentConflict(db.coachAppointments, {
        coachId: coach.id,
        athleteId,
        startAtMs: payload.startMs,
        endAtMs: payload.endMs,
        bufferMinutes: availability?.bufferMinutes || 0,
      });
      if (conflict.conflict) {
        return b2bError(res, 409, 'double_booking', 'schedule conflict detected for this appointment slot');
      }

      const candidate = clone(db);
      candidate.coachAppointments ||= [];
      const pairCount = candidate.coachAppointments.filter(item => item.linkId === access.link.id).length;
      if (pairCount >= limits.maxAppointmentsPerLink || candidate.coachAppointments.length >= limits.maxAppointments) {
        return b2bError(res, 409, 'appointment_capacity', 'appointment storage capacity reached');
      }

      const nowIso = new Date(now()).toISOString();
      const appointment = {
        id: makeEntityId('capp', candidate.coachAppointments),
        linkId: access.link.id,
        coachId: coach.id,
        athleteId,
        type: payload.type,
        title: payload.title,
        notes: payload.notes,
        startAt: payload.startAt,
        endAt: payload.endAt,
        status: 'scheduled',
        canceledBy: null,
        cancelReason: null,
        location: payload.location,
        meetingUrl: payload.meetingUrl,
        attendance: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      };

      candidate.coachAppointments.push(appointment);
      try {
        commit(candidate);
      } catch {
        return b2bError(res, 503, 'storage_unavailable', 'appointment could not be saved');
      }

      audit(req, 'b2b2c.appointment.create', { user: coach, msg: appointment.id });
      json(res, 201, { appointment: clone(appointment) });
    },

    'PATCH /api/coach/appointments/{appointmentId}': async (req, res) => {
      const coach = coachOnly(req, res);
      if (!coach) return;
      const appointmentId = req.appointmentId;
      const existing = (db.coachAppointments || []).find(a => a.id === appointmentId);
      if (!existing || existing.coachId !== coach.id) {
        auditDenied(req, 'b2b2c.appointment.update.denied', coach, 'appointment_not_found');
        return b2bError(res, 404, 'appointment_not_found', 'appointment not found');
      }

      const body = await readBody(req);
      if (!record(body)) return b2bError(res, 400, 'invalid_payload', 'invalid request body');
      if (throttle(req, res, coach, 'status')) return;

      const candidate = clone(db);
      const target = candidate.coachAppointments.find(a => a.id === appointmentId);
      const nowIso = new Date(now()).toISOString();

      if (body.status === 'canceled') {
        if (target.status === 'canceled') {
          return json(res, 200, { appointment: clone(target) });
        }
        if (target.status === 'completed' || target.status === 'no_show') {
          return b2bError(res, 409, 'invalid_transition', 'cannot cancel an already concluded session');
        }
        target.status = 'canceled';
        target.canceledBy = 'coach';
        target.cancelReason = typeof body.cancelReason === 'string' ? body.cancelReason.trim().slice(0, 500) || null : null;
        target.updatedAt = nowIso;
      } else {
        if (target.status !== 'scheduled') {
          return b2bError(res, 409, 'invalid_transition', 'cannot update a completed or canceled session');
        }
        if (body.startAt !== undefined) {
          const availability = (candidate.coachAvailability || []).find(a => a.coachId === coach.id);
          const oldDurationMin = Math.round((Date.parse(target.endAt) - Date.parse(target.startAt)) / 60000);
          const duration = availability?.sessionDurationMinutes || oldDurationMin || 60;
          const payload = validateAppointmentPayload({
            ...target,
            ...body,
          }, { defaultDuration: duration });
          if (!payload) {
            return b2bError(res, 400, 'invalid_appointment', 'invalid appointment rescheduling data');
          }

          if (availability && !isWithinAvailabilityWindows(payload.startMs, payload.endMs, availability)) {
            return b2bError(res, 400, 'outside_availability', 'requested appointment time is outside availability windows');
          }

          const conflict = hasAppointmentConflict(candidate.coachAppointments, {
            coachId: coach.id,
            athleteId: target.athleteId,
            startAtMs: payload.startMs,
            endAtMs: payload.endMs,
            bufferMinutes: availability?.bufferMinutes || 0,
            excludeAppointmentId: target.id,
          });
          if (conflict.conflict) {
            return b2bError(res, 409, 'double_booking', 'schedule conflict detected for rescheduled slot');
          }

          target.startAt = payload.startAt;
          target.endAt = payload.endAt;
        }

        if (typeof body.title === 'string' && body.title.trim()) target.title = body.title.trim().slice(0, 120);
        if (typeof body.notes === 'string') target.notes = body.notes.trim().slice(0, 1000);
        if (typeof body.location === 'string') target.location = body.location.trim().slice(0, 200) || null;
        if (typeof body.meetingUrl === 'string') target.meetingUrl = body.meetingUrl.trim().slice(0, 500) || null;
        if (typeof body.type === 'string' && APPOINTMENT_TYPES.has(body.type)) target.type = body.type;
        target.updatedAt = nowIso;
      }

      try {
        commit(candidate);
      } catch {
        return b2bError(res, 503, 'storage_unavailable', 'appointment changes could not be saved');
      }

      audit(req, 'b2b2c.appointment.update', { user: coach, msg: target.id });
      json(res, 200, { appointment: clone(target) });
    },

    'POST /api/coach/appointments/{appointmentId}/attendance': async (req, res) => {
      const coach = coachOnly(req, res);
      if (!coach) return;
      const appointmentId = req.appointmentId;
      const existing = (db.coachAppointments || []).find(a => a.id === appointmentId);
      if (!existing || existing.coachId !== coach.id) {
        auditDenied(req, 'b2b2c.appointment.attendance.denied', coach, 'appointment_not_found');
        return b2bError(res, 404, 'appointment_not_found', 'appointment not found');
      }

      if (existing.status === 'canceled') {
        return b2bError(res, 409, 'appointment_canceled', 'cannot record attendance for a canceled session');
      }

      const nowMs = now();
      const endMs = Date.parse(existing.endAt);
      if (nowMs < endMs) {
        return b2bError(res, 400, 'session_not_ended', 'attendance can only be recorded after session end time');
      }

      const body = await readBody(req);
      if (!record(body)) return b2bError(res, 400, 'invalid_payload', 'invalid request body');
      if (throttle(req, res, coach, 'status')) return;

      let newStatus = null;
      let newAttendance = null;
      if (body.status === 'completed' || body.attendance === 'attended') {
        newStatus = 'completed';
        newAttendance = 'attended';
      } else if (body.status === 'no_show' || body.attendance === 'missed') {
        newStatus = 'no_show';
        newAttendance = 'missed';
      } else {
        return b2bError(res, 400, 'invalid_attendance_status', 'status must be completed or no_show');
      }

      const candidate = clone(db);
      const target = candidate.coachAppointments.find(a => a.id === appointmentId);
      target.status = newStatus;
      target.attendance = newAttendance;
      target.updatedAt = new Date(nowMs).toISOString();

      try {
        commit(candidate);
      } catch {
        return b2bError(res, 503, 'storage_unavailable', 'attendance could not be saved');
      }

      audit(req, 'b2b2c.appointment.attendance', { user: coach, msg: `${target.id}:${newStatus}` });
      json(res, 200, { appointment: clone(target) });
    },

    'GET /api/athlete/coaches/{coachId}/availability-slots': async (req, res) => {
      const athlete = athleteOnly(req, res);
      if (!athlete) return;
      const coachId = req.coachId;
      const access = resolveLink(coachId, athlete.id, { requireActive: true });
      if (!access.ok) {
        auditDenied(req, 'b2b2c.slots.list.denied', athlete, access.code);
        return b2bError(res, access.status, access.code, access.message);
      }

      const availability = (db.coachAvailability || []).find(a => a.coachId === coachId);
      if (!availability) {
        return json(res, 200, { slots: [], timezone: 'UTC' });
      }

      const url = new URL(req.url, 'http://x');
      const fromParam = url.searchParams.get('from') || url.searchParams.get('date');
      const toParam = url.searchParams.get('to') || url.searchParams.get('date');

      if (fromParam && (!DATE_RE.test(fromParam) || !Number.isFinite(Date.parse(`${fromParam}T00:00:00Z`)))) {
        return b2bError(res, 400, 'invalid_date', 'from date must be YYYY-MM-DD');
      }
      if (toParam && (!DATE_RE.test(toParam) || !Number.isFinite(Date.parse(`${toParam}T00:00:00Z`)))) {
        return b2bError(res, 400, 'invalid_date', 'to date must be YYYY-MM-DD');
      }

      const slots = calculateAvailabilitySlots({
        availability,
        appointments: db.coachAppointments || [],
        athleteId: athlete.id,
        nowMs: now(),
        fromDate: fromParam,
        toDate: toParam,
      });

      audit(req, 'b2b2c.slots.list', { user: athlete, msg: `${coachId}:${slots.length}` });
      json(res, 200, { slots, timezone: availability.timezone });
    },

    'GET /api/athlete/appointments': async (req, res) => {
      const athlete = athleteOnly(req, res);
      if (!athlete) return;

      const url = new URL(req.url, 'http://x');
      const rawLimit = url.searchParams.get('limit');
      const limit = rawLimit === null ? 50 : Number(rawLimit);
      const cursor = parseAppointmentCursor(url.searchParams.get('cursor'));
      if (!Number.isInteger(limit) || limit < 1 || limit > 100 || cursor === false) {
        return b2bError(res, 400, 'invalid_pagination', 'limit must be 1-100 and cursor must be valid');
      }

      const coachFilter = url.searchParams.get('coachId');
      const statusFilter = url.searchParams.get('status');
      const fromFilter = url.searchParams.get('from');
      const toFilter = url.searchParams.get('to');

      let rows = (db.coachAppointments || []).filter(item => {
        if (item.athleteId !== athlete.id) return false;
        if (coachFilter && item.coachId !== coachFilter) return false;
        if (statusFilter && item.status !== statusFilter) return false;
        if (fromFilter && item.startAt < fromFilter) return false;
        if (toFilter && item.startAt > toFilter) return false;
        return true;
      });

      rows.sort((a, b) => Date.parse(b.startAt) - Date.parse(a.startAt) || b.id.localeCompare(a.id));

      if (cursor) {
        rows = rows.filter(item => item.startAt < cursor[0]
          || (item.startAt === cursor[0] && item.id.localeCompare(cursor[1]) < 0));
      }

      const hasMore = rows.length > limit;
      const items = rows.slice(0, limit).map(clone);
      audit(req, 'b2b2c.appointment.athlete-list', { user: athlete, msg: String(items.length) });
      json(res, 200, {
        appointments: items,
        items,
        page: { limit, hasMore, nextCursor: hasMore ? appointmentCursor(rows[limit - 1]) : null },
      });
    },

    'POST /api/athlete/coaches/{coachId}/appointments': async (req, res) => {
      const athlete = athleteOnly(req, res);
      if (!athlete) return;
      const coachId = req.coachId;
      const access = resolveLink(coachId, athlete.id, { requireActive: true });
      if (!access.ok) {
        auditDenied(req, 'b2b2c.appointment.athlete-create.denied', athlete, access.code);
        return b2bError(res, access.status, access.code, access.message);
      }

      const availability = (db.coachAvailability || []).find(a => a.coachId === coachId);
      if (!availability) {
        return b2bError(res, 400, 'coach_availability_not_configured', 'coach has not configured availability');
      }

      const payload = validateAppointmentPayload(await readBody(req), {
        defaultDuration: availability.sessionDurationMinutes,
      });
      if (!payload) {
        return b2bError(res, 400, 'invalid_appointment', 'invalid appointment data');
      }

      if (throttle(req, res, athlete, 'mutation')) return;

      const nowMs = now();
      const minNoticeMs = nowMs + (availability.minNoticeHours ?? 2) * 3600000;
      if (payload.startMs < minNoticeMs) {
        return b2bError(res, 400, 'min_notice_violated', 'appointment does not meet minimum advance notice requirement');
      }

      const maxAdvanceMs = nowMs + (availability.maxAdvanceDays ?? 30) * 86400000;
      if (payload.startMs > maxAdvanceMs) {
        return b2bError(res, 400, 'max_advance_exceeded', 'appointment exceeds maximum advance booking horizon');
      }

      if (!isWithinAvailabilityWindows(payload.startMs, payload.endMs, availability)) {
        return b2bError(res, 400, 'outside_availability', 'requested appointment time is outside coach availability windows');
      }

      const conflict = hasAppointmentConflict(db.coachAppointments, {
        coachId,
        athleteId: athlete.id,
        startAtMs: payload.startMs,
        endAtMs: payload.endMs,
        bufferMinutes: availability.bufferMinutes || 0,
      });
      if (conflict.conflict) {
        return b2bError(res, 409, 'double_booking', 'schedule conflict detected for this appointment slot');
      }

      const candidate = clone(db);
      candidate.coachAppointments ||= [];
      const pairCount = candidate.coachAppointments.filter(item => item.linkId === access.link.id).length;
      if (pairCount >= limits.maxAppointmentsPerLink || candidate.coachAppointments.length >= limits.maxAppointments) {
        return b2bError(res, 409, 'appointment_capacity', 'appointment storage capacity reached');
      }

      const nowIso = new Date(nowMs).toISOString();
      const appointment = {
        id: makeEntityId('capp', candidate.coachAppointments),
        linkId: access.link.id,
        coachId,
        athleteId: athlete.id,
        type: payload.type,
        title: payload.title,
        notes: payload.notes,
        startAt: payload.startAt,
        endAt: payload.endAt,
        status: 'scheduled',
        canceledBy: null,
        cancelReason: null,
        location: payload.location,
        meetingUrl: payload.meetingUrl,
        attendance: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      };

      candidate.coachAppointments.push(appointment);
      try {
        commit(candidate);
      } catch {
        return b2bError(res, 503, 'storage_unavailable', 'appointment could not be saved');
      }

      audit(req, 'b2b2c.appointment.athlete-create', { user: athlete, msg: appointment.id });
      json(res, 201, { appointment: clone(appointment) });
    },

    'POST /api/athlete/appointments/{appointmentId}/cancel': async (req, res) => {
      const athlete = athleteOnly(req, res);
      if (!athlete) return;
      const appointmentId = req.appointmentId;
      const existing = (db.coachAppointments || []).find(a => a.id === appointmentId);
      if (!existing || existing.athleteId !== athlete.id) {
        auditDenied(req, 'b2b2c.appointment.cancel.denied', athlete, 'appointment_not_found');
        return b2bError(res, 404, 'appointment_not_found', 'appointment not found');
      }

      if (existing.status === 'canceled') {
        return json(res, 200, { appointment: clone(existing) });
      }

      if (existing.status === 'completed' || existing.status === 'no_show') {
        return b2bError(res, 409, 'invalid_transition', 'cannot cancel an already concluded session');
      }

      const body = await readBody(req);
      if (throttle(req, res, athlete, 'status')) return;

      const candidate = clone(db);
      const target = candidate.coachAppointments.find(a => a.id === appointmentId);
      const nowIso = new Date(now()).toISOString();

      target.status = 'canceled';
      target.canceledBy = 'athlete';
      target.cancelReason = typeof body?.cancelReason === 'string' ? body.cancelReason.trim().slice(0, 500) || null : null;
      target.updatedAt = nowIso;

      try {
        commit(candidate);
      } catch {
        return b2bError(res, 503, 'storage_unavailable', 'appointment cancellation could not be saved');
      }

      audit(req, 'b2b2c.appointment.athlete-cancel', { user: athlete, msg: target.id });
      json(res, 200, { appointment: clone(target) });
    },
  };
}
