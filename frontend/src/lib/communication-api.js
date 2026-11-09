import { api } from './api.js'

const query = values => {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(values || {})) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value))
  }
  const encoded = params.toString()
  return encoded ? `?${encoded}` : ''
}

const json = (method, body) => ({ method, body: JSON.stringify(body) })

export const communicationApi = {
  inbox: ({ cursor, limit = 100 } = {}, opts) => api(`/api/messages/inbox${query({ cursor, limit })}`, opts),
  conversation: ({ side, counterpartId, linkId, cursor, limit = 50 }) => api(
    `${side === 'coach' ? `/api/coach/athletes/${counterpartId}/messages` : `/api/athlete/messages/${counterpartId}`}${query({ linkId, cursor, limit })}`,
  ),
  sendMessage: ({ side, counterpartId, content, category }) => api(
    side === 'coach' ? `/api/coach/athletes/${counterpartId}/messages` : `/api/athlete/messages/${counterpartId}`,
    json('POST', { content, category }),
  ),
  readMessage: messageId => api(`/api/messages/${messageId}/read`, json('POST', {})),
  readThrough: (linkId, throughMessageId) => api('/api/messages/read-through', json('POST', { linkId, throughMessageId })),
  coachHabits: ({ athleteId, linkId }) => api(`/api/coach/athletes/${athleteId}/habits${query({ linkId })}`),
  createHabit: (athleteId, habit) => api(`/api/coach/athletes/${athleteId}/habits`, json('POST', habit)),
  updateHabit: (athleteId, habitId, patch) => api(`/api/coach/athletes/${athleteId}/habits/${habitId}`, json('PATCH', patch)),
  deleteHabit: (athleteId, habitId) => api(`/api/coach/athletes/${athleteId}/habits/${habitId}`, { method: 'DELETE' }),
  athleteHabits: (timeZone, opts) => api(`/api/athlete/habits${query({ timezone: timeZone })}`, opts),
  checkin: (timeZone, input) => api(`/api/athlete/habits/checkin${query({ timezone: timeZone })}`, json('POST', input)),
  checkins: ({ side, athleteId, linkId, period, timeZone, cursor, limit = 50 }) => api(
    `${side === 'coach' ? `/api/coach/athletes/${athleteId}/checkins` : '/api/athlete/checkins'}${query({ linkId, period, timezone: timeZone, cursor, limit })}`,
  ),
  summary: ({ side, athleteId, linkId, period, timeZone }, opts) => api(
    `${side === 'coach' ? `/api/coach/athletes/${athleteId}/habits-summary` : '/api/athlete/habits-summary'}${query({ linkId, period, timezone: timeZone })}`,
    opts,
  ),
}

export function browserTimeZone() {
  const candidate = Intl.DateTimeFormat().resolvedOptions().timeZone
  if (typeof candidate === 'string' && candidate && candidate.length <= 100) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(0)
      return { value: candidate, fallback: false }
    } catch {}
  }
  return { value: 'UTC', fallback: true }
}

export function dateInTimeZone(timestamp = Date.now(), timeZone = browserTimeZone().value) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date(timestamp))
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]))
    return `${values.year}-${values.month}-${values.day}`
  } catch {
    return new Date(timestamp).toISOString().slice(0, 10)
  }
}
