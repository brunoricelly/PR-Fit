import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { api } from '../lib/api.js'
import {
  getCoachAvailability,
  updateCoachAvailability,
  getCoachAppointments,
  getCoachAthleteSlots,
  createCoachAppointment,
  getCoachAppointment,
  rescheduleCoachAppointment,
  cancelCoachAppointment,
  recordAttendance,
  getAthleteSlots,
  getAthleteAppointments,
  createAthleteAppointment,
  rescheduleAthleteAppointment,
  cancelAthleteAppointment,
  getReminderPreferences,
  updateReminderPreferences,
  ConflictError,
} from '../lib/scheduling-api.js'
import { dateLocale } from '../lib/i18n.js'
import { professionalError, professionalText as p } from '../lib/professional-copy.js'
import Icon from '../components/Icon.jsx'
import EmptyState from '../components/EmptyState.jsx'
import { Button, TextArea, TextField } from '../components/ui.jsx'
import './SchedulingView.css'

const WEEKDAYS = [
  { day: 0, key: 'Sunday' },
  { day: 1, key: 'Monday' },
  { day: 2, key: 'Tuesday' },
  { day: 3, key: 'Wednesday' },
  { day: 4, key: 'Thursday' },
  { day: 5, key: 'Friday' },
  { day: 6, key: 'Saturday' },
]

const REMINDER_OFFSETS = [
  { value: 15, label: '15 minutes before' },
  { value: 30, label: '30 minutes before' },
  { value: 60, label: '1 hour before' },
  { value: 120, label: '2 hours before' },
  { value: 1440, label: '24 hours before' },
]

export function AccessibleModal({ id, title, onClose, children, className = '' }) {
  const dialogRef = useRef(null)
  const previousFocusRef = useRef(null)

  useEffect(() => {
    previousFocusRef.current = document.activeElement
    const focusable = dialogRef.current?.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    )
    if (focusable && focusable.length > 0) {
      focusable[0].focus()
    } else {
      dialogRef.current?.focus()
    }

    const onKeyDown = event => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key === 'Tab') {
        const nodes = Array.from(dialogRef.current?.querySelectorAll(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        ) || [])
        if (!nodes.length) return
        const first = nodes[0]
        const last = nodes[nodes.length - 1]
        if (event.shiftKey) {
          if (document.activeElement === first) {
            event.preventDefault()
            last.focus()
          }
        } else {
          if (document.activeElement === last) {
            event.preventDefault()
            first.focus()
          }
        }
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      if (previousFocusRef.current && typeof previousFocusRef.current.focus === 'function') {
        previousFocusRef.current.focus()
      }
    }
  }, [onClose])

  return (
    <div className="pro-modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        tabIndex={-1}
        className={`pro-modal-container card ${className}`}
      >
        <div className="pro-modal-head">
          <h2 id={`${id}-title`}>{title}</h2>
          <button
            type="button"
            className="pro-modal-close"
            onClick={onClose}
            aria-label={p('Close')}
          >
            <Icon name="xmark" />
          </button>
        </div>
        <div className="pro-modal-body">
          {children}
        </div>
      </div>
    </div>
  )
}

function formatSlotTime(isoString, timeZone) {
  if (!isoString) return ''
  try {
    const d = new Date(isoString)
    return new Intl.DateTimeFormat(dateLocale(), {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: timeZone || undefined,
    }).format(d)
  } catch {
    return isoString.slice(11, 16)
  }
}

function formatFullDateTime(isoString, timeZone) {
  if (!isoString) return ''
  try {
    const d = new Date(isoString)
    return new Intl.DateTimeFormat(dateLocale(), {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: timeZone || undefined,
    }).format(d)
  } catch {
    return isoString
  }
}

function formatDateOnly(isoString, timeZone) {
  if (!isoString) return ''
  try {
    const d = new Date(isoString)
    return new Intl.DateTimeFormat(dateLocale(), {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: timeZone || undefined,
    }).format(d)
  } catch {
    return isoString.slice(0, 10)
  }
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const TIME_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/

export function civilTimeToIso(dateStr, timeStr, timeZone) {
  if (!dateStr || !timeStr) return null

  const dateMatch = DATE_RE.exec(String(dateStr).trim())
  const timeMatch = TIME_RE.exec(String(timeStr).trim())

  if (!dateMatch || !timeMatch) {
    try {
      return new Date(`${dateStr}T${timeStr}:00`).toISOString()
    } catch {
      return null
    }
  }

  const year = Number(dateMatch[1])
  const month = Number(dateMatch[2])
  const day = Number(dateMatch[3])
  const hour = Number(timeMatch[1])
  const minute = Number(timeMatch[2])
  const second = timeMatch[3] ? Number(timeMatch[3]) : 0

  let tz = timeZone
  if (!tz) {
    try {
      tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    } catch {
      tz = 'UTC'
    }
  }

  let formatter
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
  } catch {
    try {
      formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'UTC',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      })
      tz = 'UTC'
    } catch {
      return new Date(Date.UTC(year, month - 1, day, hour, minute, second)).toISOString()
    }
  }

  const targetUtc = Date.UTC(year, month - 1, day, hour, minute, second, 0)

  function getZonedWallEpoch(timestampMs) {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(timestampMs)).map(p => [p.type, p.value])
    )
    const h = parts.hour === '24' ? 0 : Number(parts.hour)
    return Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      h,
      Number(parts.minute),
      Number(parts.second)
    )
  }

  const offsets = new Set()
  for (let delta = -36; delta <= 36; delta += 6) {
    const sample = targetUtc + delta * 3600000
    offsets.add(getZonedWallEpoch(sample) - sample)
  }

  const pad = n => String(n).padStart(2, '0')
  const expectedDate = `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`
  const expectedTime = `${pad(hour)}:${pad(minute)}`

  for (const offset of offsets) {
    const candidate = targetUtc - offset
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(candidate)).map(p => [p.type, p.value])
    )
    const h = parts.hour === '24' ? 0 : Number(parts.hour)
    const cDate = `${parts.year}-${parts.month}-${parts.day}`
    const cTime = `${pad(h)}:${parts.minute}`
    if (cDate === expectedDate && cTime === expectedTime) {
      return new Date(candidate).toISOString()
    }
  }

  const offset = getZonedWallEpoch(targetUtc) - targetUtc
  return new Date(targetUtc - offset).toISOString()
}

export function getZonedDateStr(isoString, timeZone) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      timeZone: timeZone || undefined,
    }).format(new Date(isoString))
  } catch {
    return isoString?.slice(0, 10) || ''
  }
}

export function getZonedTimeStr(isoString, timeZone) {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone: timeZone || undefined,
    }).format(new Date(isoString))
  } catch {
    return '09:00'
  }
}

