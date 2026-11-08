import { api } from './api.js'

export class SchedulingError extends Error {
  constructor(message, status = 0, code = 'unknown_error', violations = [], data = {}) {
    super(message || 'Scheduling error')
    this.name = this.constructor.name
    this.status = status
    this.code = code
    this.violations = Array.isArray(violations) ? violations : []
    this.data = data && typeof data === 'object' ? data : {}
  }
}

export class ConflictError extends SchedulingError {
  constructor(message, code = 'conflict', violations = [], data = {}) {
    super(message || 'Conflict', 409, code, violations, data)
  }
}

export class ForbiddenError extends SchedulingError {
  constructor(message, code = 'forbidden', violations = [], data = {}) {
    super(message || 'Forbidden', 403, code, violations, data)
  }
}

export class GoneError extends SchedulingError {
  constructor(message, code = 'gone', violations = [], data = {}) {
    super(message || 'Gone', 410, code, violations, data)
  }
}

export function wrapSchedulingError(err) {
  if (err instanceof SchedulingError) return err
  const status = Number(err?.status) || 0
  const data = err?.data && typeof err.data === 'object' ? err.data : {}
  const code = data.code || err?.code || (status === 401 ? 'not_signed_in' : 'http_error')
  const message = data.error || err?.message || 'Scheduling request failed'
  const violations = Array.isArray(data.violations) ? data.violations : []

  if (status === 409) return new ConflictError(message, code, violations, data)
  if (status === 403) return new ForbiddenError(message, code, violations, data)
  if (status === 410) return new GoneError(message, code, violations, data)
  return new SchedulingError(message, status, code, violations, data)
}

function queryString(params) {
  if (!params || typeof params !== 'object') return ''
  const entries = Object.entries(params)
    .filter(([_, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
  return entries.length ? `?${entries.join('&')}` : ''
}

async function request(path, opts) {
  try {
    return await api(path, opts)
  } catch (err) {
    throw wrapSchedulingError(err)
  }
}

// Coach methods
export async function getCoachAvailability(opts) {
  return request('/api/coach/availability', opts)
}

export async function updateCoachAvailability(payload, rev) {
  const body = Object.assign({}, payload)
  if (rev !== undefined && rev !== null) {
    body._rev = rev
  }
  return request('/api/coach/availability', {
    method: 'PUT',
    body: JSON.stringify(body),
  })
}

export async function getCoachAppointments(params, opts) {
  return request(`/api/coach/appointments${queryString(params)}`, opts)
}

export async function getCoachAthleteAppointments(athleteId, params) {
  return request(`/api/coach/athletes/${encodeURIComponent(athleteId)}/appointments${queryString(params)}`)
}

export async function getCoachAthleteSlots(athleteId, params) {
  return request(`/api/coach/athletes/${encodeURIComponent(athleteId)}/availability-slots${queryString(params)}`)
}

export async function createCoachAppointment(athleteId, payload) {
  return request(`/api/coach/athletes/${encodeURIComponent(athleteId)}/appointments`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export async function getCoachAppointment(appointmentId) {
  return request(`/api/coach/appointments/${encodeURIComponent(appointmentId)}`)
}

export async function rescheduleCoachAppointment(appointmentId, payload) {
  const body = typeof payload === 'string' ? { startAt: payload } : payload
  return request(`/api/coach/appointments/${encodeURIComponent(appointmentId)}/reschedule`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function cancelCoachAppointment(appointmentId, payload) {
  const body = typeof payload === 'string' ? { reason: payload } : payload
  return request(`/api/coach/appointments/${encodeURIComponent(appointmentId)}/cancel`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function recordAttendance(appointmentId, payload) {
  const body = typeof payload === 'string' ? { status: payload } : payload
  return request(`/api/coach/appointments/${encodeURIComponent(appointmentId)}/attendance`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

// Athlete methods
export async function getAthleteSlots(coachId, params) {
  return request(`/api/athlete/coaches/${encodeURIComponent(coachId)}/availability-slots${queryString(params)}`)
}

export async function getAthleteAppointments(params, opts) {
  return request(`/api/athlete/appointments${queryString(params)}`, opts)
}

export async function getAthleteCoachAppointments(coachId, params) {
  return request(`/api/athlete/coaches/${encodeURIComponent(coachId)}/appointments${queryString(params)}`)
}

export async function getAthleteAppointment(appointmentId) {
  return request(`/api/athlete/appointments/${encodeURIComponent(appointmentId)}`)
}

export async function createAthleteAppointment(coachId, payload) {
  return request(`/api/athlete/coaches/${encodeURIComponent(coachId)}/appointments`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export async function rescheduleAthleteAppointment(appointmentId, payload) {
  const body = typeof payload === 'string' ? { startAt: payload } : payload
  return request(`/api/athlete/appointments/${encodeURIComponent(appointmentId)}/reschedule`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function cancelAthleteAppointment(appointmentId, payload) {
  const body = typeof payload === 'string' ? { reason: payload } : payload
  return request(`/api/athlete/appointments/${encodeURIComponent(appointmentId)}/cancel`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

// Shared reminder methods
export async function getReminderPreferences() {
  return request('/api/scheduling/reminder-preferences')
}

export async function updateReminderPreferences(payload) {
  return request('/api/scheduling/reminder-preferences', {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
}

// Admin status
export async function getSchedulingReminderStatus() {
  return request('/api/admin/scheduling-reminders/status')
}
