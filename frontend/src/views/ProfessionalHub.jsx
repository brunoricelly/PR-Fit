import CommunityHub from './CommunityHub.jsx'
import SchedulingView from './SchedulingView.jsx'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { api } from '../lib/api.js'
import { copyText } from '../lib/clipboard.js'
import { dateLocale } from '../lib/i18n.js'
import { professionalError, professionalText as p } from '../lib/professional-copy.js'
import { confirmSheet } from '../sheets.jsx'
import Icon from '../components/Icon.jsx'
import { Alert, Badge, Button, Field, Input, Modal, EmptyState } from '../components/design-system.jsx'
import { TextArea, TextField } from '../components/ui.jsx'
import AssessmentPanel from './AssessmentPanel.jsx'
import NutritionPanel, { AthleteNutritionView } from './NutritionPanel.jsx'
import { AthleteHabitsDashboard, CoachHabitsPanel, CommunicationPanel, useCommunicationInbox } from './CommunicationHabits.jsx'
import { CoachProgressPanel, AthleteProgressDashboard } from './ProgressAnalytics.jsx'
import './ProfessionalHub.css'

const scopeLabel = scope => scope === 'nutrition' ? p('Nutrition') : scope === 'assessments' ? p('Physical assessments') : p('Training')
const statusLabel = status => ({
  pending: p('Pending'), active: p('Active'), suspended: p('Suspended'), ended: p('Ended'),
}[status] || status)
const statusTone = status => ({
  active: 'success',
  pending: 'warning',
  suspended: 'danger',
  ended: 'neutral',
}[status] || 'neutral')
const handleRovingTabs = event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  const tabs = [...event.currentTarget.parentElement.querySelectorAll('[role="tab"]')].filter(tab => !tab.disabled)
  const current = tabs.indexOf(event.currentTarget)
  if (current < 0 || !tabs.length) return
  event.preventDefault()
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
    : event.key === 'ArrowRight' ? (current + 1) % tabs.length : (current - 1 + tabs.length) % tabs.length
  tabs[next].focus()
  tabs[next].click()
}
const formatDate = value => value ? new Date(value).toLocaleDateString(dateLocale()) : ''
const prescriptionStateLabel = state => ({
  available: p('Available'), adopted: p('Adopted'), withdrawn: p('Withdrawn'),
}[state] || state)
const blankExercise = () => ({ name: '', sets: '3', reps: '8-12', load: '', restSeconds: '60', notes: '' })
const blankRoutine = () => ({
  name: '', notes: '',
  divisions: ['A', 'B', 'C'].map(name => ({ name, exercises: [blankExercise()] })),
})

function PrescriptionSummary({ prescription, action }) {
  return <article className="card pro-prescription" data-state={prescription.state}>
    <div className="pro-link-head">
      <div><h3>{prescription.routine.name}</h3>
        <div className="pro-meta">{p('By {0}', prescription.coach?.name || p('Unavailable account'))} · {formatDate(prescription.createdAt)}</div></div>
      <span className={'pro-status ' + prescription.state}>{prescriptionStateLabel(prescription.state)}</span>
    </div>
    {prescription.routine.notes && <p className="pro-routine-note">{prescription.routine.notes}</p>}
    <p className="pro-adoption-guarantee" style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '8px 0', fontSize: 'var(--fs-footnote)', color: 'var(--label-2)' }}>
      <Icon name="checkCircle" style={{ color: 'var(--green)' }} />
      <span>{p('Your previous workout history remains completely intact.')}</span>
    </p>
    <div className="pro-divisions">{prescription.routine.divisions.map((division, divisionIndex) => <section key={division.id || `${prescription.id}-division-${divisionIndex}`} className="pro-division-summary">
      <h4>{division.name}</h4>
      <div className="pro-exercise-list">{division.exercises.map((exercise, exerciseIndex) => <div key={exercise.id || `${prescription.id}-exercise-${divisionIndex}-${exerciseIndex}`} className="pro-exercise-summary">
        <strong>{exercise.name}</strong>
        <span>{p('{0} sets · {1} reps · {2} rest', exercise.sets, exercise.reps, p('{0}s', exercise.restSeconds))}</span>
        {exercise.load && <span>{p('Load: {0}', exercise.load)}</span>}
        {exercise.notes && <small>{exercise.notes}</small>}
      </div>)}</div>
    </section>)}</div>
    {action && <div className="pro-actions">{action}</div>}
  </article>
}

function ExerciseEditor({ exercise, onChange, onRemove, canRemove, divisionIndex, exerciseIndex, errors = {} }) {
  const field = (key, value) => onChange({ ...exercise, [key]: value })
  const prefix = `${divisionIndex + 1}-${exerciseIndex + 1}`
  const errKey = `${divisionIndex}-${exerciseIndex}`
  return <div className="pro-exercise-editor">
    <div className="pro-editor-head">
      <Badge tone="neutral">{p('Exercise {0}', exerciseIndex + 1)}</Badge>
      {canRemove && <Button size="sm" variant="danger" onClick={onRemove}>{p('Remove exercise')}</Button>}
    </div>
    <Field label={p('Exercise')} required error={errors[`exercise-${errKey}`]}>
      <TextField name={`exercise-${prefix}`} value={exercise.name} maxLength={120}
        placeholder={p('Exercise')} onChange={event => field('name', event.target.value)} />
    </Field>
    <div className="pro-grid-fields">
      <Field label={p('Sets')} required error={errors[`sets-${errKey}`]}>
        <TextField name={`sets-${prefix}`} inputMode="numeric" value={exercise.sets}
          onChange={event => field('sets', event.target.value.replace(/\D/g, '').slice(0, 2))} />
      </Field>
      <Field label={p('Repetitions')} required error={errors[`reps-${errKey}`]}>
        <TextField name={`reps-${prefix}`} value={exercise.reps} maxLength={40}
          placeholder="8-12" onChange={event => field('reps', event.target.value)} />
      </Field>
      <Field label={p('Load')}>
        <TextField name={`load-${prefix}`} value={exercise.load} maxLength={40}
          placeholder={p('Example: 60 kg')} onChange={event => field('load', event.target.value)} />
      </Field>
      <Field label={p('RPE / Intensity')}>
        <TextField name={`rpe-${prefix}`} value={exercise.rpe || ''} maxLength={40}
          placeholder={p('Example: RPE 8, RIR 2')} onChange={event => field('rpe', event.target.value)} />
      </Field>
      <Field label={p('Rest (seconds)')}>
        <TextField name={`rest-${prefix}`} inputMode="numeric" value={exercise.restSeconds}
          onChange={event => field('restSeconds', event.target.value.replace(/\D/g, '').slice(0, 4))} />
      </Field>
    </div>
    <Field label={p('Observations')}>
      <TextArea name={`notes-${prefix}`} rows={2} value={exercise.notes} maxLength={500}
        placeholder={p('Observations')} onChange={event => field('notes', event.target.value)} />
    </Field>
  </div>
}

