// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App.jsx'
import { DEF, useStore } from './store/useStore.js'
import { setLang } from './lib/i18n.js'
import { auditA11y } from './test/a11y-dom-audit.js'
import { guardReactWarnings, waitForReact } from './test/react-warning-guard.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const apiResponse = path => {
  if (path === '/api/admin/users') return { users: [], invite_only: false }
  if (path === '/api/admin/invites') return { invites: [] }
  if (path === '/api/admin/coach') return {
    enabled: false,
    disabledByEnv: false,
    provider: '',
    providers: [],
    knownModels: [],
    auth: { state: 'not-required' },
    runtime: { ok: true },
    caps: { maxOutputTokens: 4096, daily: 0, maxMessageLen: 4000 },
  }
  if (path.includes('/messages/inbox')) return { conversations: [], page: { hasMore: false } }
  if (path.includes('/appointments')) return { appointments: [], page: { hasMore: false } }
  if (path.includes('/availability-slots')) return { slots: [] }
  if (path.includes('/availability')) return { availability: null, rev: 0 }
  if (path.includes('/reminder-preferences')) return { enabled: true, offsetsMinutes: [60], timeZone: 'America/Sao_Paulo' }
  if (path.includes('/coach/athletes')) return { links: [], page: { hasMore: false } }
  if (path.includes('/athlete/coaches')) return { links: [], page: { hasMore: false } }
  if (path.includes('/athlete/prescriptions')) return { prescriptions: [] }
  if (path.includes('/groups')) return { groups: [], page: { hasMore: false } }
  if (path.includes('/challenges')) return { challenges: [], page: { hasMore: false } }
  if (path.includes('/programs')) return { programs: [], page: { hasMore: false } }
  if (path.includes('/habits')) return { habits: [], checkins: [], summary: null, page: { hasMore: false } }
  return { items: [], links: [], page: { hasMore: false } }
}

vi.mock('./lib/sound.js', async importOriginal => ({
  ...(await importOriginal()),
  setPlayOnSilent: vi.fn(),
  setVibrate: vi.fn(),
  setAlarmBuzzer: vi.fn(),
  setNativeBuzzer: vi.fn(),
}))

vi.mock('./lib/api.js', async importOriginal => ({
  ...(await importOriginal()),
  api: vi.fn(async path => apiResponse(String(path))),
  beacon: vi.fn(),
}))

const athlete = { id: 'athlete-a11y', name: 'Atleta', profile: { kind: 'athlete' } }
const coach = { id: 'coach-a11y', name: 'Treinador', profile: { kind: 'coach', coachSpecialties: ['training', 'nutrition'] } }
const admin = { ...coach, id: 'admin-a11y', admin: true }

const ROUTES = [
  ['/home', athlete], ['/checkin', athlete], ['/plan', athlete], ['/plan/r/missing', athlete],
  ['/plan/programmes', athlete], ['/plan/prog/missing', athlete], ['/workout', athlete], ['/stats', athlete],
  ['/history', athlete], ['/library', athlete], ['/muscles', athlete], ['/structural-balance', athlete],
  ['/progress-photos', athlete], ['/measurements', athlete], ['/settings', athlete], ['/settings/units', athlete],
  ['/professionals', coach], ['/scheduling', coach], ['/coach/groups', coach], ['/coach/challenges', coach],
  ['/coach/programs', coach], ['/athlete/groups', athlete], ['/athlete/challenges', athlete], ['/athlete/programs', athlete],
  ['/community', athlete], ['/join', athlete], ['/groups', athlete], ['/challenges', athlete],
  ['/group-programs', athlete], ['/coach', athlete], ['/coach/intake', athlete], ['/coach/proposal', athlete],
  ['/coach/setup', athlete], ['/admin', admin], ['/rota-inexistente', athlete],
]

let host
let root
let originalStore
let assertNoReactWarnings

const settleRoute = async () => {
  await waitForReact(() => {
    const main = host.querySelector('#main-content')
    expect(main).toBeTruthy()
    expect(main.querySelector('h1')).toBeTruthy()
    expect(main.querySelector('.route-load-state')).toBeNull()
  }, { timeout: 10000 })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}

beforeEach(async () => {
  await setLang('pt-BR')
  localStorage.clear()
  originalStore = useStore.getState()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host, { onCaughtError: () => {} })
  assertNoReactWarnings = guardReactWarnings()
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.querySelectorAll('#modal-root, .ds-modal-backdrop').forEach(element => element.remove())
  useStore.setState(originalStore, true)
  window.location.hash = ''
  assertNoReactWarnings()
  vi.clearAllMocks()
})

describe('WCAG route surface harness', () => {
  it('keeps one deterministic rendered case for each of the 35 router declarations', () => {
    expect(ROUTES).toHaveLength(35)
  })

  it.each(ROUTES)('%s exposes one named, structured route surface', async (path, user) => {
    const state = JSON.parse(JSON.stringify(DEF))
    state.lang = 'pt-BR'
    window.location.hash = `#${path}`
    useStore.setState({
      S: state,
      user,
      ready: true,
      config: {},
      needsMobileOnboarding: false,
      permSteps: false,
      boot: vi.fn(),
    })

    act(() => root.render(<App />))
    await settleRoute()

    expect(auditA11y(host), `${path}\n${host.querySelector('#main-content')?.textContent?.slice(0, 500)}`).toEqual([])
  }, 15000)

  it('moves focus from the skip link to the current main landmark', async () => {
    const state = JSON.parse(JSON.stringify(DEF))
    window.location.hash = '#/library'
    useStore.setState({ S: state, user: athlete, ready: true, config: {}, needsMobileOnboarding: false, permSteps: false, boot: vi.fn() })
    act(() => root.render(<App />))
    await settleRoute()
    const main = host.querySelector('#main-content')
    main.scrollIntoView = vi.fn()
    act(() => host.querySelector('.skip-link').click())
    expect(document.activeElement).toBe(main)
    expect(main.scrollIntoView).toHaveBeenCalledWith({ block: 'start' })
  })

  it.each([
    ['pública sem sessão', false],
    ['modo local guest', true],
  ])('covers the %s composition', async (_label, guest) => {
    const state = JSON.parse(JSON.stringify(DEF))
    if (guest) localStorage.setItem('gym_guest', '1')
    window.location.hash = '#/home'
    useStore.setState({ S: state, user: null, ready: true, config: {}, needsMobileOnboarding: false, permSteps: false, boot: vi.fn() })
    act(() => root.render(<App />))
    await settleRoute()
    expect(auditA11y(host)).toEqual([])
  })

  it('supports roving tab focus with arrows, Home and End in Community', async () => {
    const state = JSON.parse(JSON.stringify(DEF))
    window.location.hash = '#/community'
    useStore.setState({ S: state, user: athlete, ready: true, config: {}, needsMobileOnboarding: false, permSteps: false, boot: vi.fn() })
    act(() => root.render(<App />))
    await settleRoute()

    const groups = host.querySelector('[data-community-tab="groups"]')
    await act(async () => {
      groups.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.dataset.communityTab).toBe('challenges')
    expect(document.activeElement?.dataset.communityTab).toBe('challenges')

    await act(async () => {
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.dataset.communityTab).toBe('programs')
    expect(host.querySelector('[data-community-panel="programs"]')?.hidden).toBe(false)

    await act(async () => {
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.dataset.communityTab).toBe('groups')
  })
})
