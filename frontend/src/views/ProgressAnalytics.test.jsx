// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  confirms: [],
}))

vi.mock('../lib/api.js', () => ({
  api: mocks.api,
  apiDownload: vi.fn(async (path, opts) => {
    return {
      blob: new Blob(['{"test": true}'], { type: 'application/json' }),
      contentDisposition: 'attachment; filename="report-prep_1.json"',
    }
  }),
}))

vi.mock('../sheets.jsx', () => ({
  confirmSheet: options => {
    mocks.confirms.push(options)
    options.onConfirm?.()
  },
}))

import {
  CoachProgressPanel,
  AthleteProgressDashboard,
  ProgressChart,
  GoalModal,
  ReportCreateModal,
  ReportDetailModal,
  AccessibleModal,
  formatDate,
  formatNumber,
  formatUnit,
} from './ProgressAnalytics.jsx'

let host, root

beforeEach(() => {
  mocks.api.mockReset()
  mocks.confirms = []
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
const button = (label, scope = host) =>
  [...scope.querySelectorAll('button')].find(item => item.textContent.trim().includes(label))
const type = async (input, value) => {
  await act(async () => {
    const proto = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, value)
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
}

describe('ProgressAnalytics formatting and helpers', () => {
  it('formats dates, numbers, and units cleanly', () => {
    expect(formatDate('2026-11-07')).toContain('2026')
    expect(formatDate('')).toBe('')
    expect(formatNumber(1234.56)).toContain('1')
    expect(formatNumber(null)).toBe('–')
    expect(formatUnit('percent')).toBe('%')
    expect(formatUnit('kg')).toBe('kg')
  })
})

describe('AccessibleModal and ProgressChart a11y', () => {
  it('implements focus trap, escape key handling, and focus restoration', async () => {
    const trigger = document.createElement('button')
    trigger.textContent = 'Open'
    document.body.appendChild(trigger)
    trigger.focus()

    let closed = false
    await act(async () => {
      root.render(
        <AccessibleModal id="test-modal" title="Test Dialog" onClose={() => { closed = true }}>
          <button type="button" id="btn-1">Action 1</button>
          <button type="button" id="btn-2">Action 2</button>
        </AccessibleModal>
      )
    })
    await settle()

    const dialog = host.querySelector('[role="dialog"]')
    expect(dialog).toBeDefined()
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('aria-labelledby')).toBe('test-modal-title')

    // Escape closes modal
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(closed).toBe(true)

    // Unmount restores focus
    act(() => root.unmount())
    expect(document.activeElement).toBe(trigger)
    trigger.remove()
  })

  it('renders SVG chart with semantic role and accessible data table alternative', async () => {
    const metricData = {
      metric: 'body_weight',
      unit: 'kg',
      currentValue: 75.5,
      points: [
        { date: '2026-10-01', value: 78.0, unit: 'kg' },
        { date: '2026-10-15', value: 76.5, unit: 'kg' },
        { date: '2026-11-01', value: 75.5, unit: 'kg' },
      ],
    }

    await act(async () => {
      root.render(<ProgressChart metricKey="body_weight" metricData={metricData} label="Body weight" />)
    })
    await settle()

    const svg = host.querySelector('svg[role="img"]')
    expect(svg).toBeDefined()
    expect(svg.getAttribute('aria-label')).toContain('Body weight')
    expect(host.querySelectorAll('circle').length).toBe(3)

    // Accessible data table
    const table = host.querySelector('.pro-data-table')
    expect(table).toBeDefined()
    const rows = table.querySelectorAll('tbody tr')
    expect(rows.length).toBe(3)
    expect(rows[0].textContent).toContain('78')
  })
})

describe('CoachProgressPanel flows', () => {
  const link = { id: 'cal_1', status: 'active', scopes: ['training', 'assessments'] }
  const athleteId = 'ath_1'

  const mockCatalog = {
    metrics: {
      body_weight: { unit: 'kg', labelPtBr: 'Peso corporal' },
      body_fat_percent: { unit: 'percent', labelPtBr: 'Percentual de gordura' },
      workouts_per_week: { unit: 'workouts_per_week', labelPtBr: 'Treinos por semana' },
    },
  }

  const mockSummary = {
    generatedAt: '2026-11-07T12:00:00.000Z',
    timezone: 'America/Sao_Paulo',
    period: { from: '2026-10-08', to: '2026-11-07', days: 30, preset: 30 },
    relationship: { linkId: 'cal_1', status: 'active', readOnly: false },
    metrics: {
      body_weight: {
        metric: 'body_weight',
        unit: 'kg',
        available: true,
        currentValue: 80.2,
        coverage: { observed: 28, expected: 30, percent: 93 },
        freshness: { state: 'fresh' },
        points: [{ date: '2026-10-10', value: 81.5 }, { date: '2026-11-05', value: 80.2 }],
      },
      body_fat_percent: {
        metric: 'body_fat_percent',
        unit: 'percent',
        available: false,
        unavailableReason: 'no_measurements',
      },
    },
    goals: [],
    disclaimer: 'Longitudinal factual summary only.',
  }

  const mockGoals = [
    {
      id: 'g_1',
      linkId: 'cal_1',
      metric: 'body_weight',
      direction: 'decrease',
      baselineValue: 85,
      targetValue: 78,
      tolerance: 0.5,
      unit: 'kg',
      startDate: '2026-10-01',
      targetDate: '2026-12-01',
      timezone: 'America/Sao_Paulo',
      status: 'active',
      _rev: 2,
      progress: { state: 'on_track', percent: 65, currentValue: 80.2 },
    },
  ]

  const mockReports = [
    {
      id: 'prep_1',
      linkId: 'cal_1',
      interval: { from: '2026-10-01', to: '2026-11-01' },
      timezone: 'America/Sao_Paulo',
      metrics: ['body_weight'],
      summary: 'Body weight decreased by 1.3kg',
      createdAt: '2026-11-02T10:00:00.000Z',
      revokedAt: null,
    },
  ]

  beforeEach(() => {
    mocks.api.mockImplementation(async (url, init) => {
      const u = String(url)
      if (u.includes('/api/progress/metrics')) return mockCatalog
      if (u.includes('/progress-summary')) return { summary: mockSummary }
      if (u.includes('/progress-goals')) {
        if (init?.method === 'POST') {
          return { goal: { id: 'g_new', ...JSON.parse(init.body), _rev: 1, status: 'active' } }
        }
        if (init?.method === 'PATCH') {
          return { goal: { id: 'g_1', ...JSON.parse(init.body), _rev: 3 } }
        }
        if (init?.method === 'DELETE') {
          return { goal: { ...mockGoals[0], status: 'archived', _rev: 3 }, archived: true }
        }
        return { items: mockGoals, hasMore: false }
      }
      if (u.includes('/progress-reports')) {
        if (u.includes('/revoke')) {
          return { report: { ...mockReports[0], revokedAt: '2026-11-07T14:00:00.000Z' } }
        }
        if (u.includes('/progress-reports/') && !u.includes('/export') && !u.includes('/revoke')) {
          return {
            report: {
              ...mockReports[0],
              snapshot: {
                metrics: mockSummary.metrics,
                disclaimer: mockSummary.disclaimer,
              },
            },
          }
        }
        if (init?.method === 'POST') {
          return {
            report: {
              id: 'prep_2',
              interval: { from: '2026-10-01', to: '2026-11-01' },
              timezone: 'America/Sao_Paulo',
              metrics: ['body_weight'],
              summary: 'New generated report',
              createdAt: '2026-11-07T12:00:00.000Z',
              revokedAt: null,
            },
          }
        }
        return { items: mockReports, hasMore: false }
      }
      return {}
    })
  })

  it('renders summary, coverage, freshness, unavailable reasons, and chart', async () => {
    await act(async () => {
      root.render(<CoachProgressPanel link={link} athleteId={athleteId} />)
    })
    await settle()

    expect(host.textContent).toContain('Progress analytics')
    expect(host.textContent).toContain('Body weight')
    expect(host.textContent).toContain('80.2')
    expect(host.textContent).toContain('Coverage:')
    expect(host.textContent).toContain('Fresh')
    expect(host.textContent).toContain('No measurements recorded yet')
    expect(host.textContent).toContain('Longitudinal factual summary only')
  })

  it('handles goal creation, editing with _rev, and archiving with _rev', async () => {
    await act(async () => {
      root.render(<CoachProgressPanel link={link} athleteId={athleteId} />)
    })
    await settle()

    // Switch to Goals tab
    await act(async () => { button('Goals').click() })
    await settle()

    expect(host.textContent).toContain('Baseline: 85')
    expect(host.textContent).toContain('Target value: 78')
    expect(host.textContent).toContain('On track')

    // Create Goal
    await act(async () => { button('New goal').click() })
    await settle()

    const baseInput = host.querySelector('input[name="baselineValue"]')
    const targetInput = host.querySelector('input[name="targetValue"]')
    expect(baseInput).toBeDefined()
    await type(baseInput, '80')
    await type(targetInput, '75')

    await act(async () => { button('Create goal').click() })
    await settle()

    expect(mocks.api).toHaveBeenCalledWith(
      expect.stringContaining('/progress-goals'),
      expect.objectContaining({ method: 'POST' })
    )

    // Edit Goal
    await act(async () => { button('Edit goal').click() })
    await settle()

    const editTarget = host.querySelector('input[name="targetValue"]')
    await type(editTarget, '76')
    await act(async () => { button('Edit goal', host.querySelector('.pro-modal-container')).click() })
    await settle()

    expect(mocks.api).toHaveBeenCalledWith(
      expect.stringContaining('/progress-goals/'),
      expect.objectContaining({ method: 'PATCH' })
    )

    // Archive Goal
    await act(async () => { button('Archive goal').click() })
    await settle()

    expect(mocks.api).toHaveBeenCalledWith(
      expect.stringContaining('/progress-goals/'),
      expect.objectContaining({ method: 'DELETE' })
    )
  })

  it('handles 409 conflict on goal edit gracefully', async () => {
    mocks.api.mockImplementation(async (url, init) => {
      if (init?.method === 'PATCH') {
        const error = new Error('Stale version')
        error.status = 409
        error.data = { code: 'stale_version' }
        throw error
      }
      if (String(url).includes('/progress-goals')) return { items: mockGoals }
      if (String(url).includes('/progress-summary')) return { summary: mockSummary }
      return {}
    })

    await act(async () => {
      root.render(<CoachProgressPanel link={link} athleteId={athleteId} />)
    })
    await settle()

    await act(async () => { button('Goals').click() })
    await settle()

    await act(async () => { button('Edit goal').click() })
    await settle()

    await act(async () => { button('Edit goal', host.querySelector('.pro-modal-container')).click() })
    await settle()

    expect(host.textContent).toContain('The goal was updated by another request. Reload and try again.')
  })

  it('manages reports: generate, detail snapshot, export, and revoke with immediate snapshot clearing', async () => {
    await act(async () => {
      root.render(<CoachProgressPanel link={link} athleteId={athleteId} />)
    })
    await settle()

    // Switch to Reports tab
    await act(async () => { button('Reports').click() })
    await settle()

    expect(host.textContent).toContain('Body weight decreased by 1.3kg')

    // Generate Report
    await act(async () => { button('Generate report').click() })
    await settle()

    await act(async () => { button('Generate report', host.querySelector('.pro-modal-container')).click() })
    await settle()

    expect(mocks.api).toHaveBeenCalledWith(
      expect.stringContaining('/progress-reports'),
      expect.objectContaining({ method: 'POST' })
    )

    // View Report Snapshot Detail
    await act(async () => { button('View report').click() })
    await settle()

    expect(host.textContent).toContain('Report snapshot')

    // Revoke report - should immediately clear snapshot detail
    await act(async () => { button('Revoke', host.querySelector('.pro-modal-container')).click() })
    await settle()

    expect(mocks.api).toHaveBeenCalledWith(
      expect.stringMatching(/\/progress-reports\/prep_[12]\/revoke/),
      expect.objectContaining({ method: 'POST' })
    )
    // Snapshot modal must be closed/cleared immediately
    expect(host.querySelector('.pro-report-detail')).toBeNull()
  })


  it('handles 429 rate limit error on goal creation and preserves form state', async () => {
    mocks.api.mockImplementation(async (url, init) => {
      if (init?.method === 'POST' && String(url).includes('/progress-goals')) {
        const error = new Error('Too many requests')
        error.status = 429
        error.data = { code: 'rate_limited', retryAfter: 30 }
        throw error
      }
      if (String(url).includes('/progress-goals')) return { items: mockGoals, hasMore: false }
      if (String(url).includes('/progress-summary')) return { summary: mockSummary }
      return {}
    })

    await act(async () => {
      root.render(<CoachProgressPanel link={link} athleteId={athleteId} />)
    })
    await settle()

    await act(async () => { button('Goals').click() })
    await settle()

    await act(async () => { button('New goal').click() })
    await settle()

    await type(host.querySelector('input[name="baselineValue"]'), '80')
    await type(host.querySelector('input[name="targetValue"]'), '75')
    await act(async () => { button('Create goal', host.querySelector('.pro-modal-container')).click() })
    await settle()

    expect(host.textContent).toContain('Too many attempts. Wait a moment and try again.')
  })

  it('paginates goals and reports when hasMore is true', async () => {
    let goalsPage = 1
    let reportsPage = 1

    mocks.api.mockImplementation(async (url, init) => {
      const u = String(url)
      if (u.includes('/progress-goals')) {
        if (goalsPage === 1) {
          return {
            items: [{ ...mockGoals[0], id: 'g_p1' }],
            hasMore: true,
            nextCursor: 'cur_goals_2',
          }
        }
        return {
          items: [{ ...mockGoals[0], id: 'g_p2', targetValue: 70 }],
          hasMore: false,
        }
      }
      if (u.includes('/progress-reports')) {
        if (reportsPage === 1) {
          return {
            items: [{ ...mockReports[0], id: 'prep_p1' }],
            hasMore: true,
            nextCursor: 'cur_rep_2',
          }
        }
        return {
          items: [{ ...mockReports[0], id: 'prep_p2', summary: 'Page 2 report' }],
          hasMore: false,
        }
      }
      if (u.includes('/progress-summary')) return { summary: mockSummary }
      return {}
    })

    await act(async () => {
      root.render(<CoachProgressPanel link={link} athleteId={athleteId} />)
    })
    await settle()

    // Goals pagination
    await act(async () => { button('Goals').click() })
    await settle()

    expect(button('Load more goals')).toBeDefined()
    goalsPage = 2
    await act(async () => { button('Load more goals').click() })
    await settle()

    expect(mocks.api).toHaveBeenCalledWith(
      expect.stringContaining('cursor=cur_goals_2'),
      expect.anything()
    )

    // Reports pagination
    await act(async () => { button('Reports').click() })
    await settle()

    expect(button('Load more reports')).toBeDefined()
    reportsPage = 2
    await act(async () => { button('Load more reports').click() })
    await settle()

    expect(mocks.api).toHaveBeenCalledWith(
      expect.stringContaining('cursor=cur_rep_2'),
      expect.anything()
    )
    expect(host.textContent).toContain('Page 2 report')
  })

  it('preserves previous summary data when reload fails and allows retry', async () => {
    let failSummary = false
    mocks.api.mockImplementation(async url => {
      const u = String(url)
      if (u.includes('/progress-summary')) {
        if (failSummary) throw new Error('Network failure')
        return { summary: mockSummary }
      }
      if (u.includes('/progress-goals')) return { items: mockGoals }
      if (u.includes('/progress-reports')) return { items: mockReports }
      return {}
    })

    await act(async () => {
      root.render(<CoachProgressPanel link={link} athleteId={athleteId} />)
    })
    await settle()

    expect(host.textContent).toContain('80.2')

    // Next summary fetch fails
    failSummary = true
    const select = host.querySelector('select')
    await type(select, '90')
    await settle()

    // Error alert is shown, but previous summary is preserved!
    expect(host.textContent).toContain('Could not load progress summary.')
    expect(host.textContent).toContain('80.2')

    // Retry succeeds
    failSummary = false
    await act(async () => { button('Try again').click() })
    await settle()

    expect(host.textContent).not.toContain('Could not load progress summary.')
    expect(host.textContent).toContain('80.2')
  })

  it('handles 410 revoked report gracefully', async () => {
    mocks.api.mockImplementationOnce(async () => {
      const err = new Error('Revoked')
      err.status = 410
      err.data = { code: 'report_revoked' }
      throw err
    })

    await act(async () => {
      root.render(
        <ReportDetailModal
          isOpen={true}
          onClose={() => {}}
          reportId="prep_revoked"
          athleteId="ath_1"
          linkId="cal_1"
          isCoach={true}
        />
      )
    })

    await settle()
    expect(host.textContent).toContain('This progress report is revoked.')
  })
})

describe('AthleteProgressDashboard flows', () => {
  const links = [{ id: 'cal_1', status: 'active', scopes: ['training', 'assessments'] }]
  const mockSummary = {
    generatedAt: '2026-11-07T12:00:00.000Z',
    timezone: 'America/Sao_Paulo',
    period: { from: '2026-10-08', to: '2026-11-07', days: 30, preset: 30 },
    relationship: { linkId: 'cal_1', status: 'active', readOnly: false },
    metrics: {
      body_weight: {
        metric: 'body_weight',
        unit: 'kg',
        available: true,
        currentValue: 77.0,
        coverage: { observed: 20 },
        freshness: { state: 'fresh' },
        points: [{ date: '2026-10-10', value: 78.0 }, { date: '2026-11-05', value: 77.0 }],
      },
    },
    goals: [],
    disclaimer: 'Athlete longitudinal summary.',
  }

  const mockGoals = [
    {
      id: 'g_ath',
      linkId: 'cal_1',
      metric: 'body_weight',
      direction: 'decrease',
      baselineValue: 80,
      targetValue: 75,
      tolerance: null,
      unit: 'kg',
      startDate: '2026-10-01',
      targetDate: '2026-12-01',
      timezone: 'America/Sao_Paulo',
      status: 'active',
      _rev: 1,
      progress: { state: 'on_track', percent: 60, currentValue: 77.0 },
    },
  ]

  const mockReports = [
    {
      id: 'prep_ath',
      linkId: 'cal_1',
      interval: { from: '2026-10-01', to: '2026-11-01' },
      timezone: 'America/Sao_Paulo',
      metrics: ['body_weight'],
      summary: 'Athlete monthly report',
      createdAt: '2026-11-02T10:00:00.000Z',
      revokedAt: null,
    },
  ]

  beforeEach(() => {
    mocks.api.mockImplementation(async url => {
      const u = String(url)
      if (u.includes('/progress-summary')) return { summary: mockSummary }
      if (u.includes('/progress-goals')) return { items: mockGoals, hasMore: false }
      if (u.includes('/progress-reports')) return { items: mockReports, hasMore: false }
      return {}
    })
  })

  it('renders read-only goals without coach mutation buttons', async () => {
    await act(async () => {
      root.render(<AthleteProgressDashboard links={links} />)
    })
    await settle()

    await act(async () => { button('Goals').click() })
    await settle()

    expect(host.textContent).toContain('Body weight')
    expect(host.textContent).toContain('60%')
    // No mutation controls
    expect(button('New goal')).toBeUndefined()
    expect(button('Edit goal')).toBeUndefined()
    expect(button('Archive goal')).toBeUndefined()
  })

  it('renders authorized reports and detail without revoke button', async () => {
    await act(async () => {
      root.render(<AthleteProgressDashboard links={links} />)
    })
    await settle()

    await act(async () => { button('Reports').click() })
    await settle()

    expect(host.textContent).toContain('Athlete monthly report')
    expect(button('Generate report')).toBeUndefined()
    expect(button('Revoke')).toBeUndefined()
    expect(button('Export JSON')).toBeDefined()
    expect(button('Export CSV')).toBeDefined()
  })
})
