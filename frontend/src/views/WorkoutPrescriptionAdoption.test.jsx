// @vitest-environment happy-dom
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { DEF, useStore } from '../store/useStore.js'
import { _setLangState } from '../lib/i18n-core.js'
import { useUI } from '../store/useUI.js'
import Workout from './Workout.jsx'

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  toast: vi.fn(),
  pullState: vi.fn(),
}))

vi.mock('../lib/api.js', () => ({
  api: (...args) => mocks.api(...args),
  beacon: vi.fn(),
}))

let host, root

const settle = () => act(async () => {
  await new Promise(resolve => setTimeout(resolve, 0))
})

const fakePrescription = {
  id: 'cpr_workout_1',
  state: 'available',
  coach: { id: 'coach_1', name: 'Coach Ricardo' },
  routine: {
    name: 'Hipertrofia ABCD Avançado',
    notes: 'Priorizar amplitude e descanso.',
    divisions: [
      { id: 'div_1', name: 'A', exercises: [{ name: 'Supino Reto', sets: 4, reps: '8-10' }] },
      { id: 'div_2', name: 'B', exercises: [{ name: 'Puxada Frontal', sets: 4, reps: '8-10' }] },
      { id: 'div_3', name: 'C', exercises: [{ name: 'Agachamento Livre', sets: 4, reps: '8-10' }] },
    ],
  },
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  vi.clearAllMocks()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)

  const st = JSON.parse(JSON.stringify(DEF))
  st.active = null
  st.routines = [{ id: 'old_r', name: 'Rotina Antiga', ex: [{ id: '0025', sets: 3, reps: 10, weight: 50 }] }]
  st.workouts = [{ id: 'w_hist_1', d: '2026-11-01', routineId: 'old_r', entries: [] }]
  useStore.setState({ S: st, user: { id: 'ath_1', name: 'Atleta' }, pullState: mocks.pullState })
  useUI.setState({ toast: mocks.toast })

  mocks.api.mockImplementation((path, opts) => {
    if (path === '/api/athlete/prescriptions') {
      return Promise.resolve({ prescriptions: [fakePrescription] })
    }
    if (path === '/api/athlete/prescriptions/cpr_workout_1/adopt') {
      return Promise.resolve({
        prescription: { ...fakePrescription, state: 'adopted' },
        routineIds: ['r_adopted_1', 'r_adopted_2', 'r_adopted_3'],
      })
    }
    return Promise.resolve({})
  })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('Workout Prescription Adoption in StartChooser', () => {
  it('exibe o banner transparente do treino prescrito pelo coach e permite adotar com 1 toque', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <Workout />
        </MemoryRouter>
      )
    })
    await settle()

    expect(host.querySelector('.pro-prescription-banner')).toBeTruthy()
    expect(host.textContent).toContain('Hipertrofia ABCD Avançado')
    expect(host.textContent).toContain('Coach Ricardo')
    expect(host.textContent).toMatch(/3 divisões|3 divisions/)
    expect(host.textContent).toContain('A, B, C')
    expect(host.textContent).toContain('Priorizar amplitude e descanso.')
    expect(host.textContent).toMatch(/Seu histórico anterior permanece 100% intacto|Your previous workout history remains 100% intact/)

    const adoptBtn = [...host.querySelectorAll('.pro-prescription-banner button')].find(b =>
      b.textContent.includes('Adotar como rotina ativa') || b.textContent.includes('Adopt as active routine')
    )
    expect(adoptBtn).toBeTruthy()

    await act(async () => {
      adoptBtn.click()
    })
    await settle()

    expect(mocks.api).toHaveBeenCalledWith(
      '/api/athlete/prescriptions/cpr_workout_1/adopt',
      expect.objectContaining({ method: 'POST' })
    )
    expect(mocks.pullState).toHaveBeenCalled()
    expect(mocks.toast).toHaveBeenCalledWith('Added to your routines')

    // History is completely intact in store
    const storeState = useStore.getState().S
    expect(storeState.workouts.length).toBe(1)
    expect(storeState.workouts[0].id).toBe('w_hist_1')
  })

  it('renderiza cópia canônica em português do Brasil quando pt-BR está ativo', async () => {
    _setLangState('pt-BR', {}, null, null)
    try {
      await act(async () => {
        root.render(
          <MemoryRouter>
            <Workout />
          </MemoryRouter>
        )
      })
      await settle()

      expect(host.textContent).toContain('Treino do treinador')
      expect(host.textContent).toContain('Prescrito por Coach Ricardo')
      expect(host.textContent).toContain('3 divisões')
      expect(host.textContent).toContain('Ao adotar, o treino prescrito se torna sua rotina ativa. Seu histórico anterior permanece 100% intacto.')
      const btn = [...host.querySelectorAll('.pro-prescription-banner button')].find(b => b.textContent.includes('Adotar como rotina ativa'))
      expect(btn).toBeTruthy()
    } finally {
      _setLangState('en', {}, null, null)
    }
  })
})