function RoutineEditor({ athlete, onCreated, onCancel }) {
  const toast = useUI(state => state.toast)
  const [routine, setRoutine] = useState(() => ({
    name: '',
    startDate: '',
    frequency: '3x por semana',
    notes: '',
    divisions: ['A', 'B', 'C'].map(name => ({ name, exercises: [blankExercise()] })),
  }))
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(false)

  const updateDivision = (divisionIndex, next) => setRoutine(current => ({
    ...current,
    divisions: current.divisions.map((division, index) => index === divisionIndex ? next : division),
  }))
  const updateExercise = (divisionIndex, exerciseIndex, next) => {
    const division = routine.divisions[divisionIndex]
    updateDivision(divisionIndex, { ...division, exercises: division.exercises.map((exercise, index) => index === exerciseIndex ? next : exercise) })
  }
  const removeExercise = (divisionIndex, exerciseIndex) => {
    const division = routine.divisions[divisionIndex]
    updateDivision(divisionIndex, { ...division, exercises: division.exercises.filter((_, index) => index !== exerciseIndex) })
  }
  const addExercise = divisionIndex => {
    const division = routine.divisions[divisionIndex]
    updateDivision(divisionIndex, { ...division, exercises: [...division.exercises, blankExercise()] })
  }
  const addDivision = () => {
    const nextChar = String.fromCharCode(65 + routine.divisions.length)
    setRoutine(current => ({
      ...current,
      divisions: [...current.divisions, { name: nextChar, exercises: [blankExercise()] }],
    }))
  }
  const removeDivision = divisionIndex => {
    if (routine.divisions.length <= 1) return
    setRoutine(current => ({
      ...current,
      divisions: current.divisions.filter((_, index) => index !== divisionIndex),
    }))
  }

  const validate = current => {
    const errs = {}
    if (!current.name.trim()) errs.name = p('Routine name is required.')
    current.divisions.forEach((division, dIdx) => {
      if (!division.name.trim()) errs[`division-${dIdx}`] = p('Division name is required.')
      division.exercises.forEach((exercise, eIdx) => {
        const key = `${dIdx}-${eIdx}`
        if (!exercise.name.trim()) errs[`exercise-${key}`] = p('Exercise name is required.')
        const s = Number(exercise.sets)
        if (!Number.isInteger(s) || s < 1 || s > 20) errs[`sets-${key}`] = p('Sets must be between 1 and 20.')
        if (!exercise.reps.trim()) errs[`reps-${key}`] = p('Reps are required.')
      })
    })
    return errs
  }

  const save = async () => {
    const errs = validate(routine)
    setErrors(errs)
    if (Object.keys(errs).length > 0) {
      return toast(p('Complete the routine name and every exercise.'))
    }
    setSaving(true)
    try {
      const metaParts = []
      if (routine.startDate) metaParts.push(`${p('Start date')}: ${routine.startDate}`)
      if (routine.frequency) metaParts.push(`${p('Recommended frequency')}: ${routine.frequency}`)
      const fullNotes = [
        metaParts.length ? `[${metaParts.join(' · ')}]` : '',
        routine.notes.trim(),
      ].filter(Boolean).join('\n')

      const body = {
        routine: {
          name: routine.name.trim(),
          notes: fullNotes.slice(0, 1000),
          divisions: routine.divisions.map(division => ({
            name: division.name.trim(),
            exercises: division.exercises.map(exercise => {
              const notesWithRpe = [
                exercise.rpe ? `[RPE: ${exercise.rpe.trim()}]` : '',
                exercise.notes.trim(),
              ].filter(Boolean).join(' ').slice(0, 500)
              return {
                name: exercise.name.trim(),
                sets: Number(exercise.sets),
                reps: exercise.reps.trim(),
                load: exercise.load.trim(),
                restSeconds: Number(exercise.restSeconds || 0),
                notes: notesWithRpe,
              }
            }),
          })),
        },
      }
      const result = await api(`/api/coach/athletes/${athlete.id}/routines`, { method: 'POST', body: JSON.stringify(body) })
      onCreated(result.routine)
      toast(p('Workout prescription saved.'))
    } catch (error) { toast(professionalError(error)) }
    finally { setSaving(false) }
  }

  return <section className="card pro-routine-editor" aria-label={p('Prescribe workout for {0}', athlete.name)}>
    <div className="pro-editor-title"><div><h3>{p('New workout prescription')}</h3><p>{p('Build the athlete’s A/B/C split with complete exercise guidance.')}</p></div>
      <Button size="sm" onClick={onCancel}>{p('Cancel')}</Button></div>

    {Object.keys(errors).length > 0 && (
      <Alert tone="warning" title={p('Please complete required fields before sending.')} style={{ margin: '10px 0' }} />
    )}

    <div className="pro-prescription-session-fields">
      <Field label={p('Routine name')} required error={errors.name}>
        <TextField name="routineName" value={routine.name} maxLength={120}
          placeholder={p('Example: Hypertrophy ABC')} onChange={event => {
            const val = event.target.value
            setRoutine(current => ({ ...current, name: val }))
            if (errors.name) setErrors(e => ({ ...e, name: undefined }))
          }} />
      </Field>

      <div className="pro-grid-fields">
        <Field label={p('Start date')}>
          <TextField type="date" name="routineStartDate" value={routine.startDate}
            onChange={event => setRoutine(current => ({ ...current, startDate: event.target.value }))} />
        </Field>
        <Field label={p('Recommended frequency')}>
          <TextField name="routineFrequency" value={routine.frequency} maxLength={40}
            placeholder={p('Example: 3x per week')}
            onChange={event => setRoutine(current => ({ ...current, frequency: event.target.value }))} />
        </Field>
      </div>

      <Field label={p('General observations')}>
        <TextArea name="routineNotes" rows={3} value={routine.notes} maxLength={1000}
          onChange={event => setRoutine(current => ({ ...current, notes: event.target.value }))} />
      </Field>
    </div>

    <div className="pro-division-editors">{routine.divisions.map((division, divisionIndex) => <section key={divisionIndex} className="pro-division-editor">
      <div className="pro-division-head">
        <Field label={p('Division')} required error={errors[`division-${divisionIndex}`]} style={{ flex: 1, margin: 0 }}>
          <TextField name={`division-${divisionIndex + 1}`} value={division.name} maxLength={80}
            onChange={event => {
              const val = event.target.value
              updateDivision(divisionIndex, { ...division, name: val })
              if (errors[`division-${divisionIndex}`]) setErrors(e => ({ ...e, [`division-${divisionIndex}`]: undefined }))
            }} />
        </Field>
        {routine.divisions.length > 1 && (
          <Button size="sm" variant="danger" onClick={() => removeDivision(divisionIndex)}>
            {p('Remove division')}
          </Button>
        )}
      </div>

      {division.exercises.map((exercise, exerciseIndex) => <ExerciseEditor key={exerciseIndex} exercise={exercise}
        divisionIndex={divisionIndex} exerciseIndex={exerciseIndex} canRemove={division.exercises.length > 1}
        errors={errors}
        onChange={next => updateExercise(divisionIndex, exerciseIndex, next)} onRemove={() => removeExercise(divisionIndex, exerciseIndex)} />)}

      <Button size="sm" icon="plus" onClick={() => addExercise(divisionIndex)}>{p('Add exercise')}</Button>
    </section>)}</div>

    <div className="pro-editor-footer-actions">
      <Button size="sm" icon="plus" onClick={addDivision}>{p('Add division')}</Button>
      <Button variant="primary" disabled={saving} onClick={save}>{saving ? p('Saving…') : p('Send prescription')}</Button>
    </div>
  </section>
}

