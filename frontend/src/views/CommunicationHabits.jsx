import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { communicationApi, browserTimeZone, dateInTimeZone } from '../lib/communication-api.js'
import { dateLocale } from '../lib/i18n.js'
import { professionalError, professionalText as p } from '../lib/professional-copy.js'
import { Alert, Badge, Button, Card, EmptyState, Field, Input, LiveFeedback, Select, Textarea } from '../components/design-system.jsx'

const PERIODS = [7, 30, 90]
const UNITS = ['horas', 'passos', 'ml', 'minutos', 'vezes']
const FREQUENCIES = ['daily', 'weekdays', 'weekends']
const frequencyLabel = value => ({ daily: p('Every day'), weekdays: p('Weekdays'), weekends: p('Weekends') }[value] || value)
const categoryLabel = value => ({ general: p('General'), workout_feedback: p('Workout feedback'), nutrition_feedback: p('Nutrition feedback') }[value] || value)
const formatDateTime = value => value ? new Date(value).toLocaleString(dateLocale(), { dateStyle: 'short', timeStyle: 'short' }) : ''
export const formatCivilDay = (value, locale = dateLocale()) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '')
  if (!match) return ''
  return new Intl.DateTimeFormat(locale, { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' })
    .format(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
}
const relationshipReadOnly = link => link.status !== 'active'
const conversationOrder = (left, right) => Number(right.lastMessageAt || 0) - Number(left.lastMessageAt || 0) || String(right.linkId).localeCompare(String(left.linkId))
const mergeById = (current, incoming, key = 'id') => {
  const rows = new Map(current.map(item => [item[key], item]))
  for (const item of incoming) rows.set(item[key], item)
  return [...rows.values()]
}

function categoriesFor(scopes = []) {
  const categories = []
  if (scopes.includes('training') || scopes.includes('nutrition')) categories.push('general')
  if (scopes.includes('training')) categories.push('workout_feedback')
  if (scopes.includes('nutrition')) categories.push('nutrition_feedback')
  return categories
}

export function useCommunicationInbox(userId) {
  const [conversations, setConversations] = useState([])
  const [page, setPage] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const request = useRef(0)
  const failedCursor = useRef(null)
  const load = useCallback(async (cursor = null) => {
    if (!userId) { setLoading(false); return }
    const current = ++request.current
    setLoading(true)
    setError(false)
    try {
      const result = await communicationApi.inbox({ cursor })
      if (current === request.current) {
        setConversations(previous => (cursor ? mergeById(previous, result.conversations || [], 'linkId') : result.conversations || []).sort(conversationOrder))
        setPage(result.page || null)
        failedCursor.current = null
      }
    } catch {
      if (current === request.current) { failedCursor.current = cursor; setError(true) }
    } finally {
      if (current === request.current) setLoading(false)
    }
  }, [userId])
  useEffect(() => { setConversations([]); setPage(null); load() }, [load])
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
        .sort(conversationOrder)
    })
  }, [])
  const byLink = useMemo(() => new Map(conversations.map(item => [item.linkId, item])), [conversations])
  const retry = useCallback(() => load(failedCursor.current), [load])
  const loadMore = useCallback(() => page?.hasMore && !loading ? load(page.nextCursor) : undefined, [load, loading, page])
  return { conversations, byLink, page, loading, error, retry, loadMore, update }
}



