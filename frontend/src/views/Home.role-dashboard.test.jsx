// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../store/useStore.js'
import Home from './Home.jsx'

vi.mock('./dashboard/CoachDashboard.jsx', () => ({ default: () => <main data-dashboard="coach">Visão do coach</main> }))
vi.mock('./dashboard/AthleteToday.jsx', () => ({ default: () => <main data-dashboard="athlete">Hoje do atleta</main> }))

let host
let root

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('Home por papel ativo', () => {
  it('mantém o coach na visão profissional por padrão', async () => {
    useStore.setState({ user: { id: 'coach_1', profile: { kind: 'coach' } } })
    act(() => root.render(<Home />))
    await vi.waitFor(() => expect(host.querySelector('[data-dashboard="coach"]')).toBeTruthy())
    expect(host.querySelector('[data-dashboard="coach"]')).toBeTruthy()
    expect(host.querySelector('[data-dashboard="athlete"]')).toBeFalsy()
  })

  it('respeita o modo atleta persistido de uma conta dual-role', async () => {
    localStorage.setItem('prfit_active_role_coach_1', 'athlete')
    useStore.setState({ user: { id: 'coach_1', profile: { kind: 'coach' } } })
    act(() => root.render(<Home />))
    await vi.waitFor(() => expect(host.querySelector('[data-dashboard="athlete"]')).toBeTruthy())
    expect(host.querySelector('[data-dashboard="athlete"]')).toBeTruthy()
    expect(host.querySelector('[data-dashboard="coach"]')).toBeFalsy()
  })

  it('não expõe a visão de coach para perfil atleta', async () => {
    useStore.setState({ user: { id: 'athlete_1', profile: { kind: 'athlete' } } })
    act(() => root.render(<Home />))
    await vi.waitFor(() => expect(host.querySelector('[data-dashboard="athlete"]')).toBeTruthy())
    expect(host.querySelector('[data-dashboard="athlete"]')).toBeTruthy()
    expect(host.querySelector('[data-dashboard="coach"]')).toBeFalsy()
  })
})
