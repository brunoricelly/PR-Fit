// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  user: { id: 'u_coach_1', name: 'Coach Bruno', profile: { kind: 'coach' } },
  toast: vi.fn(),
  api: vi.fn(),
  // Group challenges API mocks
  listCoachGroups: vi.fn(),
  createCoachGroup: vi.fn(),
  getCoachGroup: vi.fn(),
  updateCoachGroup: vi.fn(),
  deleteCoachGroup: vi.fn(),
  addCoachGroupMember: vi.fn(),
  removeCoachGroupMember: vi.fn(),
  rotateGroupInvite: vi.fn(),
  listCoachChallenges: vi.fn(),
  createCoachChallenge: vi.fn(),
  getCoachChallenge: vi.fn(),
  updateCoachChallenge: vi.fn(),
  deleteCoachChallenge: vi.fn(),
  getCoachChallengeLeaderboard: vi.fn(),
  awardCustomPoints: vi.fn(),
  listCoachGroupPrograms: vi.fn(),
  createCoachGroupProgram: vi.fn(),
  publishCoachGroupProgram: vi.fn(),
  archiveCoachGroupProgram: vi.fn(),
  copyText: vi.fn().mockResolvedValue(true),
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

vi.mock('../../lib/clipboard.js', () => ({
  copyText: (...args) => mocks.copyText(...args),
}))

vi.mock('../../lib/group-challenges-api.js', async () => {
  const actual = await vi.importActual('../../lib/group-challenges-api.js')
  return {
    ...actual,
    listCoachGroups: (...args) => mocks.listCoachGroups(...args),
    createCoachGroup: (...args) => mocks.createCoachGroup(...args),
    getCoachGroup: (...args) => mocks.getCoachGroup(...args),
    updateCoachGroup: (...args) => mocks.updateCoachGroup(...args),
    deleteCoachGroup: (...args) => mocks.deleteCoachGroup(...args),
    addCoachGroupMember: (...args) => mocks.addCoachGroupMember(...args),
    removeCoachGroupMember: (...args) => mocks.removeCoachGroupMember(...args),
    rotateGroupInvite: (...args) => mocks.rotateGroupInvite(...args),
    listCoachChallenges: (...args) => mocks.listCoachChallenges(...args),
    createCoachChallenge: (...args) => mocks.createCoachChallenge(...args),
    getCoachChallenge: (...args) => mocks.getCoachChallenge(...args),
    updateCoachChallenge: (...args) => mocks.updateCoachChallenge(...args),
    deleteCoachChallenge: (...args) => mocks.deleteCoachChallenge(...args),
    getCoachChallengeLeaderboard: (...args) => mocks.getCoachChallengeLeaderboard(...args),
    awardCustomPoints: (...args) => mocks.awardCustomPoints(...args),
    listCoachGroupPrograms: (...args) => mocks.listCoachGroupPrograms(...args),
    createCoachGroupProgram: (...args) => mocks.createCoachGroupProgram(...args),
    publishCoachGroupProgram: (...args) => mocks.publishCoachGroupProgram(...args),
    archiveCoachGroupProgram: (...args) => mocks.archiveCoachGroupProgram(...args),
  }
})

import CoachGroupsView from './CoachGroupsView.jsx'
import CoachChallengesView from './CoachChallengesView.jsx'
import CoachGroupProgramsView from './CoachGroupProgramsView.jsx'
import { ConflictError, RateLimitError } from '../../lib/group-challenges-api.js'

let host, root