export function CommunicationPanel({ link, side, actorId, conversation, onConversationChange }) {
  const counterpart = side === 'coach' ? link.athlete : link.coach
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState(null)
  const [page, setPage] = useState(null)
  const [loading, setLoading] = useState(false)
  const [conversationError, setConversationError] = useState('')
  const [actionError, setActionError] = useState('')
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
  const failedCursor = useRef(null)
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
      setActionError(professionalError(error))
    } finally { setReading(false) }
  }, [actorId, link.id, updateSummary])

  const load = useCallback(async (cursor = null) => {
    if (!counterpart?.id) return
    const current = ++request.current
    setLoading(true)
    setConversationError('')
    try {
      const result = await communicationApi.conversation({ side, counterpartId: counterpart.id, linkId: link.id, cursor })
      if (current !== request.current) return
      const rows = result.messages || []
      setMessages(previous => cursor ? mergeById(previous || [], rows) : rows)
      setPage(result.page || null)
      failedCursor.current = null
      if (!cursor) await markThrough(rows)
    } catch (error) {
      if (current === request.current) { failedCursor.current = cursor; setConversationError(professionalError(error)) }
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
    setActionError('')
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
      setActionError(professionalError(error))
    } finally { sendInFlight.current = false; setSending(false) }
  }

  const markOne = async message => {
    if (readInFlight.current) return
    readInFlight.current = true
    setReading(true)
    setActionError('')
    try {
      const result = await communicationApi.readMessage(message.id)
      setMessages(current => current?.map(item => item.id === message.id ? result.message : item))
      updateSummary(current => ({ ...current, unreadCount: Math.max(0, (current.unreadCount || 0) - 1),
        lastMessage: current.lastMessage?.id === message.id ? result.message : current.lastMessage }))
    } catch (error) { setActionError(professionalError(error)) }
    finally { readInFlight.current = false; setReading(false) }
  }

  const handleMessagesKeyDown = event => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const items = [...(event.currentTarget?.querySelectorAll('li') || [])]
    const active = document.activeElement
    const index = items.indexOf(active)
    if (index === -1) {
      if (items.length > 0) items[event.key === 'ArrowDown' ? 0 : items.length - 1].focus()
      return
    }
    const next = event.key === 'ArrowDown' ? Math.min(items.length - 1, index + 1) : Math.max(0, index - 1)
    if (items[next]) {
      event.preventDefault()
      items[next].focus()
    }
  }

  if (!counterpart?.id) return null
  return <section className="pro-comm" aria-labelledby={`messages-${link.id}`}>
    <button className="pro-comm-toggle" type="button" aria-expanded={open} onClick={() => setOpen(value => !value)} style={{ minHeight: '54px' }}>
      <span>
        <strong id={`messages-${link.id}`}>{p('Messages')}</strong>
        <small>{conversation?.lastMessage ? conversation.lastMessage.content : p('No messages yet.')}</small>
      </span>
      <span className="pro-comm-summary">
        {conversation?.unreadCount > 0 && <b aria-label={p('{0} unread messages', conversation.unreadCount)}>{conversation.unreadCount}</b>}
        <span>{conversation?.lastMessageAt ? formatDateTime(conversation.lastMessageAt) : statusText(link.status)}</span>
      </span>
    </button>
    {open && <div className="pro-comm-body">
      {readOnly && <p className="pro-readonly" role="status">{p('This relationship is read-only. You can still review its history.')}</p>}
      <LiveFeedback success={success} error={actionError} />
      {loading && messages === null ? <div className="pro-loading">{p('Loading conversation…')}</div>
        : conversationError && messages === null ? <div className="pro-load-error" role="alert"><p>{p('Could not load this conversation.')}</p><Button size="sm" onClick={() => load(failedCursor.current)} style={{ minHeight: '44px' }}>{p('Try again')}</Button></div>
          : messages?.length ? <>
            {conversationError && <div className="pro-load-error" role="alert"><p>{p('Could not refresh this conversation. Your previous messages are still shown.')}</p><Button size="sm" disabled={loading} onClick={() => load(failedCursor.current)} style={{ minHeight: '44px' }}>{p('Try again')}</Button></div>}
            {page?.hasMore && !conversationError && <Button size="sm" disabled={loading} onClick={() => load(page.nextCursor)} style={{ minHeight: '44px' }}>{loading ? p('Loading…') : p('Load earlier messages')}</Button>}
            <ol className="pro-messages" aria-label={p('Conversation history')} tabIndex={0} role="log" onKeyDown={handleMessagesKeyDown}>
              {[...messages].reverse().map(message => <li key={message.id} className={message.senderId === actorId ? 'mine' : 'theirs'} tabIndex={0}>
                <div className="pro-message-meta">
                  <span>{message.senderId === actorId ? p('You') : counterpart.name}</span>
                  <span>{categoryLabel(message.category)} · {formatDateTime(message.createdAt)}</span>
                </div>
                <p>{message.content}</p>
                <div className="pro-message-footer">
                  {message.senderId === actorId ? (
                    <span className="pro-receipt" aria-label={message.readAt ? p('Read') : p('Delivered')}>
                      {message.readAt ? p('Read {0}', formatDateTime(message.readAt)) : p('Delivered')}
                    </span>
                  ) : message.readAt === null ? (
                    <Button size="sm" disabled={reading} onClick={() => markOne(message)} style={{ minHeight: '44px' }}>
                      {p('Mark as read')}
                    </Button>
                  ) : (
                    <span className="pro-receipt read">{p('Read')}</span>
                  )}
                </div>
              </li>)}
            </ol>
          </> : messages && !conversationError && <EmptyState title={p('No messages yet')} text={readOnly ? p('There is no conversation history for this relationship.') : p('Start the conversation with a clear, respectful message.')} />}
      {!readOnly && options.length > 0 && <form className="pro-message-form" onSubmit={send}>
        <label className="pro-field">
          <span>{p('Message category')}</span>
          <select value={category} disabled={sending} onChange={event => setCategory(event.target.value)} style={{ minHeight: '44px' }}>
            {options.map(value => <option key={value} value={value}>{categoryLabel(value)}</option>)}
          </select>
        </label>
        <label className="pro-field" ref={draftRef}>
          <span>{p('Message')}</span>
          <Textarea value={draft} maxLength={2000} rows={3} disabled={sending} onChange={event => setDraft(event.target.value)} style={{ minHeight: '44px' }} />
        </label>
        <Button variant="primary" disabled={sending || !draft.trim()} style={{ minHeight: '44px' }}>
          {sending ? p('Sending…') : p('Send message')}
        </Button>
      </form>}
    </div>}
  </section>
}

