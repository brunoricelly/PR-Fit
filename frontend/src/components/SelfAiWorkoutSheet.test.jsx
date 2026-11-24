// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { guardReactWarnings } from '../test/react-warning-guard.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({ calls: [], next: null }))
vi.mock('../lib/api.js', () => ({
  api: vi.fn(async (path, opts) => {
    mocks.calls.push({ path, method: opts?.method, body: opts?.body })
    const out = typeof mocks.next === 'function' ? await mocks.next() : mocks.next
    if (out instanceof Error) throw out
    return out
  }),
}))

import SelfAiWorkoutSheet from './SelfAiWorkoutSheet.jsx'
import { routinesFromPlan, repsConfig } from '../lib/self-ai-workout.js'

const ex = (id, name) => ({ catalogueId: id, id, name, sets: 3, reps: '8-12', load: '', restSeconds: 60, notes: '', targetMuscle: 'Peitoral', equipment: 'Halteres' })
const good = {
  source: 'ai', selfService: true, manualReview: false, allowedExerciseIds: ['0289', '0334', '1027', '3415'],
  resolved: { objective: 'emagrecimento', level: 'iniciante', split: 'full_body', daysPerWeek: 3, restrictions: [], sources: {} },
  routine: { name: 'x', notes: '', rationale: 'r', divisions: [{ name: 'Treino A', exercises: [ex('0289', 'Supino'), ex('0334', 'Elevação')] }, { name: 'Treino B', exercises: [ex('1027', 'Leg press'), ex('3415', 'Mesa flexora')] }] },
}
let host, root, assertNoReactWarnings
const q = s => document.querySelector(s)
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })
const click = async el => { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) }) }

async function mount(S = { routines: [{ id: 'old' }] }) {
  const update = vi.fn(fn => fn(S)); const toast = vi.fn(); const close = vi.fn()
  await act(async () => { root.render(<SelfAiWorkoutSheet S={S} update={update} toast={toast} close={close} />) })
  await flush()
  return { S, update, toast, close }
}
beforeEach(() => { mocks.calls.length = 0; mocks.next = good; host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); assertNoReactWarnings = guardReactWarnings() })
afterEach(async () => { await act(async () => root.unmount()); host.remove(); assertNoReactWarnings() })

describe('routinesFromPlan', () => {
  it('turns divisions into routines with catalogue ids and numeric reps', () => {
    let n = 0
    const out = routinesFromPlan(good.routine, () => 'r' + (n++), new Set())
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ id: 'r0', name: 'Treino A' })
    expect(out[0].ex[0]).toMatchObject({ id: '0289', sets: 3, reps: 12, repsMin: 8, weight: 0, mode: 'reps', restSec: 60 })
  })
  it('refuses a plan with an exercise the app does not know, or invalid sets', () => {
    expect(routinesFromPlan({ divisions: [{ name: 'A', exercises: [ex('NOPE', 'x')] }] }, () => 'r', new Set(), () => false)).toBeNull()
    expect(routinesFromPlan({ divisions: [{ name: 'A', exercises: [{ ...ex('0289', 'x'), sets: 99 }] }] }, () => 'r')).toBeNull()
    expect(routinesFromPlan({ divisions: [] }, () => 'r')).toBeNull()
  })
  it('never reuses an existing routine id', () => {
    const ids = ['a', 'a', 'b']; let i = 0
    const out = routinesFromPlan({ divisions: [{ name: 'A', exercises: [ex('0289', 'x')] }] }, () => ids[i++], new Set(['a']))
    expect(out[0].id).toBe('b')
  })
  it('reps: range, single number and garbage', () => {
    expect(repsConfig('10-12')).toEqual({ reps: 12, repsMin: 10 })
    expect(repsConfig('15')).toEqual({ reps: 15 })
    expect(repsConfig('abc')).toEqual({ reps: 10 })
  })
})

describe('SelfAiWorkoutSheet', () => {
  it('posts an empty body, shows the plan with honest wording and saves once', async () => {
    const { S, update, toast, close } = await mount()
    expect(mocks.calls).toEqual([{ path: '/api/athlete/ai-workout', method: 'POST', body: '{}' }])
    expect(q('[data-testid=self-ai-note]').textContent).toContain('Não substitui um profissional')
    expect(document.body.textContent).toContain('Leg press')
    const save = q('[data-testid=self-ai-save]')
    await click(save); await click(save)
    expect(update).toHaveBeenCalledTimes(1)
    expect(S.routines.map(r => r.name)).toEqual([undefined, 'Treino A', 'Treino B'])
    expect(S.routines[0].id).toBe('old')
    expect(toast).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
  })
  it('blocked by the server: no plan, no save, a clear referral', async () => {
    mocks.next = { source: 'rules', rulesBlocked: true, manualReview: true, allowedExerciseIds: [], fallbackReason: 'manual_review_required', resolved: {} }
    const { update } = await mount()
    expect(q('[data-testid=self-ai-blocked]').textContent).toContain('Procure um profissional')
    expect(q('[data-testid=self-ai-save]')).toBeNull()
    expect(update).not.toHaveBeenCalled()
  })
  it('an AI plan with an exercise outside the allowed list is not offered', async () => {
    mocks.next = { ...good, allowedExerciseIds: ['0289'] }
    await mount()
    expect(q('[data-testid=self-ai-save]')?.textContent ?? '').not.toContain('Adicionar')
    expect(q('[data-testid=self-ai-note]')?.textContent ?? '').not.toContain('Sugestão automática da IA')
  })
  it('has a coach (409) and rate limit (429) show specific messages and save nothing', async () => {
    for (const [status, word] of [[409, 'treinador ativo'], [429, 'muitas fichas']]) {
      mocks.next = Object.assign(new Error('x'), { status })
      const { update } = await mount()
      expect(q('[data-testid=self-ai-error]').textContent).toContain(word)
      expect(update).not.toHaveBeenCalled()
      await act(async () => root.unmount()); root = createRoot(host)
    }
  })
})
