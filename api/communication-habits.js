import { createWindow } from './rate-limit.js';

const DAY_MS = 86400000;
const ID_RE = /^[A-Za-z0-9_-]{1,120}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MESSAGE_CATEGORIES = new Set(['general', 'workout_feedback', 'nutrition_feedback']);
const HABIT_UNITS = new Set(['horas', 'passos', 'ml', 'minutos', 'vezes']);
const HABIT_FREQUENCIES = new Set(['daily', 'weekdays', 'weekends']);
const HABIT_STATUSES = new Set(['active', 'archived']);
const SUMMARY_PERIODS = new Set([7, 30, 90]);
const DEFAULT_TIME_ZONE = 'UTC';

export const COMMUNICATION_HABITS_LIMITS = Object.freeze({
  maxMessagesPerLink: 500,
  maxMessages: 50000,
  messageRetentionDays: 365,
  maxHabitsPerLink: 100,
  maxHabits: 10000,
  archivedHabitRetentionDays: 730,
  maxCheckinsPerHabit: 730,
  maxCheckinsPerLink: 5000,
  maxCheckins: 100000,
  checkinRetentionDays: 730,
});

const record = value => !!value && typeof value === 'object' && !Array.isArray(value);
const ownKeysOnly = (value, allowed) => record(value) && Object.keys(value).every(key => allowed.includes(key));
const finiteTimestamp = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
  && value <= 8640000000000000;
const validId = value => typeof value === 'string' && ID_RE.test(value);
const dayString = timestamp => new Date(timestamp).toISOString().slice(0, 10);
const clone = value => structuredClone(value);

export function normalizePlainText(value, max, { required = false } = {}) {
  if (value === undefined || value === null) return required ? null : '';
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\r\n?/g, '\n').normalize('NFC').trim();
  if ((required && !normalized) || normalized.length > max
      || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(normalized)) return null;
  return normalized;
}

export function validIsoDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

export function validTimeZone(value) {
  if (typeof value !== 'string' || !value || value.length > 100) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0); return true; }
  catch { return false; }
}

