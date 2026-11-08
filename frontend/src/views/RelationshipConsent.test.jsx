// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  user: null,
  calls: [],
  answers: {},
  toast: vi.fn(),
  setUser: vi.fn(),
  pullState: vi.fn(),
  copied: [],
  confirms: [],
}))

vi.mock('../store/useStore.js', () => {
  const snap = () => ({ user: mocks.user, setUser: mocks.setUser, pullState: mocks.pullState })
  const useStore = selector => (selector ? selector(snap()) : snap())
  useStore.getState = snap
  return { useStore }
})

vi.mock('../store/useUI.js', () => {
  const snap = () => ({ toast: mocks.toast })
  const useUI = selector => (selector ? selector(snap()) : snap())
  useUI.getState = snap
  return { useUI }
})

vi.mock('../lib/api.js', () => ({
  api: vi.fn(async (path, opts) => {
    const body = opts?.body ? JSON.parse(opts.body) : null
    mocks.calls.push({ path, method: opts?.method || 'GET', body })
    const answer = mocks.answers[path] ?? mocks.answers[path.split('?')[0]]
    if (answer instanceof Error) throw answer
    return typeof answer === 'function' ? answer(body) : answer ?? {}
  }),
}))

vi.mock('../lib/clipboard.js', () => ({
  copyText: vi.fn(async value => {
    mocks.copied.push(value)
    return true
  }),
}))

vi.mock('../sheets.jsx', () => ({
  confirmSheet: options => mocks.confirms.push(options),
}))

import ProfessionalHub from './ProfessionalHub.jsx'

let host, root

beforeEach(() => {
  Object.assign(mocks, {
    user: null,
    calls: [],
    answers: {},
    toast: vi.fn(),
    setUser: vi.fn(),
    pullState: vi.fn(),
    copied: [],
    confirms: [],
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.querySelectorAll('.ds-modal-backdrop').forEach(el => el.remove())
})

const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })

const mount = async entry => {
  act(() => root.render(<MemoryRouter initialEntries={[entry]}><ProfessionalHub /></MemoryRouter>))
  await settle()
}

const button = (label, container = host) => [...container.querySelectorAll('button')].find(item => item.textContent.trim().includes(label))
const allButtons = (label, container = host) => [...container.querySelectorAll('button')].filter(item => item.textContent.trim().includes(label))
const card = label => [...host.querySelectorAll('.pro-link')].find(item => item.textContent.includes(label))

