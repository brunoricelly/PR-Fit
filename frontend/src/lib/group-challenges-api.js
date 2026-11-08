/**
 * @file group-challenges-api.js
 * Frontend client module for B2B2C Phase 8: Group Challenges, Collective Programs, and Community.
 * Provides typed methods for Coach and Athlete flows, AbortSignal handling, pagination, and error mapping.
 */

import { api } from './api.js'

/**
 * Base error class for Group Challenges API operations.
 */
export class GroupChallengesError extends Error {
  /**
   * @param {string} message - Human-readable error message.
   * @param {number} [status=0] - HTTP status code.
   * @param {string} [code='unknown_error'] - Stable machine-readable error code.
   * @param {Record<string, any>} [data={}] - Additional response or payload context.
   */
  constructor(message, status = 0, code = 'unknown_error', data = {}) {
    super(message || 'Group challenges request failed')
    this.name = this.constructor.name
    this.status = status
    this.code = code
    this.data = data && typeof data === 'object' ? data : {}
    const retry = data?.retryAfter ?? this.data.retryAfter
    this.retryAfter = Number.isFinite(Number(retry)) && Number(retry) >= 0 ? Number(retry) : null
  }
}

/**
 * 403 Forbidden: Insufficient role permissions or missing active training scope.
 */
export class ForbiddenError extends GroupChallengesError {
  constructor(message, code = 'forbidden', data = {}) {
    super(message || 'Access denied', 403, code, data)
  }
}

/**
 * 404 Not Found: Target group, challenge, program or member does not exist.
 */
export class NotFoundError extends GroupChallengesError {
  constructor(message, code = 'not_found', data = {}) {
    super(message || 'Entity not found', 404, code, data)
  }
}

/**
 * 409 Conflict: Group capacity reached, duplicate membership, or concurrency conflict.
 */
export class ConflictError extends GroupChallengesError {
  constructor(message, code = 'conflict', data = {}) {
    super(message || 'Operation conflict', 409, code, data)
  }
}

/**
 * 410 Expired / Archived: Group invite expired, challenge completed, or program archived.
 */
export class ExpiredError extends GroupChallengesError {
  constructor(message, code = 'expired', data = {}) {
    super(message || 'Resource expired or archived', 410, code, data)
  }
}

export const GoneError = ExpiredError

/**
 * 429 Rate Limit: Too many requests or operation burst throttle hit.
 */
export class RateLimitError extends GroupChallengesError {
  constructor(message, code = 'rate_limit', data = {}) {
    super(message || 'Rate limit exceeded', 429, code, data)
  }
}

/**
 * Wraps any error into a specialized GroupChallengesError subclass.
 * Preserves AbortError without wrapping so callers can identify user cancellations.
 *
 * @param {any} err - Caught error.
 * @returns {GroupChallengesError | Error} Normalized error instance.
 */
export function wrapGroupChallengesError(err) {
  if (err instanceof GroupChallengesError) return err
  if (err?.name === 'AbortError') return err

  const status = Number(err?.status) || 0
  const data = err?.data && typeof err.data === 'object' ? err.data : {}
  const rawCode = data.code || err?.code
  const retryAfter = err?.retryAfter ?? data?.retryAfter
  if (retryAfter !== undefined) data.retryAfter = retryAfter
  const message = data.error || data.message || err?.message || 'Group challenges request failed'

  if (status === 403) return new ForbiddenError(message, rawCode || 'forbidden', data)
  if (status === 404) return new NotFoundError(message, rawCode || 'not_found', data)
  if (status === 409) return new ConflictError(message, rawCode || 'conflict', data)
  if (status === 410) return new ExpiredError(message, rawCode || 'expired', data)
  if (status === 429) return new RateLimitError(message, rawCode || 'rate_limit', data)

  return new GroupChallengesError(message, status, rawCode || (status === 401 ? 'unauthorized' : 'unknown_error'), data)
}

export const parseGroupChallengesError = wrapGroupChallengesError

/**
 * Generates an RFC-compliant stable idempotency key matching ^[A-Za-z0-9._:-]{8,120}$.
 *
 * @param {string} [prefix='idemp']
 * @returns {string}
 */
