// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../../store/useStore.js'
import AthleteToday from './AthleteToday.jsx'

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  inbox: vi.fn(),
  habits: vi.fn(),
  appointments: vi.fn(),
  startFlow: vi.fn(),
}))

vi.mock('../../lib/api.js', () => ({ api: mocks.api }))
vi.mock('../../lib/communication-api.js', () => ({
  communicationApi: { inbox: mocks.inbox, athleteHabits: mocks.habits },
  browserTimeZone: () => ({ value: 'America/Sao_Paulo', fallback: false }),
}))
vi.mock('../../lib/scheduling-api.js', () => ({ getAthleteAppointments: mocks.appointments }))
vi.mock('../../sheets.jsx', () => ({ startFlow: mocks.startFlow }))

let host
let root

const user = { id: 'athlete_1', name: 'Alice Souza', profile: { kind: 'athlete' } }
const today = new Date().toISOString().slice(0, 10)

const state = extra => useStore.setState(current => ({
  user,
  ready: true,
  S: {
    ...current.S,
    routines: [{ id: 'routine_1', name: 'Treino A', ex: [] }],
    week: { 0: ['routine_1'], 1: ['routine_1'], 2: ['routine_1'], 3: ['routine_1'], 4: ['routine_1'], 5: ['routine_1'], 6: ['routine_1'] },
    dayPlan: {},
    workouts: [],
    active: null,
    gymCards: [],
    ...extra,
  },
}))

const settle = async () => act(async () => {
  await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
})

const renderToday = async () => {
  await act(async () => { root.render(<MemoryRouter><AthleteToday /></MemoryRouter>) })
  await settle()
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  state()
  mocks.api.mockImplementation(path => Promise.resolve(path === '/api/athlete/meal-plan' ? { mealPlan: null } : { adherenceRecords: [] }))
  mocks.inbox.mockResolvedValue({ conversations: [] })
  mocks.habits.mockResolvedValue({ habits: [] })
  mocks.appointments.mockResolvedValue({ items: [] })
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.clearAllMocks()
})

describe('AthleteToday', () => {
  it('explica o treino de hoje e mostra somente módulos remotos relevantes', async () => {
    mocks.api.mockImplementation(path => Promise.resolve(path === '/api/athlete/meal-plan'
      ? { mealPlan: { id: 'meal_1', title: 'Plano leve', meals: [{ id: 'm1' }, { id: 'm2' }], targetMacros: { waterMl: 2500 } } }
      : { adherenceRecords: [{ mealPlanId: 'meal_1', mealsChecked: ['m1'], waterDrunkMl: 900 }] }))
    mocks.inbox.mockResolvedValue({ conversations: [{ linkId: 'link_1', unreadCount: 1 }] })
    mocks.habits.mockResolvedValue({ habits: [{ id: 'habit_1', title: 'Água', checkin: { completed: true } }] })
    mocks.appointments.mockResolvedValue({ items: [{ id: 'app_1', title: 'Consulta', startAt: '2026-11-10T14:00:00.000Z', coach: { name: 'Bruno' } }] })

    await renderToday()

    expect(host.textContent).toContain('Treino A')
    expect(host.textContent).toContain('Iniciar treino')
    expect(host.textContent).toContain('Plano leve')
    expect(host.textContent).toContain('1 de 2 refeições marcadas')
    expect(host.textContent).toContain('1 de 1 concluídos')
    expect(host.textContent).toContain('Consulta')
    expect(host.textContent).toContain('1 aviso não lido')
    expect(host.textContent).not.toContain('Check-in')
  })

  it('oferece continuar o treino como única ação primária', async () => {
    state({ active: { id: 'active_1', name: 'Treino em curso', start: Date.now() } })

    await renderToday()

    const primary = host.querySelectorAll('.ds-button.primary')
    expect(primary).toHaveLength(1)
    expect(primary[0].textContent).toContain('Continuar treino')
  })

  it('mostra vazio com próxima ação quando não há plano nem módulos relevantes', async () => {
    state({ routines: [], week: {}, workouts: [], active: null })

    await renderToday()

    expect(host.textContent).toContain('Seu dia está livre')
    expect(host.textContent).toContain('Criar plano')
    expect(host.textContent).not.toContain('Alimentação')
    expect(host.textContent).not.toContain('Hábitos')
  })

  it('mantém o treino local disponível em erro e offline', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })
    mocks.api.mockRejectedValue(new Error('offline'))
    mocks.inbox.mockRejectedValue(new Error('offline'))
    mocks.habits.mockRejectedValue(new Error('offline'))
    mocks.appointments.mockRejectedValue(new Error('offline'))

    await renderToday()

    expect(host.textContent).toContain('Você está offline')
    expect(host.textContent).toContain('Iniciar treino')
    expect(host.textContent).toContain('Treino A')
  })

  it('usa skeleton antes de o estado local estar pronto', () => {
    useStore.setState({ user, ready: false })

    act(() => root.render(<MemoryRouter><AthleteToday /></MemoryRouter>))

    expect(host.querySelector('[aria-busy="true"]')).toBeTruthy()
    expect(host.querySelectorAll('.ds-skeleton').length).toBeGreaterThan(2)
  })

  it('resume a semana a partir do histórico já carregado', async () => {
    state({ workouts: [{ id: 'w1', d: today, routineId: 'routine_1', entries: [] }] })

    await renderToday()

    expect(host.textContent).toContain('Ver treino concluído')
    expect(host.textContent).toContain('Progresso semanal')
  })
})
