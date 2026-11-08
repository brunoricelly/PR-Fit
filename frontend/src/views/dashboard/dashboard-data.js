export const loadingSource = (data = null) => ({ status: 'loading', data })

export const unavailableSource = (reason, data = null) => ({ status: 'unavailable', data, reason })

export const summariesUnavailableSource = error => ({
  status: 'error',
  data: [],
  error,
  requested: null,
  failed: null,
  countsKnown: false,
})

export function settledSource(result, normalize, isEmpty) {
  if (result.status === 'rejected') return { status: 'error', data: null, error: result.reason }
  try {
    const data = normalize(result.value)
    return { status: isEmpty(data) ? 'empty' : 'ok', data }
  } catch (error) {
    return { status: 'error', data: null, error }
  }
}

export const sourceSucceeded = source => source?.status === 'ok' || source?.status === 'empty'

const payloadObject = (payload, label) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new TypeError(`${label} inválido`)
  return payload
}

const payloadArray = (payload, key, label) => {
  const object = payloadObject(payload, label)
  if (!Array.isArray(object[key])) throw new TypeError(`${label} inválido`)
  return object[key]
}

const finiteNonNegative = value => Number.isFinite(value) && value >= 0

export function normalizeConversations(payload) {
  return payloadArray(payload, 'conversations', 'Inbox').map(item => {
    if (!item || typeof item !== 'object' || typeof item.linkId !== 'string'
      || !finiteNonNegative(item.unreadCount)) throw new TypeError('Conversa inválida')
    return item
  })
}

export function normalizeAppointments(payload) {
  return payloadArray(payload, 'items', 'Agenda').map(item => {
    if (!item || typeof item !== 'object' || (typeof item.id !== 'string' && typeof item.id !== 'number')
      || typeof item.startAt !== 'string' || !Number.isFinite(Date.parse(item.startAt))) {
      throw new TypeError('Compromisso inválido')
    }
    return item
  })
}

export function normalizeLinks(payload) {
  return payloadArray(payload, 'links', 'Vínculos').map(link => {
    if (!link || typeof link !== 'object' || typeof link.id !== 'string' || typeof link.status !== 'string'
      || !Array.isArray(link.scopes)) throw new TypeError('Vínculo inválido')
    return link
  })
}

export function normalizeMealPlan(payload) {
  const object = payloadObject(payload, 'Plano alimentar')
  const plan = object.mealPlan
  if (plan === null) return null
  if (!plan || typeof plan !== 'object' || typeof plan.id !== 'string' || typeof plan.title !== 'string'
    || !Array.isArray(plan.meals) || (plan.targetMacros != null && typeof plan.targetMacros !== 'object')) {
    throw new TypeError('Plano alimentar inválido')
  }
  return plan
}

const normalizeAdherenceRecord = record => {
  if (!record || typeof record !== 'object' || typeof record.mealPlanId !== 'string'
    || (record.mealsChecked != null && !Array.isArray(record.mealsChecked))
    || (record.waterDrunkMl != null && !finiteNonNegative(record.waterDrunkMl))) {
    throw new TypeError('Adesão alimentar inválida')
  }
  return record
}

export function normalizeMealAdherence(payload) {
  const object = payloadObject(payload, 'Adesão alimentar')
  if (object.adherenceRecords != null) {
    if (!Array.isArray(object.adherenceRecords)) throw new TypeError('Adesão alimentar inválida')
    return object.adherenceRecords.map(normalizeAdherenceRecord)
  }
  if (object.adherence == null) return []
  return [normalizeAdherenceRecord(object.adherence)]
}

export function normalizeHabits(payload) {
  return payloadArray(payload, 'habits', 'Hábitos').map(habit => {
    if (!habit || typeof habit !== 'object' || typeof habit.id !== 'string' || typeof habit.title !== 'string'
      || (habit.checkin != null && typeof habit.checkin !== 'object')) throw new TypeError('Hábito inválido')
    return habit
  })
}

export function normalizeSummary(payload) {
  const object = payloadObject(payload, 'Resumo de adesão')
  if (object.summary === null) return null
  const summary = object.summary
  if (!summary || typeof summary !== 'object' || !finiteNonNegative(summary.adherencePercent)
    || summary.adherencePercent > 100
    || !finiteNonNegative(summary.completedDays) || !finiteNonNegative(summary.scheduledDays)) {
    throw new TypeError('Resumo de adesão inválido')
  }
  return summary
}

export async function mapSettledWithConcurrency(items, limit, worker, shouldContinue = () => true) {
  const results = new Array(items.length)
  let nextIndex = 0
  const run = async () => {
    while (nextIndex < items.length && shouldContinue()) {
      const index = nextIndex++
      try {
        results[index] = { status: 'fulfilled', value: await worker(items[index], index) }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run))
  return results
}
