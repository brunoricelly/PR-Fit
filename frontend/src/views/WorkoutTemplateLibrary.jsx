import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api.js'
import { professionalError, professionalText as p } from '../lib/professional-copy.js'
import { useUI } from '../store/useUI.js'
import { confirmSheet } from '../sheets.jsx'
import { Button } from '../components/design-system.jsx'

const MAX_ASSIGN = 50

const SKIP_COPY = {
  relationship_not_found: 'No active link with this athlete.',
  relationship_inactive: 'The link with this athlete is not active.',
  scope_forbidden: 'This athlete did not authorise training access.',
  already_assigned: 'Already has this template.',
  prescription_capacity: 'This athlete reached the prescription limit.',
}
export const skipReasonLabel = code => p(SKIP_COPY[code] || 'Could not assign.')

const exerciseCount = routine => routine.divisions.reduce((total, division) => total + division.exercises.length, 0)

// The editor posts the prescription body ({routine}); a template takes the very same body.
function TemplateCard({ template, onAssign, onEdit, onDelete }) {
  const { routine } = template
  return <article className="card pro-prescription pro-template" data-template-id={template.id}>
    <div className="pro-link-head">
      <div>
        <h3>{routine.name}</h3>
        <div className="pro-meta">{p('{0} divisions · {1} exercises', routine.divisions.length, exerciseCount(routine))}</div>
      </div>
    </div>
    {routine.notes && <p className="pro-routine-note">{routine.notes}</p>}
    <div className="pro-actions">
      <Button size="sm" variant="primary" onClick={() => onAssign(template)}>{p('Assign to athletes')}</Button>
      <Button size="sm" onClick={() => onEdit(template)}>{p('Edit template')}</Button>
      <Button size="sm" variant="danger" onClick={() => onDelete(template)}>{p('Delete template')}</Button>
    </div>
  </article>
}

function AssignPanel({ template, onClose }) {
  const toast = useUI(state => state.toast)
  const [athletes, setAthletes] = useState(null)
  const [loadError, setLoadError] = useState(false)
  const [selected, setSelected] = useState(() => new Set())
  const [sending, setSending] = useState(false)
  const [results, setResults] = useState(null)

  useEffect(() => {
    let cancelled = false
    api('/api/coach/athletes').then(result => {
      if (cancelled) return
      // only athletes the coach may prescribe training to are offered; the server re-checks every one
      setAthletes((result.links || []).filter(link => link.status === 'active' && (link.scopes || []).includes('training') && link.athlete)
        .map(link => ({ id: link.athlete.id, name: link.athlete.name })))
    }).catch(() => { if (!cancelled) setLoadError(true) })
    return () => { cancelled = true }
  }, [])

  const names = useMemo(() => new Map((athletes || []).map(athlete => [athlete.id, athlete.name])), [athletes])
  const toggle = id => setSelected(current => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else if (next.size < MAX_ASSIGN) next.add(id)
    return next
  })
  const allSelected = !!athletes?.length && athletes.slice(0, MAX_ASSIGN).every(athlete => selected.has(athlete.id))

  const send = async () => {
    if (!selected.size || sending) return
    setSending(true)
    try {
      const result = await api(`/api/coach/workout-templates/${template.id}/assign`, { method: 'POST', body: JSON.stringify({ athleteIds: [...selected] }) })
      const rows = result.results || []
      setResults(rows)
      // keep only the ones that did not get it selected, so a retry never re-sends the successes
      setSelected(new Set(rows.filter(row => row.status !== 'assigned').map(row => row.athleteId)))
      const done = rows.filter(row => row.status === 'assigned').length
      toast(done === rows.length ? p('Template assigned to {0} athletes.', done) : p('Assigned to {0} of {1} athletes.', done, rows.length))
    } catch (error) { toast(professionalError(error)) }
    finally { setSending(false) }
  }

  const failed = (results || []).filter(row => row.status !== 'assigned')
  return <section className="card pro-routine-editor pro-assign" aria-label={p('Assign {0}', template.routine.name)}>
    <div className="pro-editor-title">
      <div><h3>{p('Assign {0}', template.routine.name)}</h3>
        <p>{p('Each athlete gets an independent copy. Editing the template later does not change it.')}</p></div>
      <Button size="sm" onClick={onClose}>{results ? p('Close') : p('Cancel')}</Button>
    </div>
    {loadError ? <div className="pro-load-inline" role="alert"><span>{p('Could not load your athletes.')}</span></div>
      : athletes === null ? <div className="pro-loading">{p('Loading…')}</div>
        : athletes.length === 0 ? <p className="pro-empty-inline">{p('No athletes with active training access yet.')}</p>
          : <>
            <div className="pro-panel-head">
              <label className="pro-check"><input type="checkbox" checked={allSelected}
                onChange={() => setSelected(allSelected ? new Set() : new Set(athletes.slice(0, MAX_ASSIGN).map(athlete => athlete.id)))} />
              <span>{p('Select all')}</span></label>
              <small aria-live="polite">{p('{0} selected (max {1})', selected.size, MAX_ASSIGN)}</small>
            </div>
            <ul className="pro-pick-list">{athletes.map(athlete => <li key={athlete.id}>
              <label className="pro-check"><input type="checkbox" checked={selected.has(athlete.id)} disabled={!selected.has(athlete.id) && selected.size >= MAX_ASSIGN}
                onChange={() => toggle(athlete.id)} /><span>{athlete.name}</span></label>
            </li>)}</ul>
            {failed.length > 0 && <div className="pro-load-inline" role="status">
              <strong>{p('Not assigned')}</strong>
              <ul>{failed.map(row => <li key={row.athleteId}>{names.get(row.athleteId) || row.athleteId}: {skipReasonLabel(row.code)}</li>)}</ul>
            </div>}
            <div className="pro-editor-footer-actions">
              <Button variant="primary" disabled={!selected.size || sending} onClick={send}>
                {sending ? p('Assigning…') : p('Assign to {0} athletes', selected.size)}
              </Button>
            </div>
          </>}
  </section>
}

