import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  progressApi,
  fetchMetricCatalog,
  fetchCoachGoals,
  createCoachGoal,
  patchCoachGoal,
  archiveCoachGoal,
  fetchCoachSummary,
  fetchCoachReports,
  createCoachReport,
  fetchCoachReport,
  exportCoachReport,
  revokeCoachReport,
  fetchAthleteGoals,
  fetchAthleteSummary,
  fetchAthleteReports,
  fetchAthleteReport,
  exportAthleteReport,
  parseApiError,
} from '../lib/progress-api.js'
import { browserTimeZone } from '../lib/communication-api.js'
import { dateLocale } from '../lib/i18n.js'
import { professionalError, professionalText as p } from '../lib/professional-copy.js'
import AccessibleModal from './AccessibleModal.jsx'
export { AccessibleModal }
import { confirmSheet } from '../sheets.jsx'
import Icon from '../components/Icon.jsx'
import EmptyState from '../components/EmptyState.jsx'
import { Button, NumberField, Segmented, TextField } from '../components/ui.jsx'

const PERIOD_PRESETS = [7, 30, 90]

const DEFAULT_METRIC_CONFIG = {
  body_weight: { label: 'Body weight', unit: 'kg' },
  body_fat_percent: { label: 'Body fat percent', unit: '%' },
  workouts_per_week: { label: 'Workouts per week', unit: 'treinos/sem' },
  nutrition_adherence_percent: { label: 'Nutrition adherence', unit: '%' },
  habit_adherence_percent: { label: 'Habit adherence', unit: '%' },
}

const REASON_LABELS = {
  outside_relationship_period: 'Outside relationship period',
  no_measurements: 'No measurements recorded yet',
  training_state_unavailable: 'Training data not available',
  no_adherence_records: 'No nutrition adherence records',
  no_meal_plan: 'No active meal plan',
  no_habits: 'No habits configured',
  no_scheduled_habit_days: 'No scheduled habit days in period',
  insufficient_data: 'Insufficient data points for evaluation',
  zero_coverage: 'No data logged in period',
  stale_data: 'Data is older than freshness threshold',
  insufficient_longitudinal_coverage: 'Longitudinal coverage is too low',
  insufficient_observations: 'Insufficient observations for trend calculation',
}

const STATE_LABELS = {
  achieved: 'Achieved',
  on_track: 'On track',
  at_risk: 'At risk',
  off_track: 'Off track',
  within_tolerance: 'Within tolerance',
  outside_tolerance: 'Outside tolerance',
  insufficient_data: 'Insufficient data',
  stale: 'Stale',
  unavailable: 'Unavailable',
  not_started: 'Not started',
  in_progress: 'In progress',
}

export const formatDate = value => {
  if (!value) return ''
  try {
    const parsed = new Date(value.includes('T') ? value : `${value}T00:00:00Z`)
    return isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleDateString(dateLocale())
  } catch {
    return String(value)
  }
}

export const formatNumber = value => (value == null ? '–' : new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value))

export function formatUnit(unit) {
  if (unit === 'percent') return '%'
  if (unit === 'kg') return 'kg'
  if (unit === 'workouts_per_week') return p('Workouts per week')
  return unit || ''
}


