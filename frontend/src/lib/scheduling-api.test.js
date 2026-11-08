import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SchedulingError,
  ConflictError,
  ForbiddenError,
  GoneError,
  wrapSchedulingError,
  getCoachAvailability,
  updateCoachAvailability,
  getCoachAppointments,
  getCoachAthleteAppointments,
  getCoachAthleteSlots,
  createCoachAppointment,
  getCoachAppointment,
  rescheduleCoachAppointment,
  cancelCoachAppointment,
  recordAttendance,
  getAthleteSlots,
  getAthleteAppointments,
  getAthleteCoachAppointments,
  getAthleteAppointment,
  createAthleteAppointment,
  rescheduleAthleteAppointment,
  cancelAthleteAppointment,
  getReminderPreferences,
  updateReminderPreferences,
  getSchedulingReminderStatus,
} from './scheduling-api.js'

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
}))

vi.mock('./api.js', () => ({
  api: (...args) => mocks.api(...args),
}))

beforeEach(() => {
  vi.clearAllMocks()
})

describe('scheduling-api coach operations', () => {
  it('getCoachAvailability calls GET /api/coach/availability', async () => {
    const fakeResp = { availability: { id: 'cavl_1', timeZone: 'America/Sao_Paulo' } }
    mocks.api.mockResolvedValueOnce(fakeResp)

    const res = await getCoachAvailability()
    expect(mocks.api).toHaveBeenCalledWith('/api/coach/availability', undefined)
    expect(res).toEqual(fakeResp)
  })

  it('updateCoachAvailability serializes payload and handles rev argument', async () => {
    const fakeResp = { availability: { id: 'cavl_1', _rev: 2 }, futureConflicts: [] }
    mocks.api.mockResolvedValueOnce(fakeResp)

    const payload = { timeZone: 'America/Sao_Paulo', minNoticeHours: 4 }
    const res = await updateCoachAvailability(payload, 1)

    expect(mocks.api).toHaveBeenCalledWith('/api/coach/availability', {
      method: 'PUT',
      body: JSON.stringify({ timeZone: 'America/Sao_Paulo', minNoticeHours: 4, _rev: 1 }),
    })
    expect(res).toEqual(fakeResp)
  })

  it('updateCoachAvailability works when rev is already in payload', async () => {
    mocks.api.mockResolvedValueOnce({ ok: true })
    await updateCoachAvailability({ _rev: 3, windows: [] })

    expect(mocks.api).toHaveBeenCalledWith('/api/coach/availability', {
      method: 'PUT',
      body: JSON.stringify({ _rev: 3, windows: [] }),
    })
  })

  it('getCoachAppointments serializes query parameters and ignores empty values', async () => {
    mocks.api.mockResolvedValueOnce({ items: [], limit: 25, hasMore: false, nextCursor: null })
    await getCoachAppointments({
      from: '2026-12-01T00:00:00Z',
      to: '2026-12-31T23:59:59Z',
      status: 'scheduled',
      athleteId: 'ath_1',
      limit: 25,
      linkId: null,
      cursor: undefined,
      emptyField: '',
    })

    expect(mocks.api).toHaveBeenCalledWith(
      '/api/coach/appointments?from=2026-12-01T00%3A00%3A00Z&to=2026-12-31T23%3A59%3A59Z&status=scheduled&athleteId=ath_1&limit=25',
      undefined
    )
  })

  it('getCoachAthleteAppointments queries appointments scoped to an athlete', async () => {
    mocks.api.mockResolvedValueOnce({ items: [] })
    await getCoachAthleteAppointments('ath_test/1', { status: 'scheduled' })

    expect(mocks.api).toHaveBeenCalledWith(
      '/api/coach/athletes/ath_test%2F1/appointments?status=scheduled',
      undefined
    )
  })

  it('getCoachAthleteSlots queries availability slots for an athlete', async () => {
    mocks.api.mockResolvedValueOnce({ items: [], timeZone: 'UTC' })
    await getCoachAthleteSlots('ath_99', { date: '2026-12-10' })

    expect(mocks.api).toHaveBeenCalledWith(
      '/api/coach/athletes/ath_99/availability-slots?date=2026-12-10',
      undefined
    )
  })

  it('createCoachAppointment sends POST with JSON body', async () => {
    const payload = { startAt: '2026-12-10T14:00:00Z', title: 'PT Session' }
    mocks.api.mockResolvedValueOnce({ appointment: { id: 'capp_1' } })

    const res = await createCoachAppointment('ath_99', payload)
    expect(mocks.api).toHaveBeenCalledWith('/api/coach/athletes/ath_99/appointments', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
    expect(res).toEqual({ appointment: { id: 'capp_1' } })
  })

  it('getCoachAppointment fetches a single appointment', async () => {
    mocks.api.mockResolvedValueOnce({ appointment: { id: 'capp_10' } })
    await getCoachAppointment('capp_10')

    expect(mocks.api).toHaveBeenCalledWith('/api/coach/appointments/capp_10', undefined)
  })

  it('rescheduleCoachAppointment accepts object or startAt string', async () => {
    mocks.api.mockResolvedValue({ appointment: { id: 'capp_10' } })

    await rescheduleCoachAppointment('capp_10', { startAt: '2026-12-15T10:00:00Z' })
    expect(mocks.api).toHaveBeenLastCalledWith('/api/coach/appointments/capp_10/reschedule', {
      method: 'POST',
      body: JSON.stringify({ startAt: '2026-12-15T10:00:00Z' }),
    })

    await rescheduleCoachAppointment('capp_10', '2026-12-16T11:00:00Z')
    expect(mocks.api).toHaveBeenLastCalledWith('/api/coach/appointments/capp_10/reschedule', {
      method: 'POST',
      body: JSON.stringify({ startAt: '2026-12-16T11:00:00Z' }),
    })
  })

  it('cancelCoachAppointment accepts object or reason string', async () => {
    mocks.api.mockResolvedValue({ appointment: { id: 'capp_10' } })

    await cancelCoachAppointment('capp_10', { reason: 'Illness' })
    expect(mocks.api).toHaveBeenLastCalledWith('/api/coach/appointments/capp_10/cancel', {
      method: 'POST',
      body: JSON.stringify({ reason: 'Illness' }),
    })

    await cancelCoachAppointment('capp_10', 'Emergency')
    expect(mocks.api).toHaveBeenLastCalledWith('/api/coach/appointments/capp_10/cancel', {
      method: 'POST',
      body: JSON.stringify({ reason: 'Emergency' }),
    })
  })

  it('recordAttendance accepts object or status string', async () => {
    mocks.api.mockResolvedValue({ appointment: { id: 'capp_10' } })

    await recordAttendance('capp_10', { status: 'completed' })
    expect(mocks.api).toHaveBeenLastCalledWith('/api/coach/appointments/capp_10/attendance', {
      method: 'POST',
      body: JSON.stringify({ status: 'completed' }),
    })

    await recordAttendance('capp_10', 'no_show')
    expect(mocks.api).toHaveBeenLastCalledWith('/api/coach/appointments/capp_10/attendance', {
      method: 'POST',
      body: JSON.stringify({ status: 'no_show' }),
    })
  })
})

describe('scheduling-api athlete operations', () => {
  it('getAthleteSlots calls availability-slots with coachId and query', async () => {
    mocks.api.mockResolvedValueOnce({ items: [] })
    await getAthleteSlots('coach_1', { from: '2026-12-01', to: '2026-12-07' })

    expect(mocks.api).toHaveBeenCalledWith(
      '/api/athlete/coaches/coach_1/availability-slots?from=2026-12-01&to=2026-12-07',
      undefined
    )
  })

  it('getAthleteAppointments queries athlete appointments', async () => {
    mocks.api.mockResolvedValueOnce({ items: [] })
    await getAthleteAppointments({ status: 'scheduled' })

    expect(mocks.api).toHaveBeenCalledWith('/api/athlete/appointments?status=scheduled', undefined)
  })

  it('getAthleteCoachAppointments queries appointments with specific coach', async () => {
    mocks.api.mockResolvedValueOnce({ items: [] })
    await getAthleteCoachAppointments('coach_1', { limit: 10 })

    expect(mocks.api).toHaveBeenCalledWith(
      '/api/athlete/coaches/coach_1/appointments?limit=10',
      undefined
    )
  })

  it('getAthleteAppointment fetches detail', async () => {
    mocks.api.mockResolvedValueOnce({ appointment: { id: 'capp_20' } })
    await getAthleteAppointment('capp_20')

    expect(mocks.api).toHaveBeenCalledWith('/api/athlete/appointments/capp_20', undefined)
  })

  it('createAthleteAppointment books appointment with coach', async () => {
    const payload = { startAt: '2026-12-12T15:00:00Z', notes: 'First session' }
    mocks.api.mockResolvedValueOnce({ appointment: { id: 'capp_21' } })

    const res = await createAthleteAppointment('coach_1', payload)
    expect(mocks.api).toHaveBeenCalledWith('/api/athlete/coaches/coach_1/appointments', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
    expect(res).toEqual({ appointment: { id: 'capp_21' } })
  })

  it('rescheduleAthleteAppointment accepts payload object or string', async () => {
    mocks.api.mockResolvedValue({ appointment: { id: 'capp_21' } })

    await rescheduleAthleteAppointment('capp_21', { startAt: '2026-12-14T10:00:00Z' })
    expect(mocks.api).toHaveBeenLastCalledWith('/api/athlete/appointments/capp_21/reschedule', {
      method: 'POST',
      body: JSON.stringify({ startAt: '2026-12-14T10:00:00Z' }),
    })

    await rescheduleAthleteAppointment('capp_21', '2026-12-14T11:00:00Z')
    expect(mocks.api).toHaveBeenLastCalledWith('/api/athlete/appointments/capp_21/reschedule', {
      method: 'POST',
      body: JSON.stringify({ startAt: '2026-12-14T11:00:00Z' }),
    })
  })

  it('cancelAthleteAppointment accepts reason object or string', async () => {
    mocks.api.mockResolvedValue({ appointment: { id: 'capp_21' } })

    await cancelAthleteAppointment('capp_21', { reason: 'Schedule conflict' })
    expect(mocks.api).toHaveBeenLastCalledWith('/api/athlete/appointments/capp_21/cancel', {
      method: 'POST',
      body: JSON.stringify({ reason: 'Schedule conflict' }),
    })

    await cancelAthleteAppointment('capp_21', 'Traveling')
    expect(mocks.api).toHaveBeenLastCalledWith('/api/athlete/appointments/capp_21/cancel', {
      method: 'POST',
      body: JSON.stringify({ reason: 'Traveling' }),
    })
  })
})

describe('scheduling-api reminders and admin', () => {
  it('getReminderPreferences fetches reminder preferences', async () => {
    const fake = { preferences: { enabled: true, offsetsMinutes: [60] }, appointmentReminderStates: [] }
    mocks.api.mockResolvedValueOnce(fake)

    const res = await getReminderPreferences()
    expect(mocks.api).toHaveBeenCalledWith('/api/scheduling/reminder-preferences', undefined)
    expect(res).toEqual(fake)
  })

  it('updateReminderPreferences puts reminder preferences', async () => {
    const payload = { enabled: true, offsetsMinutes: [15, 60], timeZone: 'America/Sao_Paulo' }
    mocks.api.mockResolvedValueOnce({ preferences: payload })

    const res = await updateReminderPreferences(payload)
    expect(mocks.api).toHaveBeenCalledWith('/api/scheduling/reminder-preferences', {
      method: 'PUT',
      body: JSON.stringify(payload),
    })
    expect(res).toEqual({ preferences: payload })
  })

  it('getSchedulingReminderStatus fetches admin operational status', async () => {
    mocks.api.mockResolvedValueOnce({ backlog: { pending: 0 } })
    const res = await getSchedulingReminderStatus()
    expect(mocks.api).toHaveBeenCalledWith('/api/admin/scheduling-reminders/status', undefined)
    expect(res).toEqual({ backlog: { pending: 0 } })
  })
})

describe('scheduling-api error handling and mapping', () => {
  it('maps HTTP 409 to ConflictError', async () => {
    const httpErr = new Error('Schedule conflict detected')
    httpErr.status = 409
    httpErr.data = { error: 'Schedule conflict detected', code: 'double_booking', violations: [] }

    mocks.api.mockRejectedValueOnce(httpErr)

    await expect(getCoachAppointment('app_1')).rejects.toThrow(ConflictError)
    mocks.api.mockRejectedValueOnce(httpErr)
    try {
      await getCoachAppointment('app_1')
    } catch (e) {
      expect(e).toBeInstanceOf(ConflictError)
      expect(e).toBeInstanceOf(SchedulingError)
      expect(e.status).toBe(409)
      expect(e.code).toBe('double_booking')
      expect(e.message).toBe('Schedule conflict detected')
      expect(e.violations).toEqual([])
    }
  })

  it('maps HTTP 403 to ForbiddenError', async () => {
    const httpErr = new Error('Role forbidden')
    httpErr.status = 403
    httpErr.data = { error: 'Role forbidden', code: 'role_forbidden', violations: [] }

    mocks.api.mockRejectedValueOnce(httpErr)

    try {
      await getCoachAvailability()
    } catch (e) {
      expect(e).toBeInstanceOf(ForbiddenError)
      expect(e).toBeInstanceOf(SchedulingError)
      expect(e.status).toBe(403)
      expect(e.code).toBe('role_forbidden')
    }
  })

  it('maps HTTP 410 to GoneError', async () => {
    const httpErr = new Error('Relationship ended')
    httpErr.status = 410
    httpErr.data = { error: 'Relationship ended', code: 'relationship_gone', violations: [] }

    mocks.api.mockRejectedValueOnce(httpErr)

    try {
      await getAthleteAppointment('app_gone')
    } catch (e) {
      expect(e).toBeInstanceOf(GoneError)
      expect(e).toBeInstanceOf(SchedulingError)
      expect(e.status).toBe(410)
      expect(e.code).toBe('relationship_gone')
    }
  })

  it('maps HTTP 400 with violations to SchedulingError', async () => {
    const httpErr = new Error('Invalid appointment')
    httpErr.status = 400
    httpErr.data = {
      error: 'Invalid appointment',
      code: 'invalid_appointment',
      violations: [{ field: 'startAt', code: 'required' }],
    }

    mocks.api.mockRejectedValueOnce(httpErr)

    try {
      await createAthleteAppointment('c1', {})
    } catch (e) {
      expect(e).toBeInstanceOf(SchedulingError)
      expect(e).not.toBeInstanceOf(ConflictError)
      expect(e.status).toBe(400)
      expect(e.code).toBe('invalid_appointment')
      expect(e.violations).toEqual([{ field: 'startAt', code: 'required' }])
    }
  })

  it('preserves existing SchedulingError instances in wrapSchedulingError', () => {
    const custom = new ConflictError('Custom conflict', 'conflict_code', [{ field: 'a', code: 'b' }])
    expect(wrapSchedulingError(custom)).toBe(custom)
  })

  it('handles network or non-status errors gracefully', () => {
    const raw = new Error('Network timeout')
    const wrapped = wrapSchedulingError(raw)
    expect(wrapped).toBeInstanceOf(SchedulingError)
    expect(wrapped.status).toBe(0)
    expect(wrapped.message).toBe('Network timeout')
  })
})