export default function WorkoutTemplateLibrary({ Editor }) {
  const toast = useUI(state => state.toast)
  const [templates, setTemplates] = useState(null)
  const [loadError, setLoadError] = useState(false)
  const [mode, setMode] = useState(null) // null | {type:'new'} | {type:'edit',template} | {type:'assign',template}

  const load = useCallback(async () => {
    setLoadError(false)
    try { setTemplates((await api('/api/coach/workout-templates')).templates || []) }
    catch { setLoadError(true) }
  }, [])
  useEffect(() => { load() }, [load])

  const remove = template => confirmSheet({
    title: p('Delete this template?'),
    message: p('Athletes who already received it keep their copy.'),
    confirmText: p('Delete template'), danger: true,
    onConfirm: async () => {
      try {
        await api(`/api/coach/workout-templates/${template.id}`, { method: 'DELETE' })
        setTemplates(current => current.filter(item => item.id !== template.id))
        toast(p('Template deleted.'))
      } catch (error) { toast(professionalError(error)) }
    },
  })

  const saveNew = body => api('/api/coach/workout-templates', { method: 'POST', body: JSON.stringify(body) })
  const saveEdit = template => body => api(`/api/coach/workout-templates/${template.id}`, { method: 'PUT', body: JSON.stringify(body) })

  return <div className="pro-prescription-panel pro-library">
    <div className="pro-panel-head"><strong>{p('Workout library')}</strong>
      {!mode && <Button size="sm" icon="plus" onClick={() => setMode({ type: 'new' })}>{p('New template')}</Button>}</div>
    {mode?.type === 'new' && <Editor athlete={null} onCancel={() => setMode(null)} onSave={saveNew}
      onCreated={created => { setTemplates(current => [created, ...(current || [])]); setMode(null) }} />}
    {mode?.type === 'edit' && <Editor athlete={null} initial={mode.template.routine} onCancel={() => setMode(null)} onSave={saveEdit(mode.template)}
      onCreated={updated => { setTemplates(current => current.map(item => item.id === updated.id ? updated : item)); setMode(null) }} />}
    {mode?.type === 'assign' && <AssignPanel template={mode.template} onClose={() => setMode(null)} />}
    {loadError ? <div className="pro-load-inline" role="alert"><span>{p('Could not load your templates.')}</span><Button size="sm" onClick={load}>{p('Try again')}</Button></div>
      : templates === null ? <div className="pro-loading">{p('Loading…')}</div>
        : templates.length === 0 ? <p className="pro-empty-inline">{p('No templates yet. Save a routine once and assign it to many athletes.')}</p>
          : <div className="pro-prescription-list">{templates.map(template => <TemplateCard key={template.id} template={template}
            onAssign={item => setMode({ type: 'assign', template: item })} onEdit={item => setMode({ type: 'edit', template: item })} onDelete={remove} />)}</div>}
  </div>
}
