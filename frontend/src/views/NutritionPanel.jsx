import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { api } from '../lib/api.js'
import { professionalError, professionalText as p } from '../lib/professional-copy.js'
import { useUI } from '../store/useUI.js'
import { confirmSheet } from '../sheets.jsx'
import { Button, TextArea, TextField } from '../components/ui.jsx'
import { Alert, Badge, EmptyState } from '../components/design-system.jsx'
import {
  NUTRITION_CONTRACT_VERSION, NUTRITION_TOLERANCES, nutritionPlanIssues, nutritionTotals,
} from '../../../api/nutrition-contract.js'
import './NutritionPanel.css'

const today = () => {
  const value = new Date()
  const offset = value.getTimezoneOffset() * 60000
  return new Date(value.getTime() - offset).toISOString().slice(0, 10)
}
const number = value => Number(value || 0)
const SUBSTITUTE_NUTRIENTS = ['calories', 'protein', 'carbs', 'fats', 'fiber']
const blankSubstitute = () => ({ name: '', portion: '', calories: '', protein: '', carbs: '', fats: '', fiber: '' })
const blankItem = () => ({ name: '', portion: '', calories: '0', protein: '0', carbs: '0', fats: '0', fiber: '0', substitutes: [] })
const blankMeal = () => ({ name: '', time: '08:00', items: [blankItem()] })
const blankPlan = () => ({
  title: '', status: 'draft', targetCalories: '2000',
  targetMacros: { protein: '150', carbs: '250', fats: '65', fiber: '30', waterMl: '2500' },
  meals: [blankMeal()], notes: '',
})
const editablePlan = plan => ({
  ...plan,
  targetCalories: String(plan.targetCalories),
  targetMacros: Object.fromEntries(Object.entries(plan.targetMacros).map(([key, value]) => [key, String(value)])),
  meals: plan.meals.map(meal => ({ ...meal, items: meal.items.map(item => ({
    ...item, calories: String(item.calories), protein: String(item.protein), carbs: String(item.carbs), fats: String(item.fats), fiber: String(item.fiber || 0),
    substitutes: item.substitutes.map(substitute => ({ ...substitute, ...Object.fromEntries(SUBSTITUTE_NUTRIENTS.map(key => [key, substitute[key] === undefined ? '' : String(substitute[key])])) })),
  })) })),
})
const totalsOf = plan => plan.meals.flatMap(meal => meal.items).reduce((totals, item) => ({
  calories: totals.calories + number(item.calories), protein: totals.protein + number(item.protein),
  carbs: totals.carbs + number(item.carbs), fats: totals.fats + number(item.fats), fiber: totals.fiber + number(item.fiber),
}), { calories: 0, protein: 0, carbs: 0, fats: 0, fiber: 0 })
const formatDay = value => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '')
  return match ? `${match[3]}/${match[2]}/${match[1]}` : value
}
const finiteNumber = value => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}
const numericPlan = plan => ({
  title: plan.title,
  status: plan.status,
  targetCalories: finiteNumber(plan.targetCalories),
  targetMacros: Object.fromEntries(Object.entries(plan.targetMacros).map(([key, value]) => [key, finiteNumber(value)])),
  meals: plan.meals.map(meal => ({ ...meal, items: meal.items.map(item => ({
    ...item,
    ...Object.fromEntries(SUBSTITUTE_NUTRIENTS.map(key => [key, finiteNumber(item[key])])),
    substitutes: item.substitutes.map(substitute => ({
      ...substitute,
      ...Object.fromEntries(SUBSTITUTE_NUTRIENTS.filter(key => substitute[key] !== '' && substitute[key] !== undefined)
        .map(key => [key, finiteNumber(substitute[key])])),
    })),
  })) })),
  notes: plan.notes,
})
const ratioText = ratio => `${Math.round(ratio * 10000) / 100}%`
const editorIssues = plan => {
  const normalized = numericPlan(plan)
  const issues = []
  const targetRanges = { targetCalories: [1, 10000], protein: [1, 500], carbs: [1, 1200], fats: [1, 500], fiber: [0, 200], waterMl: [1, 15000] }
  for (const [field, [min, max]] of Object.entries(targetRanges)) {
    const value = field === 'targetCalories' ? normalized.targetCalories : normalized.targetMacros[field]
    if (value === null || value < min || value > max) issues.push({ field, code: 'invalid_number', min, max })
  }
  const itemRanges = { calories: [0, 5000], protein: [0, 500], carbs: [0, 1000], fats: [0, 500], fiber: [0, 200] }
  if (normalized.meals.length < 1 || normalized.meals.length > 20) issues.push({ field: 'meals', code: 'count_out_of_range', min: 1, max: 20 })
  normalized.meals.forEach((meal, mealIndex) => {
    if (meal.items.length < 1 || meal.items.length > 50) issues.push({ field: `meals.${mealIndex}.items`, code: 'count_out_of_range', min: 1, max: 50 })
    meal.items.forEach((item, itemIndex) => {
      if (item.substitutes.length > 20) issues.push({ field: `meals.${mealIndex}.items.${itemIndex}.substitutes`, code: 'count_out_of_range', min: 0, max: 20 })
      for (const [field, [min, max]] of Object.entries(itemRanges)) {
        const value = item[field]
        if (value === null || value < min || value > max) issues.push({ field: `meals.${mealIndex}.items.${itemIndex}.${field}`, code: 'invalid_number', min, max })
      }
      item.substitutes.forEach((substitute, substituteIndex) => SUBSTITUTE_NUTRIENTS.forEach(field => {
        if (substitute[field] === undefined || substitute[field] === '') return
        const [min, max] = itemRanges[field]
        const value = substitute[field]
        if (value === null || value < min || value > max) {
          issues.push({ field: `meals.${mealIndex}.items.${itemIndex}.substitutes.${substituteIndex}.${field}`, code: 'invalid_number', min, max })
          return
        }
        const absolute = field === 'calories' ? 100 : 5
        if (Math.abs(value - item[field]) > Math.max(absolute, item[field] * NUTRITION_TOLERANCES.substitutePercent)) {
          issues.push({ field, code: 'substitute_out_of_range', actual: value, target: item[field] })
        }
      }))
    })
  })
  if (!issues.length) issues.push(...nutritionPlanIssues(normalized, NUTRITION_CONTRACT_VERSION))
  return { normalized, issues }
}
export { editorIssues as nutritionEditorIssues }
const issueMessage = issue => {
  if (!issue) return ''
  if (issue.code === 'invalid_number') return p('{0} must be a finite value between {1} and {2}.', p(issue.field.split('.').at(-1)), issue.min, issue.max)
  if (issue.code === 'count_out_of_range') return p('{0} must contain between {1} and {2} entries.', p(issue.field.split('.').at(-1)), issue.min, issue.max)
  if (issue.code === 'substitute_out_of_range') return p('The substitute {0} must remain equivalent to the original food.', p(issue.field))
  const label = issue.field === 'targetMacros' ? p('Calories derived from macros') : p(issue.field === 'calories' ? 'Calories' : issue.field[0].toUpperCase() + issue.field.slice(1))
  const direction = issue.ratio < issue.min ? p('increase') : p('decrease')
  return p('{0} is at {1}; {2} it to stay between {3}% and {4}% of the target.', label, ratioText(issue.ratio), direction, Math.round(issue.min * 100), Math.round(issue.max * 100))
}

