export const FIRST_STEPS_STORAGE_KEY = 'prfit_first_steps'
export const FIRST_STEPS_VERSION = 1

const ROLES = new Set(['coach', 'athlete'])
const MAX_ENTRIES = 100
const MAX_COMPLETED = 16
const CHANGE_EVENT = 'prfit_first_steps_change'

const emptyPayload = () => ({ version: FIRST_STEPS_VERSION, entries: [] })

const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const validText = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max

function validateEntry(entry) {
  if (!plainObject(entry) || !validText(entry.userId, 256) || !ROLES.has(entry.role)
    || typeof entry.dismissed !== 'boolean' || !Array.isArray(entry.completed)
    || entry.completed.length > MAX_COMPLETED || !Number.isFinite(entry.updatedAt) || entry.updatedAt < 0) return null
  const completed = []
  const seen = new Set()
  for (const item of entry.completed) {
    if (!validText(item, 64) || seen.has(item)) return null
    seen.add(item)
    completed.push(item)
  }
  return { userId: entry.userId, role: entry.role, dismissed: entry.dismissed, completed, updatedAt: entry.updatedAt }
}

export function validateFirstStepsPayload(value) {
  if (!plainObject(value) || value.version !== FIRST_STEPS_VERSION || !Array.isArray(value.entries)
    || value.entries.length > MAX_ENTRIES) return null
  const entries = []
  const scopes = new Set()
  for (const valueEntry of value.entries) {
    const entry = validateEntry(valueEntry)
    if (!entry) return null
    const scope = JSON.stringify([entry.userId, entry.role])
    if (scopes.has(scope)) return null
    scopes.add(scope)
    entries.push(entry)
  }
  return { version: FIRST_STEPS_VERSION, entries }
}

export function migrateFirstStepsPayload(value) {
  if (!plainObject(value)) return null
  if (value.version === FIRST_STEPS_VERSION) return validateFirstStepsPayload(value)
  return null
}

const storageOrNull = storage => {
  if (storage) return storage
  try { return typeof localStorage === 'undefined' ? null : localStorage } catch { return null }
}

export function readFirstStepsPayload(storage) {
  const target = storageOrNull(storage)
  if (!target) return emptyPayload()
  try {
    const raw = target.getItem(FIRST_STEPS_STORAGE_KEY)
    if (raw === null) return emptyPayload()
    return migrateFirstStepsPayload(JSON.parse(raw)) || emptyPayload()
  } catch {
    return emptyPayload()
  }
}

export function getFirstStepsState(userId, role, storage) {
  if (!validText(String(userId || ''), 256) || !ROLES.has(role)) {
    return { dismissed: false, completed: [] }
  }
  const entry = readFirstStepsPayload(storage).entries.find(item => item.userId === String(userId) && item.role === role)
  return entry ? { dismissed: entry.dismissed, completed: [...entry.completed] } : { dismissed: false, completed: [] }
}

function notify(userId, role) {
  try {
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { userId, role } }))
  } catch {}
}

function updateFirstStepsState(userId, role, update, storage) {
  const normalizedUserId = String(userId || '')
  if (!validText(normalizedUserId, 256) || !ROLES.has(role)) return { dismissed: false, completed: [] }
  const target = storageOrNull(storage)
  const payload = readFirstStepsPayload(target)
  const index = payload.entries.findIndex(item => item.userId === normalizedUserId && item.role === role)
  const current = index >= 0 ? payload.entries[index] : {
    userId: normalizedUserId,
    role,
    dismissed: false,
    completed: [],
    updatedAt: 0,
  }
  const nextState = update({ dismissed: current.dismissed, completed: [...current.completed] })
  const next = {
    userId: normalizedUserId,
    role,
    dismissed: Boolean(nextState.dismissed),
    completed: [...new Set(nextState.completed)].filter(item => validText(item, 64)).slice(0, MAX_COMPLETED),
    updatedAt: Date.now(),
  }
  if (index >= 0) payload.entries[index] = next
  else payload.entries.push(next)
  if (payload.entries.length > MAX_ENTRIES) {
    payload.entries.sort((left, right) => right.updatedAt - left.updatedAt)
    payload.entries.length = MAX_ENTRIES
  }
  try { target?.setItem(FIRST_STEPS_STORAGE_KEY, JSON.stringify(payload)) } catch {}
  notify(normalizedUserId, role)
  return { dismissed: next.dismissed, completed: [...next.completed] }
}

export function setFirstStepsDismissed(userId, role, dismissed, storage) {
  return updateFirstStepsState(userId, role, state => ({ ...state, dismissed: Boolean(dismissed) }), storage)
}

export function setFirstStepCompleted(userId, role, stepId, completed = true, storage) {
  if (!validText(stepId, 64)) return getFirstStepsState(userId, role, storage)
  return updateFirstStepsState(userId, role, state => ({
    ...state,
    completed: completed
      ? [...state.completed, stepId]
      : state.completed.filter(item => item !== stepId),
  }), storage)
}

export const FIRST_STEPS_CHANGE_EVENT = CHANGE_EVENT
