// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  answers: {}, calls: [], uploads: [], toast: vi.fn(), confirms: [], media: null,
}))

vi.mock('../store/useStore.js', () => {
  const snap = () => ({ config: { media: mocks.media } })
  const useStore = selector => (selector ? selector(snap()) : snap())
  return { useStore }
})
vi.mock('../store/useUI.js', () => {
  const snap = () => ({ toast: mocks.toast })
  const useUI = selector => (selector ? selector(snap()) : snap())
  return { useUI }
})
vi.mock('../lib/api.js', () => ({
  api: vi.fn(async (path, opts) => {
    const body = opts?.body ? JSON.parse(opts.body) : null
    mocks.calls.push({ path, method: opts?.method || 'GET', body })
    const answer = mocks.answers[path]
    if (answer instanceof Error) throw answer
    return typeof answer === 'function' ? answer(body, opts) : answer ?? {}
  }),
  apiUpload: vi.fn(async (path, blob, mime) => { mocks.uploads.push({ path, size: blob.size, mime }); return {} }),
}))
vi.mock('../lib/media-ingest.js', () => ({
  ingestMediaFile: vi.fn(async () => ({
    media: { kind: 'image', hash: 'a'.repeat(64), mime: 'image/webp', size: 4, width: 100, height: 120 },
    blobs: [{ hash: 'a'.repeat(64), blob: new Blob(['test'], { type: 'image/webp' }), mime: 'image/webp' }],
    warnings: [],
  })),
}))
vi.mock('../sheets.jsx', () => ({ confirmSheet: options => mocks.confirms.push(options) }))

import AssessmentPanel from './AssessmentPanel.jsx'

const questions = Array.from({ length: 7 }, (_, index) => ({ id: `q_${index + 1}`, text: `Question ${index + 1}?` }))
const config = { parq: { version: '2024.1', questions }, limits: { photos: 6 } }

