import { api, apiDownload } from './api.js'

/**
 * Builds a query string from an options object, serializing arrays (like metrics) as comma-separated values
 * and omitting null, undefined or empty-string properties.
 */
export function buildProgressQuery(options = {}) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(options || {})) {
    if (value === undefined || value === null || value === '') continue
    if (key === 'metrics' && Array.isArray(value)) {
      if (value.length) params.set('metrics', value.join(','))
    } else {
      params.set(key, String(value))
    }
  }
  const str = params.toString()
  return str ? `?${str}` : ''
}

/**
 * Parses Content-Disposition to extract the attachment filename, falling back to a default.
 */
export function extractFilename(contentDisposition, fallback = 'download') {
  if (typeof contentDisposition === 'string') {
    const match = /filename\*?=['"]?(?:UTF-8'')?([^'";\n]+)['"]?/i.exec(contentDisposition)
    if (match && match[1]) {
      try {
        return decodeURIComponent(match[1].trim())
      } catch {
        return match[1].trim()
      }
    }
  }
  return fallback
}

/**
 * Triggers a secure browser file download from a Blob, revoking the object URL after initiation.
 */
export function triggerBlobDownload(blob, filename = 'download', { revokeDelayMs = 1000 } = {}) {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return { ok: false, error: 'DOM environment required for file download' }
  }
  const createObjectURL = window.URL?.createObjectURL || globalThis.URL?.createObjectURL
  const revokeObjectURL = window.URL?.revokeObjectURL || globalThis.URL?.revokeObjectURL
  if (typeof createObjectURL !== 'function') {
    return { ok: false, error: 'URL.createObjectURL not supported' }
  }
  const objectUrl = createObjectURL(blob)
  try {
    const link = document.createElement('a')
    link.href = objectUrl
    link.download = filename
    link.rel = 'noopener'
    link.style.display = 'none'
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    return { ok: true, filename }
  } finally {
    if (typeof revokeObjectURL === 'function') {
      if (revokeDelayMs <= 0) {
        try { revokeObjectURL(objectUrl) } catch {}
      } else {
        setTimeout(() => {
          try { revokeObjectURL(objectUrl) } catch {}
        }, revokeDelayMs)
      }
    }
  }
}

/**
 * Normalizes any error thrown by api() or apiDownload() into a stable { status, code, retryAfter, message, data } object.
 */
export function parseApiError(error) {
  const status = Number.isInteger(error?.status) ? error.status : null
  const code = typeof error?.code === 'string'
    ? error.code
    : (typeof error?.data?.code === 'string'
      ? error.data.code
      : (status ? `http_${status}` : 'unknown'))
  const rawRetry = error?.retryAfter ?? error?.data?.retryAfter
  const retryNumber = Number(rawRetry)
  const retryAfter = Number.isFinite(retryNumber) && retryNumber >= 0 ? retryNumber : null
  const message = error?.message || 'Request failed'
  const data = error?.data && typeof error.data === 'object' ? error.data : null
  return { status, code, retryAfter, message, data }
}

export async function fetchMetricCatalog(options = {}) {
  const { timeout, headers } = options
  return api('/api/progress/metrics', { timeout, headers })
}

export async function fetchCoachGoals(athleteId, options = {}) {
  const { timeout, headers, ...queryOptions } = options
  const query = buildProgressQuery(queryOptions)
  return api(`/api/coach/athletes/${athleteId}/progress-goals${query}`, { timeout, headers })
}

export async function fetchCoachGoal(athleteId, goalId, options = {}) {
  const { timeout, headers, ...queryOptions } = options
  const query = buildProgressQuery(queryOptions)
  return api(`/api/coach/athletes/${athleteId}/progress-goals/${goalId}${query}`, { timeout, headers })
}

export async function createCoachGoal(athleteId, payload, options = {}) {
  const { timeout, headers, ...queryOptions } = options
  const query = buildProgressQuery(queryOptions)
  return api(`/api/coach/athletes/${athleteId}/progress-goals${query}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    timeout,
  })
}

export async function patchCoachGoal(athleteId, goalId, payload = {}, options = {}) {
  if (!Number.isSafeInteger(payload?._rev)) {
    throw new Error('_rev must be a safe integer in payload to patch a coach goal')
  }
  const { timeout, headers, ...queryOptions } = options
  const query = buildProgressQuery(queryOptions)
  return api(`/api/coach/athletes/${athleteId}/progress-goals/${goalId}${query}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(payload),
    timeout,
  })
}