const validSnapshot = snapshot => snapshot && snapshot.version === 1
  && Number.isInteger(snapshot.nutritionContractVersion) && typeof snapshot.title === 'string'
  && Number.isFinite(snapshot.targetCalories) && snapshot.targetMacros && typeof snapshot.targetMacros === 'object'
  && Array.isArray(snapshot.meals)
const validAdherenceEnvelope = value => value && Array.isArray(value.adherence)
  && value.page && Number.isInteger(value.page.limit) && value.page.limit >= 1 && value.page.limit <= 100
  && typeof value.page.hasMore === 'boolean' && (value.page.nextCursor === null || typeof value.page.nextCursor === 'string')
  && value.quota && Number.isInteger(value.quota.used) && value.quota.used >= 0
  && Number.isInteger(value.quota.limit) && value.quota.limit >= 1
  && Number.isInteger(value.quota.retentionDays) && value.quota.retentionDays >= 1
  && value.adherence.every(item => (
    item && typeof item.id === 'string' && typeof item.athleteId === 'string' && typeof item.mealPlanId === 'string'
    && /^\d{4}-\d{2}-\d{2}$/.test(item.date) && Array.isArray(item.mealsChecked)
    && Number.isFinite(item.waterDrunkMl) && typeof item.notes === 'string' && Number.isFinite(item.updatedAt)
    && validSnapshot(item.planSnapshot)
  ))

const CONTEXTUAL_RECOMMENDATIONS = [
  'Meal timing: 4-5 meals spaced every 3-4 hours',
  'Hydration: 500ml upon waking, 250ml every 2 hours',
  'Supplementation: 5g creatine post-workout, whey protein as needed',
  'Pre-workout: fast-digesting carbohydrates 45 min before training',
]

function MacroSummary({ plan }) {
  const totals = totalsOf(plan)
  const values = [
    [p('Calories'), totals.calories, plan.targetCalories, 'kcal'],
    [p('Protein'), totals.protein, plan.targetMacros.protein, 'g'],
    [p('Carbohydrates'), totals.carbs, plan.targetMacros.carbs, 'g'],
    [p('Fats'), totals.fats, plan.targetMacros.fats, 'g'],
    [p('Fiber'), totals.fiber, plan.targetMacros.fiber, 'g'],
  ]
  return <div className="nutrition-macros" aria-label={p('Calculated nutrition totals')}>
    {values.map(([label, actual, target, unit]) => {
      const tgt = number(target)
      const pct = tgt > 0 ? Math.round((actual / tgt) * 100) : (actual > 0 ? 100 : 0)
      return (
        <div key={label}>
          <span>{label}</span>
          <strong>{actual} / {tgt} {unit}</strong>
          <progress
            aria-label={`${label} (${pct}%)`}
            aria-valuenow={pct}
            aria-valuemin="0"
            aria-valuemax="100"
            max={Math.max(tgt, actual, 1)}
            value={actual}
          />
        </div>
      )
    })}
  </div>
}