function CoachPrescriptionPanel({ link }) {
  const toast = useUI(state => state.toast)
  const [routines, setRoutines] = useState(null)
  const [editing, setEditing] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const load = useCallback(async () => {
    setLoadError(false)
    try {
      const result = await api(`/api/coach/athletes/${link.athlete.id}/routines`)
      setRoutines(result.routines || [])
    } catch { setLoadError(true) }
  }, [link.athlete.id])
  useEffect(() => { load() }, [load])
  const withdraw = prescription => confirmSheet({
    title: p('Withdraw this prescription?'),
    message: p('The athlete will no longer see this routine as available.'),
    confirmText: p('Withdraw prescription'), danger: true,
    onConfirm: async () => {
      try {
        await api(`/api/coach/athletes/${link.athlete.id}/routines/${prescription.id}`, { method: 'DELETE' })
        setRoutines(current => current.filter(item => item.id !== prescription.id))
      } catch (error) { toast(professionalError(error)) }
    },
  })
  return <div className="pro-prescription-panel">
    <div className="pro-panel-head"><strong>{p('Workout prescriptions')}</strong>
      {!editing && <Button size="sm" icon="plus" onClick={() => setEditing(true)}>{p('Prescribe workout')}</Button>}</div>
    {editing && <RoutineEditor athlete={link.athlete} onCancel={() => setEditing(false)} onCreated={created => {
      setRoutines(current => [created, ...(current || [])]); setEditing(false)
    }} />}
    {loadError ? <div className="pro-load-inline" role="alert"><span>{p('Could not load workout prescriptions.')}</span><Button size="sm" onClick={load}>{p('Try again')}</Button></div>
      : routines === null ? <div className="pro-loading">{p('Loading…')}</div>
        : routines.length === 0 ? <p className="pro-empty-inline">{p('No workout prescriptions yet.')}</p>
          : <div className="pro-prescription-list">{routines.map(item => <PrescriptionSummary key={item.id} prescription={item}
            action={<Button size="sm" variant="danger" onClick={() => withdraw(item)}>{p('Withdraw prescription')}</Button>} />)}</div>}
  </div>
}

function Choice({ active, children, onClick }) {
  return <button type="button" className={'pro-choice' + (active ? ' on' : '')} aria-pressed={active} onClick={onClick}>{children}</button>
}

function ScopeChoices({ allowed, value, onChange }) {
  const toggle = scope => onChange(value.includes(scope) ? value.filter(item => item !== scope) : [...value, scope])
  return <div className="pro-choices" role="group" aria-label={p('Authorized scope')}>
    {allowed.map(scope => <Choice key={scope} active={value.includes(scope)} onClick={() => toggle(scope)}>{scopeLabel(scope)}</Choice>)}
  </div>
}

function ProfileSetup({ user }) {
  const setUser = useStore(state => state.setUser)
  const toast = useUI(state => state.toast)
  const current = user.profile?.kind || 'athlete'
  const [kind, setKind] = useState(current)
  const [specialties, setSpecialties] = useState(user.profile?.coachSpecialties || [])
  const [saving, setSaving] = useState(false)
  const dirty = kind !== current || JSON.stringify(specialties) !== JSON.stringify(user.profile?.coachSpecialties || [])

  const chooseKind = next => {
    setKind(next)
    if (next === 'athlete') setSpecialties([])
  }
  const save = async () => {
    if (kind === 'coach' && !specialties.length) return toast(p('Choose at least one specialty.'))
    setSaving(true)
    try {
      const result = await api('/api/profile', {
        method: 'POST',
        body: JSON.stringify({ kind, coachSpecialties: kind === 'coach' ? specialties : [] }),
      })
      setUser(result.user)
      toast(p('Profile saved.'))
    } catch (error) { toast(professionalError(error)) }
    finally { setSaving(false) }
  }

  return <section className="card pro-profile" aria-labelledby="pro-profile-title">
    <div className="card-head">
      <span className="card-head-g"><Icon name="personCircle" /></span>
      <div className="card-head-copy"><div className="card-head-title" id="pro-profile-title">{p('How do you use PR Fit?')}</div>
        <div className="card-head-sub">{p('This choice never grants platform administration.')}</div></div>
    </div>
    <div className="pro-choices" role="group" aria-label={p('Profile type')}>
      <Choice active={kind === 'athlete'} onClick={() => chooseKind('athlete')}>{p('Athlete')}</Choice>
      <Choice active={kind === 'coach'} onClick={() => chooseKind('coach')}>{p('Professional')}</Choice>
    </div>
    {kind === 'coach' && <>
      <p className="pro-trust-note">{p('This professional profile is self-declared and is not verified by PR Fit.')}</p>
      <div className="pro-label">{p('Specialties')}</div>
      <ScopeChoices allowed={['training', 'nutrition', 'assessments']} value={specialties} onChange={setSpecialties} />
    </>}
    {(!user.profile || dirty) && <Button variant="primary" disabled={saving} onClick={save}>{saving ? p('Saving…') : p('Save profile')}</Button>}
  </section>
}

function RelationshipCard({ link, side, onStatus, canSuspend, canEnd, children }) {
  const person = side === 'coach' ? link.athlete : link.coach
  const title = person?.name || (link.status === 'pending' ? p('Invitation pending') : p('Unavailable account'))
  const tone = statusTone(link.status)

  return <article className="card pro-link" data-status={link.status}>
    <div className="pro-link-head">
      <div>
        <h2>{title}</h2>
        <div className="pro-scopes-badges">
          {link.scopes.map(scope => <Badge key={scope} tone="info">{scopeLabel(scope)}</Badge>)}
        </div>
      </div>
      <Badge tone={tone} className={`pro-status-badge pro-status ${link.status}`}>{statusLabel(link.status)}</Badge>
    </div>
    {link.status === 'pending' && side === 'coach' && (
      <p className="dim small" style={{ margin: '8px 0 0' }}>{p('Waiting for athlete to accept invitation.')}</p>
    )}
    {link.status === 'suspended' && (
      <p className="dim small" style={{ margin: '8px 0 0', color: 'var(--ds-state-danger, var(--red))' }}>
        {p('Relationship is suspended. Professional access is temporarily paused.')}
      </p>
    )}
    <div className="pro-dates">
      {link.acceptedAt && <span>{p('Accepted {0}', formatDate(link.acceptedAt))}</span>}
      {link.expiresAt && link.status === 'pending' && <span>{p('Expires {0}', formatDate(link.expiresAt))}</span>}
      {link.endedAt && <span>{p('Ended {0}', formatDate(link.endedAt))}</span>}
    </div>
    {(canSuspend || canEnd) && <div className="pro-actions">
      {canSuspend && <Button size="sm" onClick={() => onStatus(link, 'suspended')} style={{ minHeight: '44px' }}>{p('Suspend')}</Button>}
      {canEnd && <Button size="sm" variant="danger" onClick={() => onStatus(link, 'ended')} style={{ minHeight: '44px' }}>{link.status === 'pending' ? p('Cancel invitation') : p('End relationship')}</Button>}
    </div>}
    {children}
  </article>
}

