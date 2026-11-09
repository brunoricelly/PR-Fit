// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEF, useStore } from './store/useStore.js'
import TabBar from './components/TabBar.jsx'
import RoleSwitcher from './components/RoleSwitcher.jsx'
import { getActiveRole, setActiveRole, isDualRoleUser, clearRoleStorage } from './lib/roles.js'
import { setLang } from './lib/i18n.js'
import CoachGroupsView from './views/coach/CoachGroupsView.jsx'
import CoachChallengesView from './views/coach/CoachChallengesView.jsx'
import AthleteGroupsView from './views/athlete/AthleteGroupsView.jsx'
import CommunityHub from './views/CommunityHub.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  user: null,
  toast: vi.fn(),
  api: vi.fn(),
  listCoachGroups: vi.fn().mockResolvedValue({ groups: [], page: { hasMore: false } }),
  listCoachChallenges: vi.fn().mockResolvedValue({ challenges: [], page: { hasMore: false } }),
  listCoachGroupPrograms: vi.fn().mockResolvedValue({ programs: [], page: { hasMore: false } }),
  listAthleteGroups: vi.fn().mockResolvedValue({ groups: [], page: { hasMore: false } }),
  listAthleteChallenges: vi.fn().mockResolvedValue({ challenges: [], page: { hasMore: false } }),
  listAthleteGroupPrograms: vi.fn().mockResolvedValue({ programs: [], page: { hasMore: false } }),
}))

vi.mock('./store/useStore.js', async () => {
  const actual = await vi.importActual('./store/useStore.js')
  const snap = () => ({
    S: JSON.parse(JSON.stringify(actual.DEF)),
    user: mocks.user,
    isGuest: () => !mocks.user,
    config: {},
  })
  const useStore = selector => (selector ? selector(snap()) : snap())
  useStore.getState = snap
  return { ...actual, useStore }
})

vi.mock('./store/useUI.js', () => {
  const snap = () => ({ toast: mocks.toast, sheets: [] })
  const useUI = selector => (selector ? selector(snap()) : snap())
  useUI.getState = snap
  return { useUI }
})

vi.mock('./lib/api.js', () => ({
  api: (...args) => mocks.api(...args),
}))

vi.mock('./lib/group-challenges-api.js', () => ({
  listCoachGroups: (...args) => mocks.listCoachGroups(...args),
  listCoachChallenges: (...args) => mocks.listCoachChallenges(...args),
  listCoachGroupPrograms: (...args) => mocks.listCoachGroupPrograms(...args),
  listAthleteGroups: (...args) => mocks.listAthleteGroups(...args),
  listAthleteChallenges: (...args) => mocks.listAthleteChallenges(...args),
  listAthleteGroupPrograms: (...args) => mocks.listAthleteGroupPrograms(...args),
}))

let host, root

