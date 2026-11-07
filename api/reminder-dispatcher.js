import crypto from 'node:crypto';

const clone = value => structuredClone(value);
const iso = value => new Date(value).toISOString();
const activeStatuses = new Set(['pending', 'processing', 'retry']);

export const REMINDER_DISPATCH_DEFAULTS = Object.freeze({
  tickMs: 10_000,
  leaseMs: 60_000,
  baseRetryMs: 30_000,
  maxRetryMs: 30 * 60_000,
  maxAttempts: 5,
  batchSize: 100,
});

function retryDelay(attempts, config) {
  return Math.min(config.maxRetryMs, config.baseRetryMs * (2 ** Math.max(0, attempts - 1)));
}

function dueAt(item) {
  return Date.parse(item.nextAttemptAt || item.scheduledFor);
}

function stateFor(db, item) {
  return db.appointmentReminderStates.find(state => state.id === item.reminderStateId);
}

function eligible(db, item) {
  const state = stateFor(db, item);
  const appointment = db.coachAppointments.find(candidate => candidate.id === item.appointmentId);
  const user = db.users.find(candidate => candidate.id === item.userId);
  const link = appointment && db.coachAthleteLinks.find(candidate => candidate.id === appointment.linkId);
  const preference = db.schedulingReminderPreferences.find(candidate => candidate.userId === item.userId);
  return !!state && state.appointmentId === item.appointmentId && state.userId === item.userId
    && state.offsetMinutes === item.offsetMinutes && state.scheduledFor === item.scheduledFor && state.status === item.status
    && !!appointment && appointment.status === 'scheduled'
    && (appointment.coachId === item.userId || appointment.athleteId === item.userId)
    && !!link && link.coachId === appointment.coachId && link.athleteId === appointment.athleteId
    && link.status === 'active' && Array.isArray(link.scopes) && link.scopes.includes('training')
    && !!user && !user.disabled && !!preference?.enabled && preference.offsetsMinutes.includes(item.offsetMinutes);
}

function cancelItem(db, item, nowIso) {
  const state = stateFor(db, item);
  item.status = 'canceled';
  item.nextAttemptAt = null;
  item.leaseId = null;
  item.leaseExpiresAt = null;
  item.canceledAt = nowIso;
  item.updatedAt = nowIso;
  if (state && activeStatuses.has(state.status)) {
    state.status = 'canceled';
    state.updatedAt = nowIso;
  }
}

