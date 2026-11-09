// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  user: { id: 'u_athlete_1', name: 'Alice Silva', profile: { kind: 'athlete' } },
  toast: vi.fn(),
  api: vi.fn(),
  // Athlete API mocks
  listAthleteGroups: vi.fn(),
  joinGroupByInvite: vi.fn(),
  acceptGroupInvitation: vi.fn(),
  leaveGroup: vi.fn(),
  getAthleteGroup: vi.fn(),
  listAthleteChallenges: vi.fn(),
  getAthleteChallenge: vi.fn(),
  getAthleteChallengeLeaderboard: vi.fn(),
  listAthleteGroupPrograms: vi.fn(),
  adoptGroupProgram: vi.fn(),
  // Coach mocks for CommunityHub dual-role
  listCoachGroups: vi.fn(),
  listCoachChallenges: vi.fn(),
  listCoachGroupPrograms: vi.fn(),
  activeRole: 'athlete',
  isDualRole: false,
  setActiveRole: vi.fn(),
}))

vi.mock('../../store/useStore.js', () => {
  const snap = () => ({ user: mocks.user })
  const useStore = selector => (selector ? selector(snap()) : snap())
  useStore.getState = snap
  return { useStore }
})

vi.mock('../../store/useUI.js', () => {
  const snap = () => ({ toast: mocks.toast })
  const useUI = selector => (selector ? selector(snap()) : snap())
  useUI.getState = snap
  return { useUI }
})

vi.mock('../../lib/api.js', () => ({
  api: (...args) => mocks.api(...args),
}))

vi.mock('../../lib/roles.js', async () => {
  const actual = await vi.importActual('../../lib/roles.js')
  return {
    ...actual,
    useActiveRole: () => [mocks.activeRole, mocks.setActiveRole, mocks.isDualRole],
  }
})

vi.mock('../../lib/group-challenges-api.js', async () => {
  const actual = await vi.importActual('../../lib/group-challenges-api.js')
  return {
    ...actual,
    listAthleteGroups: (...args) => mocks.listAthleteGroups(...args),
    joinGroupByInvite: (...args) => mocks.joinGroupByInvite(...args),
    acceptGroupInvitation: (...args) => mocks.acceptGroupInvitation(...args),
    leaveGroup: (...args) => mocks.leaveGroup(...args),
    getAthleteGroup: (...args) => mocks.getAthleteGroup(...args),
    listAthleteChallenges: (...args) => mocks.listAthleteChallenges(...args),
    getAthleteChallenge: (...args) => mocks.getAthleteChallenge(...args),
    getAthleteChallengeLeaderboard: (...args) => mocks.getAthleteChallengeLeaderboard(...args),
    listAthleteGroupPrograms: (...args) => mocks.listAthleteGroupPrograms(...args),
    adoptGroupProgram: (...args) => mocks.adoptGroupProgram(...args),
    listCoachGroups: (...args) => mocks.listCoachGroups(...args),
    listCoachChallenges: (...args) => mocks.listCoachChallenges(...args),
    listCoachGroupPrograms: (...args) => mocks.listCoachGroupPrograms(...args),
  }
})

import AthleteGroupsView from './AthleteGroupsView.jsx'
import AthleteChallengesView from './AthleteChallengesView.jsx'
import AthleteGroupProgramsView from './AthleteGroupProgramsView.jsx'
import CommunityHub from '../CommunityHub.jsx'
import { ConflictError, ExpiredError, ForbiddenError } from '../../lib/group-challenges-api.js'

let host, root

beforeEach(() => {
  vi.clearAllMocks()
  mocks.user = { id: 'u_athlete_1', name: 'Alice Silva', profile: { kind: 'athlete' } }
  mocks.activeRole = 'athlete'
  mocks.isDualRole = false
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.querySelectorAll('.ds-modal-backdrop, #modal-root').forEach(el => el.remove())
})