const type = async (input, value) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('PR Fit UX Etapa 4 (Checkpoint 4.1) - Invitation, Roster & Consent Flow', () => {
  describe('Coach / Professional Flow', () => {
    beforeEach(() => {
      mocks.user = {
        id: 'u_coach_1',
        name: 'Profissional Carlos',
        admin: false,
        profile: { kind: 'coach', coachSpecialties: ['training', 'nutrition'] },
        capabilities: ['relationships:invite', 'relationships:list', 'relationships:suspend', 'relationships:end'],
      }
    })

    it('displays clear scope descriptions for training and nutrition', async () => {
      mocks.answers['/api/coach/athletes'] = { links: [] }
      await mount('/professionals')

      expect(host.textContent).toContain('Prescribe workouts, routines, sets, reps and monitor training habits.')

      // Toggle nutrition scope on
      const inviteSection = host.querySelector('.pro-invite')
      const nutBtn = button('Nutrition', inviteSection)
      expect(nutBtn).toBeDefined()
      await act(async () => { nutBtn.click() })
      await settle()

      expect(host.textContent).toContain('Prescribe meal plans, caloric and macronutrient targets, and track meal adherence.')
    })

    it('generates an invitation and provides direct copy buttons for both link and code with visual and live feedback', async () => {
      mocks.answers['/api/coach/athletes'] = { links: [] }
      mocks.answers['/api/coach/invites'] = {
        invite: {
          id: 'cai_123',
          linkId: 'cal_123',
          token: 'TOKEN-ABC-123',
          scopes: ['training'],
          expiresAt: '2026-11-15T12:00:00.000Z',
        },
      }

      await mount('/professionals')

      await act(async () => { button('Create invitation').click() })
      await settle()

      // Both code and link copy buttons must exist
      expect(host.textContent).toContain('TOKEN-ABC-123')
      const copyCodeBtn = button('Copy invitation')
      const copyLinkBtn = button('Copy link')
      expect(copyCodeBtn).toBeDefined()
      expect(copyLinkBtn).toBeDefined()

      // Copy code
      await act(async () => { copyCodeBtn.click() })
      await settle()
      expect(mocks.copied).toContain('TOKEN-ABC-123')
      expect(button('Code copied!')).toBeDefined()
      expect(mocks.toast).toHaveBeenCalledWith('Invitation copied.')

      // Copy link
      await act(async () => { copyLinkBtn.click() })
      await settle()
      expect(mocks.copied.some(val => val.includes('TOKEN-ABC-123') && val.includes('/professionals?invite='))).toBe(true)
      expect(button('Link copied!')).toBeDefined()
      expect(mocks.toast).toHaveBeenCalledWith('Invitation link copied.')

      // Verify accessible live region announcement
      const liveRegion = host.querySelector('[role="status"].sr-only')
      expect(liveRegion).toBeDefined()
      expect(liveRegion.textContent).toBeTruthy()
    })

    it('distinguishes between active, pending and suspended relationships with Design System Badges', async () => {
      mocks.answers['/api/coach/athletes'] = {
        links: [
          { id: 'cal_active', status: 'active', scopes: ['training'], athlete: { id: 'u_ath_1', name: 'Atleta Ativo' } },
          { id: 'cal_pending', status: 'pending', scopes: ['training', 'nutrition'], athlete: null, expiresAt: '2026-11-20T00:00:00.000Z' },
          { id: 'cal_suspended', status: 'suspended', scopes: ['nutrition'], athlete: { id: 'u_ath_2', name: 'Atleta Suspenso' } },
        ],
      }

      await mount('/professionals')

      const badges = [...host.querySelectorAll('.ds-badge')]
      expect(badges.some(b => b.textContent === 'Active' && b.classList.contains('success'))).toBe(true)
      expect(badges.some(b => b.textContent === 'Pending' && b.classList.contains('warning'))).toBe(true)
      expect(badges.some(b => b.textContent === 'Suspended' && b.classList.contains('danger'))).toBe(true)
    })

    it('filters athlete roster by status chips', async () => {
      mocks.answers['/api/coach/athletes'] = {
        links: [
          { id: 'cal_1', status: 'active', scopes: ['training'], athlete: { id: 'u_1', name: 'Alice' } },
          { id: 'cal_2', status: 'pending', scopes: ['training'], athlete: null },
          { id: 'cal_3', status: 'suspended', scopes: ['training'], athlete: { id: 'u_3', name: 'Bob' } },
        ],
      }

      await mount('/professionals')

      expect(host.textContent).toContain('Alice')
      expect(host.textContent).toContain('Bob')
      expect(host.textContent).toContain('Invitation pending')

      // Filter by Active
      const activeFilter = button('Active (1)')
      expect(activeFilter).toBeDefined()
      await act(async () => { activeFilter.click() })
      await settle()

      expect(host.textContent).toContain('Alice')
      expect(host.textContent).not.toContain('Bob')
      expect(host.textContent).not.toContain('Waiting for athlete to accept invitation.')

      // Filter by Pending
      const pendingFilter = button('Pending (1)')
      await act(async () => { pendingFilter.click() })
      await settle()

      expect(host.textContent).not.toContain('Alice')
      expect(host.textContent).toContain('Invitation pending')

      // Reset to All
      const allFilter = button('All athletes (3)')
      await act(async () => { allFilter.click() })
      await settle()
      expect(host.textContent).toContain('Alice')
      expect(host.textContent).toContain('Bob')
    })

    it('suspends an active relationship using the accessible confirmation Modal', async () => {
      const link = { id: 'cal_active', status: 'active', scopes: ['training'], athlete: { id: 'u_1', name: 'Fernanda' } }
      mocks.answers['/api/coach/athletes'] = { links: [link] }
      mocks.answers['/api/coach/links/status'] = { link: { ...link, status: 'suspended' } }

      await mount('/professionals')

      const suspendBtn = button('Suspend')
      expect(suspendBtn).toBeDefined()
      await act(async () => { suspendBtn.click() })
      await settle()

      // Accessible modal dialog must open in the DOM
      const modal = document.querySelector('#coach-relationship-confirm-title')?.closest('.ds-modal')
      expect(modal).toBeTruthy()
      expect(modal.textContent).toContain('Suspend this relationship?')
      expect(modal.textContent).toContain('Professional access is blocked until a future reactivation flow.')

      // Confirm inside modal
      const modalConfirmBtn = button('Suspend', modal)
      await act(async () => { modalConfirmBtn.click() })
      await settle()

      expect(mocks.calls).toContainEqual({
        path: '/api/coach/links/status',
        method: 'POST',
        body: { linkId: 'cal_active', status: 'suspended' },
      })
      expect(mocks.toast).toHaveBeenCalledWith('Relationship suspended.')
    })

    it('ends an active relationship with proportional destructive risk confirmation in Modal', async () => {
      const link = { id: 'cal_active', status: 'active', scopes: ['training'], athlete: { id: 'u_1', name: 'Fernanda' } }
      mocks.answers['/api/coach/athletes'] = { links: [link] }
      mocks.answers['/api/coach/links/status'] = { link: { ...link, status: 'ended' } }

      await mount('/professionals')

      const endBtn = button('End relationship')
      expect(endBtn).toBeDefined()
      await act(async () => { endBtn.click() })
      await settle()

      const modal = document.querySelector('#coach-relationship-confirm-title')?.closest('.ds-modal')
      expect(modal).toBeTruthy()
      expect(modal.textContent).toContain('End this relationship?')
      expect(modal.textContent).toContain('This action is irreversible. The athlete retains all workouts, nutrition and progress data.')

      // Cancel keeps the relationship
      const cancelBtn = button('Cancel', modal)
      await act(async () => { cancelBtn.click() })
      await settle()
      expect(document.querySelector('.ds-modal')).toBeNull()
      expect(mocks.calls.filter(c => c.path === '/api/coach/links/status')).toHaveLength(0)

      // Reopen and confirm
      await act(async () => { button('End relationship').click() })
      await settle()
      const reopenedModal = document.querySelector('#coach-relationship-confirm-title')?.closest('.ds-modal')
      const confirmEndBtn = button('End relationship', reopenedModal)
      await act(async () => { confirmEndBtn.click() })
      await settle()

      expect(mocks.calls).toContainEqual({
        path: '/api/coach/links/status',
        method: 'POST',
        body: { linkId: 'cal_active', status: 'ended' },
      })
      expect(mocks.toast).toHaveBeenCalledWith('Relationship ended.')
    })

    it('cancels a pending invitation with dedicated confirmation dialogue', async () => {
      const pendingLink = { id: 'cal_pend', status: 'pending', scopes: ['training'], athlete: null, expiresAt: '2026-11-20T00:00:00.000Z' }
      mocks.answers['/api/coach/athletes'] = { links: [pendingLink] }
      mocks.answers['/api/coach/links/status'] = { link: { ...pendingLink, status: 'ended' } }

      await mount('/professionals')

      const cancelInviteBtn = button('Cancel invitation')
      expect(cancelInviteBtn).toBeDefined()
      await act(async () => { cancelInviteBtn.click() })
      await settle()

      const modal = document.querySelector('#coach-relationship-confirm-title')?.closest('.ds-modal')
      expect(modal).toBeTruthy()
      expect(modal.textContent).toContain('Cancel pending invitation?')
      expect(modal.textContent).toContain('The generated invitation code will be invalidated and the athlete will no longer be able to accept it.')

      const confirmBtn = button('Cancel invitation', modal)
      await act(async () => { confirmBtn.click() })
      await settle()

      expect(mocks.calls).toContainEqual({
        path: '/api/coach/links/status',
        method: 'POST',
        body: { linkId: 'cal_pend', status: 'ended' },
      })
      expect(mocks.toast).toHaveBeenCalledWith('Invitation cancelled.')
    })
  })

  describe('Athlete View & Consent Flow', () => {
    beforeEach(() => {
      mocks.user = {
        id: 'u_athlete_1',
        name: 'Roberta Silva',
        admin: false,
        profile: { kind: 'athlete' },
      }
    })

    it('shows a contextual review screen when receiving an invitation with coach info and scopes in the URL', async () => {
      mocks.answers['/api/athlete/coaches'] = { links: [] }

      await mount('/professionals?invite=INVITE-789&coach=Dr.+Lucas&scopes=training,nutrition')

      expect(host.textContent).toContain('Dr. Lucas')
      expect(host.textContent).toContain('Workouts & routines')
      expect(host.textContent).toContain('Nutrition & meal plans')
      expect(host.textContent).toContain('Your account credentials, password, and personal email are never shared.')

      const input = host.querySelector('input[name="inviteToken"]')
      expect(input.value).toBe('INVITE-789')
      expect(button('Accept invitation')).toBeDefined()
      expect(button('Decline invitation')).toBeDefined()
    })

    it('declines an invitation cleanly, clearing the code and announcing without sharing data', async () => {
      mocks.answers['/api/athlete/coaches'] = { links: [] }

      await mount('/professionals?invite=INVITE-789')

      const declineBtn = button('Decline invitation')
      expect(declineBtn).toBeDefined()

      await act(async () => { declineBtn.click() })
      await settle()

      const input = host.querySelector('input[name="inviteToken"]')
      expect(input.value).toBe('')
      expect(mocks.calls.some(c => c.path === '/api/coach/invites/accept')).toBe(false)
      expect(mocks.toast).toHaveBeenCalledWith('Invitation declined. No data was shared.')
    })

    it('displays descriptive PT-BR error and accessible alert when invite acceptance fails', async () => {
      mocks.answers['/api/athlete/coaches'] = { links: [] }
      mocks.answers['/api/coach/invites/accept'] = Object.assign(new Error('Invalid invite'), {
        data: { code: 'invite_expired' },
        status: 410,
      })

      await mount('/professionals?invite=EXPIRED-TOKEN')

      await act(async () => { button('Accept invitation').click() })
      await settle()

      const alert = host.querySelector('.ds-alert[role="alert"]')
      expect(alert).toBeTruthy()
      expect(alert.textContent).toContain('This invitation has expired.')
      expect(mocks.toast).toHaveBeenCalledWith('This invitation has expired.')
    })

    it('ends a linked professional relationship using the accessible confirmation Modal', async () => {
      const link = {
        id: 'cal_link_1',
        status: 'active',
        scopes: ['training'],
        coach: { id: 'u_coach_9', name: 'Treinador Marcos' },
      }
      mocks.answers['/api/athlete/coaches'] = { links: [link] }
      mocks.answers['/api/coach/links/status'] = { link: { ...link, status: 'ended' } }

      await mount('/professionals')

      const endBtn = button('End relationship')
      expect(endBtn).toBeDefined()

      await act(async () => { endBtn.click() })
      await settle()

      const modal = document.querySelector('#athlete-relationship-confirm-title')?.closest('.ds-modal')
      expect(modal).toBeTruthy()
      expect(modal.textContent).toContain('End this relationship?')
      expect(modal.textContent).toContain('The professional loses future access. Your training data stays with you.')

      const confirmBtn = button('End relationship', modal)
      await act(async () => { confirmBtn.click() })
      await settle()

      expect(mocks.calls).toContainEqual({
        path: '/api/coach/links/status',
        method: 'POST',
        body: { linkId: 'cal_link_1', status: 'ended' },
      })
      expect(mocks.toast).toHaveBeenCalledWith('Relationship ended.')
    })
  })
})
