// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { guardReactWarnings } from '../test/react-warning-guard.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  user: null, calls: [], answers: {}, toast: vi.fn(), setUser: vi.fn(), pullState: vi.fn(), confirms: [], copied: [],
}))

vi.mock('../store/useStore.js', () => {
  const snap = () => ({ user: mocks.user, setUser: mocks.setUser, pullState: mocks.pullState })
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
    return typeof answer === 'function' ? answer(body, opts, path) : answer ?? {}
  }),
}))
vi.mock('../lib/clipboard.js', () => ({ copyText: vi.fn(async value => { mocks.copied.push(value); return true }) }))
vi.mock('../sheets.jsx', () => ({ confirmSheet: options => mocks.confirms.push(options) }))

import ProfessionalHub from './ProfessionalHub.jsx'

let host, root, assertNoReactWarnings
beforeEach(() => {
  Object.assign(mocks, { user: null, calls: [], answers: {}, toast: vi.fn(), setUser: vi.fn(), pullState: vi.fn(), confirms: [], copied: [] })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  assertNoReactWarnings = guardReactWarnings()
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  assertNoReactWarnings()
})

const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
const mount = async entry => {
  act(() => root.render(<MemoryRouter initialEntries={[entry]}><ProfessionalHub /></MemoryRouter>))
  await settle()
}
const button = label => [...host.querySelectorAll('button')].find(item => item.textContent.trim() === label)
const card = label => [...host.querySelectorAll('.pro-link')].find(item => item.textContent.includes(label))
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const adherenceEnvelope = adherence => ({
  adherence,
  page: { limit: 50, hasMore: false, nextCursor: null },
  quota: { used: adherence.length, limit: 1000, retentionDays: 730 },
})
const type = async (input, value) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('ProfessionalHub', () => {
  it.each([
    ['athlete nutrition deep link', { id: 'athlete_tabs', name: 'Athlete', profile: { kind: 'athlete' } }, '/professionals?tab=nutrition'],
    ['unknown deep link', { id: 'coach_tabs', name: 'Coach', profile: { kind: 'coach', coachSpecialties: ['nutrition'] } }, '/professionals?tab=qualquer'],
  ])('normalizes an invalid %s to the role default tab', async (_label, user, entry) => {
    mocks.user = user
    mocks.answers['/api/athlete/coaches'] = { links: [] }
    mocks.answers['/api/coach/athletes'] = { links: [] }
    await mount(entry)

    const selected = [...host.querySelectorAll('[role="tab"]')].filter(tab => tab.getAttribute('aria-selected') === 'true')
    expect(selected).toHaveLength(1)
    expect(selected[0].id).toBe('professional-tab-relationships')
    expect(selected[0].tabIndex).toBe(0)
    const panel = host.querySelector('[role="tabpanel"]:not([hidden])')
    expect(panel?.getAttribute('aria-labelledby')).toBe(selected[0].id)
    expect(host.textContent).not.toContain('Nutrition prescription workspace')
  })

  it('lets an athlete grant and revoke assessment consent explicitly', async () => {
    mocks.user = { id: 'u_athlete', name: 'Ana', admin: false }
    const link = { id: 'cal_1', status: 'active', scopes: ['training'], coach: { name: 'Coach', profile: { kind: 'coach', coachSpecialties: ['training', 'assessments'] } } }
    mocks.answers['/api/athlete/coaches'] = { links: [link] }
    mocks.answers['/api/athlete/assessments'] = { assessments: [] }
    mocks.answers['/api/assessments/config'] = { parq: { version: '2024.1', questions: [] }, limits: {} }
    mocks.answers['/api/athlete/coaches/cal_1/assessment-consent'] = body => ({ link: { ...link, scopes: body.granted ? ['training', 'assessments'] : ['training'] } })
    await mount('/professionals')

    await act(async () => { button('Grant assessment consent').click() })
    await settle()
    expect(mocks.calls).toContainEqual({ path: '/api/athlete/coaches/cal_1/assessment-consent', method: 'POST', body: { granted: true } })
    expect(button('Revoke assessment consent')).toBeDefined()

    await act(async () => { button('Revoke assessment consent').click() })
    await settle()
    expect(mocks.calls).toContainEqual({ path: '/api/athlete/coaches/cal_1/assessment-consent', method: 'POST', body: { granted: false } })
  })

  it('shows the athlete surface, captures an invite without accepting automatically, and hides coach controls', async () => {
    mocks.user = { id: 'u_athlete', name: 'Ana', admin: false }
    mocks.answers['/api/athlete/coaches'] = { links: [] }
    await mount('/professionals?invite=opaque-token')

    expect(host.textContent).toContain('My professionals')
    expect(host.querySelector('input[name="inviteToken"]').value).toBe('opaque-token')
    expect(mocks.calls.some(call => call.path === '/api/coach/invites/accept')).toBe(false)
    expect(button('Create invitation')).toBeUndefined()

    mocks.answers['/api/coach/invites/accept'] = { link: { id: 'cal_1', status: 'active' } }
    await act(async () => { button('Accept invitation').click() })
    await settle()
    expect(mocks.calls.find(call => call.path === '/api/coach/invites/accept').body).toEqual({ token: 'opaque-token' })
  })

  it('lets a coach create a scoped invitation and never sends administrative fields', async () => {
    mocks.user = {
      id: 'u_coach', name: 'Coach', admin: false,
      profile: { kind: 'coach', coachSpecialties: ['training'] },
      capabilities: ['relationships:invite', 'relationships:list', 'relationships:suspend', 'relationships:end'],
    }
    mocks.answers['/api/coach/athletes'] = { links: [] }
    mocks.answers['/api/coach/invites'] = {
      invite: { id: 'cai_1', linkId: 'cal_1', token: 'clear-once', scopes: ['training'], expiresAt: '2026-11-13T00:00:00.000Z' },
    }
    await mount('/professionals')

    expect(host.textContent).toContain('My athletes')
    await act(async () => { button('Create invitation').click() })
    await settle()
    const create = mocks.calls.find(call => call.path === '/api/coach/invites')
    expect(create.body).toEqual({ scopes: ['training'], expiresInDays: 7 })
    expect(create.body.admin).toBeUndefined()
    expect(host.textContent).toContain('clear-once')
  })

  it('keeps athlete relationships visible and revocable after the athlete becomes a professional', async () => {
    mocks.user = {
      id: 'u_dual', name: 'Dual role', admin: false,
      profile: { kind: 'coach', coachSpecialties: ['nutrition'] },
      capabilities: ['relationships:invite', 'relationships:list', 'relationships:suspend', 'relationships:end'],
    }
    mocks.answers['/api/coach/athletes'] = { links: [] }
    mocks.answers['/api/athlete/coaches'] = {
      links: [{ id: 'cal_dual', status: 'active', scopes: ['training'], acceptedAt: '2026-11-01T00:00:00.000Z', coach: { id: 'u_coach', name: 'Coach Original' } }],
    }
    mocks.answers['/api/coach/links/status'] = {
      link: { id: 'cal_dual', status: 'ended', scopes: ['training'], endedAt: '2026-11-06T00:00:00.000Z', coach: { id: 'u_coach', name: 'Coach Original' } },
    }
    await mount('/professionals')

    expect(host.textContent).toContain('My athletes')
    expect(host.textContent).toContain('My professionals')
    expect(host.textContent).toContain('Coach Original')
    await act(async () => { card('Coach Original').querySelector('button').click() })
    await act(async () => { await mocks.confirms.at(-1).onConfirm() })
    expect(mocks.calls.find(call => call.path === '/api/coach/links/status').body).toEqual({ linkId: 'cal_dual', status: 'ended' })
    expect(card('Coach Original').textContent).toContain('Ended')
  })

  it('shows localized load errors, retries, and recovers when the browser comes online', async () => {
    mocks.user = { id: 'u_athlete', name: 'Ana', admin: false }
    let attempts = 0
    mocks.answers['/api/athlete/coaches'] = () => {
      attempts++
      if (attempts < 3) throw Object.assign(new Error('socket exploded with internal details'), { code: 'network' })
      return { links: [] }
    }
    await mount('/professionals')

    expect(host.textContent).not.toContain('Loading…')
    expect(host.textContent).toContain('Could not load your professional relationships.')
    expect(host.textContent).not.toContain('socket exploded')
    await act(async () => { button('Try again').click() })
    await settle()
    expect(host.textContent).toContain('Could not load your professional relationships.')
    await act(async () => { window.dispatchEvent(new Event('online')) })
    await settle()
    expect(host.textContent).toContain('No linked professionals')
  })

  it('lets a professional retry a failed portfolio load', async () => {
    mocks.user = {
      id: 'u_coach', name: 'Coach', admin: false,
      profile: { kind: 'coach', coachSpecialties: ['training'] }, capabilities: ['relationships:invite'],
    }
    let attempts = 0
    mocks.answers['/api/coach/athletes'] = () => {
      attempts++
      if (attempts === 1) throw new Error('private upstream detail')
      return { links: [] }
    }
    mocks.answers['/api/athlete/coaches'] = { links: [] }
    await mount('/professionals')

    expect(host.textContent).toContain('Could not load your professional relationships.')
    expect(host.textContent).not.toContain('private upstream detail')
    await act(async () => { button('Try again').click() })
    await settle()
    expect(host.textContent).toContain('No athletes yet')
  })

  it('uses stable API codes instead of exposing raw mutation errors', async () => {
    mocks.user = {
      id: 'u_coach', name: 'Coach', admin: false,
      profile: { kind: 'coach', coachSpecialties: ['training'] }, capabilities: ['relationships:invite'],
    }
    mocks.answers['/api/coach/athletes'] = { links: [] }
    mocks.answers['/api/coach/invites'] = Object.assign(new Error('SQLITE secret internal failure'), {
      data: { code: 'pending_invite_limit', error: 'internal storage path' }, status: 409,
    })
    await mount('/professionals')
    await act(async () => { button('Create invitation').click() })
    await settle()
    expect(mocks.toast).toHaveBeenCalledWith('You already have too many pending invitations. Wait for one to be accepted or expire.')
    expect(mocks.toast).not.toHaveBeenCalledWith(expect.stringContaining('SQLITE'))
  })

  it('does not pretend an offline relationship mutation succeeded', async () => {
    mocks.user = { id: 'u_athlete', name: 'Ana', admin: false }
    mocks.answers['/api/athlete/coaches'] = {
      links: [{ id: 'cal_1', status: 'active', scopes: ['training'], coach: { id: 'u_coach', name: 'Coach' } }],
    }
    mocks.answers['/api/coach/links/status'] = Object.assign(new Error('offline internals'), { code: 'network' })
    await mount('/professionals')

    await act(async () => { card('Coach').querySelector('button').click() })
    await act(async () => { await mocks.confirms.at(-1).onConfirm() })
    expect(card('Coach').textContent).toContain('Active')
    expect(card('Coach').textContent).not.toContain('Ended')
    expect(mocks.toast).toHaveBeenCalledWith('Could not reach PR Fit. Check your connection and try again.')
  })

  it('saves a professional profile with specialties only', async () => {
    mocks.user = { id: 'u_new', name: 'New', admin: false }
    mocks.answers['/api/athlete/coaches'] = { links: [] }
    mocks.answers['/api/profile'] = {
      user: { id: 'u_new', name: 'New', admin: false, profile: { kind: 'coach', coachSpecialties: ['training'] }, capabilities: ['relationships:invite'] },
    }
    await mount('/professionals')

    await act(async () => { button('Professional').click() })
    await act(async () => { button('Training').click() })
    await act(async () => { button('Save profile').click() })
    await settle()

    const save = mocks.calls.find(call => call.path === '/api/profile')
    expect(save.body).toEqual({ kind: 'coach', coachSpecialties: ['training'] })
    expect(mocks.setUser).toHaveBeenCalledWith(mocks.answers['/api/profile'].user)
  })

  it('lets a training professional build and persist an A/B/C prescription', async () => {
    mocks.user = {
      id: 'u_coach', name: 'Coach', admin: false,
      profile: { kind: 'coach', coachSpecialties: ['training'] },
      capabilities: ['relationships:invite', 'relationships:list', 'relationships:suspend', 'relationships:end'],
    }
    const athlete = { id: 'u_athlete', name: 'Ana' }
    mocks.answers['/api/coach/athletes'] = {
      links: [{ id: 'cal_1', status: 'active', scopes: ['training'], athlete }],
    }
    mocks.answers['/api/athlete/coaches'] = { links: [] }
    mocks.answers['/api/athlete/prescriptions'] = { prescriptions: [] }
    const route = '/api/coach/athletes/u_athlete/routines'
    mocks.answers[route] = body => body ? {
      routine: {
        id: 'cpr_1', state: 'available', createdAt: '2026-11-06T00:00:00.000Z', coach: { id: 'u_coach', name: 'Coach' }, athlete,
        routine: body.routine,
      },
    } : { routines: [] }
    await mount('/professionals')

    await act(async () => { button('Prescribe workout').click() })
    await type(host.querySelector('input[name="routineName"]'), 'Ficha ABC')
    const names = [...host.querySelectorAll('input[name^="exercise-"]')]
    await type(names[0], 'Supino reto')
    await type(names[1], 'Remada baixa')
    await type(names[2], 'Agachamento')
    await act(async () => { button('Send prescription').click() })
    await settle()

    const create = mocks.calls.find(call => call.path === route && call.method === 'POST')
    expect(create.body.routine.name).toBe('Ficha ABC')
    expect(create.body.routine.divisions.map(division => division.name)).toEqual(['A', 'B', 'C'])
    expect(create.body.routine.divisions.map(division => division.exercises[0].name)).toEqual(['Supino reto', 'Remada baixa', 'Agachamento'])
    expect(create.body.routine.divisions[0].exercises[0]).toMatchObject({ sets: 3, reps: '8-12', restSeconds: 60 })
    expect(host.textContent).toContain('Ficha ABC')
    expect(mocks.toast).toHaveBeenCalledWith('Workout prescription saved.')
  })

  it('shows an athlete the full prescription and adopts it explicitly', async () => {
    mocks.user = { id: 'u_athlete', name: 'Ana', admin: false }
    mocks.answers['/api/athlete/coaches'] = { links: [] }
    const available = {
      id: 'cpr_1', state: 'available', createdAt: '2026-11-06T00:00:00.000Z',
      coach: { id: 'u_coach', name: 'Coach' }, athlete: { id: 'u_athlete', name: 'Ana' },
      routine: { name: 'Ficha ABC', notes: 'Progredir com técnica.', divisions: [
        { id: 'division_1', name: 'A', exercises: [{ id: 'exercise_1_1', name: 'Supino reto', sets: 4, reps: '8-10', load: '60 kg', restSeconds: 90, notes: 'RIR 2' }] },
      ] },
    }
    mocks.answers['/api/athlete/prescriptions'] = { prescriptions: [available] }
    mocks.answers['/api/athlete/prescriptions/cpr_1/adopt'] = {
      prescription: { ...available, state: 'adopted', adoptedAt: '2026-11-06T12:00:00.000Z', adoptedRoutineIds: ['r_adopted'] },
      routineIds: ['r_adopted'],
    }
    await mount('/professionals')

    expect(host.textContent).toContain('Supino reto')
    expect(host.textContent).toContain('4 sets · 8-10 reps · 90s rest')
    expect(host.textContent).toContain('Load: 60 kg')
    expect(button('Add to my routines')).toBeDefined()
    await act(async () => { button('Add to my routines').click() })
    await settle()

    expect(mocks.calls).toContainEqual({ path: '/api/athlete/prescriptions/cpr_1/adopt', method: 'POST', body: {} })
    expect(mocks.pullState).toHaveBeenCalledTimes(1)
    expect(host.textContent).toContain('Adopted')
    expect(button('Add to my routines')).toBeUndefined()
    expect(mocks.toast).toHaveBeenCalledWith('Added to your routines.')
  })

  it('renders tab navigation and switches between Relationships and Appointments', async () => {
    mocks.user = {
      id: 'u_coach', name: 'Coach', admin: false,
      profile: { kind: 'coach', coachSpecialties: ['training'] },
    }
    mocks.answers['/api/coach/athletes'] = { links: [] }
    mocks.answers['/api/coach/appointments'] = { items: [] }
    mocks.answers['/api/coach/availability'] = { availability: null }
    mocks.answers['/api/scheduling/reminder-preferences'] = { enabled: true, offsetsMinutes: [60] }

    await mount('/professionals')

    expect(button('Relationships')).toBeDefined()
    expect(button('Appointments')).toBeDefined()
    const relationshipTab = button('Relationships')
    const appointmentTab = button('Appointments')
    expect(relationshipTab.tabIndex).toBe(0)
    expect(appointmentTab.tabIndex).toBe(-1)
    expect(relationshipTab.getAttribute('aria-controls')).toBeTruthy()
    expect(host.querySelector(`#${relationshipTab.getAttribute('aria-controls')}[role="tabpanel"]`)).toBeTruthy()
    expect(host.textContent).toContain('Portfolio')

    relationshipTab.focus()
    await act(async () => relationshipTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
    expect(document.activeElement).toBe(appointmentTab)
    expect(appointmentTab.getAttribute('aria-selected')).toBe('true')

    // Switch to Appointments tab
    await act(async () => { button('Appointments').click() })
    await settle()

    expect(host.textContent).not.toContain('Portfolio')
    expect(host.textContent).toContain('Filter by athlete')
    expect(host.textContent).toContain('Availability')

    // Switch back to Relationships
    await act(async () => { button('Relationships').click() })
    await settle()
    expect(host.textContent).toContain('Portfolio')
  })

  it('renders the athlete scheduling shortcut and deep links via ?tab=scheduling', async () => {
    mocks.user = { id: 'u_athlete', name: 'Ana', admin: false }
    mocks.answers['/api/athlete/coaches'] = { links: [] }
    mocks.answers['/api/athlete/appointments'] = { items: [] }
    mocks.answers['/api/scheduling/reminder-preferences'] = { enabled: true, offsetsMinutes: [60] }

    await mount('/professionals')

    expect(host.textContent).toContain('Appointments and calendar')
    expect(button('Schedule session')).toBeDefined()

    // Clicking shortcut switches to scheduling tab
    await act(async () => { button('Schedule session').click() })
    await settle()
    expect(host.textContent).toContain('Book session')

    // Direct deep linking with ?tab=scheduling
    await mount('/professionals?tab=scheduling')
    expect(host.textContent).toContain('Book session')
  })

  it('validates prescription fields with clear error indicators before dispatching', async () => {
    const athlete = { id: 'u_athlete_val', name: 'Valdir' }
    mocks.user = { id: 'u_coach', name: 'Coach', admin: false, profile: { kind: 'coach', coachSpecialties: ['training'] } }
    mocks.answers['/api/coach/athletes'] = { links: [{ id: 'cal_1', status: 'active', scopes: ['training'], athlete }] }
    mocks.answers[`/api/coach/athletes/${athlete.id}/routines`] = { routines: [] }
    await mount('/professionals')

    await act(async () => { button('Prescribe workout').click() })
    expect(host.textContent).toContain('New workout prescription')

    // Click Send prescription without filling required fields
    await act(async () => { button('Send prescription').click() })
    await settle()

    expect(mocks.toast).toHaveBeenCalledWith('Complete the routine name and every exercise.')
    expect(host.textContent).toContain('Please complete required fields before sending.')
    expect(host.textContent).toContain('Routine name is required.')

    // Ensure no POST call was dispatched
    const postCalls = mocks.calls.filter(c => c.path === `/api/coach/athletes/${athlete.id}/routines` && c.method === 'POST')
    expect(postCalls.length).toBe(0)
  })

  it('supports start date, frequency, adding/removing divisions and exercise RPE in routine prescription', async () => {
    const athlete = { id: 'u_athlete_div', name: 'Davi' }
    mocks.user = { id: 'u_coach', name: 'Coach', admin: false, profile: { kind: 'coach', coachSpecialties: ['training'] } }
    mocks.answers['/api/coach/athletes'] = { links: [{ id: 'cal_1', status: 'active', scopes: ['training'], athlete }] }
    const route = `/api/coach/athletes/${athlete.id}/routines`
    mocks.answers[route] = body => body ? {
      routine: {
        id: 'cpr_div', state: 'available', createdAt: '2026-11-08T00:00:00.000Z', coach: { id: 'u_coach', name: 'Coach' }, athlete,
        routine: body.routine,
      },
    } : { routines: [] }
    await mount('/professionals')

    await act(async () => { button('Prescribe workout').click() })
    await type(host.querySelector('input[name="routineName"]'), 'Ficha Força ABCD')
    await type(host.querySelector('input[name="routineStartDate"]'), '2026-11-10')
    await type(host.querySelector('input[name="routineFrequency"]'), '4x por semana')

    // Add 4th division (D)
    await act(async () => { button('Add division').click() })
    await settle()

    const divisionInputs = [...host.querySelectorAll('input[name^="division-"]')]
    expect(divisionInputs.length).toBe(4)

    // Remove 4th division
    const removeDivButtons = [...host.querySelectorAll('button')].filter(b => b.textContent.trim() === 'Remove division')
    expect(removeDivButtons.length).toBeGreaterThan(0)
    await act(async () => { removeDivButtons[removeDivButtons.length - 1].click() })
    await settle()
    expect(host.querySelectorAll('input[name^="division-"]').length).toBe(3)

    // Fill exercise names
    const names = [...host.querySelectorAll('input[name^="exercise-"]')]
    await type(names[0], 'Levantamento Terra')
    await type(names[1], 'Barra Fixa')
    await type(names[2], 'Desenvolvimento Halteres')

    // Fill RPE on first exercise
    const rpeInput = host.querySelector('input[name="rpe-1-1"]')
    if (rpeInput) await type(rpeInput, '8.5')

    await act(async () => { button('Send prescription').click() })
    await settle()

    const create = mocks.calls.find(call => call.path === route && call.method === 'POST')
    expect(create).toBeDefined()
    expect(create.body.routine.name).toBe('Ficha Força ABCD')
    expect(create.body.routine.notes).toContain('Start date: 2026-11-10')
    expect(create.body.routine.notes).toContain('Recommended frequency: 4x por semana')
    expect(create.body.routine.divisions[0].exercises[0].notes).toContain('[RPE: 8.5]')
    expect(mocks.toast).toHaveBeenCalledWith('Workout prescription saved.')
  })

  it("ensures prescription secondary buttons (add exercise, remove division) exist in ergonomic containers", async () => {
    const athlete = { id: "u_athlete_touch", name: "Lucas" }
    mocks.user = { id: "u_coach", name: "Coach", admin: false, profile: { kind: "coach", coachSpecialties: ["training"] } }
    mocks.answers["/api/coach/athletes"] = { links: [{ id: "cal_1", status: "active", scopes: ["training"], athlete }] }
    mocks.answers[`/api/coach/athletes/${athlete.id}/routines`] = { routines: [] }
    await mount("/professionals")

    await act(async () => { button("Prescribe workout").click() })

    // Check Add division button in footer
    const addDivBtn = host.querySelector(".pro-editor-footer-actions .btn")
    expect(addDivBtn).toBeTruthy()
    expect(addDivBtn.textContent).toContain("Add division")

    // Check Add exercise button in division editor
    const addExBtns = host.querySelectorAll(".pro-division-editor > .btn")
    expect(addExBtns.length).toBeGreaterThan(0)
    expect(addExBtns[0].textContent).toContain("Add exercise")

    // Add division to reveal Remove division button
    await act(async () => { addDivBtn.click() })
    await settle()

    const removeDivBtn = host.querySelector(".pro-division-head .btn")
    expect(removeDivBtn).toBeTruthy()
    expect(removeDivBtn.textContent).toContain("Remove division")
  })

  it('opens AI workout copilot modal and applies suggested prescription into routine editor', async () => {
    const athlete = { id: 'u_athlete_ai', name: 'Atleta IA' }
    mocks.user = { id: 'u_coach', name: 'Coach', admin: false, profile: { kind: 'coach', coachSpecialties: ['training'] } }
    mocks.answers['/api/coach/athletes'] = { links: [{ id: 'cal_ai', status: 'active', scopes: ['training'], athlete }] }
    mocks.answers[`/api/coach/athletes/${athlete.id}/routines`] = { routines: [] }
    await mount('/professionals')

    await act(async () => { button('Prescribe workout').click() })

    const aiTrigger = host.querySelector('[data-testid="ai-copilot-trigger"]')
    expect(aiTrigger).toBeTruthy()
    expect(aiTrigger.textContent).toContain('Prescribe with AI')

    await act(async () => { aiTrigger.click() })

    const applyBtn = document.body.querySelector('[data-testid="apply-ai-workout-btn"]')
    expect(applyBtn).toBeTruthy()

    await act(async () => { applyBtn.click() })

    const nameInput = host.querySelector('input[name="routineName"]')
    expect(nameInput.value).toContain('Hipertrofia')
    expect(mocks.toast).toHaveBeenCalledWith('AI workout prescription applied to routine.')
  })
})

  it('renders Nutrition tab for coaches with nutrition specialty and isolates athletes by nutrition scope', async () => {
    const athleteNutri = { id: 'u_athlete_nutri', name: 'Atleta Nutrição', email: 'nutri@prfit.app' }
    const athleteTrainingOnly = { id: 'u_athlete_train', name: 'Atleta Treino', email: 'train@prfit.app' }
    mocks.user = {
      id: 'u_coach_nutri', name: 'Coach Nutri', admin: false,
      profile: { kind: 'coach', coachSpecialties: ['training', 'nutrition'] },
      capabilities: ['relationships:invite', 'relationships:list'],
    }
    mocks.answers['/api/coach/athletes'] = {
      links: [
        { id: 'link_nutri', status: 'active', scopes: ['nutrition'], athlete: athleteNutri },
        { id: 'link_train', status: 'active', scopes: ['training'], athlete: athleteTrainingOnly },
      ],
    }
    mocks.answers[`/api/coach/athletes/${athleteNutri.id}/meal-plans`] = { mealPlans: [] }
    mocks.answers[`/api/coach/athletes/${athleteNutri.id}/meal-adherence`] = adherenceEnvelope([])

    await mount('/professionals')

    const tabs = [...host.querySelectorAll('.pro-sched-nav button')]
    const nutritionTab = tabs.find(t => t.textContent.includes('Nutrition'))
    expect(nutritionTab).toBeTruthy()

    await act(async () => { nutritionTab.click() })
    await settle()

    expect(host.textContent).toContain('Nutrition prescription workspace')
    expect(host.textContent).toContain('Atleta Nutrição')
    expect(host.textContent).not.toContain('Atleta Treino')
    expect(host.textContent).toContain('New meal plan')
    expect(mocks.calls.filter(call => call.path === '/api/coach/athletes')).toHaveLength(2)
  })

  it('uses roving tabs for nutrition athletes with associated tabpanels', async () => {
    const athleteA = { id: 'u_nutri_a', name: 'Ana' }
    const athleteB = { id: 'u_nutri_b', name: 'Bia' }
    mocks.user = { id: 'u_coach_nutri_tabs', name: 'Coach', profile: { kind: 'coach', coachSpecialties: ['nutrition'] } }
    mocks.answers['/api/coach/athletes'] = { links: [
      { id: 'link_a', status: 'active', scopes: ['nutrition'], athlete: athleteA },
      { id: 'link_b', status: 'active', scopes: ['nutrition'], athlete: athleteB },
    ] }
    for (const athlete of [athleteA, athleteB]) {
      mocks.answers[`/api/coach/athletes/${athlete.id}/meal-plans`] = { mealPlans: [] }
      mocks.answers[`/api/coach/athletes/${athlete.id}/meal-adherence`] = adherenceEnvelope([])
    }
    await mount('/professionals?tab=nutrition')

    const tabs = [...host.querySelectorAll('.pro-athlete-selector [role="tab"]')]
    expect(tabs).toHaveLength(2)
    expect(tabs.map(tab => tab.tabIndex)).toEqual([0, -1])
    for (const tab of tabs) {
      expect(tab.getAttribute('aria-controls')).toBeTruthy()
      expect(host.querySelector(`#${tab.getAttribute('aria-controls')}[role="tabpanel"]`)).toBeTruthy()
    }
    tabs[0].focus()
    await act(async () => tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
    await settle()
    expect(document.activeElement).toBe(tabs[1])
    expect(tabs[1].getAttribute('aria-selected')).toBe('true')
    expect(mocks.calls.filter(call => call.path === '/api/coach/athletes')).toHaveLength(1)
  })

  it('isolates A→B immediately and ignores athlete A responses that arrive late', async () => {
    const athleteA = { id: 'u_nutri_a', name: 'Ana', email: 'ana@example.test' }
    const athleteB = { id: 'u_nutri_b', name: 'Bia', email: 'bia@example.test' }
    const biaPlan = {
      id: 'mp_b', title: 'Plano exclusivo da Bia', status: 'active', targetCalories: 2200,
      targetMacros: { protein: 150, carbs: 260, fats: 70, fiber: 30, waterMl: 2800 },
      meals: [{ id: 'm_b', name: 'Café', time: '08:00', items: [] }], notes: '', coach: { name: 'Coach' }, athlete: athleteB,
    }
    const plansA = deferred()
    const adherenceA = deferred()
    const plansB = deferred()
    const adherenceB = deferred()
    const athleteASignals = []
    mocks.user = { id: 'u_coach_nutri_switch', name: 'Coach', profile: { kind: 'coach', coachSpecialties: ['nutrition'] } }
    mocks.answers['/api/coach/athletes'] = { links: [
      { id: 'link_a', status: 'active', scopes: ['nutrition'], athlete: athleteA },
      { id: 'link_b', status: 'active', scopes: ['nutrition'], athlete: athleteB },
    ] }
    mocks.answers[`/api/coach/athletes/${athleteA.id}/meal-plans`] = (_body, options) => {
      athleteASignals.push(options.signal)
      return plansA.promise
    }
    mocks.answers[`/api/coach/athletes/${athleteA.id}/meal-adherence`] = (_body, options) => {
      athleteASignals.push(options.signal)
      return adherenceA.promise
    }
    mocks.answers[`/api/coach/athletes/${athleteB.id}/meal-plans`] = () => plansB.promise
    mocks.answers[`/api/coach/athletes/${athleteB.id}/meal-adherence`] = () => adherenceB.promise

    await mount('/professionals?tab=nutrition')
    expect(host.textContent).toContain('Ana')
    expect(host.querySelector('.nutrition-panel-skeleton')).toBeTruthy()

    await act(async () => { button('Bia').click() })
    expect(host.textContent).toContain('Bia')
    expect(host.textContent).not.toContain('Plano tardio da Ana')
    expect(host.querySelector('.nutrition-panel-skeleton')).toBeTruthy()
    expect(athleteASignals).toHaveLength(2)
    expect(athleteASignals.every(signal => signal.aborted)).toBe(true)
    await act(async () => {
      plansB.resolve({ mealPlans: [biaPlan] })
      adherenceB.resolve(adherenceEnvelope([]))
    })
    await settle()
    expect(host.textContent).toContain('Plano exclusivo da Bia')

    await act(async () => {
      plansA.resolve({ mealPlans: [{ ...biaPlan, id: 'mp_a', title: 'Plano tardio da Ana', athlete: athleteA }] })
      adherenceA.resolve(adherenceEnvelope([]))
    })
    await settle()

    expect(host.textContent).toContain('Plano exclusivo da Bia')
    expect(host.textContent).not.toContain('Plano tardio da Ana')
    expect(host.textContent).not.toContain('ana@example.test')
  })

  it('exibe badges de mensagens não lidas, alerta de inbox e filtro de não lidas no portfolio do coach', async () => {
    const athleteA = { id: 'u_athlete_a', name: 'Atleta Com Mensagem' }
    const athleteB = { id: 'u_athlete_b', name: 'Atleta Sem Mensagem' }
    mocks.user = { id: 'u_coach_inbox', name: 'Coach Ricardo', profile: { kind: 'coach', coachSpecialties: ['training'] } }
    mocks.answers['/api/coach/athletes'] = { links: [
      { id: 'link_msg', status: 'active', scopes: ['training'], athlete: athleteA },
      { id: 'link_clear', status: 'active', scopes: ['training'], athlete: athleteB },
    ] }
    mocks.answers['/api/messages/inbox'] = {
      conversations: [
        {
          linkId: 'link_msg',
          counterpart: athleteA,
          unreadCount: 3,
          lastMessage: { id: 'msg_1', senderId: athleteA.id, content: 'Professor, senti uma dor no ombro', createdAt: Date.now() - 1000, readAt: null },
          lastMessageAt: Date.now() - 1000,
          status: 'active',
        },
      ],
      page: { limit: 50, hasMore: false, nextCursor: null },
    }

    await mount('/professionals')

    expect(host.textContent).toContain('3 unread messages')
    expect(host.textContent).toContain('You have unread messages in your athlete conversations.')
    expect(host.textContent).toContain('3 unread')
    expect(host.textContent).toContain('Incoming message')

    const unreadFilterBtn = [...host.querySelectorAll('.pro-status-filter button')].find(b => b.textContent.includes('Unread messages'))
    expect(unreadFilterBtn).toBeTruthy()
    expect(unreadFilterBtn.textContent).toContain('(1)')

    await act(async () => { unreadFilterBtn.click() })
    await settle()

    expect(host.textContent).toContain('Atleta Com Mensagem')
    expect(host.textContent).not.toContain('Atleta Sem Mensagem')
  })

  it('renders export PDF button on active athlete card', async () => {
    const athlete = { id: 'ath_pdf', name: 'Atleta PDF' }
    mocks.user = {
      id: 'u_coach',
      name: 'Coach',
      admin: false,
      profile: { kind: 'coach', coachSpecialties: ['training'] },
      capabilities: ['relationships:invite'],
    }
    mocks.answers['/api/coach/athletes'] = {
      links: [{ id: 'link_pdf', status: 'active', scopes: ['training'], athlete }],
    }
    mocks.answers['/api/messages/inbox'] = { conversations: [], page: { limit: 50, hasMore: false, nextCursor: null } }
    mocks.answers['/api/coach/athletes/ath_pdf/habits'] = { habits: [] }
    mocks.answers['/api/coach/athletes/ath_pdf/progress-summary'] = { summary: null }
    mocks.answers['/api/coach/athletes/ath_pdf/progress-goals'] = { items: [] }
    mocks.answers['/api/coach/athletes/ath_pdf/progress-reports'] = { items: [] }
    mocks.answers['/api/coach/athletes/ath_pdf/prescriptions'] = { prescriptions: [] }

    await mount('/professionals')

    const exportPdfBtn = [...host.querySelectorAll('button')].find(b => b.textContent.includes('Export PDF') || b.textContent.includes('Exportar PDF'))
    expect(exportPdfBtn).toBeTruthy()
  })