const settle = () => act(async () => {
  await Promise.resolve()
  await new Promise(resolve => queueMicrotask(resolve))
  await new Promise(resolve => setTimeout(resolve, 0))
})

const mount = async (component, initialEntry = '/') => {
  act(() => {
    root.render(
      <MemoryRouter initialEntries={[initialEntry]}>
        {component}
      </MemoryRouter>
    )
  })
  await settle()
}

const button = (label, container = document.body) =>
  [...container.querySelectorAll('button')].find(item => item.textContent.trim().includes(label))

const input = (name, container = host) =>
  container.querySelector(`input[name="${name}"], textarea[name="${name}"], select[name="${name}"]`)

const changeInput = async (element, value) => {
  await act(async () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      element instanceof HTMLInputElement ? HTMLInputElement.prototype :
      element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype :
      HTMLSelectElement.prototype,
      'value'
    )
    descriptor?.set?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await settle()
}

describe('AthleteGroupsView', () => {
  const activeGroup = {
    id: 'grp_1',
    name: 'Grupo Força Total',
    description: 'Comunidade dos alunos de musculação',
    category: 'Musculação',
    memberCount: 12,
    status: 'active',
    coach: { name: 'Coach Bruno' },
  }

  const pendingGroup = {
    id: 'grp_2',
    name: 'Grupo Hipertrofia Avançada',
    description: 'Convite pendente de confirmação',
    category: 'Avançado',
    status: 'pending',
    coach: { name: 'Coach Bruno' },
  }

  it('lists active groups and pending invitations separately', async () => {
    mocks.listAthleteGroups.mockResolvedValueOnce({
      groups: [activeGroup, pendingGroup],
      page: { hasMore: false },
    })

    await mount(<AthleteGroupsView />)

    expect(mocks.listAthleteGroups).toHaveBeenCalled()
    expect(host.textContent).toContain('Grupo Força Total')
    expect(host.textContent).toContain('Grupo Hipertrofia Avançada')
    expect(host.textContent).toContain('Pending invites (1)')
  })

  it('accepts a pending group invitation', async () => {
    mocks.listAthleteGroups.mockResolvedValue({
      groups: [pendingGroup],
      page: { hasMore: false },
    })
    mocks.acceptGroupInvitation.mockResolvedValueOnce({ ok: true, group: { ...pendingGroup, status: 'active' } })

    await mount(<AthleteGroupsView />)

    const acceptBtn = button('Accept invitation')
    expect(acceptBtn).toBeTruthy()

    await act(async () => {
      acceptBtn.click()
    })
    await settle()

    expect(mocks.acceptGroupInvitation).toHaveBeenCalledWith('grp_2')
    expect(mocks.toast).toHaveBeenCalledWith('Group invitation accepted!')
  })

  it('declines a pending invitation', async () => {
    mocks.listAthleteGroups.mockResolvedValue({
      groups: [pendingGroup],
      page: { hasMore: false },
    })
    mocks.leaveGroup.mockResolvedValueOnce({ ok: true, status: 'left' })

    await mount(<AthleteGroupsView />)

    const declineBtn = button('Decline invitation')
    expect(declineBtn).toBeTruthy()

    await act(async () => {
      declineBtn.click()
    })
    await settle()

    const confirmModal = document.querySelector('#leave-group-confirm-title')?.closest('.pro-modal-container')
    expect(confirmModal).toBeTruthy()

    await act(async () => {
      button('Leave group', confirmModal).click()
    })
    await settle()

    expect(mocks.leaveGroup).toHaveBeenCalledWith('grp_2')
  })

  it('displays contextual privacy guarantee notice in join section', async () => {
    mocks.listAthleteGroups.mockResolvedValueOnce({ groups: [], page: { hasMore: false } })

    await mount(<AthleteGroupsView />)

    expect(host.textContent).toContain('Privacy guarantee')
    expect(host.textContent).toContain('Your health data, private workouts, and body measurements will never be shared')
  })

  it('joins group using an invite code', async () => {
    mocks.listAthleteGroups.mockResolvedValue({ groups: [], page: { hasMore: false } })
    mocks.joinGroupByInvite.mockResolvedValueOnce({ ok: true, group: activeGroup, member: { id: 'm_1' } })
    mocks.getAthleteGroup.mockResolvedValueOnce({ group: activeGroup, members: [] })

    await mount(<AthleteGroupsView />)

    await changeInput(input('inviteCode'), 'GRP-INVITE123')

    await act(async () => {
      button('Join group').click()
    })
    await settle()

    expect(mocks.joinGroupByInvite).toHaveBeenCalledWith('GRP-INVITE123')
    expect(mocks.toast).toHaveBeenCalledWith('Joined group successfully!')
  })

  it('displays friendly error when group is full (409 Conflict)', async () => {
    mocks.listAthleteGroups.mockResolvedValueOnce({ groups: [], page: { hasMore: false } })
    mocks.joinGroupByInvite.mockRejectedValueOnce(new ConflictError('Group is full', 'group_full'))

    await mount(<AthleteGroupsView />)

    await changeInput(input('inviteCode'), 'GRP-FULL999')

    await act(async () => {
      button('Join group').click()
    })
    await settle()

    expect(host.textContent).toContain('maximum member capacity')
  })

  it('displays friendly error when invite is expired (410 Expired)', async () => {
    mocks.listAthleteGroups.mockResolvedValueOnce({ groups: [], page: { hasMore: false } })
    mocks.joinGroupByInvite.mockRejectedValueOnce(new ExpiredError('Invite expired', 'invite_expired'))

    await mount(<AthleteGroupsView />)

    await changeInput(input('inviteCode'), 'GRP-OLD')

    await act(async () => {
      button('Join group').click()
    })
    await settle()

    expect(host.textContent).toContain('expired')
  })

  it('leaves an active group with confirmation modal', async () => {
    mocks.listAthleteGroups.mockResolvedValue({ groups: [activeGroup], page: { hasMore: false } })
    mocks.leaveGroup.mockResolvedValueOnce({ ok: true, status: 'left' })

    await mount(<AthleteGroupsView />)

    const leaveBtn = button('Leave group')
    expect(leaveBtn).toBeTruthy()

    await act(async () => {
      leaveBtn.click()
    })
    await settle()

    const confirmModal = document.querySelector('#leave-group-confirm-title')?.closest('.pro-modal-container')
    expect(confirmModal).toBeTruthy()

    await act(async () => {
      button('Leave group', confirmModal).click()
    })
    await settle()

    expect(mocks.leaveGroup).toHaveBeenCalledWith('grp_1')
    expect(mocks.toast).toHaveBeenCalledWith('Left group successfully.')
  })

  it('views privacy-safe group members roster', async () => {
    mocks.listAthleteGroups.mockResolvedValueOnce({ groups: [activeGroup], page: { hasMore: false } })
    mocks.getAthleteGroup.mockResolvedValueOnce({
      group: activeGroup,
      members: [
        { id: 'm_1', displayName: 'Carlos M.', role: 'member' },
        { id: 'm_2', displayName: 'Diana S.', role: 'moderator' },
      ],
    })

    await mount(<AthleteGroupsView />)

    await act(async () => {
      button('View members').click()
    })
    await settle()

    expect(mocks.getAthleteGroup).toHaveBeenCalledWith('grp_1', { limit: 50 })
    expect(document.body.textContent).toContain('Carlos M.')
    expect(document.body.textContent).toContain('Diana S.')
    expect(document.body.textContent).toContain('Moderator')
  })
})

