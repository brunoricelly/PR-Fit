// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../../store/useStore.js'
import AthleteToday from './AthleteToday.jsx'
import { setFirstStepsDismissed } from '../../lib/first-steps-store.js'

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
const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject })
  return { promise, resolve, reject }
}

function LocationProbe() {
  const location = useLocation()
  return <span data-location={location.pathname + location.search} />
}

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
  await act(async () => { root.render(<MemoryRouter><AthleteToday /><LocationProbe /></MemoryRouter>) })
  await settle()
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
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
    expect(host.querySelector('progress[aria-label="Progresso da meta de água"]')).toBeTruthy()
    expect(host.textContent).not.toContain('Entenda seu plano')
    expect(host.textContent).toContain('Inicie seu primeiro treino')
  })

  it('usa histórico real para concluir o primeiro treino e abre Evolução', async () => {
    state({ workouts: [{ id: 'w1', d: today, routineId: 'routine_1', entries: [] }] })
    await renderToday()

    expect(host.textContent).not.toContain('Inicie seu primeiro treino')
    const evolution = [...host.querySelectorAll('button')].find(button => button.textContent.includes('Abrir Evolução'))
    await act(async () => evolution.click())
    expect(host.querySelector('[data-location]').dataset.location).toBe('/stats')
  })

  it('retoma o checklist Atleta persistido sem expor tarefas de Coach', async () => {
    await act(async () => { setFirstStepsDismissed(user.id, 'athlete', true) })
    await renderToday()

    expect(host.textContent).toContain('Retomar primeiros passos')
    expect(host.textContent).not.toContain('Adicione seu primeiro aluno')
    expect(host.textContent).not.toContain('Configure sua disponibilidade')
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
    expect(host.querySelector('progress[aria-label="Progresso semanal de treinos"]')).toBeTruthy()
  })

  it('mantém o plano conhecido quando a adesão falha sem inventar zero', async () => {
    mocks.api.mockImplementation(path => path === '/api/athlete/meal-plan'
      ? Promise.resolve({ mealPlan: { id: 'meal_1', title: 'Plano preservado', meals: [{ id: 'm1' }], targetMacros: { waterMl: 2000 } } })
      : Promise.reject(new Error('adesão indisponível')))

    await renderToday()

    expect(host.textContent).toContain('Plano preservado')
    expect(host.textContent).toContain('Adesão indisponível agora')
    expect(host.textContent).not.toContain('0 de 1 refeições marcadas')
  })

  it('trata payload 2xx malformado como erro da fonte, sem crash ou falso vazio', async () => {
    state({ routines: [], week: {}, workouts: [], active: null })
    mocks.appointments.mockResolvedValue({ items: { id: 'não-array' } })

    await renderToday()

    expect(host.textContent).toContain('Agenda indisponível')
    expect(host.textContent).not.toContain('Seu dia está livre')
  })

  it('isola troca de conta e ignora a resposta antiga resolvida depois da nova', async () => {
    const oldInbox = deferred()
    mocks.inbox.mockImplementationOnce(() => oldInbox.promise)
      .mockResolvedValueOnce({ conversations: [{ linkId: 'new_link', unreadCount: 2 }] })

    await act(async () => { root.render(<MemoryRouter><AthleteToday /></MemoryRouter>) })
    await act(async () => {
      useStore.setState({ user: { id: 'athlete_2', name: 'Beatriz Nova', profile: { kind: 'athlete' } } })
    })
    await settle()

    expect(host.textContent).toContain('Olá, Beatriz.')
    expect(host.textContent).toContain('2 avisos não lidos')

    await act(async () => { oldInbox.resolve({ conversations: [{ linkId: 'old_link', unreadCount: 9 }] }) })
    await settle()

    expect(host.textContent).toContain('2 avisos não lidos')
    expect(host.textContent).not.toContain('9 avisos não lidos')
  })

  it('invalida a geração no unmount e aborta as requisições em voo', async () => {
    const pendingInbox = deferred()
    mocks.inbox.mockImplementation((_params, options) => {
      expect(options.signal.aborted).toBe(false)
      return pendingInbox.promise
    })

    await act(async () => { root.render(<MemoryRouter><AthleteToday /></MemoryRouter>) })
    const signal = mocks.inbox.mock.calls[0][1].signal
    act(() => root.unmount())
    expect(signal.aborted).toBe(true)

    await act(async () => { pendingInbox.resolve({ conversations: [{ linkId: 'late', unreadCount: 7 }] }) })
  })

  it('não chama hábitos nem atribui inbox ao papel Atleta em conta dual-role', async () => {
    useStore.setState({ user: { id: 'dual_1', name: 'Dani Dual', profile: { kind: 'coach', coachSpecialties: ['training'] } } })
    mocks.appointments.mockResolvedValue({ items: [{ id: 'app_dual', title: 'Consulta dual', startAt: '2026-11-10T14:00:00.000Z' }] })

    await renderToday()

    expect(mocks.habits).not.toHaveBeenCalled()
    expect(mocks.inbox).not.toHaveBeenCalled()
    expect(host.textContent).toContain('Consulta dual')
    expect(host.textContent).toContain('Hábitos indisponíveis')
    expect(host.textContent).toContain('Mensagens indisponíveis')
    expect(host.textContent).not.toContain('Seu dia está livre')
  })
})