function ItemEditor({ item, mealIndex, itemIndex, onChange, onRemove, canRemove }) {
  const set = (key, value) => onChange({ ...item, [key]: value })
  const prefix = `${mealIndex + 1}-${itemIndex + 1}`
  const updateSubstitute = (index, key, value) => set('substitutes', item.substitutes.map((substitute, current) => current === index ? { ...substitute, [key]: value } : substitute))
  return <div className="nutrition-item-editor">
    <div className="nutrition-editor-head"><strong>{p('Food {0}', itemIndex + 1)}</strong>
      {canRemove && <Button size="sm" variant="danger" onClick={onRemove}>{p('Remove food')}</Button>}</div>
    <div className="nutrition-grid two">
      <label className="pro-field"><span>{p('Food')}</span><TextField name={`food-${prefix}`} value={item.name} maxLength={120} onChange={event => set('name', event.target.value)} /></label>
      <label className="pro-field"><span>{p('Portion')}</span><TextField name={`portion-${prefix}`} value={item.portion} maxLength={120} onChange={event => set('portion', event.target.value)} /></label>
    </div>
    <div className="nutrition-grid five">
      {[['calories', p('Calories')], ['protein', p('Protein (g)')], ['carbs', p('Carbs (g)')], ['fats', p('Fats (g)')], ['fiber', p('Fiber (g)')]].map(([key, label]) => <label key={key} className="pro-field"><span>{label}</span>
        <TextField name={`${key}-${prefix}`} type="number" min="0" step="0.1" value={item[key]} onChange={event => set(key, event.target.value)} /></label>)}
    </div>
    <div className="nutrition-substitute-edit"><span className="pro-label">{p('Suggested substitutions')}</span>
      {item.substitutes.map((substitute, index) => <div className="nutrition-substitute-row" key={index}>
        <TextField aria-label={p('Substitute food')} value={substitute.name} maxLength={120} onChange={event => updateSubstitute(index, 'name', event.target.value)} />
        <TextField aria-label={p('Substitute portion')} value={substitute.portion} maxLength={120} onChange={event => updateSubstitute(index, 'portion', event.target.value)} />
        <div className="nutrition-substitute-nutrients">
          {SUBSTITUTE_NUTRIENTS.map(key => <TextField key={key} aria-label={p('Substitute {0}', key)} type="number" min="0" step="0.1" value={substitute[key]} onChange={event => updateSubstitute(index, key, event.target.value)} />)}
        </div>
        <Button size="sm" variant="danger" aria-label={p('Remove substitute')} onClick={() => set('substitutes', item.substitutes.filter((_, current) => current !== index))}>×</Button>
      </div>)}
      <Button size="sm" icon="plus" onClick={() => set('substitutes', [...item.substitutes, blankSubstitute()])}>{p('Add substitute')}</Button>
    </div>
  </div>
}

function MealEditor({ meal, mealIndex, onChange, onRemove, canRemove }) {
  const set = (key, value) => onChange({ ...meal, [key]: value })
  const updateItem = (itemIndex, next) => set('items', meal.items.map((item, index) => index === itemIndex ? next : item))
  return <section className="nutrition-meal-editor">
    <div className="nutrition-editor-head"><strong>{p('Meal {0}', mealIndex + 1)}</strong>
      {canRemove && <Button size="sm" variant="danger" onClick={onRemove}>{p('Remove meal')}</Button>}</div>
    <div className="nutrition-grid two">
      <label className="pro-field"><span>{p('Meal name')}</span><TextField name={`meal-name-${mealIndex + 1}`} value={meal.name} maxLength={100} onChange={event => set('name', event.target.value)} /></label>
      <label className="pro-field"><span>{p('Time')}</span><TextField name={`meal-time-${mealIndex + 1}`} type="time" value={meal.time} onChange={event => set('time', event.target.value)} /></label>
    </div>
    {meal.items.map((item, itemIndex) => <ItemEditor key={item.id || itemIndex} item={item} mealIndex={mealIndex} itemIndex={itemIndex}
      canRemove={meal.items.length > 1} onChange={next => updateItem(itemIndex, next)}
      onRemove={() => set('items', meal.items.filter((_, index) => index !== itemIndex))} />)}
    <Button size="sm" icon="plus" onClick={() => set('items', [...meal.items, blankItem()])}>{p('Add food')}</Button>
  </section>
}