describe('AthleteChallengesView', () => {
  const activeChallenge = {
    id: 'ch_1',
    title: 'Desafio Consistência de Novembro',
    description: 'Bata 15 treinos neste mês.',
    type: 'workouts_count',
    status: 'active',
    startAt: '2026-11-01T00:00:00Z',
    endAt: '2026-11-30T00:00:00Z',
    timeZone: 'UTC',
  }

  it('lists active challenges and switches between status tabs', async () => {
    mocks.listAthleteChallenges.mockResolvedValueOnce({
      challenges: [activeChallenge],
      page: { hasMore: false },
    })

    await mount(<AthleteChallengesView />)

    expect(mocks.listAthleteChallenges).toHaveBeenCalled()
    expect(host.textContent).toContain('Desafio Consistência de Novembro')
    expect(host.textContent).toContain('Workouts count')

    // Switch to Completed tab
    await act(async () => {
      button('Completed').click()
    })
    await settle()

    expect(host.textContent).toContain('No completed challenges')
  })

  it('renders accessible semantic table for athlete challenge leaderboard with ARIA labels', async () => {
    mocks.listAthleteChallenges.mockResolvedValueOnce({
      challenges: [activeChallenge],
      page: { hasMore: false },
    })
    mocks.getAthleteChallengeLeaderboard.mockResolvedValueOnce({
      challenge: activeChallenge,
      leaderboard: [
        { participantKey: 'p_1', rank: 1, displayName: 'Bob', score: 200, workoutsCount: 10, isMe: false },
        { participantKey: 'p_2', rank: 2, displayName: 'Alice Silva', score: 180, workoutsCount: 9, isMe: true },
      ],
      activityFeed: [],
    })

    await mount(<AthleteChallengesView />)

    await act(async () => {
      button('Leaderboard & Activity feed').click()
    })
    await settle()

    const table = document.querySelector('table.gc-leaderboard-table')
    expect(table).toBeTruthy()
    expect(table.querySelector('caption')?.textContent).toBe('Leaderboard')
    const meRow = table.querySelector('tr.athlete-me-row')
    expect(meRow).toBeTruthy()
    expect(meRow.getAttribute('aria-current')).toBe('true')
  })

  it('opens challenge details with leaderboard highlighting current athlete', async () => {
    mocks.listAthleteChallenges.mockResolvedValueOnce({
      challenges: [activeChallenge],
      page: { hasMore: false },
    })
    mocks.getAthleteChallengeLeaderboard.mockResolvedValueOnce({
      challenge: activeChallenge,
      leaderboard: [
        { participantKey: 'p_1', rank: 1, displayName: 'Bob', score: 200, workoutsCount: 10, isMe: false },
        { participantKey: 'p_2', rank: 2, displayName: 'Alice Silva', score: 180, workoutsCount: 9, isMe: true },
      ],
      activityFeed: [
        { id: 'f_1', displayName: 'Alice Silva', description: 'Completou treino', pointsAwarded: 20, timestamp: '2026-11-04T10:00:00Z' },
      ],
    })

    await mount(<AthleteChallengesView />)

    await act(async () => {
      button('Leaderboard & Activity feed').click()
    })
    await settle()

    expect(mocks.getAthleteChallengeLeaderboard).toHaveBeenCalledWith('ch_1', expect.anything())
    expect(document.body.textContent).toContain('Bob')
    expect(document.body.textContent).toContain('Alice Silva')

    // Verify current athlete highlight row
    const meRow = document.querySelector('.athlete-me-row')
    expect(meRow).toBeTruthy()
    expect(meRow.textContent).toContain('You')
    expect(meRow.textContent).toContain('180')
  })

  it('reloads leaderboard and feed when refresh button is tapped', async () => {
    mocks.listAthleteChallenges.mockResolvedValueOnce({
      challenges: [activeChallenge],
      page: { hasMore: false },
    })
    mocks.getAthleteChallengeLeaderboard.mockResolvedValue({
      challenge: activeChallenge,
      leaderboard: [],
      activityFeed: [],
    })

    await mount(<AthleteChallengesView />)

    await act(async () => {
      button('Leaderboard & Activity feed').click()
    })
    await settle()

    expect(mocks.getAthleteChallengeLeaderboard).toHaveBeenCalledTimes(1)

    await act(async () => {
      button('Refresh').click()
    })
    await settle()

    expect(mocks.getAthleteChallengeLeaderboard).toHaveBeenCalledTimes(2)
  })
})

