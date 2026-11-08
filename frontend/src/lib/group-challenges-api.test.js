import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  GroupChallengesError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  ExpiredError,
  GoneError,
  RateLimitError,
  wrapGroupChallengesError,
  buildQueryString,
  generateIdempotencyKey,
  listCoachGroups,
  createCoachGroup,
  getCoachGroup,
  updateCoachGroup,
  deleteCoachGroup,
  addCoachGroupMember,
  removeCoachGroupMember,
  rotateGroupInvite,
  listCoachChallenges,
  createCoachChallenge,
  getCoachChallenge,
  updateCoachChallenge,
  deleteCoachChallenge,
  getCoachChallengeLeaderboard,
  awardCustomPoints,
  listCoachGroupPrograms,
  createCoachGroupProgram,
  getCoachGroupProgram,
  updateCoachGroupProgram,
  publishCoachGroupProgram,
  archiveCoachGroupProgram,
  listAthleteGroups,
  joinGroupByInvite,
  acceptGroupInvitation,
  leaveGroup,
  getAthleteGroup,
  listAthleteChallenges,
  getAthleteChallenge,
  getAthleteChallengeLeaderboard,
  listAthleteGroupPrograms,
  adoptGroupProgram,
  groupChallengesApi,
} from './group-challenges-api.js'

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
}))

vi.mock('./api.js', () => ({
  api: (...args) => mocks.api(...args),
}))

beforeEach(() => {
  vi.clearAllMocks()
})

describe('group-challenges-api query string and utilities', () => {
  it('buildQueryString serializes valid params and skips null/undefined/empty', () => {
    expect(buildQueryString(null)).toBe('')
    expect(buildQueryString({})).toBe('')
    expect(buildQueryString({ cursor: 'c_1', limit: 20, ignored: undefined, empty: '', nil: null }))
      .toBe('?cursor=c_1&limit=20')
    expect(buildQueryString({ filter: 'hello world' }))
      .toBe('?filter=hello+world')
  })

  it('generateIdempotencyKey produces a valid header-safe key', () => {
    const key = generateIdempotencyKey('pts')
    expect(key).toMatch(/^pts_[a-z0-9]+_[a-z0-9]+$/)
    expect(key.length).toBeGreaterThanOrEqual(8)
    expect(key.length).toBeLessThanOrEqual(120)
  })

  it('groupChallengesApi export contains all client methods and classes', () => {
    expect(groupChallengesApi.listCoachGroups).toBe(listCoachGroups)
    expect(groupChallengesApi.createCoachGroup).toBe(createCoachGroup)
    expect(groupChallengesApi.awardCustomPoints).toBe(awardCustomPoints)
    expect(groupChallengesApi.adoptGroupProgram).toBe(adoptGroupProgram)
    expect(groupChallengesApi.ConflictError).toBe(ConflictError)
  })
})