function MealPlanEditor({ initial, athleteId, onSaved, onCancel }) {
  const toast = useUI(state => state.toast)
  const [plan, setPlan] = useState(() => initial ? editablePlan(initial) : blankPlan())
  const [saving, setSaving] = useState(false)
  const updateMeal = (mealIndex, next) => setPlan(current => ({ ...current, meals: current.meals.map((meal, index) => index === mealIndex ? next : meal) }))

  const targetCal = number(plan.targetCalories)
  const targetProt = number(plan.targetMacros.protein)
  const targetCarbs = number(plan.targetMacros.carbs)
  const targetFats = number(plan.targetMacros.fats)
  const targetFiber = number(plan.targetMacros.fiber)
  const targetWater = number(plan.targetMacros.waterMl)

  const macroCalories = targetProt * 4 + targetCarbs * 4 + targetFats * 9
  const validation = editorIssues(plan)
  const contractIssues = validation.issues.filter(issue => issue.code !== 'invalid_number')
  const macroIssue = contractIssues.find(issue => issue.field === 'targetMacros')
  const totals = validation.issues.some(issue => issue.code === 'invalid_number') ? totalsOf(plan) : nutritionTotals(validation.normalized)
  const macroDifference = macroCalories - targetCal
  const macroCoherence = targetCal > 0 && Number.isFinite(macroCalories) ? (
    macroIssue
      ? { tone: 'error', title: p('Macronutrient sum incoherence'), text: issueMessage(macroIssue) }
      : { tone: 'info', title: p('Consistent macro distribution'), text: p('Calculated macro calories: {0} kcal; difference from target: {1} kcal ({2}).', macroCalories, macroDifference >= 0 ? `+${macroDifference}` : macroDifference, ratioText(macroCalories / targetCal)) }
  ) : null
  const coverage = ['calories', 'protein', 'carbs', 'fats', 'fiber'].map(field => {
    const target = field === 'calories' ? targetCal : number(plan.targetMacros[field])
    const actual = totals[field]
    const ratio = target > 0 ? actual / target : 0
    return { field, actual, target, ratio, issue: contractIssues.find(item => item.field === field) }
  })

  const save = async () => {
    const invalid = !plan.title.trim() || plan.meals.some(meal => !meal.name.trim() || !meal.time || meal.items.some(item => !item.name.trim() || !item.portion.trim()
      || item.substitutes.some(substitute => !substitute.name.trim() || !substitute.portion.trim())))
    if (invalid) return toast(p('Complete the plan, meals, foods and portions.'))
    if (validation.issues.length) return toast(issueMessage(validation.issues[0]))
    setSaving(true)
    try {
      const body = {
        title: plan.title.trim(), status: plan.status, targetCalories: number(plan.targetCalories),
        targetMacros: Object.fromEntries(Object.entries(plan.targetMacros).map(([key, value]) => [key, number(value)])),
        meals: plan.meals.map(meal => ({ ...(meal.id ? { id: meal.id } : {}), name: meal.name.trim(), time: meal.time,
          items: meal.items.map(item => ({ ...(item.id ? { id: item.id } : {}), name: item.name.trim(), portion: item.portion.trim(),
            calories: number(item.calories), protein: number(item.protein), carbs: number(item.carbs), fats: number(item.fats), fiber: number(item.fiber),
            substitutes: item.substitutes.map(substitute => ({
              name: substitute.name.trim(), portion: substitute.portion.trim(),
              ...Object.fromEntries(SUBSTITUTE_NUTRIENTS.filter(key => substitute[key] !== '' && substitute[key] !== undefined).map(key => [key, number(substitute[key])])),
            })),
          })),
        })), notes: plan.notes.trim(),
      }
      const route = `/api/coach/athletes/${athleteId}/meal-plans${initial ? `/${initial.id}` : ''}`
      const result = await api(route, { method: initial ? 'PATCH' : 'POST', body: JSON.stringify(body) })
      onSaved(result.mealPlan, initial)
      toast(p('Meal plan saved.'))
    } catch (error) { toast(professionalError(error)) }
    finally { setSaving(false) }
  }

  const addRecommendation = rec => {
    setPlan(current => ({
      ...current,
      notes: current.notes ? `${current.notes}\n• ${p(rec)}` : `• ${p(rec)}`,
    }))
  }

  return <section className="card nutrition-editor" aria-label={p('Meal plan editor')}>
    <div className="nutrition-editor-head"><h3>{initial ? p('Edit meal plan') : p('New meal plan')}</h3><Button size="sm" onClick={onCancel}>{p('Cancel')}</Button></div>
    <div className="nutrition-grid two">
      <label className="pro-field"><span>{p('Plan title')}</span><TextField name="mealPlanTitle" value={plan.title} maxLength={120} onChange={event => setPlan(current => ({ ...current, title: event.target.value }))} /></label>
      <label className="pro-field"><span>{p('Status')}</span><select name="mealPlanStatus" value={plan.status} onChange={event => setPlan(current => ({ ...current, status: event.target.value }))}>
        <option value="draft">{p('Draft')}</option><option value="active">{p('Active')}</option><option value="archived">{p('Archived')}</option>
      </select></label>
    </div>
    <div className="nutrition-grid nutrition-targets">
      {[['targetCalories', p('Calories'), plan.targetCalories], ['protein', p('Protein (g)'), plan.targetMacros.protein], ['carbs', p('Carbs (g)'), plan.targetMacros.carbs],
        ['fats', p('Fats (g)'), plan.targetMacros.fats], ['fiber', p('Fiber (g)'), plan.targetMacros.fiber], ['waterMl', p('Water (ml)'), plan.targetMacros.waterMl]].map(([key, label, value]) => <label className="pro-field" key={key}><span>{label}</span>
          <TextField name={`target-${key}`} type="number" min={key === 'fiber' ? '0' : '1'} value={value} onChange={event => setPlan(current => key === 'targetCalories'
            ? { ...current, targetCalories: event.target.value } : { ...current, targetMacros: { ...current.targetMacros, [key]: event.target.value } })} /></label>)}
    </div>

    {macroCoherence && (
      <div className="nutrition-validation-box">
        <Alert tone={macroCoherence.tone} title={macroCoherence.title}>
          {macroCoherence.text}
        </Alert>
      </div>
    )}

    <div className="nutrition-validation-box" aria-label={p('Food coverage versus targets')}>
      {coverage.map(item => <Alert key={item.field} tone={item.issue ? 'error' : 'info'} title={p('{0} coverage', p(item.field === 'calories' ? 'Calories' : item.field[0].toUpperCase() + item.field.slice(1)))}>
        {p('{0} of {1} ({2}); allowed range is {3}%–{4}%.', item.actual, item.target, ratioText(item.ratio), NUTRITION_TOLERANCES.foodTotalsMin * 100, NUTRITION_TOLERANCES.foodTotalsMax * 100)}
      </Alert>)}
    </div>

    <MacroSummary plan={plan} />
    <div className="nutrition-meal-editors">{plan.meals.map((meal, mealIndex) => <MealEditor key={meal.id || mealIndex} meal={meal} mealIndex={mealIndex}
      canRemove={plan.meals.length > 1} onChange={next => updateMeal(mealIndex, next)}
      onRemove={() => setPlan(current => ({ ...current, meals: current.meals.filter((_, index) => index !== mealIndex) }))} />)}</div>
    <Button size="sm" icon="plus" onClick={() => setPlan(current => ({ ...current, meals: [...current.meals, blankMeal()] }))}>{p('Add meal')}</Button>

    <div className="nutrition-recommendations-toolbar">
      <span className="pro-label">{p('Contextual recommendations')}</span>
      <span className="pro-meta">{p('Add meal timing, hydration or supplementation guidelines for the athlete.')}</span>
      <div className="nutrition-rec-pills">
        {CONTEXTUAL_RECOMMENDATIONS.map((rec, idx) => (
          <button key={idx} type="button" className="nutrition-rec-pill" onClick={() => addRecommendation(rec)}>
            + {p(rec)}
          </button>
        ))}
      </div>
    </div>

    <label className="pro-field"><span>{p('Notes')}</span><TextArea name="mealPlanNotes" rows={3} value={plan.notes} maxLength={2000} onChange={event => setPlan(current => ({ ...current, notes: event.target.value }))} /></label>
    <Button variant="primary" disabled={saving} onClick={save}>{saving ? p('Saving…') : p('Save meal plan')}</Button>
  </section>
}