describe('AthleteGroupProgramsView', () => {
  const publishedProgram = {
    id: 'prg_1',
    groupId: 'grp_1',
    title: 'Programa de Força Comunitário',
    version: 2,
    status: 'published',
    group: { name: 'Barbell Club' },
    coach: { name: 'Coach Bruno' },
    routine: {
      name: 'Rotina ABC',
      notes: 'Executar 3 vezes por semana',
      divisions: [
        { id: 'division_1', name: 'A', exercises: [{ id: 'ex_1', name: 'Agachamento', sets: 4, reps: '8-10', load: '80 kg', restSeconds: 90 }] },
        { id: 'division_2', name: 'B', exercises: [{ id: 'ex_2', name: 'Supino', sets: 4, reps: '8-10', load: '60 kg', restSeconds: 90 }] },
      ]
    }
  }

  it('lists published collective programs with division counts', async () => {
    mocks.listAthleteGroupPrograms.mockResolvedValueOnce({
      programs: [publishedProgram],
      page: { hasMore: false },
    })

    await mount(<AthleteGroupProgramsView />)

    expect(mocks.listAthleteGroupPrograms).toHaveBeenCalled()
    expect(host.textContent).toContain('Programa de Força Comunitário')
    expect(host.textContent).toContain('v2')
    expect(host.textContent).toContain('Barbell Club')
    expect(host.textContent).toContain('Coach Bruno')
    expect(host.textContent).toContain('A:')
    expect(host.textContent).toContain('B:')
  })

  it('adopts a collective program with confirmation modal and idempotency', async () => {
    mocks.listAthleteGroupPrograms.mockResolvedValueOnce({
      programs: [publishedProgram],
      page: { hasMore: false },
    })
    mocks.adoptGroupProgram.mockResolvedValueOnce({
      ok: true,
      adoption: { id: 'gadp_1', programId: 'prg_1' },
      routineIds: ['r_1', 'r_2'],
    })

    await mount(<AthleteGroupProgramsView />)

    await act(async () => {
      button('Adopt program').click()
    })
    await settle()

    const confirmModal = document.querySelector('#adopt-program-confirm-title')?.closest('.pro-modal-container')
    expect(confirmModal).toBeTruthy()
    expect(confirmModal.textContent).toContain('overwrite conflicting routines')

    await act(async () => {
      button('Confirm adoption', confirmModal).click()
    })
    await settle()

    expect(mocks.adoptGroupProgram).toHaveBeenCalledWith(
      'prg_1',
      expect.objectContaining({
        confirmExistingPlan: true,
        idempotencyKey: expect.stringMatching(/^adopt_/),
      })
    )
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining('adopted successfully'))
  })
})