beforeEach(() => {
  vi.clearAllMocks()
  mocks.user = { id: 'u_coach_1', name: 'Coach Bruno', profile: { kind: 'coach' } }
  mocks.api.mockResolvedValue({ links: [
    { athleteId: 'ath_1', status: 'active', scopes: ['training'], athlete: { id: 'ath_1', name: 'Alice Silva' } },
    { athleteId: 'ath_2', status: 'active', scopes: ['training'], athlete: { id: 'ath_2', name: 'Bob Souza' } },
  ]})
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

const mount = async (component) => {
  act(() => {
    root.render(
      <MemoryRouter>
        {component}
      </MemoryRouter>
    )
  })
  await settle()
}

const button = (label, container = document.body) =>
  [...container.querySelectorAll('button')].find(item => item.textContent.trim().includes(label))

const input = (name, container = document.body) =>
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

describe('CoachGroupsView', () => {
  const fakeGroup = {
    id: 'grp_1',
    name: 'Grupo Força Total',
    description: 'Treinos pesados de força',
    category: 'Powerlifting',
    memberCount: 8,
    maxMembers: 20,
    isPrivate: true,
    inviteCode: 'GRP-ABC12345',
    invite: { code: 'GRP-ABC12345' },
  }

  it('provides quick shortcuts to assign collective programs and challenges to a group', async () => {
    mocks.listCoachGroups.mockResolvedValueOnce({
      groups: [{ id: 'grp_1', name: 'Barbell Club', category: 'Powerlifting', memberCount: 10, maxMembers: 50 }],
      page: { hasMore: false },
    })

    await mount(<CoachGroupsView />)

    expect(button('Collective programs')).toBeTruthy()
    expect(button('Group challenges')).toBeTruthy()
  })

  it('loads and lists coach groups with capacity meter and category', async () => {
    mocks.listCoachGroups.mockResolvedValueOnce({ groups: [fakeGroup], page: { hasMore: false } })
    await mount(<CoachGroupsView />)

    expect(mocks.listCoachGroups).toHaveBeenCalled()
    expect(host.textContent).toContain('Grupo Força Total')
    expect(host.textContent).toContain('8 / 20')
    expect(host.textContent).toContain('Powerlifting')
  })

  it('filters groups using the search box', async () => {
    const groupA = { id: 'g_1', name: 'Barbell Club', category: 'Powerlifting', memberCount: 5, maxMembers: 10 }
    const groupB = { id: 'g_2', name: 'Running Crew', category: 'Cardio', memberCount: 3, maxMembers: 10 }
    mocks.listCoachGroups.mockResolvedValueOnce({ groups: [groupA, groupB], page: { hasMore: false } })
    await mount(<CoachGroupsView />)

    expect(host.textContent).toContain('Barbell Club')
    expect(host.textContent).toContain('Running Crew')

    await changeInput(input('groupSearch'), 'running')
    expect(host.textContent).not.toContain('Barbell Club')
    expect(host.textContent).toContain('Running Crew')
  })

  it('creates a new group via the modal', async () => {
    mocks.listCoachGroups.mockResolvedValue({ groups: [], page: { hasMore: false } })
    mocks.createCoachGroup.mockResolvedValueOnce({ group: fakeGroup, invite: { code: 'GRP-ABC12345' } })
    mocks.getCoachGroup.mockResolvedValueOnce({ group: fakeGroup, members: [] })

    await mount(<CoachGroupsView />)

    await act(async () => {
      button('New group').click()
    })
    await settle()

    const modal = document.querySelector('#create-group-title')?.closest('.pro-modal-container')
    expect(modal).toBeTruthy()

    await changeInput(input('name', modal), 'Novo Grupo Teste')
    await changeInput(input('description', modal), 'Descrição detalhada do grupo')

    await act(async () => {
      button('Create group', modal).click()
    })
    await settle()

    expect(mocks.createCoachGroup).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Novo Grupo Teste',
      description: 'Descrição detalhada do grupo',
    }))
    expect(mocks.toast).toHaveBeenCalled()
  })

  it('opens group details modal and copies invite code', async () => {
    mocks.listCoachGroups.mockResolvedValueOnce({ groups: [fakeGroup], page: { hasMore: false } })
    mocks.getCoachGroup.mockResolvedValueOnce({
      group: fakeGroup,
      members: [{ id: 'm_1', athleteId: 'ath_1', displayName: 'Alice Silva', role: 'member', status: 'active' }],
    })

    await mount(<CoachGroupsView />)

    await act(async () => {
      button('Group details').click()
    })
    await settle()

    expect(mocks.getCoachGroup).toHaveBeenCalledWith('grp_1', { limit: 100 })
    expect(document.body.textContent).toContain('Alice Silva')
    expect(document.body.textContent).toContain('GRP-ABC12345')

    await act(async () => {
      button('Copy code').click()
    })
    await settle()

    expect(mocks.copyText).toHaveBeenCalledWith('GRP-ABC12345')
  })

  it('rotates group invite code and updates view', async () => {
    mocks.listCoachGroups.mockResolvedValueOnce({ groups: [fakeGroup], page: { hasMore: false } })
    mocks.getCoachGroup.mockResolvedValueOnce({ group: fakeGroup, members: [] })
    mocks.rotateGroupInvite.mockResolvedValueOnce({ invite: { code: 'GRP-NEW99999' } })

    await mount(<CoachGroupsView />)

    await act(async () => {
      button('Group details').click()
    })
    await settle()

    await act(async () => {
      button('Rotate code').click()
    })
    await settle()

    expect(mocks.rotateGroupInvite).toHaveBeenCalledWith('grp_1')
    expect(mocks.toast).toHaveBeenCalled()
  })

  it('adds an athlete via autocomplete modal', async () => {
    mocks.listCoachGroups.mockResolvedValue({ groups: [fakeGroup], page: { hasMore: false } })
    mocks.getCoachGroup.mockResolvedValue({ group: fakeGroup, members: [] })
    mocks.addCoachGroupMember.mockResolvedValueOnce({ member: { id: 'm_2', athleteId: 'ath_2' } })

    await mount(<CoachGroupsView />)

    await act(async () => {
      button('Group details').click()
    })
    await settle()

    await act(async () => {
      button('Add athlete').click()
    })
    await settle()

    expect(mocks.api).toHaveBeenCalledWith('/api/coach/athletes')

    // Click on athlete option
    const option = [...document.body.querySelectorAll('.gc-autocomplete-option')].find(el => el.textContent.includes('Bob Souza'))
    expect(option).toBeTruthy()

    await act(async () => {
      option.click()
    })
    await settle()

    const addBtn = [...document.body.querySelectorAll('button')].find(b => b.textContent.includes('Add athlete') && !b.disabled && b.type === 'button')
    await act(async () => {
      addBtn.click()
    })
    await settle()

    expect(mocks.addCoachGroupMember).toHaveBeenCalledWith('grp_1', {
      athleteId: 'ath_2',
      role: 'member',
    })
  })

  it('removes a member with confirmation modal', async () => {
    mocks.listCoachGroups.mockResolvedValue({ groups: [fakeGroup], page: { hasMore: false } })
    mocks.getCoachGroup.mockResolvedValue({
      group: fakeGroup,
      members: [{ id: 'm_1', athleteId: 'ath_1', displayName: 'Alice Silva', role: 'member', status: 'active' }],
    })
    mocks.removeCoachGroupMember.mockResolvedValueOnce({ ok: true, status: 'removed' })

    await mount(<CoachGroupsView />)

    await act(async () => {
      button('Group details').click()
    })
    await settle()

    await act(async () => {
      button('Remove member').click()
    })
    await settle()

    const confirmModal = document.querySelector('#remove-member-confirm-title')?.closest('.pro-modal-container')
    expect(confirmModal).toBeTruthy()

    const confirmBtn = button('Remove member', confirmModal)
    await act(async () => {
      confirmBtn.click()
    })
    await settle()

    expect(mocks.removeCoachGroupMember).toHaveBeenCalledWith('grp_1', 'ath_1')
    expect(mocks.toast).toHaveBeenCalled()
  })

  it('displays friendly error when group capacity is reached (409 Conflict)', async () => {
    mocks.listCoachGroups.mockResolvedValue({ groups: [fakeGroup], page: { hasMore: false } })
    mocks.getCoachGroup.mockResolvedValue({ group: fakeGroup, members: [] })
    mocks.addCoachGroupMember.mockRejectedValueOnce(new ConflictError('Group is full', 'group_full'))

    await mount(<CoachGroupsView />)

    await act(async () => {
      button('Group details').click()
    })
    await settle()

    await act(async () => {
      button('Add athlete').click()
    })
    await settle()

    const option = [...document.body.querySelectorAll('.gc-autocomplete-option')].find(el => el.textContent.includes('Bob Souza'))
    await act(async () => {
      option.click()
    })
    await settle()

    const addBtn = [...document.body.querySelectorAll('button')].find(b => b.textContent.includes('Add athlete') && !b.disabled && b.type === 'button')
    await act(async () => {
      addBtn.click()
    })
    await settle()

    expect(document.body.textContent).toContain('maximum member capacity')
  })
  it('renders a semantic <main> tag standalone and a <div> tag when embedded', async () => {
    mocks.listCoachGroups.mockResolvedValue({ groups: [], page: { hasMore: false } })
    await mount(<CoachGroupsView />)
    expect(host.querySelector('main.gc-page')).toBeTruthy()
    expect(host.querySelector('div.gc-page')).toBeNull()

    await mount(<CoachGroupsView embedded />)
    expect(host.querySelector('main.gc-page')).toBeNull()
    expect(host.querySelector('div.gc-page.embedded')).toBeTruthy()
  })

  it('validates member capacity bounds (min 1, max 500) and displays inline error', async () => {
    mocks.listCoachGroups.mockResolvedValue({ groups: [], page: { hasMore: false } })
    mocks.createCoachGroup.mockResolvedValueOnce({ group: fakeGroup })
    mocks.getCoachGroup.mockResolvedValueOnce({ group: fakeGroup, members: [] })

    await mount(<CoachGroupsView />)

    await act(async () => {
      button('New group').click()
    })
    await settle()

    const modal = document.querySelector('#create-group-title')?.closest('.pro-modal-container')
    expect(modal).toBeTruthy()

    const maxMembersInput = input('maxMembers', modal)
    expect(maxMembersInput.getAttribute('min')).toBe('1')
    expect(maxMembersInput.getAttribute('max')).toBe('500')
    expect(modal.textContent).toContain('Choose a limit between 1 and 500 athletes.')

    await changeInput(input('name', modal), 'Grupo Validação')

    // Set invalid max members: 0
    await changeInput(maxMembersInput, '0')
    expect(button('Create group', modal).disabled).toBe(true)
    expect(modal.querySelector('.ds-field-error')).toBeTruthy()

    // Set valid max members: 1
    await changeInput(maxMembersInput, '1')
    expect(button('Create group', modal).disabled).toBe(false)
    expect(modal.querySelector('.ds-field-error')).toBeNull()

    await act(async () => {
      button('Create group', modal).click()
    })
    await settle()

    expect(mocks.createCoachGroup).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Grupo Validação',
      maxMembers: 1,
    }))
  })

  it('supports pagination of members in group details modal', async () => {
    mocks.listCoachGroups.mockResolvedValueOnce({ groups: [fakeGroup], page: { hasMore: false } })
    mocks.getCoachGroup.mockResolvedValueOnce({
      group: fakeGroup,
      members: [{ id: 'm_1', athleteId: 'ath_1', displayName: 'Atleta 1', role: 'member', status: 'active' }],
      page: { hasMore: true, nextCursor: 'cur_page_2' },
    })
    mocks.getCoachGroup.mockResolvedValueOnce({
      group: fakeGroup,
      members: [{ id: 'm_2', athleteId: 'ath_2', displayName: 'Atleta 2', role: 'member', status: 'active' }],
      page: { hasMore: false },
    })

    await mount(<CoachGroupsView />)

    await act(async () => {
      button('Group details').click()
    })
    await settle()

    expect(document.body.textContent).toContain('Atleta 1')
    expect(document.body.textContent).not.toContain('Atleta 2')

    const loadMoreBtn = button('Load more members')
    expect(loadMoreBtn).toBeTruthy()

    await act(async () => {
      loadMoreBtn.click()
    })
    await settle()

    expect(mocks.getCoachGroup).toHaveBeenCalledWith('grp_1', { cursor: 'cur_page_2', limit: 100 })
    expect(document.body.textContent).toContain('Atleta 1')
    expect(document.body.textContent).toContain('Atleta 2')
  })

  it('displays specific group limit reached error (409 group_limit_reached)', async () => {
    mocks.listCoachGroups.mockResolvedValue({ groups: [], page: { hasMore: false } })
    mocks.createCoachGroup.mockRejectedValueOnce(new ConflictError('group quota reached', 'group_limit_reached'))

    await mount(<CoachGroupsView />)

    await act(async () => {
      button('New group').click()
    })
    await settle()

    const modal = document.querySelector('#create-group-title')?.closest('.pro-modal-container')
    await changeInput(input('name', modal), 'Grupo 51')

    await act(async () => {
      button('Create group', modal).click()
    })
    await settle()

    expect(document.body.textContent).toContain('Group limit reached for your profile (maximum 50 groups).')
  })
})

