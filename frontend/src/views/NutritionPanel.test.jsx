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
    const key = Object.keys(mocks.answers).find(candidate => candidate.endsWith('*') ? path.startsWith(candidate.slice(0, -1)) : candidate === path)
    const answer = mocks.answers[key]
    if (answer instanceof Error) throw answer
    return typeof answer === 'function' ? answer(body, opts, path) : answer ?? {}
  }),
}))
vi.mock('../sheets.jsx', () => ({ confirmSheet: options => mocks.confirms.push(options) }))

import NutritionPanel, { AthleteNutritionView } from './NutritionPanel.jsx'

let host, root
beforeEach(() => {
  Object.assign(mocks, { answers: {}, calls: [], toast: vi.fn(), confirms: [] })
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })

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

const mealPlan = {
  id: 'mp_1', title: 'Plano 2400 kcal', status: 'active', targetCalories: 2400,
  targetMacros: { protein: 160, carbs: 300, fats: 70, fiber: 30, waterMl: 3000 },
  meals: [{ id: 'm_1', name: 'Café da manhã', time: '07:30', items: [{ id: 'it_1', name: 'Ovos', portion: '3 unidades', calories: 210, protein: 18, carbs: 2, fats: 15,
    fiber: 1, substitutes: [{ name: 'Whey', portion: '30g' }] }] }],
  notes: 'Hidratar ao acordar.', coach: { name: 'Nutri' }, athlete: { name: 'Ana' }, createdAt: 1, updatedAt: 1,
}

describe('nutrition phase 4 views', () => {
  it('builds a meal with food and substitutions and submits calculated plan fields', async () => {
    const route = '/api/coach/athletes/u_athlete/meal-plans'
    mocks.answers[route] = (body, opts) => opts?.method === 'POST' ? { mealPlan: { ...mealPlan, ...body } } : { mealPlans: [] }
    mocks.answers['/api/coach/athletes/u_athlete/meal-adherence'] = { adherence: [] }
    await mount(<NutritionPanel athleteId="u_athlete" />)

    await click(button('New meal plan'))
    await change(input('mealPlanTitle'), 'Plano 2400 kcal')
    await change(input('meal-name-1'), 'Café da manhã')
    await change(input('food-1-1'), 'Ovos')
    await change(input('portion-1-1'), '3 unidades')
    await change(input('calories-1-1'), '210')
    await change(input('protein-1-1'), '18')
    await click(button('Add substitute'))
    const substituteInputs = host.querySelectorAll('.nutrition-substitute-row input')
    await change(substituteInputs[0], 'Whey')
    await change(substituteInputs[1], '30g')
    await click(button('Save meal plan'))
    await settle()

    const created = mocks.calls.find(call => call.path === route && call.method === 'POST')
    expect(created.body).toMatchObject({ title: 'Plano 2400 kcal', targetCalories: 2000 })
    expect(created.body.meals[0]).toMatchObject({ name: 'Café da manhã', time: '08:00' })
    expect(created.body.meals[0].items[0]).toMatchObject({ name: 'Ovos', portion: '3 unidades', calories: 210, protein: 18 })
    expect(created.body.meals[0].items[0].substitutes).toEqual([{ name: 'Whey', portion: '30g' }])
    expect(host.textContent).toContain('210 / 2000 kcal')
  })

  it('renders the active plan, shows substitutions and persists meal and water check-ins', async () => {
    mocks.answers['/api/athlete/meal-plan'] = { mealPlan }
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
    mocks.answers['/api/athlete/meal-plan'] = { mealPlan }
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
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    expect(document.activeElement).toBe(close)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }))
    expect(document.activeElement).toBe(close)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await settle()
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('serializes/coalesces rapid meal and water mutations and keeps unrelated optimistic state', async () => {
    const twoMeals = { ...mealPlan, meals: [mealPlan.meals[0], { ...mealPlan.meals[0], id: 'm_2', name: 'Almoço', items: [{ ...mealPlan.meals[0].items[0], id: 'it_2' }] }] }
    mocks.answers['/api/athlete/meal-plan'] = { mealPlan: twoMeals }
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
    pendingRequests[0].wait.resolve({ adherence: { id: 'adh_1', mealPlanId: 'mp_1', athleteId: 'u', date: '2026-11-06', mealsChecked: ['m_1'], waterDrunkMl: 0, notes: '', updatedAt: 1 } })
    await settle()
    expect(pendingRequests).toHaveLength(2)
    pendingRequests[1].wait.resolve({ adherence: { id: 'adh_1', mealPlanId: 'mp_1', athleteId: 'u', date: '2026-11-06', mealsChecked: ['m_1', 'm_2'], waterDrunkMl: 0, notes: '', updatedAt: 2 } })
    await settle()
    expect(pendingRequests).toHaveLength(3)
    pendingRequests[2].wait.resolve({ adherence: { id: 'adh_1', mealPlanId: 'mp_1', athleteId: 'u', date: '2026-11-06', mealsChecked: ['m_1', 'm_2'], waterDrunkMl: 1800, notes: '', updatedAt: 3 } })
    await settle()
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
    mocks.answers['/api/coach/athletes/u_athlete/meal-adherence'] = { adherence: [] }
    await mount(<NutritionPanel athleteId="u_athlete" />)

    await click(button('New meal plan'))

    // Notice default plan has 2000 kcal target, 150g protein (600kcal), 250g carbs (1000kcal), 65g fats (585kcal) = 2185 kcal (within 0.65-1.35)
    expect(host.textContent).toContain('Consistent macro distribution')

    // Change target calories to 10000 kcal while macros remain ~2185 kcal -> macro sum is too low
    await change(input('target-targetCalories'), '10000')
    await settle()
    expect(host.textContent).toContain('Macronutrient sum incoherence')
    expect(host.textContent).toContain('is too low for the daily goal')

    // Click contextual recommendation pill to insert hydration guideline into notes
    const recButton = [...host.querySelectorAll('.nutrition-rec-pill')].find(b => b.textContent.includes('Hydration'))
    expect(recButton).toBeTruthy()
    await click(recButton)
    await settle()
    expect(input('mealPlanNotes').value).toContain('Hydration: 500ml upon waking, 250ml every 2 hours')
  })

  it('provides 1-touch quick water buttons and accessible adherence indicators', async () => {
    mocks.answers['/api/athlete/meal-plan'] = { mealPlan }
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
    mocks.answers['/api/coach/athletes/u_athlete/meal-adherence'] = {
      adherence: [{ id: 'adh_today', mealPlanId: 'mp_1', date: '2026-11-08', mealsChecked: ['m_1'], waterDrunkMl: 3000 }],
    }
    await mount(<NutritionPanel athleteId="u_athlete" />)

    expect(host.textContent).toContain('Recent adherence')
    expect(host.textContent).toContain('2026-11-08')
    expect(host.textContent).toContain('1/1 (100%)')
    expect(host.textContent).toContain('3000 / 3000 ml (100%)')
    const completedBadge = host.querySelector('.nutrition-adherence-day .ds-badge.success')
    expect(completedBadge).toBeTruthy()
  })
