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
import EmptyState from '../components/EmptyState.jsx'
import { Button, TextArea, TextField } from '../components/ui.jsx'
import AssessmentPanel from './AssessmentPanel.jsx'
import NutritionPanel, { AthleteNutritionView } from './NutritionPanel.jsx'
import { AthleteHabitsDashboard, CoachHabitsPanel, CommunicationPanel, useCommunicationInbox } from './CommunicationHabits.jsx'
import './ProfessionalHub.css'

const scopeLabel = scope => scope === 'nutrition' ? p('Nutrition') : scope === 'assessments' ? p('Physical assessments') : p('Training')
const statusLabel = status => ({
  pending: p('Pending'), active: p('Active'), suspended: p('Suspended'), ended: p('Ended'),
}[status] || status)
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

function ExerciseEditor({ exercise, onChange, onRemove, canRemove, divisionIndex, exerciseIndex }) {
  const field = (key, value) => onChange({ ...exercise, [key]: value })
  const prefix = `${divisionIndex + 1}-${exerciseIndex + 1}`
  return <div className="pro-exercise-editor">
    <div className="pro-editor-head"><strong>{p('Exercise {0}', exerciseIndex + 1)}</strong>
      {canRemove && <Button size="sm" variant="danger" onClick={onRemove}>{p('Remove exercise')}</Button>}</div>
    <label className="pro-field"><span>{p('Exercise')}</span><TextField name={`exercise-${prefix}`} value={exercise.name} maxLength={120}
      onChange={event => field('name', event.target.value)} /></label>
    <div className="pro-grid-fields">
      <label className="pro-field"><span>{p('Sets')}</span><TextField name={`sets-${prefix}`} inputMode="numeric" value={exercise.sets}
        onChange={event => field('sets', event.target.value.replace(/\D/g, '').slice(0, 2))} /></label>
      <label className="pro-field"><span>{p('Repetitions')}</span><TextField name={`reps-${prefix}`} value={exercise.reps} maxLength={40}
        onChange={event => field('reps', event.target.value)} /></label>
      <label className="pro-field"><span>{p('Load')}</span><TextField name={`load-${prefix}`} value={exercise.load} maxLength={40}
        placeholder={p('Example: 60 kg')} onChange={event => field('load', event.target.value)} /></label>
      <label className="pro-field"><span>{p('Rest (seconds)')}</span><TextField name={`rest-${prefix}`} inputMode="numeric" value={exercise.restSeconds}
        onChange={event => field('restSeconds', event.target.value.replace(/\D/g, '').slice(0, 4))} /></label>
    </div>
    <label className="pro-field"><span>{p('Observations')}</span><TextArea name={`notes-${prefix}`} rows={2} value={exercise.notes} maxLength={500}
      onChange={event => field('notes', event.target.value)} /></label>
  </div>
}