describe('CommunityHub dual-role and navigation', () => {
  it('keeps a standard athlete in athlete views when the URL requests coach mode', async () => {
    mocks.listAthleteGroups.mockResolvedValue({ groups: [], page: { hasMore: false } })

    await mount(<CommunityHub />, '/community?role=coach')

    expect(host.textContent).toContain('My groups')
    expect(mocks.listAthleteGroups).toHaveBeenCalled()
    expect(mocks.listCoachGroups).not.toHaveBeenCalled()
    expect(mocks.listCoachChallenges).not.toHaveBeenCalled()
    expect(mocks.listCoachGroupPrograms).not.toHaveBeenCalled()
    expect(mocks.setActiveRole).not.toHaveBeenCalled()
  })

  it('keeps a standard athlete in athlete views when defaultRole requests coach mode', async () => {
    mocks.listAthleteGroups.mockResolvedValue({ groups: [], page: { hasMore: false } })

    await mount(<CommunityHub defaultRole="coach" />)

    expect(host.textContent).toContain('My groups')
    expect(mocks.listAthleteGroups).toHaveBeenCalled()
    expect(mocks.listCoachGroups).not.toHaveBeenCalled()
    expect(mocks.setActiveRole).not.toHaveBeenCalled()
  })

  it('keeps a non-dual coach in coach views when the URL requests athlete mode', async () => {
    mocks.user = { id: 'u_coach_standard', name: 'Coach Bruno', profile: { kind: 'coach' } }
    mocks.activeRole = 'coach'
    mocks.listCoachGroups.mockResolvedValue({ groups: [], page: { hasMore: false } })

    await mount(<CommunityHub />, '/community?role=athlete')

    expect(host.textContent).toContain('Groups')
    expect(host.textContent).not.toContain('My groups')
    expect(mocks.listCoachGroups).toHaveBeenCalled()
    expect(mocks.listAthleteGroups).not.toHaveBeenCalled()
    expect(mocks.setActiveRole).not.toHaveBeenCalled()
  })

  it('preserves an authorized athlete deep link for dual-role users and still allows switching', async () => {
    mocks.user = { id: 'u_coach_deep_link', name: 'Coach Bruno', profile: { kind: 'coach' } }
    mocks.activeRole = 'coach'
    mocks.isDualRole = true
    mocks.listCoachGroups.mockResolvedValue({ groups: [], page: { hasMore: false } })
    mocks.listAthleteGroups.mockResolvedValue({ groups: [], page: { hasMore: false } })

    await mount(<CommunityHub />, '/community?role=athlete')

    expect(mocks.listAthleteGroups).toHaveBeenCalled()
    expect(mocks.listCoachGroups).not.toHaveBeenCalled()

    await act(async () => {
      button('Coach view').click()
    })
    await settle()

    expect(mocks.listCoachGroups).toHaveBeenCalled()
    expect(mocks.setActiveRole).toHaveBeenCalledWith('coach')
  })

  it('supports dual-role switching between coach and athlete view modes', async () => {
    mocks.user = { id: 'u_coach_1', name: 'Coach Bruno', profile: { kind: 'coach' } }
    mocks.activeRole = 'coach'
    mocks.isDualRole = true
    mocks.listCoachGroups.mockResolvedValue({ groups: [], page: { hasMore: false } })
    mocks.listAthleteGroups.mockResolvedValue({ groups: [], page: { hasMore: false } })

    await mount(<CommunityHub defaultRole="coach" />)

    // Verify coach view is active initially
    expect(mocks.listCoachGroups).toHaveBeenCalled()

    // Switch to athlete view
    const athleteTab = button('Athlete view')
    expect(athleteTab).toBeTruthy()

    await act(async () => {
      athleteTab.click()
    })
    await settle()

    expect(mocks.listAthleteGroups).toHaveBeenCalled()
    expect(mocks.setActiveRole).toHaveBeenCalledWith('athlete')

    await act(async () => {
      button('Coach view').click()
    })
    await settle()

    expect(mocks.listCoachGroups).toHaveBeenCalledTimes(2)
    expect(mocks.setActiveRole).toHaveBeenLastCalledWith('coach')
  })

  it('switches between section tabs (groups, challenges, programs)', async () => {
    mocks.user = { id: 'u_athlete_1', name: 'Alice Silva', profile: { kind: 'athlete' } }
    mocks.listAthleteGroups.mockResolvedValue({ groups: [], page: { hasMore: false } })
    mocks.listAthleteChallenges.mockResolvedValue({ challenges: [], page: { hasMore: false } })
    mocks.listAthleteGroupPrograms.mockResolvedValue({ programs: [], page: { hasMore: false } })

    await mount(<CommunityHub defaultRole="athlete" />)

    // Click on Group challenges section tab
    await act(async () => {
      button('Group challenges').click()
    })
    await settle()

    expect(mocks.listAthleteChallenges).toHaveBeenCalled()

    // Click on Collective programs section tab
    await act(async () => {
      button('Collective programs').click()
    })
    await settle()

    expect(mocks.listAthleteGroupPrograms).toHaveBeenCalled()
  })
})