export function dateInTimeZone(timestamp = Date.now(), timeZone = DEFAULT_TIME_ZONE) {
  if (!validTimeZone(timeZone)) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function validateMessageInput(payload) {
  if (!ownKeysOnly(payload, ['category', 'content', 'refId'])) return null;
  const content = normalizePlainText(payload.content, 2000, { required: true });
  const category = payload.category === undefined ? 'general' : payload.category;
  const refId = payload.refId === undefined || payload.refId === null ? null : normalizePlainText(payload.refId, 120, { required: true });
  if (content === null || !MESSAGE_CATEGORIES.has(category) || refId === null && payload.refId !== undefined && payload.refId !== null) return null;
  if (refId !== null && !ID_RE.test(refId)) return null;
  return { content, category, refId };
}

export function validateHabitInput(payload, { partial = false } = {}) {
  const allowed = ['description', 'frequency', 'status', 'targetValue', 'title', 'unit'];
  if (!ownKeysOnly(payload, allowed) || (partial && Object.keys(payload).length === 0)) return null;
  if (!partial && !['title', 'targetValue', 'unit', 'frequency'].every(key => Object.hasOwn(payload, key))) return null;
  const out = {};
  if (Object.hasOwn(payload, 'title')) {
    out.title = normalizePlainText(payload.title, 120, { required: true });
    if (out.title === null) return null;
  }
  if (Object.hasOwn(payload, 'description')) {
    out.description = normalizePlainText(payload.description, 1000);
    if (out.description === null) return null;
  } else if (!partial) out.description = '';
  if (Object.hasOwn(payload, 'targetValue')) {
    if (typeof payload.targetValue !== 'number' || !Number.isFinite(payload.targetValue)
        || payload.targetValue <= 0 || payload.targetValue > 1000000000) return null;
    out.targetValue = payload.targetValue;
  }
  if (Object.hasOwn(payload, 'unit')) {
    if (!HABIT_UNITS.has(payload.unit)) return null;
    out.unit = payload.unit;
  }
  if (Object.hasOwn(payload, 'frequency')) {
    if (!HABIT_FREQUENCIES.has(payload.frequency)) return null;
    out.frequency = payload.frequency;
  }
  if (Object.hasOwn(payload, 'status')) {
    if (!HABIT_STATUSES.has(payload.status)) return null;
    out.status = payload.status;
  } else if (!partial) out.status = 'active';
  return out;
}

export function validateCheckinInput(payload) {
  if (!ownKeysOnly(payload, ['completed', 'date', 'habitId', 'notes', 'value'])
      || !validId(payload.habitId) || !validIsoDate(payload.date)
      || typeof payload.value !== 'number' || !Number.isFinite(payload.value) || payload.value < 0 || payload.value > 1000000000
      || typeof payload.completed !== 'boolean') return null;
  const notes = normalizePlainText(payload.notes, 500);
  if (notes === null) return null;
  return { habitId: payload.habitId, date: payload.date, value: payload.value, completed: payload.completed, notes };
}

function exactKeys(item, allowed) {
  return record(item) && Object.keys(item).every(key => allowed.includes(key));
}

export function validateCommunicationHabitsLimits(limits) {
  const merged = { ...COMMUNICATION_HABITS_LIMITS, ...limits };
  if (merged.archivedHabitRetentionDays < merged.checkinRetentionDays) {
    throw new Error('archived habit retention must be at least check-in retention');
  }
  for (const key of ['messageRetentionDays', 'archivedHabitRetentionDays', 'checkinRetentionDays']) {
    if (!Number.isInteger(merged[key]) || merged[key] < 1) throw new Error(`${key} must be a positive integer`);
  }
  return merged;
}

export function validateCommunicationHabitsState(db) {
  if (!Array.isArray(db.coachMessages) || !Array.isArray(db.coachHabits) || !Array.isArray(db.habitCheckins)) {
    throw new Error('communication and habits collections must be arrays');
  }
  const links = new Map((db.coachAthleteLinks || []).map(link => [link.id, link]));
  const messageIds = new Set();
  for (const item of db.coachMessages) {
    const link = links.get(item?.linkId);
    const normalized = validateMessageInput(item && { content: item.content, category: item.category, refId: item.refId });
    if (!exactKeys(item, ['id', 'linkId', 'senderId', 'recipientId', 'content', 'category', 'refId', 'createdAt', 'readAt'])
        || !validId(item.id) || messageIds.has(item.id) || !link || !normalized
        || normalized.content !== item.content || normalized.category !== item.category || normalized.refId !== item.refId
        || !finiteTimestamp(item.createdAt) || !(item.readAt === null || finiteTimestamp(item.readAt))
        || item.readAt !== null && item.readAt < item.createdAt
        || !((item.senderId === link.coachId && item.recipientId === link.athleteId)
          || (item.senderId === link.athleteId && item.recipientId === link.coachId))) {
      throw new Error('coachMessages contains a duplicate id or invalid record');
    }
    messageIds.add(item.id);
  }
  const habitIds = new Set();
  const habits = new Map();
  for (const item of db.coachHabits) {
    const link = links.get(item?.linkId);
    const normalized = validateHabitInput(item && {
      title: item.title, description: item.description, targetValue: item.targetValue,
      unit: item.unit, frequency: item.frequency, status: item.status,
    });
    if (!exactKeys(item, ['id', 'linkId', 'coachId', 'athleteId', 'title', 'description', 'targetValue', 'unit', 'frequency', 'status', 'createdAt', 'updatedAt', 'archivedAt'])
        || !validId(item.id) || habitIds.has(item.id) || !link || !normalized
        || link.coachId !== item.coachId || link.athleteId !== item.athleteId
        || !finiteTimestamp(item.createdAt) || !finiteTimestamp(item.updatedAt) || item.updatedAt < item.createdAt
        || (item.status === 'archived' ? !finiteTimestamp(item.archivedAt) || item.archivedAt < item.createdAt : item.archivedAt !== null)
        || normalized.title !== item.title || normalized.description !== item.description
        || normalized.targetValue !== item.targetValue || normalized.unit !== item.unit
        || normalized.frequency !== item.frequency || normalized.status !== item.status) {
      throw new Error('coachHabits contains a duplicate id or invalid record');
    }
    habitIds.add(item.id);
    habits.set(item.id, item);
  }
  const checkinIds = new Set();
  const checkinKeys = new Set();
  for (const item of db.habitCheckins) {
    const habit = habits.get(item?.habitId);
    const normalized = validateCheckinInput(item && {
      habitId: item.habitId, date: item.date, value: item.value, completed: item.completed, notes: item.notes,
    });
    const uniqueKey = `${item?.athleteId}\0${item?.habitId}\0${item?.date}`;
    if (!exactKeys(item, ['id', 'linkId', 'athleteId', 'habitId', 'date', 'value', 'completed', 'notes', 'updatedAt'])
        || !validId(item.id) || checkinIds.has(item.id) || checkinKeys.has(uniqueKey) || !habit || !normalized
        || habit.linkId !== item.linkId || habit.athleteId !== item.athleteId || !finiteTimestamp(item.updatedAt)
        || normalized.date !== item.date || normalized.value !== item.value || normalized.completed !== item.completed
        || normalized.notes !== item.notes) {
      throw new Error('habitCheckins contains a duplicate id, duplicate day, or invalid record');
    }
    checkinIds.add(item.id);
    checkinKeys.add(uniqueKey);
  }
  return true;
}

const newestMessage = (left, right) => right.createdAt - left.createdAt || String(right.id).localeCompare(String(left.id));
const newestHabit = (left, right) => right.updatedAt - left.updatedAt || String(right.id).localeCompare(String(left.id));
const newestCheckin = (left, right) => right.date.localeCompare(left.date) || right.updatedAt - left.updatedAt || String(right.id).localeCompare(String(left.id));

function capBy(rows, keyOf, max, compare) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()].flatMap(group => group.sort(compare).slice(0, max));
}

export function compactCommunicationHabits(db, configuredLimits = COMMUNICATION_HABITS_LIMITS, now = Date.now()) {
  const limits = validateCommunicationHabitsLimits(configuredLimits);
  const before = [db.coachMessages.length, db.coachHabits.length, db.habitCheckins.length];
  const links = new Map((db.coachAthleteLinks || []).map(link => [link.id, link]));
  const messageCutoff = now - limits.messageRetentionDays * DAY_MS;
  db.coachMessages = capBy(
    db.coachMessages.filter(item => links.has(item.linkId) && item.createdAt >= messageCutoff), item => item.linkId,
    limits.maxMessagesPerLink, newestMessage,
  ).sort(newestMessage).slice(0, limits.maxMessages);

  const archivedCutoff = now - limits.archivedHabitRetentionDays * DAY_MS;
  const liveHabits = db.coachHabits.filter(item => {
    const link = links.get(item.linkId);
    if (!link) return false;
    if (link.status !== 'ended' && item.status === 'active') return true;
    return item.updatedAt >= archivedCutoff;
  });
  const activeHabits = liveHabits.filter(item => item.status === 'active');
  if (activeHabits.length > limits.maxHabits) throw new Error(`active coachHabits exceed configured limit ${limits.maxHabits}`);
  const activeCounts = new Map();
  for (const habit of activeHabits) {
    const count = (activeCounts.get(habit.linkId) || 0) + 1;
    if (count > limits.maxHabitsPerLink) throw new Error(`active coachHabits link exceeds configured limit ${limits.maxHabitsPerLink}`);
    activeCounts.set(habit.linkId, count);
  }
  const archived = liveHabits.filter(item => item.status === 'archived').sort(newestHabit);
  const keptArchived = [];
  const totalSlots = Math.max(0, limits.maxHabits - activeHabits.length);
  const archivedCounts = new Map();
  for (const habit of archived) {
    if (keptArchived.length >= totalSlots) break;
    const slots = Math.max(0, limits.maxHabitsPerLink - (activeCounts.get(habit.linkId) || 0));
    const count = archivedCounts.get(habit.linkId) || 0;
    if (count >= slots) continue;
    keptArchived.push(habit);
    archivedCounts.set(habit.linkId, count + 1);
  }
  db.coachHabits = [...activeHabits, ...keptArchived];
  const keptHabitIds = new Set(db.coachHabits.map(item => item.id));
  const checkinCutoff = dayString(now - limits.checkinRetentionDays * DAY_MS);
  const perHabit = capBy(
    db.habitCheckins.filter(item => keptHabitIds.has(item.habitId) && item.date >= checkinCutoff),
    item => item.habitId, limits.maxCheckinsPerHabit, newestCheckin,
  );
  db.habitCheckins = capBy(perHabit, item => item.linkId, limits.maxCheckinsPerLink, newestCheckin)
    .sort(newestCheckin).slice(0, limits.maxCheckins);
  return { changed: before.some((count, index) => count !== [db.coachMessages.length, db.coachHabits.length, db.habitCheckins.length][index]) };
}