export function generateIdempotencyKey(prefix = 'idemp') {
  const ts = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 10)
  return `${prefix}_${ts}_${rand}`
}

/**
 * Serializes an object of parameters into a URL query string, omitting undefined, null, or empty values.
 *
 * @param {Record<string, any>} [params={}]
 * @returns {string} Query string starting with '?' or empty string.
 */
export function buildQueryString(params = {}) {
  if (!params || typeof params !== 'object') return ''
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      search.set(key, String(value))
    }
  }
  const str = search.toString()
  return str ? `?${str}` : ''
}

/**
 * Internal dispatch helper executing `api(path, opts)` wrapped in group challenge error handling.
 *
 * @param {string} path - Target URL path.
 * @param {object} [opts={}] - Fetch configuration options.
 * @returns {Promise<any>}
 */
async function request(path, opts = {}) {
  const { signal, timeout, headers = {}, method = 'GET', body, ...rest } = opts
  if (signal?.aborted) {
    const abortErr = new Error('The operation was aborted')
    abortErr.name = 'AbortError'
    throw abortErr
  }

  const reqOpts = {
    method,
    headers: { ...headers },
    ...rest,
  }
  if (signal) reqOpts.signal = signal
  if (timeout !== undefined) reqOpts.timeout = timeout
  if (body !== undefined) {
    reqOpts.body = typeof body === 'string' ? body : JSON.stringify(body)
  }

  try {
    return await api(path, reqOpts)
  } catch (err) {
    if (err?.name === 'AbortError') throw err
    throw wrapGroupChallengesError(err)
  }
}

// ============================================================================
// COACH GROUPS
// ============================================================================

/**
 * Lists groups owned by the authenticated coach with cursor pagination.
 *
 * @param {object} [options={}] - Query options.
 * @param {string} [options.cursor] - Opaque pagination cursor.
 * @param {number} [options.limit=50] - Maximum records to return.
 * @param {AbortSignal} [options.signal] - Optional abort signal.
 * @param {number} [options.timeout] - Optional request timeout in ms.
 * @returns {Promise<{ groups: Array<object>, page: object }>}
 */
export async function listCoachGroups(options = {}) {
  const { cursor, limit, signal, timeout, headers } = options
  const query = buildQueryString({ cursor, limit })
  return request(`/api/coach/groups${query}`, { method: 'GET', signal, timeout, headers })
}

/**
 * Creates a new coach community group.
 *
 * @param {object} data - Group payload.
 * @param {string} data.name - Group display name (1-100 characters).
 * @param {string} [data.description] - Group description (max 1000 characters).
 * @param {string} [data.category] - Group category (max 50 characters).
 * @param {number} [data.maxMembers=50] - Capacity limit (1-500).
 * @param {boolean} [data.isPrivate=true] - Visibility toggle.
 * @param {object} [options={}] - Optional request options.
 * @returns {Promise<{ group: object, invite: object }>}
 */
export async function createCoachGroup(data, options = {}) {
  const { signal, timeout, headers } = options
  return request('/api/coach/groups', {
    method: 'POST',
    body: data,
    signal,
    timeout,
    headers,
  })
}

/**
 * Retrieves details and member roster of a coach group.
 *
 * @param {string} id - Group ID.
 * @param {object} [options={}] - Query and request options.
 * @param {string} [options.cursor] - Pagination cursor for members list.
 * @param {number} [options.limit] - Page size for members list.
 * @returns {Promise<{ group: object, members: Array<object>, page: object }>}
 */
export async function getCoachGroup(id, options = {}) {
  const { cursor, limit, signal, timeout, headers } = options
  const query = buildQueryString({ cursor, limit })
  return request(`/api/coach/groups/${encodeURIComponent(id)}${query}`, {
    method: 'GET',
    signal,
    timeout,
    headers,
  })
}