describe('Coach Groups methods', () => {
  it('listCoachGroups fetches /api/coach/groups with optional pagination', async () => {
    const fake = { groups: [{ id: 'grp_1', name: 'Barbell Club' }], page: { next: null } }
    mocks.api.mockResolvedValueOnce(fake)

    const res = await listCoachGroups({ cursor: 'cur_abc', limit: 10 })
    expect(mocks.api).toHaveBeenCalledWith('/api/coach/groups?cursor=cur_abc&limit=10', {
      method: 'GET',
      headers: {},
    })
    expect(res).toEqual(fake)
  })

  it('createCoachGroup posts group data to /api/coach/groups', async () => {
    const payload = { name: 'Morning Crew', maxMembers: 30 }
    const fake = { group: { id: 'grp_2', ...payload }, invite: { code: 'GRP-123' } }
    mocks.api.mockResolvedValueOnce(fake)

    const res = await createCoachGroup(payload)
    expect(mocks.api).toHaveBeenCalledWith('/api/coach/groups', {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: {},
    })
    expect(res).toEqual(fake)
  })

  it('getCoachGroup fetches /api/coach/groups/:id with pagination query', async () => {
    const fake = { group: { id: 'grp_1' }, members: [], page: { next: null } }
    mocks.api.mockResolvedValueOnce(fake)

    const res = await getCoachGroup('grp_1', { cursor: 'm_cur', limit: 25 })
    expect(mocks.api).toHaveBeenCalledWith('/api/coach/groups/grp_1?cursor=m_cur&limit=25', {
      method: 'GET',
      headers: {},
    })
    expect(res).toEqual(fake)
  })

  it('updateCoachGroup sends PUT to /api/coach/groups/:id', async () => {
    const patch = { name: 'Evening Crew', isPrivate: false }
    mocks.api.mockResolvedValueOnce({ group: { id: 'grp_1', ...patch } })

    await updateCoachGroup('grp_1', patch)
    expect(mocks.api).toHaveBeenCalledWith('/api/coach/groups/grp_1', {
      method: 'PUT',
      body: JSON.stringify(patch),
      headers: {},
    })
  })

  it('deleteCoachGroup sends DELETE to /api/coach/groups/:id', async () => {
    mocks.api.mockResolvedValueOnce({ ok: true, id: 'grp_1' })
    const res = await deleteCoachGroup('grp_1')
    expect(mocks.api).toHaveBeenCalledWith('/api/coach/groups/grp_1', {
      method: 'DELETE',
      headers: {},
    })
    expect(res).toEqual({ ok: true, id: 'grp_1' })
  })

  it('addCoachGroupMember supports both string athleteId and object payload', async () => {
    mocks.api.mockResolvedValue({ member: { id: 'm_1' } })

    await addCoachGroupMember('grp_1', 'ath_10')
    expect(mocks.api).toHaveBeenLastCalledWith('/api/coach/groups/grp_1/members', {
      method: 'POST',
      body: JSON.stringify({ athleteId: 'ath_10' }),
      headers: {},
    })

    await addCoachGroupMember('grp_1', { athleteId: 'ath_20', role: 'moderator' })
    expect(mocks.api).toHaveBeenLastCalledWith('/api/coach/groups/grp_1/members', {
      method: 'POST',
      body: JSON.stringify({ athleteId: 'ath_20', role: 'moderator' }),
      headers: {},
    })
  })

  it('removeCoachGroupMember sends DELETE to /api/coach/groups/:id/members/:athleteId', async () => {
    mocks.api.mockResolvedValueOnce({ ok: true, status: 'removed' })
    const res = await removeCoachGroupMember('grp_1', 'ath_1')
    expect(mocks.api).toHaveBeenCalledWith('/api/coach/groups/grp_1/members/ath_1', {
      method: 'DELETE',
      headers: {},
    })
    expect(res).toEqual({ ok: true, status: 'removed' })
  })

  it('rotateGroupInvite sends POST to /api/coach/groups/:id/invite with expiresInDays', async () => {
    mocks.api.mockResolvedValueOnce({ invite: { code: 'GRP-999', status: 'active' } })
    await rotateGroupInvite('grp_1', { expiresInDays: 30 })
    expect(mocks.api).toHaveBeenCalledWith('/api/coach/groups/grp_1/invite', {
      method: 'POST',
      body: JSON.stringify({ expiresInDays: 30 }),
      headers: {},
    })
  })
})