const linkTime = link => Date.parse(link.updatedAt || link.createdAt || '') || 0;
export function resolveCommunicationLink(db, coachId, athleteId, { write = false, linkId = null, scope = null } = {}) {
  const pair = db.coachAthleteLinks.filter(link => link.coachId === coachId && link.athleteId === athleteId)
    .sort((left, right) => linkTime(right) - linkTime(left) || String(right.id).localeCompare(String(left.id)));
  if (linkId !== null) {
    if (!validId(linkId)) return { ok: false, code: 'relationship_not_found' };
    const selected = pair.find(link => link.id === linkId);
    if (!selected) return { ok: false, code: 'relationship_not_found' };
    if (write && selected.status !== 'active') return { ok: false, code: 'relationship_inactive' };
    if (scope && !selected.scopes?.includes(scope)) return { ok: false, code: 'scope_forbidden' };
    return { ok: true, link: selected, readOnly: selected.status !== 'active' };
  }
  const active = pair.find(link => link.status === 'active');
  const selected = write ? active : active || pair[0];
  if (!selected) return { ok: false, code: write && pair.length ? 'relationship_inactive' : 'relationship_not_found' };
  if (write && selected.status !== 'active') return { ok: false, code: 'relationship_inactive' };
  if (scope && !selected.scopes?.includes(scope)) return { ok: false, code: 'scope_forbidden' };
  return { ok: true, link: selected, readOnly: selected.status !== 'active' };
}

export function removeCommunicationHabitsUser(db, userId) {
  db.coachMessages ||= [];
  db.coachHabits ||= [];
  db.habitCheckins ||= [];
  const removedHabitIds = new Set(db.coachHabits.filter(item => item.coachId === userId || item.athleteId === userId).map(item => item.id));
  db.coachMessages = db.coachMessages.filter(item => item.senderId !== userId && item.recipientId !== userId);
  db.coachHabits = db.coachHabits.filter(item => item.coachId !== userId && item.athleteId !== userId);
  db.habitCheckins = db.habitCheckins.filter(item => item.athleteId !== userId && !removedHabitIds.has(item.habitId));
}

function scheduledOn(date, frequency) {
  const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return frequency === 'daily' || frequency === 'weekdays' && day >= 1 && day <= 5 || frequency === 'weekends' && (day === 0 || day === 6);
}

const shiftDay = (date, amount) => new Date(Date.parse(`${date}T00:00:00.000Z`) + amount * DAY_MS).toISOString().slice(0, 10);

export function habitSummary(habits, checkins, today = dayString(Date.now()), periodDays = 30, timeZone = DEFAULT_TIME_ZONE) {
  const from = shiftDay(today, -(periodDays - 1));
  const byHabit = new Map();
  for (const checkin of checkins) {
    if (!byHabit.has(checkin.habitId)) byHabit.set(checkin.habitId, new Map());
    byHabit.get(checkin.habitId).set(checkin.date, checkin);
  }
  let scheduledTotal = 0;
  let completedTotal = 0;
  const summaries = habits.map(habit => {
    const created = dateInTimeZone(habit.createdAt, timeZone);
    const archived = habit.archivedAt === null ? today : dateInTimeZone(habit.archivedAt, timeZone);
    const start = created > from ? created : from;
    const end = archived < today ? archived : today;
    const dates = [];
    if (start <= end) for (let date = start; date <= end; date = shiftDay(date, 1)) if (scheduledOn(date, habit.frequency)) dates.push(date);
    const rows = byHabit.get(habit.id) || new Map();
    const completed = dates.filter(date => rows.get(date)?.completed).length;
    let currentStreak = 0;
    let index = dates.length - 1;
    if (dates[index] === today && rows.get(today) === undefined) index -= 1;
    for (; index >= 0 && rows.get(dates[index])?.completed; index -= 1) currentStreak += 1;
    let longestStreakInPeriod = 0;
    let run = 0;
    for (const date of dates) {
      run = rows.get(date)?.completed ? run + 1 : 0;
      longestStreakInPeriod = Math.max(longestStreakInPeriod, run);
    }
    scheduledTotal += dates.length;
    completedTotal += completed;
    return {
      habitId: habit.id, title: habit.title, frequency: habit.frequency,
      scheduledDays: dates.length, completedDays: completed,
      adherencePercent: dates.length ? Math.round(completed / dates.length * 1000) / 10 : 0,
      currentStreak, longestStreakInPeriod, longestStreak: longestStreakInPeriod,
    };
  });
  return {
    from, to: today, periodDays, scheduledDays: scheduledTotal, completedDays: completedTotal,
    adherencePercent: scheduledTotal ? Math.round(completedTotal / scheduledTotal * 1000) / 10 : 0,
    habits: summaries,
  };
}

