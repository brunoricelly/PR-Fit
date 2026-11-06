// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  user: null, calls: [], answers: {}, toast: vi.fn(), setUser: vi.fn(), confirms: [], copied: [],
}))

vi.mock('../store/useStore.js', () => {
  const snap = () => ({ user: mocks.user, setUser: mocks.setUser })
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
  Object.assign(mocks, { user: null, calls: [], answers: {}, toast: vi.fn(), setUser: vi.fn(), confirms: [], copied: [] })
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
const type = async (input, value) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('ProfessionalHub', () => {
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
})