describe('CoachChallengesView', () => {
  const fakeChallenge = {
    id: 'ch_1',
    title: 'Desafio Supino de Ouro',
    description: 'Quem levantar mais volume este mês ganha.',
    type: 'volume_load',
    scope: 'group',
    groupId: 'grp_1',
    status: 'active',
    startAt: '2026-11-01T00:00:00Z',
    endAt: '2026-11-30T00:00:00Z',
    timeZone: 'UTC',
    rules: { pointsPer1000: 5 },
  }

  it('lists challenges with badges and actions', async () => {
    mocks.listCoachChallenges.mockResolvedValueOnce({ challenges: [fakeChallenge], page: { hasMore: false } })
    mocks.listCoachGroups.mockResolvedValueOnce({ groups: [{ id: 'grp_1', name: 'Barbell Club' }] })

    await mount(<CoachChallengesView />)

    expect(mocks.listCoachChallenges).toHaveBeenCalled()
    expect(host.textContent).toContain('Desafio Supino de Ouro')
    expect(host.textContent).toContain('Volume load')
    expect(host.textContent).toContain('Active')
  })

  it('creates a challenge with volume metric and group scope', async () => {
    mocks.listCoachChallenges.mockResolvedValue({ challenges: [], page: { hasMore: false } })
    mocks.listCoachGroups.mockResolvedValue({ groups: [{ id: 'grp_1', name: 'Barbell Club' }] })
    mocks.createCoachChallenge.mockResolvedValueOnce({ challenge: fakeChallenge })
    mocks.getCoachChallengeLeaderboard.mockResolvedValueOnce({
      challenge: fakeChallenge,
      leaderboard: [],
      activityFeed: [],
    })

    await mount(<CoachChallengesView />)

    await act(async () => {
      button('New challenge').click()
    })
    await settle()

    const modal = document.querySelector('#create-challenge-title')?.closest('.pro-modal-container')
    expect(modal).toBeTruthy()

    await changeInput(input('title', modal), 'Desafio Supino de Ouro')
    await changeInput(input('groupId', modal), 'grp_1')
    await changeInput(input('type', modal), 'volume_load')

    await act(async () => {
      button('Create challenge', modal).click()
    })
    await settle()

    expect(mocks.createCoachChallenge).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Desafio Supino de Ouro',
      type: 'volume_load',
      rules: expect.objectContaining({ pointsPer1000: 5 }),
    }))
  })

  it('renders accessible semantic leaderboard table without inventing false zeros', async () => {
    mocks.listCoachChallenges.mockResolvedValueOnce({
      challenges: [{
        id: 'ch_workouts',
        title: 'Desafio Treinos de Novembro',
        type: 'workouts_count',
        scope: 'group',
        groupId: 'grp_1',
        status: 'active',
        startAt: '2026-11-01T00:00:00Z',
        endAt: '2026-11-30T00:00:00Z',
        rules: { pointsPerWorkout: 10 },
      }],
      page: { hasMore: false },
    })
    mocks.getCoachChallengeLeaderboard.mockResolvedValueOnce({
      challenge: {
        id: 'ch_workouts',
        title: 'Desafio Treinos de Novembro',
        type: 'workouts_count',
        status: 'active',
      },
      leaderboard: [
        { participantKey: 'p_1', rank: 1, displayName: 'Carla Silva', score: 50, workoutsCount: 5, volumeLoad: 0, habitCheckinsCount: 0 },
      ],
      activityFeed: [],
    })

    await mount(<CoachChallengesView />)

    await act(async () => {
      button('Leaderboard').click()
    })
    await settle()

    const table = document.querySelector('table.gc-leaderboard-table')
    expect(table).toBeTruthy()
    expect(table.getAttribute('aria-label')).toBe('Leaderboard')
    expect(table.querySelectorAll('th[scope="col"]').length).toBe(4)
    expect(table.textContent).toContain('Carla Silva')
    expect(table.textContent).toContain('5 workouts')
    expect(table.textContent).not.toContain('0 kg')
    expect(table.textContent).not.toContain('0 habits')
  })

  it('opens challenge details with real-time leaderboard and activity feed', async () => {
    mocks.listCoachChallenges.mockResolvedValueOnce({ challenges: [fakeChallenge], page: { hasMore: false } })
    mocks.getCoachChallengeLeaderboard.mockResolvedValue({
      challenge: fakeChallenge,
      leaderboard: [
        { participantKey: 'p_1', rank: 1, displayName: 'Alice', score: 120, workoutsCount: 6, volumeLoad: 24000 },
        { participantKey: 'p_2', rank: 2, displayName: 'Bob', score: 90, workoutsCount: 4, volumeLoad: 18000 },
      ],
      activityFeed: [
        { id: 'f_1', displayName: 'Alice', description: 'Treino finalizado', pointsAwarded: 20, timestamp: '2026-11-05T12:00:00Z' }
      ],
    })

    await mount(<CoachChallengesView />)

    await act(async () => {
      button('Leaderboard').click()
    })
    await settle()

    expect(mocks.getCoachChallengeLeaderboard).toHaveBeenCalledWith('ch_1', expect.anything())
    expect(document.body.textContent).toContain('Alice')
    expect(document.body.textContent).toContain('120')
    expect(document.body.textContent).toContain('Bob')
    expect(document.body.textContent).toContain('Treino finalizado')
  })

  it('awards custom points with idempotency and justification', async () => {
    mocks.listCoachChallenges.mockResolvedValue({ challenges: [fakeChallenge], page: { hasMore: false } })
    mocks.getCoachChallengeLeaderboard.mockResolvedValue({
      challenge: { ...fakeChallenge, type: 'custom_points' },
      leaderboard: [],
      activityFeed: [],
    })
    mocks.awardCustomPoints.mockResolvedValueOnce({ adjustment: { id: 'adj_1', points: 15 }, score: 15 })

    await mount(<CoachChallengesView />)

    await act(async () => {
      button('Leaderboard').click()
    })
    await settle()

    await act(async () => {
      button('Award points').click()
    })
    await settle()

    const modal = document.querySelector('#award-points-title')?.closest('.pro-modal-container')
    expect(modal).toBeTruthy()

    await changeInput(input('athleteId', modal), 'ath_1')
    await changeInput(input('reason', modal), 'Bônus por assiduidade e disciplina')

    await act(async () => {
      button('Award points', modal).click()
    })
    await settle()

    expect(mocks.awardCustomPoints).toHaveBeenCalledWith(
      'ch_1',
      expect.objectContaining({
        athleteId: 'ath_1',
        points: 10,
        reason: 'Bônus por assiduidade e disciplina',
      }),
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(/^pts_/),
      })
    )
    expect(mocks.toast).toHaveBeenCalledWith('Points awarded successfully.')
  })

  it('ends an active challenge via lifecycle transition', async () => {
    mocks.listCoachChallenges.mockResolvedValue({ challenges: [fakeChallenge], page: { hasMore: false } })
    mocks.getCoachChallengeLeaderboard.mockResolvedValue({
      challenge: fakeChallenge,
      leaderboard: [],
      activityFeed: [],
    })
    mocks.updateCoachChallenge.mockResolvedValueOnce({ challenge: { ...fakeChallenge, status: 'completed' } })

    await mount(<CoachChallengesView />)

    await act(async () => {
      button('End challenge').click()
    })
    await settle()

    expect(mocks.updateCoachChallenge).toHaveBeenCalledWith('ch_1', { status: 'completed' })
  })
})