export function createReminderDispatcher({
  getDb,
  commit,
  deliver,
  now = () => Date.now(),
  randomId = () => `lease_${crypto.randomBytes(18).toString('base64url')}`,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  logger = console,
  config: configured = {},
}) {
  if (typeof getDb !== 'function' || typeof commit !== 'function' || typeof deliver !== 'function') {
    throw new TypeError('getDb, commit, and deliver are required');
  }
  const config = { ...REMINDER_DISPATCH_DEFAULTS, ...configured };
  for (const [key, value] of Object.entries(config)) {
    if (!Number.isInteger(value) || value < 1) throw new RangeError(`${key} must be a positive integer`);
  }
  const counters = { claimed: 0, delivered: 0, retried: 0, failed: 0, canceled: 0, saveErrors: 0, deliveryErrors: 0 };
  let timer = null;
  let activeTick = null;

  const mutate = async transform => {
    const candidate = clone(getDb());
    const result = transform(candidate);
    if (!result?.changed) return result;
    try {
      await commit(candidate);
    } catch (error) {
      counters.saveErrors++;
      throw error;
    }
    for (const [name, count] of Object.entries(result.counters || {})) counters[name] += count;
    return result;
  };

  const recoverExpiredLeases = nowMs => mutate(candidate => {
    const nowIso = iso(nowMs);
    let changed = false;
    const delta = { retried: 0, failed: 0 };
    for (const item of candidate.schedulingReminderOutbox) {
      if (item.status !== 'processing' || Date.parse(item.leaseExpiresAt) > nowMs) continue;
      const state = stateFor(candidate, item);
      item.status = item.attempts >= config.maxAttempts ? 'failed' : 'retry';
      item.leaseId = null;
      item.leaseExpiresAt = null;
      item.updatedAt = nowIso;
      if (item.status === 'failed') {
        item.failedAt = nowIso;
        item.nextAttemptAt = null;
        delta.failed++;
      } else {
        item.nextAttemptAt = iso(nowMs + retryDelay(item.attempts, config));
        delta.retried++;
      }
      if (state) { state.status = item.status; state.updatedAt = nowIso; }
      changed = true;
    }
    return { changed, counters: delta };
  });

  const claimDue = nowMs => mutate(candidate => {
    const nowIso = iso(nowMs);
    const claims = [];
    let changed = false;
    let canceled = 0;
    let processed = 0;
    const candidates = candidate.schedulingReminderOutbox
      .filter(item => (item.status === 'pending' || item.status === 'retry') && dueAt(item) <= nowMs)
      .sort((left, right) => dueAt(left) - dueAt(right) || left.id.localeCompare(right.id));
    for (const item of candidates) {
      if (processed >= config.batchSize) break;
      processed++;
      if (!eligible(candidate, item)) {
        cancelItem(candidate, item, nowIso);
        canceled++;
        changed = true;
        continue;
      }
      const state = stateFor(candidate, item);
      const leaseId = randomId();
      item.status = 'processing';
      item.attempts++;
      item.lastAttemptAt = nowIso;
      item.nextAttemptAt = null;
      item.leaseId = leaseId;
      item.leaseExpiresAt = iso(nowMs + config.leaseMs);
      item.updatedAt = nowIso;
      state.status = 'processing';
      state.updatedAt = nowIso;
      claims.push({
        id: item.id,
        reminderStateId: item.reminderStateId,
        appointmentId: item.appointmentId,
        userId: item.userId,
        offsetMinutes: item.offsetMinutes,
        scheduledFor: item.scheduledFor,
        idempotencyKey: item.idempotencyKey,
        leaseId,
      });
      changed = true;
    }
    return { changed, claims, counters: { claimed: claims.length, canceled } };
  });

  const claimStillCurrent = claim => {
    const item = getDb().schedulingReminderOutbox.find(candidate => candidate.id === claim.id);
    return !!item && item.status === 'processing' && item.leaseId === claim.leaseId
      && item.appointmentId === claim.appointmentId && item.userId === claim.userId
      && item.offsetMinutes === claim.offsetMinutes && item.scheduledFor === claim.scheduledFor;
  };

  const finalize = (claim, result, nowMs) => mutate(candidate => {
    const item = candidate.schedulingReminderOutbox.find(candidateItem => candidateItem.id === claim.id);
    if (!item || item.status !== 'processing' || item.leaseId !== claim.leaseId) return { changed: false };
    const state = stateFor(candidate, item);
    const nowIso = iso(nowMs);
    item.leaseId = null;
    item.leaseExpiresAt = null;
    item.updatedAt = nowIso;
    if (result?.status === 'delivered') {
      item.status = 'delivered';
      item.deliveredAt = nowIso;
      item.nextAttemptAt = null;
      return finishState({ delivered: 1 });
    } else if (item.attempts >= config.maxAttempts) {
      item.status = 'failed';
      item.failedAt = nowIso;
      item.nextAttemptAt = null;
      return finishState({ failed: 1 });
    } else {
      item.status = 'retry';
      item.nextAttemptAt = iso(nowMs + retryDelay(item.attempts, config));
      return finishState({ retried: 1 });
    }
    function finishState(delta) {
      if (state) { state.status = item.status; state.updatedAt = nowIso; }
      return { changed: true, counters: delta };
    }
  });

  const runTick = async () => {
    const tickNow = now();
    await recoverExpiredLeases(tickNow);
    const claimed = await claimDue(tickNow);
    for (const claim of claimed.claims || []) {
      if (!claimStillCurrent(claim)) continue;
      let result;
      try {
        result = await deliver({
          userId: claim.userId,
          appointmentId: claim.appointmentId,
          offsetMinutes: claim.offsetMinutes,
          scheduledFor: claim.scheduledFor,
          idempotencyKey: claim.idempotencyKey,
        });
      } catch {
        counters.deliveryErrors++;
        result = { status: 'retry' };
      }
      await finalize(claim, result, now());
    }
    return { ...counters };
  };

  const tick = () => {
    if (activeTick) return activeTick;
    activeTick = runTick().finally(() => { activeTick = null; });
    return activeTick;
  };

  const start = () => {
    if (timer) return;
    timer = setIntervalFn(() => tick().catch(error => logger.error('appointment reminder dispatcher tick failed', error?.message || 'unknown')), config.tickMs);
    timer?.unref?.();
  };

  const stop = async () => {
    if (timer) { clearIntervalFn(timer); timer = null; }
    if (activeTick) await activeTick;
  };

  return {
    start,
    stop,
    tick,
    metrics: () => ({ ...counters }),
  };
}