/**
 * Updates an existing coach group.
 *
 * @param {string} id - Group ID.
 * @param {object} data - Updated group fields.
 * @param {string} [data.name] - Group name.
 * @param {string} [data.description] - Group description.
 * @param {string} [data.category] - Category.
 * @param {number} [data.maxMembers] - Max members.
 * @param {boolean} [data.isPrivate] - Visibility.
 * @param {boolean} [data.archived] - Soft archive flag.
 * @param {string} [data.expectedUpdatedAt] - Optimistic concurrency lock stamp.
 * @param {object} [options={}] - Request options.
 * @returns {Promise<{ group: object }>}
 */
export async function updateCoachGroup(id, data, options = {}) {
  const { signal, timeout, headers } = options
  return request(`/api/coach/groups/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: data,
    signal,
    timeout,
    headers,
  })
}

/**
 * Deletes or archives a coach group.
 *
 * @param {string} id - Group ID.
 * @param {object} [options={}] - Request options.
 * @returns {Promise<{ ok: boolean, id: string }>}
 */
export async function deleteCoachGroup(id, options = {}) {
  const { signal, timeout, headers } = options
  return request(`/api/coach/groups/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    signal,
    timeout,
    headers,
  })
}

/**
 * Adds or invites an athlete to a coach group.
 * Requires active training scope with the athlete.
 *
 * @param {string} id - Group ID.
 * @param {object | string} data - Payload or athleteId.
 * @param {string} [data.athleteId] - Target athlete identifier.
 * @param {string} [data.role='member'] - Member role ('member' | 'moderator').
 * @param {object} [options={}] - Request options.
 * @returns {Promise<{ member: object }>}
 */
export async function addCoachGroupMember(id, data, options = {}) {
  const body = typeof data === 'string' ? { athleteId: data } : data
  const { signal, timeout, headers } = options
  return request(`/api/coach/groups/${encodeURIComponent(id)}/members`, {
    method: 'POST',
    body,
    signal,
    timeout,
    headers,
  })
}

/**
 * Removes an athlete from a coach group.
 *
 * @param {string} id - Group ID.
 * @param {string} athleteId - Athlete ID to remove.
 * @param {object} [options={}] - Request options.
 * @returns {Promise<{ ok: boolean, status: string }>}
 */
export async function removeCoachGroupMember(id, athleteId, options = {}) {
  const { signal, timeout, headers } = options
  return request(`/api/coach/groups/${encodeURIComponent(id)}/members/${encodeURIComponent(athleteId)}`, {
    method: 'DELETE',
    signal,
    timeout,
    headers,
  })
}

/**
 * Rotates the active invite code for a coach group.
 *
 * @param {string} id - Group ID.
 * @param {object} [options={}] - Request options.
 * @param {number} [options.expiresInDays] - Optional validity in days (1-365).
 * @returns {Promise<{ invite: { code: string, expiresAt: string, status: string } }>}
 */
export async function rotateGroupInvite(id, options = {}) {
  const { expiresInDays, signal, timeout, headers, body } = options
  const payload = body || (expiresInDays !== undefined ? { expiresInDays } : {})
  return request(`/api/coach/groups/${encodeURIComponent(id)}/invite`, {
    method: 'POST',
    body: payload,
    signal,
    timeout,
    headers,
  })
}

// ============================================================================
// COACH CHALLENGES
// ============================================================================

/**
 * Lists collective challenges owned by the coach.
 *
 * @param {object} [options={}] - Query options.
 * @param {string} [options.cursor] - Pagination cursor.
 * @param {number} [options.limit] - Page limit.
 * @returns {Promise<{ challenges: Array<object>, page: object }>}
 */
export async function listCoachChallenges(options = {}) {
  const { cursor, limit, signal, timeout, headers } = options
  const query = buildQueryString({ cursor, limit })
  return request(`/api/coach/challenges${query}`, { method: 'GET', signal, timeout, headers })
}

/**
 * Creates a new collective challenge.
 *
 * @param {object} data - Challenge definition.
 * @param {string} data.title - Challenge title.
 * @param {string} data.type - Metric type ('workouts_count' | 'volume_load' | 'habit_streak' | 'custom_points').
 * @param {string} data.scope - Scope ('group' | 'coach_all').
 * @param {string} [data.groupId] - Required if scope is 'group'.
 * @param {string} data.startAt - ISO start timestamp.
 * @param {string} data.endAt - ISO end timestamp.
 * @param {string} data.timeZone - Canonical IANA timezone.
 * @param {object} data.rules - Rules and scoring configuration.
 * @param {object} [options={}] - Request options.
 * @returns {Promise<{ challenge: object }>}
 */
