// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({ answers: {}, calls: [], toast: vi.fn(), confirms: [] }))
vi.mock('../store/useUI.js', () => {
  const useUI = selector => selector({ toast: mocks.toast })
  return { useUI }
})
vi.mock('../lib/api.js', () => ({
  api: vi.fn(async (path, opts) => {
    const body = opts?.body ? JSON.parse(opts.body) : null
    mocks.calls.push({ path, method: opts?.method || 'GET', body })
    const basePath = path.split('?')[0]
    const key = Object.keys(mocks.answers).find(candidate => candidate.endsWith('*') ? path.startsWith(candidate.slice(0, -1)) : candidate === path || candidate === basePath)
    const answer = mocks.answers[key]
    if (answer instanceof Error) throw answer
    return typeof answer === 'function' ? answer(body, opts, path) : answer ?? {}
  }),
}))
vi.mock('../sheets.jsx', () => ({ confirmSheet: options => mocks.confirms.push(options) }))

import NutritionPanel, { AthleteNutritionView, nutritionEditorIssues } from './NutritionPanel.jsx'

let host, root, consoleError
beforeEach(() => {
  Object.assign(mocks, { answers: {}, calls: [], toast: vi.fn(), confirms: [] })
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  consoleError = vi.spyOn(console, 'error')
})
afterEach(async () => {
  await act(async () => root.unmount())
  const reactWarnings = consoleError.mock.calls.filter(args => args.some(value => /act\(|unique "key"/i.test(String(value))))
  consoleError.mockRestore()
  host.remove()
  expect(reactWarnings).toEqual([])
})

const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
const mount = async component => { act(() => root.render(component)); await settle() }
const button = label => [...host.querySelectorAll('button')].find(item => item.textContent.trim() === label)
const input = name => host.querySelector(`[name="${name}"]`)
const change = async (element, value) => act(async () => {
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true }))
})
const click = async element => act(async () => { element.click() })
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const adherenceEnvelope = adherence => ({
  adherence,
  page: { limit: 50, hasMore: false, nextCursor: null },
  quota: { used: adherence.length, limit: 1000, retentionDays: 730 },
})

const mealPlan = {
  id: 'mp_1', title: 'Plano 2400 kcal', status: 'active', targetCalories: 2400,
  targetMacros: { protein: 160, carbs: 300, fats: 70, fiber: 30, waterMl: 3000 },
  meals: [{ id: 'm_1', name: 'Café da manhã', time: '07:30', items: [{ id: 'it_1', name: 'Ovos', portion: '3 unidades', calories: 210, protein: 18, carbs: 2, fats: 15,
    fiber: 1, substitutes: [{ name: 'Whey', portion: '30g' }] }] }],
  notes: 'Hidratar ao acordar.', coach: { name: 'Nutri' }, athlete: { name: 'Ana' }, createdAt: 1, updatedAt: 1,
}
const adherenceRecord = ({ id, mealPlanId = mealPlan.id, date = '2026-11-08', updatedAt = 1, title = mealPlan.title } = {}) => ({
  id, athleteId: 'u_athlete', mealPlanId, date, mealsChecked: ['m_1'], waterDrunkMl: 2000, notes: '', updatedAt,
  planSnapshot: {
    version: 1, nutritionContractVersion: 2, title, targetCalories: 2000,
    targetMacros: { protein: 150, carbs: 250, fats: 65, fiber: 30, waterMl: 2500 },
    meals: [{ id: 'm_1', name: 'Dia', time: '08:00', items: [] }, { id: 'm_2', name: 'Noite', time: '20:00', items: [] }], notes: '',
  },
})