describe('Coach Challenges methods', () => {
  it('listCoachChallenges fetches /api/coach/challenges', async () => {
    mocks.api.mockResolvedValueOnce({ challenges: [], page: {} })
    await listCoachChallenges({ cursor: 'c_1', limit: 10 })
    expect(mocks.api).toHaveBeenCalledWith('/api/coach/challenges?cursor=c_1&limit=10', {
      method: 'GET',
      headers: {},
    })
  })

  it('createCoachChallenge posts definition to /api/coach/challenges', async () => {
    const data = { title: 'Squat Fest', type: 'volume_load', scope: 'coach_all' }
    mocks.api.mockResolvedValueOnce({ challenge: { id: 'ch_1', ...data } })
    await createCoachChallenge(data)
    expect(mocks.api).toHaveBeenCalledWith('/api/coach/challenges', {
      method: 'POST',
      body: JSON.stringify(data),
      headers: {},
    })
  })

  it('getCoachChallenge fetches /api/coach/challenges/:id', async () => {
    mocks.api.mockResolvedValueOnce({ challenge: { id: 'ch_1' } })
    await getCoachChallenge('ch_1')
    expect(mocks.api).toHaveBeenCalledWith('/api/coach/challenges/ch_1', {
      method: 'GET',
      headers: {},
    })
  })

  it('updateCoachChallenge sends PUT to /api/coach/challenges/:id', async () => {
    const patch = { title: 'Updated Fest' }
    mocks.api.mockResolvedValueOnce({ challenge: { id: 'ch_1', ...patch } })
    await updateCoachChallenge('ch_1', patch)
    expect(mocks.api).toHaveBeenCalledWith('/api/coach/challenges/ch_1', {
      method: 'PUT',
      body: JSON.stringify(patch),
      headers: {},
    })
  })

  it('deleteCoachChallenge sends DELETE to /api/coach/challenges/:id', async () => {
    mocks.api.mockResolvedValueOnce({ ok: true, id: 'ch_1' })
    await deleteCoachChallenge('ch_1')
    expect(mocks.api).toHaveBeenCalledWith('/api/coach/challenges/ch_1', {
      method: 'DELETE',
      headers: {},
    })
  })

  it('getCoachChallengeLeaderboard serializes leaderboard and feed pagination', async () => {
    mocks.api.mockResolvedValueOnce({ leaderboard: [], activityFeed: [] })
    await getCoachChallengeLeaderboard('ch_1', { cursor: 'lb_1', limit: 50, feedcursor: 'fd_1', feedlimit: 25 })
    expect(mocks.api).toHaveBeenCalledWith(
      '/api/coach/challenges/ch_1/leaderboard?cursor=lb_1&limit=50&feedcursor=fd_1&feedlimit=25',
      { method: 'GET', headers: {} }
    )
  })

  it('awardCustomPoints sends Idempotency-Key header and exact body', async () => {
    mocks.api.mockResolvedValueOnce({ adjustment: { id: 'adj_1' }, score: 50 })
    const data = { athleteId: 'ath_1', points: 10, reason: 'Great effort', correctionOf: 'adj_0' }
    await awardCustomPoints('ch_1', data, { idempotencyKey: 'idemp_test_custom_key_123' })

    expect(mocks.api).toHaveBeenCalledWith('/api/coach/challenges/ch_1/points', {
      method: 'POST',
      body: JSON.stringify({
        athleteId: 'ath_1',
        points: 10,
        reason: 'Great effort',
        correctionOf: 'adj_0',
      }),
      headers: {
        'Idempotency-Key': 'idemp_test_custom_key_123',
      },
    })
  })

  it('awardCustomPoints generates an Idempotency-Key if none is provided', async () => {
    mocks.api.mockResolvedValueOnce({ adjustment: { id: 'adj_2' }, score: 20 })
    await awardCustomPoints('ch_1', { athleteId: 'ath_2', points: 5, reason: 'Extra rep' })

    const callArgs = mocks.api.mock.calls[0]
    expect(callArgs[0]).toBe('/api/coach/challenges/ch_1/points')
    expect(callArgs[1].headers['Idempotency-Key']).toMatch(/^pts_/)
  })
})

