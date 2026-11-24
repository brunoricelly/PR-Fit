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

  it('falls back to a rules plan limited to the authoritative ids, labelled as not AI', async () => {
    const { generateAiWorkout } = await import('../lib/ai-workout-copilot.js')
    const allowedExerciseIds = [...new Set(generateAiWorkout({ objective: 'emagrecimento', split: 'upper_lower', level: 'avancado', seed: 0 }).divisions.flatMap(d => d.exercises.map(e => e.id)))]
    mocks.next = { source: 'rules', fallbackReason: 'timeout', allowedExerciseIds, resolved: { ...aiResult.resolved, level: 'avancado', restrictions: [] }, facts: {} }
    await open()
    await click(q('[data-testid="ai-build-with-athlete"]'))
    await flush()
    expect(q('[data-testid="ai-status"]').textContent).toContain('A IA demorou demais para responder.')
    expect(q('[data-testid="ai-status"]').textContent).toContain('não é da IA')
    expect(text()).not.toContain('perfil do aluno aplicado')
    expect(q('[data-testid="ai-rationale"]')).toBeNull()
    expect(pill('Avançado').getAttribute('aria-checked')).toBe('true')
    expect(text()).toContain('Treino A')
    expect(q('[data-testid="apply-ai-workout-btn"]').disabled).toBe(false)
  })

  it('requires manual editing and refuses to apply when the personalized fallback has no verified safe plan', async () => {
    const onApply = vi.fn()
    // Pool exhausted: only two ids allowed, so every rules slot would repeat/leave the list.
    mocks.next = { source: 'rules', fallbackReason: 'no_valid_exercises', allowedExerciseIds: ['0289', '0334'], resolved: { ...aiResult.resolved, split: 'ppl', restrictions: ['joelho'] }, facts: {} }
    await open({ onApply })
    await click(q('[data-testid="ai-build-with-athlete"]'))
    await flush()
    expect(q('[data-testid="ai-status"]').textContent).toContain('manualmente')
    expect(document.querySelector('.ai-preview-card')).toBeNull()
    const apply = q('[data-testid="apply-ai-workout-btn"]')
    expect(apply.disabled).toBe(true)
    await click(apply)
    expect(onApply).not.toHaveBeenCalled()
  })

  it.each([
    ['no allowedExerciseIds from the API', { allowedExerciseIds: undefined }],
    ['manualReview=true', { allowedExerciseIds: ['0289'], manualReview: true }],
  ])('does not offer an automatic personalized fallback with %s', async (_label, extra) => {
    mocks.next = { source: 'rules', fallbackReason: 'timeout', resolved: aiResult.resolved, facts: {}, ...extra }
    await open()
    await click(q('[data-testid="ai-build-with-athlete"]'))
    await flush()
    expect(document.querySelector('.ai-preview-card')).toBeNull()
    expect(q('[data-testid="apply-ai-workout-btn"]').disabled).toBe(true)
  })

  it('rejects an AI answer with an exercise outside the allowed ids, a duplicate or a restricted exercise', async () => {
    const dup = { ...aiResult, allowedExerciseIds: ['0289', '0334', '1027', '3415'], routine: { ...aiResult.routine, divisions: [{ name: 'A', exercises: [exercise('0289', 'Supino', 'Peitoral'), exercise('0289', 'Supino', 'Peitoral')] }] } }
    const outside = { ...aiResult, allowedExerciseIds: ['0289'], routine: aiResult.routine }
    const restricted = { ...aiResult, allowedExerciseIds: ['3593', '1027'], routine: { ...aiResult.routine, divisions: [{ name: 'A', exercises: [exercise('3593', 'Agachamento', 'Quadríceps'), exercise('1027', 'Leg press', 'Quadríceps')] }] } }
    for (const answer of [dup, outside, restricted]) {
      mocks.next = { ...answer, allowedExerciseIds: answer.allowedExerciseIds }
      await open()
      await click(q('[data-testid="ai-build-with-athlete"]'))
      await flush()
      expect(q('[data-testid="ai-rationale"]')).toBeNull()
      expect(q('[data-testid="ai-status"]').textContent).toContain('verificação de segurança')
      expect(q('[data-testid="apply-ai-workout-btn"]').disabled).toBe(true)
      await act(async () => root.render(<div />))
    }
  })

  it('keeps catalogueId in the applied AI plan', async () => {
    const onApply = vi.fn()
    mocks.next = { ...aiResult, allowedExerciseIds: ['0289', '0334', '1027', '3415'] }
    await open({ onApply })
    await click(q('[data-testid="ai-build-with-athlete"]'))
    await flush()
    await click(q('[data-testid="apply-ai-workout-btn"]'))
    expect(onApply.mock.calls[0][0].divisions[0].exercises[0].catalogueId).toBe('0289')
  })

  it('drops a request still pending when the coach edits an option, so it cannot overwrite the edit', async () => {
    let release
    mocks.next = () => new Promise(r => { release = () => r({ ...aiResult, resolved: { ...aiResult.resolved, objective: 'forca', level: 'avancado', restrictions: [] } }) })
    await open()
    await click(q('[data-testid="ai-build-with-athlete"]'))
    await click(pill('Hipertrofia'))
    await click(pill('Lombar'))
    expect(q('[data-testid="ai-build-with-athlete"]').disabled).toBe(false)
    await act(async () => { release(); await Promise.resolve() })
    await flush()
    expect(pill('Hipertrofia').getAttribute('aria-checked')).toBe('true')
    expect(pill('Lombar').getAttribute('aria-checked')).toBe('true')
    expect(pill('Força').getAttribute('aria-checked')).toBe('false')
    expect(q('[data-testid="ai-rationale"]')).toBeNull()
    expect(text()).toContain('descartada')
  })

  it('ignores a stale response after switching athlete and after close/reopen', async () => {
    let release
    mocks.next = () => new Promise(r => { release = () => r(aiResult) })
    const onClose = () => {}
    const render = (isOpen, athlete) => act(async () => root.render(<AiWorkoutGeneratorModal isOpen={isOpen} onClose={onClose} onApply={() => {}} initialAthlete={athlete} />))
    await render(true, { id: 'u_ana', name: 'Ana' })
    await click(pill('Joelho'))
    await click(q('[data-testid="ai-build-with-athlete"]'))
    const firstRelease = release
    await render(true, { id: 'u_bia', name: 'Bia' })
    expect(pill('Joelho').getAttribute('aria-checked')).toBe('false')
    expect(q('[data-testid="ai-build-with-athlete"]').disabled).toBe(false)
    await act(async () => { firstRelease(); await Promise.resolve() })
    await flush()
    expect(q('[data-testid="ai-rationale"]')).toBeNull()
    expect(text()).not.toContain('Supino com halteres')
    expect(pill('Emagrecimento').getAttribute('aria-checked')).toBe('false')

    await click(q('[data-testid="ai-build-with-athlete"]'))
    const secondRelease = release
    await render(false, { id: 'u_bia', name: 'Bia' })
    await render(true, { id: 'u_bia', name: 'Bia' })
    await act(async () => { secondRelease(); await Promise.resolve() })
    await flush()
    expect(q('[data-testid="ai-rationale"]')).toBeNull()
    expect(q('[data-testid="ai-build-with-athlete"]').disabled).toBe(false)
  })

  it('aborts the request on Cancelar and on the close button', async () => {
    const onClose = vi.fn()
    let signal
    const { api } = await import('../lib/api.js')
    api.mockImplementationOnce((path, opts) => { signal = opts.signal; return new Promise(() => {}) })
    await act(async () => root.render(<AiWorkoutGeneratorModal isOpen onClose={onClose} onApply={() => {}} initialAthlete={{ id: 'u_ana', name: 'Ana' }} />))
    await click(q('[data-testid="ai-build-with-athlete"]'))
    expect(signal.aborted).toBe(false)
    await click([...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Cancelar'))
    expect(signal.aborted).toBe(true)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not apply while loading and applies only once', async () => {
    const onApply = vi.fn(); const onClose = vi.fn()
    let release
    mocks.next = () => new Promise(r => { release = () => r(aiResult) })
    await act(async () => root.render(<AiWorkoutGeneratorModal isOpen onClose={onClose} onApply={onApply} initialAthlete={{ id: 'u_ana', name: 'Ana' }} />))
    await click(q('[data-testid="ai-build-with-athlete"]'))
    const apply = q('[data-testid="apply-ai-workout-btn"]')
    expect(apply.disabled).toBe(true)
    await click(apply)
    expect(onApply).not.toHaveBeenCalled()
    await act(async () => { release(); await Promise.resolve() })
    await flush()
    const ready = q('[data-testid="apply-ai-workout-btn"]')
    await click(ready); await click(ready)
    expect(onApply).toHaveBeenCalledTimes(1)
  })

  it.each([
    [Object.assign(new Error('x'), { status: 403 }), 'Sem vínculo ativo'],
    [Object.assign(new Error('x'), { status: 401 }), 'sessão expirou'],
  ])('after a denied request (%#) shows no plan, blocks apply and does not pass local rules off as personalized', async (error, expected) => {
    mocks.next = error
    await open()
    await click(q('[data-testid="ai-build-with-athlete"]'))
    await flush()
    expect(q('[data-testid="ai-status"]').textContent).toContain(expected)
    expect(document.querySelector('.ai-preview-card')).toBeNull()
    expect(q('[data-testid="apply-ai-workout-btn"]').disabled).toBe(true)
    // The coach can still choose to work locally, clearly labelled as without the athlete's data.
    await click(pill('Força'))
    expect(text()).toContain('sem IA, sem dados do aluno')
    expect(q('[data-testid="apply-ai-workout-btn"]').disabled).toBe(false)
  })

  it.each([
    [Object.assign(new Error('x'), { status: 429 }), 'Muitas tentativas'],
    [Object.assign(new Error('x'), { code: 'timeout' }), 'servidor demorou'],
    [new Error('boom'), 'Não foi possível montar com a IA'],
  ])('shows a clear message when the request fails (%#) and keeps the labelled local plan', async (error, expected) => {
    mocks.next = error
    await open()
    await click(q('[data-testid="ai-build-with-athlete"]'))
    await flush()
    expect(q('[data-testid="ai-status"]').textContent).toContain(expected)
    expect(q('[data-testid="ai-status"]').textContent).toContain('sem IA e sem dados do aluno')
    expect(text()).toContain('Treino A')
  })

  it('makes no claim about the athlete profile before fetching', async () => {
    await open()
    expect(text()).not.toMatch(/já com o perfil do aluno/)
    expect(text()).toContain('sem IA, sem dados do aluno')
    expect(text()).toContain('Montar com os dados do aluno')
  })

  it('without an athlete the local editor flow still works and says it is local', async () => {
    const onApply = vi.fn()
    await open({ athlete: null, onApply })
    expect(text()).toContain('Sem aluno vinculado')
    await click(pill('Força'))
    await click([...document.querySelectorAll('button')].find(b => b.textContent.includes('Aplicar este treino')))
    expect(onApply).toHaveBeenCalledTimes(1)
    expect(mocks.calls).toHaveLength(0)
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
