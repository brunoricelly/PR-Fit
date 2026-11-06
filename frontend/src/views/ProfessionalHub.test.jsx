// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
    const answer = mocks.answers[path]
    if (answer instanceof Error) throw answer
    return typeof answer === 'function' ? answer(body) : answer ?? {}
  }),
}))
vi.mock('../lib/clipboard.js', () => ({ copyText: vi.fn(async value => { mocks.copied.push(value); return true }) }))
vi.mock('../sheets.jsx', () => ({ confirmSheet: options => mocks.confirms.push(options) }))

import ProfessionalHub from './ProfessionalHub.jsx'

let host, root
beforeEach(() => {
  Object.assign(mocks, { user: null, calls: [], answers: {}, toast: vi.fn(), setUser: vi.fn(), pullState: vi.fn(), confirms: [], copied: [] })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
const mount = async entry => {
  act(() => root.render(<MemoryRouter initialEntries={[entry]}><ProfessionalHub /></MemoryRouter>))
  await settle()
}
const button = label => [...host.querySelectorAll('button')].find(item => item.textContent.trim() === label)
const card = label => [...host.querySelectorAll('.pro-link')].find(item => item.textContent.includes(label))
const type = async (input, value) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('ProfessionalHub', () => {
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
})