let host, root
beforeEach(() => {
  Object.assign(mocks, { answers: {}, calls: [], uploads: [], toast: vi.fn(), confirms: [], media: null })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
const mount = async props => {
  act(() => root.render(<AssessmentPanel {...props} />))
  await settle()
}
const button = label => [...host.querySelectorAll('button')].find(item => item.textContent.trim() === label)
const input = name => host.querySelector(`[name="${name}"]`)
const change = async (element, value) => {
  await act(async () => {
    const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
const click = async element => act(async () => { element.click() })

const assessment = (overrides = {}) => ({
  id: 'cas_1', assessedAt: '2026-10-01T10:00:00.000Z', createdAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-01T10:00:00.000Z',
  coach: { name: 'Coach' }, athlete: { name: 'Ana' }, weightKg: 80, heightCm: 180,
  results: { bodyFatPercent: 20, leanMassKg: 64 }, circumferences: { waist: 90, hip: 100, arm: 35 },
  ...overrides,
})

describe('AssessmentPanel phase 3', () => {
  it('creates a complete assessment with stable PAR-Q ids and requires guidance acknowledgement', async () => {
    mocks.media = { imageMB: 2, gifMB: 8, videoMB: 40, videoSec: 60, quotaMB: 200 }
    const route = '/api/coach/athletes/u_athlete/assessments'
    mocks.answers[route] = (body, opts) => opts?.method === 'POST' ? { assessment: assessment({ id: 'cas_new', ...body }) } : { assessments: [] }
    mocks.answers['/api/assessments/config'] = config
    await mount({ athleteId: 'u_athlete' })

    await click(button('New assessment'))
    await change(input('weightKg'), '80')
    await change(input('heightCm'), '180')
    await change(input('age'), '30')
    await change(input('skinfold-chest'), '10')
    await change(input('skinfold-abdomen'), '15')
    await change(input('skinfold-thigh'), '12')
    await change(input('circumference-waist'), '88')
    await change(input('healthHistory'), 'Controlled asthma')
    const picker = host.querySelector('input[type="file"]')
    Object.defineProperty(picker, 'files', { configurable: true, value: [new File(['test'], 'progress.jpg', { type: 'image/jpeg' })] })
    await act(async () => { picker.dispatchEvent(new Event('change', { bubbles: true })) })
    await settle()
    const parq = host.querySelector('.assessment-question input')
    await click(parq)
    await settle()
    await click(button('Save assessment'))
    await settle()

    expect(mocks.calls.some(call => call.method === 'POST')).toBe(false)

    const acknowledge = [...host.querySelectorAll('.assessment-warning input')][0]
    await click(acknowledge)
    await click(button('Save assessment'))
    await settle()

    const created = mocks.calls.find(call => call.path === route && call.method === 'POST')
    expect(created.body.parq).toMatchObject({ version: '2024.1', acknowledged: true })
    expect(created.body.parq.answers.map(item => item.questionId)).toEqual(questions.map(item => item.id))
    expect(created.body.parq.answers[0].answer).toBe(true)
    expect(created.body.skinfolds).toMatchObject({ protocol: 'pollock3', sex: 'male', age: 30, chest: 10, abdomen: 15, thigh: 12 })
    expect(created.body.anamnesis.healthHistory).toBe('Controlled asthma')
    expect(created.body.photos).toEqual([{ kind: 'image', hash: 'a'.repeat(64), mime: 'image/webp', size: 4, width: 100, height: 120 }])
    expect(mocks.uploads).toEqual([{ path: `/api/media/${'a'.repeat(64)}`, size: 4, mime: 'image/webp' }])
    expect(mocks.toast).toHaveBeenCalledWith('Assessment saved.')
  })

  it('shows athlete history, medical warning and real longitudinal deltas without coach controls', async () => {
    mocks.answers['/api/athlete/assessments'] = { assessments: [
      assessment({ id: 'cas_2', assessedAt: '2026-11-01T10:00:00.000Z', weightKg: 78, results: { bodyFatPercent: 18, leanMassKg: 63.96 }, circumferences: { waist: 86, hip: 98, arm: 36 }, requiresMedicalClearance: true, medicalClearanceNotice: 'Clearance required. This is not a diagnosis.' }),
      assessment(),
    ] }
    mocks.answers['/api/assessments/config'] = config
    await mount({ athlete: true })

    expect(host.textContent).toContain('Medical clearance required')
    expect(host.textContent).toContain('Clearance required. This is not a diagnosis.')
    expect(host.textContent).toContain('-2 kg')
    expect(host.textContent).toContain('-2%')
    expect(host.textContent).toContain('-4 cm')
    expect(host.textContent).toContain('+1 cm')
    expect(button('New assessment')).toBeUndefined()
    expect(button('Correct assessment')).toBeUndefined()
  })

  it('deletes an athlete-owned assessment only after explicit id confirmation', async () => {
    mocks.answers['/api/athlete/assessments'] = { assessments: [assessment()] }
    mocks.answers['/api/assessments/config'] = config
    mocks.answers['/api/athlete/assessments/cas_1'] = { deleted: true }
    await mount({ athlete: true })

    await click(button('Delete assessment'))
    expect(mocks.confirms).toHaveLength(1)
    await act(async () => { await mocks.confirms[0].onConfirm() })

    expect(mocks.calls).toContainEqual({ path: '/api/athlete/assessments/cas_1', method: 'DELETE', body: { confirmation: 'cas_1' } })
    expect(host.textContent).toContain('No physical assessments yet.')
  })

  it('renders a recoverable error state when assessment history is forbidden or unavailable', async () => {
    mocks.answers['/api/coach/athletes/u_athlete/assessments'] = Object.assign(new Error('forbidden'), { status: 403, code: 'scope_forbidden' })
    mocks.answers['/api/assessments/config'] = config
    await mount({ athleteId: 'u_athlete' })

    expect(host.querySelector('[role="alert"]').textContent).toContain('This relationship does not authorize this action.')
    expect(button('Try again')).toBeDefined()
  })
})