describe('CoachGroupProgramsView', () => {
  const fakeProgram = {
    id: 'prg_1',
    groupId: 'grp_1',
    title: 'Programa Força Básica',
    version: 1,
    status: 'draft',
    routine: {
      name: 'Rotina A/B',
      divisions: [
        { id: 'division_1', name: 'A', exercises: [{ id: 'exercise_1_1', name: 'Agachamento', sets: 4, reps: '8-10', load: '100 kg', restSeconds: 90 }] },
        { id: 'division_2', name: 'B', exercises: [{ id: 'exercise_2_1', name: 'Supino Reto', sets: 4, reps: '8-10', load: '80 kg', restSeconds: 90 }] },
      ]
    }
  }

  it('lists collective programs with version badge and routine summary', async () => {
    mocks.listCoachGroupPrograms.mockResolvedValueOnce({ programs: [fakeProgram], page: { hasMore: false } })
    mocks.listCoachGroups.mockResolvedValueOnce({ groups: [{ id: 'grp_1', name: 'Barbell Club' }] })

    await mount(<CoachGroupProgramsView />)

    expect(mocks.listCoachGroupPrograms).toHaveBeenCalled()
    expect(host.textContent).toContain('Programa Força Básica')
    expect(host.textContent).toContain('v1')
    expect(host.textContent).toContain('Barbell Club')
  })

  it('creates a collective program with valid routine format', async () => {
    mocks.listCoachGroupPrograms.mockResolvedValue({ programs: [], page: { hasMore: false } })
    mocks.listCoachGroups.mockResolvedValue({ groups: [{ id: 'grp_1', name: 'Barbell Club' }] })
    mocks.createCoachGroupProgram.mockResolvedValueOnce({ program: fakeProgram })

    await mount(<CoachGroupProgramsView />)

    await act(async () => {
      button('New collective program').click()
    })
    await settle()

    const modal = document.querySelector('#create-program-title')?.closest('.pro-modal-container')
    expect(modal).toBeTruthy()

    await changeInput(input('title', modal), 'Programa Força Básica')
    await changeInput(input('groupId', modal), 'grp_1')

    // Fill exercise names
    const exNameA = input('ex-name-0-0', modal)
    const exNameB = input('ex-name-1-0', modal)
    await changeInput(exNameA, 'Agachamento')
    await changeInput(exNameB, 'Supino Reto')

    await act(async () => {
      button('Save draft', modal).click()
    })
    await settle()

    expect(mocks.createCoachGroupProgram).toHaveBeenCalledWith(expect.objectContaining({
      groupId: 'grp_1',
      title: 'Programa Força Básica',
      routine: expect.objectContaining({
        divisions: expect.arrayContaining([
          expect.objectContaining({ id: 'division_1', exercises: expect.arrayContaining([expect.objectContaining({ name: 'Agachamento' })]) })
        ])
      })
    }))
  })

  it('publishes a draft collective program into an immutable version', async () => {
    mocks.listCoachGroupPrograms.mockResolvedValue({ programs: [fakeProgram], page: { hasMore: false } })
    mocks.publishCoachGroupProgram.mockResolvedValueOnce({ program: { ...fakeProgram, status: 'published' } })

    await mount(<CoachGroupProgramsView />)

    await act(async () => {
      button('Publish version').click()
    })
    await settle()

    const modal = document.querySelector('#publish-confirm-title')?.closest('.pro-modal-container')
    expect(modal).toBeTruthy()

    const publishBtn = button('Publish version', modal)
    await act(async () => {
      publishBtn.click()
    })
    await settle()

    expect(mocks.publishCoachGroupProgram).toHaveBeenCalledWith('prg_1')
    expect(mocks.toast).toHaveBeenCalled()
  })

  it('archives a collective program', async () => {
    mocks.listCoachGroupPrograms.mockResolvedValue({ programs: [{ ...fakeProgram, status: 'published' }], page: { hasMore: false } })
    mocks.archiveCoachGroupProgram.mockResolvedValueOnce({ program: { ...fakeProgram, status: 'archived' } })

    await mount(<CoachGroupProgramsView />)

    await act(async () => {
      button('Archive program').click()
    })
    await settle()

    const modal = document.querySelector('#archive-confirm-title')?.closest('.pro-modal-container')
    expect(modal).toBeTruthy()

    const archiveBtn = button('Archive program', modal)
    await act(async () => {
      archiveBtn.click()
    })
    await settle()

    expect(mocks.archiveCoachGroupProgram).toHaveBeenCalledWith('prg_1')
    expect(mocks.toast).toHaveBeenCalled()
  })
})
