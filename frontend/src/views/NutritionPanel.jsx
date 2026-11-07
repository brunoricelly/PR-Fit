import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { api } from '../lib/api.js'
import { professionalError, professionalText as p } from '../lib/professional-copy.js'
import { useUI } from '../store/useUI.js'
import { confirmSheet } from '../sheets.jsx'
import { Button, TextArea, TextField } from '../components/ui.jsx'
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
    {values.map(([label, actual, target, unit]) => <div key={label}><span>{label}</span><strong>{actual} / {number(target)} {unit}</strong>
      <progress max={Math.max(number(target), actual, 1)} value={actual} /></div>)}
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
  const save = async () => {
    const invalid = !plan.title.trim() || plan.meals.some(meal => !meal.name.trim() || !meal.time || meal.items.some(item => !item.name.trim() || !item.portion.trim()
      || item.substitutes.some(substitute => !substitute.name.trim() || !substitute.portion.trim())))
    if (invalid) return toast(p('Complete the plan, meals, foods and portions.'))
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
    <MacroSummary plan={plan} />
    <div className="nutrition-meal-editors">{plan.meals.map((meal, mealIndex) => <MealEditor key={meal.id || mealIndex} meal={meal} mealIndex={mealIndex}
      canRemove={plan.meals.length > 1} onChange={next => updateMeal(mealIndex, next)}
      onRemove={() => setPlan(current => ({ ...current, meals: current.meals.filter((_, index) => index !== mealIndex) }))} />)}</div>
    <Button size="sm" icon="plus" onClick={() => setPlan(current => ({ ...current, meals: [...current.meals, blankMeal()] }))}>{p('Add meal')}</Button>
    <label className="pro-field"><span>{p('Notes')}</span><TextArea name="mealPlanNotes" rows={3} value={plan.notes} maxLength={2000} onChange={event => setPlan(current => ({ ...current, notes: event.target.value }))} /></label>
    <Button variant="primary" disabled={saving} onClick={save}>{saving ? p('Saving…') : p('Save meal plan')}</Button>
  </section>
}

function PlanSummary({ plan, adherence, onEdit, onStatus, onDelete }) {
  const checked = adherence.filter(item => item.mealPlanId === plan.id)
  return <article className="card nutrition-plan-summary" data-status={plan.status}>
    <div className="nutrition-editor-head"><div><h3>{plan.title}</h3><span className="pro-meta">{p('By {0}', plan.coach?.name || p('Unavailable account'))} · {plan.targetCalories} kcal · {plan.meals.length} {p('meals')}</span></div><span className={`pro-status ${plan.status}`}>{p(plan.status === 'active' ? 'Active' : plan.status === 'draft' ? 'Draft' : 'Archived')}</span></div>
    <MacroSummary plan={plan} />
    {plan.notes && <p className="nutrition-notes">{plan.notes}</p>}
    <div className="nutrition-history"><strong>{p('Recent adherence')}</strong>
      {checked.length === 0 ? <span>{p('No meal check-ins yet.')}</span> : checked.slice(0, 7).map(item => <span key={item.id}>{item.date}: {item.mealsChecked.length}/{plan.meals.length} · {item.waterDrunkMl} ml</span>)}</div>
    <div className="pro-actions"><Button size="sm" onClick={() => onEdit(plan)}>{p('Edit')}</Button>
      {plan.status !== 'active' && <Button size="sm" variant="primary" onClick={() => onStatus(plan, 'active')}>{p('Activate')}</Button>}
      {plan.status === 'active' && <Button size="sm" onClick={() => onStatus(plan, 'archived')}>{p('Archive')}</Button>}
      <Button size="sm" variant="danger" onClick={() => onDelete(plan)}>{p('Delete')}</Button></div>
  </article>
}