export async function createCoachChallenge(data, options = {}) {
  const { signal, timeout, headers } = options
  return request('/api/coach/challenges', {
    method: 'POST',
    body: data,
    signal,
    timeout,
    headers,
  })
}

/**
 * Reads challenge details.
 *
 * @param {string} id - Challenge ID.
 * @param {object} [options={}] - Request options.
 * @returns {Promise<{ challenge: object }>}
 */
export async function getCoachChallenge(id, options = {}) {
  const { signal, timeout, headers } = options
  return request(`/api/coach/challenges/${encodeURIComponent(id)}`, {
    method: 'GET',
    signal,
    timeout,
    headers,
  })
}

/**
 * Updates a draft or active challenge.
 *
 * @param {string} id - Challenge ID.
 * @param {object} data - Fields to update.
 * @param {object} [options={}] - Request options.
 * @returns {Promise<{ challenge: object }>}
 */
export async function updateCoachChallenge(id, data, options = {}) {
  const { signal, timeout, headers } = options
  return request(`/api/coach/challenges/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: data,
    signal,
    timeout,
    headers,
  })
}

/**
 * Deletes a draft challenge.
 *
 * @param {string} id - Challenge ID.
 * @param {object} [options={}] - Request options.
 * @returns {Promise<{ ok: boolean, id: string }>}
 */
export async function deleteCoachChallenge(id, options = {}) {
  const { signal, timeout, headers } = options
  return request(`/api/coach/challenges/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    signal,
    timeout,
    headers,
  })
}

/**
 * Retrieves the live or finalized leaderboard and activity feed for a challenge.
 *
 * @param {string} id - Challenge ID.
 * @param {object} [options={}] - Query options.
 * @param {string} [options.cursor] - Leaderboard cursor.
 * @param {number} [options.limit] - Leaderboard limit.
 * @param {string} [options.feedcursor] - Activity feed cursor.
 * @param {number} [options.feedlimit] - Activity feed limit.
 * @returns {Promise<{ challenge: object, leaderboard: Array<object>, activityFeed: Array<object>, page: object, feedPage: object }>}
 */
export async function getCoachChallengeLeaderboard(id, options = {}) {
  const { cursor, limit, feedcursor, feedlimit, signal, timeout, headers } = options
  const query = buildQueryString({ cursor, limit, feedcursor, feedlimit })
  return request(`/api/coach/challenges/${encodeURIComponent(id)}/leaderboard${query}`, {
    method: 'GET',
    signal,
    timeout,
    headers,
  })
}

/**
 * Awards or deducts audited custom points for an athlete in a custom_points challenge.
 * Requires an Idempotency-Key header.
 *
 * @param {string} id - Challenge ID.
 * @param {object} data - Adjustment payload.
 * @param {string} data.athleteId - Target athlete ID.
 * @param {number} data.points - Points delta (-10000 to 10000, non-zero).
 * @param {string} data.reason - Reason description (max 500 characters).
 * @param {string} [data.correctionOf] - ID of previous adjustment if this is a correction.
 * @param {object} [options={}] - Request options.
 * @param {string} [options.idempotencyKey] - Custom idempotency key.
 * @returns {Promise<{ adjustment: object, score: number, idempotent?: boolean }>}
 */
export async function awardCustomPoints(id, data, options = {}) {
  const { idempotencyKey, signal, timeout, headers = {} } = options
  const key = idempotencyKey || headers['Idempotency-Key'] || headers['idempotency-key'] || generateIdempotencyKey('pts')
  const reqHeaders = {
    ...headers,
    'Idempotency-Key': key,
  }

  // Ensure body only includes exact accepted keys: athleteId, points, reason, correctionOf
  const body = {
    athleteId: data.athleteId,
    points: data.points,
    reason: data.reason,
  }
  if (data.correctionOf !== undefined) {
    body.correctionOf = data.correctionOf
  }

  return request(`/api/coach/challenges/${encodeURIComponent(id)}/points`, {
    method: 'POST',
    body,
    signal,
    timeout,
    headers: reqHeaders,
  })
}