describe('Coach Group Programs methods', () => {
  it('listCoachGroupPrograms calls GET /api/coach/group-programs', async () => {
    mocks.api.mockResolvedValueOnce({ programs: [], page: {} })
    await listCoachGroupPrograms({ limit: 15 })
    expect(mocks.api).toHaveBeenCalledWith('/api/coach/group-programs?limit=15', {
      method: 'GET',
      headers: {},
    })
  })

  it('createCoachGroupProgram posts program data', async () => {
    const payload = { groupId: 'grp_1', title: 'Strength Cycle', routine: { name: 'PPL', days: [] } }
    mocks.api.mockResolvedValueOnce({ program: { id: 'prg_1', ...payload } })
    await createCoachGroupProgram(payload)
    expect(mocks.api).toHaveBeenCalledWith('/api/coach/group-programs', {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: {},
    })
  })

  it('getCoachGroupProgram fetches /api/coach/group-programs/:id', async () => {
    mocks.api.mockResolvedValueOnce({ program: { id: 'prg_1' } })
    await getCoachGroupProgram('prg_1')
    expect(mocks.api).toHaveBeenCalledWith('/api/coach/group-programs/prg_1', {
      method: 'GET',
      headers: {},
    })
  })

  it('updateCoachGroupProgram sends PUT to /api/coach/group-programs/:id', async () => {
    const patch = { title: 'Updated Title' }
    mocks.api.mockResolvedValueOnce({ program: { id: 'prg_1', ...patch } })
    await updateCoachGroupProgram('prg_1', patch)
    expect(mocks.api).toHaveBeenCalledWith('/api/coach/group-programs/prg_1', {
      method: 'PUT',
      body: JSON.stringify(patch),
      headers: {},
    })
  })

  it('publishCoachGroupProgram sends POST to /api/coach/group-programs/:id/publish', async () => {
    mocks.api.mockResolvedValueOnce({ program: { id: 'prg_1', status: 'published' } })
    await publishCoachGroupProgram('prg_1')
    expect(mocks.api).toHaveBeenCalledWith('/api/coach/group-programs/prg_1/publish', {
      method: 'POST',
      body: '{}',
      headers: {},
    })
  })

  it('archiveCoachGroupProgram sends POST to /api/coach/group-programs/:id/archive', async () => {
    mocks.api.mockResolvedValueOnce({ program: { id: 'prg_1', status: 'archived' } })
    await archiveCoachGroupProgram('prg_1')
    expect(mocks.api).toHaveBeenCalledWith('/api/coach/group-programs/prg_1/archive', {
      method: 'POST',
      body: '{}',
      headers: {},
    })
  })
})

describe('Athlete Groups methods', () => {
  it('listAthleteGroups fetches /api/athlete/groups', async () => {
    mocks.api.mockResolvedValueOnce({ groups: [] })
    await listAthleteGroups()
    expect(mocks.api).toHaveBeenCalledWith('/api/athlete/groups', {
      method: 'GET',
      headers: {},
    })
  })

  it('joinGroupByInvite handles both code string and object', async () => {
    mocks.api.mockResolvedValue({ ok: true, group: { id: 'grp_1' } })

    await joinGroupByInvite('GRP-ABCD1234EF567890')
    expect(mocks.api).toHaveBeenLastCalledWith('/api/athlete/groups/join', {
      method: 'POST',
      body: JSON.stringify({ inviteCode: 'GRP-ABCD1234EF567890' }),
      headers: {},
    })

    await joinGroupByInvite({ inviteCode: 'GRP-9999888877776666' })
    expect(mocks.api).toHaveBeenLastCalledWith('/api/athlete/groups/join', {
      method: 'POST',
      body: JSON.stringify({ inviteCode: 'GRP-9999888877776666' }),
      headers: {},
    })
  })

  it('acceptGroupInvitation sends POST to /api/athlete/groups/:id/accept', async () => {
    mocks.api.mockResolvedValueOnce({ ok: true, status: 'active' })
    await acceptGroupInvitation('grp_1')
    expect(mocks.api).toHaveBeenCalledWith('/api/athlete/groups/grp_1/accept', {
      method: 'POST',
      body: '{}',
      headers: {},
    })
  })

  it('leaveGroup sends POST to /api/athlete/groups/:id/leave', async () => {
    mocks.api.mockResolvedValueOnce({ ok: true, status: 'left' })
    await leaveGroup('grp_1')
    expect(mocks.api).toHaveBeenCalledWith('/api/athlete/groups/grp_1/leave', {
      method: 'POST',
      body: '{}',
      headers: {},
    })
  })

  it('getAthleteGroup fetches /api/athlete/groups/:id with pagination', async () => {
    mocks.api.mockResolvedValueOnce({ group: { id: 'grp_1' }, members: [] })
    await getAthleteGroup('grp_1', { cursor: 'c1', limit: 20 })
    expect(mocks.api).toHaveBeenCalledWith('/api/athlete/groups/grp_1?cursor=c1&limit=20', {
      method: 'GET',
      headers: {},
    })
  })
})