const encodeCursor = values => Buffer.from(JSON.stringify(values)).toString('base64url');
function parseCursor(value, validate) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    return validate(parsed) ? parsed : false;
  } catch { return false; }
}
const messageCursor = item => encodeCursor([item.createdAt, item.id]);
const parseMessageCursor = value => parseCursor(value, parsed => Array.isArray(parsed) && parsed.length === 2
  && finiteTimestamp(parsed[0]) && validId(parsed[1]));
const checkinCursor = item => encodeCursor([item.date, item.updatedAt, item.id]);
const parseCheckinCursor = value => parseCursor(value, parsed => Array.isArray(parsed) && parsed.length === 3
  && validIsoDate(parsed[0]) && finiteTimestamp(parsed[1]) && validId(parsed[2]));
const inboxCursor = item => encodeCursor([item.lastMessageAt, item.linkId]);
const parseInboxCursor = value => parseCursor(value, parsed => Array.isArray(parsed) && parsed.length === 2
  && finiteTimestamp(parsed[0]) && validId(parsed[1]));

function requestedTimeZone(req) {
  const url = new URL(req.url, 'http://x');
  const timeZone = url.searchParams.get('timezone') || DEFAULT_TIME_ZONE;
  return validTimeZone(timeZone) ? timeZone : null;
}

function requestedLinkId(req) {
  const value = new URL(req.url, 'http://x').searchParams.get('linkId');
  return value === null ? null : validId(value) ? value : false;
}

function requestedPeriod(req, today) {
  const url = new URL(req.url, 'http://x');
  const rawPeriod = url.searchParams.get('period');
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  if (rawPeriod !== null && (from !== null || to !== null)) return null;
  if (rawPeriod !== null) {
    const periodDays = Number(rawPeriod);
    return SUMMARY_PERIODS.has(periodDays) ? { from: shiftDay(today, -(periodDays - 1)), to: today, periodDays } : null;
  }
  if (from !== null || to !== null) {
    if (!validIsoDate(from) || !validIsoDate(to) || from > to || to > today) return null;
    const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
    return days <= 90 ? { from, to, periodDays: days } : null;
  }
  return { from: shiftDay(today, -29), to: today, periodDays: 30 };
}

