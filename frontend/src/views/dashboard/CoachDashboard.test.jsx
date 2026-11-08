// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../../store/useStore.js'
import CoachDashboard from './CoachDashboard.jsx'

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  inbox: vi.fn(),
  summary: vi.fn(),
  appointments: vi.fn(),
}))

vi.mock('../../lib/api.js', () => ({ api: mocks.api }))
vi.mock('../../lib/communication-api.js', () => ({
  communicationApi: { inbox: mocks.inbox, summary: mocks.summary },
  browserTimeZone: () => ({ value: 'America/Sao_Paulo', fallback: false }),
}))
vi.mock('../../lib/scheduling-api.js', () => ({ getCoachAppointments: mocks.appointments }))

let host
let root

const user = { id: 'coach_1', name: 'Bruno Lima', profile: { kind: 'coach', coachSpecialties: ['training'] } }
const link = { id: 'link_1', status: 'active', scopes: ['training'], athlete: { id: 'athlete_1', name: 'Ana' } }

const settle = async () => act(async () => {
  await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
})

const renderDashboard = async () => {
  useStore.setState({ user, ready: true })
  await act(async () => {
    root.render(<MemoryRouter><CoachDashboard /></MemoryRouter>)
  })
  await settle()
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  mocks.api.mockResolvedValue({ links: [] })
  mocks.inbox.mockResolvedValue({ conversations: [] })
  mocks.summary.mockResolvedValue({ summary: null })
  mocks.appointments.mockResolvedValue({ items: [] })
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
    mocks.inbox.mockResolvedValue({ conversations: [{ linkId: link.id, unreadCount: 2 }] })
    mocks.summary.mockResolvedValue({ summary: { adherencePercent: 0, completedDays: 0, scheduledDays: 4 } })
    mocks.appointments.mockResolvedValue({ items: [{ id: 'app_1', title: 'Avaliação', startAt: '2026-11-08T15:00:00.000Z', athlete: { name: 'Ana' } }] })

    await renderDashboard()

    expect(host.textContent).toContain('Ana')
    expect(host.textContent).toContain('2 mensagens não lidas')
    expect(host.textContent).toContain('nenhum check-in concluído nesta semana')
    expect(host.textContent).toContain('Avaliação')
    expect(host.textContent).toContain('0%')
    expect(host.textContent).toContain('Alunos')
    expect(host.textContent).toContain('Comunidade')
    expect(mocks.summary).toHaveBeenCalledWith(expect.objectContaining({ athleteId: 'athlete_1', period: 7 }))
  })

  it('mostra vazios acionáveis sem inventar métricas', async () => {
    await renderDashboard()

    expect(host.textContent).toContain('Nenhuma pendência agora')
    expect(host.textContent).toContain('Agenda livre hoje')
    expect(host.textContent).toContain('Sem mensagens pendentes ou dados de adesão para mostrar')
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
})