export async function archiveCoachGoal(athleteId, goalId, options = {}) {
  const normalized = typeof options === 'number' ? { _rev: options } : (options || {})
  const { _rev, rev, timeout, headers, ...queryOptions } = normalized
  const revision = _rev !== undefined ? _rev : rev
  if (!Number.isSafeInteger(revision)) {
    throw new Error('_rev must be a safe integer to archive a coach goal')
  }
  const query = buildProgressQuery(queryOptions)
  return api(`/api/coach/athletes/${athleteId}/progress-goals/${goalId}${query}`, {
    method: 'DELETE',
    headers: Object.assign({ 'If-Match': `"${revision}"` }, headers),
    body: JSON.stringify({ _rev: revision }),
    timeout,
  })
}

export async function fetchCoachSummary(athleteId, options = {}) {
  const { timeout, headers, ...queryOptions } = options
  const query = buildProgressQuery(queryOptions)
  return api(`/api/coach/athletes/${athleteId}/progress-summary${query}`, { timeout, headers })
}

export async function fetchAthleteGoals(options = {}) {
  const { timeout, headers, ...queryOptions } = options
  const query = buildProgressQuery(queryOptions)
  return api(`/api/athlete/progress-goals${query}`, { timeout, headers })
}

export async function fetchAthleteSummary(options = {}) {
  const { timeout, headers, ...queryOptions } = options
  const query = buildProgressQuery(queryOptions)
  return api(`/api/athlete/progress-summary${query}`, { timeout, headers })
}

export async function fetchCoachReports(athleteId, options = {}) {
  const { timeout, headers, ...queryOptions } = options
  const query = buildProgressQuery(queryOptions)
  return api(`/api/coach/athletes/${athleteId}/progress-reports${query}`, { timeout, headers })
}

export async function createCoachReport(athleteId, payload, options = {}) {
  const { timeout, headers, ...queryOptions } = options
  const query = buildProgressQuery(queryOptions)
  return api(`/api/coach/athletes/${athleteId}/progress-reports${query}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    timeout,
  })
}

export async function fetchCoachReport(athleteId, reportId, options = {}) {
  const { timeout, headers, ...queryOptions } = options
  const query = buildProgressQuery(queryOptions)
  return api(`/api/coach/athletes/${athleteId}/progress-reports/${reportId}${query}`, { timeout, headers })
}

export async function exportCoachReport(athleteId, reportId, format = 'json', options = {}) {
  const { timeout, fetchImpl, triggerDownload = true, ...queryOptions } = options
  const query = buildProgressQuery({ ...queryOptions, format })
  const result = await apiDownload(
    `/api/coach/athletes/${athleteId}/progress-reports/${reportId}/export${query}`,
    { timeout, fetchImpl },
  )
  const defaultName = `progress-report-${reportId}.${format}`
  const filename = extractFilename(result.contentDisposition, defaultName)
  let downloaded = false
  if (triggerDownload) {
    const res = triggerBlobDownload(result.blob, filename)
    downloaded = res.ok
  }
  return {
    ...result,
    filename,
    downloaded,
  }
}

export async function revokeCoachReport(athleteId, reportId, options = {}) {
  const { timeout, headers, ...queryOptions } = options
  const query = buildProgressQuery(queryOptions)
  return api(`/api/coach/athletes/${athleteId}/progress-reports/${reportId}/revoke${query}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({}),
    timeout,
  })
}

export async function fetchAthleteReports(options = {}) {
  const { timeout, headers, ...queryOptions } = options
  const query = buildProgressQuery(queryOptions)
  return api(`/api/athlete/progress-reports${query}`, { timeout, headers })
}

export async function fetchAthleteReport(reportId, options = {}) {
  const { timeout, headers, ...queryOptions } = options
  const query = buildProgressQuery(queryOptions)
  return api(`/api/athlete/progress-reports/${reportId}${query}`, { timeout, headers })
}

export async function exportAthleteReport(reportId, format = 'json', options = {}) {
  const { timeout, fetchImpl, triggerDownload = true, ...queryOptions } = options
  const query = buildProgressQuery({ ...queryOptions, format })
  const result = await apiDownload(
    `/api/athlete/progress-reports/${reportId}/export${query}`,
    { timeout, fetchImpl },
  )
  const defaultName = `progress-report-${reportId}.${format}`
  const filename = extractFilename(result.contentDisposition, defaultName)
  let downloaded = false
  if (triggerDownload) {
    const res = triggerBlobDownload(result.blob, filename)
    downloaded = res.ok
  }
  return {
    ...result,
    filename,
    downloaded,
  }
}

export const progressApi = {
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
  parseApiError,
  triggerBlobDownload,
  extractFilename,
  buildProgressQuery,
}