const statusText = status => ({ active: p('Active conversation'), suspended: p('Suspended relationship'), ended: p('Ended relationship') }[status] || p('Relationship history'))

const blankHabit = () => ({ title: '', description: '', targetValue: '1', unit: 'vezes', frequency: 'daily' })
function HabitFields({ value, onChange, disabled, prefix }) {
  const set = key => event => onChange({ ...value, [key]: event.target.value })
  return <div className="pro-habit-fields">
    <label className="pro-field" htmlFor={`${prefix}-title`}>
      <span>{p('Habit title')}</span>
      <Input id={`${prefix}-title`} value={value.title} maxLength={120} disabled={disabled} onChange={set('title')} style={{ minHeight: '44px' }} />
    </label>
    <label className="pro-field" htmlFor={`${prefix}-description`}>
      <span>{p('Description')}</span>
      <Textarea id={`${prefix}-description`} value={value.description} maxLength={1000} rows={2} disabled={disabled} onChange={set('description')} style={{ minHeight: '44px' }} />
    </label>
    <div className="pro-grid-fields">
      <label className="pro-field" htmlFor={`${prefix}-target`}>
        <span>{p('Target')}</span>
        <Input id={`${prefix}-target`} type="number" min="0.01" step="any" value={value.targetValue} disabled={disabled} onChange={set('targetValue')} style={{ minHeight: '44px' }} />
      </label>
      <label className="pro-field" htmlFor={`${prefix}-unit`}>
        <span>{p('Unit')}</span>
        <select id={`${prefix}-unit`} value={value.unit} disabled={disabled} onChange={set('unit')} style={{ minHeight: '44px' }}>
          {UNITS.map(unit => <option key={unit} value={unit}>{unit}</option>)}
        </select>
      </label>
      <label className="pro-field" htmlFor={`${prefix}-frequency`}>
        <span>{p('Frequency')}</span>
        <select id={`${prefix}-frequency`} value={value.frequency} disabled={disabled} onChange={set('frequency')} style={{ minHeight: '44px' }}>
          {FREQUENCIES.map(item => <option key={item} value={item}>{frequencyLabel(item)}</option>)}
        </select>
      </label>
    </div>
  </div>
}

