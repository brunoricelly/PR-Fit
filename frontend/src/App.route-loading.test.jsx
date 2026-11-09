// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App.jsx'
import { DEF, useStore } from './store/useStore.js'
import { setActiveRole } from './lib/roles.js'
import { setLang } from './lib/i18n.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const groupMocks = vi.hoisted(() => ({
  listCoachGroups: vi.fn().mockResolvedValue({ groups: [], page: { hasMore: false } }),
  listAthleteGroups: vi.fn().mockResolvedValue({ groups: [], page: { hasMore: false } }),
}))

vi.mock('./lib/sound.js', async importOriginal => ({
  ...(await importOriginal()),
  setPlayOnSilent: vi.fn(),
  setVibrate: vi.fn(),
  setAlarmBuzzer: vi.fn(),
  setNativeBuzzer: vi.fn(),
}))

vi.mock('./lib/api.js', async importOriginal => ({
  ...(await importOriginal()),
  api: vi.fn().mockResolvedValue({}),
  beacon: vi.fn(),
}))

vi.mock('./lib/group-challenges-api.js', async importOriginal => ({
  ...(await importOriginal()),
  listCoachGroups: (...args) => groupMocks.listCoachGroups(...args),
  listAthleteGroups: (...args) => groupMocks.listAthleteGroups(...args),
}))

let host
let root
let originalStore
let consoleError
let consoleWarn

const appear = async find => {
  const get = typeof find === 'string' ? () => host.querySelector(find) : find
  for (let attempt = 0; attempt < 200 && !get(); attempt++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) })
  }
  return get()
}

const mountDeepLink = async (hash, user) => {
  window.location.hash = hash
  const state = JSON.parse(JSON.stringify(DEF))
  state.lang = 'pt-BR'
  useStore.setState({
    S: state,
    user,
    ready: true,
    config: {},
    needsMobileOnboarding: false,
    permSteps: false,
    boot: vi.fn(),
  })
  await act(async () => { root.render(<App />) })
}

beforeEach(async () => {
  await setLang('pt-BR')
  localStorage.clear()
  vi.clearAllMocks()
  originalStore = useStore.getState()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host, { onCaughtError: () => {} })
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useStore.setState(originalStore, true)
  window.location.hash = ''
  const consoleText = [...consoleError.mock.calls, ...consoleWarn.mock.calls].flat().join(' ')
  expect(consoleText).not.toMatch(/act\(|unique "key"|Each child in a list/i)
  vi.restoreAllMocks()
})

describe('deep links com superfícies carregadas por rota', () => {
  it('resolve o deep link de treinador sem atravessar a área do atleta', async () => {
    const coach = { id: 'coach-route', name: 'Coach', profile: { kind: 'coach' } }
    await mountDeepLink('#/coach/groups', coach)

    const heading = await appear('h1')
    expect(window.location.hash).toBe('#/coach/groups')
    expect(heading?.textContent).toBe('Grupos')
    expect(groupMocks.listCoachGroups).toHaveBeenCalledTimes(1)
    expect(groupMocks.listAthleteGroups).not.toHaveBeenCalled()
  })

  it('resolve o deep link de atleta sem carregar a área do treinador', async () => {
    const athlete = { id: 'athlete-route', name: 'Atleta', profile: { kind: 'athlete' } }
    await mountDeepLink('#/athlete/groups', athlete)

    const heading = await appear('h1')
    expect(window.location.hash).toBe('#/athlete/groups')
    expect(heading?.textContent).toBe('Meus grupos')
    expect(groupMocks.listAthleteGroups).toHaveBeenCalledTimes(1)
    expect(groupMocks.listCoachGroups).not.toHaveBeenCalled()
  })

  it('preserva o modo atleta de um usuário dual-role em deep link', async () => {
    const dual = { id: 'dual-route', name: 'Dual', profile: { kind: 'coach' } }
    setActiveRole(dual, 'athlete')
    await mountDeepLink('#/athlete/groups', dual)

    const heading = await appear('h1')
    expect(window.location.hash).toBe('#/athlete/groups')
    expect(heading?.textContent).toBe('Meus grupos')
    expect(host.querySelector('.shell-dual-role-current')?.textContent).toContain('Aluno')
    expect(groupMocks.listAthleteGroups).toHaveBeenCalledTimes(1)
  })
})