function CoachPortfolio({ user, inbox, onSchedule }) {
  const toast = useUI(state => state.toast)
  const navigate = useNavigate()
  const [links, setLinks] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [scopes, setScopes] = useState(() => user.profile.coachSpecialties.slice(0, 1))
  const [creating, setCreating] = useState(false)
  const [freshInvite, setFreshInvite] = useState(null)
  const [copiedLink, setCopiedLink] = useState(false)
  const [copiedCode, setCopiedCode] = useState(false)
  const [liveMessage, setLiveMessage] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [confirmModal, setConfirmModal] = useState(null)
  const capabilities = new Set(user.capabilities || [])
  const canInvite = capabilities.has('relationships:invite')

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(false)
    try {
      const result = await api('/api/coach/athletes')
      setLinks(result.links || [])
    } catch {
      setLoadError(true)
    } finally {
      setLoading(false)
    }
  }, [user.id])
  useEffect(() => {
    load()
    const online = () => load()
    window.addEventListener('online', online)
    return () => window.removeEventListener('online', online)
  }, [load])

  const createInvite = async () => {
    if (!scopes.length) return toast(p('Choose at least one scope.'))
    setCreating(true)
    try {
      const result = await api('/api/coach/invites', { method: 'POST', body: JSON.stringify({ scopes, expiresInDays: 7 }) })
      setFreshInvite(result.invite)
      setCopiedLink(false)
      setCopiedCode(false)
      const msg = p('New invitation created. Share the code or link with your athlete.')
      setLiveMessage(msg)
      toast(msg)
      await load()
    } catch (error) { toast(professionalError(error)) }
    finally { setCreating(false) }
  }

  const copyInvite = async () => {
    if (!freshInvite) return
    if (await copyText(freshInvite.token)) {
      setCopiedCode(true)
      setTimeout(() => setCopiedCode(false), 2500)
      setLiveMessage(p('Invite code copied to clipboard.'))
      toast(p('Invitation copied.'))
    }
  }

  const copyInviteLink = async () => {
    if (!freshInvite) return
    const origin = typeof window !== 'undefined' ? window.location.origin : ''
    const linkUrl = `${origin}/professionals?invite=${freshInvite.token}&coach=${encodeURIComponent(user.name || '')}&scopes=${freshInvite.scopes.join(',')}`
    if (await copyText(linkUrl)) {
      setCopiedLink(true)
      setTimeout(() => setCopiedLink(false), 2500)
      setLiveMessage(p('Invite link copied to clipboard.'))
      toast(p('Invitation link copied.'))
    }
  }

  const status = (link, next) => {
    const isCancelInvite = link.status === 'pending' && next === 'ended'
    const isEnd = next === 'ended'
    const title = isCancelInvite
      ? p('Cancel pending invitation?')
      : isEnd
        ? p('End this relationship?')
        : p('Suspend this relationship?')
    const message = isCancelInvite
      ? p('The generated invitation code will be invalidated and the athlete will no longer be able to accept it.')
      : isEnd
        ? p('Future professional access is blocked. The athlete keeps their training data.')
        : p('Professional access is blocked until a future reactivation flow.')
    const confirmText = isCancelInvite
      ? p('Cancel invitation')
      : isEnd
        ? p('End relationship')
        : p('Suspend')
    const destructiveNote = isEnd && !isCancelInvite
      ? p('This action is irreversible. The athlete retains all workouts, nutrition and progress data.')
      : undefined

    const execute = async () => {
      try {
        const result = await api('/api/coach/links/status', { method: 'POST', body: JSON.stringify({ linkId: link.id, status: next }) })
        setLinks(current => current.map(item => item.id === link.id ? { ...item, ...result.link } : item))
        toast(isCancelInvite ? p('Invitation cancelled.') : isEnd ? p('Relationship ended.') : p('Relationship suspended.'))
      } catch (error) { toast(professionalError(error)) }
    }

    setConfirmModal({
      title,
      message,
      destructiveNote,
      confirmText,
      danger: isEnd,
      onConfirm: execute,
    })

    confirmSheet?.({
      title,
      message,
      confirmText,
      danger: isEnd,
      onConfirm: execute,
    })
  }

  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const freshInviteLink = freshInvite ? `${origin}/professionals?invite=${freshInvite.token}&coach=${encodeURIComponent(user.name || '')}&scopes=${freshInvite.scopes.join(',')}` : ''

  const filteredLinks = useMemo(() => {
    if (!links) return null
    if (statusFilter === 'all') return links
    return links.filter(item => item.status === statusFilter)
  }, [links, statusFilter])

  const counts = useMemo(() => {
    if (!links) return { all: 0, active: 0, pending: 0, suspended: 0 }
    return {
      all: links.length,
      active: links.filter(l => l.status === 'active').length,
      pending: links.filter(l => l.status === 'pending').length,
      suspended: links.filter(l => l.status === 'suspended').length,
    }
  }, [links])

  return <>
    {canInvite && <section className="card pro-invite" aria-labelledby="pro-invite-title">
      <h2 id="pro-invite-title">{p('Invite an athlete')}</h2>
      <p>{p('Choose what this relationship authorizes. The athlete must accept explicitly.')}</p>
      <ScopeChoices allowed={user.profile.coachSpecialties} value={scopes} onChange={setScopes} />
      <div className="pro-scope-descriptions" style={{ margin: '8px 0 14px', display: 'grid', gap: '6px' }}>
        {scopes.includes('training') && (
          <div className="dim small" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <Icon name="dumbbell" style={{ color: 'var(--acc)' }} />
            <span><strong>{p('Training')}:</strong> {p('Prescribe workouts, routines, sets, reps and monitor training habits.')}</span>
          </div>
        )}
        {scopes.includes('nutrition') && (
          <div className="dim small" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <Icon name="apple" style={{ color: 'var(--green)' }} />
            <span><strong>{p('Nutrition')}:</strong> {p('Prescribe meal plans, caloric and macronutrient targets, and track meal adherence.')}</span>
          </div>
        )}
        {scopes.includes('assessments') && (
          <div className="dim small" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <Icon name="shield" style={{ color: 'var(--orange)' }} />
            <span><strong>{p('Physical assessments')}:</strong> {p('Track body weight, circumferences, skinfolds and physical evolution.')}</span>
          </div>
        )}
      </div>
      <Button variant="primary" disabled={creating || !scopes.length} onClick={createInvite} style={{ minHeight: '44px' }}>
        {creating ? p('Creating…') : p('Create invitation')}
      </Button>

      {freshInvite && <div className="pro-token" role="region" aria-label={p('Invitation ready to share')}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 8 }}>
          <div>
            <strong>{p('Invitation ready to share')}</strong>
            <span style={{ display: 'block', fontSize: 'var(--fs-footnote)', color: 'var(--label-2)' }}>
              {p('It expires {0}.', formatDate(freshInvite.expiresAt))}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {freshInvite.scopes.map(s => <Badge key={s} tone="info">{scopeLabel(s)}</Badge>)}
          </div>
        </div>

        <div className="pro-token-copy-row">
          <div>
            <label className="pro-label" style={{ marginBottom: 4 }}>{p('Invitation link')}</label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <Input
                readOnly
                value={freshInviteLink}
                style={{ flex: '1 1 200px', minHeight: '44px' }}
                aria-label={p('Invitation link')}
              />
              <Button
                size="sm"
                icon={copiedLink ? 'check' : 'copy'}
                onClick={copyInviteLink}
                style={{ minHeight: '44px', minWidth: '44px' }}
              >
                {copiedLink ? p('Link copied!') : p('Copy link')}
              </Button>
            </div>
          </div>

          <div>
            <label className="pro-label" style={{ marginBottom: 4 }}>{p('Invitation code')}</label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <code style={{ flex: '1 1 200px', padding: '10px 12px', background: 'var(--surface)', borderRadius: 'var(--r-xs)', wordBreak: 'break-all', minHeight: '44px', display: 'flex', alignItems: 'center' }}>
                {freshInvite.token}
              </code>
              <Button
                size="sm"
                icon={copiedCode ? 'check' : 'copy'}
                onClick={copyInvite}
                style={{ minHeight: '44px', minWidth: '44px' }}
              >
                {copiedCode ? p('Code copied!') : p('Copy invitation')}
              </Button>
            </div>
          </div>
        </div>

        <div className="sr-only" aria-live="polite" role="status">
          {liveMessage}
        </div>
      </div>}
    </section>}

    <section aria-labelledby="pro-coach-list-title">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, margin: '22px 4px 10px' }}>
        <h2 className="pro-section-title" id="pro-coach-list-title" style={{ margin: 0 }}>{p('Portfolio')}</h2>
      </div>

      {links && links.length > 0 && (
        <div className="pro-status-filter" role="group" aria-label={p('Filter by status')}>
          <button type="button" className={'pro-choice' + (statusFilter === 'all' ? ' on' : '')} aria-pressed={statusFilter === 'all'} onClick={() => setStatusFilter('all')}>
            {p('All athletes')} ({counts.all})
          </button>
          <button type="button" className={'pro-choice' + (statusFilter === 'active' ? ' on' : '')} aria-pressed={statusFilter === 'active'} onClick={() => setStatusFilter('active')}>
            {p('Active')} ({counts.active})
          </button>
          <button type="button" className={'pro-choice' + (statusFilter === 'pending' ? ' on' : '')} aria-pressed={statusFilter === 'pending'} onClick={() => setStatusFilter('pending')}>
            {p('Pending')} ({counts.pending})
          </button>
          {counts.suspended > 0 && (
            <button type="button" className={'pro-choice' + (statusFilter === 'suspended' ? ' on' : '')} aria-pressed={statusFilter === 'suspended'} onClick={() => setStatusFilter('suspended')}>
              {p('Suspended')} ({counts.suspended})
            </button>
          )}
        </div>
      )}

      {loading && links === null ? <div className="pro-loading">{p('Loading…')}</div>
        : loadError ? <div className="card pro-load-error" role="alert"><p>{p('Could not load your professional relationships.')}</p><Button size="sm" onClick={load}>{p('Try again')}</Button></div>
        : links.length === 0 ? <EmptyState icon="person" title={p('No athletes yet')} text={p('Create an invitation to start your portfolio.')} />
          : filteredLinks.length === 0 ? <p className="pro-empty-inline" style={{ padding: '16px 0' }}>{p('No athletes match the selected filter.')}</p>
            : <div className="pro-list">{filteredLinks.map(link => <RelationshipCard key={link.id} link={link} side="coach" onStatus={status}
              canSuspend={link.status === 'active' && capabilities.has('relationships:suspend')}
              canEnd={link.status !== 'ended' && capabilities.has('relationships:end')}>
              {link.status === 'active' && link.scopes.includes('training') && link.athlete && <CoachPrescriptionPanel link={link} />}
              {link.status === 'active' && link.scopes.includes('nutrition') && link.athlete && <NutritionPanel athleteId={link.athlete.id} />}
              {link.status === 'active' && link.scopes.includes('assessments') && link.athlete && <AssessmentPanel athleteId={link.athlete.id} />}
              <CommunicationPanel link={link} side="coach" actorId={user.id} conversation={inbox.byLink.get(link.id)} onConversationChange={inbox.update} />
              {link.scopes.includes('training') && <CoachHabitsPanel link={link} />}
              {link.athlete && <CoachProgressPanel link={link} athleteId={link.athlete.id} />}
              {link.status === 'active' && link.athlete && <div className="pro-actions"><Button size="sm" onClick={() => onSchedule ? onSchedule(link.athlete.id) : navigate('/scheduling?athleteId=' + link.athlete.id)}>{p('Schedule session')}</Button></div>}
            </RelationshipCard>)}</div>}
    </section>

    {confirmModal && (
      <Modal
        id="coach-relationship-confirm"
        title={confirmModal.title}
        closeLabel={p('Close')}
        onClose={() => setConfirmModal(null)}
      >
        <div className="pro-modal-form">
          <p style={{ margin: '0 0 12px', lineHeight: 1.5 }}>{confirmModal.message}</p>
          {confirmModal.destructiveNote && (
            <Alert tone="error" style={{ marginBottom: 14 }}>
              {confirmModal.destructiveNote}
            </Alert>
          )}
          <div className="pro-actions" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
            <Button type="button" onClick={() => setConfirmModal(null)} style={{ minHeight: '44px' }}>
              {p('Cancel')}
            </Button>
            <Button
              type="button"
              variant={confirmModal.danger ? 'danger' : 'primary'}
              onClick={async () => {
                const action = confirmModal.onConfirm
                setConfirmModal(null)
                await action?.()
              }}
              style={{ minHeight: '44px' }}
            >
              {confirmModal.confirmText}
            </Button>
          </div>
        </div>
      </Modal>
    )}
  </>
}

