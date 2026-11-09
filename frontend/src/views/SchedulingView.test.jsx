// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { guardReactWarnings } from '../test/react-warning-guard.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  user: null,
  calls: [],
  answers: {},
  toast: vi.fn(),
  pullState: vi.fn(),
}))

vi.mock('../store/useStore.js', () => {
  const snap = () => ({ user: mocks.user, pullState: mocks.pullState })
  const useStore = selector => (selector ? selector(snap()) : snap())
  useStore.getState = snap
  return { useStore }
})

vi.mock('../store/useUI.js', () => {
  const snap = () => ({ toast: mocks.toast })
  const useUI = selector => (selector ? selector(snap()) : snap())
  useUI.getState = snap
  return { useUI }
})

vi.mock('../lib/api.js', () => ({
  api: vi.fn(async (path, opts) => {
    const body = opts?.body ? JSON.parse(opts.body) : null
    mocks.calls.push({ path, method: opts?.method || 'GET', body })
    const answer = mocks.answers[path] ?? mocks.answers[path.split('?')[0]]
    if (answer instanceof Error) throw answer
    if (typeof answer === 'function') return answer(body, path)
    return answer ?? {}
  }),
}))

import SchedulingView, {
  AccessibleModal,
  CoachAvailabilityEditor,
  CoachAppointmentsView,
  AthleteBookingView,
  AthleteAppointmentsView,
  ReminderPreferencesView,
  RescheduleModal,
  CreateCoachAppointmentModal,
  CancelModal,
  NextAppointmentCard,
  civilTimeToIso,
  formatDateOnly,
  formatDayHeader,
} from './SchedulingView.jsx'

let host, root, assertNoReactWarnings

function LocationProbe() {
  const location = useLocation()
  mocks.location = `${location.pathname}${location.search}`
  return null
}

