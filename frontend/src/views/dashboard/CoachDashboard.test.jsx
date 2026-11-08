// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../../store/useStore.js'
import CoachDashboard from './CoachDashboard.jsx'
import { normalizeAvailability, normalizeSummary } from './dashboard-data.js'
import { setFirstStepsDismissed } from '../../lib/first-steps-store.js'

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  inbox: vi.fn(),
  summary: vi.fn(),
  appointments: vi.fn(),
  availability: vi.fn(),
}))

vi.mock('../../lib/api.js', () => ({ api: mocks.api }))
vi.mock('../../lib/communication-api.js', () => ({
  communicationApi: { inbox: mocks.inbox, summary: mocks.summary },
  browserTimeZone: () => ({ value: 'America/Sao_Paulo', fallback: false }),
}))
vi.mock('../../lib/scheduling-api.js', () => ({ getCoachAppointments: mocks.appointments, getCoachAvailability: mocks.availability }))

let host
let root

const user = { id: 'coach_1', name: 'Bruno Lima', profile: { kind: 'coach', coachSpecialties: ['training'] } }
const link = { id: 'link_1', status: 'active', scopes: ['training'], athlete: { id: 'athlete_1', name: 'Ana' } }
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

const settle = async () => act(async () => {
  await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
})

const renderDashboard = async () => {
  useStore.setState({ user, ready: true })
  await act(async () => {
    root.render(<MemoryRouter><CoachDashboard /><LocationProbe /></MemoryRouter>)
  })
  await settle()
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  mocks.api.mockResolvedValue({ links: [] })
  mocks.inbox.mockResolvedValue({ conversations: [] })
  mocks.summary.mockResolvedValue({ summary: null })
  mocks.appointments.mockResolvedValue({ items: [] })
  mocks.availability.mockResolvedValue({ availability: null })
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.clearAllMocks()
})