function CoachNutritionWorkspace({ user }) {
  const [links, setLinks] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [selectedAthleteId, setSelectedAthleteId] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(false)
    try {
      const result = await api('/api/coach/athletes')
      const activeNutritionLinks = (result.links || []).filter(
        link => link.status === 'active' && link.scopes.includes('nutrition') && link.athlete
      )
      setLinks(activeNutritionLinks)
      setSelectedAthleteId(current => activeNutritionLinks.some(link => link.athlete.id === current)
        ? current : activeNutritionLinks[0]?.athlete.id || null)
    } catch {
      setLoadError(true)
    } finally {
      setLoading(false)
    }
  }, [user?.id])

  useEffect(() => { load() }, [load])

  if (loading && links === null) return <div className="pro-loading">{p('Loading…')}</div>
  if (loadError) return (
    <div className="card pro-load-error" role="alert">
      <p>{p('Could not load your professional relationships.')}</p>
      <Button size="sm" onClick={load}>{p('Try again')}</Button>
    </div>
  )
  if (!links || links.length === 0) return (
    <EmptyState
      icon="scale"
      title={p('No nutrition athletes yet')}
      text={p('Connect with athletes and enable the nutrition scope to prescribe meal plans.')}
    />
  )

  const selectedLink = links.find(l => l.athlete.id === selectedAthleteId) || links[0]

  return (
    <section className="coach-nutrition-workspace" aria-labelledby="coach-nutrition-title">
      <header className="pro-panel-head">
        <h2 id="coach-nutrition-title" className="pro-section-title">{p('Nutrition prescription workspace')}</h2>
      </header>
      {links.length > 1 && (
        <div className="pro-athlete-selector" role="tablist" aria-label={p('Nutrition athletes')}>
          {links.map(link => {
            const selected = link.athlete.id === selectedLink.athlete.id
            const tabId = `nutrition-athlete-tab-${link.athlete.id}`
            const panelId = `nutrition-athlete-panel-${link.athlete.id}`
            return (
              <button
                key={link.id}
                id={tabId}
                role="tab"
                aria-selected={selected}
                aria-controls={panelId}
                tabIndex={selected ? 0 : -1}
                className={`pro-sched-tab ${selected ? 'active' : ''}`}
                onClick={() => setSelectedAthleteId(link.athlete.id)}
                onKeyDown={handleRovingTabs}
              >
                <Icon name="person" />
                <span>{link.athlete.name}</span>
              </button>
            )
          })}
        </div>
      )}
      <div
        key={selectedLink.athlete.id}
        className="pro-athlete-active-nutrition"
        id={`nutrition-athlete-panel-${selectedLink.athlete.id}`}
        role="tabpanel"
        aria-labelledby={links.length > 1 ? `nutrition-athlete-tab-${selectedLink.athlete.id}` : undefined}
      >
        <div className="athlete-card-head" style={{ marginBottom: 12 }}>
          <h3>{selectedLink.athlete.name}</h3>
          <span className="pro-meta">{selectedLink.athlete.email || ''}</span>
        </div>
        <NutritionPanel athleteId={selectedLink.athlete.id} />
      </div>
    </section>
  )
}

