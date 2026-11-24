// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { guardReactWarnings } from '../test/react-warning-guard.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({ calls: [], next: null }))
vi.mock('../lib/api.js', () => ({
  api: vi.fn(async (path, opts) => {
    mocks.calls.push({ path, method: opts?.method, body: opts?.body ? JSON.parse(opts.body) : null, timeout: opts?.timeout, hasSignal: !!opts?.signal })
    const out = typeof mocks.next === 'function' ? await mocks.next() : mocks.next
    if (out instanceof Error) throw out
    return out
  }),
}))

import AiWorkoutGeneratorModal, { aiPlanFrom } from './AiWorkoutGeneratorModal.jsx'

const exercise = (id, name, muscle) => ({ catalogueId: id, id, name, sets: 3, reps: '8-12', load: '', restSeconds: 60, notes: 'n', targetMuscle: muscle, equipment: 'Halteres' })
const aiResult = {
  source: 'ai', model: 'm',
  resolved: { objective: 'emagrecimento', level: 'iniciante', split: 'upper_lower', daysPerWeek: 3, restrictions: ['joelho'], sources: { objective: 'athlete', level: 'athlete', daysPerWeek: 'athlete', restrictions: 'athlete' } },
  facts: { hasIntake: true },
  routine: { name: 'Ficha da Ana', notes: '', rationale: 'Iniciante com dor no joelho: baixo volume.', divisions: [
    { name: 'A', exercises: [exercise('0289', 'Supino com halteres', 'Peitoral'), exercise('0334', 'Elevação lateral', 'Ombros')] },
    { name: 'B', exercises: [exercise('1027', 'Leg press', 'Quadríceps'), exercise('3415', 'Mesa flexora', 'Isquiotibiais')] },
  ] },
}

let host, root, assertNoReactWarnings
const q = sel => document.querySelector(sel)
const text = () => document.body.textContent
const click = async el => { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) }) }
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })
const pill = label => [...document.querySelectorAll('.ai-copilot-pill')].find(b => b.textContent.includes(label))

async function open(props = {}) {
  await act(async () => { root.render(<AiWorkoutGeneratorModal isOpen onClose={() => {}} onApply={props.onApply || (() => {})} initialAthlete={'athlete' in props ? props.athlete : { id: 'u_ana', name: 'Ana' }} />) })
}

beforeEach(() => {
  mocks.calls.length = 0; mocks.next = aiResult
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  assertNoReactWarnings = guardReactWarnings()
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove()
  document.querySelectorAll('.ds-modal-backdrop').forEach(el => el.remove())
  assertNoReactWarnings()
})

describe('AI workout builder with the athlete data', () => {
  it('has no AI button without a linked athlete and never calls the API', async () => {
    await open({ athlete: null })
    expect(q('[data-testid="ai-build-with-athlete"]')).toBeNull()
    expect(mocks.calls).toHaveLength(0)
  })

  it('sends only what the coach touched, shows the AI plan with its reason and applies it', async () => {
    const onApply = vi.fn()
    await open({ onApply })
    await click(pill('Joelho'))
    await click(q('[data-testid="ai-build-with-athlete"]'))
    await flush()
    expect(mocks.calls).toHaveLength(1)
    expect(mocks.calls[0]).toMatchObject({ path: '/api/coach/athletes/u_ana/ai-workout', method: 'POST', body: { restrictions: ['joelho'] }, hasSignal: true })
    expect(mocks.calls[0].timeout).toBeGreaterThanOrEqual(40000)
    expect(Object.keys(mocks.calls[0].body)).toEqual(['restrictions'])
    expect(text()).toContain('Por que esta ficha')
    expect(text()).toContain('Iniciante com dor no joelho')
    expect(text()).toContain('vindo do aluno')
    expect(text()).toContain('Supino com halteres')
    expect(pill('Emagrecimento').getAttribute('aria-checked')).toBe('true')
    expect(pill('Iniciante').getAttribute('aria-checked')).toBe('true')
    const apply = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Aplicar este treino'))
    await click(apply)
    expect(onApply).toHaveBeenCalledTimes(1)
    const plan = onApply.mock.calls[0][0]
    expect(plan.name).toBe('Ficha da Ana')
    expect(plan.divisions[0].exercises[0]).toMatchObject({ name: 'Supino com halteres', sets: 3, reps: '8-12', restSeconds: 60 })
  })

  it('shows a loading state, disables the button meanwhile and refuses a second request', async () => {
    let release
    mocks.next = () => new Promise(r => { release = () => r(aiResult) })
    await open()
    const btn = q('[data-testid="ai-build-with-athlete"]')
    await click(btn)
    expect(q('[data-testid="ai-status"]').textContent).toContain('montando a ficha')
    expect(btn.disabled).toBe(true)
    await click(btn)
    expect(mocks.calls).toHaveLength(1)
    await act(async () => { release(); await Promise.resolve() })
    await flush()
    expect(q('[data-testid="ai-rationale"]')).not.toBeNull()
  })

  it('falls back to the rules plan with a reason in Portuguese, keeping the athlete profile applied', async () => {
    mocks.next = { source: 'rules', fallbackReason: 'timeout', resolved: { ...aiResult.resolved, level: 'avancado' }, facts: {} }
    await open()
    await click(q('[data-testid="ai-build-with-athlete"]'))
    await flush()
    expect(q('[data-testid="ai-status"]').textContent).toContain('A IA demorou demais para responder.')
    expect(q('[data-testid="ai-rationale"]')).toBeNull()
    expect(pill('Avançado').getAttribute('aria-checked')).toBe('true')
    expect(text()).toContain('Treino A')
  })

  it.each([
    [Object.assign(new Error('x'), { status: 403 }), 'Sem vínculo ativo'],
    [Object.assign(new Error('x'), { status: 429 }), 'Muitas tentativas'],
    [Object.assign(new Error('x'), { code: 'timeout' }), 'servidor demorou'],
    [new Error('boom'), 'Não foi possível montar com a IA'],
  ])('shows a clear message when the request fails (%#)', async (error, expected) => {
    mocks.next = error
    await open()
    await click(q('[data-testid="ai-build-with-athlete"]'))
    await flush()
    expect(q('[data-testid="ai-status"]').textContent).toContain(expected)
    expect(text()).toContain('Treino A')
  })

  it('warns when the athlete has no profile yet', async () => {
    mocks.next = { ...aiResult, facts: { hasIntake: false } }
    await open()
    await click(q('[data-testid="ai-build-with-athlete"]'))
    await flush()
    expect(q('[data-testid="ai-rationale"]').textContent).toContain('ainda não preencheu o perfil')
  })

  it('aiPlanFrom keeps the shape the editor expects', () => {
    const plan = aiPlanFrom(aiResult)
    expect(plan.frequency).toBe('3x por semana')
    expect(plan.summary.totalExercises).toBe(4)
    expect(plan.summary.safetyNotes[0]).toContain('joelho')
    expect(plan.divisions[1].description).toContain('Quadríceps')
  })
})