// ==========================================
// Coach Availability Editor
// ==========================================
export function CoachAvailabilityEditor() {
  const toast = useUI(state => state.toast)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [saving, setSaving] = useState(false)
  const [availability, setAvailability] = useState(null)
  const [futureConflicts, setFutureConflicts] = useState([])

  const defaultTz = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Sao_Paulo'
    } catch {
      return 'America/Sao_Paulo'
    }
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(false)
    setFutureConflicts([])
    try {
      const res = await getCoachAvailability()
      if (res?.availability) {
        setAvailability(res.availability)
      } else {
        setAvailability({
          timeZone: defaultTz,
          sessionDurationMinutes: 60,
          bufferMinutes: 0,
          minNoticeHours: 2,
          maxAdvanceDays: 30,
          windows: [1, 2, 3, 4, 5].map(dayOfWeek => ({ dayOfWeek, start: '09:00', end: '17:00' })),
          exceptions: [],
          _rev: 0,
        })
      }
    } catch {
      setLoadError(true)
    } finally {
      setLoading(false)
    }
  }, [defaultTz])

  useEffect(() => { load() }, [load])

  const handleFieldChange = (key, val) => {
    setAvailability(prev => ({ ...prev, [key]: val }))
  }

  const addWindow = dayOfWeek => {
    setAvailability(prev => {
      const nextWindows = [...(prev.windows || []), { dayOfWeek, start: '09:00', end: '17:00' }]
      return { ...prev, windows: nextWindows }
    })
  }

  const updateWindow = (index, field, value) => {
    setAvailability(prev => {
      const next = [...prev.windows]
      next[index] = { ...next[index], [field]: value }
      return { ...prev, windows: next }
    })
  }

  const removeWindow = index => {
    setAvailability(prev => {
      const next = prev.windows.filter((_, i) => i !== index)
      return { ...prev, windows: next }
    })
  }

  const addException = () => {
    const today = new Date().toISOString().slice(0, 10)
    setAvailability(prev => ({
      ...prev,
      exceptions: [
        ...(prev.exceptions || []),
        { date: today, unavailable: true, windows: [] },
      ],
    }))
  }

  const updateException = (index, updates) => {
    setAvailability(prev => {
      const next = [...prev.exceptions]
      next[index] = { ...next[index], ...updates }
      return { ...prev, exceptions: next }
    })
  }

  const removeException = index => {
    setAvailability(prev => ({
      ...prev,
      exceptions: prev.exceptions.filter((_, i) => i !== index),
    }))
  }

  const handleSave = async () => {
    setSaving(true)
    setFutureConflicts([])
    try {
      const payload = {
        timeZone: availability.timeZone || defaultTz,
        sessionDurationMinutes: Number(availability.sessionDurationMinutes) || 60,
        bufferMinutes: Number(availability.bufferMinutes) || 0,
        minNoticeHours: Number(availability.minNoticeHours) || 0,
        maxAdvanceDays: Number(availability.maxAdvanceDays) || 30,
        windows: availability.windows || [],
        exceptions: availability.exceptions || [],
      }
      const res = await updateCoachAvailability(payload, availability._rev ?? 0)
      if (res?.availability) {
        setAvailability(res.availability)
      }
      if (res?.futureConflicts && res.futureConflicts.length > 0) {
        setFutureConflicts(res.futureConflicts)
      }
      toast(p('Availability saved.'))
    } catch (err) {
      if (err instanceof ConflictError || err?.status === 409) {
        toast(p('Revision conflict. Your availability was updated elsewhere. Please refresh and try again.'))
      } else {
        toast(professionalError(err))
      }
    } finally {
      setSaving(false)
    }
  }

  if (loading && !availability) {
    return <div className="pro-loading">{p('Loading…')}</div>
  }

  if (loadError) {
    return (
      <div className="card pro-load-error" role="alert">
        <p>{p('Could not load availability.')}</p>
        <Button size="sm" onClick={load}>{p('Try again')}</Button>
      </div>
    )
  }

  return (
    <section className="pro-sched-section" aria-labelledby="coach-availability-heading">
      <div className="pro-panel-head">
        <h2 id="coach-availability-heading" className="pro-section-title">{p('Availability')}</h2>
        <Button variant="primary" disabled={saving} onClick={handleSave}>
          {saving ? p('Saving availability…') : p('Save availability')}
        </Button>
      </div>

      {futureConflicts.length > 0 && (
        <div className="pro-sched-conflict-alert" role="alert">
          {p('Future conflicts detected: {0} appointment(s) may be impacted.', futureConflicts.length)}
        </div>
      )}

      <div className="card pro-sched-form">
        <div className="pro-grid-fields">
          <label className="pro-field">
            <span>{p('Session duration (minutes)')}</span>
            <TextField
              name="sessionDurationMinutes"
              type="number"
              min="15"
              max="240"
              step="15"
              value={availability.sessionDurationMinutes ?? 60}
              onChange={e => handleFieldChange('sessionDurationMinutes', parseInt(e.target.value, 10))}
            />
          </label>
          <label className="pro-field">
            <span>{p('Buffer (minutes)')}</span>
            <TextField
              name="bufferMinutes"
              type="number"
              min="0"
              max="120"
              step="5"
              value={availability.bufferMinutes ?? 0}
              onChange={e => handleFieldChange('bufferMinutes', parseInt(e.target.value, 10))}
            />
          </label>
          <label className="pro-field">
            <span>{p('Minimum notice (hours)')}</span>
            <TextField
              name="minNoticeHours"
              type="number"
              min="0"
              max="720"
              value={availability.minNoticeHours ?? 2}
              onChange={e => handleFieldChange('minNoticeHours', parseInt(e.target.value, 10))}
            />
          </label>
          <label className="pro-field">
            <span>{p('Maximum advance notice (days)')}</span>
            <TextField
              name="maxAdvanceDays"
              type="number"
              min="1"
              max="365"
              value={availability.maxAdvanceDays ?? 30}
              onChange={e => handleFieldChange('maxAdvanceDays', parseInt(e.target.value, 10))}
            />
          </label>
        </div>

        <label className="pro-field">
          <span>{p('Default timezone')}</span>
          <TextField
            name="timeZone"
            value={availability.timeZone || defaultTz}
            onChange={e => handleFieldChange('timeZone', e.target.value)}
          />
        </label>
      </div>

      <div className="card">
        <h3 className="pro-card-title">{p('Weekly windows')}</h3>
        <div className="pro-sched-windows">
          {WEEKDAYS.map(weekday => {
            const dayWindows = (availability.windows || [])
              .map((w, index) => ({ ...w, originalIndex: index }))
              .filter(w => w.dayOfWeek === weekday.day)

            return (
              <div key={weekday.day} className="pro-sched-day-row">
                <div className="pro-sched-day-head">
                  <span className="pro-sched-day-name">{p(weekday.key)}</span>
                  <Button size="sm" onClick={() => addWindow(weekday.day)}>
                    {p('Add window')}
                  </Button>
                </div>
                {dayWindows.length === 0 ? (
                  <span className="dim small">{p('Day off')}</span>
                ) : (
                  <div className="pro-sched-day-windows">
                    {dayWindows.map(w => (
                      <div key={w.originalIndex} className="pro-sched-window-item">
                        <input
                          type="time"
                          aria-label={`${p(weekday.key)} ${p('Start')}`}
                          value={w.start}
                          onChange={e => updateWindow(w.originalIndex, 'start', e.target.value)}
                        />
                        <span>–</span>
                        <input
                          type="time"
                          aria-label={`${p(weekday.key)} ${p('End')}`}
                          value={w.end}
                          onChange={e => updateWindow(w.originalIndex, 'end', e.target.value)}
                        />
                        <Button
                          size="sm"
                          variant="danger"
                          aria-label={p('Remove window')}
                          onClick={() => removeWindow(w.originalIndex)}
                        >
                          <Icon name="xmark" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      <div className="card">
        <div className="pro-panel-head">
          <h3 className="pro-card-title">{p('Date exceptions')}</h3>
          <Button size="sm" onClick={addException}>
            {p('Add exception')}
          </Button>
        </div>

        {(availability.exceptions || []).length === 0 ? (
          <p className="dim small">{p('No date exceptions configured.') || 'Nenhuma exceção configurada.'}</p>
        ) : (
          <div className="pro-sched-exceptions">
            {availability.exceptions.map((ex, index) => (
              <div key={index} className="pro-sched-exception-item">
                <div className="pro-panel-head">
                  <TextField
                    type="date"
                    name={`exception-date-${index}`}
                    aria-label={p('Date')}
                    value={ex.date}
                    onChange={e => updateException(index, { date: e.target.value })}
                  />
                  <Button
                    size="sm"
                    variant="danger"
                    aria-label={p('Remove exception')}
                    onClick={() => removeException(index)}
                  >
                    {p('Remove exception')}
                  </Button>
                </div>
                <label className="pro-check">
                  <input
                    type="checkbox"
                    checked={ex.unavailable}
                    onChange={e => updateException(index, { unavailable: e.target.checked })}
                  />
                  <span>{p('Blackout date')}</span>
                </label>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

// ==========================================
// Appointment Modals
// ==========================================
export function AppointmentDetailModal({ appointment, onClose, onReschedule, onCancel, onAttendance }) {
  if (!appointment) return null
  const now = Date.now()
  const ended = now >= Date.parse(appointment.endAt)
  const lifecycle = appointment.lifecycle || {}
  const allowed = lifecycle.allowedActions || []
  const readOnly = !!lifecycle.readOnly

  return (
    <AccessibleModal id="appointment-detail" title={p('Session details')} onClose={onClose}>
      <div className="pro-sched-card-details">
        <div className="pro-sched-badges" style={{ marginBottom: 10 }}>
          <span className={`pro-sched-badge ${appointment.status}`}>{p(appointment.status === 'scheduled' ? 'Scheduled' : appointment.status === 'completed' ? 'Completed' : appointment.status === 'canceled' ? 'Canceled' : 'No-show')}</span>
          <span className="pro-sched-badge info">{p(appointment.type === 'in_person' ? 'In person' : 'Online')}</span>
          {lifecycle.historical && <span className="pro-sched-badge historical">{p('Historical')}</span>}
          {readOnly && <span className="pro-sched-badge readonly">{p('Read-only')}</span>}
        </div>

        <div className="detail-row">
          <span className="detail-label">{p('Title')}:</span>
          <strong>{appointment.title || p('New session')}</strong>
        </div>
        <div className="detail-row">
          <span className="detail-label">{p('Date')}:</span>
          <span>{formatDateOnly(appointment.startAt, appointment.timeZone)}</span>
        </div>
        <div className="detail-row">
          <span className="detail-label">{p('Time')}:</span>
          <span>{formatSlotTime(appointment.startAt, appointment.timeZone)} – {formatSlotTime(appointment.endAt, appointment.timeZone)}</span>
        </div>
        <div className="detail-row">
          <span className="detail-label">{p('Duration')}:</span>
          <span>{appointment.durationMinutes} min</span>
        </div>
        <div className="detail-row">
          <span className="detail-label">{p('Timezone')}:</span>
          <span>{appointment.timeZone}</span>
        </div>
        {appointment.coach && (
          <div className="detail-row">
            <span className="detail-label">{p('Coach')}:</span>
            <span>{appointment.coach.name}</span>
          </div>
        )}
        {appointment.athlete && (
          <div className="detail-row">
            <span className="detail-label">{p('Athlete')}:</span>
            <span>{appointment.athlete.name}</span>
          </div>
        )}
        {appointment.location && (
          <div className="detail-row">
            <span className="detail-label">{p('Location')}:</span>
            <span>{appointment.location}</span>
          </div>
        )}
        {appointment.meetingUrl && (
          <div className="detail-row">
            <span className="detail-label">{p('Meeting link')}:</span>
            <a href={appointment.meetingUrl} target="_blank" rel="noreferrer">{appointment.meetingUrl}</a>
          </div>
        )}
        {appointment.notes && (
          <div className="detail-row">
            <span className="detail-label">{p('Notes')}:</span>
            <p style={{ margin: 0 }}>{appointment.notes}</p>
          </div>
        )}
        {appointment.cancellation && (
          <div className="detail-row" style={{ marginTop: 8, color: 'var(--red)' }}>
            <span className="detail-label">{p('Cancellation reason')}:</span>
            <span>{appointment.cancellation.reason} ({p('Canceled by {0}', appointment.cancellation.actor)})</span>
          </div>
        )}
        {appointment.attendance && (
          <div className="detail-row" style={{ marginTop: 8 }}>
            <span className="detail-label">{p('Attendance')}:</span>
            <span>{p(appointment.attendance.state === 'attended' ? 'Attended' : 'Missed')}</span>
          </div>
        )}

        <div className="pro-sched-actions" style={{ marginTop: 14 }}>
          {!readOnly && allowed.includes('reschedule') && (
            <Button size="sm" onClick={() => onReschedule(appointment)}>
              {p('Reschedule')}
            </Button>
          )}
          {!readOnly && allowed.includes('cancel') && (
            <Button size="sm" variant="danger" onClick={() => onCancel(appointment)}>
              {p('Cancel session')}
            </Button>
          )}
          {!readOnly && allowed.includes('attendance') && ended && (
            <Button size="sm" variant="tinted" onClick={() => onAttendance(appointment)}>
              {p('Record attendance')}
            </Button>
          )}
        </div>
      </div>
    </AccessibleModal>
  )
}

export function RescheduleModal({ appointment, onClose, onSave, isCoach = true }) {
  const [newDate, setNewDate] = useState(() => appointment?.localDate || (appointment?.startAt ? getZonedDateStr(appointment.startAt, appointment.timeZone) : new Date().toISOString().slice(0, 10)))
  const [newTime, setNewTime] = useState(() => appointment?.startAt ? getZonedTimeStr(appointment.startAt, appointment.timeZone) : '09:00')
  const [submitting, setSubmitting] = useState(false)
  const toast = useUI(state => state.toast)

  const handleSubmit = async e => {
    e?.preventDefault()
    if (!newDate || !newTime) return
    setSubmitting(true)
    try {
      const timeZone = appointment?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Sao_Paulo'
      const startAt = civilTimeToIso(newDate, newTime, timeZone)
      if (isCoach) {
        await rescheduleCoachAppointment(appointment.id, { startAt })
      } else {
        await rescheduleAthleteAppointment(appointment.id, { startAt })
      }
      toast(p('Appointment rescheduled.'))
      onSave()
      onClose()
    } catch (err) {
      if (err instanceof ConflictError || err?.status === 409) {
        toast(p('This slot is no longer available. Please select another time.'))
      } else {
        toast(professionalError(err))
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AccessibleModal id="reschedule-modal" title={p('Reschedule session')} onClose={onClose}>
      <form onSubmit={handleSubmit} className="pro-sched-form">
        <label className="pro-sched-form-row">
          <span>{p('Date')}</span>
          <TextField
            type="date"
            name="rescheduleDate"
            value={newDate}
            onChange={e => setNewDate(e.target.value)}
            required
          />
        </label>
        <label className="pro-sched-form-row">
          <span>{p('Start time')}</span>
          <TextField
            type="time"
            name="rescheduleTime"
            value={newTime}
            onChange={e => setNewTime(e.target.value)}
            required
          />
        </label>
        <div className="pro-actions">
          <Button type="button" onClick={onClose}>{p('Cancel')}</Button>
          <Button variant="primary" type="submit" disabled={submitting || !newDate || !newTime}>
            {submitting ? p('Rescheduling…') : p('Reschedule')}
          </Button>
        </div>
      </form>
    </AccessibleModal>
  )
}

export function CancelModal({ appointment, onClose, onSave, isCoach = true }) {
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const toast = useUI(state => state.toast)

  const handleSubmit = async e => {
    e?.preventDefault()
    if (!reason.trim()) {
      toast(p('Provide a reason for cancellation.'))
      return
    }
    setSubmitting(true)
    try {
      if (isCoach) {
        await cancelCoachAppointment(appointment.id, { reason: reason.trim() })
      } else {
        await cancelAthleteAppointment(appointment.id, { reason: reason.trim() })
      }
      toast(p('Appointment canceled.'))
      onSave()
      onClose()
    } catch (err) {
      toast(professionalError(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AccessibleModal id="cancel-modal" title={p('Cancel appointment')} onClose={onClose}>
      <form onSubmit={handleSubmit} className="pro-sched-form">
        <label className="pro-sched-form-row">
          <span>{p('Reason for cancellation')}</span>
          <TextArea
            name="cancelReason"
            value={reason}
            placeholder={p('Enter cancellation reason')}
            maxLength={500}
            rows={3}
            onChange={e => setReason(e.target.value)}
            required
          />
        </label>
        <div className="pro-actions">
          <Button type="button" onClick={onClose}>{p('Close')}</Button>
          <Button variant="danger" type="submit" disabled={submitting || !reason.trim()}>
            {submitting ? p('Canceling…') : p('Cancel appointment')}
          </Button>
        </div>
      </form>
    </AccessibleModal>
  )
}

export function AttendanceModal({ appointment, onClose, onSave }) {
  const [status, setStatus] = useState('completed')
  const [submitting, setSubmitting] = useState(false)
  const toast = useUI(state => state.toast)

  const handleSubmit = async e => {
    e?.preventDefault()
    if (Date.now() < Date.parse(appointment.endAt)) {
      toast(p('Attendance can only be recorded after the session has ended.'))
      return
    }
    setSubmitting(true)
    try {
      await recordAttendance(appointment.id, { status })
      toast(p('Attendance recorded.'))
      onSave()
      onClose()
    } catch (err) {
      toast(professionalError(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AccessibleModal id="attendance-modal" title={p('Record attendance')} onClose={onClose}>
      <form onSubmit={handleSubmit} className="pro-sched-form">
        <label className="pro-sched-form-row">
          <span>{p('Status')}</span>
          <select value={status} onChange={e => setStatus(e.target.value)}>
            <option value="completed">{p('Attended')}</option>
            <option value="no_show">{p('No-show')}</option>
          </select>
        </label>
        <div className="pro-actions">
          <Button type="button" onClick={onClose}>{p('Cancel')}</Button>
          <Button variant="primary" type="submit" disabled={submitting}>
            {submitting ? p('Recording…') : p('Record attendance')}
          </Button>
        </div>
      </form>
    </AccessibleModal>
  )
}

export function CreateCoachAppointmentModal({ links, defaultAthleteId, onClose, onSave, coachTimeZone }) {
  const toast = useUI(state => state.toast)
  const [athleteId, setAthleteId] = useState(() => defaultAthleteId || links[0]?.athlete?.id || '')
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [slots, setSlots] = useState([])
  const [slotsLoading, setSlotsLoading] = useState(false)
  const [selectedSlot, setSelectedSlot] = useState(null)
  const [type, setType] = useState('in_person')
  const [title, setTitle] = useState('')
  const [notes, setNotes] = useState('')
  const [location, setLocation] = useState('')
  const [meetingUrl, setMeetingUrl] = useState('')
  const [manualTime, setManualTime] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [effectiveTimeZone, setEffectiveTimeZone] = useState(coachTimeZone || null)
  const slotsRequestIdRef = useRef(0)

  const loadSlots = useCallback(async () => {
    if (!athleteId || !date) return
    const reqId = ++slotsRequestIdRef.current
    setSlotsLoading(true)
    try {
      const res = await getCoachAthleteSlots(athleteId, { date })
      if (reqId !== slotsRequestIdRef.current) return
      setSlots(res?.items || [])
      if (res?.timeZone) setEffectiveTimeZone(res.timeZone)
      setSelectedSlot(null)
    } catch {
      if (reqId !== slotsRequestIdRef.current) return
      setSlots([])
    } finally {
      if (reqId === slotsRequestIdRef.current) {
        setSlotsLoading(false)
      }
    }
  }, [athleteId, date])

  useEffect(() => { loadSlots() }, [loadSlots])

  const handleSubmit = async e => {
    e?.preventDefault()
    if (!athleteId) {
      toast(p('Select athlete'))
      return
    }
    const targetTz = effectiveTimeZone || (slots[0]?.timeZone) || coachTimeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Sao_Paulo'
    const startAt = selectedSlot ? selectedSlot.startAt : (date && manualTime ? civilTimeToIso(date, manualTime, targetTz) : null)
    if (!startAt) {
      toast(p('Select a slot'))
      return
    }

    setSubmitting(true)
    try {
      const payload = {
        type,
        title: title.trim() || p('New session'),
        notes: notes.trim(),
        startAt,
        ...(selectedSlot ? { endAt: selectedSlot.endAt } : {}),
        ...(type === 'in_person' && location.trim() ? { location: location.trim() } : {}),
        ...(type === 'online' && meetingUrl.trim() ? { meetingUrl: meetingUrl.trim() } : {}),
      }
      await createCoachAppointment(athleteId, payload)
      toast(p('Session booked successfully.'))
      onSave()
      onClose()
    } catch (err) {
      if (err instanceof ConflictError || err?.status === 409) {
        toast(p('This slot is no longer available. Please select another time.'))
        loadSlots()
      } else {
        toast(professionalError(err))
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AccessibleModal id="coach-create-appointment" title={p('Schedule session')} onClose={onClose}>
      <form onSubmit={handleSubmit} className="pro-sched-form">
        <label className="pro-sched-form-row">
          <span>{p('Athlete')}</span>
          <select value={athleteId} onChange={e => setAthleteId(e.target.value)} required>
            {links.map(l => (
              <option key={l.athlete?.id || l.id} value={l.athlete?.id}>
                {l.athlete?.name || p('Unavailable account')}
              </option>
            ))}
          </select>
        </label>

        <label className="pro-sched-form-row">
          <span>{p('Date')}</span>
          <TextField
            type="date"
            name="createDate"
            value={date}
            onChange={e => setDate(e.target.value)}
            required
          />
        </label>

        <div className="pro-sched-form-row">
          <span>{p('Available slots')}</span>
          {slotsLoading ? (
            <div className="pro-loading">{p('Loading…')}</div>
          ) : slots.length === 0 ? (
            <div className="pro-sched-manual-time">
              <p className="dim small">{p('No free slots available for this period.')}</p>
              <TextField
                type="time"
                name="manualTime"
                placeholder="HH:MM"
                value={manualTime}
                onChange={e => setManualTime(e.target.value)}
              />
            </div>
          ) : (
            <div className="pro-sched-slots" role="group" aria-label={p('Available slots')}>
              {slots.map(slot => {
                const isSelected = selectedSlot?.startAt === slot.startAt
                return (
                  <button
                    key={slot.startAt}
                    type="button"
                    className={`pro-sched-slot-btn ${isSelected ? 'selected' : ''}`}
                    onClick={() => { setSelectedSlot(slot); setManualTime('') }}
                    aria-pressed={isSelected}
                  >
                    <span className="pro-sched-slot-time">{formatSlotTime(slot.startAt, slot.timeZone)}</span>
                    <span className="pro-sched-slot-dur">{slot.durationMinutes} min</span>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        <label className="pro-sched-form-row">
          <span>{p('Type')}</span>
          <select value={type} onChange={e => setType(e.target.value)}>
            <option value="in_person">{p('In person')}</option>
            <option value="online">{p('Online')}</option>
          </select>
        </label>

        {type === 'in_person' ? (
          <label className="pro-sched-form-row">
            <span>{p('Location')}</span>
            <TextField
              name="location"
              value={location}
              placeholder={p('Location')}
              maxLength={200}
              onChange={e => setLocation(e.target.value)}
            />
          </label>
        ) : (
          <label className="pro-sched-form-row">
            <span>{p('Meeting link')}</span>
            <TextField
              name="meetingUrl"
              value={meetingUrl}
              placeholder="https://..."
              maxLength={500}
              onChange={e => setMeetingUrl(e.target.value)}
            />
          </label>
        )}

        <label className="pro-sched-form-row">
          <span>{p('Title')}</span>
          <TextField
            name="title"
            value={title}
            placeholder={p('Session title')}
            maxLength={120}
            onChange={e => setTitle(e.target.value)}
          />
        </label>

        <label className="pro-sched-form-row">
          <span>{p('Notes')}</span>
          <TextArea
            name="notes"
            value={notes}
            placeholder={p('Notes')}
            maxLength={1000}
            rows={2}
            onChange={e => setNotes(e.target.value)}
          />
        </label>

        <div className="pro-actions">
          <Button type="button" onClick={onClose}>{p('Cancel')}</Button>
          <Button variant="primary" type="submit" disabled={submitting || (!selectedSlot && !manualTime)}>
            {submitting ? p('Confirming…') : p('Confirm booking')}
          </Button>
        </div>
      </form>
    </AccessibleModal>
  )
}

// ==========================================
// Coach Appointments View
// ==========================================
export function CoachAppointmentsView({ links = [] }) {
  const [appointments, setAppointments] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [athleteFilter, setAthleteFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [viewMode, setViewMode] = useState('list') // 'list' | 'calendar'
  const [cursor, setCursor] = useState(null)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)

  // Modals
  const [detailItem, setDetailItem] = useState(null)
  const [rescheduleItem, setRescheduleItem] = useState(null)
  const [cancelItem, setCancelItem] = useState(null)
  const [attendanceItem, setAttendanceItem] = useState(null)
  const [createOpen, setCreateOpen] = useState(false)

  const activeRequestIdRef = useRef(0)

  const loadAppointments = useCallback(async (isLoadMore = false) => {
    const requestId = ++activeRequestIdRef.current
    if (isLoadMore) setLoadingMore(true)
    else setLoading(true)
    setLoadError(false)

    try {
      const params = {
        limit: 20,
        ...(athleteFilter ? { athleteId: athleteFilter } : {}),
        ...(statusFilter ? { status: statusFilter } : {}),
        ...(fromDate ? { from: fromDate } : {}),
        ...(toDate ? { to: toDate } : {}),
        ...(isLoadMore && cursor ? { cursor } : {}),
      }
      const res = await getCoachAppointments(params)
      if (requestId !== activeRequestIdRef.current) return
      const items = res?.items || []
      if (isLoadMore) {
        setAppointments(prev => [...prev, ...items])
      } else {
        setAppointments(items)
      }
      setCursor(res?.nextCursor || null)
      setHasMore(!!res?.hasMore)
    } catch {
      if (requestId !== activeRequestIdRef.current) return
      setLoadError(true)
    } finally {
      if (requestId === activeRequestIdRef.current) {
        setLoading(false)
        setLoadingMore(false)
      }
    }
  }, [athleteFilter, statusFilter, fromDate, toDate, cursor])

  useEffect(() => {
    setCursor(null)
    loadAppointments(false)
  }, [athleteFilter, statusFilter, fromDate, toDate])

  return (
    <section className="pro-sched-section" aria-labelledby="coach-appointments-heading">
      <div className="pro-panel-head">
        <h2 id="coach-appointments-heading" className="pro-section-title">{p('Appointments')}</h2>
        {links.length > 0 && (
          <Button variant="primary" onClick={() => setCreateOpen(true)}>
            {p('New session')}
          </Button>
        )}
      </div>

      <div className="pro-sched-filters">
        <label>
          <span>{p('Filter by athlete')}</span>
          <select value={athleteFilter} onChange={e => setAthleteFilter(e.target.value)}>
            <option value="">{p('All athletes')}</option>
            {links.map(l => (
              <option key={l.athlete?.id || l.id} value={l.athlete?.id}>
                {l.athlete?.name || p('Unavailable account')}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>{p('Filter by status')}</span>
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
            <option value="">{p('All statuses')}</option>
            <option value="scheduled">{p('Scheduled')}</option>
            <option value="completed">{p('Completed')}</option>
            <option value="canceled">{p('Canceled')}</option>
            <option value="no_show">{p('No-show')}</option>
          </select>
        </label>

        <label>
          <span>{p('Date')} ({p('Start')})</span>
          <input
            type="date"
            aria-label={`${p('Date')} ${p('Start')}`}
            value={fromDate}
            onChange={e => setFromDate(e.target.value)}
          />
        </label>

        <label>
          <span>{p('Date')} ({p('End')})</span>
          <input
            type="date"
            aria-label={`${p('Date')} ${p('End')}`}
            value={toDate}
            onChange={e => setToDate(e.target.value)}
          />
        </label>

        <div className="pro-sched-view-toggle">
          <Button
            size="sm"
            variant={viewMode === 'list' ? 'tinted' : 'ghost'}
            aria-label={p('List view')}
            onClick={() => setViewMode('list')}
          >
            <Icon name="list" />
          </Button>
          <Button
            size="sm"
            variant={viewMode === 'calendar' ? 'tinted' : 'ghost'}
            aria-label={p('Calendar view')}
            onClick={() => setViewMode('calendar')}
          >
            <Icon name="calendar" />
          </Button>
        </div>
      </div>

      {loading && appointments.length === 0 ? (
        <div className="pro-loading">{p('Loading…')}</div>
      ) : loadError ? (
        <div className="card pro-load-error" role="alert">
          <p>{p('Could not load appointments.')}</p>
          <Button size="sm" onClick={() => loadAppointments(false)}>{p('Try again')}</Button>
        </div>
      ) : appointments.length === 0 ? (
        <EmptyState
          icon="calendar"
          title={p('No appointments found')}
          text={p('No appointments scheduled.')}
        />
      ) : viewMode === 'calendar' ? (
        <div className="pro-sched-table-wrap">
          <table className="pro-data-table" role="table">
            <caption className="sr-only">{p('Calendar view')}</caption>
            <thead>
              <tr>
                <th scope="col">{p('Date')}</th>
                <th scope="col">{p('Time')}</th>
                <th scope="col">{p('Athlete')}</th>
                <th scope="col">{p('Type')}</th>
                <th scope="col">{p('Status')}</th>
                <th scope="col">{p('Allowed actions')}</th>
              </tr>
            </thead>
            <tbody>
              {appointments.map(item => (
                <tr key={item.id}>
                  <td>{formatDateOnly(item.startAt, item.timeZone)}</td>
                  <td>{formatSlotTime(item.startAt, item.timeZone)} – {formatSlotTime(item.endAt, item.timeZone)}</td>
                  <td>{item.athlete?.name || p('Unavailable account')}</td>
                  <td>{p(item.type === 'in_person' ? 'In person' : 'Online')}</td>
                  <td>
                    <span className={`pro-sched-badge ${item.status}`}>
                      {p(item.status === 'scheduled' ? 'Scheduled' : item.status === 'completed' ? 'Completed' : item.status === 'canceled' ? 'Canceled' : 'No-show')}
                    </span>
                  </td>
                  <td>
                    <Button size="sm" onClick={() => setDetailItem(item)}>{p('Session details')}</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="pro-sched-grid">
          {appointments.map(item => {
            const ended = Date.now() >= Date.parse(item.endAt)
            const allowed = item.lifecycle?.allowedActions || []
            const readOnly = !!item.lifecycle?.readOnly

            return (
              <article key={item.id} className="pro-sched-card">
                <div className="pro-sched-card-head">
                  <div>
                    <h3 className="pro-sched-card-title">{item.title || p('New session')}</h3>
                    <div className="pro-sched-card-meta">
                      <span>{item.athlete?.name}</span>
                      <span>·</span>
                      <span>{formatFullDateTime(item.startAt, item.timeZone)}</span>
                    </div>
                  </div>
                  <div className="pro-sched-badges">
                    <span className={`pro-sched-badge ${item.status}`}>
                      {p(item.status === 'scheduled' ? 'Scheduled' : item.status === 'completed' ? 'Completed' : item.status === 'canceled' ? 'Canceled' : 'No-show')}
                    </span>
                    <span className="pro-sched-badge info">{p(item.type === 'in_person' ? 'In person' : 'Online')}</span>
                    {item.lifecycle?.historical && <span className="pro-sched-badge historical">{p('Historical')}</span>}
                    {readOnly && <span className="pro-sched-badge readonly">{p('Read-only')}</span>}
                  </div>
                </div>

                {item.location && <div className="small dim">{p('Location')}: {item.location}</div>}
                {item.meetingUrl && <div className="small dim">{p('Meeting link')}: <a href={item.meetingUrl} target="_blank" rel="noreferrer">{item.meetingUrl}</a></div>}
                {item.cancellation && <div className="small" style={{ color: 'var(--red)' }}>{p('Canceled by {0}', item.cancellation.actor)}: {item.cancellation.reason}</div>}

                <div className="pro-sched-actions">
                  <Button size="sm" onClick={() => setDetailItem(item)}>
                    {p('Session details')}
                  </Button>
                  {!readOnly && allowed.includes('reschedule') && (
                    <Button size="sm" onClick={() => setRescheduleItem(item)}>
                      {p('Reschedule')}
                    </Button>
                  )}
                  {!readOnly && allowed.includes('cancel') && (
                    <Button size="sm" variant="danger" onClick={() => setCancelItem(item)}>
                      {p('Cancel session')}
                    </Button>
                  )}
                  {!readOnly && allowed.includes('attendance') && ended && (
                    <Button size="sm" variant="tinted" onClick={() => setAttendanceItem(item)}>
                      {p('Record attendance')}
                    </Button>
                  )}
                </div>
              </article>
            )
          })}
        </div>
      )}

      {hasMore && (
        <div className="pro-actions" style={{ marginTop: 14 }}>
          <Button
            size="sm"
            disabled={loadingMore}
            onClick={() => loadAppointments(true)}
          >
            {loadingMore ? p('Loading…') : p('Load more appointments')}
          </Button>
        </div>
      )}

      {detailItem && (
        <AppointmentDetailModal
          appointment={detailItem}
          onClose={() => setDetailItem(null)}
          onReschedule={item => { setDetailItem(null); setRescheduleItem(item) }}
          onCancel={item => { setDetailItem(null); setCancelItem(item) }}
          onAttendance={item => { setDetailItem(null); setAttendanceItem(item) }}
        />
      )}

      {rescheduleItem && (
        <RescheduleModal
          appointment={rescheduleItem}
          isCoach={true}
          onClose={() => setRescheduleItem(null)}
          onSave={() => loadAppointments(false)}
        />
      )}

      {cancelItem && (
        <CancelModal
          appointment={cancelItem}
          isCoach={true}
          onClose={() => setCancelItem(null)}
          onSave={() => loadAppointments(false)}
        />
      )}

      {attendanceItem && (
        <AttendanceModal
          appointment={attendanceItem}
          onClose={() => setAttendanceItem(null)}
          onSave={() => loadAppointments(false)}
        />
      )}

      {createOpen && (
        <CreateCoachAppointmentModal
          links={links}
          coachTimeZone={appointments[0]?.timeZone}
          onClose={() => setCreateOpen(false)}
          onSave={() => loadAppointments(false)}
        />
      )}
    </section>
  )
}

// ==========================================
// Athlete Booking View
// ==========================================
export function AthleteBookingView({ links = [], onBookSuccess }) {
  const toast = useUI(state => state.toast)
  const [coachId, setCoachId] = useState(() => links[0]?.coach?.id || '')
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [slots, setSlots] = useState([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [selectedSlot, setSelectedSlot] = useState(null)
  const [bookingOpen, setBookingOpen] = useState(false)
  const [type, setType] = useState('in_person')
  const [title, setTitle] = useState('')
  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const slotsRequestIdRef = useRef(0)

  useEffect(() => {
    if (!coachId && links[0]?.coach?.id) {
      setCoachId(links[0].coach.id)
    }
  }, [coachId, links])

  const loadSlots = useCallback(async () => {
    if (!coachId || !date) return
    const reqId = ++slotsRequestIdRef.current
    setLoading(true)
    setLoadError(false)
    try {
      const res = await getAthleteSlots(coachId, { date })
      if (reqId !== slotsRequestIdRef.current) return
      setSlots(res?.items || [])
    } catch {
      if (reqId !== slotsRequestIdRef.current) return
      setLoadError(true)
      setSlots([])
    } finally {
      if (reqId === slotsRequestIdRef.current) {
        setLoading(false)
      }
    }
  }, [coachId, date])

  useEffect(() => { loadSlots() }, [loadSlots])

  const handleSelectSlot = slot => {
    setSelectedSlot(slot)
    setTitle(p('Schedule with coach'))
    setBookingOpen(true)
  }

  const handleConfirmBooking = async e => {
    e?.preventDefault()
    if (!selectedSlot || !coachId) return
    setSubmitting(true)
    try {
      const payload = {
        type,
        title: title.trim() || p('New session'),
        notes: notes.trim(),
        startAt: selectedSlot.startAt,
        endAt: selectedSlot.endAt,
      }
      await createAthleteAppointment(coachId, payload)
      toast(p('Session booked successfully.'))
      setBookingOpen(false)
      setSelectedSlot(null)
      loadSlots()
      if (onBookSuccess) onBookSuccess()
    } catch (err) {
      if (err instanceof ConflictError || err?.status === 409) {
        toast(p('This slot is no longer available. Please select another time.'))
        setBookingOpen(false)
        setSelectedSlot(null)
        loadSlots()
      } else {
        toast(professionalError(err))
      }
    } finally {
      setSubmitting(false)
    }
  }

  if (links.length === 0) {
    return (
      <EmptyState
        icon="personCircle"
        title={p('No linked professionals')}
        text={p('When you accept an invitation, the professional and authorized scope appear here.')}
      />
    )
  }

  return (
    <section className="pro-sched-section" aria-labelledby="athlete-booking-heading">
      <h2 id="athlete-booking-heading" className="pro-section-title">{p('Book a session')}</h2>

      <div className="pro-sched-filters">
        {links.length > 1 && (
          <label>
            <span>{p('Select coach')}</span>
            <select value={coachId} onChange={e => setCoachId(e.target.value)}>
              {links.map(l => (
                <option key={l.coach?.id || l.id} value={l.coach?.id}>
                  {l.coach?.name || p('Unavailable account')}
                </option>
              ))}
            </select>
          </label>
        )}

        <label>
          <span>{p('Select date')}</span>
          <input
            type="date"
            aria-label={p('Select date')}
            value={date}
            onChange={e => setDate(e.target.value)}
          />
        </label>
      </div>

      <div className="card">
        <h3 className="pro-card-title">{p('Available slots')}</h3>
        {loading ? (
          <div className="pro-loading">{p('Loading…')}</div>
        ) : loadError ? (
          <div className="card pro-load-error" role="alert">
            <p>{p('Could not load availability slots.')}</p>
            <Button size="sm" onClick={loadSlots}>{p('Try again')}</Button>
          </div>
        ) : slots.length === 0 ? (
          <p className="dim small">{p('No free slots available for this period.')}</p>
        ) : (
          <div className="pro-sched-slots" role="group" aria-label={p('Available slots')}>
            {slots.map(slot => (
              <button
                key={slot.startAt}
                type="button"
                className="pro-sched-slot-btn"
                onClick={() => handleSelectSlot(slot)}
              >
                <span className="pro-sched-slot-time">{formatSlotTime(slot.startAt, slot.timeZone)}</span>
                <span className="pro-sched-slot-dur">{slot.durationMinutes} min</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {bookingOpen && selectedSlot && (
        <AccessibleModal id="athlete-confirm-booking" title={p('Confirm booking')} onClose={() => setBookingOpen(false)}>
          <form onSubmit={handleConfirmBooking} className="pro-sched-form">
            <div className="pro-sched-form-row">
              <span>{p('Time')}:</span>
              <strong>{formatDateOnly(selectedSlot.startAt, selectedSlot.timeZone)} · {formatSlotTime(selectedSlot.startAt, selectedSlot.timeZone)} – {formatSlotTime(selectedSlot.endAt, selectedSlot.timeZone)}</strong>
            </div>

            <label className="pro-sched-form-row">
              <span>{p('Type')}</span>
              <select value={type} onChange={e => setType(e.target.value)}>
                <option value="in_person">{p('In person')}</option>
                <option value="online">{p('Online')}</option>
              </select>
            </label>

            <label className="pro-sched-form-row">
              <span>{p('Title')}</span>
              <TextField
                name="bookingTitle"
                value={title}
                maxLength={120}
                onChange={e => setTitle(e.target.value)}
              />
            </label>

            <label className="pro-sched-form-row">
              <span>{p('Notes')}</span>
              <TextArea
                name="bookingNotes"
                value={notes}
                maxLength={1000}
                rows={2}
                onChange={e => setNotes(e.target.value)}
              />
            </label>

            <div className="pro-actions">
              <Button type="button" onClick={() => setBookingOpen(false)}>{p('Cancel')}</Button>
              <Button variant="primary" type="submit" disabled={submitting}>
                {submitting ? p('Confirming…') : p('Confirm booking')}
              </Button>
            </div>
          </form>
        </AccessibleModal>
      )}
    </section>
  )
}

// ==========================================
// Athlete Appointments View
// ==========================================
export function AthleteAppointmentsView() {
  const [appointments, setAppointments] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [cursor, setCursor] = useState(null)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)

  const [detailItem, setDetailItem] = useState(null)
  const [rescheduleItem, setRescheduleItem] = useState(null)
  const [cancelItem, setCancelItem] = useState(null)
  const activeRequestIdRef = useRef(0)

  const loadAppointments = useCallback(async (isLoadMore = false) => {
    const requestId = ++activeRequestIdRef.current
    if (isLoadMore) setLoadingMore(true)
    else setLoading(true)
    setLoadError(false)

    try {
      const params = {
        limit: 20,
        ...(isLoadMore && cursor ? { cursor } : {}),
      }
      const res = await getAthleteAppointments(params)
      if (requestId !== activeRequestIdRef.current) return
      const items = res?.items || []
      if (isLoadMore) {
        setAppointments(prev => [...prev, ...items])
      } else {
        setAppointments(items)
      }
      setCursor(res?.nextCursor || null)
      setHasMore(!!res?.hasMore)
    } catch {
      if (requestId !== activeRequestIdRef.current) return
      setLoadError(true)
    } finally {
      if (requestId === activeRequestIdRef.current) {
        setLoading(false)
        setLoadingMore(false)
      }
    }
  }, [cursor])

  useEffect(() => {
    setCursor(null)
    loadAppointments(false)
  }, [])

  return (
    <section className="pro-sched-section" aria-labelledby="athlete-appointments-heading">
      <h2 id="athlete-appointments-heading" className="pro-section-title">{p('My appointments')}</h2>

      {loading && appointments.length === 0 ? (
        <div className="pro-loading">{p('Loading…')}</div>
      ) : loadError ? (
        <div className="card pro-load-error" role="alert">
          <p>{p('Could not load appointments.')}</p>
          <Button size="sm" onClick={() => loadAppointments(false)}>{p('Try again')}</Button>
        </div>
      ) : appointments.length === 0 ? (
        <EmptyState
          icon="calendar"
          title={p('No appointments found')}
          text={p('No appointments scheduled.')}
        />
      ) : (
        <div className="pro-sched-grid">
          {appointments.map(item => {
            const allowed = item.lifecycle?.allowedActions || []
            const readOnly = !!item.lifecycle?.readOnly

            return (
              <article key={item.id} className="pro-sched-card">
                <div className="pro-sched-card-head">
                  <div>
                    <h3 className="pro-sched-card-title">{item.title || p('New session')}</h3>
                    <div className="pro-sched-card-meta">
                      <span>{item.coach?.name}</span>
                      <span>·</span>
                      <span>{formatFullDateTime(item.startAt, item.timeZone)}</span>
                    </div>
                  </div>
                  <div className="pro-sched-badges">
                    <span className={`pro-sched-badge ${item.status}`}>
                      {p(item.status === 'scheduled' ? 'Scheduled' : item.status === 'completed' ? 'Completed' : item.status === 'canceled' ? 'Canceled' : 'No-show')}
                    </span>
                    <span className="pro-sched-badge info">{p(item.type === 'in_person' ? 'In person' : 'Online')}</span>
                    {item.lifecycle?.historical && <span className="pro-sched-badge historical">{p('Historical')}</span>}
                    {readOnly && <span className="pro-sched-badge readonly">{p('Read-only')}</span>}
                  </div>
                </div>

                {item.location && <div className="small dim">{p('Location')}: {item.location}</div>}
                {item.meetingUrl && <div className="small dim">{p('Meeting link')}: <a href={item.meetingUrl} target="_blank" rel="noreferrer">{item.meetingUrl}</a></div>}
                {item.cancellation && <div className="small" style={{ color: 'var(--red)' }}>{p('Canceled by {0}', item.cancellation.actor)}: {item.cancellation.reason}</div>}

                <div className="pro-sched-actions">
                  <Button size="sm" onClick={() => setDetailItem(item)}>
                    {p('Session details')}
                  </Button>
                  {!readOnly && allowed.includes('reschedule') && (
                    <Button size="sm" onClick={() => setRescheduleItem(item)}>
                      {p('Reschedule')}
                    </Button>
                  )}
                  {!readOnly && allowed.includes('cancel') && (
                    <Button size="sm" variant="danger" onClick={() => setCancelItem(item)}>
                      {p('Cancel session')}
                    </Button>
                  )}
                </div>
              </article>
            )
          })}
        </div>
      )}

      {hasMore && (
        <div className="pro-actions" style={{ marginTop: 14 }}>
          <Button
            size="sm"
            disabled={loadingMore}
            onClick={() => loadAppointments(true)}
          >
            {loadingMore ? p('Loading…') : p('Load more appointments')}
          </Button>
        </div>
      )}

      {detailItem && (
        <AppointmentDetailModal
          appointment={detailItem}
          onClose={() => setDetailItem(null)}
          onReschedule={item => { setDetailItem(null); setRescheduleItem(item) }}
          onCancel={item => { setDetailItem(null); setCancelItem(item) }}
          onAttendance={() => {}}
        />
      )}

      {rescheduleItem && (
        <RescheduleModal
          appointment={rescheduleItem}
          isCoach={false}
          onClose={() => setRescheduleItem(null)}
          onSave={() => loadAppointments(false)}
        />
      )}

      {cancelItem && (
        <CancelModal
          appointment={cancelItem}
          isCoach={false}
          onClose={() => setCancelItem(null)}
          onSave={() => loadAppointments(false)}
        />
      )}
    </section>
  )
}

// ==========================================
// Reminder Preferences View
// ==========================================
export function ReminderPreferencesView() {
  const toast = useUI(state => state.toast)
  const [preferences, setPreferences] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [saving, setSaving] = useState(false)

  const defaultTz = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Sao_Paulo'
    } catch {
      return 'America/Sao_Paulo'
    }
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(false)
    try {
      const res = await getReminderPreferences()
      setPreferences(res || {
        enabled: true,
        offsetsMinutes: [60],
        timeZone: defaultTz,
      })
    } catch {
      setLoadError(true)
    } finally {
      setLoading(false)
    }
  }, [defaultTz])

  useEffect(() => { load() }, [load])

  const toggleOffset = val => {
    setPreferences(prev => {
      const current = prev.offsetsMinutes || []
      const next = current.includes(val) ? current.filter(x => x !== val) : [...current, val]
      return { ...prev, offsetsMinutes: next.sort((a, b) => a - b) }
    })
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      const payload = {
        enabled: !!preferences.enabled,
        offsetsMinutes: preferences.offsetsMinutes || [],
        timeZone: preferences.timeZone || defaultTz,
      }
      const res = await updateReminderPreferences(payload)
      if (res) setPreferences(res)
      toast(p('Reminder preferences saved.'))
    } catch (err) {
      toast(professionalError(err))
    } finally {
      setSaving(false)
    }
  }

  if (loading && !preferences) {
    return <div className="pro-loading">{p('Loading…')}</div>
  }

  if (loadError) {
    return (
      <div className="card pro-load-error" role="alert">
        <p>{p('Could not load reminder preferences.')}</p>
        <Button size="sm" onClick={load}>{p('Try again')}</Button>
      </div>
    )
  }

  return (
    <section className="pro-sched-section" aria-labelledby="reminder-preferences-heading">
      <div className="pro-panel-head">
        <h2 id="reminder-preferences-heading" className="pro-section-title">{p('Reminders')}</h2>
        <Button variant="primary" disabled={saving} onClick={handleSave}>
          {saving ? p('Saving reminders…') : p('Save reminders')}
        </Button>
      </div>

      <div className="pro-sched-reminders-box">
        <label className="pro-check">
          <input
            type="checkbox"
            checked={!!preferences.enabled}
            onChange={e => setPreferences(prev => ({ ...prev, enabled: e.target.checked }))}
          />
          <strong>{p('Enable reminders')}</strong>
        </label>

        <div>
          <span className="small dim">{p('Timezone')}: {preferences.timeZone || defaultTz}</span>
        </div>

        <div className="pro-sched-offsets-grid">
          <span className="pro-field-label">{p('Reminder offsets')}</span>
          {REMINDER_OFFSETS.map(offset => (
            <label key={offset.value} className="pro-check">
              <input
                type="checkbox"
                disabled={!preferences.enabled}
                checked={(preferences.offsetsMinutes || []).includes(offset.value)}
                onChange={() => toggleOffset(offset.value)}
              />
              <span>{p(offset.label)}</span>
            </label>
          ))}
        </div>
      </div>
    </section>
  )
}

// ==========================================
// Main SchedulingView Component
// ==========================================
export default function SchedulingView({ embedded = false, initialTab, initialRole }) {
  const user = useStore(state => state.user)
  const navigate = useNavigate()
  const location = useLocation()
  const [coachLinks, setCoachLinks] = useState([])
  const [athleteLinks, setAthleteLinks] = useState([])
  const [linksLoaded, setLinksLoaded] = useState(false)

  const isCoach = user?.profile?.kind === 'coach'

  const queryRole = useMemo(() => {
    return new URLSearchParams(location.search).get('role') || ''
  }, [location.search])

  const queryTab = useMemo(() => {
    return initialTab || new URLSearchParams(location.search).get('tab') || ''
  }, [initialTab, location.search])

  const [roleMode, setRoleMode] = useState(() => {
    if (initialRole) return initialRole
    if (queryRole === 'athlete') return 'athlete'
    if (queryTab === 'book') return 'athlete'
    return isCoach ? 'coach' : 'athlete'
  })

  const [activeTab, setActiveTab] = useState(() => {
    if (queryTab) return queryTab
    const startingRole = initialRole || (queryRole === 'athlete' ? 'athlete' : (queryTab === 'book' ? 'athlete' : (isCoach ? 'coach' : 'athlete')))
    return startingRole === 'coach' ? 'appointments' : 'book'
  })

  // Load links (coach's athletes and athlete's coaches)
  useEffect(() => {
    let unmounted = false
    const load = async () => {
      try {
        if (isCoach) {
          const [cRes, aRes] = await Promise.allSettled([
            api('/api/coach/athletes'),
            api('/api/athlete/coaches'),
          ])
          if (!unmounted) {
            if (cRes.status === 'fulfilled') {
              setCoachLinks(cRes.value?.links || [])
            }
            if (aRes.status === 'fulfilled') {
              setAthleteLinks(aRes.value?.links || [])
            }
            setLinksLoaded(true)
          }
        } else {
          const res = await api('/api/athlete/coaches')
          if (!unmounted) {
            setAthleteLinks(res?.links || [])
            setLinksLoaded(true)
          }
        }
      } catch {
        if (!unmounted) setLinksLoaded(true)
      }
    }
    load()
    return () => { unmounted = true }
  }, [isCoach, user?.id])

  if (!user) return null

  const hasAthleteRole = athleteLinks.length > 0
  const canSwitchRole = isCoach && hasAthleteRole
  const currentRole = isCoach ? (canSwitchRole ? roleMode : 'coach') : 'athlete'

  const handleSwitchRole = mode => {
    if (mode === roleMode) return
    setRoleMode(mode)
    if (mode === 'athlete' && activeTab === 'availability') {
      setActiveTab('book')
    } else if (mode === 'coach' && activeTab === 'book') {
      setActiveTab('appointments')
    }
  }

  return (
    <main className={`narrow pro-page ${embedded ? 'embedded' : ''}`}>
      {!embedded && (
        <div className="pro-nav">
          <button data-back="/settings" onClick={() => navigate('/settings')}>
            <Icon name="chevronLeft" />
            {p('Settings')}
          </button>
        </div>
      )}

      {!embedded && (
        <header className="pro-hero">
          <div>
            <span className="pro-kicker">{p('Scheduling')}</span>
            <h1>{currentRole === 'coach' ? p('Coach appointments') : p('My appointments')}</h1>
            <p>{p('Manage availability, sessions and reminders')}</p>
          </div>
          <Icon name="calendar" />
        </header>
      )}

      {canSwitchRole && (
        <div className="pro-sched-role-switcher" role="group" aria-label={p('View mode')}>
          <Button
            size="sm"
            variant={currentRole === 'coach' ? 'tinted' : 'ghost'}
            aria-pressed={currentRole === 'coach'}
            onClick={() => handleSwitchRole('coach')}
          >
            {p('Coach / Meus Alunos')}
          </Button>
          <Button
            size="sm"
            variant={currentRole === 'athlete' ? 'tinted' : 'ghost'}
            aria-pressed={currentRole === 'athlete'}
            onClick={() => handleSwitchRole('athlete')}
          >
            {p('Atleta / Meus Treinadores')}
          </Button>
        </div>
      )}

      <nav className="pro-sched-nav" role="tablist">
        {currentRole === 'coach' ? (
          <>
            <button
              role="tab"
              aria-selected={activeTab === 'appointments'}
              className={`pro-sched-tab ${activeTab === 'appointments' ? 'active' : ''}`}
              onClick={() => setActiveTab('appointments')}
            >
              <Icon name="calendar" />
              <span>{p('Appointments')}</span>
            </button>
            <button
              role="tab"
              aria-selected={activeTab === 'availability'}
              className={`pro-sched-tab ${activeTab === 'availability' ? 'active' : ''}`}
              onClick={() => setActiveTab('availability')}
            >
              <Icon name="clock" />
              <span>{p('Availability')}</span>
            </button>
            <button
              role="tab"
              aria-selected={activeTab === 'reminders'}
              className={`pro-sched-tab ${activeTab === 'reminders' ? 'active' : ''}`}
              onClick={() => setActiveTab('reminders')}
            >
              <Icon name="bell" />
              <span>{p('Reminders')}</span>
            </button>
          </>
        ) : (
          <>
            <button
              role="tab"
              aria-selected={activeTab === 'book'}
              className={`pro-sched-tab ${activeTab === 'book' ? 'active' : ''}`}
              onClick={() => setActiveTab('book')}
            >
              <Icon name="plus" />
              <span>{p('Book session')}</span>
            </button>
            <button
              role="tab"
              aria-selected={activeTab === 'appointments'}
              className={`pro-sched-tab ${activeTab === 'appointments' ? 'active' : ''}`}
              onClick={() => setActiveTab('appointments')}
            >
              <Icon name="calendar" />
              <span>{p('My appointments')}</span>
            </button>
            <button
              role="tab"
              aria-selected={activeTab === 'reminders'}
              className={`pro-sched-tab ${activeTab === 'reminders' ? 'active' : ''}`}
              onClick={() => setActiveTab('reminders')}
            >
              <Icon name="bell" />
              <span>{p('Reminders')}</span>
            </button>
          </>
        )}
      </nav>

      {currentRole === 'coach' ? (
        activeTab === 'appointments' ? (
          <CoachAppointmentsView links={coachLinks} />
        ) : activeTab === 'availability' ? (
          <CoachAvailabilityEditor />
        ) : (
          <ReminderPreferencesView />
        )
      ) : (
        activeTab === 'book' ? (
          <AthleteBookingView links={athleteLinks} onBookSuccess={() => setActiveTab('appointments')} />
        ) : activeTab === 'appointments' ? (
          <AthleteAppointmentsView />
        ) : (
          <ReminderPreferencesView />
        )
      )}
    </main>
  )
}