function AthletePrescriptions({ userId }) {
  const toast = useUI(state => state.toast)
  const pullState = useStore(state => state.pullState)
  const [prescriptions, setPrescriptions] = useState(null)
  const [loadError, setLoadError] = useState(false)
  const [adopting, setAdopting] = useState(null)
  const load = useCallback(async () => {
    setLoadError(false)
    try {
      const result = await api('/api/athlete/prescriptions')
      setPrescriptions(result.prescriptions || [])
    } catch { setLoadError(true) }
  }, [userId])
  useEffect(() => { load() }, [load])
  const adopt = async prescription => {
    setAdopting(prescription.id)
    try {
      const result = await api(`/api/athlete/prescriptions/${prescription.id}/adopt`, { method: 'POST', body: '{}' })
      setPrescriptions(current => current.map(item => item.id === prescription.id ? result.prescription : item))
      await pullState()
      toast(p('Added to your routines.'))
    } catch (error) { toast(professionalError(error)) }
    finally { setAdopting(null) }
  }
  return <section aria-labelledby="pro-prescriptions-title">
    <h2 className="pro-section-title" id="pro-prescriptions-title">{p('Workout prescriptions')}</h2>
    {loadError ? <div className="card pro-load-error" role="alert"><p>{p('Could not load workout prescriptions.')}</p><Button size="sm" onClick={load}>{p('Try again')}</Button></div>
      : prescriptions === null ? <div className="pro-loading">{p('Loading…')}</div>
        : prescriptions.length === 0 ? <EmptyState icon="dumbbell" title={p('No workout prescriptions')} text={p('Training prescriptions from linked professionals appear here.')} />
          : <div className="pro-prescription-list">{prescriptions.map(item => <PrescriptionSummary key={item.id} prescription={item}
            action={item.state === 'available' || !item.adoptedRoutineIds?.length
              ? <Button variant="primary" disabled={adopting === item.id} onClick={() => adopt(item)}>{adopting === item.id ? p('Adding…') : p('Add to my routines')}</Button>
              : null} />)}</div>}
  </section>
}