it('uses the shared nutrition boundary matrix and rejects non-finite editor values', () => {
  const base = {
    title: 'Matriz', status: 'draft', targetCalories: '2000',
    targetMacros: { protein: '150', carbs: '250', fats: '65', fiber: '30', waterMl: '2500' },
    meals: [{ name: 'Dia', time: '08:00', items: [{
      name: 'Cardápio', portion: 'porções', calories: '2000', protein: '150', carbs: '250', fats: '65', fiber: '30', substitutes: [],
    }] }], notes: '',
  }
  const coverage = ratio => ({ ...base, meals: [{ ...base.meals[0], items: [{
    ...base.meals[0].items[0], calories: String(2000 * ratio), protein: String(150 * ratio), carbs: String(250 * ratio), fats: String(65 * ratio), fiber: String(30 * ratio),
  }] }] })
  expect(nutritionEditorIssues(coverage(0.79)).issues.some(issue => issue.code === 'food_coverage_out_of_range')).toBe(true)
  expect(nutritionEditorIssues(coverage(0.8)).issues).toEqual([])
  expect(nutritionEditorIssues(coverage(1)).issues).toEqual([])
  expect(nutritionEditorIssues(coverage(1.2)).issues).toEqual([])
  expect(nutritionEditorIssues(coverage(1.21)).issues.some(issue => issue.code === 'food_coverage_out_of_range')).toBe(true)
  for (const value of ['-1', 'NaN', 'Infinity']) {
    const candidate = structuredClone(base)
    candidate.targetMacros.protein = value
    expect(nutritionEditorIssues(candidate).issues.some(issue => issue.code === 'invalid_number')).toBe(true)
  }
})

