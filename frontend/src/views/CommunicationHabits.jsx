import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { communicationApi, browserTimeZone } from '../lib/communication-api.js'
import { dateLocale } from '../lib/i18n.js'
import { professionalError, professionalText as p } from '../lib/professional-copy.js'
import EmptyState from '../components/EmptyState.jsx'
import { Button, TextArea, TextField } from '../components/ui.jsx'

const PERIODS = [7, 30, 90]
const UNITS = ['horas', 'passos', 'ml', 'minutos', 'vezes']
const FREQUENCIES = ['daily', 'weekdays', 'weekends']
const frequencyLabel = value => ({ daily: p('Every day'), weekdays: p('Weekdays'), weekends: p('Weekends') }[value] || value)
const categoryLabel = value => ({ general: p('General'), workout_feedback: p('Workout feedback'), nutrition_feedback: p('Nutrition feedback') }[value] || value)
const formatDateTime = value => value ? new Date(value).toLocaleString(dateLocale(), { dateStyle: 'short', timeStyle: 'short' }) : ''
const formatDay = value => value ? new Date(`${value}T12:00:00Z`).toLocaleDateString(dateLocale()) : ''
const relationshipReadOnly = link => link.status !== 'active'

function categoriesFor(scopes = []) {
  const categories = []
  if (scopes.includes('training') || scopes.includes('nutrition')) categories.push('general')
  if (scopes.includes('training')) categories.push('workout_feedback')
  if (scopes.includes('nutrition')) categories.push('nutrition_feedback')
  return categories
}

export function useCommunicationInbox(userId) {
  const [conversations, setConversations] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const request = useRef(0)
  const load = useCallback(async () => {
    if (!userId) { setLoading(false); return }
    const current = ++request.current
    setLoading(true)
    setError(false)
    try {
      const result = await communicationApi.inbox()
      if (current === request.current) setConversations(result.conversations || [])
    } catch {
      if (current === request.current) setError(true)
    } finally {
      if (current === request.current) setLoading(false)
    }
  }, [userId])
  useEffect(() => { load() }, [load])
  const update = useCallback((link, side, updater) => {
    setConversations(current => {
      const existing = current.find(item => item.linkId === link.id) || {
        linkId: link.id,
        counterpart: side === 'coach' ? link.athlete : link.coach,
        unreadCount: 0,
        lastMessage: null,
        lastMessageAt: 0,
        status: link.status,
      }
      const next = typeof updater === 'function' ? updater(existing) : { ...existing, ...updater }
      return [...current.filter(item => item.linkId !== link.id), next]
        .sort((left, right) => right.lastMessageAt - left.lastMessageAt)
    })
  }, [])
  const byLink = useMemo(() => new Map(conversations.map(item => [item.linkId, item])), [conversations])
  return { conversations, byLink, loading, error, retry: load, update }
}

function LiveFeedback({ success, error }) {
  return <div className="pro-live" aria-live="polite" aria-atomic="true">
    {success && <span role="status">{success}</span>}
    {error && <span role="alert">{error}</span>}
  </div>
}