function AthleteProfessionals({ initialInvite, initialToken, userId, inbox, embedded = false, onSchedule }) {
  const toast = useUI(state => state.toast)
  const navigate = useNavigate()
  const tokenFromProps = typeof initialInvite === 'object' ? (initialInvite?.invite || '') : (initialToken || '')
  const coachFromProps = typeof initialInvite === 'object' ? (initialInvite?.coach || '') : ''
  const scopesFromProps = typeof initialInvite === 'object' ? (initialInvite?.scopes || null) : null

  const [links, setLinks] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [token, setToken] = useState(tokenFromProps)
  const [coachName, setCoachName] = useState(coachFromProps)
  const [requestedScopes, setRequestedScopes] = useState(scopesFromProps)
  const [accepting, setAccepting] = useState(false)
  const [acceptError, setAcceptError] = useState(null)
  const [liveStatus, setLiveStatus] = useState('')
  const [confirmModal, setConfirmModal] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(false)
    try {
      const result = await api('/api/athlete/coaches')
      setLinks(result.links || [])
    } catch {
      setLoadError(true)
    } finally {
      setLoading(false)
    }
  }, [userId])
  useEffect(() => {
    load()
    const online = () => load()
    window.addEventListener('online', online)
    return () => window.removeEventListener('online', online)
  }, [load])

  const accept = async () => {
    if (!token.trim()) return
    setAccepting(true)
    setAcceptError(null)
    try {
      await api('/api/coach/invites/accept', { method: 'POST', body: JSON.stringify({ token: token.trim() }) })
      setToken('')
      setCoachName('')
      setRequestedScopes(null)
      const msg = p('Invitation accepted.')
      setLiveStatus(msg)
      toast(msg)
      await load()
    } catch (error) {
      const msg = professionalError(error)
      setAcceptError(msg)
      setLiveStatus(msg)
      toast(msg)
    } finally {
      setAccepting(false)
    }
  }

  const declineInvite = () => {
    setToken('')
    setCoachName('')
    setRequestedScopes(null)
    setAcceptError(null)
    const msg = p('Invitation declined. No data was shared.')
    setLiveStatus(msg)
    toast(msg)
  }

  const end = link => {
    const title = p('End this relationship?')
    const message = p('The professional loses future access. Your training data stays with you.')
    const confirmText = p('End relationship')
    const destructiveNote = p('This action will immediately stop data sharing. Your logged workouts, meals and history remain safely in your account.')

    const execute = async () => {
      try {
        const result = await api('/api/coach/links/status', { method: 'POST', body: JSON.stringify({ linkId: link.id, status: 'ended' }) })
        setLinks(current => current.map(item => item.id === link.id ? { ...item, ...result.link } : item))
        toast(p('Relationship ended.'))
      } catch (error) { toast(professionalError(error)) }
    }

    setConfirmModal({
      title,
      message,
      destructiveNote,
      confirmText,
      danger: true,
      onConfirm: execute,
    })

    confirmSheet?.({
      title,
      message,
      confirmText,
      danger: true,
      onConfirm: execute,
    })
  }

  const assessmentConsent = async (link, granted) => {
    try {
      const result = await api(`/api/athlete/coaches/${link.id}/assessment-consent`, { method: 'POST', body: JSON.stringify({ granted }) })
      setLinks(current => current.map(item => item.id === link.id ? { ...item, ...result.link } : item))
      toast(granted ? p('Physical assessment consent granted.') : p('Physical assessment consent revoked.'))
    } catch (error) { toast(professionalError(error)) }
  }

  return <>
    {embedded && <h2 className="pro-section-title">{p('My professionals')}</h2>}
    <section className="card pro-schedule-shortcut" aria-labelledby="athlete-schedule-shortcut-title">
      <div className="pro-panel-head">
        <div>
          <h3 id="athlete-schedule-shortcut-title" style={{ margin: 0 }}>{p('Appointments and calendar')}</h3>
          <p className="dim small" style={{ margin: '4px 0 0' }}>{p('Book and manage your sessions with linked professionals.')}</p>
        </div>
        <Button size="sm" variant="primary" onClick={() => onSchedule ? onSchedule() : navigate('/scheduling')}>
          {p('Schedule session')}
        </Button>
      </div>
    </section>

    <section className="card pro-accept" aria-labelledby="pro-accept-title">
      <h2 id="pro-accept-title">{p('Accept an invitation')}</h2>
      <p>{p('Opening an invitation never grants access by itself. Review it and accept here.')}</p>

      {token.trim() && (
        <div className="pro-accept-context">
          {coachName ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <span style={{ fontSize: 24, color: 'var(--acc)' }}><Icon name="personCircle" /></span>
              <div>
                <div style={{ fontWeight: 600, fontSize: 'var(--fs-subhead)' }}>
                  {p('Professional {0} invited you to connect on PR Fit.', coachName)}
                </div>
                <span className="dim small">{p('Professional profile')}</span>
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <span style={{ fontSize: 24, color: 'var(--acc)' }}><Icon name="shield" /></span>
              <div style={{ fontWeight: 600, fontSize: 'var(--fs-subhead)' }}>
                {p('Connect your profile with a certified coach or nutritionist.')}
              </div>
            </div>
          )}

          <div className="pro-scope-explainer" style={{ display: 'grid', gap: 10, marginTop: 10 }}>
            <strong style={{ fontSize: 'var(--fs-footnote)', color: 'var(--label-2)' }}>
              {p('Data and access requested by professional:')}
            </strong>
            {(!requestedScopes || requestedScopes.includes('training')) && (
              <div className="pro-scope-item">
                <Icon name="dumbbell" style={{ color: 'var(--acc)' }} />
                <div>
                  <strong>{p('Workouts & routines')}: </strong>
                  <span className="dim small">{p('Your coach will be able to prescribe workouts, adjust routines, and view your exercise logs.')}</span>
                </div>
              </div>
            )}
            {(!requestedScopes || requestedScopes.includes('nutrition')) && (
              <div className="pro-scope-item">
                <Icon name="apple" style={{ color: 'var(--green)' }} />
                <div>
                  <strong>{p('Nutrition & meal plans')}: </strong>
                  <span className="dim small">{p('Your nutritionist will be able to prescribe meal plans, set macro goals, and monitor meal adherence.')}</span>
                </div>
              </div>
            )}
            {(!requestedScopes || requestedScopes.includes('assessments')) && (
              <div className="pro-scope-item">
                <Icon name="shield" style={{ color: 'var(--orange)' }} />
                <div>
                  <strong>{p('Physical assessments & measurements')}: </strong>
                  <span className="dim small">{p('Body measurements and progress photos require explicit athlete consent before sharing.')}</span>
                </div>
              </div>
            )}
            <p className="dim small" style={{ margin: '8px 0 0', fontStyle: 'italic' }}>
              {p('Your account credentials, password, and personal email are never shared. You can revoke access at any time.')}
            </p>
          </div>
        </div>
      )}

      <Field label={p('Invitation code')} help={p('Review the code received from your coach or nutritionist.')} error={acceptError || undefined}>
        <Input
          name="inviteToken"
          value={token}
          onChange={event => {
            setToken(event.target.value)
            setAcceptError(null)
          }}
          placeholder={p('Paste the invitation code here')}
          autoComplete="off"
          spellCheck="false"
          style={{ minHeight: '44px' }}
        />
      </Field>

      {acceptError && (
        <Alert tone="error" title={p('Unable to accept invitation')} style={{ marginTop: 12 }}>
          {acceptError}
        </Alert>
      )}

      <div className="pro-actions" style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        <Button
          variant="primary"
          disabled={accepting || !token.trim()}
          onClick={accept}
          style={{ minHeight: '44px' }}
        >
          {accepting ? p('Accepting…') : p('Accept invitation')}
        </Button>
        {token.trim() && (
          <Button
            variant="secondary"
            disabled={accepting}
            onClick={declineInvite}
            style={{ minHeight: '44px' }}
          >
            {p('Decline invitation')}
          </Button>
        )}
      </div>

      <div className="sr-only" aria-live="polite" role="status">
        {liveStatus}
      </div>
    </section>

    <AthletePrescriptions userId={userId} />
    <section aria-labelledby="athlete-nutrition-section"><h2 className="pro-section-title" id="athlete-nutrition-section">{p('My nutrition')}</h2><AthleteNutritionView /></section>
    <section aria-labelledby="athlete-assessments-title"><h2 className="pro-section-title" id="athlete-assessments-title">{p('My physical assessments')}</h2><AssessmentPanel athlete /></section>
    {links && <AthleteHabitsDashboard links={links} />}
    {links && <section aria-labelledby="athlete-progress-section"><h2 className="pro-section-title" id="athlete-progress-section">{p('My progress')}</h2><AthleteProgressDashboard links={links} /></section>}
    <section aria-labelledby="pro-athlete-list-title">
      <h2 className="pro-section-title" id="pro-athlete-list-title">{p('Linked professionals')}</h2>
      {loading && links === null ? <div className="pro-loading">{p('Loading…')}</div>
        : loadError ? <div className="card pro-load-error" role="alert"><p>{p('Could not load your professional relationships.')}</p><Button size="sm" onClick={load}>{p('Try again')}</Button></div>
        : links.length === 0 ? <EmptyState icon="personCircle" title={p('No linked professionals')} text={p('When you accept an invitation, the professional and authorized scope appear here.')} />
          : <div className="pro-list">{links.map(link => <RelationshipCard key={link.id} link={link} side="athlete" onStatus={end}
            canSuspend={false} canEnd={link.status !== 'ended'}>
            {link.status === 'active' && link.coach?.profile?.coachSpecialties?.includes('assessments') && <div className="pro-actions">
              <Button size="sm" variant={link.scopes.includes('assessments') ? 'danger' : 'primary'} onClick={() => assessmentConsent(link, !link.scopes.includes('assessments'))}>
                {link.scopes.includes('assessments') ? p('Revoke assessment consent') : p('Grant assessment consent')}
              </Button>
            </div>}
            <CommunicationPanel link={link} side="athlete" actorId={userId} conversation={inbox.byLink.get(link.id)} onConversationChange={inbox.update} />
          </RelationshipCard>)}</div>}
    </section>

    {confirmModal && (
      <Modal
        id="athlete-relationship-confirm"
        title={confirmModal.title}
        closeLabel={p('Close')}
        onClose={() => setConfirmModal(null)}
      >
        <div className="pro-modal-form">
          <p style={{ margin: '0 0 12px', lineHeight: 1.5 }}>{confirmModal.message}</p>
          {confirmModal.destructiveNote && (
            <Alert tone="error" style={{ marginBottom: 14 }}>
              {confirmModal.destructiveNote}
            </Alert>
          )}
          <div className="pro-actions" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
            <Button type="button" onClick={() => setConfirmModal(null)} style={{ minHeight: '44px' }}>
              {p('Cancel')}
            </Button>
            <Button
              type="button"
              variant="danger"
              onClick={async () => {
                const action = confirmModal.onConfirm
                setConfirmModal(null)
                await action?.()
              }}
              style={{ minHeight: '44px' }}
            >
              {confirmModal.confirmText}
            </Button>
          </div>
        </div>
      </Modal>
    )}
  </>
}