function SummaryView({ summary }) {
  if (!summary) return null
  const hasScheduled = (summary.scheduledDays || 0) > 0
  return <div className="pro-summary" aria-label={p('Adherence summary')}>
    <div className="pro-summary-stat">
      <strong>{hasScheduled ? `${summary.adherencePercent}%` : '—'}</strong>
      <span>{p('Adherence')}</span>
      {!hasScheduled && <small className="pro-summary-note">{p('No scheduled habit days in period')}</small>}
    </div>
    <div className="pro-summary-stat">
      <strong>{summary.completedDays}/{summary.scheduledDays}</strong>
      <span>{p('Completed scheduled days')}</span>
    </div>
    {summary.habits?.length > 0 ? summary.habits.map(habit => (
      <article key={habit.habitId} className="pro-summary-habit">
        <div className="pro-summary-habit-head">
          <strong>{habit.title}</strong>
          <span className="pro-meta-badge">{frequencyLabel(habit.frequency)}</span>
        </div>
        <span>{p('Current streak: {0}', habit.currentStreak)}</span>
        <span>{p('Longest streak in selected period: {0}', habit.longestStreakInPeriod)}</span>
        {habit.scheduledDays > 0 ? (
          <span className="pro-summary-adherence">{p('Adherence: {0}%', habit.adherencePercent)}</span>
        ) : (
          <span className="pro-summary-note">{p('No scheduled habit days in period')}</span>
        )}
      </article>
    )) : <p className="pro-empty-inline">{p('No habits configured')}</p>}
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
  const [habitsLoading, setHabitsLoading] = useState(false)
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [habitsError, setHabitsError] = useState('')
  const [summaryError, setSummaryError] = useState('')
  const [historyError, setHistoryError] = useState('')
  const [mutationError, setMutationError] = useState('')
  const [success, setSuccess] = useState('')
  const request = useRef(0)
  const mutationInFlight = useRef(false)
  const confirmRef = useRef(null)
  const readOnly = relationshipReadOnly(link)
  const loading = habitsLoading || summaryLoading || historyLoading

  const load = useCallback(async (nextPeriod = period, cursor = null) => {
    if (!athleteId) return
    const current = ++request.current
    if (cursor) {
      setHistoryLoading(true)
      setHistoryError('')
      try {
        const result = await communicationApi.checkins({ side: 'coach', athleteId, linkId: link.id, period: nextPeriod, timeZone, cursor })
        if (current !== request.current) return
        setCheckins(previous => mergeById(previous || [], result.checkins || []))
        setPage(result.page || null)
      } catch (caught) {
        if (current === request.current) setHistoryError(professionalError(caught))
      } finally { if (current === request.current) setHistoryLoading(false) }
      return
    }
    setHabitsLoading(true); setSummaryLoading(true); setHistoryLoading(true)
    setHabitsError(''); setSummaryError(''); setHistoryError('')
    const results = await Promise.allSettled([
      communicationApi.coachHabits({ athleteId, linkId: link.id }),
      communicationApi.summary({ side: 'coach', athleteId, linkId: link.id, period: nextPeriod, timeZone }),
      communicationApi.checkins({ side: 'coach', athleteId, linkId: link.id, period: nextPeriod, timeZone }),
    ])
    if (current !== request.current) return
    if (results[0].status === 'fulfilled') setHabits(results[0].value.habits || [])
    else setHabitsError(professionalError(results[0].reason))
    if (results[1].status === 'fulfilled') setSummary(results[1].value.summary || null)
    else setSummaryError(professionalError(results[1].reason))
    if (results[2].status === 'fulfilled') { setCheckins(results[2].value.checkins || []); setPage(results[2].value.page || null) }
    else setHistoryError(professionalError(results[2].reason))
    setHabitsLoading(false); setSummaryLoading(false); setHistoryLoading(false)
  }, [athleteId, link.id, period, timeZone])
  useEffect(() => { if (open && habits === null) load() }, [habits, load, open])
  useEffect(() => { if (confirmDelete) requestAnimationFrame(() => confirmRef.current?.focus()) }, [confirmDelete])

  const payload = value => ({ title: value.title.trim(), description: value.description.trim(), targetValue: Number(value.targetValue), unit: value.unit, frequency: value.frequency })
  const mutate = async (key, action, message) => {
    if (mutationInFlight.current) return false
    mutationInFlight.current = true
    setPending(key)
    setMutationError('')
    setSuccess('')
    try { await action(); setSuccess(message); await load(period); return true }
    catch (caught) { setMutationError(professionalError(caught)); return false }
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
    <button className="pro-comm-toggle" type="button" aria-expanded={open} onClick={() => setOpen(value => !value)} style={{ minHeight: '54px' }}>
      <span><strong id={`habits-${link.id}`}>{p('Habits and check-ins')}</strong><small>{p('Goals, adherence and streaks')}</small></span>
      <span>{readOnly ? p('History only') : p('Manage')}</span>
    </button>
    {open && <div className="pro-comm-body">
      {readOnly && <p className="pro-readonly" role="status">{p('This relationship is read-only. You can still review its history.')}</p>}
      <div className="pro-period-row">
        <label className="pro-field">
          <span>{p('Summary period')}</span>
          <select value={period} disabled={loading} onChange={event => { const next = Number(event.target.value); setPeriod(next); load(next) }} style={{ minHeight: '44px' }}>
            {PERIODS.map(days => <option key={days} value={days}>{p('{0} days', days)}</option>)}
          </select>
        </label>
        <span>{p('Timezone: {0}', timeZone)}</span>
      </div>
      <LiveFeedback success={success} error={mutationError} />
      <section aria-labelledby={`summary-${link.id}`}><h3 id={`summary-${link.id}`}>{p('Adherence summary')}</h3>
        {summaryLoading && summary === null ? <div className="pro-loading">{p('Loading adherence summary…')}</div>
          : summaryError ? <div className="pro-load-error" role="alert"><p>{summary ? p('Could not refresh adherence. Your previous summary is still shown.') : p('Could not load adherence summary.')}</p><Button size="sm" onClick={() => load()} style={{ minHeight: '44px' }}>{p('Try again')}</Button></div> : null}
        <SummaryView summary={summary} />
        {!summaryLoading && !summaryError && summary === null && <p className="pro-empty-inline">{p('No adherence summary for this period.')}</p>}
      </section>
      {habitsLoading && habits === null && <div className="pro-loading">{p('Loading habits…')}</div>}
      {habitsError && <div className="pro-load-error" role="alert"><p>{habits ? p('Could not refresh habits. Your previous habits are still shown.') : p('Could not load habits.')}</p><Button size="sm" onClick={() => load()} style={{ minHeight: '44px' }}>{p('Try again')}</Button></div>}
      {habits !== null && <><div className="pro-habit-list">{habits.length ? habits.map(habit => <article key={habit.id} className="pro-habit" data-status={habit.status}>
              {editing?.id === habit.id ? <form onSubmit={saveEdit}><HabitFields value={editing} onChange={setEditing} disabled={pending === habit.id} prefix={`edit-${habit.id}`} />
                <div className="pro-actions"><Button variant="primary" disabled={!!pending} style={{ minHeight: '44px' }}>{p('Save changes')}</Button><Button type="button" disabled={!!pending} onClick={() => setEditing(null)} style={{ minHeight: '44px' }}>{p('Cancel')}</Button></div></form>
                : <><div className="pro-link-head"><div><h3>{habit.title}</h3><div className="pro-meta">{habit.targetValue} {habit.unit} · {frequencyLabel(habit.frequency)}</div></div><span className={`pro-status ${habit.status}`}>{habit.status === 'active' ? p('Active') : p('Archived')}</span></div>
                  {habit.description && <p>{habit.description}</p>}
                  {!readOnly && <div className="pro-actions">
                    <Button size="sm" disabled={!!pending} onClick={() => setEditing({ ...habit, targetValue: String(habit.targetValue) })} style={{ minHeight: '44px' }}>{p('Edit')}</Button>
                    <Button size="sm" disabled={!!pending} onClick={() => mutate(habit.id, () => communicationApi.updateHabit(athleteId, habit.id, { status: habit.status === 'active' ? 'archived' : 'active' }), habit.status === 'active' ? p('Habit archived.') : p('Habit reactivated.'))} style={{ minHeight: '44px' }}>{habit.status === 'active' ? p('Archive') : p('Reactivate')}</Button>
                    {confirmDelete === habit.id ? <span className="pro-inline-confirm"><span>{p('Delete this habit and its check-ins?')}</span><Button ref={confirmRef} size="sm" variant="danger" disabled={!!pending} onClick={() => mutate(habit.id, () => communicationApi.deleteHabit(athleteId, habit.id), p('Habit deleted.')).then(() => setConfirmDelete(null))} style={{ minHeight: '44px' }}>{p('Confirm delete')}</Button><Button size="sm" disabled={!!pending} onClick={() => setConfirmDelete(null)} style={{ minHeight: '44px' }}>{p('Cancel')}</Button></span>
                      : <Button size="sm" variant="danger" disabled={!!pending} onClick={() => setConfirmDelete(habit.id)} style={{ minHeight: '44px' }}>{p('Delete')}</Button>}
                  </div>}
                </>}
            </article>) : !habitsError && <EmptyState title={p('No habits yet')} text={readOnly ? p('There are no saved habits for this relationship.') : p('Create a measurable habit for this athlete.')} />}</div>
        {!readOnly && <form className="card pro-habit-create" onSubmit={create}>
          <h3>{p('Create habit')}</h3>
          <HabitFields value={draft} onChange={setDraft} disabled={pending === 'create'} prefix={`create-${link.id}`} />
          <Button variant="primary" disabled={!!pending || !draft.title.trim() || !(Number(draft.targetValue) > 0)} style={{ minHeight: '44px' }}>
            {pending === 'create' ? p('Saving…') : p('Create habit')}
          </Button>
        </form>}</>}
      <section aria-labelledby={`history-${link.id}`}><h3 id={`history-${link.id}`}>{p('Check-in history')}</h3>
        {historyLoading && checkins === null && <div className="pro-loading">{p('Loading check-in history…')}</div>}
        {historyError && <div className="pro-load-error" role="alert"><p>{checkins ? p('Could not refresh check-in history. Your previous check-ins are still shown.') : p('Could not load check-in history.')}</p><Button size="sm" onClick={() => load(period)} style={{ minHeight: '44px' }}>{p('Try again')}</Button></div>}
        {checkins?.length ? <ul className="pro-checkin-history">{checkins.map(checkin => <li key={checkin.id}><strong>{habitName.get(checkin.habitId) || p('Habit')}</strong><span>{formatCivilDay(checkin.date)} · {checkin.value} · {checkin.completed ? p('Completed') : p('Not completed')}</span>{checkin.notes && <p>{checkin.notes}</p>}</li>)}</ul>
          : checkins && !historyError && <p className="pro-empty-inline">{p('No check-ins in this period.')}</p>}
        {page?.hasMore && !historyError && <Button size="sm" disabled={historyLoading} onClick={() => load(period, page.nextCursor)} style={{ minHeight: '44px' }}>{historyLoading ? p('Loading…') : p('Load more check-ins')}</Button>}
      </section>
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

  useEffect(() => {
    if (habit.checkin) {
      setValue(String(habit.checkin.value ?? 0))
      setCompleted(habit.checkin.completed ?? false)
      setNotes(habit.checkin.notes ?? '')
    }
  }, [habit.checkin])

  const submit = async event => {
    if (event?.preventDefault) event.preventDefault()
    if (inFlight.current || readOnly) return
    inFlight.current = true
    const current = ++mutation.current
    setPending(true)
    setError('')
    setSuccess('')
    try {
      const result = await communicationApi.checkin(timeZone, {
        habitId: habit.id,
        date: habit.date,
        value: Number(value),
        completed,
        notes: notes.trim(),
      })
      if (current !== mutation.current) return
      await onSaved(result.checkin)
      setSuccess(p('Check-in saved.'))
    } catch (caught) {
      if (current === mutation.current) setError(professionalError(caught))
    } finally {
      inFlight.current = false
      if (current === mutation.current) setPending(false)
    }
  }

  const quickToggle = async () => {
    if (inFlight.current || readOnly) return
    inFlight.current = true
    const current = ++mutation.current
    setPending(true)
    setError('')
    setSuccess('')
    const nextCompleted = !completed
    const nextValue = nextCompleted ? Number(habit.targetValue || 1) : 0
    try {
      const result = await communicationApi.checkin(timeZone, {
        habitId: habit.id,
        date: habit.date,
        value: nextValue,
        completed: nextCompleted,
        notes: notes.trim(),
      })
      if (current !== mutation.current) return
      setCompleted(result.checkin.completed)
      setValue(String(result.checkin.value))
      await onSaved(result.checkin)
      setSuccess(p('Check-in saved.'))
    } catch (caught) {
      if (current === mutation.current) setError(professionalError(caught))
    } finally {
      inFlight.current = false
      if (current === mutation.current) setPending(false)
    }
  }

  return <article className="card pro-athlete-habit">
    <div className="pro-link-head">
      <div>
        <h3>{habit.title}</h3>
        <div className="pro-meta">{habit.targetValue} {habit.unit} · {frequencyLabel(habit.frequency)}</div>
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        {existing && <span className="pro-status active">{p('Saved')}</span>}
      </div>
    </div>
    {habit.description && <p>{habit.description}</p>}
    {readOnly ? (
      <p className="pro-readonly">{p('History only for this relationship.')}</p>
    ) : (
      <>
        <div className="pro-quick-checkin-row" style={{ margin: '8px 0 12px' }}>
          <Button
            size="sm"
            variant={completed ? 'secondary' : 'primary'}
            disabled={pending}
            onClick={quickToggle}
            style={{ minHeight: '44px', width: '100%' }}
          >
            {pending ? p('Saving…') : completed ? p('Mark as pending') : p('Complete today with 1 tap')}
          </Button>
        </div>
        <form onSubmit={submit}>
          <div className="pro-grid-fields">
            <label className="pro-field">
              <span>{p('Value')}</span>
              <Input type="number" min="0" step="any" value={value} disabled={pending} onChange={event => setValue(event.target.value)} style={{ minHeight: '44px' }} />
            </label>
            <label className="pro-check" style={{ minHeight: '44px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <input type="checkbox" checked={completed} disabled={pending} onChange={event => setCompleted(event.target.checked)} />
              <span>{p('Completed')}</span>
            </label>
          </div>
          <label className="pro-field">
            <span>{p('Notes')}</span>
            <Textarea value={notes} maxLength={500} rows={2} disabled={pending} onChange={event => setNotes(event.target.value)} style={{ minHeight: '44px' }} />
          </label>
          <Button variant="primary" disabled={pending || !Number.isFinite(Number(value))} style={{ minHeight: '44px' }}>
            {pending ? p('Saving…') : p('Save check-in')}
          </Button>
        </form>
      </>
    )}
    <LiveFeedback success={success} error={error} />
  </article>
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
  const [habitsLoading, setHabitsLoading] = useState(true)
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [habitsError, setHabitsError] = useState('')
  const [summaryError, setSummaryError] = useState('')
  const [historyError, setHistoryError] = useState('')
  const request = useRef(0)
  const historyRequest = useRef(0)

  useEffect(() => { if (!trainingLinks.some(link => link.id === selectedLink)) setSelectedLink(trainingLinks[0]?.id || '') }, [selectedLink, trainingLinks])
  const loadHabits = useCallback(async () => {
    const current = ++request.current
    setHabitsLoading(true)
    setHabitsError('')
    try {
      const result = await communicationApi.athleteHabits(zone.value)
      if (current === request.current) setHabits((result.habits || []).map(habit => ({ ...habit, date: result.date })))
    } catch (caught) { if (current === request.current) setHabitsError(professionalError(caught)) }
    finally { if (current === request.current) setHabitsLoading(false) }
  }, [zone.value])
  useEffect(() => { if (trainingLinks.length) loadHabits(); else { setHabits([]); setHabitsLoading(false) } }, [loadHabits, trainingLinks.length])

  const loadHistory = useCallback(async (linkId = selectedLink, nextPeriod = period, cursor = null) => {
    if (!linkId) return
    const current = ++historyRequest.current
    if (cursor) {
      setHistoryLoading(true); setHistoryError('')
      try {
        const result = await communicationApi.checkins({ side: 'athlete', linkId, period: nextPeriod, timeZone: zone.value, cursor })
        if (current !== historyRequest.current) return
        setCheckins(previous => mergeById(previous || [], result.checkins || []))
        setPage(result.page || null)
      } catch (caught) { if (current === historyRequest.current) setHistoryError(professionalError(caught)) }
      finally { if (current === historyRequest.current) setHistoryLoading(false) }
      return
    }
    setSummaryLoading(true); setHistoryLoading(true); setSummaryError(''); setHistoryError('')
    const results = await Promise.allSettled([
      communicationApi.summary({ side: 'athlete', linkId, period: nextPeriod, timeZone: zone.value }),
      communicationApi.checkins({ side: 'athlete', linkId, period: nextPeriod, timeZone: zone.value }),
    ])
    if (current !== historyRequest.current) return
    if (results[0].status === 'fulfilled') setSummary(results[0].value.summary || null)
    else setSummaryError(professionalError(results[0].reason))
    if (results[1].status === 'fulfilled') { setCheckins(results[1].value.checkins || []); setPage(results[1].value.page || null) }
    else setHistoryError(professionalError(results[1].reason))
    setSummaryLoading(false); setHistoryLoading(false)
  }, [period, selectedLink, zone.value])
  useEffect(() => { if (selectedLink) loadHistory(selectedLink, period) }, [loadHistory, period, selectedLink])
  const selected = trainingLinks.find(link => link.id === selectedLink)
  const habitNames = new Map((habits || []).map(habit => [habit.id, habit.title]))
  const savedCheckin = useCallback(async (habit, checkin) => {
    setHabits(current => current?.map(item => item.id === habit.id ? { ...item, checkin } : item))
    if (habit.relationship?.linkId === selectedLink) {
      setCheckins(current => current === null ? [checkin] : [checkin, ...current.filter(item => item.id !== checkin.id && (item.habitId !== checkin.habitId || item.date !== checkin.date))])
      await loadHistory(selectedLink, period)
    }
  }, [loadHistory, period, selectedLink])

  if (!trainingLinks.length) return null
  return <section aria-labelledby="athlete-habits-title">
    <h2 className="pro-section-title" id="athlete-habits-title">{p('My habits')}</h2>
    <div className="card pro-timezone">
      <strong>{p('Today in {0}', zone.value)}</strong>
      <span>{zone.fallback ? p('Your browser timezone was unavailable, so PR Fit is using UTC.') : p('PR Fit uses your browser IANA timezone for daily check-ins.')}</span>
    </div>
    {habitsLoading && habits === null ? <div className="pro-loading">{p('Loading habits…')}</div>
      : habitsError && habits === null ? <div className="pro-load-error" role="alert"><p>{p('Could not load habits.')}</p><Button size="sm" onClick={loadHabits} style={{ minHeight: '44px' }}>{p('Try again')}</Button></div>
        : <>{habitsError && <div className="pro-load-error" role="alert"><p>{p('Could not refresh habits. Your previous habits are still shown.')}</p><Button size="sm" onClick={loadHabits} style={{ minHeight: '44px' }}>{p('Try again')}</Button></div>}
          {habits?.length ? <div className="pro-list">{habits.map(habit => <AthleteCheckin key={habit.id} habit={habit} timeZone={zone.value} onSaved={checkin => savedCheckin(habit, checkin)} />)}</div>
            : !habitsError && <EmptyState title={p('No habits for today')} text={p('Your active scheduled habits will appear here.')} />}</>}
    <section className="card pro-own-history" aria-labelledby="athlete-history-title">
      <h3 id="athlete-history-title">{p('My adherence history')}</h3>
      <div className="pro-grid-fields">
        <label className="pro-field">
          <span>{p('Professional')}</span>
          <select value={selectedLink} onChange={event => setSelectedLink(event.target.value)} style={{ minHeight: '44px' }}>
            {trainingLinks.map(link => <option key={link.id} value={link.id}>{link.coach?.name || p('Unavailable account')} · {statusText(link.status)}</option>)}
          </select>
        </label>
        <label className="pro-field">
          <span>{p('Period')}</span>
          <select value={period} onChange={event => setPeriod(Number(event.target.value))} style={{ minHeight: '44px' }}>
            {PERIODS.map(days => <option key={days} value={days}>{p('{0} days', days)}</option>)}
          </select>
        </label>
      </div>
      {selected && relationshipReadOnly(selected) && <p className="pro-readonly">{p('This relationship is read-only. You can still review its history.')}</p>}
      {summaryLoading && summary === null && <div className="pro-loading">{p('Loading adherence summary…')}</div>}
      {summaryError && <div className="pro-load-error" role="alert"><p>{summary ? p('Could not refresh adherence. Your previous summary is still shown.') : p('Could not load adherence summary.')}</p><Button size="sm" onClick={() => loadHistory(selectedLink, period)} style={{ minHeight: '44px' }}>{p('Try again')}</Button></div>}
      <SummaryView summary={summary} />
      {!summaryLoading && !summaryError && summary === null && <p>{p('No adherence summary for this period.')}</p>}
      {historyLoading && checkins === null && <div className="pro-loading">{p('Loading check-in history…')}</div>}
      {historyError && <div className="pro-load-error" role="alert"><p>{checkins ? p('Could not refresh check-in history. Your previous check-ins are still shown.') : p('Could not load check-in history.')}</p><Button size="sm" onClick={() => loadHistory(selectedLink, period)} style={{ minHeight: '44px' }}>{p('Try again')}</Button></div>}
      {checkins?.length ? <ul className="pro-checkin-history">{checkins.map(checkin => <li key={checkin.id}><strong>{habitNames.get(checkin.habitId) || p('Habit')}</strong><span>{formatCivilDay(checkin.date)} · {checkin.value} · {checkin.completed ? p('Completed') : p('Not completed')}</span>{checkin.notes && <p>{checkin.notes}</p>}</li>)}</ul>
        : checkins && !historyError && <p>{p('No check-ins in this period.')}</p>}
      {page?.hasMore && !historyError && <Button size="sm" disabled={historyLoading} onClick={() => loadHistory(selectedLink, period, page.nextCursor)} style={{ minHeight: '44px' }}>{historyLoading ? p('Loading…') : p('Load more check-ins')}</Button>}
    </section>
  </section>
}