export function ProgressChart({ metricKey, metricData, label }) {
  const points = useMemo(() => {
    if (!metricData?.points || !Array.isArray(metricData.points)) return []
    return metricData.points.filter(p => p && (p.value !== undefined && p.value !== null))
  }, [metricData])

  if (!points.length) {
    return (
      <div className="pro-chart-empty" role="note">
        <p>{p('No data points for this period.')}</p>
      </div>
    )
  }

  const values = points.map(p => Number(p.value))
  const minVal = Math.min(...values)
  const maxVal = Math.max(...values)
  const range = maxVal - minVal || 1
  const padding = range * 0.1
  const yMin = minVal - padding
  const yMax = maxVal + padding
  const yRange = yMax - yMin

  const width = 500
  const height = 180
  const padLeft = 45
  const padRight = 20
  const padTop = 20
  const padBottom = 30
  const plotWidth = width - padLeft - padRight
  const plotHeight = height - padTop - padBottom

  const coords = points.map((pt, index) => {
    const x = padLeft + (points.length === 1 ? plotWidth / 2 : (index / (points.length - 1)) * plotWidth)
    const y = padTop + plotHeight - ((Number(pt.value) - yMin) / yRange) * plotHeight
    return { x, y, pt }
  })

  const pointsString = coords.map(c => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ')
  const unit = formatUnit(metricData.unit)

  return (
    <div className="pro-chart-container">
      <div className="pro-chart-wrap">
        <svg
          className="pro-chart-svg"
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={p('Chart for {0}', label || metricKey)}
        >
          <title>{p('Chart for {0}', label || metricKey)}</title>
          <desc>{`${label || metricKey}: ${points.length} points, current ${formatNumber(metricData.currentValue)} ${unit}`}</desc>

          {/* Grid lines */}
          <line x1={padLeft} y1={padTop} x2={width - padRight} y2={padTop} className="pro-chart-grid" />
          <line x1={padLeft} y1={padTop + plotHeight / 2} x2={width - padRight} y2={padTop + plotHeight / 2} className="pro-chart-grid" />
          <line x1={padLeft} y1={padTop + plotHeight} x2={width - padRight} y2={padTop + plotHeight} className="pro-chart-grid" />

          {/* Y Axis text */}
          <text x={padLeft - 8} y={padTop + 4} textAnchor="end" className="pro-chart-label">{formatNumber(yMax)}</text>
          <text x={padLeft - 8} y={padTop + plotHeight + 4} textAnchor="end" className="pro-chart-label">{formatNumber(yMin)}</text>

          {/* Sparkline / Plot line */}
          {coords.length > 1 && (
            <polyline
              fill="none"
              stroke="var(--acc)"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              points={pointsString}
            />
          )}

          {/* Points */}
          {coords.map((c, i) => (
            <circle
              key={i}
              cx={c.x}
              cy={c.y}
              r={coords.length > 30 ? 2.5 : 4}
              className="pro-chart-dot"
            >
              <title>{`${formatDate(c.pt.date || c.pt.from || c.pt.at)}: ${formatNumber(c.pt.value)} ${unit}`}</title>
            </circle>
          ))}

          {/* X Axis text */}
          {coords.length > 0 && (
            <>
              <text x={padLeft} y={height - 8} textAnchor="start" className="pro-chart-label">
                {formatDate(coords[0].pt.date || coords[0].pt.from || coords[0].pt.at)}
              </text>
              {coords.length > 1 && (
                <text x={width - padRight} y={height - 8} textAnchor="end" className="pro-chart-label">
                  {formatDate(coords[coords.length - 1].pt.date || coords[coords.length - 1].pt.from || coords[coords.length - 1].pt.at)}
                </text>
              )}
            </>
          )}
        </svg>
      </div>

      {/* Accessible tabular alternative for screen readers and keyboard access */}
      <details className="pro-chart-table-wrap">
        <summary>{p('View data table')}</summary>
        <div className="assessment-table-wrap">
          <table className="pro-data-table">
            <thead>
              <tr>
                <th scope="col">{p('Date')}</th>
                <th scope="col">{p('Value')}</th>
                <th scope="col">{p('Unit')}</th>
              </tr>
            </thead>
            <tbody>
              {points.map((pt, idx) => (
                <tr key={idx}>
                  <td>{formatDate(pt.date || pt.from || pt.at)}</td>
                  <td>{formatNumber(pt.value)}</td>
                  <td>{unit}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  )
}

export function GoalModal({
  isOpen,
  onClose,
  onSaved,
  goal,
  athleteId,
  linkId,
  catalog,
}) {
  const isEdit = Boolean(goal?.id)
  const zone = useMemo(() => browserTimeZone().value, [])
  const [metric, setMetric] = useState(goal?.metric || 'body_weight')
  const [direction, setDirection] = useState(goal?.direction || 'decrease')
  const [baselineValue, setBaselineValue] = useState(goal?.baselineValue != null ? String(goal.baselineValue) : '')
  const [targetValue, setTargetValue] = useState(goal?.targetValue != null ? String(goal.targetValue) : '')
  const [tolerance, setTolerance] = useState(goal?.tolerance != null ? String(goal.tolerance) : '')
  const [startDate, setStartDate] = useState(goal?.startDate || new Date().toISOString().slice(0, 10))
  const [targetDate, setTargetDate] = useState(goal?.targetDate || new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10))
  const [status, setStatus] = useState(goal?.status || 'active')
  const [submitting, setSubmitting] = useState(false)
  const [errorMsg, setErrorMsg] = useState('')

  useEffect(() => {
    if (goal) {
      setMetric(goal.metric || 'body_weight')
      setDirection(goal.direction || 'decrease')
      setBaselineValue(goal.baselineValue != null ? String(goal.baselineValue) : '')
      setTargetValue(goal.targetValue != null ? String(goal.targetValue) : '')
      setTolerance(goal.tolerance != null ? String(goal.tolerance) : '')
      setStartDate(goal.startDate || new Date().toISOString().slice(0, 10))
      setTargetDate(goal.targetDate || new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10))
      setStatus(goal.status || 'active')
    } else {
      setMetric('body_weight')
      setDirection('decrease')
      setBaselineValue('')
      setTargetValue('')
      setTolerance('')
      setStartDate(new Date().toISOString().slice(0, 10))
      setTargetDate(new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10))
      setStatus('active')
    }
    setErrorMsg('')
  }, [goal, isOpen])

  if (!isOpen) return null

  const metricOptions = catalog?.metrics ? Object.keys(catalog.metrics) : Object.keys(DEFAULT_METRIC_CONFIG)

  const handleSubmit = async e => {
    e.preventDefault()
    if (submitting) return
    setErrorMsg('')

    const baseNum = Number(baselineValue)
    const targetNum = Number(targetValue)
    const tolNum = tolerance.trim() ? Number(tolerance) : null

    if (isNaN(baseNum) || isNaN(targetNum)) {
      setErrorMsg(p('Review the goal metric, direction, baseline, target, and dates.'))
      return
    }

    if (targetDate < startDate) {
      setErrorMsg(p('Target date must be on or after start date.'))
      return
    }

    if (direction === 'increase' && targetNum <= baseNum) {
      setErrorMsg(p('For increase, target must be greater than baseline.'))
      return
    }
    if (direction === 'decrease' && targetNum >= baseNum) {
      setErrorMsg(p('For decrease, target must be less than baseline.'))
      return
    }
    if (direction === 'maintain' && targetNum !== baseNum) {
      setErrorMsg(p('For maintain, target must equal baseline.'))
      return
    }

    setSubmitting(true)
    try {
      if (isEdit) {
        const payload = {
          _rev: goal._rev,
          metric,
          direction,
          baselineValue: baseNum,
          targetValue: targetNum,
          tolerance: tolNum,
          startDate,
          targetDate,
          timezone: zone,
          status,
        }
        const res = await patchCoachGoal(athleteId, goal.id, payload, { linkId })
        onSaved(res.goal, goal)
      } else {
        const payload = {
          metric,
          direction,
          baselineValue: baseNum,
          targetValue: targetNum,
          tolerance: tolNum,
          startDate,
          targetDate,
          timezone: zone,
          status: 'active',
        }
        const res = await createCoachGoal(athleteId, payload, { linkId })
        onSaved(res.goal, null)
      }
      onClose()
    } catch (err) {
      const parsed = parseApiError(err)
      if (parsed.status === 409 || parsed.code === 'stale_version') {
        setErrorMsg(p('The goal was updated by another request. Reload and try again.'))
      } else if (parsed.status === 429) {
        setErrorMsg(p('Too many attempts. Wait a moment and try again.'))
      } else {
        setErrorMsg(professionalError(err))
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AccessibleModal
      id="goal-modal"
      title={isEdit ? p('Edit goal') : p('New goal')}
      onClose={onClose}
    >
      <form onSubmit={handleSubmit} className="pro-modal-form">
        {errorMsg && (
          <div className="card pro-load-error" role="alert">
            <p>{errorMsg}</p>
          </div>
        )}

        <label className="pro-field">
          <span>{p('Metric')}</span>
          <select
            name="metric"
            value={metric}
            disabled={isEdit || submitting}
            onChange={e => setMetric(e.target.value)}
          >
            {metricOptions.map(key => (
              <option key={key} value={key}>
                {p(DEFAULT_METRIC_CONFIG[key]?.label || key)}
              </option>
            ))}
          </select>
        </label>

        <label className="pro-field">
          <span>{p('Direction')}</span>
          <select
            name="direction"
            value={direction}
            disabled={submitting}
            onChange={e => setDirection(e.target.value)}
          >
            <option value="increase">{p('Increase')}</option>
            <option value="decrease">{p('Decrease')}</option>
            <option value="maintain">{p('Maintain')}</option>
          </select>
        </label>

        <div className="pro-grid-fields">
          <label className="pro-field">
            <span>{p('Baseline value')}</span>
            <TextField
              name="baselineValue"
              type="number"
              step="any"
              value={baselineValue}
              disabled={submitting}
              onChange={e => setBaselineValue(e.target.value)}
              required
            />
          </label>

          <label className="pro-field">
            <span>{p('Target value')}</span>
            <TextField
              name="targetValue"
              type="number"
              step="any"
              value={targetValue}
              disabled={submitting}
              onChange={e => setTargetValue(e.target.value)}
              required
            />
          </label>
        </div>

        <label className="pro-field">
          <span>{p('Tolerance')}</span>
          <TextField
            name="tolerance"
            type="number"
            step="any"
            value={tolerance}
            disabled={submitting}
            onChange={e => setTolerance(e.target.value)}
          />
        </label>

        <div className="pro-grid-fields">
          <label className="pro-field">
            <span>{p('Start date')}</span>
            <TextField
              name="startDate"
              type="date"
              value={startDate}
              disabled={submitting}
              onChange={e => setStartDate(e.target.value)}
              required
            />
          </label>

          <label className="pro-field">
            <span>{p('Target date')}</span>
            <TextField
              name="targetDate"
              type="date"
              value={targetDate}
              disabled={submitting}
              onChange={e => setTargetDate(e.target.value)}
              required
            />
          </label>
        </div>

        {isEdit && (
          <label className="pro-field">
            <span>{p('Filter by status')}</span>
            <select
              name="status"
              value={status}
              disabled={submitting}
              onChange={e => setStatus(e.target.value)}
            >
              <option value="active">{p('Active')}</option>
              <option value="achieved">{p('Achieved')}</option>
              <option value="archived">{p('Archived')}</option>
            </select>
          </label>
        )}

        <div className="pro-actions">
          <Button
            variant="primary"
            type="submit"
            disabled={submitting}
            onClick={handleSubmit}
          >
            {submitting ? p('Saving…') : isEdit ? p('Edit goal') : p('Create goal')}
          </Button>
          <Button
            type="button"
            disabled={submitting}
            onClick={onClose}
          >
            {p('Close')}
          </Button>
        </div>
      </form>
    </AccessibleModal>
  )
}

export function ReportCreateModal({
  isOpen,
  onClose,
  onCreated,
  athleteId,
  linkId,
  catalog,
}) {
  const zone = useMemo(() => browserTimeZone().value, [])
  const [preset, setPreset] = useState(30)
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const metricOptions = catalog?.metrics ? Object.keys(catalog.metrics) : Object.keys(DEFAULT_METRIC_CONFIG)
  const [selectedMetrics, setSelectedMetrics] = useState(metricOptions)
  const [submitting, setSubmitting] = useState(false)
  const [errorMsg, setErrorMsg] = useState('')

  if (!isOpen) return null

  const toggleMetric = metric => {
    setSelectedMetrics(curr =>
      curr.includes(metric) ? curr.filter(m => m !== metric) : [...curr, metric]
    )
  }

  const handleSubmit = async e => {
    e.preventDefault()
    if (submitting) return
    if (!selectedMetrics.length) {
      setErrorMsg(p('Select at least one valid metric.'))
      return
    }
    setErrorMsg('')
    setSubmitting(true)

    const payload = {
      timezone: zone,
      metrics: selectedMetrics,
    }
    if (preset === 'custom') {
      if (!customFrom || !customTo || customTo < customFrom) {
        setErrorMsg(p('Review the report period and selected metrics.'))
        setSubmitting(false)
        return
      }
      payload.from = customFrom
      payload.to = customTo
    } else {
      payload.period = Number(preset)
    }

    try {
      const res = await createCoachReport(athleteId, payload, { linkId })
      onCreated(res.report)
      onClose()
    } catch (err) {
      setErrorMsg(professionalError(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AccessibleModal
      id="report-create-modal"
      title={p('Generate report')}
      onClose={onClose}
    >
      <form onSubmit={handleSubmit} className="pro-modal-form">
        {errorMsg && (
          <div className="card pro-load-error" role="alert">
            <p>{errorMsg}</p>
          </div>
        )}

        <label className="pro-field">
          <span>{p('Period')}</span>
          <select
            value={preset}
            disabled={submitting}
            onChange={e => setPreset(e.target.value === 'custom' ? 'custom' : Number(e.target.value))}
          >
            <option value={7}>{p('7 days')}</option>
            <option value={30}>{p('30 days')}</option>
            <option value={90}>{p('90 days')}</option>
            <option value="custom">{p('Custom range')}</option>
          </select>
        </label>

        {preset === 'custom' && (
          <div className="pro-grid-fields">
            <label className="pro-field">
              <span>{p('From')}</span>
              <TextField
                type="date"
                value={customFrom}
                disabled={submitting}
                onChange={e => setCustomFrom(e.target.value)}
                required
              />
            </label>
            <label className="pro-field">
              <span>{p('To')}</span>
              <TextField
                type="date"
                value={customTo}
                disabled={submitting}
                onChange={e => setCustomTo(e.target.value)}
                required
              />
            </label>
          </div>
        )}

        <fieldset className="pro-fieldset">
          <legend className="pro-label">{p('Metric')}</legend>
          <div className="pro-checkbox-grid">
            {metricOptions.map(key => (
              <label key={key} className="assessment-question">
                <input
                  type="checkbox"
                  checked={selectedMetrics.includes(key)}
                  disabled={submitting}
                  onChange={() => toggleMetric(key)}
                />
                <span>{p(DEFAULT_METRIC_CONFIG[key]?.label || key)}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="pro-actions">
          <Button
            variant="primary"
            type="submit"
            disabled={submitting || !selectedMetrics.length}
            onClick={handleSubmit}
          >
            {submitting ? p('Generating…') : p('Generate report')}
          </Button>
          <Button
            type="button"
            disabled={submitting}
            onClick={onClose}
          >
            {p('Close')}
          </Button>
        </div>
      </form>
    </AccessibleModal>
  )
}

export function ReportDetailModal({
  isOpen,
  onClose,
  reportId,
  athleteId,
  linkId,
  isCoach = false,
  onRevoked,
}) {
  const [report, setReport] = useState(null)
  const [loading, setLoading] = useState(true)
  const [errorMsg, setErrorMsg] = useState('')
  const [exporting, setExporting] = useState(null)
  const [revoking, setRevoking] = useState(false)

  const load = useCallback(async () => {
    if (!reportId) return
    setLoading(true)
    setErrorMsg('')
    try {
      const res = isCoach
        ? await fetchCoachReport(athleteId, reportId, { linkId })
        : await fetchAthleteReport(reportId, { linkId })
      setReport(res.report)
    } catch (err) {
      const parsed = parseApiError(err)
      if (parsed.status === 410 || parsed.code === 'report_revoked') {
        setErrorMsg(p('This progress report is revoked.'))
      } else {
        setErrorMsg(professionalError(err))
      }
    } finally {
      setLoading(false)
    }
  }, [reportId, athleteId, linkId, isCoach])

  useEffect(() => {
    if (isOpen) load()
    else setReport(null)
  }, [isOpen, load])

  if (!isOpen) return null

  const handleExport = async format => {
    if (exporting) return
    setExporting(format)
    try {
      if (isCoach) {
        await exportCoachReport(athleteId, reportId, format, { linkId, triggerDownload: true })
      } else {
        await exportAthleteReport(reportId, format, { linkId, triggerDownload: true })
      }
    } catch (err) {
      setErrorMsg(p('Report export failed. Try again.'))
    } finally {
      setExporting(null)
    }
  }

  const handleRevoke = () => {
    confirmSheet({
      title: p('Revoke this report?'),
      message: p('Revoked reports can no longer be viewed or exported.'),
      confirmText: p('Revoke'),
      danger: true,
      onConfirm: async () => {
        setRevoking(true)
        try {
          await revokeCoachReport(athleteId, reportId, { linkId })
          onRevoked(reportId)
          onClose() // Immediately clear snapshot view
        } catch (err) {
          setErrorMsg(professionalError(err))
        } finally {
          setRevoking(false)
        }
      },
    })
  }

  return (
    <AccessibleModal
      id="report-detail-modal"
      title={p('Report snapshot')}
      onClose={onClose}
    >
      {loading ? (
        <div className="pro-loading">{p('Loading…')}</div>
      ) : errorMsg ? (
        <div className="card pro-load-error" role="alert">
          <p>{errorMsg}</p>
        </div>
      ) : report ? (
        <div className="pro-report-detail">
          <div className="pro-link-head">
            <div>
              <h3>{`${formatDate(report.interval?.from)} — ${formatDate(report.interval?.to)}`}</h3>
              <div className="pro-meta">{report.timezone}</div>
            </div>
            {report.revokedAt ? (
              <span className="pro-status ended">{p('Archived')}</span>
            ) : (
              <span className="pro-status active">{p('Active')}</span>
            )}
          </div>

          <p className="pro-report-summary">{report.summary}</p>

          {/* Snapshot Metrics */}
          {report.snapshot?.metrics && (
            <div className="pro-snapshot-metrics">
              {Object.entries(report.snapshot.metrics).map(([key, data]) => (
                <div key={key} className="pro-metric-card card">
                  <div className="pro-panel-head">
                    <strong>{p(DEFAULT_METRIC_CONFIG[key]?.label || key)}</strong>
                    <span className="pro-metric-val">
                      {formatNumber(data.currentValue)} {formatUnit(data.unit)}
                    </span>
                  </div>
                  {data.unavailableReason ? (
                    <p className="assessment-warning" role="note">
                      {p(REASON_LABELS[data.unavailableReason] || data.unavailableReason)}
                    </p>
                  ) : (
                    <ProgressChart
                      metricKey={key}
                      metricData={data}
                      label={p(DEFAULT_METRIC_CONFIG[key]?.label || key)}
                    />
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Disclaimer */}
          {report.snapshot?.disclaimer && (
            <p className="pro-disclaimer" role="note">
              {p(report.snapshot.disclaimer)}
            </p>
          )}

          <div className="pro-actions">
            <Button
              size="sm"
              icon="download"
              disabled={exporting !== null || Boolean(report.revokedAt)}
              onClick={() => handleExport('json')}
            >
              {exporting === 'json' ? p('Exporting…') : p('Export JSON')}
            </Button>
            <Button
              size="sm"
              icon="download"
              disabled={exporting !== null || Boolean(report.revokedAt)}
              onClick={() => handleExport('csv')}
            >
              {exporting === 'csv' ? p('Exporting…') : p('Export CSV')}
            </Button>
            {isCoach && !report.revokedAt && (
              <Button
                size="sm"
                variant="danger"
                icon="trash"
                disabled={revoking}
                onClick={handleRevoke}
              >
                {revoking ? p('Saving…') : p('Revoke')}
              </Button>
            )}
          </div>
        </div>
      ) : null}
    </AccessibleModal>
  )
}

export function ProgressSummaryView({
  summary,
  loading,
  error,
  onRetry,
  preset,
  onPresetChange,
  customFrom,
  setCustomFrom,
  customTo,
  setCustomTo,
  onApplyCustom,
  catalog,
}) {
  return (
    <section className="pro-summary-section" aria-labelledby="pro-summary-heading">
      <h3 id="pro-summary-heading" className="sr-only">{p('Progress summary')}</h3>
      <div className="pro-period-row">
        <label className="pro-field">
          <span>{p('Period')}</span>
          <select
            value={preset}
            onChange={e => onPresetChange(e.target.value === 'custom' ? 'custom' : Number(e.target.value))}
          >
            <option value={7}>{p('7 days')}</option>
            <option value={30}>{p('30 days')}</option>
            <option value={90}>{p('90 days')}</option>
            <option value="custom">{p('Custom range')}</option>
          </select>
        </label>
        {summary?.period && (
          <span>
            {formatDate(summary.period.from)} — {formatDate(summary.period.to)} ({summary.period.days} {p('Days')})
          </span>
        )}
      </div>

      {preset === 'custom' && (
        <div className="pro-grid-fields" style={{ marginBottom: 12 }}>
          <label className="pro-field">
            <span>{p('From')}</span>
            <TextField
              type="date"
              value={customFrom}
              onChange={e => setCustomFrom(e.target.value)}
            />
          </label>
          <label className="pro-field">
            <span>{p('To')}</span>
            <TextField
              type="date"
              value={customTo}
              onChange={e => setCustomTo(e.target.value)}
            />
          </label>
          <div style={{ display: 'flex', alignItems: 'flex-end', marginBottom: 14 }}>
            <Button size="sm" variant="primary" onClick={onApplyCustom}>
              {p('Try again')}
            </Button>
          </div>
        </div>
      )}

      {loading && !summary && <div className="pro-loading">{p('Loading…')}</div>}

      {error && (
        <div className="card pro-load-error" role="alert">
          <p>{p('Could not load progress summary.')}</p>
          <Button size="sm" onClick={onRetry}>{p('Try again')}</Button>
        </div>
      )}

      {summary && (
        <div className="pro-summary-metrics-grid">
          {summary.metrics && Object.entries(summary.metrics).map(([key, data]) => {
            const label = p(DEFAULT_METRIC_CONFIG[key]?.label || key)
            const unit = formatUnit(data.unit)
            return (
              <article key={key} className="pro-metric-card card">
                <div className="pro-link-head">
                  <div>
                    <h3>{label}</h3>
                    <div className="pro-meta">
                      {data.coverage?.observed != null && (
                        <span>{p('Coverage: {0}', `${data.coverage.observed} ${p('Days')}`)}</span>
                      )}
                      {data.freshness?.state && (
                        <span> · {p('Freshness: {0}', p(data.freshness.state === 'fresh' ? 'Fresh' : 'Stale'))}</span>
                      )}
                    </div>
                  </div>
                  <strong className="pro-metric-large-val">
                    {formatNumber(data.currentValue)} {unit}
                  </strong>
                </div>

                {data.unavailableReason ? (
                  <p className="assessment-warning" role="note">
                    {p(REASON_LABELS[data.unavailableReason] || data.unavailableReason)}
                  </p>
                ) : (
                  <ProgressChart metricKey={key} metricData={data} label={label} />
                )}
              </article>
            )
          })}

          {summary.disclaimer && (
            <p className="pro-disclaimer" role="note">
              {p(summary.disclaimer)}
            </p>
          )}
        </div>
      )}
    </section>
  )
}

export function ProgressGoalsView({
  goals,
  loading,
  error,
  onRetry,
  statusFilter,
  setStatusFilter,
  hasMore,
  onLoadMore,
  isCoach = false,
  onNewGoal,
  onEditGoal,
  onArchiveGoal,
}) {
  return (
    <section className="pro-goals-section" aria-labelledby="pro-goals-heading">
      <div className="pro-panel-head">
        <label className="pro-field" style={{ margin: 0, minWidth: 150 }}>
          <span>{p('Filter by status')}</span>
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
          >
            <option value="all">{p('All')}</option>
            <option value="active">{p('Active')}</option>
            <option value="achieved">{p('Achieved')}</option>
            <option value="archived">{p('Archived')}</option>
          </select>
        </label>
        {isCoach && (
          <Button size="sm" icon="plusCircle" onClick={onNewGoal}>
            {p('New goal')}
          </Button>
        )}
      </div>

      {loading && !goals.length && <div className="pro-loading">{p('Loading…')}</div>}

      {error && (
        <div className="card pro-load-error" role="alert">
          <p>{p('Could not load progress goals.')}</p>
          <Button size="sm" onClick={onRetry}>{p('Try again')}</Button>
        </div>
      )}

      {!loading && !goals.length && !error ? (
        <EmptyState
          icon="target"
          title={p('No goals yet')}
          text={p('No progress goals found.')}
        />
      ) : (
        <div className="pro-goal-list">
          {goals.map(goal => {
            const metricLabel = p(DEFAULT_METRIC_CONFIG[goal.metric]?.label || goal.metric)
            const unit = formatUnit(goal.unit)
            const progress = goal.progress
            const evalState = progress?.state || goal.status
            return (
              <article key={goal.id} className="pro-goal-card card" data-status={goal.status}>
                <div className="pro-link-head">
                  <div>
                    <h3>{metricLabel}</h3>
                    <div className="pro-meta">
                      <span>{p('Baseline')}: {formatNumber(goal.baselineValue)} {unit}</span>
                      {' → '}
                      <span>{p('Target value')}: {formatNumber(goal.targetValue)} {unit}</span>
                    </div>
                  </div>
                  <span className={`pro-status ${goal.status}`}>
                    {p(STATE_LABELS[evalState] || evalState)}
                  </span>
                </div>

                {progress?.currentValue != null && (
                  <div className="pro-goal-progress">
                    <div className="pro-panel-head">
                      <span>{p('Current value')}: {formatNumber(progress.currentValue)} {unit}</span>
                      {progress.percent != null && <strong>{Math.round(progress.percent)}%</strong>}
                    </div>
                    {progress.percent != null && (
                      <progress max="100" value={Math.max(0, Math.min(100, progress.percent))} />
                    )}
                  </div>
                )}

                <div className="pro-dates">
                  <span>{formatDate(goal.startDate)} — {formatDate(goal.targetDate)}</span>
                  <span>{goal.timezone}</span>
                  <small style={{ color: 'var(--label-2)' }}>_rev: {goal._rev}</small>
                </div>

                {isCoach && goal.status !== 'archived' && (
                  <div className="pro-actions">
                    <Button size="sm" onClick={() => onEditGoal(goal)}>
                      {p('Edit goal')}
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => onArchiveGoal(goal)}>
                      {p('Archive goal')}
                    </Button>
                  </div>
                )}
              </article>
            )
          })}
          {hasMore && (
            <div className="pro-actions">
              <Button size="sm" disabled={loading} onClick={onLoadMore}>
                {loading ? p('Loading…') : p('Load more goals')}
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  )
}

export function ProgressReportsView({
  reports,
  loading,
  error,
  onRetry,
  hasMore,
  onLoadMore,
  isCoach = false,
  onGenerateReport,
  onViewReport,
  onExportReport,
  onRevokeReport,
}) {
  const [exportingId, setExportingId] = useState(null)

  const handleExport = async (reportId, format) => {
    if (exportingId) return
    setExportingId(`${reportId}-${format}`)
    try {
      await onExportReport(reportId, format)
    } finally {
      setExportingId(null)
    }
  }

  return (
    <section className="pro-reports-section" aria-labelledby="pro-reports-heading">
      <div className="pro-panel-head">
        <strong>{p('Reports')}</strong>
        {isCoach && (
          <Button size="sm" icon="plusCircle" onClick={onGenerateReport}>
            {p('Generate report')}
          </Button>
        )}
      </div>

      {loading && !reports.length && <div className="pro-loading">{p('Loading…')}</div>}

      {error && (
        <div className="card pro-load-error" role="alert">
          <p>{p('Could not load progress reports.')}</p>
          <Button size="sm" onClick={onRetry}>{p('Try again')}</Button>
        </div>
      )}

      {!loading && !reports.length && !error ? (
        <EmptyState
          icon="chart"
          title={p('No reports yet')}
          text={p('No progress reports found.')}
        />
      ) : (
        <div className="pro-report-list">
          {reports.map(report => (
            <article key={report.id} className="pro-report-card card" data-status={report.revokedAt ? 'archived' : 'active'}>
              <div className="pro-link-head">
                <div>
                  <h3>{`${formatDate(report.interval?.from)} — ${formatDate(report.interval?.to)}`}</h3>
                  <div className="pro-meta">
                    {formatDate(report.createdAt)} · {report.timezone}
                  </div>
                </div>
                {report.revokedAt ? (
                  <span className="pro-status ended">{p('Archived')}</span>
                ) : (
                  <span className="pro-status active">{p('Active')}</span>
                )}
              </div>

              <p className="pro-report-summary">{report.summary}</p>

              <div className="pro-actions">
                <Button size="sm" onClick={() => onViewReport(report.id)}>
                  {p('View report')}
                </Button>
                <Button
                  size="sm"
                  icon="download"
                  disabled={Boolean(exportingId) || Boolean(report.revokedAt)}
                  onClick={() => handleExport(report.id, 'json')}
                >
                  {exportingId === `${report.id}-json` ? p('Exporting…') : p('Export JSON')}
                </Button>
                <Button
                  size="sm"
                  icon="download"
                  disabled={Boolean(exportingId) || Boolean(report.revokedAt)}
                  onClick={() => handleExport(report.id, 'csv')}
                >
                  {exportingId === `${report.id}-csv` ? p('Exporting…') : p('Export CSV')}
                </Button>
                {isCoach && !report.revokedAt && (
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => onRevokeReport(report.id)}
                  >
                    {p('Revoke')}
                  </Button>
                )}
              </div>
            </article>
          ))}
          {hasMore && (
            <div className="pro-actions">
              <Button size="sm" disabled={loading} onClick={onLoadMore}>
                {loading ? p('Loading…') : p('Load more reports')}
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  )
}

export function CoachProgressPanel({ link, athleteId }) {
  const [tab, setTab] = useState('summary')
  const [catalog, setCatalog] = useState(null)
  const zone = useMemo(() => browserTimeZone().value, [])

  // Summary State
  const [summaryPreset, setSummaryPreset] = useState(30)
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [summary, setSummary] = useState(null)
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [summaryError, setSummaryError] = useState(false)

  // Goals State
  const [goals, setGoals] = useState([])
  const [goalsFilter, setGoalsFilter] = useState('all')
  const [goalsLoading, setGoalsLoading] = useState(false)
  const [goalsError, setGoalsError] = useState(false)
  const [goalsCursor, setGoalsCursor] = useState(null)
  const [goalsHasMore, setGoalsHasMore] = useState(false)

  // Reports State
  const [reports, setReports] = useState([])
  const [reportsLoading, setReportsLoading] = useState(false)
  const [reportsError, setReportsError] = useState(false)
  const [reportsCursor, setReportsCursor] = useState(null)
  const [reportsHasMore, setReportsHasMore] = useState(false)

  // Modal States
  const [goalModalOpen, setGoalModalOpen] = useState(false)
  const [editingGoal, setEditingGoal] = useState(null)
  const [reportModalOpen, setReportModalOpen] = useState(false)
  const [detailReportId, setDetailReportId] = useState(null)

  // Load Catalog
  useEffect(() => {
    fetchMetricCatalog()
      .then(res => setCatalog(res))
      .catch(() => {})
  }, [])

  // Load Summary
  const loadSummary = useCallback(async () => {
    if (!athleteId) return
    setSummaryLoading(true)
    setSummaryError(false)
    try {
      const opts = { linkId: link?.id, timezone: zone }
      if (summaryPreset === 'custom') {
        if (customFrom && customTo) {
          opts.from = customFrom
          opts.to = customTo
        } else {
          setSummaryLoading(false)
          return
        }
      } else {
        opts.period = summaryPreset
      }
      const res = await fetchCoachSummary(athleteId, opts)
      if (res && res.summary) setSummary(res.summary)
    } catch {
      setSummaryError(true)
    } finally {
      setSummaryLoading(false)
    }
  }, [athleteId, link?.id, zone, summaryPreset, customFrom, customTo])

  // Load Goals
  const loadGoals = useCallback(async (cursor = null, append = false) => {
    if (!athleteId) return
    setGoalsLoading(true)
    setGoalsError(false)
    try {
      const opts = { linkId: link?.id, cursor, limit: 25 }
      if (goalsFilter !== 'all') opts.status = goalsFilter
      const res = await fetchCoachGoals(athleteId, opts)
      const incoming = res.items || []
      setGoals(curr => (append ? [...curr, ...incoming] : incoming))
      setGoalsHasMore(Boolean(res.hasMore))
      setGoalsCursor(res.nextCursor || null)
    } catch {
      setGoalsError(true)
    } finally {
      setGoalsLoading(false)
    }
  }, [athleteId, link?.id, goalsFilter])

  // Load Reports
  const loadReports = useCallback(async (cursor = null, append = false) => {
    if (!athleteId) return
    setReportsLoading(true)
    setReportsError(false)
    try {
      const opts = { linkId: link?.id, cursor, limit: 25 }
      const res = await fetchCoachReports(athleteId, opts)
      const incoming = res.items || []
      setReports(curr => (append ? [...curr, ...incoming] : incoming))
      setReportsHasMore(Boolean(res.hasMore))
      setReportsCursor(res.nextCursor || null)
    } catch {
      setReportsError(true)
    } finally {
      setReportsLoading(false)
    }
  }, [athleteId, link?.id])

  useEffect(() => { loadSummary() }, [loadSummary])
  useEffect(() => { loadGoals() }, [loadGoals])
  useEffect(() => { loadReports() }, [loadReports])

  const handleGoalSaved = (saved, previous) => {
    setGoals(curr => {
      if (previous) {
        const updated = { ...saved, id: previous.id }
        return curr.map(goal => (goal.id === previous.id ? updated : goal))
      }
      return [saved, ...curr.filter(goal => goal.id !== saved.id)]
    })
    loadSummary()
  }

  const handleArchiveGoal = goal => {
    confirmSheet({
      title: p('Archive this goal?'),
      message: p('The goal will be archived and no longer tracked actively.'),
      confirmText: p('Archive'),
      danger: true,
      onConfirm: async () => {
        try {
          const res = await archiveCoachGoal(athleteId, goal.id, { _rev: goal._rev, linkId: link?.id })
          const archived = { ...res.goal, id: goal.id }
          setGoals(curr => curr.map(g => (g.id === goal.id ? archived : g)))
          loadSummary()
        } catch (err) {
          // Toast or error handling
        }
      },
    })
  }

  const handleReportCreated = report => {
    setReports(curr => [report, ...curr])
    setDetailReportId(report.id)
  }

  const handleRevokeReport = reportId => {
    confirmSheet({
      title: p('Revoke this report?'),
      message: p('Revoked reports can no longer be viewed or exported.'),
      confirmText: p('Revoke'),
      danger: true,
      onConfirm: async () => {
        try {
          await revokeCoachReport(athleteId, reportId, { linkId: link?.id })
          setReports(curr =>
            curr.map(r => (r.id === reportId ? { ...r, revokedAt: new Date().toISOString() } : r))
          )
          if (detailReportId === reportId) setDetailReportId(null) // Immediate clear
        } catch {}
      },
    })
  }

  const handleExportReport = async (reportId, format) => {
    await exportCoachReport(athleteId, reportId, format, { linkId: link?.id, triggerDownload: true })
  }

  const tabOptions = [
    { value: 'summary', label: p('Overview') },
    { value: 'goals', label: p('Goals') },
    { value: 'reports', label: p('Reports') },
  ]

  return (
    <section className="pro-progress-panel card" aria-label={p('Progress analytics')}>
      <div className="pro-panel-head">
        <strong>{p('Progress analytics')}</strong>
        <Segmented
          options={tabOptions}
          value={tab}
          onChange={setTab}
        />
      </div>

      {tab === 'summary' && (
        <ProgressSummaryView
          summary={summary}
          loading={summaryLoading}
          error={summaryError}
          onRetry={loadSummary}
          preset={summaryPreset}
          onPresetChange={setSummaryPreset}
          customFrom={customFrom}
          setCustomFrom={setCustomFrom}
          customTo={customTo}
          setCustomTo={setCustomTo}
          onApplyCustom={loadSummary}
          catalog={catalog}
        />
      )}

      {tab === 'goals' && (
        <ProgressGoalsView
          goals={goals}
          loading={goalsLoading}
          error={goalsError}
          onRetry={() => loadGoals()}
          statusFilter={goalsFilter}
          setStatusFilter={setGoalsFilter}
          hasMore={goalsHasMore}
          onLoadMore={() => loadGoals(goalsCursor, true)}
          isCoach={true}
          onNewGoal={() => { setEditingGoal(null); setGoalModalOpen(true) }}
          onEditGoal={goal => { setEditingGoal(goal); setGoalModalOpen(true) }}
          onArchiveGoal={handleArchiveGoal}
        />
      )}

      {tab === 'reports' && (
        <ProgressReportsView
          reports={reports}
          loading={reportsLoading}
          error={reportsError}
          onRetry={() => loadReports()}
          hasMore={reportsHasMore}
          onLoadMore={() => loadReports(reportsCursor, true)}
          isCoach={true}
          onGenerateReport={() => setReportModalOpen(true)}
          onViewReport={id => setDetailReportId(id)}
          onExportReport={handleExportReport}
          onRevokeReport={handleRevokeReport}
        />
      )}

      <GoalModal
        isOpen={goalModalOpen}
        onClose={() => { setGoalModalOpen(false); setEditingGoal(null) }}
        onSaved={handleGoalSaved}
        goal={editingGoal}
        athleteId={athleteId}
        linkId={link?.id}
        catalog={catalog}
      />

      <ReportCreateModal
        isOpen={reportModalOpen}
        onClose={() => setReportModalOpen(false)}
        onCreated={handleReportCreated}
        athleteId={athleteId}
        linkId={link?.id}
        catalog={catalog}
      />

      <ReportDetailModal
        isOpen={Boolean(detailReportId)}
        onClose={() => setDetailReportId(null)}
        reportId={detailReportId}
        athleteId={athleteId}
        linkId={link?.id}
        isCoach={true}
        onRevoked={id => {
          setReports(curr =>
            curr.map(r => (r.id === id ? { ...r, revokedAt: new Date().toISOString() } : r))
          )
          setDetailReportId(null) // Immediate clear
        }}
      />
    </section>
  )
}

export function AthleteProgressDashboard({ links }) {
  const activeLink = useMemo(() => {
    if (!links || !Array.isArray(links)) return null
    return links.find(l => l.status === 'active') || links[0] || null
  }, [links])

  const [tab, setTab] = useState('summary')
  const [catalog, setCatalog] = useState(null)
  const zone = useMemo(() => browserTimeZone().value, [])

  // Summary State
  const [summaryPreset, setSummaryPreset] = useState(30)
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [summary, setSummary] = useState(null)
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [summaryError, setSummaryError] = useState(false)

  // Goals State
  const [goals, setGoals] = useState([])
  const [goalsFilter, setGoalsFilter] = useState('all')
  const [goalsLoading, setGoalsLoading] = useState(false)
  const [goalsError, setGoalsError] = useState(false)
  const [goalsCursor, setGoalsCursor] = useState(null)
  const [goalsHasMore, setGoalsHasMore] = useState(false)

  // Reports State
  const [reports, setReports] = useState([])
  const [reportsLoading, setReportsLoading] = useState(false)
  const [reportsError, setReportsError] = useState(false)
  const [reportsCursor, setReportsCursor] = useState(null)
  const [reportsHasMore, setReportsHasMore] = useState(false)

  // Detail Modal
  const [detailReportId, setDetailReportId] = useState(null)

  useEffect(() => {
    fetchMetricCatalog()
      .then(res => setCatalog(res))
      .catch(() => {})
  }, [])

  const loadSummary = useCallback(async () => {
    setSummaryLoading(true)
    setSummaryError(false)
    try {
      const opts = { linkId: activeLink?.id, timezone: zone }
      if (summaryPreset === 'custom') {
        if (customFrom && customTo) {
          opts.from = customFrom
          opts.to = customTo
        } else {
          setSummaryLoading(false)
          return
        }
      } else {
        opts.period = summaryPreset
      }
      const res = await fetchAthleteSummary(opts)
      if (res && res.summary) setSummary(res.summary)
    } catch {
      setSummaryError(true)
    } finally {
      setSummaryLoading(false)
    }
  }, [activeLink?.id, zone, summaryPreset, customFrom, customTo])

  const loadGoals = useCallback(async (cursor = null, append = false) => {
    setGoalsLoading(true)
    setGoalsError(false)
    try {
      const opts = { linkId: activeLink?.id, cursor, limit: 25 }
      if (goalsFilter !== 'all') opts.status = goalsFilter
      const res = await fetchAthleteGoals(opts)
      const incoming = res.items || []
      setGoals(curr => (append ? [...curr, ...incoming] : incoming))
      setGoalsHasMore(Boolean(res.hasMore))
      setGoalsCursor(res.nextCursor || null)
    } catch {
      setGoalsError(true)
    } finally {
      setGoalsLoading(false)
    }
  }, [activeLink?.id, goalsFilter])

  const loadReports = useCallback(async (cursor = null, append = false) => {
    setReportsLoading(true)
    setReportsError(false)
    try {
      const opts = { linkId: activeLink?.id, cursor, limit: 25 }
      const res = await fetchAthleteReports(opts)
      const incoming = res.items || []
      setReports(curr => (append ? [...curr, ...incoming] : incoming))
      setReportsHasMore(Boolean(res.hasMore))
      setReportsCursor(res.nextCursor || null)
    } catch {
      setReportsError(true)
    } finally {
      setReportsLoading(false)
    }
  }, [activeLink?.id])

  useEffect(() => { loadSummary() }, [loadSummary])
  useEffect(() => { loadGoals() }, [loadGoals])
  useEffect(() => { loadReports() }, [loadReports])

  const handleExportReport = async (reportId, format) => {
    await exportAthleteReport(reportId, format, { linkId: activeLink?.id, triggerDownload: true })
  }

  const tabOptions = [
    { value: 'summary', label: p('Overview') },
    { value: 'goals', label: p('Goals') },
    { value: 'reports', label: p('Reports') },
  ]

  return (
    <div className="pro-athlete-progress-dashboard">
      <div className="pro-panel-head" style={{ marginBottom: 14 }}>
        <Segmented
          options={tabOptions}
          value={tab}
          onChange={setTab}
        />
      </div>

      {tab === 'summary' && (
        <ProgressSummaryView
          summary={summary}
          loading={summaryLoading}
          error={summaryError}
          onRetry={loadSummary}
          preset={summaryPreset}
          onPresetChange={setSummaryPreset}
          customFrom={customFrom}
          setCustomFrom={setCustomFrom}
          customTo={customTo}
          setCustomTo={setCustomTo}
          onApplyCustom={loadSummary}
          catalog={catalog}
        />
      )}

      {tab === 'goals' && (
        <ProgressGoalsView
          goals={goals}
          loading={goalsLoading}
          error={goalsError}
          onRetry={() => loadGoals()}
          statusFilter={goalsFilter}
          setStatusFilter={setGoalsFilter}
          hasMore={goalsHasMore}
          onLoadMore={() => loadGoals(goalsCursor, true)}
          isCoach={false}
        />
      )}

      {tab === 'reports' && (
        <ProgressReportsView
          reports={reports}
          loading={reportsLoading}
          error={reportsError}
          onRetry={() => loadReports()}
          hasMore={reportsHasMore}
          onLoadMore={() => loadReports(reportsCursor, true)}
          isCoach={false}
          onViewReport={id => setDetailReportId(id)}
          onExportReport={handleExportReport}
        />
      )}

      <ReportDetailModal
        isOpen={Boolean(detailReportId)}
        onClose={() => setDetailReportId(null)}
        reportId={detailReportId}
        linkId={activeLink?.id}
        isCoach={false}
      />
    </div>
  )
}
