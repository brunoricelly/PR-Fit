import crypto from 'node:crypto';

const clone = value => structuredClone(value);
const iso = value => new Date(value).toISOString();
const cancelableStatuses = new Set(['pending', 'processing', 'retry']);
const leasedStatuses = new Set(['processing', 'delivery_started']);

export const REMINDER_DISPATCH_DEFAULTS = Object.freeze({
  tickMs: 10_000,
  leaseMs: 60_000,
  baseRetryMs: 30_000,
  maxRetryMs: 30 * 60_000,
  maxAttempts: 5,
  batchSize: 100,
  lockLeaseMs: 30_000,
  lockTimeoutMs: 5_000,
  lockRetryMs: 10,
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

function clearLease(item) {
  item.leaseId = null;
  item.leaseExpiresAt = null;
}

function clearDeliveryAttempt(item) {
  item.deliveryAttemptId = null;
  item.deliveryStartedAt = null;
}

function cancelItem(db, item, nowIso) {
  const state = stateFor(db, item);
  item.status = 'canceled';
  item.nextAttemptAt = null;
  clearLease(item);
  clearDeliveryAttempt(item);
  item.canceledAt = nowIso;
  item.updatedAt = nowIso;
  if (state && cancelableStatuses.has(state.status)) {
    state.status = 'canceled';
    state.updatedAt = nowIso;
  }
}

function deliveryOutcome(result) {
  if (result?.status === 'delivered') return 'delivered';
  if (result?.status === 'retry' && result.confirmed !== false) return 'retry';
  if (result?.status === 'failed' && result.confirmed === true) return 'failed';
  return 'delivery_uncertain';
}

export function createReminderDispatcher({
  transaction,
  getDb,
  commit,
  deliver,
  now = () => Date.now(),
  randomId = prefix => `${prefix}_${crypto.randomBytes(18).toString('base64url')}`,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  logger = console,
  config: configured = {},
}) {
  if (typeof deliver !== 'function' || (typeof transaction !== 'function' && (typeof getDb !== 'function' || typeof commit !== 'function'))) {
    throw new TypeError('deliver and either transaction or getDb/commit are required');
  }
  const config = { ...REMINDER_DISPATCH_DEFAULTS, ...configured };
  for (const [key, value] of Object.entries(config)) {
    if (!Number.isInteger(value) || value < 1) throw new RangeError(`${key} must be a positive integer`);
  }
  const counters = {
    claimed: 0, deliveryStarted: 0, delivered: 0, retried: 0, failed: 0, canceled: 0,
    deliveryUncertain: 0, saveErrors: 0, deliveryErrors: 0, ticks: 0, tickErrors: 0,
  };
  let timer = null;
  let bootImmediate = null;
  let activeTick = null;
  let lastTickAt = null;
  let lastSuccessAt = null;
  let lastErrorAt = null;

  const localTransaction = async transform => {
    const candidate = clone(getDb());
    const result = transform(candidate);
    if (result?.changed) await commit(candidate);
    return result;
  };
  const transact = transaction || localTransaction;

  const mutate = async transform => {
    let result;
    try { result = await transact(transform); }
    catch (error) { counters.saveErrors++; throw error; }
    for (const [name, count] of Object.entries(result?.counters || {})) counters[name] += count;
    return result || { changed: false };
  };

  const recoverExpiredLeases = nowMs => mutate(candidate => {
    const nowIso = iso(nowMs);
    let changed = false;
    const delta = { retried: 0, failed: 0, deliveryUncertain: 0 };
    for (const item of candidate.schedulingReminderOutbox) {
      if (!leasedStatuses.has(item.status) || Date.parse(item.leaseExpiresAt) > nowMs) continue;
      const state = stateFor(candidate, item);
      if (item.status === 'delivery_started') {
        item.status = 'delivery_uncertain';
        item.deliveryUncertainAt = nowIso;
        item.nextAttemptAt = null;
        clearLease(item);
        delta.deliveryUncertain++;
      } else {
        item.status = item.attempts >= config.maxAttempts ? 'failed' : 'retry';
        clearLease(item);
        clearDeliveryAttempt(item);
        if (item.status === 'failed') {
          item.failedAt = nowIso;
          item.nextAttemptAt = null;
          delta.failed++;
        } else {
          item.nextAttemptAt = iso(nowMs + retryDelay(item.attempts, config));
          delta.retried++;
        }
      }
      item.updatedAt = nowIso;
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
      const leaseId = randomId('lease');
      item.status = 'processing';
      item.attempts++;
      item.lastAttemptAt = nowIso;
      item.nextAttemptAt = null;
      item.leaseId = leaseId;
      item.leaseExpiresAt = iso(nowMs + config.leaseMs);
      clearDeliveryAttempt(item);
      item.updatedAt = nowIso;
      state.status = 'processing';
      state.updatedAt = nowIso;
      claims.push({
        id: item.id,
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

  const beginDelivery = (claim, nowMs) => mutate(candidate => {
    const item = candidate.schedulingReminderOutbox.find(candidateItem => candidateItem.id === claim.id);
    if (!item || item.status !== 'processing' || item.leaseId !== claim.leaseId) return { changed: false, delivery: null };
    const nowIso = iso(nowMs);
    if (!eligible(candidate, item)) {
      cancelItem(candidate, item, nowIso);
      return { changed: true, delivery: null, counters: { canceled: 1 } };
    }
    const state = stateFor(candidate, item);
    const deliveryAttemptId = randomId('delivery');
    item.status = 'delivery_started';
    item.deliveryAttemptId = deliveryAttemptId;
    item.deliveryStartedAt = nowIso;
    item.leaseExpiresAt = iso(nowMs + config.leaseMs);
    item.updatedAt = nowIso;
    state.status = 'delivery_started';
    state.updatedAt = nowIso;
    return {
      changed: true,
      delivery: { ...claim, deliveryAttemptId },
      counters: { deliveryStarted: 1 },
    };
  });

  const finalize = (delivery, outcome, nowMs) => mutate(candidate => {
    const item = candidate.schedulingReminderOutbox.find(candidateItem => candidateItem.id === delivery.id);
    if (!item || item.status !== 'delivery_started' || item.leaseId !== delivery.leaseId
        || item.deliveryAttemptId !== delivery.deliveryAttemptId) return { changed: false };
    const state = stateFor(candidate, item);
    const nowIso = iso(nowMs);
    clearLease(item);
    item.updatedAt = nowIso;
    if (outcome === 'delivered') {
      item.status = 'delivered';
      item.deliveredAt = nowIso;
      item.nextAttemptAt = null;
      return finishState({ delivered: 1 });
    }
    if (outcome === 'delivery_uncertain') {
      item.status = 'delivery_uncertain';
      item.deliveryUncertainAt = nowIso;
      item.nextAttemptAt = null;
      return finishState({ deliveryUncertain: 1 });
    }
    clearDeliveryAttempt(item);
    if (outcome === 'failed' || item.attempts >= config.maxAttempts) {
      item.status = 'failed';
      item.failedAt = nowIso;
      item.nextAttemptAt = null;
      return finishState({ failed: 1 });
    }
    item.status = 'retry';
    item.nextAttemptAt = iso(nowMs + retryDelay(item.attempts, config));
    return finishState({ retried: 1 });

    function finishState(delta) {
      if (state) { state.status = item.status; state.updatedAt = nowIso; }
      return { changed: true, counters: delta };
    }
  });

  const runTick = async () => {
    const tickNow = now();
    lastTickAt = iso(tickNow);
    counters.ticks++;
    try {
      await recoverExpiredLeases(tickNow);
      const claimed = await claimDue(tickNow);
      for (const claim of claimed.claims || []) {
        const started = await beginDelivery(claim, now());
        const delivery = started.delivery;
        if (!delivery) continue;
        let outcome;
        try { outcome = deliveryOutcome(await deliver({
          userId: delivery.userId,
          appointmentId: delivery.appointmentId,
          offsetMinutes: delivery.offsetMinutes,
          scheduledFor: delivery.scheduledFor,
          idempotencyKey: delivery.idempotencyKey,
          deliveryAttemptId: delivery.deliveryAttemptId,
        })); }
        catch { counters.deliveryErrors++; outcome = 'delivery_uncertain'; }
        try { await finalize(delivery, outcome, now()); }
        catch (error) {
          try { await finalize(delivery, 'delivery_uncertain', now()); } catch { /* recovery handles the persisted delivery_started lease */ }
          throw error;
        }
      }
      lastSuccessAt = iso(now());
      return { ...counters };
    } catch (error) {
      counters.tickErrors++;
      lastErrorAt = iso(now());
      throw error;
    }
  };

  const tick = () => {
    if (activeTick) return activeTick;
    activeTick = runTick().finally(() => { activeTick = null; });
    return activeTick;
  };

  const start = () => {
    if (timer) return;
    timer = setIntervalFn(() => tick().catch(() => logger.error('appointment reminder dispatcher tick failed')), config.tickMs);
    timer?.unref?.();
  };

  const startTick = () => {
    if (!timer) return;
    bootImmediate = setImmediate(() => {
      bootImmediate = null;
      tick().catch(() => logger.error('appointment reminder dispatcher boot tick failed'));
    });
    bootImmediate?.unref?.();
  };

  const stop = async () => {
    if (timer) { clearIntervalFn(timer); timer = null; }
    if (bootImmediate) { clearImmediate(bootImmediate); bootImmediate = null; }
    if (activeTick) await activeTick;
  };

  return {
    start,
    startTick,
    stop,
    tick,
    metrics: () => ({ ...counters }),
    status: () => ({
      running: !!timer,
      tickActive: !!activeTick,
      lastTickAt,
      lastSuccessAt,
      lastErrorAt,
      counters: { ...counters },
    }),
  };
}