// ============================================================================
// COACH COLLECTIVE PROGRAMS
// ============================================================================

/**
 * Lists collective program series and versions created by the coach.
 *
 * @param {object} [options={}] - Query options.
 * @param {string} [options.cursor] - Pagination cursor.
 * @param {number} [options.limit] - Page limit.
 * @returns {Promise<{ programs: Array<object>, page: object }>}
 */
export async function listCoachGroupPrograms(options = {}) {
  const { cursor, limit, signal, timeout, headers } = options
  const query = buildQueryString({ cursor, limit })
  return request(`/api/coach/group-programs${query}`, { method: 'GET', signal, timeout, headers })
}

/**
 * Creates a new draft collective program attached to a group.
 *
 * @param {object} data - Program payload.
 * @param {string} data.groupId - Group ID.
 * @param {string} data.title - Program title.
 * @param {object} data.routine - Prescription routine definition.
 * @param {string} [data.templateId] - Optional template reference.
 * @param {object} [options={}] - Request options.
 * @returns {Promise<{ program: object }>}
 */
export async function createCoachGroupProgram(data, options = {}) {
  const { signal, timeout, headers } = options
  return request('/api/coach/group-programs', {
    method: 'POST',
    body: data,
    signal,
    timeout,
    headers,
  })
}

/**
 * Reads a coach collective program version by ID.
 *
 * @param {string} id - Program ID.
 * @param {object} [options={}] - Request options.
 * @returns {Promise<{ program: object }>}
 */
export async function getCoachGroupProgram(id, options = {}) {
  const { signal, timeout, headers } = options
  return request(`/api/coach/group-programs/${encodeURIComponent(id)}`, {
    method: 'GET',
    signal,
    timeout,
    headers,
  })
}

/**
 * Updates a draft collective program.
 *
 * @param {string} id - Program ID.
 * @param {object} data - Fields to update.
 * @param {string} [data.title] - New title.
 * @param {object} [data.routine] - Updated routine.
 * @param {string} [data.templateId] - Template id.
 * @param {object} [options={}] - Request options.
 * @returns {Promise<{ program: object }>}
 */