describe('Athlete Challenges methods', () => {
  it('listAthleteChallenges fetches /api/athlete/challenges', async () => {
    mocks.api.mockResolvedValueOnce({ challenges: [] })
    await listAthleteChallenges({ limit: 5 })
    expect(mocks.api).toHaveBeenCalledWith('/api/athlete/challenges?limit=5', {
      method: 'GET',
      headers: {},
    })
  })

  it('getAthleteChallenge fetches /api/athlete/challenges/:id', async () => {
    mocks.api.mockResolvedValueOnce({ challenge: { id: 'ch_10' } })
    await getAthleteChallenge('ch_10')
    expect(mocks.api).toHaveBeenCalledWith('/api/athlete/challenges/ch_10', {
      method: 'GET',
      headers: {},
    })
  })

  it('getAthleteChallengeLeaderboard fetches /api/athlete/challenges/:id/leaderboard', async () => {
    mocks.api.mockResolvedValueOnce({ leaderboard: [] })
    await getAthleteChallengeLeaderboard('ch_10', { cursor: 'lb_c', limit: 10 })
    expect(mocks.api).toHaveBeenCalledWith('/api/athlete/challenges/ch_10/leaderboard?cursor=lb_c&limit=10', {
      method: 'GET',
      headers: {},
    })
  })
})

describe('Athlete Collective Programs methods', () => {
  it('listAthleteGroupPrograms fetches /api/athlete/group-programs', async () => {
    mocks.api.mockResolvedValueOnce({ programs: [] })
    await listAthleteGroupPrograms()
    expect(mocks.api).toHaveBeenCalledWith('/api/athlete/group-programs', {
      method: 'GET',
      headers: {},
    })
  })

  it('adoptGroupProgram sends confirmExistingPlan and Idempotency-Key header', async () => {
    mocks.api.mockResolvedValueOnce({ ok: true, adoption: { id: 'gadp_1' } })

    await adoptGroupProgram('prg_1', { confirmExistingPlan: true, idempotencyKey: 'idemp_adopt_123' })
    expect(mocks.api).toHaveBeenCalledWith('/api/athlete/group-programs/prg_1/adopt', {
      method: 'POST',
      body: JSON.stringify({ confirmExistingPlan: true }),
      headers: {
        'Idempotency-Key': 'idemp_adopt_123',
      },
    })
  })

  it('adoptGroupProgram sends empty body when confirmExistingPlan is false/omitted', async () => {
    mocks.api.mockResolvedValueOnce({ ok: true, adoption: { id: 'gadp_2' } })

    await adoptGroupProgram('prg_2')
    expect(mocks.api).toHaveBeenCalledWith('/api/athlete/group-programs/prg_2/adopt', {
      method: 'POST',
      body: '{}',
      headers: {},
    })
  })

  it('adoptGroupProgram handles boolean confirmExistingPlan shorthand', async () => {
    mocks.api.mockResolvedValueOnce({ ok: true, adoption: { id: 'gadp_3' } })

    await adoptGroupProgram('prg_3', true, { idempotencyKey: 'idemp_bool_short' })
    expect(mocks.api).toHaveBeenCalledWith('/api/athlete/group-programs/prg_3/adopt', {
      method: 'POST',
      body: JSON.stringify({ confirmExistingPlan: true }),
      headers: {
        'Idempotency-Key': 'idemp_bool_short',
      },
    })
  })
})

describe('AbortSignal handling', () => {
  it('throws AbortError immediately if signal is already aborted', async () => {
    const ctl = new AbortController()
    ctl.abort()

    await expect(listCoachGroups({ signal: ctl.signal })).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(mocks.api).not.toHaveBeenCalled()
  })

  it('forwards AbortSignal into api options', async () => {
    const ctl = new AbortController()
    mocks.api.mockResolvedValueOnce({ groups: [] })

    await listCoachGroups({ signal: ctl.signal })
    expect(mocks.api).toHaveBeenCalledWith('/api/coach/groups', expect.objectContaining({
      signal: ctl.signal,
    }))
  })

  it('does not rewrap AbortError into GroupChallengesError', async () => {
    const abortErr = new Error('The user aborted a request.')
    abortErr.name = 'AbortError'
    mocks.api.mockRejectedValueOnce(abortErr)

    await expect(getCoachGroup('grp_1')).rejects.toThrow('The user aborted a request.')
    try {
      await getCoachGroup('grp_1')
    } catch (e) {
      expect(e).not.toBeInstanceOf(GroupChallengesError)
      expect(e.name).toBe('AbortError')
    }
  })
})