describe('CoachDashboard', () => {
  it('prioriza atenção, agenda, mensagens, adesão e ações rápidas com dados reais', async () => {
    mocks.api.mockResolvedValue({ links: [link] })
    mocks.inbox.mockResolvedValue({ conversations: [
      { linkId: link.id, unreadCount: 2 },
      { linkId: 'athlete_side_link', unreadCount: 8 },
    ] })
    mocks.summary.mockResolvedValue({ summary: { adherencePercent: 0, completedDays: 0, scheduledDays: 4 } })
    mocks.appointments.mockResolvedValue({ items: [{ id: 'app_1', title: 'Avaliação', startAt: '2026-11-08T15:00:00.000Z', athlete: { name: 'Ana' } }] })

    await renderDashboard()

    expect(host.textContent).toContain('Ana')
    expect(host.textContent).toContain('2 mensagens não lidas')
    expect(host.textContent).not.toContain('10 mensagens não lidas')
    expect(host.textContent).toContain('nenhum check-in concluído nesta semana')
    expect(host.textContent).toContain('Avaliação')
    expect(host.textContent).toContain('0%')
    expect(host.textContent).toContain('Alunos')
    expect(host.textContent).toContain('Comunidade')
    expect(mocks.summary).toHaveBeenCalledWith(expect.objectContaining({ athleteId: 'athlete_1', period: 7 }), expect.objectContaining({ signal: expect.any(AbortSignal) }))
  })

  it('mostra vazios acionáveis sem inventar métricas', async () => {
    await renderDashboard()

    expect(host.textContent).toContain('Nenhuma pendência agora')
    expect(host.textContent).toContain('Agenda livre hoje')
    expect(host.textContent).toContain('Sem mensagens pendentes ou dados de adesão para mostrar')
    expect(host.textContent).toContain('Adicione seu primeiro aluno')
    expect(host.textContent).toContain('Configure sua disponibilidade')
  })

  it('conclui passos apenas com vínculos e disponibilidade realmente existentes', async () => {
    mocks.api.mockResolvedValue({ links: [link] })
    mocks.availability.mockResolvedValue({ availability: { timeZone: 'America/Sao_Paulo', windows: [], exceptions: [] } })

    await renderDashboard()

    expect(host.textContent).not.toContain('Adicione seu primeiro aluno')
    expect(host.textContent).not.toContain('Configure sua disponibilidade')
    expect(host.textContent).toContain('Prescreva o primeiro treino')
  })

  it('leva a disponibilidade para a aba Coach correta e preserva dismiss local', async () => {
    await renderDashboard()
    const availability = [...host.querySelectorAll('button')].find(button => button.textContent.includes('Configurar agenda'))
    await act(async () => availability.click())
    expect(host.querySelector('[data-location]').dataset.location).toBe('/scheduling?tab=availability')

    await act(async () => { setFirstStepsDismissed(user.id, 'coach', true) })
    await settle()
    expect(host.textContent).toContain('Retomar primeiros passos')
  })

  it('mostra skeleton enquanto a carga inicial está pendente', async () => {
    useStore.setState({ user, ready: true })
    mocks.api.mockImplementation(() => new Promise(() => {}))
    mocks.inbox.mockImplementation(() => new Promise(() => {}))
    mocks.appointments.mockImplementation(() => new Promise(() => {}))

    act(() => root.render(<MemoryRouter><CoachDashboard /></MemoryRouter>))

    expect(host.querySelector('[aria-busy="true"]')).toBeTruthy()
    expect(host.querySelectorAll('.ds-skeleton').length).toBeGreaterThan(2)
  })

  it('oferece recuperação quando as fontes principais falham', async () => {
    mocks.api.mockRejectedValue(new Error('falha'))
    mocks.inbox.mockRejectedValue(new Error('falha'))
    mocks.appointments.mockRejectedValue(new Error('falha'))

    await renderDashboard()

    expect(host.textContent).toContain('Não foi possível abrir sua visão geral')
    expect([...host.querySelectorAll('button')].some(button => button.textContent.includes('Tentar novamente'))).toBe(true)
  })

  it('distingue o estado offline da falha de servidor', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })
    mocks.api.mockRejectedValue(new Error('offline'))
    mocks.inbox.mockRejectedValue(new Error('offline'))
    mocks.appointments.mockRejectedValue(new Error('offline'))

    await renderDashboard()

    expect(host.textContent).toContain('Você está offline')
    expect(host.textContent).toContain('buscar alunos, agenda e mensagens')
  })

  it('mantém conteúdo conhecido e não afirma zero quando uma fonte parcial falha', async () => {
    mocks.api.mockResolvedValue({ links: [link] })
    mocks.inbox.mockRejectedValue(new Error('inbox indisponível'))
    mocks.appointments.mockResolvedValue({ items: [{ id: 'app_1', title: 'Avaliação conhecida', startAt: '2026-11-08T15:00:00.000Z' }] })

    await renderDashboard()

    expect(host.textContent).toContain('Avaliação conhecida')
    expect(host.textContent).toContain('Mensagens do papel Coach indisponíveis')
    expect(host.textContent).not.toContain('Nenhuma pendência agora')
    expect(host.textContent).not.toContain('Sem mensagens pendentes')
  })

  it.each([
    ['falha', () => mocks.api.mockRejectedValue(new Error('vínculos indisponíveis'))],
    ['payload malformado', () => mocks.api.mockResolvedValue({ links: 'não-array' })],
  ])('trata contagens de adesão como desconhecidas quando links têm %s', async (_scenario, arrangeLinks) => {
    arrangeLinks()
    mocks.inbox.mockResolvedValue({ conversations: [] })
    mocks.appointments.mockResolvedValue({ items: [{ id: 'app_1', title: 'Avaliação conhecida', startAt: '2026-11-08T15:00:00.000Z' }] })

    await renderDashboard()

    expect(host.textContent).toContain('Avaliação conhecida')
    expect(host.textContent).toContain('Resumos de adesão indisponíveis porque os vínculos não carregaram.')
    expect(host.textContent).not.toContain('0 de 0')
    expect(host.textContent).not.toContain('0 alunos')
    expect(host.textContent).not.toContain('Nenhuma pendência agora')
    expect(mocks.summary).not.toHaveBeenCalled()
  })

  it('rejeita percentual de adesão fora da faixa de 0 a 100', () => {
    expect(() => normalizeSummary({ summary: { adherencePercent: 101, completedDays: 1, scheduledDays: 1 } })).toThrow('Resumo de adesão inválido')
    expect(normalizeSummary({ summary: { adherencePercent: 100, completedDays: 1, scheduledDays: 1 } }).adherencePercent).toBe(100)
  })

  it('valida disponibilidade sem transformar payload inválido em configuração concluída', () => {
    expect(normalizeAvailability({ availability: null })).toBeNull()
    expect(normalizeAvailability({ availability: { timeZone: 'UTC', windows: [], exceptions: [] } }).timeZone).toBe('UTC')
    expect(() => normalizeAvailability({ availability: { timeZone: 'UTC', windows: {} } })).toThrow('Disponibilidade inválida')
  })

  it('trata payload 2xx malformado como erro da fonte', async () => {
    mocks.appointments.mockResolvedValue({ items: 'não-array' })

    await renderDashboard()

    expect(host.textContent).toContain('Agenda indisponível')
    expect(host.textContent).not.toContain('Agenda livre hoje')
  })

  it('direciona o CTA principal e a ação Treinos ao fluxo profissional', async () => {
    await renderDashboard()

    const primary = [...host.querySelectorAll('button')].find(button => button.textContent.includes('Organizar treinos'))
    await act(async () => { primary.click() })
    expect(host.querySelector('[data-location]').dataset.location).toBe('/professionals')

    const training = [...host.querySelectorAll('button')].find(button => button.textContent.trim() === 'Treinos')
    await act(async () => { training.click() })
    expect(host.querySelector('[data-location]').dataset.location).toBe('/professionals')
  })

  it('limita a três os resumos simultâneos e processa todos os vínculos retornados', async () => {
    const links = Array.from({ length: 7 }, (_, index) => ({
      id: `link_${index}`,
      status: 'active',
      scopes: ['training'],
      athlete: { id: `athlete_${index}`, name: `Aluno ${index}` },
    }))
    let active = 0
    let maximum = 0
    mocks.api.mockResolvedValue({ links })
    mocks.summary.mockImplementation(async () => {
      active += 1
      maximum = Math.max(maximum, active)
      await new Promise(resolve => setTimeout(resolve, 1))
      active -= 1
      return { summary: null }
    })

    await renderDashboard()
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })

    expect(mocks.summary).toHaveBeenCalledTimes(7)
    expect(maximum).toBeLessThanOrEqual(3)
  })

  it('invalida a carga no retry online e ignora a resposta antiga fora de ordem', async () => {
    useStore.setState({ user, ready: true })
    const oldLinks = deferred()
    mocks.api.mockImplementationOnce(() => oldLinks.promise)
      .mockResolvedValue({ links: [{ ...link, id: 'new_link', athlete: { id: 'athlete_new', name: 'Nova Aluna' } }] })
    mocks.summary.mockResolvedValue({ summary: { adherencePercent: 0, completedDays: 0, scheduledDays: 4 } })

    await act(async () => { root.render(<MemoryRouter><CoachDashboard /></MemoryRouter>) })
    await act(async () => { window.dispatchEvent(new Event('online')) })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })

    expect(mocks.api.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(host.textContent).toContain('Nova Aluna')
    oldLinks.resolve({ links: [{ ...link, athlete: { id: 'athlete_old', name: 'Aluna Antiga' } }] })
    await settle()

    expect(host.textContent).toContain('Nova Aluna')
    expect(host.textContent).not.toContain('Aluna Antiga')
  })

  it('isola troca de conta enquanto a carga anterior está em voo', async () => {
    useStore.setState({ user, ready: true })
    const oldLinks = deferred()
    mocks.api.mockImplementationOnce(() => oldLinks.promise)
      .mockResolvedValueOnce({ links: [{ ...link, id: 'second_link', athlete: { id: 'athlete_2', name: 'Conta Dois' } }] })
    mocks.summary.mockResolvedValue({ summary: { adherencePercent: 25, completedDays: 1, scheduledDays: 4 } })

    await act(async () => { root.render(<MemoryRouter><CoachDashboard /></MemoryRouter>) })
    await act(async () => {
      useStore.setState({ user: { id: 'coach_2', name: 'Carla Nova', profile: { kind: 'coach', coachSpecialties: ['training'] } } })
    })
    await settle()

    expect(host.textContent).toContain('Olá, Carla.')
    expect(host.textContent).toContain('Conta Dois')
    oldLinks.resolve({ links: [{ ...link, athlete: { id: 'athlete_old', name: 'Conta Um' } }] })
    await settle()
    expect(host.textContent).not.toContain('Conta Um')
  })

  it('aborta as requisições em voo no unmount', async () => {
    useStore.setState({ user, ready: true })
    const pendingLinks = deferred()
    mocks.api.mockImplementation((_path, options) => {
      expect(options.signal.aborted).toBe(false)
      return pendingLinks.promise
    })

    await act(async () => { root.render(<MemoryRouter><CoachDashboard /></MemoryRouter>) })
    const signal = mocks.api.mock.calls[0][1].signal
    act(() => root.unmount())
    expect(signal.aborted).toBe(true)
    await act(async () => { pendingLinks.resolve({ links: [] }) })
  })
})