export default function NutritionPanel({ athleteId }) {
  const toast = useUI(state => state.toast)
  const [plans, setPlans] = useState(null)
  const [adherence, setAdherence] = useState([])
  const [editing, setEditing] = useState(null)
  const [error, setError] = useState(null)
  const [quota, setQuota] = useState(null)
  const load = useCallback(async () => {
    setError(null)
    try {
      const [plansResult, adherenceResult] = await Promise.all([
        api(`/api/coach/athletes/${athleteId}/meal-plans`), api(`/api/coach/athletes/${athleteId}/meal-adherence`),
      ])
      setPlans(plansResult.mealPlans || []); setAdherence(adherenceResult.adherence || [])
      setQuota({ plans: plansResult.quota, adherence: adherenceResult.quota })
    } catch (loadError) { setError(loadError) }
  }, [athleteId])
  useEffect(() => { load() }, [load])
  const saveStatus = async (plan, status) => {
    try {
      const result = await api(`/api/coach/athletes/${athleteId}/meal-plans/${plan.id}`, { method: 'PATCH', body: JSON.stringify({ status }) })
      setPlans(current => current.map(item => item.id === plan.id ? result.mealPlan : status === 'active' && item.status === 'active' ? { ...item, status: 'archived' } : item))
    } catch (saveError) { toast(professionalError(saveError)) }
  }
  const remove = plan => confirmSheet({ title: p('Delete this meal plan?'), message: p('Its meal check-ins will also be removed.'), confirmText: p('Delete meal plan'), danger: true,
    onConfirm: async () => { try { await api(`/api/coach/athletes/${athleteId}/meal-plans/${plan.id}`, { method: 'DELETE' }); setPlans(current => current.filter(item => item.id !== plan.id)) } catch (removeError) { toast(professionalError(removeError)) } },
  })
  return <section className="nutrition-panel" aria-labelledby={`nutrition-panel-${athleteId}`}>
    <div className="pro-panel-head"><strong id={`nutrition-panel-${athleteId}`}>{p('Nutrition')}</strong>
      {!editing && <Button size="sm" icon="plus" onClick={() => setEditing(true)}>{p('New meal plan')}</Button>}</div>
    {quota?.plans && <p className="nutrition-quota">{p('{0} of {1} meal-plan slots used. Delete obsolete plans to free a slot.', quota.plans.used, quota.plans.limit)}</p>}
    {quota?.adherence && <p className="nutrition-quota">{p('{0} of {1} check-ins stored; entries older than {2} days are removed automatically.', quota.adherence.used, quota.adherence.limit, quota.adherence.retentionDays)}</p>}
    {editing && <MealPlanEditor athleteId={athleteId} initial={editing === true ? null : editing} onCancel={() => setEditing(null)} onSaved={(saved, previous) => {
      setPlans(current => previous ? current.map(item => item.id === saved.id ? saved : saved.status === 'active' && item.status === 'active' ? { ...item, status: 'archived' } : item)
        : [saved, ...(current || []).map(item => saved.status === 'active' && item.status === 'active' ? { ...item, status: 'archived' } : item)])
      setEditing(null)
    }} />}
    {error ? <div className="pro-load-inline" role="alert"><span>{professionalError(error)}</span><Button size="sm" onClick={load}>{p('Try again')}</Button></div>
      : plans === null ? <div className="pro-loading">{p('Loading…')}</div>
        : plans.length === 0 ? <p className="pro-empty-inline">{p('No meal plans yet.')}</p>
          : <div className="nutrition-plan-list">{plans.map(plan => <PlanSummary key={plan.id} plan={plan} adherence={adherence} onEdit={setEditing} onStatus={saveStatus} onDelete={remove} />)}</div>}
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
  const date = today()
  const [plan, setPlan] = useState(null)
  const [loaded, setLoaded] = useState(false)
  const [adherence, setAdherence] = useState(null)
  const [water, setWater] = useState('0')
  const [substitutes, setSubstitutes] = useState(null)
  const [error, setError] = useState(null)
  const [pending, setPending] = useState(() => new Set())
  const adherenceRef = useRef(null)
  const mutationQueueRef = useRef(Promise.resolve())
  const mutationVersionsRef = useRef(new Map())
  const mutationSequenceRef = useRef(0)
  const updateAdherence = useCallback(next => {
    const value = typeof next === 'function' ? next(adherenceRef.current) : next
    adherenceRef.current = value
    setAdherence(value)
    return value
  }, [])
  const load = useCallback(async () => {
    setError(null)
    try {
      const [planResult, adherenceResult] = await Promise.all([api('/api/athlete/meal-plan'), api(`/api/athlete/meal-adherence?date=${date}`)])
      setPlan(planResult.mealPlan || null)
      const current = (adherenceResult.adherenceRecords || [adherenceResult.adherence]).find(item => item?.mealPlanId === planResult.mealPlan?.id) || null
      adherenceRef.current = current; setAdherence(current); setWater(String(current?.waterDrunkMl || 0)); setLoaded(true)
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
    const value = number(water)
    updateAdherence(current => ({
      id: current?.id, athleteId: current?.athleteId, mealPlanId: plan.id, date,
      mealsChecked: current?.mealsChecked || [], waterDrunkMl: value, notes: current?.notes || '', updatedAt: current?.updatedAt,
    }))
    persist('water', { waterDrunkMl: value }, () => { updateAdherence(current => ({ ...current, waterDrunkMl: previous })); setWater(String(previous)) })
  }
  const closeSubstitutes = useCallback(() => setSubstitutes(null), [])
  if (!loaded) return <div className="pro-loading">{p('Loading…')}</div>
  if (error) return <div className="card pro-load-error" role="alert"><p>{professionalError(error)}</p><Button size="sm" onClick={load}>{p('Try again')}</Button></div>
  if (!plan) return <p className="pro-empty-inline">{p('No active meal plan.')}</p>
  const checked = new Set(adherence?.mealsChecked || [])
  return <section className="card athlete-nutrition" aria-labelledby="athlete-nutrition-title">
    <div className="nutrition-editor-head"><div><h3 id="athlete-nutrition-title">{plan.title}</h3><span className="pro-meta">{p('By {0}', plan.coach?.name || p('Unavailable account'))}</span></div><strong>{checked.size}/{plan.meals.length}</strong></div>
    <MacroSummary plan={plan} />
    {plan.notes && <p className="nutrition-notes">{plan.notes}</p>}
    <div className="athlete-meals">{plan.meals.slice().sort((left, right) => left.time.localeCompare(right.time)).map(meal => <article className={`athlete-meal${checked.has(meal.id) ? ' checked' : ''}`} key={meal.id}>
      <div className="athlete-meal-head"><div><time>{meal.time}</time><h4>{meal.name}</h4></div><Button size="sm" disabled={pending.has(`meal:${meal.id}`)} variant={checked.has(meal.id) ? 'primary' : 'plain'} onClick={() => toggleMeal(meal.id)}>{checked.has(meal.id) ? p('Completed') : p('Check in')}</Button></div>
      {meal.items.map(item => <div className="athlete-food" key={item.id}><div><strong>{item.name}</strong><span>{item.portion}</span></div><small>{item.calories} kcal · P {item.protein}g · C {item.carbs}g · G {item.fats}g · F {item.fiber || 0}g</small>
        {item.substitutes.length > 0 && <Button size="sm" onClick={event => setSubstitutes({ item, trigger: event.currentTarget })}>{p('View substitutions')}</Button>}</div>)}
    </article>)}</div>
    <div className="nutrition-water"><div><strong>{p('Water today')}</strong><span>{number(water)} / {plan.targetMacros.waterMl} ml</span></div><progress max={plan.targetMacros.waterMl} value={Math.min(number(water), plan.targetMacros.waterMl)} />
      <div><TextField name="waterDrunkMl" disabled={pending.has('water')} type="number" min="0" max="20000" step="100" value={water} onChange={event => setWater(event.target.value)} /><Button size="sm" variant="primary" disabled={pending.has('water')} onClick={saveWater}>{p('Save water')}</Button></div></div>
    {substitutes && <SubstituteDialog item={substitutes.item} trigger={substitutes.trigger} onClose={closeSubstitutes} />}
  </section>
}