beforeEach(() => {
  Object.assign(mocks, {
    user: null,
    calls: [],
    answers: {},
    toast: vi.fn(),
    pullState: vi.fn(),
    location: '',
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  assertNoReactWarnings = guardReactWarnings()
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  assertNoReactWarnings()
})

const settle = () => act(async () => {
  await Promise.resolve()
  await new Promise(resolve => queueMicrotask(resolve))
})

const mount = async (component, entry = '/scheduling') => {
  act(() => {
    root.render(
      <MemoryRouter initialEntries={[entry]}>
        <LocationProbe />
        {component}
      </MemoryRouter>
    )
  })
  await settle()
}

const button = (label, container = host) =>
  [...container.querySelectorAll('button')].find(item => item.textContent.trim().includes(label))

const input = (name, container = host) =>
  container.querySelector(`input[name="${name}"], textarea[name="${name}"], select[name="${name}"]`)

const changeInput = async (element, value) => {
  await act(async () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      element instanceof HTMLInputElement ? HTMLInputElement.prototype :
      element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype :
      HTMLSelectElement.prototype,
      'value'
    )
    descriptor?.set?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await settle()
}

describe('SchedulingView - Coach Availability', () => {
  it('loads coach availability and allows saving updated windows with _rev (CAS)', async () => {
    mocks.user = { id: 'coach_1', name: 'Coach Bruno', profile: { kind: 'coach' } }
    const initialAvailability = {
      id: 'cavl_1',
      coachId: 'coach_1',
      timeZone: 'America/Sao_Paulo',
      sessionDurationMinutes: 60,
      bufferMinutes: 10,
      minNoticeHours: 2,
      maxAdvanceDays: 30,
      windows: [
        { dayOfWeek: 1, start: '09:00', end: '17:00' },
      ],
      exceptions: [],
      _rev: 3,
    }
    mocks.answers['/api/coach/availability'] = { availability: initialAvailability }
    mocks.answers['/api/coach/athletes'] = { links: [] }

    await mount(<CoachAvailabilityEditor />)

    expect(host.textContent).toContain('Availability')
    expect(host.querySelector('input[name="sessionDurationMinutes"]').value).toBe('60')
    expect(host.querySelector('input[name="bufferMinutes"]').value).toBe('10')

    // Add window to Tuesday (day 2)
    const tuesdayRow = [...host.querySelectorAll('.pro-sched-day-row')].find(r => r.textContent.includes('Tuesday'))
    const addBtn = button('Add window', tuesdayRow)
    await act(async () => { addBtn.click() })
    await settle()

    // Add date exception
    await act(async () => { button('Add exception').click() })
    await settle()
    expect(host.textContent).toContain('Blackout date')

    // Save availability
    let putBody = null
    mocks.answers['/api/coach/availability'] = (body) => {
      putBody = body
      return {
        availability: { ...initialAvailability, ...body, _rev: 4 },
        futureConflicts: [],
      }
    }

    await act(async () => { button('Save availability').click() })
    await settle()

    expect(putBody).toBeTruthy()
    expect(putBody._rev).toBe(3)
    expect(putBody.windows.length).toBe(2)
    expect(putBody.exceptions.length).toBe(1)
    expect(mocks.toast).toHaveBeenCalledWith('Availability saved.')
  })

  it('handles revision conflict (409) and displays future conflicts alert', async () => {
    mocks.user = { id: 'coach_1', name: 'Coach Bruno', profile: { kind: 'coach' } }
    mocks.answers['/api/coach/availability'] = {
      availability: {
        id: 'cavl_1',
        coachId: 'coach_1',
        timeZone: 'America/Sao_Paulo',
        sessionDurationMinutes: 60,
        bufferMinutes: 0,
        minNoticeHours: 2,
        maxAdvanceDays: 30,
        windows: [{ dayOfWeek: 1, start: '09:00', end: '12:00' }],
        exceptions: [],
        _rev: 2,
      },
    }

    await mount(<CoachAvailabilityEditor />)

    // Simulate 409 revision conflict on save
    mocks.answers['/api/coach/availability'] = () => {
      const err = new Error('revision conflict')
      err.status = 409
      err.data = { code: 'revision_conflict' }
      throw err
    }

    await act(async () => { button('Save availability').click() })
    await settle()

    expect(mocks.toast).toHaveBeenCalledWith(
      'Revision conflict. Your availability was updated elsewhere. Please refresh and try again.'
    )

    // Next, simulate future conflicts returned
    mocks.answers['/api/coach/availability'] = () => ({
      availability: {
        id: 'cavl_1',
        coachId: 'coach_1',
        windows: [],
        exceptions: [],
        _rev: 3,
      },
      futureConflicts: ['appt_1', 'appt_2'],
    })

    await act(async () => { button('Save availability').click() })
    await settle()

    expect(host.textContent).toContain('Future conflicts detected: 2 appointment(s) may be impacted.')
  })
})

describe('SchedulingView - Coach Appointments', () => {
  const sampleAppointment = {
    id: 'appt_1',
    linkId: 'link_1',
    coachId: 'coach_1',
    athleteId: 'athlete_1',
    type: 'in_person',
    title: 'Hypertrophy Session',
    notes: 'Leg day focus',
    startAt: '2026-11-10T14:00:00.000Z',
    endAt: '2026-11-10T15:00:00.000Z',
    durationMinutes: 60,
    timeZone: 'UTC',
    localDate: '2026-11-10',
    status: 'scheduled',
    location: 'OpenGym HQ',
    coach: { id: 'coach_1', name: 'Coach Bruno' },
    athlete: { id: 'athlete_1', name: 'Atleta Carlos' },
    lifecycle: {
      historical: false,
      readOnly: false,
      allowedActions: ['reschedule', 'cancel', 'attendance'],
    },
  }

  it('renders coach appointments with filters, details modal, and actions', async () => {
    mocks.user = { id: 'coach_1', name: 'Coach Bruno', profile: { kind: 'coach' } }
    const links = [{ id: 'link_1', athlete: { id: 'athlete_1', name: 'Atleta Carlos' } }]
    mocks.answers['/api/coach/appointments'] = {
      items: [sampleAppointment],
      hasMore: false,
      nextCursor: null,
    }

    await mount(<CoachAppointmentsView links={links} />)

    expect(host.textContent).toContain('Hypertrophy Session')
    expect(host.textContent).toContain('Atleta Carlos')
    expect(host.textContent).toContain('Scheduled')

    // Open detail modal
    await act(async () => { button('Session details').click() })
    await settle()

    const modal = host.querySelector('[role="dialog"]')
    expect(modal).not.toBeNull()
    expect(modal.getAttribute('aria-modal')).toBe('true')
    expect(modal.textContent).toContain('Hypertrophy Session')
    expect(modal.textContent).toContain('OpenGym HQ')
    expect(modal.textContent).toContain('Leg day focus')

    // Close modal via close button
    const closeBtn = modal.querySelector('.pro-modal-close')
    await act(async () => { closeBtn.click() })
    await settle()
    expect(host.querySelector('[role="dialog"]')).toBeNull()

    // Test toggle to Calendar View
    const calToggleBtn = host.querySelector('button[aria-label="Calendar view"]')
    await act(async () => { calToggleBtn.click() })
    await settle()
    expect(host.querySelector('table[role="table"]')).not.toBeNull()
    expect(host.querySelector('table').textContent).toContain('Atleta Carlos')
  })

  it('allows rescheduling and canceling a coach appointment', async () => {
    mocks.user = { id: 'coach_1', name: 'Coach Bruno', profile: { kind: 'coach' } }
    mocks.answers['/api/coach/appointments'] = {
      items: [sampleAppointment],
      hasMore: false,
    }

    await mount(<CoachAppointmentsView links={[{ id: 'link_1', athlete: { id: 'athlete_1', name: 'Atleta Carlos' } }]} />)

    // Open reschedule modal
    await act(async () => { button('Reschedule').click() })
    await settle()

    let rescheduleBody = null
    mocks.answers['/api/coach/appointments/appt_1/reschedule'] = body => {
      rescheduleBody = body
      return { appointment: { ...sampleAppointment, startAt: body.startAt } }
    }

    const modal = host.querySelector('[role="dialog"]')
    await changeInput(input('rescheduleDate', modal), '2026-11-12')
    await changeInput(input('rescheduleTime', modal), '10:00')

    const confirmReschedule = button('Reschedule', modal)
    await act(async () => { confirmReschedule.click() })
    await settle()

    expect(rescheduleBody).toBeTruthy()
    expect(rescheduleBody.startAt).toContain('2026-11-12')
    expect(mocks.toast).toHaveBeenCalledWith('Appointment rescheduled.')

    // Open cancel modal
    await act(async () => { button('Cancel session').click() })
    await settle()

    const cancelModal = host.querySelector('[role="dialog"]')
    await changeInput(input('cancelReason', cancelModal), 'Coach traveling')

    let cancelBody = null
    mocks.answers['/api/coach/appointments/appt_1/cancel'] = body => {
      cancelBody = body
      return { appointment: { ...sampleAppointment, status: 'canceled' } }
    }

    await act(async () => { button('Cancel appointment', cancelModal).click() })
    await settle()

    expect(cancelBody).toEqual({ reason: 'Coach traveling' })
    expect(mocks.toast).toHaveBeenCalledWith('Appointment canceled.')
  })

  it('allows creating a new session with an athlete using availability slots', async () => {
    mocks.user = { id: 'coach_1', name: 'Coach Bruno', profile: { kind: 'coach' } }
    const links = [{ id: 'link_1', athlete: { id: 'athlete_1', name: 'Atleta Carlos' } }]
    mocks.answers['/api/coach/appointments'] = { items: [] }
    mocks.answers['/api/coach/athletes/athlete_1/availability-slots'] = {
      items: [
        {
          startAt: '2026-11-15T10:00:00.000Z',
          endAt: '2026-11-15T11:00:00.000Z',
          durationMinutes: 60,
          timeZone: 'UTC',
          localDate: '2026-11-15',
        },
      ],
      timeZone: 'UTC',
    }

    await mount(<CoachAppointmentsView links={links} />)

    await act(async () => { button('New session').click() })
    await settle()

    const createModal = host.querySelector('[role="dialog"]')
    expect(createModal).not.toBeNull()
    expect(createModal.textContent).toContain('10:00')

    // Click slot button
    const slotBtn = createModal.querySelector('.pro-sched-slot-btn')
    await act(async () => { slotBtn.click() })
    await settle()
    expect(slotBtn.className).toContain('selected')

    let createBody = null
    mocks.answers['/api/coach/athletes/athlete_1/appointments'] = body => {
      createBody = body
      return { appointment: { ...sampleAppointment, ...body, id: 'appt_new' } }
    }

    await act(async () => { button('Confirm booking', createModal).click() })
    await settle()

    expect(createBody).toBeTruthy()
    expect(createBody.startAt).toBe('2026-11-15T10:00:00.000Z')
    expect(mocks.toast).toHaveBeenCalledWith('Session booked successfully.')
  })

  it('records attendance only when session has ended (now >= endAt)', async () => {
    const pastAppointment = {
      ...sampleAppointment,
      id: 'appt_past',
      startAt: '2020-01-01T10:00:00.000Z',
      endAt: '2020-01-01T11:00:00.000Z',
    }

    mocks.user = { id: 'coach_1', name: 'Coach Bruno', profile: { kind: 'coach' } }
    mocks.answers['/api/coach/appointments'] = { items: [pastAppointment] }

    await mount(<CoachAppointmentsView links={[{ id: 'link_1', athlete: { id: 'athlete_1', name: 'Atleta Carlos' } }]} />)

    const attendBtn = button('Record attendance')
    expect(attendBtn).toBeDefined()

    await act(async () => { attendBtn.click() })
    await settle()

    const modal = host.querySelector('[role="dialog"]')
    expect(modal).not.toBeNull()

    let attendBody = null
    mocks.answers['/api/coach/appointments/appt_past/attendance'] = body => {
      attendBody = body
      return { appointment: { ...pastAppointment, status: 'completed' } }
    }

    await act(async () => { button('Record attendance', modal).click() })
    await settle()

    expect(attendBody).toEqual({ status: 'completed' })
    expect(mocks.toast).toHaveBeenCalledWith('Attendance recorded.')
  })
})

describe('SchedulingView - Athlete Booking and Appointments', () => {
  it('allows athlete to browse coach slots, book session, and handles 409 conflict', async () => {
    mocks.user = { id: 'athlete_1', name: 'Atleta Carlos', profile: { kind: 'athlete' } }
    const links = [{ id: 'link_1', coach: { id: 'coach_1', name: 'Coach Bruno' } }]
    mocks.answers['/api/athlete/coaches/coach_1/availability-slots'] = {
      items: [
        {
          startAt: '2026-11-20T09:00:00.000Z',
          endAt: '2026-11-20T10:00:00.000Z',
          durationMinutes: 60,
          timeZone: 'UTC',
          localDate: '2026-11-20',
        },
      ],
      timeZone: 'UTC',
    }

    await mount(<AthleteBookingView links={links} />)

    expect(host.textContent).toContain('Available slots')
    expect(host.textContent).toContain('09:00')

    // Click slot
    await act(async () => { host.querySelector('.pro-sched-slot-btn').click() })
    await settle()

    const confirmModal = host.querySelector('[role="dialog"]')
    expect(confirmModal).not.toBeNull()

    // Simulate 409 conflict
    mocks.answers['/api/athlete/coaches/coach_1/appointments'] = () => {
      const err = new Error('slot conflict')
      err.status = 409
      err.data = { code: 'conflict' }
      throw err
    }

    await act(async () => { button('Confirm booking', confirmModal).click() })
    await settle()

    expect(mocks.toast).toHaveBeenCalledWith('This slot is no longer available. Please select another time.')
    expect(host.querySelector('[role="dialog"]')).toBeNull()
  })

  it('displays athlete appointments and allows rescheduling and cancellation', async () => {
    mocks.user = { id: 'athlete_1', name: 'Atleta Carlos', profile: { kind: 'athlete' } }
    const appt = {
      id: 'appt_ath_1',
      linkId: 'link_1',
      coachId: 'coach_1',
      athleteId: 'athlete_1',
      type: 'online',
      title: 'Online Coaching Consultation',
      meetingUrl: 'https://meet.jit.si/coach-session',
      startAt: '2026-11-22T15:00:00.000Z',
      endAt: '2026-11-22T16:00:00.000Z',
      durationMinutes: 60,
      timeZone: 'UTC',
      localDate: '2026-11-22',
      status: 'scheduled',
      coach: { id: 'coach_1', name: 'Coach Bruno' },
      lifecycle: {
        historical: false,
        readOnly: false,
        allowedActions: ['reschedule', 'cancel'],
      },
    }
    mocks.answers['/api/athlete/appointments'] = { items: [appt] }

    await mount(<AthleteAppointmentsView />)

    expect(host.textContent).toContain('Online Coaching Consultation')
    expect(host.textContent).toContain('Coach Bruno')
    expect(host.textContent).toContain('https://meet.jit.si/coach-session')

    // Cancel appointment
    await act(async () => { button('Cancel session').click() })
    await settle()

    const cancelModal = host.querySelector('[role="dialog"]')
    await changeInput(input('cancelReason', cancelModal), 'Sick')

    let cancelBody = null
    mocks.answers['/api/athlete/appointments/appt_ath_1/cancel'] = body => {
      cancelBody = body
      return { appointment: { ...appt, status: 'canceled' } }
    }

    await act(async () => { button('Cancel appointment', cancelModal).click() })
    await settle()

    expect(cancelBody).toEqual({ reason: 'Sick' })
    expect(mocks.toast).toHaveBeenCalledWith('Appointment canceled.')
  })
})

describe('SchedulingView - Reminder Preferences', () => {
  it('loads reminder preferences and updates offsets and enable switch', async () => {
    mocks.user = { id: 'user_1', name: 'User', profile: { kind: 'coach' } }
    mocks.answers['/api/scheduling/reminder-preferences'] = {
      userId: 'user_1',
      enabled: true,
      offsetsMinutes: [60],
      timeZone: 'America/Sao_Paulo',
      updatedAt: '2026-11-01T00:00:00.000Z',
    }

    await mount(<ReminderPreferencesView />)

    expect(host.textContent).toContain('Reminders')
    expect(host.textContent).toContain('Enable reminders')
    expect(host.textContent).toContain('1 hour before')

    // Toggle 15 minutes before
    const check15 = [...host.querySelectorAll('.pro-sched-offsets-grid label input')][0]
    await act(async () => { check15.click() })
    await settle()

    let putBody = null
    mocks.answers['/api/scheduling/reminder-preferences'] = body => {
      putBody = body
      return { ...body, userId: 'user_1', updatedAt: '2026-11-08T00:00:00.000Z' }
    }

    await act(async () => { button('Save reminders').click() })
    await settle()

    expect(putBody).toBeTruthy()
    expect(putBody.offsetsMinutes).toEqual([15, 60])
    expect(mocks.toast).toHaveBeenCalledWith('Reminder preferences saved.')
  })
})

describe('SchedulingView - Full View & Accessibility', () => {
  it.each([
    ['coach rejects book', { id: 'coach_query', name: 'Coach', profile: { kind: 'coach' } }, '/scheduling?tab=book', 'appointments'],
    ['athlete rejects availability', { id: 'athlete_query', name: 'Athlete', profile: { kind: 'athlete' } }, '/scheduling?tab=availability', 'book'],
    ['athlete rejects unknown', { id: 'athlete_unknown', name: 'Athlete', profile: { kind: 'athlete' } }, '/scheduling?tab=qualquer', 'book'],
  ])('%s and replaces the invalid query with the role default', async (_label, user, entry, expectedTab) => {
    mocks.user = user
    mocks.answers['/api/coach/athletes'] = { links: [] }
    mocks.answers['/api/athlete/coaches'] = { links: [] }
    mocks.answers['/api/coach/appointments'] = { items: [] }
    mocks.answers['/api/athlete/appointments'] = { items: [] }
    await mount(<SchedulingView />, entry)

    const tabs = [...host.querySelectorAll('[role="tab"]')]
    const selected = tabs.filter(tab => tab.getAttribute('aria-selected') === 'true')
    expect(selected).toHaveLength(1)
    expect(selected[0].id).toBe(`tab-${expectedTab}`)
    expect(selected[0].tabIndex).toBe(0)
    const panel = host.querySelector('[role="tabpanel"]:not([hidden])')
    expect(panel?.getAttribute('aria-labelledby')).toBe(selected[0].id)
    expect(mocks.location).toBe(`/scheduling?tab=${expectedTab}`)
  })

  it('renders top tabs for Coach and allows navigation between subviews', async () => {
    mocks.user = { id: 'coach_1', name: 'Coach Bruno', profile: { kind: 'coach' } }
    mocks.answers['/api/coach/athletes'] = { links: [] }
    mocks.answers['/api/coach/appointments'] = { items: [] }
    mocks.answers['/api/coach/availability'] = { availability: null }
    mocks.answers['/api/scheduling/reminder-preferences'] = { enabled: true, offsetsMinutes: [60] }

    await mount(<SchedulingView />)

    expect(host.textContent).toContain('Coach appointments')
    expect(host.textContent).toContain('Appointments')
    expect(host.textContent).toContain('Availability')
    expect(host.textContent).toContain('Reminders')

    // Switch to Availability tab
    await act(async () => { button('Availability').click() })
    await settle()
    expect(host.textContent).toContain('Weekly windows')

    // Switch to Reminders tab
    await act(async () => { button('Reminders').click() })
    await settle()
    expect(host.textContent).toContain('Enable reminders')
  })

  it('supports AccessibleModal focus trapping and escape closing', async () => {
    let closed = false
    await mount(
      <AccessibleModal id="test-modal" title="Test Dialog" onClose={() => { closed = true }}>
        <button type="button">Action 1</button>
        <button type="button">Action 2</button>
      </AccessibleModal>
    )

    const dialog = host.querySelector('[role="dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('aria-labelledby')).toBe('test-modal-title')

    // Escape closes modal
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(closed).toBe(true)
  })
})

describe('SchedulingView - Civil Timezone Conversion', () => {
  it('keeps civil YYYY-MM-DD dates on the same day in every IANA timezone', () => {
    const honolulu = formatDateOnly('2026-01-01', 'Pacific/Honolulu')
    const tokyo = formatDateOnly('2026-01-01', 'Asia/Tokyo')
    expect(honolulu).toBe(tokyo)
    expect(formatDayHeader('2026-01-01', 'Pacific/Honolulu')).toBe(formatDayHeader('2026-01-01', 'Asia/Tokyo'))
  })

  it('converts civil date and time to ISO instant deterministically across time zones', () => {
    // UTC-3
    expect(civilTimeToIso('2026-06-01', '10:00', 'America/Sao_Paulo')).toBe('2026-06-01T13:00:00.000Z')
    // UTC+2 (summer DST in Europe/Madrid)
    expect(civilTimeToIso('2026-06-01', '10:00', 'Europe/Madrid')).toBe('2026-06-01T08:00:00.000Z')
    // UTC+9
    expect(civilTimeToIso('2026-06-01', '10:00', 'Asia/Tokyo')).toBe('2026-06-01T01:00:00.000Z')
    // UTC
    expect(civilTimeToIso('2026-06-01', '10:00', 'UTC')).toBe('2026-06-01T10:00:00.000Z')
    // America/New_York winter (UTC-5)
    expect(civilTimeToIso('2026-01-15', '10:00', 'America/New_York')).toBe('2026-01-15T15:00:00.000Z')
    // America/New_York summer (EDT UTC-4)
    expect(civilTimeToIso('2026-06-15', '10:00', 'America/New_York')).toBe('2026-06-15T14:00:00.000Z')
    // Null inputs
    expect(civilTimeToIso('', '10:00', 'UTC')).toBeNull()
    expect(civilTimeToIso('2026-06-01', '', 'UTC')).toBeNull()
  })

  it('RescheduleModal serializes startAt respecting appointment civil timezone', async () => {
    let rescheduleBody = null
    mocks.answers['/api/coach/appointments/appt_madrid/reschedule'] = body => {
      rescheduleBody = body
      return { appointment: { id: 'appt_madrid', startAt: body.startAt } }
    }

    const madridAppointment = {
      id: 'appt_madrid',
      timeZone: 'Europe/Madrid',
      localDate: '2026-06-01',
      startAt: '2026-06-01T08:00:00.000Z',
    }

    await mount(
      <RescheduleModal
        appointment={madridAppointment}
        onClose={vi.fn()}
        onSave={vi.fn()}
        isCoach={true}
      />
    )

    const modal = host.querySelector('[role="dialog"]')
    await changeInput(input('rescheduleDate', modal), '2026-06-02')
    await changeInput(input('rescheduleTime', modal), '11:00')

    await act(async () => { button('Reschedule', modal).click() })
    await settle()

    expect(rescheduleBody).toBeTruthy()
    // 11:00 in Madrid (CEST, UTC+2) is 09:00 UTC
    expect(rescheduleBody.startAt).toBe('2026-06-02T09:00:00.000Z')
  })

  it('CreateCoachAppointmentModal serializes manual time using coach availability timezone', async () => {
    let createBody = null
    mocks.answers['/api/coach/athletes/athlete_1/appointments'] = body => {
      createBody = body
      return { appointment: { id: 'appt_new', ...body } }
    }
    mocks.answers['/api/coach/athletes/athlete_1/availability-slots'] = {
      items: [],
      timeZone: 'America/Sao_Paulo',
    }

    await mount(
      <CreateCoachAppointmentModal
        links={[{ id: 'link_1', athlete: { id: 'athlete_1', name: 'Atleta Carlos' } }]}
        coachTimeZone="America/Sao_Paulo"
        onClose={vi.fn()}
        onSave={vi.fn()}
      />
    )

    const modal = host.querySelector('[role="dialog"]')
    await changeInput(input('createDate', modal), '2026-06-01')
    await changeInput(input('manualTime', modal), '10:00')

    await act(async () => { button('Confirm booking', modal).click() })
    await settle()

    expect(createBody).toBeTruthy()
    // 10:00 in America/Sao_Paulo (UTC-3) is 13:00 UTC
    expect(createBody.startAt).toBe('2026-06-01T13:00:00.000Z')
  })
})

describe('SchedulingView - Dual-Role Mode Switching', () => {
  it('normalizes a role-only tab after switching roles and keeps the URL in sync', async () => {
    mocks.user = { id: 'dual_query', name: 'Dual Role Coach', profile: { kind: 'coach' } }
    mocks.answers['/api/coach/athletes'] = { links: [] }
    mocks.answers['/api/athlete/coaches'] = { links: [{ id: 'dual_link', coach: { id: 'coach_2', name: 'Coach Two' } }] }
    mocks.answers['/api/coach/availability'] = { availability: null }
    mocks.answers['/api/coach/appointments'] = { items: [] }
    mocks.answers['/api/athlete/appointments'] = { items: [] }
    mocks.answers['/api/athlete/coaches/coach_2/availability-slots'] = { items: [] }

    await mount(<SchedulingView />, '/scheduling?role=coach&tab=availability')
    expect(host.querySelector('#tab-availability')?.getAttribute('aria-selected')).toBe('true')

    await act(async () => { button('Atleta / Meus Treinadores').click() })
    await settle()

    const selected = [...host.querySelectorAll('[role="tab"]')].filter(tab => tab.getAttribute('aria-selected') === 'true')
    expect(selected).toHaveLength(1)
    expect(selected[0].id).toBe('tab-book')
    expect(selected[0].tabIndex).toBe(0)
    expect(host.querySelector('[role="tabpanel"]:not([hidden])')?.getAttribute('aria-labelledby')).toBe('tab-book')
    expect(mocks.location).toBe('/scheduling?role=athlete&tab=book')
  })

  it('renders mode switcher for dual-role coach and toggles between coach and athlete views', async () => {
    mocks.user = { id: 'dual_user', name: 'Dual Role Coach', profile: { kind: 'coach' } }
    mocks.answers['/api/coach/athletes'] = {
      links: [{ id: 'link_coach_1', athlete: { id: 'athlete_1', name: 'My Athlete Carlos' } }],
    }
    mocks.answers['/api/athlete/coaches'] = {
      links: [{ id: 'link_athlete_1', coach: { id: 'coach_2', name: 'Sensei Silva' } }],
    }
    mocks.answers['/api/coach/appointments'] = { items: [] }
    mocks.answers['/api/athlete/appointments'] = { items: [] }
    mocks.answers['/api/athlete/coaches/coach_2/availability-slots'] = { items: [] }
    mocks.answers['/api/scheduling/reminder-preferences'] = { enabled: true, offsetsMinutes: [60] }

    await mount(<SchedulingView />)

    // Initial role is coach: should have coach title and switcher
    expect(host.textContent).toContain('Coach appointments')
    const coachBtn = button('Coach / Meus Alunos')
    const athleteBtn = button('Atleta / Meus Treinadores')
    expect(coachBtn).not.toBeUndefined()
    expect(athleteBtn).not.toBeUndefined()
    expect(coachBtn.getAttribute('aria-pressed')).toBe('true')
    expect(athleteBtn.getAttribute('aria-pressed')).toBe('false')

    // Switch to athlete view
    await act(async () => { athleteBtn.click() })
    await settle()

    expect(host.textContent).toContain('My appointments')
    expect(host.textContent).toContain('Book session')
    expect(coachBtn.getAttribute('aria-pressed')).toBe('false')
    expect(athleteBtn.getAttribute('aria-pressed')).toBe('true')

    // Switch back to coach view
    await act(async () => { coachBtn.click() })
    await settle()

    expect(host.textContent).toContain('Coach appointments')
    expect(host.textContent).toContain('Availability')
    expect(coachBtn.getAttribute('aria-pressed')).toBe('true')
    expect(athleteBtn.getAttribute('aria-pressed')).toBe('false')
  })

  it('does not display mode switcher when coach has no athlete links', async () => {
    mocks.user = { id: 'coach_only', name: 'Coach Bruno', profile: { kind: 'coach' } }
    mocks.answers['/api/coach/athletes'] = {
      links: [{ id: 'link_1', athlete: { id: 'athlete_1', name: 'Atleta Carlos' } }],
    }
    mocks.answers['/api/athlete/coaches'] = { links: [] }
    mocks.answers['/api/coach/appointments'] = { items: [] }

    await mount(<SchedulingView />)

    expect(host.textContent).toContain('Coach appointments')
    expect(button('Coach / Meus Alunos')).toBeUndefined()
    expect(button('Atleta / Meus Treinadores')).toBeUndefined()
  })

  it('does not display mode switcher for athlete-only user', async () => {
    mocks.user = { id: 'athlete_only', name: 'Carlos Atleta', profile: { kind: 'athlete' } }
    mocks.answers['/api/athlete/coaches'] = {
      links: [{ id: 'link_1', coach: { id: 'coach_1', name: 'Coach Bruno' } }],
    }
    mocks.answers['/api/athlete/coaches/coach_1/availability-slots'] = { items: [] }

    await mount(<SchedulingView />)

    expect(host.textContent).toContain('My appointments')
    expect(button('Coach / Meus Alunos')).toBeUndefined()
    expect(button('Atleta / Meus Treinadores')).toBeUndefined()
  })
})

describe('SchedulingView - Race Condition Prevention in Filters', () => {
  it('discards stale slow response when filter is rapidly changed in CoachAppointmentsView', async () => {
    mocks.user = { id: 'coach_1', name: 'Coach Bruno', profile: { kind: 'coach' } }

    let resolveScheduled
    const scheduledPromise = new Promise(resolve => { resolveScheduled = resolve })

    mocks.answers['/api/coach/appointments'] = (body, path) => {
      if (path.includes('status=scheduled')) {
        return scheduledPromise
      }
      if (path.includes('status=canceled')) {
        return {
          items: [
            {
              id: 'appt_canceled',
              title: 'Canceled Session Only',
              status: 'canceled',
              startAt: '2026-11-10T14:00:00.000Z',
              endAt: '2026-11-10T15:00:00.000Z',
              timeZone: 'UTC',
              localDate: '2026-11-10',
              lifecycle: { allowedActions: [] },
            },
          ],
          hasMore: false,
        }
      }
      return { items: [], hasMore: false }
    }

    await mount(<CoachAppointmentsView links={[]} />)

    const statusSelect = host.querySelector('select:has(option[value="scheduled"])')
    expect(statusSelect).not.toBeNull()

    // Rapidly switch to scheduled, then immediately to canceled
    await changeInput(statusSelect, 'scheduled')
    await changeInput(statusSelect, 'canceled')

    // Now resolve the older 'scheduled' request after the 'canceled' one already returned
    await act(async () => {
      resolveScheduled({
        items: [
          {
            id: 'appt_scheduled_stale',
            title: 'Stale Scheduled Session',
            status: 'scheduled',
            startAt: '2026-11-10T14:00:00.000Z',
            endAt: '2026-11-10T15:00:00.000Z',
            timeZone: 'UTC',
            localDate: '2026-11-10',
            lifecycle: { allowedActions: [] },
          },
        ],
        hasMore: false,
      })
    })
    await settle()

    // Only 'Canceled Session Only' should be visible; 'Stale Scheduled Session' must be discarded
    expect(host.textContent).toContain('Canceled Session Only')
    expect(host.textContent).not.toContain('Stale Scheduled Session')
  })
})


describe('SchedulingView - Modernized UX, Day/Week Breakdown, Optional Cancellation Reason, and A11y', () => {
  it('highlights next appointment card for coach and athlete with quick actions', async () => {
    mocks.user = { id: 'coach_1', name: 'Coach Bruno', profile: { kind: 'coach' } }
    const futureDate = new Date(Date.now() + 86400000).toISOString()
    const futureEnd = new Date(Date.now() + 86400000 + 3600000).toISOString()

    mocks.answers['/api/coach/appointments'] = {
      items: [
        {
          id: 'app_future',
          title: 'Upcoming Coaching Session',
          status: 'scheduled',
          startAt: futureDate,
          endAt: futureEnd,
          timeZone: 'America/Sao_Paulo',
          localDate: futureDate.slice(0, 10),
          athlete: { id: 'ath_1', name: 'Aluno Marcos' },
          lifecycle: { allowedActions: ['reschedule', 'cancel'], readOnly: false },
        },
      ],
      hasMore: false,
    }

    await mount(<CoachAppointmentsView links={[]} />)

    expect(host.querySelector('.pro-sched-next-card')).not.toBeNull()
    expect(host.querySelector('.pro-sched-next-card').textContent).toContain('Upcoming Coaching Session')
    expect(host.querySelector('.pro-sched-next-card').textContent).toContain('Aluno Marcos')
    expect(button('Session details', host.querySelector('.pro-sched-next-card'))).not.toBeNull()
    expect(button('Reschedule', host.querySelector('.pro-sched-next-card'))).not.toBeNull()
    expect(button('Cancel session', host.querySelector('.pro-sched-next-card'))).not.toBeNull()
  })

  it('groups coach appointments by day and supports period filters', async () => {
    mocks.user = { id: 'coach_1', name: 'Coach Bruno', profile: { kind: 'coach' } }
    const d1 = '2026-11-10T14:00:00.000Z'
    const d2 = '2026-11-12T14:00:00.000Z'

    mocks.answers['/api/coach/appointments'] = {
      items: [
        {
          id: 'app_1',
          title: 'Session Day 1',
          status: 'scheduled',
          startAt: d1,
          endAt: '2026-11-10T15:00:00.000Z',
          timeZone: 'UTC',
          localDate: '2026-11-10',
          athlete: { id: 'ath_1', name: 'Aluno 1' },
          lifecycle: { allowedActions: [] },
        },
        {
          id: 'app_2',
          title: 'Session Day 2',
          status: 'scheduled',
          startAt: d2,
          endAt: '2026-11-12T15:00:00.000Z',
          timeZone: 'UTC',
          localDate: '2026-11-12',
          athlete: { id: 'ath_2', name: 'Aluno 2' },
          lifecycle: { allowedActions: [] },
        },
      ],
      hasMore: false,
    }

    await mount(<CoachAppointmentsView links={[]} />)

    const dayGroups = host.querySelectorAll('.pro-sched-day-group')
    expect(dayGroups.length).toBe(2)
    expect(dayGroups[0].textContent).toContain('Session Day 1')
    expect(dayGroups[1].textContent).toContain('Session Day 2')

    // Click quick period 'Today'
    const todayPill = button('Today')
    expect(todayPill).not.toBeNull()
    await act(async () => { todayPill.click() })
    await settle()
    expect(mocks.calls.some(c => c.path.includes('/api/coach/appointments') && c.path.includes('from='))).toBe(true)
  })

  it('allows canceling with optional reason by submitting default fallback when empty', async () => {
    mocks.user = { id: 'coach_1', name: 'Coach Bruno', profile: { kind: 'coach' } }
    let cancelPayload = null

    mocks.answers['/api/coach/appointments/app_cancel/cancel'] = body => {
      cancelPayload = body
      return { appointment: { id: 'app_cancel', status: 'canceled' } }
    }

    const testAppt = {
      id: 'app_cancel',
      title: 'Session to Cancel',
      status: 'scheduled',
      startAt: '2026-11-15T10:00:00.000Z',
      endAt: '2026-11-15T11:00:00.000Z',
      timeZone: 'UTC',
      localDate: '2026-11-15',
    }

    let closed = false
    let saved = false

    await mount(
      <CancelModal
        appointment={testAppt}
        isCoach={true}
        onClose={() => { closed = true }}
        onSave={() => { saved = true }}
      />
    )

    // Form should have label marked optional
    expect(host.textContent).toContain('Reason for cancellation (optional)')

    // Click submit button directly without filling textarea
    const cancelSubmitBtn = button('Cancel appointment')
    await act(async () => { cancelSubmitBtn.click() })
    await settle()

    expect(cancelPayload).not.toBeNull()
    expect(cancelPayload.reason).toBe('Cancellation requested by coach')
    expect(saved).toBe(true)
    expect(closed).toBe(true)
  })

  it('separates athlete upcoming sessions and read-only session history', async () => {
    mocks.user = { id: 'ath_1', name: 'Atleta Maria', profile: { kind: 'athlete' } }
    const futureDate = new Date(Date.now() + 86400000).toISOString()
    const pastDate = '2026-10-01T10:00:00.000Z'

    mocks.answers['/api/athlete/appointments'] = {
      items: [
        {
          id: 'app_active',
          title: 'Active Future Session',
          status: 'scheduled',
          startAt: futureDate,
          endAt: new Date(Date.now() + 86400000 + 3600000).toISOString(),
          timeZone: 'America/Sao_Paulo',
          localDate: futureDate.slice(0, 10),
          coach: { name: 'Coach Bruno' },
          lifecycle: { allowedActions: ['reschedule', 'cancel'], readOnly: false },
        },
        {
          id: 'app_past',
          title: 'Past Completed Session',
          status: 'completed',
          startAt: pastDate,
          endAt: '2026-10-01T11:00:00.000Z',
          timeZone: 'America/Sao_Paulo',
          localDate: '2026-10-01',
          coach: { name: 'Coach Bruno' },
          lifecycle: { allowedActions: [], readOnly: true, historical: true },
        },
      ],
      hasMore: false,
    }

    await mount(<AthleteAppointmentsView />)

    // Next session highlight card
    expect(host.querySelector('.pro-sched-next-card')).not.toBeNull()
    expect(host.querySelector('.pro-sched-next-card').textContent).toContain('Active Future Session')

    // Filter to Session history
    const historyPill = button('Session history')
    expect(historyPill).not.toBeNull()
    await act(async () => { historyPill.click() })
    await settle()

    expect(host.textContent).toContain('Past Completed Session')
    expect(host.textContent).not.toContain('Active Future Session')
    // No reschedule or cancel buttons in read-only history
    expect(button('Reschedule', host.querySelector('.pro-sched-grid'))).toBeUndefined()
    expect(button('Cancel session', host.querySelector('.pro-sched-grid'))).toBeUndefined()
  })

  it('handles partial failures gracefully without dropping other tabs and provides retry', async () => {
    mocks.user = { id: 'coach_1', name: 'Coach Bruno', profile: { kind: 'coach' } }
    mocks.answers['/api/coach/athletes'] = { links: [] }
    mocks.answers['/api/athlete/coaches'] = { links: [] }
    mocks.answers['/api/coach/appointments'] = new Error('Appointments unavailable')
    mocks.answers['/api/coach/availability'] = {
      availability: {
        timeZone: 'America/Sao_Paulo',
        sessionDurationMinutes: 60,
        bufferMinutes: 0,
        minNoticeHours: 2,
        maxAdvanceDays: 30,
        windows: [{ dayOfWeek: 1, start: '09:00', end: '17:00' }],
        exceptions: [],
        _rev: 1,
      },
    }
    mocks.answers['/api/scheduling/reminder-preferences'] = { enabled: true, offsetsMinutes: [60] }

    await mount(<SchedulingView />)

    // Error in appointments view
    expect(host.textContent).toContain('Could not load appointments.')
    const retryBtn = button('Try again')
    expect(retryBtn).not.toBeNull()

    // Switch to Availability tab: should work without issues!
    const availabilityTab = [...host.querySelectorAll('nav button[role=tab]')][1]
    await act(async () => { availabilityTab.click() })
    await settle()

    expect(host.textContent).toContain('Weekly windows')
    expect(host.textContent).toContain('Save availability')

    // Switch back to Appointments and retry
    const apptsTab = [...host.querySelectorAll('nav button[role=tab]')][0]
    await act(async () => { apptsTab.click() })
    await settle()

    mocks.answers['/api/coach/appointments'] = { items: [], hasMore: false }
    await act(async () => { button('Try again').click() })
    await settle()

    expect(host.textContent).toContain('No appointments found')
  })

  it('supports APG tab navigation with Arrow keys', async () => {
    mocks.user = { id: 'coach_1', name: 'Coach Bruno', profile: { kind: 'coach' } }
    mocks.answers['/api/coach/athletes'] = { links: [] }
    mocks.answers['/api/athlete/coaches'] = { links: [] }
    mocks.answers['/api/coach/appointments'] = { items: [] }
    mocks.answers['/api/coach/availability'] = { availability: null }
    mocks.answers['/api/scheduling/reminder-preferences'] = { enabled: true, offsetsMinutes: [60] }

    await mount(<SchedulingView />)

    const tabs = [...host.querySelectorAll('nav button[role=tab]')]
    expect(tabs.length).toBe(3)

    // Navigate right from Appointments (0) -> Availability (1)
    await act(async () => {
      tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    await settle()
    expect(tabs[1].getAttribute('aria-selected')).toBe('true')

    // Navigate right from Availability (1) -> Reminders (2)
    await act(async () => {
      tabs[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    await settle()
    expect(tabs[2].getAttribute('aria-selected')).toBe('true')

    // Navigate right from Reminders (2) -> wraps to Appointments (0)
    await act(async () => {
      tabs[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    await settle()
    expect(tabs[0].getAttribute('aria-selected')).toBe('true')

    // Navigate left from Appointments (0) -> wraps to Reminders (2)
    await act(async () => {
      tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    })
    await settle()
    expect(tabs[2].getAttribute('aria-selected')).toBe('true')
  })
})