export function createCommunicationHabitsRoutes(context) {
  const {
    audit, auditDenied, b2bError, db, json, limitAddress, limits: configuredLimits, makeEntityId,
    profileOf, readBody, readSession, rate, saveDb,
  } = context;
  const limits = validateCommunicationHabitsLimits(configuredLimits);
  const windows = Object.fromEntries(['message', 'checkin', 'habit', 'read'].map(kind => [kind, {
    account: createWindow({ max: rate[`${kind}Account`], windowMs: rate.windowMs }),
    ip: createWindow({ max: rate[`${kind}Ip`], windowMs: rate.windowMs }),
  }]));
  const timer = setInterval(() => {
    for (const pair of Object.values(windows)) { pair.account.sweep(); pair.ip.sweep(); }
  }, Math.min(rate.windowMs, 60000));
  timer.unref();

  const throttle = (req, res, user, kind) => {
    const wait = Math.max(windows[kind].account.take(user.id), windows[kind].ip.take(limitAddress(req)));
    if (!wait) return false;
    auditDenied(req, `b2b2c.${kind}.throttled`, user, 'rate_limited');
    b2bError(res, 429, 'rate_limited', `too many ${kind} attempts, try again later`, { 'Retry-After': String(wait) });
    return true;
  };

  const commit = (nextMessages, nextHabits, nextCheckins) => {
    const candidate = clone(db);
    candidate.coachMessages = nextMessages;
    candidate.coachHabits = nextHabits;
    candidate.habitCheckins = nextCheckins;
    validateCommunicationHabitsState(candidate);
    saveDb(candidate);
    db.coachMessages = nextMessages;
    db.coachHabits = nextHabits;
    db.habitCheckins = nextCheckins;
  };

  const compactedCopies = () => {
    const copy = clone(db);
    compactCommunicationHabits(copy, limits);
    return copy;
  };

  const actorLink = (req, res, actor, coachId, athleteId, { write = false, scope = null, event, linkId = null } = {}) => {
    const access = resolveCommunicationLink(db, coachId, athleteId, { write, scope, linkId });
    if (access.ok) return access;
    auditDenied(req, `${event}.denied`, actor, access.code);
    const status = access.code === 'relationship_not_found' ? 404 : 403;
    const message = access.code === 'scope_forbidden' ? 'relationship scope does not permit this operation'
      : write ? 'active professional relationship required' : 'professional relationship not found';
    b2bError(res, status, access.code, message);
    return null;
  };

  const coachOnly = (req, res) => {
    const coach = readSession(req);
    if (!coach) { b2bError(res, 401, 'not_signed_in', 'not signed in'); return null; }
    if (profileOf(coach).kind !== 'coach') { b2bError(res, 403, 'role_forbidden', 'professional profile required'); return null; }
    return coach;
  };

  const athleteOnly = (req, res) => {
    const athlete = readSession(req);
    if (!athlete) { b2bError(res, 401, 'not_signed_in', 'not signed in'); return null; }
    if (profileOf(athlete).kind === 'coach') { b2bError(res, 403, 'role_forbidden', 'athlete profile required'); return null; }
    return athlete;
  };

  const listMessages = (req, res, actor, coachId, athleteId) => {
    const linkId = requestedLinkId(req);
    if (linkId === false) return b2bError(res, 400, 'invalid_link_id', 'linkId must be valid');
    const access = actorLink(req, res, actor, coachId, athleteId, { event: 'b2b2c.message.list', linkId });
    if (!access) return;
    const url = new URL(req.url, 'http://x');
    const rawLimit = url.searchParams.get('limit');
    const limit = rawLimit === null ? 50 : Number(rawLimit);
    const cursor = parseMessageCursor(url.searchParams.get('cursor'));
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || cursor === false) {
      return b2bError(res, 400, 'invalid_pagination', 'limit must be 1-100 and cursor must be valid');
    }
    let rows = db.coachMessages.filter(item => item.linkId === access.link.id).sort(newestMessage);
    if (cursor) rows = rows.filter(item => item.createdAt < cursor[0]
      || item.createdAt === cursor[0] && String(item.id).localeCompare(cursor[1]) < 0);
    const hasMore = rows.length > limit;
    const messages = rows.slice(0, limit).map(clone);
    audit(req, 'b2b2c.message.list', { user: actor, msg: `${access.link.id}:${messages.length}` });
    json(res, 200, {
      messages, page: { limit, hasMore, nextCursor: hasMore ? messageCursor(rows[limit - 1]) : null },
      relationship: { linkId: access.link.id, status: access.link.status, readOnly: !!access.readOnly },
    });
  };

  const sendMessage = async (req, res, actor, coachId, athleteId) => {
    const input = validateMessageInput(await readBody(req));
    if (!input) return b2bError(res, 400, 'invalid_message', 'invalid message');
    const scope = input.category === 'nutrition_feedback' ? 'nutrition'
      : input.category === 'workout_feedback' ? 'training' : null;
    const access = actorLink(req, res, actor, coachId, athleteId, { write: true, event: 'b2b2c.message.send' });
    if (!access) return;
    if (scope ? !access.link.scopes?.includes(scope) : !access.link.scopes?.some(item => item === 'training' || item === 'nutrition')) {
      auditDenied(req, 'b2b2c.message.send.denied', actor, 'scope_forbidden');
      return b2bError(res, 403, 'scope_forbidden', 'relationship scope does not permit this operation');
    }
    if (throttle(req, res, actor, 'message')) return;
    const retained = compactedCopies();
    const pairCount = retained.coachMessages.filter(item => item.linkId === access.link.id).length;
    if (pairCount >= limits.maxMessagesPerLink || retained.coachMessages.length >= limits.maxMessages) {
      return b2bError(res, 409, 'message_capacity', 'message storage capacity reached');
    }
    const row = {
      id: makeEntityId('cmsg', retained.coachMessages), linkId: access.link.id,
      senderId: actor.id, recipientId: actor.id === coachId ? athleteId : coachId,
      ...input, createdAt: Date.now(), readAt: null,
    };
    try { commit([...retained.coachMessages, row], retained.coachHabits, retained.habitCheckins); }
    catch { return b2bError(res, 503, 'storage_unavailable', 'message could not be saved'); }
    audit(req, 'b2b2c.message.send', { user: actor, msg: row.id });
    json(res, 201, { message: clone(row) });
  };

  const history = (req, res, actor, coachId, athleteId) => {
    const timeZone = requestedTimeZone(req);
    if (!timeZone) return b2bError(res, 400, 'invalid_timezone', 'timezone must be a valid IANA time zone');
    const today = dateInTimeZone(Date.now(), timeZone);
    const period = requestedPeriod(req, today);
    const linkId = requestedLinkId(req);
    if (!period) return b2bError(res, 400, 'invalid_period', 'period must be 7, 30 or 90 days, or an interval up to 90 days');
    if (linkId === false) return b2bError(res, 400, 'invalid_link_id', 'linkId must be valid');
    const access = actorLink(req, res, actor, coachId, athleteId, { scope: 'training', event: 'b2b2c.checkin.list', linkId });
    if (!access) return;
    const url = new URL(req.url, 'http://x');
    const rawLimit = url.searchParams.get('limit');
    const limit = rawLimit === null ? 50 : Number(rawLimit);
    const cursor = parseCheckinCursor(url.searchParams.get('cursor'));
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || cursor === false) {
      return b2bError(res, 400, 'invalid_pagination', 'limit must be 1-100 and cursor must be valid');
    }
    let rows = db.habitCheckins.filter(item => item.linkId === access.link.id && item.date >= period.from && item.date <= period.to)
      .sort(newestCheckin);
    if (cursor) rows = rows.filter(item => item.date < cursor[0]
      || item.date === cursor[0] && (item.updatedAt < cursor[1]
        || item.updatedAt === cursor[1] && String(item.id).localeCompare(cursor[2]) < 0));
    const hasMore = rows.length > limit;
    const checkins = rows.slice(0, limit).map(item => ({
      id: item.id, habitId: item.habitId, date: item.date, value: item.value,
      completed: item.completed, notes: item.notes, updatedAt: item.updatedAt,
    }));
    json(res, 200, {
      checkins, period: { ...period, timezone: timeZone },
      page: { limit, hasMore, nextCursor: hasMore ? checkinCursor(rows[limit - 1]) : null },
      relationship: { linkId: access.link.id, status: access.link.status, readOnly: !!access.readOnly },
    });
  };

  const summary = (req, res, actor, coachId, athleteId) => {
    const timeZone = requestedTimeZone(req);
    if (!timeZone) return b2bError(res, 400, 'invalid_timezone', 'timezone must be a valid IANA time zone');
    const today = dateInTimeZone(Date.now(), timeZone);
    const period = requestedPeriod(req, today);
    const linkId = requestedLinkId(req);
    if (!period) return b2bError(res, 400, 'invalid_period', 'period must be 7, 30 or 90 days, or an interval up to 90 days');
    if (linkId === false) return b2bError(res, 400, 'invalid_link_id', 'linkId must be valid');
    const access = actorLink(req, res, actor, coachId, athleteId, { scope: 'training', event: 'b2b2c.habit.summary', linkId });
    if (!access) return;
    const habits = db.coachHabits.filter(item => item.linkId === access.link.id);
    const habitIds = new Set(habits.map(item => item.id));
    const result = habitSummary(habits, db.habitCheckins.filter(item => habitIds.has(item.habitId)), period.to, period.periodDays, timeZone);
    result.from = period.from;
    json(res, 200, { summary: result, timezone: timeZone,
      relationship: { linkId: access.link.id, status: access.link.status, readOnly: !!access.readOnly } });
  };

  const routes = {
    'GET /api/coach/athletes/{athleteId}/messages': async (req, res) => {
      const coach = coachOnly(req, res); if (!coach) return;
      listMessages(req, res, coach, coach.id, req.athleteId);
    },
    'POST /api/coach/athletes/{athleteId}/messages': async (req, res) => {
      const coach = coachOnly(req, res); if (!coach) return;
      await sendMessage(req, res, coach, coach.id, req.athleteId);
    },
    'GET /api/athlete/messages/{coachId}': async (req, res) => {
      const athlete = athleteOnly(req, res); if (!athlete) return;
      listMessages(req, res, athlete, req.coachId, athlete.id);
    },
    'POST /api/athlete/messages/{coachId}': async (req, res) => {
      const athlete = athleteOnly(req, res); if (!athlete) return;
      await sendMessage(req, res, athlete, req.coachId, athlete.id);
    },
    'GET /api/messages/inbox': async (req, res) => {
      const actor = readSession(req);
      if (!actor) return b2bError(res, 401, 'not_signed_in', 'not signed in');
      const url = new URL(req.url, 'http://x');
      const rawLimit = url.searchParams.get('limit');
      const limit = rawLimit === null ? 30 : Number(rawLimit);
      const cursor = parseInboxCursor(url.searchParams.get('cursor'));
      if (!Number.isInteger(limit) || limit < 1 || limit > 100 || cursor === false) {
        return b2bError(res, 400, 'invalid_pagination', 'limit must be 1-100 and cursor must be valid');
      }
      const links = new Map(db.coachAthleteLinks.filter(link => link.coachId === actor.id || link.athleteId === actor.id).map(link => [link.id, link]));
      const conversations = new Map();
      for (const message of db.coachMessages) {
        const link = links.get(message.linkId);
        if (!link) continue;
        let item = conversations.get(link.id);
        if (!item) {
          const counterpartId = actor.id === link.coachId ? link.athleteId : link.coachId;
          const counterpart = db.users.find(user => user.id === counterpartId);
          item = { linkId: link.id, counterpart: counterpart ? { id: counterpart.id, name: counterpart.name } : { id: counterpartId, name: '' },
            unreadCount: 0, lastMessage: null, lastMessageAt: 0, status: link.status };
          conversations.set(link.id, item);
        }
        if (message.recipientId === actor.id && message.readAt === null) item.unreadCount += 1;
        if (!item.lastMessage || message.createdAt > item.lastMessage.createdAt
            || message.createdAt === item.lastMessage.createdAt && message.id.localeCompare(item.lastMessage.id) > 0) {
          item.lastMessage = { id: message.id, senderId: message.senderId, category: message.category,
            content: message.content.slice(0, 240), createdAt: message.createdAt, readAt: message.readAt };
          item.lastMessageAt = message.createdAt;
        }
      }
      let rows = [...conversations.values()].sort((left, right) => right.lastMessageAt - left.lastMessageAt || right.linkId.localeCompare(left.linkId));
      if (cursor) rows = rows.filter(item => item.lastMessageAt < cursor[0]
        || item.lastMessageAt === cursor[0] && item.linkId.localeCompare(cursor[1]) < 0);
      const hasMore = rows.length > limit;
      json(res, 200, { conversations: rows.slice(0, limit),
        page: { limit, hasMore, nextCursor: hasMore ? inboxCursor(rows[limit - 1]) : null } });
    },
    'POST /api/messages/{messageId}/read': async (req, res) => {
      const actor = readSession(req);
      if (!actor) return b2bError(res, 401, 'not_signed_in', 'not signed in');
      const message = db.coachMessages.find(item => item.id === req.messageId);
      if (!message) return b2bError(res, 404, 'message_not_found', 'message not found');
      if (message.recipientId !== actor.id) {
        const sender = message.senderId === actor.id;
        auditDenied(req, 'b2b2c.message.read.denied', actor, sender ? 'recipient_required' : 'message_not_found');
        return sender ? b2bError(res, 403, 'recipient_required', 'only the recipient can mark this message read')
          : b2bError(res, 404, 'message_not_found', 'message not found');
      }
      const link = db.coachAthleteLinks.find(item => item.id === message.linkId
        && (item.coachId === actor.id || item.athleteId === actor.id));
      if (!link) return b2bError(res, 404, 'message_not_found', 'message not found');
      if (message.readAt !== null) return json(res, 200, { message: clone(message) });
      if (throttle(req, res, actor, 'read')) return;
      const updated = { ...message, readAt: Date.now() };
      const next = db.coachMessages.map(item => item.id === message.id ? updated : item);
      try { commit(next, db.coachHabits, db.habitCheckins); }
      catch { return b2bError(res, 503, 'storage_unavailable', 'message read state could not be saved'); }
      audit(req, 'b2b2c.message.read', { user: actor, msg: message.id });
      json(res, 200, { message: clone(updated) });
    },
    'POST /api/messages/read-through': async (req, res) => {
      const actor = readSession(req);
      if (!actor) return b2bError(res, 401, 'not_signed_in', 'not signed in');
      const body = await readBody(req);
      if (!ownKeysOnly(body, ['linkId', 'throughMessageId']) || !validId(body.linkId) || !validId(body.throughMessageId)) {
        return b2bError(res, 400, 'invalid_read_cursor', 'linkId and throughMessageId are required');
      }
      const link = db.coachAthleteLinks.find(item => item.id === body.linkId && (item.coachId === actor.id || item.athleteId === actor.id));
      const through = db.coachMessages.find(item => item.id === body.throughMessageId && item.linkId === body.linkId);
      if (!link || !through) return b2bError(res, 404, 'message_not_found', 'message not found');
      if (through.recipientId !== actor.id) return b2bError(res, 403, 'recipient_required', 'cursor message must have been received by this account');
      const eligible = item => item.linkId === link.id && item.recipientId === actor.id && item.readAt === null
        && (item.createdAt < through.createdAt || item.createdAt === through.createdAt && item.id.localeCompare(through.id) <= 0);
      const count = db.coachMessages.filter(eligible).length;
      if (!count) return json(res, 200, { linkId: link.id, readCount: 0, throughMessageId: through.id });
      if (throttle(req, res, actor, 'read')) return;
      const now = Date.now();
      const next = db.coachMessages.map(item => eligible(item) ? { ...item, readAt: now } : item);
      try { commit(next, db.coachHabits, db.habitCheckins); }
      catch { return b2bError(res, 503, 'storage_unavailable', 'message read state could not be saved'); }
      audit(req, 'b2b2c.message.read-through', { user: actor, msg: `${link.id}:${count}` });
      json(res, 200, { linkId: link.id, readCount: count, throughMessageId: through.id });
    },
    'GET /api/coach/athletes/{athleteId}/habits': async (req, res) => {
      const coach = coachOnly(req, res); if (!coach) return;
      const linkId = requestedLinkId(req);
      if (linkId === false) return b2bError(res, 400, 'invalid_link_id', 'linkId must be valid');
      const access = actorLink(req, res, coach, coach.id, req.athleteId, { scope: 'training', event: 'b2b2c.habit.list', linkId });
      if (!access) return;
      const habits = db.coachHabits.filter(item => item.linkId === access.link.id).sort(newestHabit).map(clone);
      json(res, 200, { habits, relationship: { linkId: access.link.id, status: access.link.status, readOnly: !!access.readOnly } });
    },
    'POST /api/coach/athletes/{athleteId}/habits': async (req, res) => {
      const coach = coachOnly(req, res); if (!coach) return;
      const access = actorLink(req, res, coach, coach.id, req.athleteId, { write: true, scope: 'training', event: 'b2b2c.habit.create' });
      if (!access) return;
      const input = validateHabitInput(await readBody(req));
      if (!input) return b2bError(res, 400, 'invalid_habit', 'invalid habit');
      if (throttle(req, res, coach, 'habit')) return;
      const retained = compactedCopies();
      const linkCount = retained.coachHabits.filter(item => item.linkId === access.link.id).length;
      if (linkCount >= limits.maxHabitsPerLink || retained.coachHabits.length >= limits.maxHabits) {
        return b2bError(res, 409, 'habit_capacity', 'habit storage capacity reached');
      }
      const now = Date.now();
      const row = { id: makeEntityId('hab', retained.coachHabits), linkId: access.link.id, coachId: coach.id,
        athleteId: req.athleteId, ...input, createdAt: now, updatedAt: now, archivedAt: input.status === 'archived' ? now : null };
      try { commit(retained.coachMessages, [...retained.coachHabits, row], retained.habitCheckins); }
      catch { return b2bError(res, 503, 'storage_unavailable', 'habit could not be saved'); }
      audit(req, 'b2b2c.habit.create', { user: coach, msg: row.id });
      json(res, 201, { habit: clone(row) });
    },
    'PATCH /api/coach/athletes/{athleteId}/habits/{habitId}': async (req, res) => {
      const coach = coachOnly(req, res); if (!coach) return;
      const ownedHabit = db.coachHabits.find(item => item.id === req.habitId && item.coachId === coach.id && item.athleteId === req.athleteId);
      if (!ownedHabit) return b2bError(res, 404, 'habit_not_found', 'habit not found');
      const access = actorLink(req, res, coach, coach.id, req.athleteId, { write: true, scope: 'training', event: 'b2b2c.habit.update' });
      if (!access) return;
      const habit = ownedHabit.linkId === access.link.id ? ownedHabit : null;
      if (!habit) return b2bError(res, 404, 'habit_not_found', 'habit not found');
      const input = validateHabitInput(await readBody(req), { partial: true });
      if (!input) return b2bError(res, 400, 'invalid_habit', 'invalid habit update');
      const status = input.status ?? habit.status;
      const changed = Object.entries(input).some(([key, value]) => habit[key] !== value);
      if (!changed) return json(res, 200, { habit: clone(habit) });
      if (throttle(req, res, coach, 'habit')) return;
      const now = Date.now();
      const updated = { ...habit, ...input, status, updatedAt: now, archivedAt: status === 'archived' ? habit.archivedAt ?? now : null };
      try { commit(db.coachMessages, db.coachHabits.map(item => item.id === habit.id ? updated : item), db.habitCheckins); }
      catch { return b2bError(res, 503, 'storage_unavailable', 'habit could not be saved'); }
      audit(req, 'b2b2c.habit.update', { user: coach, msg: habit.id });
      json(res, 200, { habit: clone(updated) });
    },
    'DELETE /api/coach/athletes/{athleteId}/habits/{habitId}': async (req, res) => {
      const coach = coachOnly(req, res); if (!coach) return;
      const ownedHabit = db.coachHabits.find(item => item.id === req.habitId && item.coachId === coach.id && item.athleteId === req.athleteId);
      if (!ownedHabit) return b2bError(res, 404, 'habit_not_found', 'habit not found');
      const access = actorLink(req, res, coach, coach.id, req.athleteId, { write: true, scope: 'training', event: 'b2b2c.habit.delete' });
      if (!access) return;
      const habit = ownedHabit.linkId === access.link.id ? ownedHabit : null;
      if (!habit) return b2bError(res, 404, 'habit_not_found', 'habit not found');
      if (throttle(req, res, coach, 'habit')) return;
      try { commit(db.coachMessages, db.coachHabits.filter(item => item.id !== habit.id), db.habitCheckins.filter(item => item.habitId !== habit.id)); }
      catch { return b2bError(res, 503, 'storage_unavailable', 'habit could not be deleted'); }
      audit(req, 'b2b2c.habit.delete', { user: coach, msg: habit.id });
      json(res, 200, { deleted: true, habit: clone(habit) });
    },
    'GET /api/athlete/habits': async (req, res) => {
      const athlete = athleteOnly(req, res); if (!athlete) return;
      const timeZone = requestedTimeZone(req);
      if (!timeZone) return b2bError(res, 400, 'invalid_timezone', 'timezone must be a valid IANA time zone');
      const today = dateInTimeZone(Date.now(), timeZone);
      const linksByCoach = new Map();
      for (const link of db.coachAthleteLinks.filter(item => item.athleteId === athlete.id && item.scopes?.includes('training'))
        .sort((left, right) => linkTime(right) - linkTime(left))) {
        const existing = linksByCoach.get(link.coachId);
        if (!existing || link.status === 'active' && existing.status !== 'active') linksByCoach.set(link.coachId, link);
      }
      const selected = new Map([...linksByCoach.values()].map(link => [link.id, link]));
      const checkins = new Map(db.habitCheckins.filter(item => item.athleteId === athlete.id && item.date === today).map(item => [item.habitId, item]));
      const habits = db.coachHabits.filter(item => item.athleteId === athlete.id && item.status === 'active' && selected.has(item.linkId))
        .sort(newestHabit).map(item => ({ ...clone(item), checkin: clone(checkins.get(item.id) || null),
          relationship: { linkId: item.linkId, status: selected.get(item.linkId).status, readOnly: selected.get(item.linkId).status !== 'active' } }));
      json(res, 200, { date: today, timezone: timeZone, habits });
    },
    'POST /api/athlete/habits/checkin': async (req, res) => {
      const athlete = athleteOnly(req, res); if (!athlete) return;
      const timeZone = requestedTimeZone(req);
      if (!timeZone) return b2bError(res, 400, 'invalid_timezone', 'timezone must be a valid IANA time zone');
      const input = validateCheckinInput(await readBody(req));
      if (!input) return b2bError(res, 400, 'invalid_checkin', 'invalid habit check-in');
      const habit = db.coachHabits.find(item => item.id === input.habitId && item.athleteId === athlete.id && item.status === 'active');
      if (!habit) return b2bError(res, 404, 'habit_not_found', 'active habit not found');
      const access = actorLink(req, res, athlete, habit.coachId, athlete.id, { write: true, scope: 'training', event: 'b2b2c.checkin.update' });
      if (!access || access.link.id !== habit.linkId) {
        if (access) b2bError(res, 404, 'habit_not_found', 'active habit not found');
        return;
      }
      const today = dateInTimeZone(Date.now(), timeZone);
      if (input.date > today || input.date < dateInTimeZone(habit.createdAt, timeZone) || !scheduledOn(input.date, habit.frequency)) {
        return b2bError(res, 400, 'invalid_checkin_date', 'check-in date is outside the habit schedule');
      }
      const retained = compactedCopies();
      const index = retained.habitCheckins.findIndex(item => item.athleteId === athlete.id && item.habitId === habit.id && item.date === input.date);
      if (index >= 0) {
        const existing = retained.habitCheckins[index];
        if (existing.value === input.value && existing.completed === input.completed && existing.notes === input.notes) {
          return json(res, 200, { checkin: clone(existing) });
        }
      }
      if (throttle(req, res, athlete, 'checkin')) return;
      if (index < 0 && (retained.habitCheckins.filter(item => item.habitId === habit.id).length >= limits.maxCheckinsPerHabit
          || retained.habitCheckins.filter(item => item.linkId === habit.linkId).length >= limits.maxCheckinsPerLink
          || retained.habitCheckins.length >= limits.maxCheckins)) {
        return b2bError(res, 409, 'checkin_capacity', 'habit check-in storage capacity reached');
      }
      const now = Date.now();
      const row = index < 0
        ? { id: makeEntityId('hchk', retained.habitCheckins), linkId: habit.linkId, athleteId: athlete.id, ...input, updatedAt: now }
        : { ...retained.habitCheckins[index], ...input, updatedAt: now };
      const next = index < 0 ? [...retained.habitCheckins, row]
        : retained.habitCheckins.map((item, itemIndex) => itemIndex === index ? row : item);
      try { commit(retained.coachMessages, retained.coachHabits, next); }
      catch { return b2bError(res, 503, 'storage_unavailable', 'habit check-in could not be saved'); }
      audit(req, 'b2b2c.checkin.update', { user: athlete, msg: row.id });
      json(res, index < 0 ? 201 : 200, { checkin: clone(row) });
    },
    'GET /api/coach/athletes/{athleteId}/checkins': async (req, res) => {
      const coach = coachOnly(req, res); if (!coach) return;
      history(req, res, coach, coach.id, req.athleteId);
    },
    'GET /api/athlete/checkins': async (req, res) => {
      const athlete = athleteOnly(req, res); if (!athlete) return;
      const linkId = requestedLinkId(req);
      if (!linkId || linkId === false) return b2bError(res, 400, 'invalid_link_id', 'linkId is required');
      const link = db.coachAthleteLinks.find(item => item.id === linkId && item.athleteId === athlete.id);
      if (!link) return b2bError(res, 404, 'relationship_not_found', 'relationship not found');
      history(req, res, athlete, link.coachId, athlete.id);
    },
    'GET /api/coach/athletes/{athleteId}/habits-summary': async (req, res) => {
      const coach = coachOnly(req, res); if (!coach) return;
      summary(req, res, coach, coach.id, req.athleteId);
    },
    'GET /api/athlete/habits-summary': async (req, res) => {
      const athlete = athleteOnly(req, res); if (!athlete) return;
      const linkId = requestedLinkId(req);
      if (!linkId || linkId === false) return b2bError(res, 400, 'invalid_link_id', 'linkId is required');
      const link = db.coachAthleteLinks.find(item => item.id === linkId && item.athleteId === athlete.id);
      if (!link) return b2bError(res, 404, 'relationship_not_found', 'relationship not found');
      summary(req, res, athlete, link.coachId, athlete.id);
    },
  };
  return routes;
}