function RoutineEditor({ athlete, onCreated, onCancel }) {
  const toast = useUI(state => state.toast)
  const [routine, setRoutine] = useState(blankRoutine)
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
  const save = async () => {
    const invalid = !routine.name.trim() || routine.divisions.some(division => !division.name.trim()
      || division.exercises.some(exercise => !exercise.name.trim() || !exercise.reps.trim() || !Number(exercise.sets)))
    if (invalid) return toast(p('Complete the routine name and every exercise.'))
    setSaving(true)
    try {
      const body = {
        routine: {
          name: routine.name.trim(), notes: routine.notes.trim(),
          divisions: routine.divisions.map(division => ({
            name: division.name.trim(),
            exercises: division.exercises.map(exercise => ({
              name: exercise.name.trim(), sets: Number(exercise.sets), reps: exercise.reps.trim(), load: exercise.load.trim(),
              restSeconds: Number(exercise.restSeconds || 0), notes: exercise.notes.trim(),
            })),
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
    <label className="pro-field"><span>{p('Routine name')}</span><TextField name="routineName" value={routine.name} maxLength={120}
      placeholder={p('Example: Hypertrophy ABC')} onChange={event => setRoutine(current => ({ ...current, name: event.target.value }))} /></label>
    <label className="pro-field"><span>{p('General observations')}</span><TextArea name="routineNotes" rows={3} value={routine.notes} maxLength={1000}
      onChange={event => setRoutine(current => ({ ...current, notes: event.target.value }))} /></label>
    <div className="pro-division-editors">{routine.divisions.map((division, divisionIndex) => <section key={divisionIndex} className="pro-division-editor">
      <label className="pro-field"><span>{p('Division')}</span><TextField name={`division-${divisionIndex + 1}`} value={division.name} maxLength={80}
        onChange={event => updateDivision(divisionIndex, { ...division, name: event.target.value })} /></label>
      {division.exercises.map((exercise, exerciseIndex) => <ExerciseEditor key={exerciseIndex} exercise={exercise}
        divisionIndex={divisionIndex} exerciseIndex={exerciseIndex} canRemove={division.exercises.length > 1}
        onChange={next => updateExercise(divisionIndex, exerciseIndex, next)} onRemove={() => removeExercise(divisionIndex, exerciseIndex)} />)}
      <Button size="sm" icon="plus" onClick={() => addExercise(divisionIndex)}>{p('Add exercise')}</Button>
    </section>)}</div>
    <Button variant="primary" disabled={saving} onClick={save}>{saving ? p('Saving…') : p('Send prescription')}</Button>
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
  return <article className="card pro-link" data-status={link.status}>
    <div className="pro-link-head">
      <div><h2>{title}</h2><div className="pro-meta">{link.scopes.map(scopeLabel).join(' · ')}</div></div>
      <span className={'pro-status ' + link.status}>{statusLabel(link.status)}</span>
    </div>
    <div className="pro-dates">
      {link.acceptedAt && <span>{p('Accepted {0}', formatDate(link.acceptedAt))}</span>}
      {link.expiresAt && link.status === 'pending' && <span>{p('Expires {0}', formatDate(link.expiresAt))}</span>}
      {link.endedAt && <span>{p('Ended {0}', formatDate(link.endedAt))}</span>}
    </div>
    {(canSuspend || canEnd) && <div className="pro-actions">
      {canSuspend && <Button size="sm" onClick={() => onStatus(link, 'suspended')}>{p('Suspend')}</Button>}
      {canEnd && <Button size="sm" variant="danger" onClick={() => onStatus(link, 'ended')}>{p('End relationship')}</Button>}
    </div>}
    {children}
  </article>
}

function CoachPortfolio({ user, inbox }) {
  const toast = useUI(state => state.toast)
  const [links, setLinks] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [scopes, setScopes] = useState(() => user.profile.coachSpecialties.slice(0, 1))
  const [creating, setCreating] = useState(false)
  const [freshInvite, setFreshInvite] = useState(null)
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
      await load()
    } catch (error) { toast(professionalError(error)) }
    finally { setCreating(false) }
  }
  const copyInvite = async () => {
    if (await copyText(freshInvite.token)) toast(p('Invitation copied.'))
  }
  const status = (link, next) => confirmSheet({
    title: next === 'ended' ? p('End this relationship?') : p('Suspend this relationship?'),
    message: next === 'ended'
      ? p('Future professional access is blocked. The athlete keeps their training data.')
      : p('Professional access is blocked until a future reactivation flow.'),
    confirmText: next === 'ended' ? p('End relationship') : p('Suspend'),
    danger: true,
    onConfirm: async () => {
      try {
        const result = await api('/api/coach/links/status', { method: 'POST', body: JSON.stringify({ linkId: link.id, status: next }) })
        setLinks(current => current.map(item => item.id === link.id ? { ...item, ...result.link } : item))
      } catch (error) { toast(professionalError(error)) }
    },
  })

  return <>
    {canInvite && <section className="card pro-invite" aria-labelledby="pro-invite-title">
      <h2 id="pro-invite-title">{p('Invite an athlete')}</h2>
      <p>{p('Choose what this relationship authorizes. The athlete must accept explicitly.')}</p>
      <ScopeChoices allowed={user.profile.coachSpecialties} value={scopes} onChange={setScopes} />
      <Button variant="primary" disabled={creating || !scopes.length} onClick={createInvite}>{creating ? p('Creating…') : p('Create invitation')}</Button>
      {freshInvite && <div className="pro-token" role="status">
        <div><strong>{p('Share this code once')}</strong><span>{p('It expires {0}.', formatDate(freshInvite.expiresAt))}</span></div>
        <code>{freshInvite.token}</code>
        <Button size="sm" icon="copy" onClick={copyInvite}>{p('Copy invitation')}</Button>
      </div>}
    </section>}
    <section aria-labelledby="pro-coach-list-title">
      <h2 className="pro-section-title" id="pro-coach-list-title">{p('Portfolio')}</h2>
      {loading && links === null ? <div className="pro-loading">{p('Loading…')}</div>
        : loadError ? <div className="card pro-load-error" role="alert"><p>{p('Could not load your professional relationships.')}</p><Button size="sm" onClick={load}>{p('Try again')}</Button></div>
        : links.length === 0 ? <EmptyState icon="person" title={p('No athletes yet')} text={p('Create an invitation to start your portfolio.')} />
          : <div className="pro-list">{links.map(link => <RelationshipCard key={link.id} link={link} side="coach" onStatus={status}
            canSuspend={link.status === 'active' && capabilities.has('relationships:suspend')}
            canEnd={link.status !== 'ended' && capabilities.has('relationships:end')}>
            {link.status === 'active' && link.scopes.includes('training') && link.athlete && <CoachPrescriptionPanel link={link} />}
            {link.status === 'active' && link.scopes.includes('nutrition') && link.athlete && <NutritionPanel athleteId={link.athlete.id} />}
            {link.status === 'active' && link.scopes.includes('assessments') && link.athlete && <AssessmentPanel athleteId={link.athlete.id} />}
            <CommunicationPanel link={link} side="coach" actorId={user.id} conversation={inbox.byLink.get(link.id)} onConversationChange={inbox.update} />
            {link.scopes.includes('training') && <CoachHabitsPanel link={link} />}
          </RelationshipCard>)}</div>}
    </section>
  </>
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

function AthleteProfessionals({ initialToken, userId, inbox, embedded = false }) {
  const toast = useUI(state => state.toast)
  const [links, setLinks] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [token, setToken] = useState(initialToken || '')
  const [accepting, setAccepting] = useState(false)
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
    try {
      await api('/api/coach/invites/accept', { method: 'POST', body: JSON.stringify({ token: token.trim() }) })
      setToken('')
      toast(p('Invitation accepted.'))
      await load()
    } catch (error) { toast(professionalError(error)) }
    finally { setAccepting(false) }
  }
  const end = link => confirmSheet({
    title: p('End this relationship?'),
    message: p('The professional loses future access. Your training data stays with you.'),
    confirmText: p('End relationship'), danger: true,
    onConfirm: async () => {
      try {
        const result = await api('/api/coach/links/status', { method: 'POST', body: JSON.stringify({ linkId: link.id, status: 'ended' }) })
        setLinks(current => current.map(item => item.id === link.id ? { ...item, ...result.link } : item))
      } catch (error) { toast(professionalError(error)) }
    },
  })
  const assessmentConsent = async (link, granted) => {
    try {
      const result = await api(`/api/athlete/coaches/${link.id}/assessment-consent`, { method: 'POST', body: JSON.stringify({ granted }) })
      setLinks(current => current.map(item => item.id === link.id ? { ...item, ...result.link } : item))
      toast(granted ? p('Physical assessment consent granted.') : p('Physical assessment consent revoked.'))
    } catch (error) { toast(professionalError(error)) }
  }

  return <>
    {embedded && <h2 className="pro-section-title">{p('My professionals')}</h2>}
    <section className="card pro-accept" aria-labelledby="pro-accept-title">
      <h2 id="pro-accept-title">{p('Accept an invitation')}</h2>
      <p>{p('Opening an invitation never grants access by itself. Review it and accept here.')}</p>
      <label className="pro-field"><span>{p('Invitation code')}</span>
        <TextField name="inviteToken" value={token} onChange={event => setToken(event.target.value)} autoComplete="off" spellCheck="false" /></label>
      <Button variant="primary" disabled={accepting || !token.trim()} onClick={accept}>{accepting ? p('Accepting…') : p('Accept invitation')}</Button>
    </section>
    <AthletePrescriptions userId={userId} />
    <section aria-labelledby="athlete-nutrition-section"><h2 className="pro-section-title" id="athlete-nutrition-section">{p('My nutrition')}</h2><AthleteNutritionView /></section>
    <section aria-labelledby="athlete-assessments-title"><h2 className="pro-section-title" id="athlete-assessments-title">{p('My physical assessments')}</h2><AssessmentPanel athlete /></section>
    {links && <AthleteHabitsDashboard links={links} />}
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
  </>
}

export default function ProfessionalHub() {
  const user = useStore(state => state.user)
  const location = useLocation()
  const navigate = useNavigate()
  const inbox = useCommunicationInbox(user?.id)
  const initialToken = useMemo(() => new URLSearchParams(location.search).get('invite') || '', [])
  useEffect(() => {
    if (initialToken && location.search) navigate('/professionals', { replace: true })
  }, [initialToken, location.search, navigate])
  if (!user) return null
  const coach = user.profile?.kind === 'coach'
  return <main className="narrow pro-page">
    <div className="pro-nav"><button data-back="/settings" onClick={() => navigate('/settings')}><Icon name="chevronLeft" />{p('Settings')}</button></div>
    <header className="pro-hero"><div><span className="pro-kicker">{p('Professional relationships')}</span>
      <h1>{coach ? p('My athletes') : p('My professionals')}</h1>
      <p>{coach ? p('Access depends on an accepted relationship and its authorized scope.') : p('You control which professionals are linked to your account.')}</p></div>
      <Icon name={coach ? 'person' : 'shield'} />
    </header>
    <ProfileSetup user={user} />
    {inbox.loading && inbox.conversations.length === 0 && !inbox.error && <div className="pro-loading">{p('Loading messaging summaries…')}</div>}
    {inbox.error && <div className="card pro-load-error" role="alert"><p>{inbox.conversations.length ? p('Could not load more conversations. Previous messaging summaries are still shown.') : p('Could not load messaging summaries.')}</p><Button size="sm" disabled={inbox.loading} onClick={inbox.retry}>{p('Try again')}</Button></div>}
    {coach ? <><CoachPortfolio user={user} inbox={inbox} /><AthleteProfessionals initialToken={initialToken} userId={user.id} inbox={inbox} embedded /></>
      : <AthleteProfessionals initialToken={initialToken} userId={user.id} inbox={inbox} />}
    {inbox.page?.hasMore && !inbox.error && <div className="pro-actions"><Button size="sm" disabled={inbox.loading} onClick={inbox.loadMore}>{inbox.loading ? p('Loading…') : p('Load more conversations')}</Button></div>}
  </main>
}
