// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import FirstSteps from './FirstSteps.jsx'
import { getFirstStepsState, setFirstStepsDismissed } from '../lib/first-steps-store.js'

let host
let root

const coachSteps = [
  { id: 'profile', title: 'Revise seu perfil', text: 'Confira seus dados.', route: '/settings', cta: 'Abrir configurações', completion: 'visit' },
  { id: 'athlete', title: 'Adicione seu primeiro aluno', text: 'Crie um convite.', route: '/professionals', cta: 'Gerenciar alunos', completion: 'evidence', completed: false },
  { id: 'workout', title: 'Prescreva o primeiro treino', text: 'Organize uma rotina.', route: '/professionals', cta: 'Abrir alunos', completion: 'manual' },
]

function LocationProbe() {
  const location = useLocation()
  return <span data-location={location.pathname + location.search} />
}

const renderSteps = async (props = {}) => act(async () => {
  root.render(<MemoryRouter><FirstSteps userId="dual_1" role="coach" steps={coachSteps} {...props} /><LocationProbe /></MemoryRouter>)
})

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

describe('FirstSteps', () => {
  it('mostra progresso, poucos itens e detalhes expansíveis', async () => {
    await renderSteps()
    expect(host.querySelector('progress')?.value).toBe(0)
    expect(host.querySelectorAll('.first-steps-list')[0].children).toHaveLength(2)
    expect(host.querySelector('details summary')?.textContent).toContain('Ver mais 1 passo')
  })

  it('fecha e retoma com estado persistente', async () => {
    await renderSteps()
    await act(async () => host.querySelector('[aria-label="Fechar primeiros passos"]').click())
    expect(host.textContent).toContain('Retomar primeiros passos')
    expect(getFirstStepsState('dual_1', 'coach').dismissed).toBe(true)

    await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent.includes('Retomar')).click())
    expect(host.textContent).toContain('Primeiros passos')
    expect(getFirstStepsState('dual_1', 'coach').dismissed).toBe(false)
  })

  it('conclui visita local ao abrir CTA e navega para rota permitida', async () => {
    await renderSteps()
    await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent.includes('Abrir configurações')).click())
    expect(host.querySelector('[data-location]').dataset.location).toBe('/settings')
    expect(getFirstStepsState('dual_1', 'coach').completed).toContain('profile')
  })

  it('aceita conclusão manual sem mutar dados de negócio', async () => {
    await renderSteps()
    const details = host.querySelector('details')
    details.open = true
    await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Já fiz').click())
    expect(getFirstStepsState('dual_1', 'coach').completed).toContain('workout')
  })

  it('troca para o escopo do papel sem compartilhar dismiss', async () => {
    setFirstStepsDismissed('dual_1', 'coach', true)
    await renderSteps()
    expect(host.textContent).toContain('Retomar primeiros passos')

    await act(async () => {
      root.render(<MemoryRouter><FirstSteps userId="dual_1" role="athlete" steps={coachSteps} /></MemoryRouter>)
    })
    expect(host.textContent).toContain('Primeiros passos')
    expect(host.textContent).not.toContain('Retomar primeiros passos')
  })
})