describe('Error status code mapping', () => {
  it('maps HTTP 403 to ForbiddenError', async () => {
    const httpErr = new Error('Access denied')
    httpErr.status = 403
    httpErr.data = { error: 'Access denied', code: 'scope_forbidden' }
    mocks.api.mockRejectedValueOnce(httpErr)

    try {
      await addCoachGroupMember('grp_1', 'ath_unlinked')
    } catch (e) {
      expect(e).toBeInstanceOf(ForbiddenError)
      expect(e).toBeInstanceOf(GroupChallengesError)
      expect(e.status).toBe(403)
      expect(e.code).toBe('scope_forbidden')
    }
  })

  it('maps HTTP 404 to NotFoundError', async () => {
    const httpErr = new Error('Group not found')
    httpErr.status = 404
    httpErr.data = { error: 'Group not found', code: 'group_not_found' }
    mocks.api.mockRejectedValueOnce(httpErr)

    try {
      await getCoachGroup('grp_missing')
    } catch (e) {
      expect(e).toBeInstanceOf(NotFoundError)
      expect(e).toBeInstanceOf(GroupChallengesError)
      expect(e.status).toBe(404)
      expect(e.code).toBe('group_not_found')
    }
  })

  it('maps HTTP 409 to ConflictError (e.g. group_full)', async () => {
    const httpErr = new Error('Group capacity reached')
    httpErr.status = 409
    httpErr.data = { error: 'Group is full', code: 'group_full' }
    mocks.api.mockRejectedValueOnce(httpErr)

    try {
      await joinGroupByInvite('GRP-FULL1234')
    } catch (e) {
      expect(e).toBeInstanceOf(ConflictError)
      expect(e).toBeInstanceOf(GroupChallengesError)
      expect(e.status).toBe(409)
      expect(e.code).toBe('group_full')
    }
  })

  it('maps HTTP 410 to ExpiredError (and GoneError alias)', async () => {
    const httpErr = new Error('Invite expired')
    httpErr.status = 410
    httpErr.data = { error: 'Invite expired', code: 'invite_expired' }
    mocks.api.mockRejectedValueOnce(httpErr)

    try {
      await joinGroupByInvite('GRP-EXPIRED12')
    } catch (e) {
      expect(e).toBeInstanceOf(ExpiredError)
      expect(e).toBeInstanceOf(GoneError)
      expect(e).toBeInstanceOf(GroupChallengesError)
      expect(e.status).toBe(410)
      expect(e.code).toBe('invite_expired')
    }
  })

  it('maps HTTP 429 to RateLimitError with retryAfter', async () => {
    const httpErr = new Error('Too many requests')
    httpErr.status = 429
    httpErr.retryAfter = 45
    httpErr.data = { error: 'Rate limit exceeded', code: 'rate_limited' }
    mocks.api.mockRejectedValueOnce(httpErr)

    try {
      await rotateGroupInvite('grp_1')
    } catch (e) {
      expect(e).toBeInstanceOf(RateLimitError)
      expect(e).toBeInstanceOf(GroupChallengesError)
      expect(e.status).toBe(429)
      expect(e.code).toBe('rate_limited')
      expect(e.retryAfter).toBe(45)
    }
  })

  it('maps unmapped HTTP codes (e.g. 500) to base GroupChallengesError', () => {
    const raw = new Error('Server error')
    raw.status = 500
    raw.data = { code: 'internal_error', error: 'Database timeout' }
    const err = wrapGroupChallengesError(raw)
    expect(err).toBeInstanceOf(GroupChallengesError)
    expect(err).not.toBeInstanceOf(ConflictError)
    expect(err.status).toBe(500)
    expect(err.code).toBe('internal_error')
    expect(err.message).toBe('Database timeout')
  })

  it('wrapGroupChallengesError is idempotent on already wrapped errors', () => {
    const initial = new ConflictError('Duplicate key', 'idempotency_conflict')
    expect(wrapGroupChallengesError(initial)).toBe(initial)
  })
})