describe('nutrition phase 4 views', () => {
  it('builds a meal with food and substitutions and submits calculated plan fields', async () => {
    const route = '/api/coach/athletes/u_athlete/meal-plans'
    mocks.answers[route] = (body, opts) => opts?.method === 'POST' ? { mealPlan: { ...mealPlan, ...body } } : { mealPlans: [] }
    mocks.answers['/api/coach/athletes/u_athlete/meal-adherence'] = adherenceEnvelope([])
    await mount(<NutritionPanel athleteId="u_athlete" />)

    await click(button('New meal plan'))
    await change(input('mealPlanTitle'), 'Plano 2400 kcal')
    await change(input('meal-name-1'), 'Café da manhã')
    await change(input('food-1-1'), 'Ovos')
    await change(input('portion-1-1'), '3 unidades')
    await change(input('calories-1-1'), '2000')
    await change(input('protein-1-1'), '150')
    await change(input('carbs-1-1'), '250')
    await change(input('fats-1-1'), '65')
    await change(input('fiber-1-1'), '30')
    await click(button('Add substitute'))
    const substituteInputs = host.querySelectorAll('.nutrition-substitute-row input')
    await change(substituteInputs[0], 'Whey')
    await change(substituteInputs[1], '30g')
    await click(button('Save meal plan'))
    await settle()

    const created = mocks.calls.find(call => call.path === route && call.method === 'POST')
    expect(created.body).toMatchObject({ title: 'Plano 2400 kcal', targetCalories: 2000 })
    expect(created.body.meals[0]).toMatchObject({ name: 'Café da manhã', time: '08:00' })
    expect(created.body.meals[0].items[0]).toMatchObject({ name: 'Ovos', portion: '3 unidades', calories: 2000, protein: 150, carbs: 250, fats: 65, fiber: 30 })
    expect(created.body.meals[0].items[0].substitutes).toEqual([{ name: 'Whey', portion: '30g' }])
    expect(host.textContent).toContain('2000 / 2000 kcal')
  })

  it('renders the active plan, shows substitutions and persists meal and water check-ins', async () => {
    mocks.answers['/api/athlete/meal-plan?date=*'] = { mealPlan }
    mocks.answers['/api/athlete/meal-adherence?date=*'] = { adherence: null }
    mocks.answers['/api/athlete/meal-adherence'] = body => ({ adherence: { id: 'adh_1', athleteId: 'u_athlete', ...body, updatedAt: 1 } })
    await mount(<AthleteNutritionView />)

    expect(host.textContent).toContain('Plano 2400 kcal')
    expect(host.textContent).toContain('Café da manhã')
    await click(button('View substitutions'))
    expect(host.querySelector('[role="dialog"]').textContent).toContain('Whey')
    await click(button('Close'))
    await click(button('Check in'))
    await settle()
    expect(mocks.calls.find(call => call.method === 'POST').body.mealUpdate).toEqual({ mealId: 'm_1', checked: true })

    await change(input('waterDrunkMl'), '2200')
    await click(button('Save water'))
    await settle()
    const posts = mocks.calls.filter(call => call.path === '/api/athlete/meal-adherence' && call.method === 'POST')
    expect(posts.at(-1).body).toMatchObject({ mealPlanId: 'mp_1', waterDrunkMl: 2200 })
    expect(posts.at(-1).body).not.toHaveProperty('mealsChecked')
  })

  it('traps dialog focus, closes on Escape and restores the substitution trigger', async () => {
    mocks.answers['/api/athlete/meal-plan?date=*'] = { mealPlan }
    mocks.answers['/api/athlete/meal-adherence?date=*'] = { adherence: null }
    await mount(<AthleteNutritionView />)
    const trigger = button('View substitutions')
    trigger.focus()
    await click(trigger)
    const dialog = host.querySelector('[role="dialog"]')
    expect(document.activeElement).toBe(dialog)
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy()
    const close = button('Close')
    close.focus()
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })))
    expect(document.activeElement).toBe(close)
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true })))
    expect(document.activeElement).toBe(close)
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    await settle()
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('serializes/coalesces rapid meal and water mutations and keeps unrelated optimistic state', async () => {
    const twoMeals = { ...mealPlan, meals: [mealPlan.meals[0], { ...mealPlan.meals[0], id: 'm_2', name: 'Almoço', items: [{ ...mealPlan.meals[0].items[0], id: 'it_2' }] }] }
    mocks.answers['/api/athlete/meal-plan?date=*'] = { mealPlan: twoMeals }
    mocks.answers['/api/athlete/meal-adherence?date=*'] = { adherence: null }
    const pendingRequests = []
    mocks.answers['/api/athlete/meal-adherence'] = body => {
      const wait = deferred(); pendingRequests.push({ body, wait }); return wait.promise
    }
    await mount(<AthleteNutritionView />)
    const checkIns = [...host.querySelectorAll('button')].filter(item => item.textContent === 'Check in')
    await click(checkIns[0])
    await click(checkIns[1])
    await change(input('waterDrunkMl'), '1800')
    await click(button('Save water'))
    expect(pendingRequests).toHaveLength(1)
    expect(pendingRequests[0].body.mealUpdate.mealId).toBe('m_1')
    expect([...host.querySelectorAll('.athlete-meal.checked')]).toHaveLength(2)
    await act(async () => pendingRequests[0].wait.resolve({ adherence: { id: 'adh_1', mealPlanId: 'mp_1', athleteId: 'u', date: '2026-11-06', mealsChecked: ['m_1'], waterDrunkMl: 0, notes: '', updatedAt: 1 } }))
    expect(pendingRequests).toHaveLength(2)
    await act(async () => pendingRequests[1].wait.resolve({ adherence: { id: 'adh_1', mealPlanId: 'mp_1', athleteId: 'u', date: '2026-11-06', mealsChecked: ['m_1', 'm_2'], waterDrunkMl: 0, notes: '', updatedAt: 2 } }))
    expect(pendingRequests).toHaveLength(3)
    await act(async () => pendingRequests[2].wait.resolve({ adherence: { id: 'adh_1', mealPlanId: 'mp_1', athleteId: 'u', date: '2026-11-06', mealsChecked: ['m_1', 'm_2'], waterDrunkMl: 1800, notes: '', updatedAt: 3 } }))
    expect(pendingRequests.map(item => item.body)).toEqual([
      expect.objectContaining({ mealUpdate: { mealId: 'm_1', checked: true } }),
      expect.objectContaining({ mealUpdate: { mealId: 'm_2', checked: true } }),
      expect.objectContaining({ waterDrunkMl: 1800 }),
    ])
    expect([...host.querySelectorAll('.athlete-meal.checked')]).toHaveLength(2)
    expect(host.textContent).toContain('1800 / 3000 ml')
  })
})

  it('validates macro coherence in real-time and allows 1-touch contextual recommendations', async () => {
    const route = '/api/coach/athletes/u_athlete/meal-plans'
    mocks.answers[route] = { mealPlans: [] }
    mocks.answers['/api/coach/athletes/u_athlete/meal-adherence'] = adherenceEnvelope([])
    await mount(<NutritionPanel athleteId="u_athlete" />)

    await click(button('New meal plan'))

    // Default plan has 2185 kcal derived from macros, within the shared 85–115% corridor.
    expect(host.textContent).toContain('Consistent macro distribution')

    // Change target calories to 10000 kcal while macros remain ~2185 kcal -> macro sum is too low
    await change(input('target-targetCalories'), '10000')
    await settle()
    expect(host.textContent).toContain('Macronutrient sum incoherence')
    expect(host.textContent).toContain('21.85%')
    expect(host.textContent).toContain('increase it')

    // Click contextual recommendation pill to insert hydration guideline into notes
    const recButton = [...host.querySelectorAll('.nutrition-rec-pill')].find(b => b.textContent.includes('Hydration'))
    expect(recButton).toBeTruthy()
    await click(recButton)
    await settle()
    expect(input('mealPlanNotes').value).toContain('Hydration: 500ml upon waking, 250ml every 2 hours')
  })

  it('provides 1-touch quick water buttons and accessible adherence indicators', async () => {
    mocks.answers['/api/athlete/meal-plan?date=*'] = { mealPlan }
    mocks.answers['/api/athlete/meal-adherence?date=*'] = { adherence: { id: 'adh_1', athleteId: 'u_athlete', mealPlanId: 'mp_1', mealsChecked: ['m_1'], waterDrunkMl: 1000 } }
    mocks.answers['/api/athlete/meal-adherence'] = body => ({ adherence: { id: 'adh_1', athleteId: 'u_athlete', ...body, updatedAt: 2 } })
    await mount(<AthleteNutritionView />)

    // Check transparent targets banner
    expect(host.querySelector('.athlete-target-banner')).toBeTruthy()
    expect(host.textContent).toContain('2400 kcal')
    expect(host.textContent).toContain('P: 160g')
    expect(host.textContent).toContain('C: 300g')
    expect(host.textContent).toContain('G: 70g')

    // Check accessible meal adherence progress
    const mealProgress = host.querySelector('progress[aria-label="Meal adherence progress"]')
    expect(mealProgress).toBeTruthy()
    expect(mealProgress.getAttribute('aria-valuenow')).toBe('100')
    expect(host.textContent).toContain('100% (1/1 meals)')

    // Check accessible water adherence progress
    const waterProgress = host.querySelector('progress[aria-label="Water adherence progress"]')
    expect(waterProgress).toBeTruthy()
    expect(waterProgress.getAttribute('aria-valuenow')).toBe('33') // 1000 / 3000 ml = 33%

    // 1-touch quick water increment (+500ml)
    const add500 = button('+500ml')
    expect(add500).toBeTruthy()
    await click(add500)
    await settle()

    const lastCall = mocks.calls.filter(c => c.path === '/api/athlete/meal-adherence' && c.method === 'POST').at(-1)
    expect(lastCall.body).toMatchObject({ mealPlanId: 'mp_1', waterDrunkMl: 1500 })
    expect(host.textContent).toContain('50% (1500 / 3000 ml)')
  })

  it('renders semantic adherence badges and progress in coach plan summary', async () => {
    const route = '/api/coach/athletes/u_athlete/meal-plans'
    mocks.answers[route] = { mealPlans: [mealPlan] }
    mocks.answers['/api/coach/athletes/u_athlete/meal-adherence'] = adherenceEnvelope([{
        id: 'adh_today', athleteId: 'u_athlete', mealPlanId: 'mp_1', date: '2026-11-08', mealsChecked: ['m_old_1'], waterDrunkMl: 3000, notes: '', updatedAt: 1,
        planSnapshot: {
          version: 1, nutritionContractVersion: 2, title: 'Plano histórico', targetCalories: 2600,
          targetMacros: { protein: 170, carbs: 320, fats: 75, fiber: 35, waterMl: 4000 },
          meals: [{ id: 'm_old_1', name: 'Manhã', time: '08:00', items: [] }, { id: 'm_old_2', name: 'Noite', time: '20:00', items: [] }], notes: '',
        },
      }])
    await mount(<NutritionPanel athleteId="u_athlete" />)

    expect(host.textContent).toContain('Recent adherence')
    expect(host.textContent).toContain('08/11/2026')
    expect(host.textContent).toContain('1/2 (50%)')
    expect(host.textContent).toContain('3000 / 4000 ml (75%)')
    expect(host.querySelector('.nutrition-adherence-day .ds-badge.success')).toBeNull()
  })

  it('loads every adherence page so page-two plans and tombstones remain represented', async () => {
    const plansRoute = '/api/coach/athletes/u_athlete/meal-plans'
    const adherenceRoute = '/api/coach/athletes/u_athlete/meal-adherence'
    const archivedPlan = { ...mealPlan, id: 'mp_page_two', title: 'Plano arquivado da página 2', status: 'archived' }
    mocks.answers[plansRoute] = { mealPlans: [mealPlan, archivedPlan] }
    const firstPage = Array.from({ length: 50 }, (_, index) => adherenceRecord({
      id: `adh_${String(index).padStart(2, '0')}`,
      updatedAt: 1000 - index,
    }))
    mocks.answers[adherenceRoute] = (_body, _opts, path) => {
      const cursor = new URL(path, 'http://test').searchParams.get('cursor')
      if (!cursor) return {
        adherence: firstPage,
        page: { limit: 50, hasMore: true, nextCursor: 'page-two' },
        quota: { used: 52, limit: 1000, retentionDays: 730 },
      }
      expect(cursor).toBe('page-two')
      return {
        adherence: [
          adherenceRecord({ id: 'adh_page_two', mealPlanId: archivedPlan.id, updatedAt: 950, title: archivedPlan.title }),
          adherenceRecord({ id: 'adh_tombstone', mealPlanId: 'mp_deleted_late', updatedAt: 949, title: 'Tombstone posterior' }),
        ],
        page: { limit: 50, hasMore: false, nextCursor: null },
        quota: { used: 52, limit: 1000, retentionDays: 730 },
      }
    }

    await mount(<NutritionPanel athleteId="u_athlete" />)

    expect(host.textContent).toContain('Plano arquivado da página 2')
    expect(host.textContent).toContain('Tombstone posterior')
    expect(host.textContent).toContain('Deleted plan history')
    const adherenceCalls = mocks.calls.filter(call => call.path.startsWith(adherenceRoute))
    expect(adherenceCalls).toHaveLength(2)
    expect(adherenceCalls[0].path).toContain('limit=50')
    expect(adherenceCalls[1].path).toContain('cursor=page-two')
  })

  it('preserves page-one history and offers retry when page two fails', async () => {
    const plansRoute = '/api/coach/athletes/u_athlete/meal-plans'
    const adherenceRoute = '/api/coach/athletes/u_athlete/meal-adherence'
    const pageTwoPlan = { ...mealPlan, id: 'mp_page_two', title: 'Plano sem página carregada', status: 'archived' }
    mocks.answers[plansRoute] = { mealPlans: [mealPlan, pageTwoPlan] }
    let failSecondPage = true
    mocks.answers[adherenceRoute] = (_body, _opts, path) => {
      const cursor = new URL(path, 'http://test').searchParams.get('cursor')
      if (!cursor) return {
        adherence: [adherenceRecord({ id: 'adh_recovered', updatedAt: 2 })],
        page: { limit: 50, hasMore: true, nextCursor: 'second' },
        quota: { used: 2, limit: 1000, retentionDays: 730 },
      }
      if (failSecondPage) throw new Error('page two offline')
      return {
        adherence: [adherenceRecord({ id: 'adh_second', mealPlanId: pageTwoPlan.id, updatedAt: 1, title: pageTwoPlan.title })],
        page: { limit: 50, hasMore: false, nextCursor: null },
        quota: { used: 2, limit: 1000, retentionDays: 730 },
      }
    }

    await mount(<NutritionPanel athleteId="u_athlete" />)

    expect(host.textContent).toContain('Adherence history is incomplete. Showing 1 recovered check-ins.')
    expect(host.textContent).toContain('08/11/2026')
    expect(host.textContent).toContain('Full adherence history is unavailable.')
    expect(host.textContent).not.toContain('No meal check-ins yet.')
    failSecondPage = false
    await click(button('Try again'))
    await settle()
    expect(host.textContent).toContain(pageTwoPlan.title)
    expect(host.textContent).not.toContain('Adherence history is incomplete.')
  })

  it('stops repeated cursors without looping and keeps the valid pages already received', async () => {
    const plansRoute = '/api/coach/athletes/u_athlete/meal-plans'
    const adherenceRoute = '/api/coach/athletes/u_athlete/meal-adherence'
    mocks.answers[plansRoute] = { mealPlans: [mealPlan] }
    mocks.answers[adherenceRoute] = (_body, _opts, path) => {
      const cursor = new URL(path, 'http://test').searchParams.get('cursor')
      return cursor ? {
        adherence: [adherenceRecord({ id: 'adh_loop_2', updatedAt: 1 })],
        page: { limit: 50, hasMore: true, nextCursor: 'loop' },
        quota: { used: 2, limit: 1000, retentionDays: 730 },
      } : {
        adherence: [adherenceRecord({ id: 'adh_loop_1', updatedAt: 2 })],
        page: { limit: 50, hasMore: true, nextCursor: 'loop' },
        quota: { used: 2, limit: 1000, retentionDays: 730 },
      }
    }

    await mount(<NutritionPanel athleteId="u_athlete" />)

    expect(host.textContent).toContain('Adherence history is incomplete. Showing 2 recovered check-ins.')
    expect(mocks.calls.filter(call => call.path.startsWith(adherenceRoute))).toHaveLength(2)
  })

  it('deduplicates adherence IDs across page boundaries', async () => {
    const plansRoute = '/api/coach/athletes/u_athlete/meal-plans'
    const adherenceRoute = '/api/coach/athletes/u_athlete/meal-adherence'
    const duplicate = adherenceRecord({ id: 'adh_duplicate', updatedAt: 2 })
    mocks.answers[plansRoute] = { mealPlans: [mealPlan] }
    mocks.answers[adherenceRoute] = (_body, _opts, path) => new URL(path, 'http://test').searchParams.has('cursor') ? {
      adherence: [duplicate, adherenceRecord({ id: 'adh_unique', updatedAt: 1 })],
      page: { limit: 50, hasMore: false, nextCursor: null },
      quota: { used: 2, limit: 1000, retentionDays: 730 },
    } : {
      adherence: [duplicate],
      page: { limit: 50, hasMore: true, nextCursor: 'next' },
      quota: { used: 2, limit: 1000, retentionDays: 730 },
    }

    await mount(<NutritionPanel athleteId="u_athlete" />)

    expect(host.textContent).toContain('2 registros')
    expect(host.querySelectorAll('.nutrition-adherence-day')).toHaveLength(2)
  })

  it('rejects out-of-order later pages as partial instead of accepting a corrupt global history', async () => {
    const plansRoute = '/api/coach/athletes/u_athlete/meal-plans'
    const adherenceRoute = '/api/coach/athletes/u_athlete/meal-adherence'
    mocks.answers[plansRoute] = { mealPlans: [mealPlan] }
    mocks.answers[adherenceRoute] = (_body, _opts, path) => new URL(path, 'http://test').searchParams.has('cursor') ? {
      adherence: [adherenceRecord({ id: 'adh_newer_late', updatedAt: 3 })],
      page: { limit: 50, hasMore: false, nextCursor: null },
      quota: { used: 2, limit: 1000, retentionDays: 730 },
    } : {
      adherence: [adherenceRecord({ id: 'adh_first', updatedAt: 2 })],
      page: { limit: 50, hasMore: true, nextCursor: 'next' },
      quota: { used: 2, limit: 1000, retentionDays: 730 },
    }

    await mount(<NutritionPanel athleteId="u_athlete" />)

    expect(host.textContent).toContain('Adherence history is incomplete. Showing 1 recovered check-ins.')
    expect(host.querySelectorAll('.nutrition-adherence-day')).toHaveLength(1)
  })

  it('keeps valid plans visible when adherence is unavailable and retries only that state', async () => {
    const plansRoute = '/api/coach/athletes/u_athlete/meal-plans'
    const adherenceRoute = '/api/coach/athletes/u_athlete/meal-adherence'
    mocks.answers[plansRoute] = { mealPlans: [mealPlan] }
    mocks.answers[adherenceRoute] = new Error('offline')
    await mount(<NutritionPanel athleteId="u_athlete" />)

    expect(host.textContent).toContain(mealPlan.title)
    expect(host.textContent).toContain('Adherence unavailable now')
    expect(host.textContent).not.toContain('No meal check-ins yet.')
    mocks.answers[adherenceRoute] = adherenceEnvelope([])
    await click(button('Try again'))
    await settle()
    expect(host.textContent).toContain('No meal check-ins yet.')
  })

  it('treats an incomplete 2xx adherence envelope as unavailable without inventing zero denominators', async () => {
    const route = '/api/coach/athletes/u_athlete/meal-plans'
    mocks.answers[route] = { mealPlans: [mealPlan] }
    mocks.answers['/api/coach/athletes/u_athlete/meal-adherence'] = { adherence: [] }
    await mount(<NutritionPanel athleteId="u_athlete" />)

    expect(host.textContent).toContain(mealPlan.title)
    expect(host.textContent).toContain('Adherence unavailable now')
    expect(host.textContent).not.toMatch(/0\/0 \(0%\)/)
  })

  it('keeps deleted-plan history readable from the immutable adherence snapshot', async () => {
    const route = '/api/coach/athletes/u_athlete/meal-plans'
    mocks.answers[route] = { mealPlans: [] }
    mocks.answers['/api/coach/athletes/u_athlete/meal-adherence'] = adherenceEnvelope([{
      id: 'adh_deleted', athleteId: 'u_athlete', mealPlanId: 'mp_deleted', date: '2026-11-07', mealsChecked: ['m_1'], waterDrunkMl: 2000, notes: '', updatedAt: 1,
      planSnapshot: {
        version: 1, nutritionContractVersion: 2, title: 'Plano excluído', targetCalories: 2000,
        targetMacros: { protein: 150, carbs: 250, fats: 65, fiber: 30, waterMl: 2500 },
        meals: [{ id: 'm_1', name: 'Dia', time: '08:00', items: [] }, { id: 'm_2', name: 'Noite', time: '20:00', items: [] }], notes: '',
      },
    }])
    await mount(<NutritionPanel athleteId="u_athlete" />)

    expect(host.textContent).toContain('Plano excluído')
    expect(host.textContent).toContain('Deleted plan history')
    expect(host.textContent).toContain('07/11/2026')
    expect(host.textContent).toContain('1/2 (50%)')
    expect(button('Edit')).toBeUndefined()
  })

  it('blocks incoherent coverage before dispatch and identifies the proportion to correct', async () => {
    const route = '/api/coach/athletes/u_athlete/meal-plans'
    mocks.answers[route] = { mealPlans: [] }
    mocks.answers['/api/coach/athletes/u_athlete/meal-adherence'] = adherenceEnvelope([])
    await mount(<NutritionPanel athleteId="u_athlete" />)
    await click(button('New meal plan'))
    await change(input('mealPlanTitle'), 'Plano incompleto')
    await change(input('meal-name-1'), 'Dia')
    await change(input('food-1-1'), 'Cardápio')
    await change(input('portion-1-1'), 'porções')
    await change(input('calories-1-1'), '1599')
    await change(input('protein-1-1'), '119')
    await change(input('carbs-1-1'), '199')
    await change(input('fats-1-1'), '51')
    await change(input('fiber-1-1'), '23')

    expect(host.textContent).toContain('Calories coverage')
    expect(host.textContent).toContain('79.95%')
    await click(button('Save meal plan'))
    expect(mocks.calls.filter(call => call.path === route && call.method === 'POST')).toHaveLength(0)
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining('Calories'))
  })
