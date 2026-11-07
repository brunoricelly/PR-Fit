import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

register('data:text/javascript,' + encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    const result = await nextLoad(url, context);
    if (result.format === "module" && result.source) {
      const text = Buffer.from(result.source).toString("utf8");
      if (text.includes("import.meta.env")) {
        return {
          ...result,
          source: text.replaceAll("import.meta.env", "(globalThis.__env || {})")
        };
      }
    }
    return result;
  }
`))
globalThis.__env = { VITE_MOBILE: '0' }

const {
  buildProgressQuery,
  extractFilename,
  triggerBlobDownload,
  parseApiError,
  fetchMetricCatalog,
  fetchCoachGoals,
  fetchCoachGoal,
  createCoachGoal,
  patchCoachGoal,
  archiveCoachGoal,
  fetchCoachSummary,
  fetchAthleteGoals,
  fetchAthleteSummary,
  fetchCoachReports,
  createCoachReport,
  fetchCoachReport,
  exportCoachReport,
  revokeCoachReport,
  fetchAthleteReports,
  fetchAthleteReport,
  exportAthleteReport,
  progressApi,
} = await import('./progress-api.js')

test('buildProgressQuery formats arrays, numbers, and strips empty entries', () => {
  assert.equal(buildProgressQuery({}), '')
  assert.equal(buildProgressQuery({ status: 'active', limit: 25 }), '?status=active&limit=25')
  assert.equal(
    buildProgressQuery({ metrics: ['body_weight', 'body_fat_percent'], period: 30 }),
    '?metrics=body_weight%2Cbody_fat_percent&period=30',
  )
  assert.equal(buildProgressQuery({ empty: '', nil: null, undef: undefined, keep: 0 }), '?keep=0')
})

test('extractFilename handles standard, UTF-8 encoded, and fallback filenames', () => {
  assert.equal(extractFilename('attachment; filename="report-123.csv"'), 'report-123.csv')
  assert.equal(extractFilename("attachment; filename*=UTF-8''relat%C3%B3rio.pdf"), 'relatório.pdf')
  assert.equal(extractFilename(null, 'default.json'), 'default.json')
  assert.equal(extractFilename('attachment', 'fallback.csv'), 'fallback.csv')
})

test('triggerBlobDownload handles non-DOM and DOM environments', () => {
  // Non-DOM
  const originalWindow = globalThis.window
  const originalDocument = globalThis.document
  try {
    delete globalThis.window
    delete globalThis.document
    const nonDom = triggerBlobDownload(new Blob(['test']), 'test.txt')
    assert.equal(nonDom.ok, false)
    assert.match(nonDom.error, /DOM environment required/)
  } finally {
    globalThis.window = originalWindow
    globalThis.document = originalDocument
  }

  // DOM simulation
  let revoked = null
  let clicked = false
  let appended = false
  let removed = false

  globalThis.window = {
    URL: {
      createObjectURL: () => 'blob:https://opengym.test/uuid',
      revokeObjectURL: url => { revoked = url },
    },
  }
  const fakeElement = {
    href: '',
    download: '',
    rel: '',
    style: {},
    click: () => { clicked = true },
  }
  globalThis.document = {
    createElement: tag => (tag === 'a' ? fakeElement : {}),
    body: {
      appendChild: el => { appended = true },
      removeChild: el => { removed = true },
    },
  }

  try {
    const domRes = triggerBlobDownload(new Blob(['hello']), 'report.csv', { revokeDelayMs: 0 })
    assert.equal(domRes.ok, true)
    assert.equal(domRes.filename, 'report.csv')
    assert.equal(clicked, true)
    assert.equal(appended, true)
    assert.equal(removed, true)
    assert.equal(revoked, 'blob:https://opengym.test/uuid')
  } finally {
    if (originalWindow) globalThis.window = originalWindow; else delete globalThis.window
    if (originalDocument) globalThis.document = originalDocument; else delete globalThis.document
  }
})

test('parseApiError normalizes 429, 409, 410, and generic errors', () => {
  const err429 = { status: 429, code: 'rate_limited', retryAfter: 45, message: 'Too many requests' }
  assert.deepEqual(parseApiError(err429), {
    status: 429,
    code: 'rate_limited',
    retryAfter: 45,
    message: 'Too many requests',
    data: null,
  })

  const err409 = { status: 409, data: { error: 'goal version is stale', code: 'stale_version' } }
  assert.deepEqual(parseApiError(err409), {
    status: 409,
    code: 'stale_version',
    retryAfter: null,
    message: 'Request failed',
    data: { error: 'goal version is stale', code: 'stale_version' },
  })

  const err410 = { status: 410, code: 'report_revoked' }
  assert.equal(parseApiError(err410).code, 'report_revoked')

  const generic = new Error('network down')
  assert.deepEqual(parseApiError(generic), {
    status: null,
    code: 'unknown',
    retryAfter: null,
    message: 'network down',
    data: null,
  })
})

test('route methods invoke fetch with correct URLs, methods, headers and payloads', async () => {
  const recorded = []
  const originalFetch = globalThis.fetch

  globalThis.fetch = async (url, init = {}) => {
    recorded.push({ url: String(url), ...init })
    const isExport = String(url).includes('/export')
    if (isExport) {
      return {
        ok: true,
        status: 200,
        headers: new Headers({
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="custom-export.csv"',
        }),
        blob: async () => new Blob(['sample,data'], { type: 'text/csv' }),
      }
    }
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'Content-Type': 'application/json' }),
      json: async () => ({ ok: true, data: { id: 'test_123' } }),
    }
  }

  try {
    // 1. Metric catalog
    await fetchMetricCatalog()
    assert.equal(recorded.at(-1).url.endsWith('/api/progress/metrics'), true)

    // 2. Coach goals
    await fetchCoachGoals('ath_1', { status: 'active', limit: 10 })
    assert.equal(recorded.at(-1).url.endsWith('/api/coach/athletes/ath_1/progress-goals?status=active&limit=10'), true)

    // 3. Coach goal detail
    await fetchCoachGoal('ath_1', 'g_1', { linkId: 'lnk_1' })
    assert.equal(recorded.at(-1).url.endsWith('/api/coach/athletes/ath_1/progress-goals/g_1?linkId=lnk_1'), true)

    // 4. Create coach goal
    const goalPayload = { metric: 'body_weight', direction: 'decrease', baselineValue: 80, targetValue: 75, startDate: '2026-01-01', targetDate: '2026-06-01', timezone: 'UTC' }
    await createCoachGoal('ath_1', goalPayload)
    const createReq = recorded.at(-1)
    assert.equal(createReq.url.endsWith('/api/coach/athletes/ath_1/progress-goals'), true)
    assert.equal(createReq.method, 'POST')
    assert.deepEqual(JSON.parse(createReq.body), goalPayload)

    // 5. Patch coach goal
    await assert.rejects(
      async () => patchCoachGoal('ath_1', 'g_1', { baselineValue: 82 }),
      /_rev must be a safe integer/,
    )
    await patchCoachGoal('ath_1', 'g_1', { _rev: 1, baselineValue: 82 })
    const patchReq = recorded.at(-1)
    assert.equal(patchReq.url.endsWith('/api/coach/athletes/ath_1/progress-goals/g_1'), true)
    assert.equal(patchReq.method, 'PATCH')
    assert.deepEqual(JSON.parse(patchReq.body), { _rev: 1, baselineValue: 82 })

    // 6. Archive coach goal
    await assert.rejects(
      async () => archiveCoachGoal('ath_1', 'g_1'),
      /_rev must be a safe integer/,
    )
    await archiveCoachGoal('ath_1', 'g_1', { _rev: 3, linkId: 'lnk_1' })
    const archiveReq = recorded.at(-1)
    assert.equal(archiveReq.url.endsWith('/api/coach/athletes/ath_1/progress-goals/g_1?linkId=lnk_1'), true)
    assert.equal(archiveReq.method, 'DELETE')
    assert.equal(archiveReq.headers['If-Match'], '"3"')
    assert.deepEqual(JSON.parse(archiveReq.body), { _rev: 3 })

    // 7. Coach summary
    await fetchCoachSummary('ath_1', { timezone: 'America/Sao_Paulo', period: 30 })
    assert.equal(recorded.at(-1).url.endsWith('/api/coach/athletes/ath_1/progress-summary?timezone=America%2FSao_Paulo&period=30'), true)

    // 8. Athlete goals
    await fetchAthleteGoals({ status: 'achieved' })
    assert.equal(recorded.at(-1).url.endsWith('/api/athlete/progress-goals?status=achieved'), true)

    // 9. Athlete summary
    await fetchAthleteSummary({ timezone: 'UTC', metrics: ['body_weight'] })
    assert.equal(recorded.at(-1).url.endsWith('/api/athlete/progress-summary?timezone=UTC&metrics=body_weight'), true)

    // 10. Coach reports
    await fetchCoachReports('ath_1', { status: 'active' })
    assert.equal(recorded.at(-1).url.endsWith('/api/coach/athletes/ath_1/progress-reports?status=active'), true)

    // 11. Create coach report
    const reportPayload = { metrics: ['body_weight'], timezone: 'UTC' }
    await createCoachReport('ath_1', reportPayload)
    const reportCreateReq = recorded.at(-1)
    assert.equal(reportCreateReq.url.endsWith('/api/coach/athletes/ath_1/progress-reports'), true)
    assert.equal(reportCreateReq.method, 'POST')
    assert.deepEqual(JSON.parse(reportCreateReq.body), reportPayload)

    // 12. Coach report detail
    await fetchCoachReport('ath_1', 'prep_1')
    assert.equal(recorded.at(-1).url.endsWith('/api/coach/athletes/ath_1/progress-reports/prep_1'), true)

    // 13. Export coach report
    const exportRes = await exportCoachReport('ath_1', 'prep_1', 'csv', { triggerDownload: false })
    assert.equal(recorded.at(-1).url.endsWith('/api/coach/athletes/ath_1/progress-reports/prep_1/export?format=csv'), true)
    assert.equal(exportRes.filename, 'custom-export.csv')
    assert.equal(exportRes.downloaded, false)

    // 14. Revoke coach report
    await revokeCoachReport('ath_1', 'prep_1')
    const revokeReq = recorded.at(-1)
    assert.equal(revokeReq.url.endsWith('/api/coach/athletes/ath_1/progress-reports/prep_1/revoke'), true)
    assert.equal(revokeReq.method, 'POST')

    // 15. Athlete reports
    await fetchAthleteReports({ status: 'revoked' })
    assert.equal(recorded.at(-1).url.endsWith('/api/athlete/progress-reports?status=revoked'), true)

    // 16. Athlete report detail
    await fetchAthleteReport('prep_2')
    assert.equal(recorded.at(-1).url.endsWith('/api/athlete/progress-reports/prep_2'), true)

    // 17. Athlete export report
    const athExportRes = await exportAthleteReport('prep_2', 'json', { triggerDownload: false })
    assert.equal(recorded.at(-1).url.endsWith('/api/athlete/progress-reports/prep_2/export?format=json'), true)
    assert.equal(athExportRes.filename, 'custom-export.csv')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('progressApi exports all requested operations and helpers', () => {
  const expectedMethods = [
    'fetchMetricCatalog',
    'fetchCoachGoals',
    'fetchCoachGoal',
    'createCoachGoal',
    'patchCoachGoal',
    'archiveCoachGoal',
    'fetchCoachSummary',
    'fetchAthleteGoals',
    'fetchAthleteSummary',
    'fetchCoachReports',
    'createCoachReport',
    'fetchCoachReport',
    'exportCoachReport',
    'revokeCoachReport',
    'fetchAthleteReports',
    'fetchAthleteReport',
    'exportAthleteReport',
    'parseApiError',
    'triggerBlobDownload',
    'extractFilename',
    'buildProgressQuery',
  ]
  for (const name of expectedMethods) {
    assert.equal(typeof progressApi[name], 'function', `progressApi.${name} must be a function`)
  }
})