export function CommunicationPanel({ link, side, actorId, conversation, onConversationChange }) {
  const counterpart = side === 'coach' ? link.athlete : link.coach
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState(null)
  const [page, setPage] = useState(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [draft, setDraft] = useState('')
  const options = useMemo(() => categoriesFor(link.scopes), [link.scopes])
  const [category, setCategory] = useState(options[0] || 'general')
  const [sending, setSending] = useState(false)
  const [reading, setReading] = useState(false)
  const [success, setSuccess] = useState('')
  const request = useRef(0)
  const sendInFlight = useRef(false)
  const readInFlight = useRef(false)
  const draftRef = useRef(null)
  const markedThrough = useRef(null)
  const readOnly = relationshipReadOnly(link)

  const updateSummary = useCallback(updater => onConversationChange?.(link, side, updater), [link, side, onConversationChange])
  const markThrough = useCallback(async rows => {
    const through = rows.find(message => message.recipientId === actorId && message.readAt === null)
    if (!through || markedThrough.current === through.id) return
    markedThrough.current = through.id
    setReading(true)
    try {
      await communicationApi.readThrough(link.id, through.id)
      const readAt = Date.now()
      setMessages(current => current?.map(message => message.recipientId === actorId && message.readAt === null
        && (message.createdAt < through.createdAt || message.createdAt === through.createdAt && message.id.localeCompare(through.id) <= 0)
        ? { ...message, readAt } : message))
      updateSummary(current => ({ ...current, unreadCount: 0,
        lastMessage: current.lastMessage?.id === through.id ? { ...current.lastMessage, readAt } : current.lastMessage }))
    } catch (error) {
      setLoadError(professionalError(error))
    } finally { setReading(false) }
  }, [actorId, link.id, updateSummary])

  const load = useCallback(async (cursor = null) => {
    if (!counterpart?.id) return
    const current = ++request.current
    setLoading(true)
    setLoadError('')
    try {
      const result = await communicationApi.conversation({ side, counterpartId: counterpart.id, linkId: link.id, cursor })
      if (current !== request.current) return
      const rows = result.messages || []
      setMessages(previous => cursor ? [...(previous || []), ...rows] : rows)
      setPage(result.page || null)
      if (!cursor) await markThrough(rows)
    } catch (error) {
      if (current === request.current) setLoadError(professionalError(error))
    } finally {
      if (current === request.current) setLoading(false)
    }
  }, [counterpart?.id, link.id, markThrough, side])

  useEffect(() => { if (open && messages === null) load() }, [load, messages, open])
  useEffect(() => { if (!options.includes(category)) setCategory(options[0] || 'general') }, [category, options])

  const send = async event => {
    event.preventDefault()
    const content = draft.trim()
    if (!content || sendInFlight.current) return
    sendInFlight.current = true
    setSending(true)
    setLoadError('')
    setSuccess('')
    try {
      const result = await communicationApi.sendMessage({ side, counterpartId: counterpart.id, content, category })
      setMessages(current => [result.message, ...(current || [])])
      setDraft('')
      setSuccess(p('Message sent.'))
      updateSummary(current => ({ ...current, status: link.status, unreadCount: current.unreadCount || 0,
        lastMessage: result.message, lastMessageAt: result.message.createdAt }))
      requestAnimationFrame(() => draftRef.current?.querySelector('textarea')?.focus())
    } catch (error) {
      setLoadError(professionalError(error))
    } finally { sendInFlight.current = false; setSending(false) }
  }

  const markOne = async message => {
    if (readInFlight.current) return
    readInFlight.current = true
    setReading(true)
    setLoadError('')
    try {
      const result = await communicationApi.readMessage(message.id)
      setMessages(current => current?.map(item => item.id === message.id ? result.message : item))
      updateSummary(current => ({ ...current, unreadCount: Math.max(0, (current.unreadCount || 0) - 1),
        lastMessage: current.lastMessage?.id === message.id ? result.message : current.lastMessage }))
    } catch (error) { setLoadError(professionalError(error)) }
    finally { readInFlight.current = false; setReading(false) }
  }

  if (!counterpart?.id) return null
  return <section className="pro-comm" aria-labelledby={`messages-${link.id}`}>
    <button className="pro-comm-toggle" type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <span><strong id={`messages-${link.id}`}>{p('Messages')}</strong>
        <small>{conversation?.lastMessage ? conversation.lastMessage.content : p('No messages yet.')}</small></span>
      <span className="pro-comm-summary">{conversation?.unreadCount > 0 && <b aria-label={p('{0} unread messages', conversation.unreadCount)}>{conversation.unreadCount}</b>}
        <span>{conversation?.lastMessageAt ? formatDateTime(conversation.lastMessageAt) : statusText(link.status)}</span></span>
    </button>
    {open && <div className="pro-comm-body">
      {readOnly && <p className="pro-readonly" role="status">{p('This relationship is read-only. You can still review its history.')}</p>}
      <LiveFeedback success={success} error={loadError} />
      {loading && messages === null ? <div className="pro-loading">{p('Loading conversation…')}</div>
        : loadError && messages === null ? <Button size="sm" onClick={() => load()}>{p('Try again')}</Button>
          : messages?.length ? <>
            {page?.hasMore && <Button size="sm" disabled={loading} onClick={() => load(page.nextCursor)}>{loading ? p('Loading…') : p('Load earlier messages')}</Button>}
            <ol className="pro-messages" aria-label={p('Conversation history')}>
              {[...messages].reverse().map(message => <li key={message.id} className={message.senderId === actorId ? 'mine' : 'theirs'}>
                <div className="pro-message-meta"><span>{message.senderId === actorId ? p('You') : counterpart.name}</span>
                  <span>{categoryLabel(message.category)} · {formatDateTime(message.createdAt)}</span></div>
                <p>{message.content}</p>
                {message.recipientId === actorId && message.readAt === null && <Button size="sm" disabled={reading} onClick={() => markOne(message)}>{p('Mark as read')}</Button>}
              </li>)}
            </ol>
          </> : messages && <EmptyState title={p('No messages yet')} text={readOnly ? p('There is no conversation history for this relationship.') : p('Start the conversation with a clear, respectful message.')} />}
      {!readOnly && options.length > 0 && <form className="pro-message-form" onSubmit={send}>
        <label className="pro-field"><span>{p('Message category')}</span><select value={category} disabled={sending} onChange={event => setCategory(event.target.value)}>
          {options.map(value => <option key={value} value={value}>{categoryLabel(value)}</option>)}
        </select></label>
        <label className="pro-field" ref={draftRef}><span>{p('Message')}</span><TextArea value={draft} maxLength={2000} rows={3} disabled={sending}
          onChange={event => setDraft(event.target.value)} /></label>
        <Button variant="primary" disabled={sending || !draft.trim()}>{sending ? p('Sending…') : p('Send message')}</Button>
      </form>}
    </div>}
  </section>
}

const statusText = status => ({ active: p('Active conversation'), suspended: p('Suspended relationship'), ended: p('Ended relationship') }[status] || p('Relationship history'))

const blankHabit = () => ({ title: '', description: '', targetValue: '1', unit: 'vezes', frequency: 'daily' })
function HabitFields({ value, onChange, disabled, prefix }) {
  const set = key => event => onChange({ ...value, [key]: event.target.value })
  return <div className="pro-habit-fields">
    <label className="pro-field" htmlFor={`${prefix}-title`}><span>{p('Habit title')}</span><TextField id={`${prefix}-title`} value={value.title} maxLength={120} disabled={disabled} onChange={set('title')} /></label>
    <label className="pro-field" htmlFor={`${prefix}-description`}><span>{p('Description')}</span><TextArea id={`${prefix}-description`} value={value.description} maxLength={1000} rows={2} disabled={disabled} onChange={set('description')} /></label>
    <div className="pro-grid-fields">
      <label className="pro-field" htmlFor={`${prefix}-target`}><span>{p('Target')}</span><TextField id={`${prefix}-target`} type="number" min="0.01" step="any" value={value.targetValue} disabled={disabled} onChange={set('targetValue')} /></label>
      <label className="pro-field" htmlFor={`${prefix}-unit`}><span>{p('Unit')}</span><select id={`${prefix}-unit`} value={value.unit} disabled={disabled} onChange={set('unit')}>{UNITS.map(unit => <option key={unit}>{unit}</option>)}</select></label>
      <label className="pro-field" htmlFor={`${prefix}-frequency`}><span>{p('Frequency')}</span><select id={`${prefix}-frequency`} value={value.frequency} disabled={disabled} onChange={set('frequency')}>{FREQUENCIES.map(item => <option key={item} value={item}>{frequencyLabel(item)}</option>)}</select></label>
    </div>
  </div>
}

function SummaryView({ summary }) {
  if (!summary) return null
  return <div className="pro-summary" aria-label={p('Adherence summary')}>
    <div><strong>{summary.adherencePercent}%</strong><span>{p('Adherence')}</span></div>
    <div><strong>{summary.completedDays}/{summary.scheduledDays}</strong><span>{p('Completed scheduled days')}</span></div>
    {summary.habits?.map(habit => <article key={habit.habitId}>
      <strong>{habit.title}</strong><span>{p('Current streak: {0}', habit.currentStreak)}</span>
      <span>{p('Longest streak in selected period: {0}', habit.longestStreakInPeriod)}</span>
    </article>)}
  </div>
}

export function CoachHabitsPanel({ link, timeZone = browserTimeZone().value }) {
  const athleteId = link.athlete?.id
  const [open, setOpen] = useState(false)
  const [habits, setHabits] = useState(null)
  const [summary, setSummary] = useState(null)
  const [checkins, setCheckins] = useState(null)
  const [page, setPage] = useState(null)
  const [period, setPeriod] = useState(30)
  const [draft, setDraft] = useState(blankHabit)
  const [editing, setEditing] = useState(null)
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [pending, setPending] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const request = useRef(0)
  const mutationInFlight = useRef(false)
  const confirmRef = useRef(null)
  const readOnly = relationshipReadOnly(link)

  const load = useCallback(async (nextPeriod = period, cursor = null) => {
    if (!athleteId) return
    const current = ++request.current
    setLoading(true)
    setError('')
    try {
      const tasks = cursor ? [communicationApi.checkins({ side: 'coach', athleteId, linkId: link.id, period: nextPeriod, timeZone, cursor })]
        : [communicationApi.coachHabits({ athleteId, linkId: link.id }), communicationApi.summary({ side: 'coach', athleteId, linkId: link.id, period: nextPeriod, timeZone }), communicationApi.checkins({ side: 'coach', athleteId, linkId: link.id, period: nextPeriod, timeZone })]
      const result = await Promise.all(tasks)
      if (current !== request.current) return
      if (cursor) {
        setCheckins(previous => [...(previous || []), ...(result[0].checkins || [])])
        setPage(result[0].page || null)
      } else {
        setHabits(result[0].habits || [])
        setSummary(result[1].summary || null)
        setCheckins(result[2].checkins || [])
        setPage(result[2].page || null)
      }
    } catch (caught) {
      if (current === request.current) setError(professionalError(caught))
    } finally { if (current === request.current) setLoading(false) }
  }, [athleteId, link.id, period, timeZone])
  useEffect(() => { if (open && habits === null) load() }, [habits, load, open])
  useEffect(() => { if (confirmDelete) requestAnimationFrame(() => confirmRef.current?.focus()) }, [confirmDelete])

  const payload = value => ({ title: value.title.trim(), description: value.description.trim(), targetValue: Number(value.targetValue), unit: value.unit, frequency: value.frequency })
  const mutate = async (key, action, message) => {
    if (mutationInFlight.current) return false
    mutationInFlight.current = true
    setPending(key)
    setError('')
    setSuccess('')
    try { await action(); setSuccess(message); await load(period); return true }
    catch (caught) { setError(professionalError(caught)); return false }
    finally { mutationInFlight.current = false; setPending('') }
  }
  const create = event => {
    event.preventDefault()
    mutate('create', () => communicationApi.createHabit(athleteId, payload(draft)), p('Habit created.')).then(saved => {
      if (saved) setDraft(blankHabit())
    })
  }
  const saveEdit = event => {
    event.preventDefault()
    const current = editing
    mutate(current.id, () => communicationApi.updateHabit(athleteId, current.id, payload(current)), p('Habit updated.')).then(saved => {
      if (saved) setEditing(null)
    })
  }
  const habitName = new Map((habits || []).map(habit => [habit.id, habit.title]))

  if (!athleteId) return null
  return <section className="pro-habits" aria-labelledby={`habits-${link.id}`}>
    <button className="pro-comm-toggle" type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <span><strong id={`habits-${link.id}`}>{p('Habits and check-ins')}</strong><small>{p('Goals, adherence and streaks')}</small></span>
      <span>{readOnly ? p('History only') : p('Manage')}</span>
    </button>
    {open && <div className="pro-comm-body">
      {readOnly && <p className="pro-readonly" role="status">{p('This relationship is read-only. You can still review its history.')}</p>}
      <div className="pro-period-row"><label className="pro-field"><span>{p('Summary period')}</span><select value={period} disabled={loading} onChange={event => { const next = Number(event.target.value); setPeriod(next); load(next) }}>
        {PERIODS.map(days => <option key={days} value={days}>{p('{0} days', days)}</option>)}</select></label><span>{p('Timezone: {0}', timeZone)}</span></div>
      <LiveFeedback success={success} error={error} />
      {loading && habits === null ? <div className="pro-loading">{p('Loading habits…')}</div>
        : error && habits === null ? <Button size="sm" onClick={() => load()}>{p('Try again')}</Button>
          : <>
            <SummaryView summary={summary} />
            <div className="pro-habit-list">{habits?.length ? habits.map(habit => <article key={habit.id} className="pro-habit" data-status={habit.status}>
              {editing?.id === habit.id ? <form onSubmit={saveEdit}><HabitFields value={editing} onChange={setEditing} disabled={pending === habit.id} prefix={`edit-${habit.id}`} />
                <div className="pro-actions"><Button variant="primary" disabled={!!pending}>{p('Save changes')}</Button><Button type="button" disabled={!!pending} onClick={() => setEditing(null)}>{p('Cancel')}</Button></div></form>
                : <><div className="pro-link-head"><div><h3>{habit.title}</h3><div className="pro-meta">{habit.targetValue} {habit.unit} · {frequencyLabel(habit.frequency)}</div></div><span className={`pro-status ${habit.status}`}>{habit.status === 'active' ? p('Active') : p('Archived')}</span></div>
                  {habit.description && <p>{habit.description}</p>}
                  {!readOnly && <div className="pro-actions"><Button size="sm" disabled={!!pending} onClick={() => setEditing({ ...habit, targetValue: String(habit.targetValue) })}>{p('Edit')}</Button>
                    <Button size="sm" disabled={!!pending} onClick={() => mutate(habit.id, () => communicationApi.updateHabit(athleteId, habit.id, { status: habit.status === 'active' ? 'archived' : 'active' }), habit.status === 'active' ? p('Habit archived.') : p('Habit reactivated.'))}>{habit.status === 'active' ? p('Archive') : p('Reactivate')}</Button>
                    {confirmDelete === habit.id ? <span className="pro-inline-confirm"><span>{p('Delete this habit and its check-ins?')}</span><Button ref={confirmRef} size="sm" variant="danger" disabled={!!pending} onClick={() => mutate(habit.id, () => communicationApi.deleteHabit(athleteId, habit.id), p('Habit deleted.')).then(() => setConfirmDelete(null))}>{p('Confirm delete')}</Button><Button size="sm" disabled={!!pending} onClick={() => setConfirmDelete(null)}>{p('Cancel')}</Button></span>
                      : <Button size="sm" variant="danger" disabled={!!pending} onClick={() => setConfirmDelete(habit.id)}>{p('Delete')}</Button>}</div>}
                </>}
            </article>) : <EmptyState title={p('No habits yet')} text={readOnly ? p('There are no saved habits for this relationship.') : p('Create a measurable habit for this athlete.')} />}</div>
            {!readOnly && <form className="card pro-habit-create" onSubmit={create}><h3>{p('Create habit')}</h3><HabitFields value={draft} onChange={setDraft} disabled={pending === 'create'} prefix={`create-${link.id}`} />
              <Button variant="primary" disabled={!!pending || !draft.title.trim() || !(Number(draft.targetValue) > 0)}>{pending === 'create' ? p('Saving…') : p('Create habit')}</Button></form>}
            <section aria-labelledby={`history-${link.id}`}><h3 id={`history-${link.id}`}>{p('Check-in history')}</h3>
              {checkins?.length ? <ul className="pro-checkin-history">{checkins.map(checkin => <li key={checkin.id}><strong>{habitName.get(checkin.habitId) || p('Habit')}</strong><span>{formatDay(checkin.date)} · {checkin.value} · {checkin.completed ? p('Completed') : p('Not completed')}</span>{checkin.notes && <p>{checkin.notes}</p>}</li>)}</ul>
                : <p className="pro-empty-inline">{p('No check-ins in this period.')}</p>}
              {page?.hasMore && <Button size="sm" disabled={loading} onClick={() => load(period, page.nextCursor)}>{loading ? p('Loading…') : p('Load more check-ins')}</Button>}
            </section>
          </>}
    </div>}
  </section>
}

function AthleteCheckin({ habit, timeZone, onSaved }) {
  const existing = habit.checkin
  const [value, setValue] = useState(String(existing?.value ?? 0))
  const [completed, setCompleted] = useState(existing?.completed ?? false)
  const [notes, setNotes] = useState(existing?.notes ?? '')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const mutation = useRef(0)
  const inFlight = useRef(false)
  const readOnly = habit.relationship?.readOnly
  const submit = async event => {
    event.preventDefault()
    if (inFlight.current || readOnly) return
    inFlight.current = true
    const current = ++mutation.current
    setPending(true)
    setError('')
    setSuccess('')
    try {
      const result = await communicationApi.checkin(timeZone, { habitId: habit.id, date: habit.date, value: Number(value), completed, notes: notes.trim() })
      if (current !== mutation.current) return
      onSaved(result.checkin)
      setSuccess(p('Check-in saved.'))
    } catch (caught) { if (current === mutation.current) setError(professionalError(caught)) }
    finally { inFlight.current = false; if (current === mutation.current) setPending(false) }
  }
  return <article className="card pro-athlete-habit"><div className="pro-link-head"><div><h3>{habit.title}</h3><div className="pro-meta">{habit.targetValue} {habit.unit} · {frequencyLabel(habit.frequency)}</div></div>
    {existing && <span className="pro-status active">{p('Saved')}</span>}</div>{habit.description && <p>{habit.description}</p>}
    {readOnly ? <p className="pro-readonly">{p('History only for this relationship.')}</p> : <form onSubmit={submit}>
      <div className="pro-grid-fields"><label className="pro-field"><span>{p('Value')}</span><TextField type="number" min="0" step="any" value={value} disabled={pending} onChange={event => setValue(event.target.value)} /></label>
        <label className="pro-check"><input type="checkbox" checked={completed} disabled={pending} onChange={event => setCompleted(event.target.checked)} /><span>{p('Completed')}</span></label></div>
      <label className="pro-field"><span>{p('Notes')}</span><TextArea value={notes} maxLength={500} rows={2} disabled={pending} onChange={event => setNotes(event.target.value)} /></label>
      <Button variant="primary" disabled={pending || !Number.isFinite(Number(value))}>{pending ? p('Saving…') : p('Save check-in')}</Button>
    </form>}<LiveFeedback success={success} error={error} /></article>
}

export function AthleteHabitsDashboard({ links }) {
  const zone = useMemo(browserTimeZone, [])
  const trainingLinks = useMemo(() => links.filter(link => link.scopes.includes('training')), [links])
  const [habits, setHabits] = useState(null)
  const [selectedLink, setSelectedLink] = useState(trainingLinks[0]?.id || '')
  const [period, setPeriod] = useState(30)
  const [summary, setSummary] = useState(null)
  const [checkins, setCheckins] = useState(null)
  const [page, setPage] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const request = useRef(0)
  const historyRequest = useRef(0)

  useEffect(() => { if (!trainingLinks.some(link => link.id === selectedLink)) setSelectedLink(trainingLinks[0]?.id || '') }, [selectedLink, trainingLinks])
  const loadHabits = useCallback(async () => {
    const current = ++request.current
    setLoading(true)
    setError('')
    try {
      const result = await communicationApi.athleteHabits(zone.value)
      if (current === request.current) setHabits((result.habits || []).map(habit => ({ ...habit, date: result.date })))
    } catch (caught) { if (current === request.current) setError(professionalError(caught)) }
    finally { if (current === request.current) setLoading(false) }
  }, [zone.value])
  useEffect(() => { if (trainingLinks.length) loadHabits(); else { setHabits([]); setLoading(false) } }, [loadHabits, trainingLinks.length])

  const loadHistory = useCallback(async (linkId = selectedLink, nextPeriod = period, cursor = null) => {
    if (!linkId) return
    const current = ++historyRequest.current
    setError('')
    try {
      const results = cursor ? [await communicationApi.checkins({ side: 'athlete', linkId, period: nextPeriod, timeZone: zone.value, cursor })]
        : await Promise.all([communicationApi.summary({ side: 'athlete', linkId, period: nextPeriod, timeZone: zone.value }), communicationApi.checkins({ side: 'athlete', linkId, period: nextPeriod, timeZone: zone.value })])
      if (current !== historyRequest.current) return
      if (cursor) { setCheckins(previous => [...(previous || []), ...(results[0].checkins || [])]); setPage(results[0].page || null) }
      else { setSummary(results[0].summary || null); setCheckins(results[1].checkins || []); setPage(results[1].page || null) }
    } catch (caught) { if (current === historyRequest.current) setError(professionalError(caught)) }
  }, [period, selectedLink, zone.value])
  useEffect(() => { if (selectedLink) loadHistory(selectedLink, period) }, [loadHistory, period, selectedLink])
  const selected = trainingLinks.find(link => link.id === selectedLink)
  const habitNames = new Map((habits || []).map(habit => [habit.id, habit.title]))

  if (!trainingLinks.length) return null
  return <section aria-labelledby="athlete-habits-title"><h2 className="pro-section-title" id="athlete-habits-title">{p('My habits')}</h2>
    <div className="card pro-timezone"><strong>{p('Today in {0}', zone.value)}</strong><span>{zone.fallback ? p('Your browser timezone was unavailable, so PR Fit is using UTC.') : p('PR Fit uses your browser IANA timezone for daily check-ins.')}</span></div>
    <LiveFeedback error={error} />
    {loading && habits === null ? <div className="pro-loading">{p('Loading habits…')}</div>
      : error && habits === null ? <Button size="sm" onClick={loadHabits}>{p('Try again')}</Button>
        : habits?.length ? <div className="pro-list">{habits.map(habit => <AthleteCheckin key={habit.id} habit={habit} timeZone={zone.value} onSaved={checkin => setHabits(current => current.map(item => item.id === habit.id ? { ...item, checkin } : item))} />)}</div>
          : <EmptyState title={p('No habits for today')} text={p('Your active scheduled habits will appear here.')} />}
    <section className="card pro-own-history" aria-labelledby="athlete-history-title"><h3 id="athlete-history-title">{p('My adherence history')}</h3>
      <div className="pro-grid-fields"><label className="pro-field"><span>{p('Professional')}</span><select value={selectedLink} onChange={event => setSelectedLink(event.target.value)}>{trainingLinks.map(link => <option key={link.id} value={link.id}>{link.coach?.name || p('Unavailable account')} · {statusText(link.status)}</option>)}</select></label>
        <label className="pro-field"><span>{p('Period')}</span><select value={period} onChange={event => setPeriod(Number(event.target.value))}>{PERIODS.map(days => <option key={days} value={days}>{p('{0} days', days)}</option>)}</select></label></div>
      {selected && relationshipReadOnly(selected) && <p className="pro-readonly">{p('This relationship is read-only. You can still review its history.')}</p>}
      <SummaryView summary={summary} />
      {checkins?.length ? <ul className="pro-checkin-history">{checkins.map(checkin => <li key={checkin.id}><strong>{habitNames.get(checkin.habitId) || p('Habit')}</strong><span>{formatDay(checkin.date)} · {checkin.value} · {checkin.completed ? p('Completed') : p('Not completed')}</span>{checkin.notes && <p>{checkin.notes}</p>}</li>)}</ul>
        : checkins && <p>{p('No check-ins in this period.')}</p>}
      {page?.hasMore && <Button size="sm" onClick={() => loadHistory(selectedLink, period, page.nextCursor)}>{p('Load more check-ins')}</Button>}
    </section>
  </section>
}