function PlanSummary({ plan, adherenceState, onEdit, onStatus, onDelete, historyOnly = false }) {
  const checked = adherenceState.data.filter(item => item.mealPlanId === plan.id)
  return <article className="card nutrition-plan-summary" data-status={plan.status}>
    <div className="nutrition-editor-head"><div><h3>{plan.title}</h3><span className="pro-meta">{historyOnly ? p('Deleted plan history') : p('By {0}', plan.coach?.name || p('Unavailable account'))} · {plan.targetCalories} kcal · {plan.meals.length} {p('meals')}</span></div><span className={`pro-status ${plan.status}`}>{p(plan.status === 'active' ? 'Active' : plan.status === 'draft' ? 'Draft' : 'Archived')}</span></div>
    <MacroSummary plan={plan} />
    {plan.notes && <p className="nutrition-notes">{plan.notes}</p>}
    <div className="nutrition-history">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <strong>{p('Recent adherence')}</strong>
        {checked.length > 0 && <span className="pro-meta">{checked.length} {checked.length === 1 ? 'registro' : 'registros'}</span>}
      </div>
      {adherenceState.status === 'loading' ? <span>{p('Loading adherence…')}</span>
        : adherenceState.status === 'error' ? <span>{p('Adherence unavailable now')}</span>
          : checked.length === 0 ? <span>{p('No meal check-ins yet.')}</span> : (
        <div className="nutrition-adherence-card-grid">
          {checked.slice(0, 7).map(item => {
            const snapshot = item.planSnapshot
            const mealCount = Array.isArray(snapshot?.meals) ? snapshot.meals.length : null
            const mealsDone = item.mealsChecked.length
            const allMealsDone = mealCount !== null && mealCount > 0 && mealsDone >= mealCount
            const waterMl = item.waterDrunkMl || 0
            const waterTarget = Number.isFinite(snapshot?.targetMacros?.waterMl) ? snapshot.targetMacros.waterMl : null
            const waterDone = waterTarget > 0 && waterMl >= waterTarget
            const mealPct = mealCount > 0 ? Math.round((mealsDone / mealCount) * 100) : null
            const waterPct = waterTarget > 0 ? Math.round((Math.min(waterMl, waterTarget) / waterTarget) * 100) : null

            return (
              <div key={item.id} className="nutrition-adherence-day">
                <div className="nutrition-adherence-day-head">
                  <span>{formatDay(item.date)}</span>
                  <Badge tone={allMealsDone && (waterTarget === 0 || waterDone) ? 'success' : 'neutral'}>
                    {allMealsDone ? p('Completed') : mealPct === null ? p('Unavailable') : `${mealPct}%`}
                  </Badge>
                </div>
                <div className="nutrition-adherence-day-metrics">
                  <div className="nutrition-adherence-metric-row">
                    <span>{p('Meal check-ins')}:</span>
                    <strong>{mealCount === null ? mealsDone : `${mealsDone}/${mealCount} (${mealPct}%)`}</strong>
                  </div>
                  {mealCount !== null && <progress
                    aria-label={p('Meal adherence progress')}
                    aria-valuenow={mealPct}
                    aria-valuemin="0"
                    aria-valuemax="100"
                    max={mealCount}
                    value={mealsDone}
                  />}
                  <div className="nutrition-adherence-metric-row">
                    <span>{p('Water intake')}:</span>
                    <strong>{waterTarget === null ? `${waterMl} ml` : `${waterMl} / ${waterTarget} ml (${waterPct}%)`}</strong>
                  </div>
                  {waterTarget > 0 && (
                    <progress
                      aria-label={p('Water adherence progress')}
                      aria-valuenow={waterPct}
                      aria-valuemin="0"
                      aria-valuemax="100"
                      max={waterTarget}
                      value={Math.min(waterMl, waterTarget)}
                    />
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
    {!historyOnly && <div className="pro-actions"><Button size="sm" onClick={() => onEdit(plan)}>{p('Edit')}</Button>
      {plan.status !== 'active' && <Button size="sm" variant="primary" onClick={() => onStatus(plan, 'active')}>{p('Activate')}</Button>}
      {plan.status === 'active' && <Button size="sm" onClick={() => onStatus(plan, 'archived')}>{p('Archive')}</Button>}
      <Button size="sm" variant="danger" onClick={() => onDelete(plan)}>{p('Delete')}</Button></div>}
  </article>
}

export default function NutritionPanel({ athleteId }) {
  const toast = useUI(state => state.toast)
  const [plans, setPlans] = useState(null)
  const [adherenceState, setAdherenceState] = useState({ status: 'loading', data: [], error: null })
  const [editing, setEditing] = useState(null)
  const [plansError, setPlansError] = useState(null)
  const [quota, setQuota] = useState({ plans: null, adherence: null })
  const loadAdherence = useCallback(async () => {
    setAdherenceState(current => ({ ...current, status: 'loading', error: null }))
    try {
      const result = await api(`/api/coach/athletes/${athleteId}/meal-adherence`)
      if (!validAdherenceEnvelope(result)) throw new Error('invalid adherence envelope')
      setAdherenceState({ status: result.adherence.length ? 'ok' : 'empty', data: result.adherence, error: null })
      setQuota(current => ({ ...current, adherence: result.quota || null }))
    } catch (error) {
      setAdherenceState(current => ({ ...current, status: 'error', error }))
    }
  }, [athleteId])
  const load = useCallback(async () => {
    setPlansError(null)
    setAdherenceState(current => ({ ...current, status: 'loading', error: null }))
    const [plansResult, adherenceResult] = await Promise.allSettled([
      api(`/api/coach/athletes/${athleteId}/meal-plans`), api(`/api/coach/athletes/${athleteId}/meal-adherence`),
    ])
    if (plansResult.status === 'fulfilled' && Array.isArray(plansResult.value?.mealPlans)) {
      setPlans(plansResult.value.mealPlans)
      setQuota(current => ({ ...current, plans: plansResult.value.quota || null }))
    } else setPlansError(plansResult.status === 'rejected' ? plansResult.reason : new Error('invalid meal plan envelope'))
    if (adherenceResult.status === 'fulfilled' && validAdherenceEnvelope(adherenceResult.value)) {
      setAdherenceState({ status: adherenceResult.value.adherence.length ? 'ok' : 'empty', data: adherenceResult.value.adherence, error: null })
      setQuota(current => ({ ...current, adherence: adherenceResult.value.quota || null }))
    } else {
      setAdherenceState(current => ({ ...current, status: 'error', error: adherenceResult.status === 'rejected' ? adherenceResult.reason : new Error('invalid adherence envelope') }))
    }
  }, [athleteId])
  useEffect(() => { load() }, [load])
  const saveStatus = async (plan, status) => {
    try {
      const result = await api(`/api/coach/athletes/${athleteId}/meal-plans/${plan.id}`, { method: 'PATCH', body: JSON.stringify({ status }) })
      setPlans(current => current.map(item => item.id === plan.id ? result.mealPlan : status === 'active' && item.status === 'active' ? { ...item, status: 'archived' } : item))
    } catch (saveError) { toast(professionalError(saveError)) }
  }
  const remove = plan => confirmSheet({ title: p('Delete this meal plan?'), message: p('The plan will be removed, but its historical check-ins will remain available.'), confirmText: p('Delete meal plan'), danger: true,
    onConfirm: async () => { try { await api(`/api/coach/athletes/${athleteId}/meal-plans/${plan.id}`, { method: 'DELETE' }); setPlans(current => current.filter(item => item.id !== plan.id)) } catch (removeError) { toast(professionalError(removeError)) } },
  })
  const livePlanIds = new Set((plans || []).map(plan => plan.id))
  const retainedHistoryPlans = [...adherenceState.data.reduce((groups, item) => {
    if (livePlanIds.has(item.mealPlanId) || groups.has(item.mealPlanId) || !validSnapshot(item.planSnapshot)) return groups
    const snapshot = item.planSnapshot
    groups.set(item.mealPlanId, {
      id: item.mealPlanId, title: snapshot.title, status: 'archived', targetCalories: snapshot.targetCalories,
      targetMacros: snapshot.targetMacros, meals: snapshot.meals, notes: '', coach: null,
    })
    return groups
  }, new Map()).values()]
  return <section className="nutrition-panel" aria-labelledby={`nutrition-panel-${athleteId}`}>
    <div className="pro-panel-head"><strong id={`nutrition-panel-${athleteId}`}>{p('Nutrition')}</strong>
      {!editing && <Button size="sm" icon="plus" onClick={() => setEditing(true)}>{p('New meal plan')}</Button>}</div>
    {quota?.plans && <p className="nutrition-quota">{p('{0} of {1} meal-plan slots used. Delete obsolete plans to free a slot.', quota.plans.used, quota.plans.limit)}</p>}
    {quota?.adherence && <p className="nutrition-quota">{p('{0} of {1} check-ins stored; entries older than {2} days are removed automatically.', quota.adherence.used, quota.adherence.limit, quota.adherence.retentionDays)}</p>}
    {adherenceState.status === 'error' && <div className="pro-load-inline" role="alert"><span>{p('Adherence unavailable now')}</span><Button size="sm" onClick={loadAdherence}>{p('Try again')}</Button></div>}
    {editing && <MealPlanEditor athleteId={athleteId} initial={editing === true ? null : editing} onCancel={() => setEditing(null)} onSaved={(saved, previous) => {
      setPlans(current => previous ? current.map(item => item.id === saved.id ? saved : saved.status === 'active' && item.status === 'active' ? { ...item, status: 'archived' } : item)
        : [saved, ...(current || []).map(item => saved.status === 'active' && item.status === 'active' ? { ...item, status: 'archived' } : item)])
      setEditing(null)
    }} />}
    {plansError ? <div className="pro-load-inline" role="alert"><span>{professionalError(plansError)}</span><Button size="sm" onClick={load}>{p('Try again')}</Button></div>
      : plans === null ? <div className="pro-loading">{p('Loading…')}</div>
        : plans.length === 0 && retainedHistoryPlans.length === 0 ? <p className="pro-empty-inline">{p('No meal plans yet.')}</p>
          : <div className="nutrition-plan-list">
            {plans.map(plan => <PlanSummary key={plan.id} plan={plan} adherenceState={adherenceState} onEdit={setEditing} onStatus={saveStatus} onDelete={remove} />)}
            {retainedHistoryPlans.map(plan => <PlanSummary key={plan.id} plan={plan} adherenceState={adherenceState} historyOnly />)}
          </div>}
  </section>
}

function SubstituteDialog({ item, trigger, onClose }) {
  const dialogRef = useRef(null)
  const titleId = useId()
  useEffect(() => {
    const dialog = dialogRef.current
    dialog?.focus()
    const keydown = event => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return }
      if (event.key !== 'Tab' || !dialog) return
      const focusable = [...dialog.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
        .filter(element => !element.disabled && element.getAttribute('aria-hidden') !== 'true')
      if (!focusable.length) { event.preventDefault(); dialog.focus(); return }
      const first = focusable[0]; const last = focusable.at(-1)
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', keydown)
    return () => { document.removeEventListener('keydown', keydown); trigger?.focus() }
  }, [onClose, trigger])
  return <div className="nutrition-dialog-backdrop" role="presentation" onMouseDown={event => event.target === event.currentTarget && onClose()}><section ref={dialogRef} tabIndex={-1} className="card nutrition-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
    <div className="nutrition-editor-head"><h3 id={titleId}>{p('Substitutions for {0}', item.name)}</h3><Button size="sm" onClick={onClose}>{p('Close')}</Button></div>
    <p className="nutrition-notes">{p('Nutrition is verified only when calories and every macro are shown.')}</p>
    {item.substitutes.map((substitute, index) => <div className="nutrition-substitute" key={index}><strong>{substitute.name}</strong><span>{substitute.portion}</span>
      {SUBSTITUTE_NUTRIENTS.every(key => typeof substitute[key] === 'number')
        ? <small>{substitute.calories} kcal · P {substitute.protein}g · C {substitute.carbs}g · G {substitute.fats}g · F {substitute.fiber}g</small>
        : <small>{p('Nutrition not verified for this suggestion.')}</small>}</div>)}
  </section></div>
}

export function AthleteNutritionView() {
  const toast = useUI(state => state.toast)
  const [date] = useState(today)
  const [plan, setPlan] = useState(null)
  const [adherence, setAdherence] = useState(null)
  const [water, setWater] = useState('0')
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState(null)
  const [substitutes, setSubstitutes] = useState(null)
  const [pending, setPending] = useState(() => new Set())
  const adherenceRef = useRef(null)
  const mutationQueueRef = useRef(Promise.resolve())
  const mutationVersionsRef = useRef(new Map())
  const mutationSequenceRef = useRef(0)

  const updateAdherence = useCallback(next => {
    const value = typeof next === 'function' ? next(adherenceRef.current) : next
    adherenceRef.current = value
    setAdherence(value)
  }, [])

  const load = useCallback(async () => {
    setError(null)
    try {
      const [planResult, adherenceResult] = await Promise.all([api(`/api/athlete/meal-plan?date=${date}`), api(`/api/athlete/meal-adherence?date=${date}`)])
      const current = (adherenceResult.adherenceRecords || [adherenceResult.adherence]).find(item => item?.mealPlanId === planResult.mealPlan?.id) || null
      adherenceRef.current = current; setPlan(planResult.mealPlan || null); setAdherence(current); setWater(String(current?.waterDrunkMl || 0)); setLoaded(true)
    } catch (loadError) { setError(loadError); setLoaded(true) }
  }, [date])
  useEffect(() => { load() }, [load])

  const persist = useCallback((key, mutation, rollback) => {
    if (!plan) return
    const version = ++mutationSequenceRef.current
    mutationVersionsRef.current.set(key, version)
    setPending(current => new Set(current).add(key))
    const run = async () => {
      try {
        const result = await api('/api/athlete/meal-adherence', {
          method: 'POST', body: JSON.stringify({ mealPlanId: plan.id, date, ...mutation }),
        })
        if (mutationVersionsRef.current.get(key) !== version) return
        updateAdherence(current => ({
          ...result.adherence,
          mealsChecked: current?.mealsChecked || result.adherence.mealsChecked,
          waterDrunkMl: current?.waterDrunkMl ?? result.adherence.waterDrunkMl,
          notes: current?.notes ?? result.adherence.notes,
        }))
      } catch (saveError) {
        if (mutationVersionsRef.current.get(key) === version) rollback?.()
        toast(professionalError(saveError))
      } finally {
        if (mutationVersionsRef.current.get(key) === version) {
          setPending(current => { const next = new Set(current); next.delete(key); return next })
        }
      }
    }
    mutationQueueRef.current = mutationQueueRef.current.then(run, run)
  }, [date, plan, toast, updateAdherence])

  const toggleMeal = mealId => {
    const before = new Set(adherenceRef.current?.mealsChecked || [])
    const checked = !before.has(mealId)
    const optimistic = new Set(before)
    if (checked) optimistic.add(mealId); else optimistic.delete(mealId)
    updateAdherence(current => ({
      id: current?.id, athleteId: current?.athleteId, mealPlanId: plan.id, date,
      mealsChecked: [...optimistic], waterDrunkMl: current?.waterDrunkMl || 0, notes: current?.notes || '', updatedAt: current?.updatedAt,
    }))
    persist(`meal:${mealId}`, { mealUpdate: { mealId, checked } }, () => updateAdherence(current => {
      const restored = new Set(current?.mealsChecked || [])
      if (before.has(mealId)) restored.add(mealId); else restored.delete(mealId)
      return { ...current, mealsChecked: [...restored] }
    }))
  }

  const saveWater = () => {
    const previous = adherenceRef.current?.waterDrunkMl || 0
    const value = Math.max(0, number(water))
    updateAdherence(current => ({
      id: current?.id, athleteId: current?.athleteId, mealPlanId: plan.id, date,
      mealsChecked: current?.mealsChecked || [], waterDrunkMl: value, notes: current?.notes || '', updatedAt: current?.updatedAt,
    }))
    persist('water', { waterDrunkMl: value }, () => { updateAdherence(current => ({ ...current, waterDrunkMl: previous })); setWater(String(previous)) })
  }

  const adjustWater = amount => {
    const current = number(water)
    const next = Math.max(0, current + amount)
    setWater(String(next))
    const previous = adherenceRef.current?.waterDrunkMl || 0
    updateAdherence(curr => ({
      id: curr?.id, athleteId: curr?.athleteId, mealPlanId: plan.id, date,
      mealsChecked: curr?.mealsChecked || [], waterDrunkMl: next, notes: curr?.notes || '', updatedAt: curr?.updatedAt,
    }))
    persist('water', { waterDrunkMl: next }, () => {
      updateAdherence(curr => ({ ...curr, waterDrunkMl: previous }))
      setWater(String(previous))
    })
  }

  const closeSubstitutes = useCallback(() => setSubstitutes(null), [])
  if (!loaded) return <div className="pro-loading">{p('Loading…')}</div>
  if (error) return <div className="card pro-load-error" role="alert"><p>{professionalError(error)}</p><Button size="sm" onClick={load}>{p('Try again')}</Button></div>
  if (!plan) return <p className="pro-empty-inline">{p('No active meal plan.')}</p>

  const checked = new Set(adherence?.mealsChecked || [])
  const mealCount = plan.meals.length
  const checkedCount = checked.size
  const mealPercent = mealCount > 0 ? Math.round((checkedCount / mealCount) * 100) : 0
  const waterVal = number(water)
  const waterGoal = plan.targetMacros?.waterMl || 0
  const waterPercent = waterGoal > 0 ? Math.round((Math.min(waterVal, waterGoal) / waterGoal) * 100) : 0

  return <section className="card athlete-nutrition" aria-labelledby="athlete-nutrition-title">
    <div className="nutrition-editor-head">
      <div>
        <h3 id="athlete-nutrition-title">{plan.title}</h3>
        <span className="pro-meta">{p('By {0}', plan.coach?.name || p('Unavailable account'))}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <strong>{checkedCount}/{mealCount}</strong>
        {mealCount > 0 && checkedCount >= mealCount && <Badge tone="success">{p('Completed')}</Badge>}
      </div>
    </div>

    <div className="athlete-target-banner" aria-label={p('Daily nutritional targets')}>
      {plan.targetCalories > 0 && <span className="athlete-target-badge"><strong>{plan.targetCalories}</strong> kcal</span>}
      {plan.targetMacros?.protein > 0 && <span className="athlete-target-badge"><strong>P:</strong> {plan.targetMacros.protein}g</span>}
      {plan.targetMacros?.carbs > 0 && <span className="athlete-target-badge"><strong>C:</strong> {plan.targetMacros.carbs}g</span>}
      {plan.targetMacros?.fats > 0 && <span className="athlete-target-badge"><strong>G:</strong> {plan.targetMacros.fats}g</span>}
      {plan.targetMacros?.fiber > 0 && <span className="athlete-target-badge"><strong>F:</strong> {plan.targetMacros.fiber}g</span>}
      {waterGoal > 0 && <span className="athlete-target-badge"><strong>{p('Water (ml)')}:</strong> {waterGoal} ml</span>}
    </div>

    <MacroSummary plan={plan} />

    {plan.notes && (
      <div className="nutrition-recommendations-banner">
        <h4>{p('Nutritionist recommendations')}</h4>
        <p>{plan.notes}</p>
      </div>
    )}

    <div className="nutrition-adherence-tracker" style={{ margin: '14px 0 8px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
        <strong>{p('Meal check-ins')}</strong>
        <span>{mealPercent}% ({checkedCount}/{mealCount} {p('meals')})</span>
      </div>
      <progress
        aria-label={p('Meal adherence progress')}
        aria-valuenow={mealPercent}
        aria-valuemin="0"
        aria-valuemax="100"
        max={mealCount}
        value={checkedCount}
      />
    </div>

    <div className="athlete-meals">{plan.meals.slice().sort((left, right) => left.time.localeCompare(right.time)).map(meal => <article className={`athlete-meal${checked.has(meal.id) ? ' checked' : ''}`} key={meal.id}>
      <div className="athlete-meal-head">
        <div><time>{meal.time}</time><h4>{meal.name}</h4></div>
        <Button size="sm" className="athlete-meal-action-btn" style={{ minHeight: '44px' }} disabled={pending.has(`meal:${meal.id}`)} variant={checked.has(meal.id) ? 'primary' : 'plain'} onClick={() => toggleMeal(meal.id)}>
          {checked.has(meal.id) ? p('Completed') : p('Check in')}
        </Button>
      </div>
      {meal.items.map(item => <div className="athlete-food" key={item.id}><div><strong>{item.name}</strong><span>{item.portion}</span></div><small>{item.calories} kcal · P {item.protein}g · C {item.carbs}g · G {item.fats}g · F {item.fiber || 0}g</small>
        {item.substitutes.length > 0 && <Button size="sm" style={{ minHeight: '44px' }} onClick={event => setSubstitutes({ item, trigger: event.currentTarget })}>{p('View substitutions')}</Button>}</div>)}
    </article>)}</div>

    <div className="nutrition-water">
      <div>
        <strong>{p('Water today')}</strong>
        <span>{waterPercent}% ({waterVal} / {waterGoal} ml)</span>
      </div>
      <progress
        aria-label={p('Water adherence progress')}
        aria-valuenow={waterPercent}
        aria-valuemin="0"
        aria-valuemax="100"
        max={waterGoal}
        value={Math.min(waterVal, waterGoal)}
      />
      {waterGoal > 0 && waterVal >= waterGoal && (
        <Badge tone="success" style={{ alignSelf: 'flex-start' }}>
          {p('Daily water target reached')}
        </Badge>
      )}

      <div className="athlete-water-quick-buttons" aria-label={p('Quick water intake')}>
        <Button size="sm" className="athlete-water-btn" disabled={pending.has('water')} onClick={() => adjustWater(250)}>
          +250ml
        </Button>
        <Button size="sm" className="athlete-water-btn" disabled={pending.has('water')} onClick={() => adjustWater(500)}>
          +500ml
        </Button>
        <Button size="sm" className="athlete-water-btn" disabled={pending.has('water')} onClick={() => adjustWater(1000)}>
          +1000ml
        </Button>
        <Button size="sm" className="athlete-water-btn" disabled={pending.has('water') || waterVal === 0} onClick={() => adjustWater(-250)}>
          -250ml
        </Button>
      </div>

      <div>
        <TextField name="waterDrunkMl" disabled={pending.has('water')} type="number" min="0" max="20000" step="100" value={water} onChange={event => setWater(event.target.value)} />
        <Button size="sm" variant="primary" style={{ minHeight: '44px' }} disabled={pending.has('water')} onClick={saveWater}>{p('Save water')}</Button>
      </div>
    </div>
    {substitutes && <SubstituteDialog item={substitutes.item} trigger={substitutes.trigger} onClose={closeSubstitutes} />}
  </section>
}
