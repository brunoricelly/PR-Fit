// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { guardReactWarnings } from '../test/react-warning-guard.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({ calls: [], answers: {}, toast: vi.fn(), confirms: [] }))
vi.mock('../store/useUI.js', () => {
  const snap = () => ({ toast: mocks.toast })
  const useUI = selector => (selector ? selector(snap()) : snap())
  useUI.getState = snap
  return { useUI }
})
vi.mock('../lib/api.js', () => ({
  api: vi.fn(async (path, opts) => {
    const body = opts?.body ? JSON.parse(opts.body) : null
    mocks.calls.push({ path, method: opts?.method || 'GET', body })
    const answer = mocks.answers[`${opts?.method || 'GET'} ${path}`]
    if (answer instanceof Error) throw answer
    return typeof answer === 'function' ? answer(body) : answer ?? {}
  }),
}))
vi.mock('../sheets.jsx', () => ({ confirmSheet: options => mocks.confirms.push(options) }))

import WorkoutTemplateLibrary, { skipReasonLabel } from './WorkoutTemplateLibrary.jsx'

const routine = { name: 'Ficha ABC', notes: 'Progredir.', divisions: [{ id: 'division_1', name: 'A', exercises: [{ id: 'exercise_1_1', name: 'Supino', sets: 4, reps: '8', load: '', restSeconds: 60, notes: '' }] }] }
const tpl = { id: 'wtpl_1', routine, createdAt: '2026-11-24T00:00:00.000Z', updatedAt: '2026-11-24T00:00:00.000Z' }
const links = [
  { status: 'active', scopes: ['training'], athlete: { id: 'a1', name: 'Ana' } },
  { status: 'active', scopes: ['nutrition'], athlete: { id: 'a2', name: 'Bia' } },
  { status: 'suspended', scopes: ['training'], athlete: { id: 'a3', name: 'Caio' } },
  { status: 'active', scopes: ['training'], athlete: { id: 'a4', name: 'Duda' } },
]
const Editor = () => <div data-testid="editor" />

let host, root, assertNoReactWarnings
beforeEach(() => {
  Object.assign(mocks, { calls: [], answers: {}, toast: vi.fn(), confirms: [] })
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  assertNoReactWarnings = guardReactWarnings()
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); assertNoReactWarnings() })

const mount = async () => { await act(async () => root.render(<WorkoutTemplateLibrary Editor={Editor} />)) }
const buttonByText = text => [...host.querySelectorAll('button')].find(b => b.textContent.includes(text))
const click = async el => { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) }) }

describe('WorkoutTemplateLibrary', () => {
  it('lists templates and shows an empty state', async () => {
    mocks.answers['GET /api/coach/workout-templates'] = { templates: [tpl] }
    await mount()
    expect(host.textContent).toContain('Ficha ABC')
    expect(host.textContent).toContain('1 divisions · 1 exercises')
  })

  it('shows an empty state and a retryable error', async () => {
    mocks.answers['GET /api/coach/workout-templates'] = { templates: [] }
    await mount()
    expect(host.textContent).toContain('No templates yet')
    mocks.answers['GET /api/coach/workout-templates'] = new Error('x')
    await act(async () => root.unmount()); root = createRoot(host)
    await mount()
    expect(host.querySelector('[role="alert"]')).toBeTruthy()
  })

  it('offers only active training athletes and sends the chosen ids to the real endpoint', async () => {
    mocks.answers['GET /api/coach/workout-templates'] = { templates: [tpl] }
    mocks.answers['GET /api/coach/athletes'] = { links }
    mocks.answers['POST /api/coach/workout-templates/wtpl_1/assign'] = body => ({ results: body.athleteIds.map(id => ({ athleteId: id, status: 'assigned', prescriptionId: `p_${id}` })) })
    await mount()
    await click(buttonByText('Assign to athletes'))
    const names = [...host.querySelectorAll('.pro-pick-list li')].map(li => li.textContent)
    expect(names).toEqual(['Ana', 'Duda'])
    await click(host.querySelector('.pro-pick-list input'))
    await click(buttonByText('Assign to 1 athletes'))
    const post = mocks.calls.find(call => call.method === 'POST')
    expect(post.body).toEqual({ athleteIds: ['a1'] })
    expect(mocks.toast).toHaveBeenCalledWith('Template assigned to 1 athletes.')
  })

  it('reports partial results per athlete and keeps only the failures selected for a retry', async () => {
    mocks.answers['GET /api/coach/workout-templates'] = { templates: [tpl] }
    mocks.answers['GET /api/coach/athletes'] = { links }
    mocks.answers['POST /api/coach/workout-templates/wtpl_1/assign'] = () => ({ results: [
      { athleteId: 'a1', status: 'assigned', prescriptionId: 'p1' },
      { athleteId: 'a4', status: 'skipped', code: 'already_assigned', prescriptionId: 'p0' },
    ] })
    await mount()
    await click(buttonByText('Assign to athletes'))
    await click(buttonByText('Select all') ?? host.querySelector('.pro-panel-head input'))
    await click(buttonByText('Assign to 2 athletes'))
    expect(host.textContent).toContain('Duda: Already has this template.')
    expect(host.textContent).not.toContain('Ana: ')
    const checked = [...host.querySelectorAll('.pro-pick-list input')].map(i => i.checked)
    expect(checked).toEqual([false, true])
    expect(mocks.toast).toHaveBeenCalledWith('Assigned to 1 of 2 athletes.')
  })

  it('maps every server skip code to a message', () => {
    for (const code of ['relationship_not_found', 'relationship_inactive', 'scope_forbidden', 'already_assigned', 'prescription_capacity']) {
      expect(skipReasonLabel(code)).not.toBe('Could not assign.')
    }
    expect(skipReasonLabel('weird')).toBe('Could not assign.')
  })

  it('deletes through a confirmation and removes the card', async () => {
    mocks.answers['GET /api/coach/workout-templates'] = { templates: [tpl] }
    mocks.answers['DELETE /api/coach/workout-templates/wtpl_1'] = { template: tpl }
    await mount()
    await click(buttonByText('Delete template'))
    expect(mocks.confirms).toHaveLength(1)
    await act(async () => { await mocks.confirms[0].onConfirm() })
    expect(host.textContent).not.toContain('Ficha ABC')
  })
})
