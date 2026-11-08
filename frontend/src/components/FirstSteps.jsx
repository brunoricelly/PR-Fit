import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Card } from './design-system.jsx'
import Icon from './Icon.jsx'
import {
  FIRST_STEPS_CHANGE_EVENT,
  FIRST_STEPS_STORAGE_KEY,
  getFirstStepsState,
  setFirstStepCompleted,
  setFirstStepsDismissed,
} from '../lib/first-steps-store.js'

export default function FirstSteps({ userId, role, steps }) {
  const navigate = useNavigate()
  const scope = JSON.stringify([String(userId || ''), role])
  const [storedState, setStoredState] = useState(() => ({ scope, value: getFirstStepsState(userId, role) }))
  const resumeRef = useRef(null)
  const headingRef = useRef(null)
  const focusTargetRef = useRef(null)
  const state = storedState.scope === scope ? storedState.value : getFirstStepsState(userId, role)
  const setState = value => setStoredState({ scope, value })

  useEffect(() => { setStoredState({ scope, value: getFirstStepsState(userId, role) }) }, [role, scope, userId])

  useEffect(() => {
    const refresh = event => {
      if (event.type === 'storage' && event.key !== FIRST_STEPS_STORAGE_KEY) return
      if (event.type === FIRST_STEPS_CHANGE_EVENT && event.detail
        && (event.detail.userId !== String(userId) || event.detail.role !== role)) return
      setStoredState({ scope, value: getFirstStepsState(userId, role) })
    }
    window.addEventListener(FIRST_STEPS_CHANGE_EVENT, refresh)
    window.addEventListener('storage', refresh)
    return () => {
      window.removeEventListener(FIRST_STEPS_CHANGE_EVENT, refresh)
      window.removeEventListener('storage', refresh)
    }
  }, [role, scope, userId])

  useEffect(() => {
    if (focusTargetRef.current === 'resume' && state.dismissed) resumeRef.current?.querySelector('button')?.focus()
    if (focusTargetRef.current === 'heading' && !state.dismissed) headingRef.current?.focus()
    focusTargetRef.current = null
  }, [state.dismissed])

  const storedCompleted = useMemo(() => new Set(state.completed), [state.completed])
  const evidenceIds = useMemo(() => steps.filter(step => step.completed).map(step => step.id), [steps])

  useEffect(() => {
    const missing = evidenceIds.filter(id => !storedCompleted.has(id))
    if (!missing.length) return
    let next = state
    for (const id of missing) next = setFirstStepCompleted(userId, role, id)
    setState(next)
  }, [evidenceIds, role, scope, state, storedCompleted, userId])

  if (!userId || !steps.length) return null
  const items = steps.map(step => ({ ...step, done: step.completed || storedCompleted.has(step.id) }))
  const completedCount = items.filter(step => step.done).length
  const incomplete = items.filter(step => !step.done)
  if (!incomplete.length) return null

  const dismiss = () => {
    focusTargetRef.current = 'resume'
    setState(setFirstStepsDismissed(userId, role, true))
  }
  const resume = () => {
    focusTargetRef.current = 'heading'
    setState(setFirstStepsDismissed(userId, role, false))
  }
  const finish = stepId => setState(setFirstStepCompleted(userId, role, stepId))
  const open = step => {
    if (step.completion === 'visit') finish(step.id)
    navigate(step.route)
  }
  const renderStep = step => <li className="first-steps-item" key={step.id}>
    <span className="first-steps-status" aria-hidden="true"><Icon name="target" /></span>
    <div className="first-steps-copy"><h3>{step.title}</h3><p>{step.text}</p></div>
    <div className="first-steps-actions">
      <Button variant="ghost" onClick={() => open(step)}>{step.cta}</Button>
      {step.completion === 'manual' && <Button variant="ghost" onClick={() => finish(step.id)}>Já fiz</Button>}
    </div>
  </li>

  if (state.dismissed) return <aside ref={resumeRef} className="first-steps-resume" aria-label="Primeiros passos pausados">
    <Button variant="ghost" onClick={resume}><Icon name="checkCircle" aria-hidden="true" />Retomar primeiros passos</Button>
  </aside>

  const visible = incomplete.slice(0, 2)
  const remaining = incomplete.slice(2)
  return <Card as="section" className="first-steps-card" aria-labelledby={`first-steps-${role}-title`}>
    <div className="first-steps-header">
      <div>
        <span className="dashboard-kicker">Comece por aqui</span>
        <h2 id={`first-steps-${role}-title`} ref={headingRef} tabIndex={-1}>Primeiros passos</h2>
        <p>{'Você avança no seu ritmo. Este checklist não bloqueia o PR Fit.'}</p>
      </div>
      <Button variant="ghost" onClick={dismiss} aria-label="Fechar primeiros passos">Agora não</Button>
    </div>
    <div className="first-steps-progress" aria-live="polite" aria-atomic="true">
      <span>{completedCount} de {items.length} concluídos</span>
      <progress aria-label="Progresso dos primeiros passos" max={items.length} value={completedCount} />
    </div>
    <ul className="first-steps-list">{visible.map(renderStep)}</ul>
    {remaining.length > 0 && <details className="first-steps-more">
      <summary>Ver mais {remaining.length} {remaining.length === 1 ? 'passo' : 'passos'}</summary>
      <ul className="first-steps-list">{remaining.map(renderStep)}</ul>
    </details>}
  </Card>
}
