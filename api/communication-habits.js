import { createWindow } from './rate-limit.js';

const DAY_MS = 86400000;
const ID_RE = /^[A-Za-z0-9_-]{1,120}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MESSAGE_CATEGORIES = new Set(['general', 'workout_feedback', 'nutrition_feedback']);
const HABIT_UNITS = new Set(['horas', 'passos', 'ml', 'minutos', 'vezes']);
const HABIT_FREQUENCIES = new Set(['daily', 'weekdays', 'weekends']);
const HABIT_STATUSES = new Set(['active', 'archived']);

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

export function compactCommunicationHabits(db, limits = COMMUNICATION_HABITS_LIMITS, now = Date.now()) {
  limits = { ...COMMUNICATION_HABITS_LIMITS, ...limits };
  const before = [db.coachMessages.length, db.coachHabits.length, db.habitCheckins.length];
  const validLinkIds = new Set((db.coachAthleteLinks || []).map(link => link.id));
  const messageCutoff = now - limits.messageRetentionDays * DAY_MS;
  db.coachMessages = capBy(
    db.coachMessages.filter(item => validLinkIds.has(item.linkId) && item.createdAt >= messageCutoff), item => item.linkId,
    limits.maxMessagesPerLink, newestMessage,
  ).sort(newestMessage).slice(0, limits.maxMessages);

  const archivedCutoff = now - limits.archivedHabitRetentionDays * DAY_MS;
  const activeHabits = db.coachHabits.filter(item => validLinkIds.has(item.linkId) && item.status === 'active');
  if (activeHabits.length > limits.maxHabits) throw new Error(`active coachHabits exceed configured limit ${limits.maxHabits}`);
  const activeCounts = new Map();
  for (const habit of activeHabits) {
    const count = (activeCounts.get(habit.linkId) || 0) + 1;
    if (count > limits.maxHabitsPerLink) throw new Error(`active coachHabits link exceeds configured limit ${limits.maxHabitsPerLink}`);
    activeCounts.set(habit.linkId, count);
  }
  const archived = db.coachHabits.filter(item => validLinkIds.has(item.linkId) && item.status === 'archived' && item.updatedAt >= archivedCutoff).sort(newestHabit);
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
export function resolveCommunicationLink(db, coachId, athleteId, { write = false } = {}) {
  const links = db.coachAthleteLinks.filter(link => link.coachId === coachId && link.athleteId === athleteId)
    .sort((left, right) => linkTime(right) - linkTime(left) || String(right.id).localeCompare(String(left.id)));
  const active = links.find(link => link.status === 'active');
  if (write) return active ? { ok: true, link: active } : links.length
    ? { ok: false, code: 'relationship_inactive', link: links[0] }
    : { ok: false, code: 'relationship_not_found' };
  return active ? { ok: true, link: active } : links[0]
    ? { ok: true, link: links[0], readOnly: true }
    : { ok: false, code: 'relationship_not_found' };
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

export function habitSummary(habits, checkins, today = new Date().toISOString().slice(0, 10)) {
  const from = shiftDay(today, -29);
  const byHabit = new Map();
  for (const checkin of checkins) {
    if (!byHabit.has(checkin.habitId)) byHabit.set(checkin.habitId, new Map());
    byHabit.get(checkin.habitId).set(checkin.date, checkin);
  }
  let scheduledTotal = 0;
  let completedTotal = 0;
  const summaries = habits.map(habit => {
    const created = dayString(habit.createdAt);
    const archived = habit.archivedAt === null ? today : dayString(habit.archivedAt);
    const start = created > from ? created : from;
    const end = archived < today ? archived : today;
    const dates = [];
    if (start <= end) for (let date = start; date <= end; date = shiftDay(date, 1)) if (scheduledOn(date, habit.frequency)) dates.push(date);
    const rows = byHabit.get(habit.id) || new Map();
    const completed = dates.filter(date => rows.get(date)?.completed).length;
    let currentStreak = 0;
    for (let index = dates.length - 1; index >= 0 && rows.get(dates[index])?.completed; index -= 1) currentStreak += 1;
    let longestStreak = 0;
    let run = 0;
    for (const date of dates) {
      run = rows.get(date)?.completed ? run + 1 : 0;
      longestStreak = Math.max(longestStreak, run);
    }
    scheduledTotal += dates.length;
    completedTotal += completed;
    return {
      habitId: habit.id, title: habit.title, frequency: habit.frequency,
      scheduledDays: dates.length, completedDays: completed,
      adherencePercent: dates.length ? Math.round(completed / dates.length * 1000) / 10 : 0,
      currentStreak, longestStreak,
    };
  });
  return {
    from, to: today, scheduledDays: scheduledTotal, completedDays: completedTotal,
    adherencePercent: scheduledTotal ? Math.round(completedTotal / scheduledTotal * 1000) / 10 : 0,
    habits: summaries,
  };
}

const clone = value => structuredClone(value);
const messageCursor = item => Buffer.from(JSON.stringify([item.createdAt, item.id])).toString('base64url');
function parseMessageCursor(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    return Array.isArray(parsed) && parsed.length === 2 && finiteTimestamp(parsed[0]) && validId(parsed[1])
      ? { createdAt: parsed[0], id: parsed[1] } : false;
  } catch { return false; }
}

export function createCommunicationHabitsRoutes(context) {
  const {
    audit, auditDenied, b2bError, db, json, limitAddress, limits, makeEntityId,
    profileOf, readBody, readSession, rate, saveDb,
  } = context;
  const messageAccount = createWindow({ max: rate.messageAccount, windowMs: rate.windowMs });
  const messageIp = createWindow({ max: rate.messageIp, windowMs: rate.windowMs });
  const checkinAccount = createWindow({ max: rate.checkinAccount, windowMs: rate.windowMs });
  const checkinIp = createWindow({ max: rate.checkinIp, windowMs: rate.windowMs });
  const timer = setInterval(() => {
    messageAccount.sweep(); messageIp.sweep(); checkinAccount.sweep(); checkinIp.sweep();
  }, Math.min(rate.windowMs, 60000));
  timer.unref();

  const throttle = (req, res, user, kind) => {
    const account = kind === 'message' ? messageAccount : checkinAccount;
    const ip = kind === 'message' ? messageIp : checkinIp;
    const wait = Math.max(account.take(user.id), ip.take(limitAddress(req)));
    if (!wait) return false;
    auditDenied(req, `b2b2c.${kind}.throttled`, user, 'rate_limited');
    b2bError(res, 429, 'rate_limited', `too many ${kind} attempts, try again later`, { 'Retry-After': String(wait) });
    return true;
  };

  const commit = (nextMessages, nextHabits, nextCheckins) => {
    const previous = [db.coachMessages, db.coachHabits, db.habitCheckins];
    db.coachMessages = nextMessages;
    db.coachHabits = nextHabits;
    db.habitCheckins = nextCheckins;
    try {
      validateCommunicationHabitsState(db);
      saveDb();
    } catch (error) {
      [db.coachMessages, db.coachHabits, db.habitCheckins] = previous;
      throw error;
    }
  };

  const compactedCopies = () => {
    const copy = {
      coachAthleteLinks: db.coachAthleteLinks,
      coachMessages: clone(db.coachMessages), coachHabits: clone(db.coachHabits), habitCheckins: clone(db.habitCheckins),
    };
    compactCommunicationHabits(copy, limits);
    return copy;
  };

  const actorLink = (req, res, actor, coachId, athleteId, write, event) => {
    const access = resolveCommunicationLink(db, coachId, athleteId, { write });
    if (access.ok) return access;
    auditDenied(req, `${event}.denied`, actor, access.code);
    b2bError(res, access.code === 'relationship_not_found' ? 404 : 403, access.code,
      write ? 'active professional relationship required' : 'professional relationship not found');
    return null;
  };

  const listMessages = (req, res, actor, coachId, athleteId) => {
    const access = actorLink(req, res, actor, coachId, athleteId, false, 'b2b2c.message.list');
    if (!access) return;
    const url = new URL(req.url, 'http://x');
    const rawLimit = url.searchParams.get('limit');
    const limit = rawLimit === null ? 50 : Number(rawLimit);
    const cursor = parseMessageCursor(url.searchParams.get('cursor'));
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || cursor === false) {
      return b2bError(res, 400, 'invalid_pagination', 'limit must be 1-100 and cursor must be valid');
    }
    let rows = db.coachMessages.filter(item => item.linkId === access.link.id).sort(newestMessage);
    if (cursor) rows = rows.filter(item => item.createdAt < cursor.createdAt
      || item.createdAt === cursor.createdAt && String(item.id).localeCompare(cursor.id) < 0);
    const hasMore = rows.length > limit;
    const messages = rows.slice(0, limit).map(clone);
    audit(req, 'b2b2c.message.list', { user: actor, msg: `${access.link.id}:${messages.length}` });
    json(res, 200, {
      messages, page: { limit, hasMore, nextCursor: hasMore ? messageCursor(rows[limit - 1]) : null },
      relationship: { linkId: access.link.id, status: access.link.status, readOnly: !!access.readOnly },
    });
  };

  const sendMessage = async (req, res, actor, coachId, athleteId) => {
    if (throttle(req, res, actor, 'message')) return;
    const access = actorLink(req, res, actor, coachId, athleteId, true, 'b2b2c.message.send');
    if (!access) return;
    const input = validateMessageInput(await readBody(req));
    if (!input) return b2bError(res, 400, 'invalid_message', 'invalid message');
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

  const coachOnly = (req, res) => {
    const coach = readSession(req);
    if (!coach) { b2bError(res, 401, 'not_signed_in', 'not signed in'); return null; }
    if (profileOf(coach).kind !== 'coach') { b2bError(res, 403, 'role_forbidden', 'professional profile required'); return null; }
    return coach;
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
      const athlete = readSession(req);
      if (!athlete) return b2bError(res, 401, 'not_signed_in', 'not signed in');
      listMessages(req, res, athlete, req.coachId, athlete.id);
    },
    'POST /api/athlete/messages/{coachId}': async (req, res) => {
      const athlete = readSession(req);
      if (!athlete) return b2bError(res, 401, 'not_signed_in', 'not signed in');
      await sendMessage(req, res, athlete, req.coachId, athlete.id);
    },
    'POST /api/messages/{messageId}/read': async (req, res) => {
      const actor = readSession(req);
      if (!actor) return b2bError(res, 401, 'not_signed_in', 'not signed in');
      const message = db.coachMessages.find(item => item.id === req.messageId);
      if (!message) return b2bError(res, 404, 'message_not_found', 'message not found');
      if (message.recipientId !== actor.id) {
        const sender = message.senderId === actor.id;
        auditDenied(req, 'b2b2c.message.read.denied', actor, sender ? 'recipient_required' : 'message_not_found');
        return sender
          ? b2bError(res, 403, 'recipient_required', 'only the recipient can mark this message read')
          : b2bError(res, 404, 'message_not_found', 'message not found');
      }
      const link = db.coachAthleteLinks.find(item => item.id === message.linkId);
      if (!link || link.status !== 'active') return b2bError(res, 403, 'relationship_inactive', 'active professional relationship required');
      if (message.readAt !== null) return json(res, 200, { message: clone(message) });
      const updated = { ...message, readAt: Date.now() };
      const next = db.coachMessages.map(item => item.id === message.id ? updated : item);
      try { commit(next, db.coachHabits, db.habitCheckins); }
      catch { return b2bError(res, 503, 'storage_unavailable', 'message read state could not be saved'); }
      audit(req, 'b2b2c.message.read', { user: actor, msg: message.id });
      json(res, 200, { message: clone(updated) });
    },
    'GET /api/coach/athletes/{athleteId}/habits': async (req, res) => {
      const coach = coachOnly(req, res); if (!coach) return;
      const access = actorLink(req, res, coach, coach.id, req.athleteId, false, 'b2b2c.habit.list');
      if (!access) return;
      const habits = db.coachHabits.filter(item => item.linkId === access.link.id).sort(newestHabit).map(clone);
      json(res, 200, { habits, relationship: { linkId: access.link.id, status: access.link.status, readOnly: !!access.readOnly } });
    },
    'POST /api/coach/athletes/{athleteId}/habits': async (req, res) => {
      const coach = coachOnly(req, res); if (!coach) return;
      const access = actorLink(req, res, coach, coach.id, req.athleteId, true, 'b2b2c.habit.create');
      if (!access) return;
      const input = validateHabitInput(await readBody(req));
      if (!input) return b2bError(res, 400, 'invalid_habit', 'invalid habit');
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
      const access = actorLink(req, res, coach, coach.id, req.athleteId, true, 'b2b2c.habit.update');
      if (!access) return;
      const habit = db.coachHabits.find(item => item.id === req.habitId && item.linkId === access.link.id && item.coachId === coach.id && item.athleteId === req.athleteId);
      if (!habit) return b2bError(res, 404, 'habit_not_found', 'habit not found');
      const input = validateHabitInput(await readBody(req), { partial: true });
      if (!input) return b2bError(res, 400, 'invalid_habit', 'invalid habit update');
      const now = Date.now();
      const status = input.status ?? habit.status;
      const updated = { ...habit, ...input, status, updatedAt: now, archivedAt: status === 'archived' ? habit.archivedAt ?? now : null };
      try { commit(db.coachMessages, db.coachHabits.map(item => item.id === habit.id ? updated : item), db.habitCheckins); }
      catch { return b2bError(res, 503, 'storage_unavailable', 'habit could not be saved'); }
      audit(req, 'b2b2c.habit.update', { user: coach, msg: habit.id });
      json(res, 200, { habit: clone(updated) });
    },
    'DELETE /api/coach/athletes/{athleteId}/habits/{habitId}': async (req, res) => {
      const coach = coachOnly(req, res); if (!coach) return;
      const access = actorLink(req, res, coach, coach.id, req.athleteId, true, 'b2b2c.habit.delete');
      if (!access) return;
      const habit = db.coachHabits.find(item => item.id === req.habitId && item.linkId === access.link.id && item.coachId === coach.id && item.athleteId === req.athleteId);
      if (!habit) return b2bError(res, 404, 'habit_not_found', 'habit not found');
      try { commit(db.coachMessages, db.coachHabits.filter(item => item.id !== habit.id), db.habitCheckins.filter(item => item.habitId !== habit.id)); }
      catch { return b2bError(res, 503, 'storage_unavailable', 'habit could not be deleted'); }
      audit(req, 'b2b2c.habit.delete', { user: coach, msg: habit.id });
      json(res, 200, { deleted: true, habit: clone(habit) });
    },
    'GET /api/athlete/habits': async (req, res) => {
      const athlete = readSession(req);
      if (!athlete) return b2bError(res, 401, 'not_signed_in', 'not signed in');
      const linksByCoach = new Map();
      for (const link of db.coachAthleteLinks.filter(item => item.athleteId === athlete.id)
        .sort((left, right) => linkTime(right) - linkTime(left))) {
        const existing = linksByCoach.get(link.coachId);
        if (!existing || link.status === 'active' && existing.status !== 'active') linksByCoach.set(link.coachId, link);
      }
      const selected = new Map([...linksByCoach.values()].map(link => [link.id, link]));
      const today = new Date().toISOString().slice(0, 10);
      const checkins = new Map(db.habitCheckins.filter(item => item.athleteId === athlete.id && item.date === today).map(item => [item.habitId, item]));
      const habits = db.coachHabits.filter(item => item.athleteId === athlete.id && item.status === 'active' && selected.has(item.linkId))
        .sort(newestHabit).map(item => ({ ...clone(item), checkin: clone(checkins.get(item.id) || null),
          relationship: { linkId: item.linkId, status: selected.get(item.linkId).status, readOnly: selected.get(item.linkId).status !== 'active' } }));
      json(res, 200, { date: today, habits });
    },
    'POST /api/athlete/habits/checkin': async (req, res) => {
      const athlete = readSession(req);
      if (!athlete) return b2bError(res, 401, 'not_signed_in', 'not signed in');
      if (throttle(req, res, athlete, 'checkin')) return;
      const input = validateCheckinInput(await readBody(req));
      if (!input) return b2bError(res, 400, 'invalid_checkin', 'invalid habit check-in');
      const habit = db.coachHabits.find(item => item.id === input.habitId && item.athleteId === athlete.id && item.status === 'active');
      if (!habit) return b2bError(res, 404, 'habit_not_found', 'active habit not found');
      const access = actorLink(req, res, athlete, habit.coachId, athlete.id, true, 'b2b2c.checkin.update');
      if (!access) return;
      if (access.link.id !== habit.linkId) return b2bError(res, 404, 'habit_not_found', 'active habit not found');
      const today = new Date().toISOString().slice(0, 10);
      if (input.date > today || input.date < dayString(habit.createdAt) || !scheduledOn(input.date, habit.frequency)) {
        return b2bError(res, 400, 'invalid_checkin_date', 'check-in date is outside the habit schedule');
      }
      const retained = compactedCopies();
      const index = retained.habitCheckins.findIndex(item => item.athleteId === athlete.id && item.habitId === habit.id && item.date === input.date);
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
    'GET /api/coach/athletes/{athleteId}/habits-summary': async (req, res) => {
      const coach = coachOnly(req, res); if (!coach) return;
      const access = actorLink(req, res, coach, coach.id, req.athleteId, false, 'b2b2c.habit.summary');
      if (!access) return;
      const habits = db.coachHabits.filter(item => item.linkId === access.link.id);
      const habitIds = new Set(habits.map(item => item.id));
      const summary = habitSummary(habits, db.habitCheckins.filter(item => habitIds.has(item.habitId)));
      json(res, 200, { summary, relationship: { linkId: access.link.id, status: access.link.status, readOnly: !!access.readOnly } });
    },
  };
  return routes;
}