beforeEach(async () => {
  await setLang('pt-BR')
  localStorage.clear()
  mocks.api.mockResolvedValue({ links: [] })
  vi.clearAllMocks()
  mocks.user = null
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const settle = () => act(async () => {
  await Promise.resolve()
  await new Promise(resolve => queueMicrotask(resolve))
  await new Promise(resolve => setTimeout(resolve, 0))
})

const mount = async (element, initialEntry = '/home') => {
  act(() => {
    root.render(
      <MemoryRouter initialEntries={[initialEntry]}>
        {element}
      </MemoryRouter>
    )
  })
  await settle()
}

describe('Coach Navigation (Treinador)', () => {
  it('renders complete Coach navigation structure with Alunos, Treinos, Agenda, Comunidade e Configurações', async () => {
    mocks.user = {
      id: 'coach_1',
      name: 'Treinador Bruno',
      profile: { kind: 'coach', coachSpecialties: ['training'] },
    }

    await mount(<TabBar onStart={() => {}} />, '/home')

    const buttons = [...host.querySelectorAll('#tabbar button')]
    const labels = buttons.map(b => b.textContent.trim())

    expect(labels).toContain('Início')
    expect(labels).toContain('Alunos')
    expect(labels).toContain('Treinos')
    expect(labels).toContain('Agenda')
    expect(labels).toContain('Comunidade')
    expect(labels).toContain('Configurações')
    expect(labels).not.toContain('Nutrição')
  })

  it('includes Nutrição in Coach navigation when nutrition specialty is enabled', async () => {
    mocks.user = {
      id: 'coach_nutri',
      name: 'Coach Nutri',
      profile: { kind: 'coach', coachSpecialties: ['training', 'nutrition'] },
    }

    await mount(<TabBar onStart={() => {}} />, '/home')

    const buttons = [...host.querySelectorAll('#tabbar button')]
    const labels = buttons.map(b => b.textContent.trim())

    expect(labels).toContain('Nutrição')
  })
})

describe('Athlete Navigation (Atleta)', () => {
  it('renders thumb-reachable 5-tab bar: Hoje, Meu plano, Evolução, Comunidade e Perfil', async () => {
    mocks.user = {
      id: 'athlete_1',
      name: 'Atleta Alice',
      profile: { kind: 'athlete' },
    }

    await mount(<TabBar onStart={() => {}} />, '/home')

    const buttons = [...host.querySelectorAll('#tabbar button')]
    expect(buttons).toHaveLength(5)

    const labels = buttons.map(b => b.textContent.trim())
    expect(labels).toEqual(['Hoje', 'Meu plano', 'Evolução', 'Comunidade', 'Perfil'])
  })
})

describe('Visual Ambiguity Resolution (Mutual Exclusion)', () => {
  it('highlights strictly one button at any time, never multiple active buttons simultaneously', async () => {
    mocks.user = {
      id: 'coach_1',
      name: 'Treinador Bruno',
      profile: { kind: 'coach', coachSpecialties: ['training'] },
    }

    const testRoutes = [
      '/home',
      '/professionals',
      '/plan',
      '/scheduling',
      '/community',
      '/coach/groups',
      '/settings',
    ]

    for (const route of testRoutes) {
      await mount(<TabBar onStart={() => {}} />, route)
      const activeButtons = host.querySelectorAll('#tabbar button.on')
      expect(activeButtons.length).toBe(1)
    }
  })

  it('lights Comunidade tab for nested community routes (/coach/groups and /community)', async () => {
    mocks.user = {
      id: 'coach_1',
      name: 'Treinador Bruno',
      profile: { kind: 'coach', coachSpecialties: ['training'] },
    }

    await mount(<TabBar onStart={() => {}} />, '/coach/groups')

    const activeButton = host.querySelector('#tabbar button.on')
    expect(activeButton).toBeTruthy()
    expect(activeButton.textContent).toContain('Comunidade')
  })
})

describe('Community Back Navigation Hierarchy', () => {
  it('navigates back from CoachGroupsView to Comunidade, NOT to Meus alunos', async () => {
    let currentPath = '/coach/groups'
    const TestApp = () => {
      const navigate = useNavigate()
      return (
        <div>
          <button data-testid="goto-community" onClick={() => navigate('/community')}>Comunidade</button>
          <CoachGroupsView />
        </div>
      )
    }

    await mount(<TestApp />, '/coach/groups')

    const backButton = host.querySelector('.pro-nav button')
    expect(backButton).toBeTruthy()
    expect(backButton.textContent).toContain('Comunidade')
    expect(backButton.textContent).not.toContain('Meus alunos')
  })

  it('navigates back from CoachChallengesView to Comunidade, NOT to Meus alunos', async () => {
    await mount(<CoachChallengesView />, '/coach/challenges')

    const backButton = host.querySelector('.pro-nav button')
    expect(backButton).toBeTruthy()
    expect(backButton.textContent).toContain('Comunidade')
    expect(backButton.textContent).not.toContain('Meus alunos')
  })

  it('navigates back from AthleteGroupsView to Comunidade, NOT to Settings', async () => {
    await mount(<AthleteGroupsView />, '/athlete/groups')

    const backButton = host.querySelector('.pro-nav button')
    expect(backButton).toBeTruthy()
    expect(backButton.textContent).toContain('Comunidade')
    expect(backButton.textContent).not.toContain('Configurações')
  })

  it('navigates back from standalone CommunityHub to Início, preserving hierarchy', async () => {
    mocks.user = { id: 'u_1', profile: { kind: 'coach' } }
    await mount(<CommunityHub />, '/community')

    const backButton = host.querySelector('.pro-nav button')
    expect(backButton).toBeTruthy()
    expect(backButton.textContent).toContain('Início')
    expect(backButton.textContent).not.toContain('Meus alunos')
  })
})

describe('Dual-Role Mode Switching & Persistence', () => {
  it('detects dual-role capabilities and allows persistent role toggling', async () => {
    const coachUser = {
      id: 'dual_coach_1',
      name: 'Coach Bruno',
      profile: { kind: 'coach' },
    }

    expect(isDualRoleUser(coachUser)).toBe(true)
    expect(getActiveRole(coachUser)).toBe('coach')

    // Toggle to athlete mode
    setActiveRole(coachUser, 'athlete')
    expect(getActiveRole(coachUser)).toBe('athlete')

    // Persisted in localStorage
    expect(localStorage.getItem('prfit_active_role_dual_coach_1')).toBe('athlete')

    // Toggle back to coach mode
    setActiveRole(coachUser, 'coach')
    expect(getActiveRole(coachUser)).toBe('coach')
    expect(localStorage.getItem('prfit_active_role_dual_coach_1')).toBe('coach')
  })

  it('renders RoleSwitcher as a named mode control with pressed state', async () => {
    const onSwitch = vi.fn()
    await mount(<RoleSwitcher activeRole="coach" onSwitch={onSwitch} />)

    const switcher = host.querySelector('[role="group"]')
    expect(switcher).toBeTruthy()
    expect(switcher.getAttribute('aria-label')).toBe('Alternar papel')

    const [coachTab, athleteTab] = host.querySelectorAll('.ds-role-tab')

    expect(coachTab.getAttribute('aria-pressed')).toBe('true')
    expect(athleteTab.getAttribute('aria-pressed')).toBe('false')
    expect(coachTab.hasAttribute('aria-controls')).toBe(false)
    expect(athleteTab.hasAttribute('aria-controls')).toBe(false)

    await act(async () => {
      athleteTab.click()
    })
    expect(onSwitch).toHaveBeenCalledWith('athlete')
  })

  it('updates TabBar dynamically when role mode changes in dual-role', async () => {
    const coachUser = {
      id: 'dual_coach_2',
      name: 'Coach Bruno',
      profile: { kind: 'coach', coachSpecialties: ['training'] },
    }
    mocks.user = coachUser

    await mount(<TabBar onStart={() => {}} />, '/home')

    // In Coach mode initially
    expect(host.textContent).toContain('Alunos')

    // Switch to athlete mode
    await act(async () => {
      setActiveRole(coachUser, 'athlete')
    })
    await settle()

    // TabBar dynamically switches to Athlete navigation
    expect(host.textContent).toContain('Meu plano')
    expect(host.textContent).toContain('Evolução')
    expect(host.textContent).toContain('Perfil')
    expect(host.textContent).not.toContain('Alunos')
  })

  it('does not display role switcher in CommunityHub for standard athlete users', async () => {
    const athleteUser = {
      id: 'athlete_standard_1',
      name: 'Standard Athlete',
      profile: { kind: 'athlete' },
    }
    mocks.user = athleteUser
    await mount(<CommunityHub />, '/community')

    const switcher = host.querySelector('[aria-label="Role switch"], [aria-label="Alternar papel"]')
    expect(switcher).toBeNull()
    expect(host.textContent).not.toContain('Coach view')
    expect(host.textContent).not.toContain('Athlete view')
  })

  it('displays role switcher in CommunityHub for verified dual-role users', async () => {
    const coachUser = {
      id: 'coach_dual_1',
      name: 'Coach Bruno',
      profile: { kind: 'coach' },
    }
    mocks.user = coachUser
    await mount(<CommunityHub />, '/community')

    const switcher = host.querySelector('[role="group"][aria-label="Alternar visão"]')
    expect(switcher).toBeTruthy()
    expect(switcher.querySelectorAll('button[aria-pressed]')).toHaveLength(2)
    expect(switcher.textContent).toContain('Visão do treinador')
    expect(switcher.textContent).toContain('Visão do atleta')
  })

  it('cleans up prfit_active_role keys on clearRoleStorage', () => {
    localStorage.setItem('prfit_active_role', 'coach')
    localStorage.setItem('prfit_active_role_user_1', 'athlete')
    localStorage.setItem('prfit_active_role_user_2', 'coach')
    localStorage.setItem('other_app_key', 'preserve')

    clearRoleStorage()

    expect(localStorage.getItem('prfit_active_role')).toBeNull()
    expect(localStorage.getItem('prfit_active_role_user_1')).toBeNull()
    expect(localStorage.getItem('prfit_active_role_user_2')).toBeNull()
    expect(localStorage.getItem('other_app_key')).toBe('preserve')
  })
})