export async function updateCoachGroupProgram(id, data, options = {}) {
  const { signal, timeout, headers } = options
  return request(`/api/coach/group-programs/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: data,
    signal,
    timeout,
    headers,
  })
}

/**
 * Publishes a draft collective program into an immutable published version.
 *
 * @param {string} id - Program ID.
 * @param {object} [options={}] - Request options.
 * @returns {Promise<{ program: object }>}
 */
export async function publishCoachGroupProgram(id, options = {}) {
  const { signal, timeout, headers } = options
  return request(`/api/coach/group-programs/${encodeURIComponent(id)}/publish`, {
    method: 'POST',
    body: {},
    signal,
    timeout,
    headers,
  })
}

/**
 * Archives a published or draft collective program version.
 *
 * @param {string} id - Program ID.
 * @param {object} [options={}] - Request options.
 * @returns {Promise<{ program: object }>}
 */
export async function archiveCoachGroupProgram(id, options = {}) {
  const { signal, timeout, headers } = options
  return request(`/api/coach/group-programs/${encodeURIComponent(id)}/archive`, {
    method: 'POST',
    body: {},
    signal,
    timeout,
    headers,
  })
}

// ============================================================================
// ATHLETE GROUPS
// ============================================================================

/**
 * Lists community groups the authenticated athlete belongs to or has pending invites for.
 *
 * @param {object} [options={}] - Query options.
 * @param {string} [options.cursor] - Cursor.
 * @param {number} [options.limit] - Limit.
 * @returns {Promise<{ groups: Array<object>, page: object }>}
 */
export async function listAthleteGroups(options = {}) {
  const { cursor, limit, signal, timeout, headers } = options
  const query = buildQueryString({ cursor, limit })
  return request(`/api/athlete/groups${query}`, { method: 'GET', signal, timeout, headers })
}

/**
 * Joins a coach group using an active invite code.
 *
 * @param {string | { inviteCode: string }} code - Invite code (e.g., 'GRP-...') or object.
 * @param {object} [options={}] - Request options.
 * @returns {Promise<{ ok: boolean, group: object, member: object }>}
 */
export async function joinGroupByInvite(code, options = {}) {
  const inviteCode = typeof code === 'string' ? code.trim() : (code?.inviteCode || code?.code || '')
  const { signal, timeout, headers } = options
  return request('/api/athlete/groups/join', {
    method: 'POST',
    body: { inviteCode },
    signal,
    timeout,
    headers,
  })
}

/**
 * Accepts a pending invitation into a coach group.
 *
 * @param {string} id - Group ID.
 * @param {object} [options={}] - Request options.
 * @returns {Promise<{ ok: boolean, group: object, member: object }>}
 */
export async function acceptGroupInvitation(id, options = {}) {
  const { signal, timeout, headers } = options
  return request(`/api/athlete/groups/${encodeURIComponent(id)}/accept`, {
    method: 'POST',
    body: {},
    signal,
    timeout,
    headers,
  })
}

/**
 * Leaves a group voluntarily.
 *
 * @param {string} id - Group ID.
 * @param {object} [options={}] - Request options.
 * @returns {Promise<{ ok: boolean, status: string }>}
 */
export async function leaveGroup(id, options = {}) {
  const { signal, timeout, headers } = options
  return request(`/api/athlete/groups/${encodeURIComponent(id)}/leave`, {
    method: 'POST',
    body: {},
    signal,
    timeout,
    headers,
  })
}

/**
 * Reads group details and privacy-safe roster from an athlete perspective.
 *
 * @param {string} id - Group ID.
 * @param {object} [options={}] - Query options.
 * @param {string} [options.cursor] - Cursor for members list.
 * @param {number} [options.limit] - Page limit for members list.
 * @returns {Promise<{ group: object, members: Array<object>, page: object }>}
 */
export async function getAthleteGroup(id, options = {}) {
  const { cursor, limit, signal, timeout, headers } = options
  const query = buildQueryString({ cursor, limit })
  return request(`/api/athlete/groups/${encodeURIComponent(id)}${query}`, {
    method: 'GET',
    signal,
    timeout,
    headers,
  })
}

// ============================================================================
// ATHLETE CHALLENGES
// ============================================================================

/**
 * Lists collective challenges available to the athlete.
 *
 * @param {object} [options={}] - Query options.
 * @param {string} [options.cursor] - Cursor.
 * @param {number} [options.limit] - Limit.
 * @returns {Promise<{ challenges: Array<object>, page: object }>}
 */
export async function listAthleteChallenges(options = {}) {
  const { cursor, limit, signal, timeout, headers } = options
  const query = buildQueryString({ cursor, limit })
  return request(`/api/athlete/challenges${query}`, { method: 'GET', signal, timeout, headers })
}

/**
 * Reads challenge details for the athlete.
 *
 * @param {string} id - Challenge ID.
 * @param {object} [options={}] - Request options.
 * @returns {Promise<{ challenge: object }>}
 */
export async function getAthleteChallenge(id, options = {}) {
  const { signal, timeout, headers } = options
  return request(`/api/athlete/challenges/${encodeURIComponent(id)}`, {
    method: 'GET',
    signal,
    timeout,
    headers,
  })
}

/**
 * Reads leaderboard and activity feed for a challenge.
 *
 * @param {string} id - Challenge ID.
 * @param {object} [options={}] - Query options.
 * @param {string} [options.cursor] - Leaderboard cursor.
 * @param {number} [options.limit] - Leaderboard limit.
 * @param {string} [options.feedcursor] - Feed cursor.
 * @param {number} [options.feedlimit] - Feed limit.
 * @returns {Promise<{ challenge: object, leaderboard: Array<object>, activityFeed: Array<object>, page: object, feedPage: object }>}
 */
export async function getAthleteChallengeLeaderboard(id, options = {}) {
  const { cursor, limit, feedcursor, feedlimit, signal, timeout, headers } = options
  const query = buildQueryString({ cursor, limit, feedcursor, feedlimit })
  return request(`/api/athlete/challenges/${encodeURIComponent(id)}/leaderboard${query}`, {
    method: 'GET',
    signal,
    timeout,
    headers,
  })
}

// ============================================================================
// ATHLETE COLLECTIVE PROGRAMS
// ============================================================================

/**
 * Lists published collective programs available to the athlete through active membership and training scope.
 *
 * @param {object} [options={}] - Query options.
 * @param {string} [options.cursor] - Cursor.
 * @param {number} [options.limit] - Limit.
 * @returns {Promise<{ programs: Array<object>, page: object }>}
 */
export async function listAthleteGroupPrograms(options = {}) {
  const { cursor, limit, signal, timeout, headers } = options
  const query = buildQueryString({ cursor, limit })
  return request(`/api/athlete/group-programs${query}`, { method: 'GET', signal, timeout, headers })
}

/**
 * Atomically adopts a published collective program version into athlete routines.
 * Supports Idempotency-Key and confirmExistingPlan.
 *
 * @param {string} id - Program ID.
 * @param {object | boolean} [dataOrOptions={}] - Payload or options object.
 * @param {boolean} [dataOrOptions.confirmExistingPlan] - Whether to confirm overwriting an existing active plan.
 * @param {string} [dataOrOptions.idempotencyKey] - Idempotency key.
 * @param {object} [maybeOptions={}] - Optional request options when data is passed as second argument.
 * @returns {Promise<{ ok: boolean, adoption: object, plan?: object }>}
 */
export async function adoptGroupProgram(id, dataOrOptions = {}, maybeOptions = {}) {
  let confirmExistingPlan = false
  let opts = {}

  if (typeof dataOrOptions === 'boolean') {
    confirmExistingPlan = dataOrOptions
    opts = maybeOptions || {}
  } else if (dataOrOptions && typeof dataOrOptions === 'object') {
    if ('confirmExistingPlan' in dataOrOptions) {
      confirmExistingPlan = Boolean(dataOrOptions.confirmExistingPlan)
    }
    opts = { ...dataOrOptions, ...maybeOptions }
  }

  const { idempotencyKey, signal, timeout, headers = {} } = opts
  const key = idempotencyKey || headers['Idempotency-Key'] || headers['idempotency-key']
  const reqHeaders = { ...headers }
  if (key) {
    reqHeaders['Idempotency-Key'] = key
  }

  const body = confirmExistingPlan ? { confirmExistingPlan: true } : {}

  return request(`/api/athlete/group-programs/${encodeURIComponent(id)}/adopt`, {
    method: 'POST',
    body,
    signal,
    timeout,
    headers: reqHeaders,
  })
}

// ============================================================================
// MODULE EXPORT
// ============================================================================

export const groupChallengesApi = {
  // Coach Groups
  listCoachGroups,
  createCoachGroup,
  getCoachGroup,
  updateCoachGroup,
  deleteCoachGroup,
  addCoachGroupMember,
  removeCoachGroupMember,
  rotateGroupInvite,
  // Coach Challenges
  listCoachChallenges,
  createCoachChallenge,
  getCoachChallenge,
  updateCoachChallenge,
  deleteCoachChallenge,
  getCoachChallengeLeaderboard,
  awardCustomPoints,
  // Coach Programs
  listCoachGroupPrograms,
  createCoachGroupProgram,
  getCoachGroupProgram,
  updateCoachGroupProgram,
  publishCoachGroupProgram,
  archiveCoachGroupProgram,
  // Athlete Groups
  listAthleteGroups,
  joinGroupByInvite,
  acceptGroupInvitation,
  leaveGroup,
  getAthleteGroup,
  // Athlete Challenges
  listAthleteChallenges,
  getAthleteChallenge,
  getAthleteChallengeLeaderboard,
  // Athlete Programs
  listAthleteGroupPrograms,
  adoptGroupProgram,
  // Errors & Utilities
  GroupChallengesError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  ExpiredError,
  GoneError,
  RateLimitError,
  wrapGroupChallengesError,
  parseGroupChallengesError,
  generateIdempotencyKey,
  buildQueryString,
}

export default groupChallengesApi