export default function ProfessionalHub() {
  const user = useStore(state => state.user)
  const location = useLocation()
  const navigate = useNavigate()
  const inbox = useCommunicationInbox(user?.id)
  const initialParams = useMemo(() => {
    const params = new URLSearchParams(location.search)
    return {
      invite: params.get('invite') || '',
      coach: params.get('coach') || '',
      scopes: params.get('scopes') ? params.get('scopes').split(',').map(s => s.trim()).filter(Boolean) : null,
    }
  }, [])
  useEffect(() => {
    if (initialParams.invite && location.search) navigate('/professionals', { replace: true })
  }, [initialParams.invite, location.search, navigate])
  const [tab, setTab] = useState(() => new URLSearchParams(location.search).get('tab') || 'relationships')
  if (!user) return null
  const coach = user.profile?.kind === 'coach'
  const hasNutrition = coach && (user?.profile?.coachSpecialties?.includes('nutrition') || user?.coachSpecialties?.includes('nutrition'))
  return <main className="narrow pro-page">
    <div className="pro-nav"><button data-back="/settings" onClick={() => navigate('/settings')}><Icon name="chevronLeft" />{p('Settings')}</button></div>
    <header className="pro-hero"><div><span className="pro-kicker">{p('Professional relationships')}</span>
      <h1>{coach ? p('My athletes') : p('My professionals')}</h1>
      <p>{coach ? p('Access depends on an accepted relationship and its authorized scope.') : p('You control which professionals are linked to your account.')}</p></div>
      <Icon name={coach ? 'person' : 'shield'} />
    </header>
    <ProfileSetup user={user} />
    <nav className="pro-sched-nav" role="tablist" style={{ marginTop: 12 }}>
      <button
        id="professional-tab-relationships"
        role="tab"
        aria-selected={tab === 'relationships'}
        aria-controls="professional-panel-relationships"
        tabIndex={tab === 'relationships' ? 0 : -1}
        className={"pro-sched-tab " + (tab === 'relationships' ? 'active' : '')}
        onClick={() => setTab('relationships')}
        onKeyDown={handleRovingTabs}
      >
        <Icon name="person" />
        <span>{p('Relationships')}</span>
      </button>
      <button
        id="professional-tab-scheduling"
        role="tab"
        aria-selected={tab === 'scheduling'}
        aria-controls="professional-panel-scheduling"
        tabIndex={tab === 'scheduling' ? 0 : -1}
        className={"pro-sched-tab " + (tab === 'scheduling' ? 'active' : '')}
        onClick={() => setTab('scheduling')}
        onKeyDown={handleRovingTabs}
      >
        <Icon name="calendar" />
        <span>{p('Appointments')}</span>
      </button>
      <button
        id="professional-tab-community"
        role="tab"
        aria-selected={tab === 'community'}
        aria-controls="professional-panel-community"
        tabIndex={tab === 'community' ? 0 : -1}
        className={"pro-sched-tab " + (tab === 'community' ? 'active' : '')}
        onClick={() => setTab('community')}
        onKeyDown={handleRovingTabs}
      >
        <Icon name="trophy" />
        <span>{p('Community')}</span>
      </button>
      {hasNutrition && (
        <button
          id="professional-tab-nutrition"
          role="tab"
          aria-selected={tab === 'nutrition'}
          aria-controls="professional-panel-nutrition"
          tabIndex={tab === 'nutrition' ? 0 : -1}
          className={"pro-sched-tab " + (tab === 'nutrition' ? 'active' : '')}
          onClick={() => setTab('nutrition')}
          onKeyDown={handleRovingTabs}
        >
          <Icon name="scale" />
          <span>{p('Nutrition')}</span>
        </button>
      )}
    </nav>
    <section id={`professional-panel-${tab}`} role="tabpanel" aria-labelledby={`professional-tab-${tab}`}>
      {tab === 'scheduling' ? (
        <SchedulingView embedded />
      ) : tab === 'community' ? (
        <CommunityHub embedded defaultRole={coach ? 'coach' : 'athlete'} />
      ) : tab === 'nutrition' ? (
        coach ? (
          <CoachNutritionWorkspace user={user} />
        ) : (
          <section aria-labelledby="athlete-nutrition-section">
            <h2 className="pro-section-title" id="athlete-nutrition-section">{p('My nutrition')}</h2>
            <AthleteNutritionView />
          </section>
        )
      ) : (
        <>
          {inbox.loading && inbox.conversations.length === 0 && !inbox.error && <div className="pro-loading">{p('Loading messaging summaries…')}</div>}
          {inbox.error && <div className="card pro-load-error" role="alert"><p>{inbox.conversations.length ? p('Could not load more conversations. Previous messaging summaries are still shown.') : p('Could not load messaging summaries.')}</p><Button size="sm" disabled={inbox.loading} onClick={inbox.retry}>{p('Try again')}</Button></div>}
          {coach ? <><CoachPortfolio user={user} inbox={inbox} onSchedule={() => setTab('scheduling')} /><AthleteProfessionals initialInvite={initialParams} initialToken={initialParams.invite} userId={user.id} inbox={inbox} onSchedule={() => setTab('scheduling')} embedded /></>
            : <AthleteProfessionals initialInvite={initialParams} initialToken={initialParams.invite} userId={user.id} inbox={inbox} onSchedule={() => setTab('scheduling')} />}
          {inbox.page?.hasMore && !inbox.error && <div className="pro-actions"><Button size="sm" disabled={inbox.loading} onClick={inbox.loadMore}>{inbox.loading ? p('Loading…') : p('Load more conversations')}</Button></div>}
        </>
      )}
    </section>
  </main>
}
