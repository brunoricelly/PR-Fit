// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({ api: {}, zone: { value: 'America/Sao_Paulo', fallback: false } }))
vi.mock('../lib/communication-api.js', () => ({ communicationApi: mocks.api, browserTimeZone: () => mocks.zone }))

import { AthleteHabitsDashboard, CoachHabitsPanel, CommunicationPanel, formatCivilDay, useCommunicationInbox } from './CommunicationHabits.jsx'

let host, root
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
const click = async element => { await act(async () => { element.click() }); await settle() }
const setValue = async (element, value) => {
  await act(async () => {
    const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, value)
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
}
const button = (label, scope = host) => [...scope.querySelectorAll('button')].find(item => item.textContent.trim() === label)
const render = async element => { act(() => root.render(element)); await settle() }

beforeEach(() => {
  Object.assign(mocks.api, {
    inbox: vi.fn(), conversation: vi.fn(), sendMessage: vi.fn(), readMessage: vi.fn(), readThrough: vi.fn(),
    coachHabits: vi.fn(), createHabit: vi.fn(), updateHabit: vi.fn(), deleteHabit: vi.fn(), athleteHabits: vi.fn(),
    checkin: vi.fn(), checkins: vi.fn(), summary: vi.fn(),
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })

const activeLink = {
  id: 'cal_1', status: 'active', scopes: ['training', 'nutrition'],
  athlete: { id: 'athlete_1', name: 'Ana' }, coach: { id: 'coach_1', name: 'Carla' },
}
const page = (hasMore = false, nextCursor = null) => ({ limit: 50, hasMore, nextCursor })

function summary(percent, streak = 2) {
  return { adherencePercent: percent, completedDays: 2, scheduledDays: 3, habits: [{ habitId: 'hab_1', title: 'Água', currentStreak: streak, longestStreakInPeriod: streak + 1 }] }
}

function InboxHarness() {
  const inbox = useCommunicationInbox('athlete_1')
  return <div><span data-count={inbox.conversations.length}>{inbox.byLink.get('cal_1')?.lastMessage?.content || ''}</span>
    <ol>{inbox.conversations.map(item => <li key={item.linkId} data-link={item.linkId}>{item.lastMessage?.content}</li>)}</ol>
    {inbox.error && <button onClick={inbox.retry}>Retry inbox</button>}
    {inbox.page?.hasMore && !inbox.error && <button disabled={inbox.loading} onClick={inbox.loadMore}>Load more inbox</button>}</div>
}

describe('civil dates', () => {
  it.each(['Pacific/Kiritimati', 'America/Sao_Paulo', 'Asia/Tokyo'])('keeps 2026-11-07 on 07/11 in %s', zone => {
    const previous = process.env.TZ
    process.env.TZ = zone
    expect(formatCivilDay('2026-11-07', 'pt-BR')).toBe('07/11/2026')
    if (previous === undefined) delete process.env.TZ
    else process.env.TZ = previous
  })
})

describe('communication inbox', () => {
  it('loads the backend summary once and exposes unread, last-message and status data', async () => {
    mocks.api.inbox.mockResolvedValue({ conversations: [{ linkId: 'cal_1', unreadCount: 3, status: 'active', lastMessageAt: 20, lastMessage: { content: 'Resumo' } }] })
    await render(<InboxHarness />)
    expect(mocks.api.inbox).toHaveBeenCalledTimes(1)
    expect(host.querySelector('[data-count]').dataset.count).toBe('1')
    expect(host.textContent).toContain('Resumo')
  })

  it('offers a retry after an inbox error without exposing server text', async () => {
    mocks.api.inbox.mockRejectedValueOnce(new Error('raw server failure')).mockResolvedValueOnce({ conversations: [] })
    await render(<InboxHarness />)
    expect(button('Retry inbox')).toBeDefined()
    expect(host.textContent).not.toContain('raw server failure')
    await click(button('Retry inbox'))
    expect(mocks.api.inbox).toHaveBeenCalledTimes(2)
  })

  it('paginates, deduplicates and keeps a stable newest-first order', async () => {
    mocks.api.inbox
      .mockResolvedValueOnce({ conversations: [
        { linkId: 'cal_1', lastMessageAt: 30, lastMessage: { content: 'Primeira' } },
        { linkId: 'cal_2', lastMessageAt: 20, lastMessage: { content: 'Duplicada' } },
      ], page: page(true, 'next') })
      .mockResolvedValueOnce({ conversations: [
        { linkId: 'cal_2', lastMessageAt: 20, lastMessage: { content: 'Atualizada' } },
        { linkId: 'cal_3', lastMessageAt: 20, lastMessage: { content: 'Terceira' } },
      ], page: page() })
    await render(<InboxHarness />)
    await click(button('Load more inbox'))
    expect(mocks.api.inbox).toHaveBeenLastCalledWith({ cursor: 'next' })
    expect(host.querySelector('[data-count]').dataset.count).toBe('3')
    expect([...host.querySelectorAll('[data-link]')].map(item => item.dataset.link)).toEqual(['cal_1', 'cal_3', 'cal_2'])
    expect(host.querySelectorAll('[data-link="cal_2"]')).toHaveLength(1)
    expect(host.textContent).toContain('Atualizada')
  })

  it('preserves loaded inbox rows when a later page fails and retries that cursor', async () => {
    mocks.api.inbox
      .mockResolvedValueOnce({ conversations: [{ linkId: 'cal_1', lastMessageAt: 30, lastMessage: { content: 'Mantida' } }], page: page(true, 'next') })
      .mockRejectedValueOnce(new Error('raw page failure'))
      .mockResolvedValueOnce({ conversations: [{ linkId: 'cal_2', lastMessageAt: 10, lastMessage: { content: 'Depois' } }], page: page() })
    await render(<InboxHarness />)
    await click(button('Load more inbox'))
    expect(host.textContent).toContain('Mantida')
    expect(host.textContent).not.toContain('raw page failure')
    await click(button('Retry inbox'))
    expect(mocks.api.inbox).toHaveBeenLastCalledWith({ cursor: 'next' })
    expect(host.querySelector('[data-count]').dataset.count).toBe('2')
  })
})

describe('CommunicationPanel', () => {
  it('distinguishes an initial failure from an empty conversation and retries successfully', async () => {
    mocks.api.conversation.mockRejectedValueOnce(new Error('raw conversation failure')).mockResolvedValueOnce({ messages: [], page: page() })
    await render(<CommunicationPanel link={activeLink} side="athlete" actorId="athlete_1" />)
    await click(host.querySelector('.pro-comm-toggle'))
    expect(host.textContent).toContain('Could not load this conversation.')
    expect(host.querySelector('.empty-state')).toBeNull()
    expect(host.textContent).not.toContain('raw conversation failure')
    await click(button('Try again'))
    expect(host.querySelector('.empty-state')).not.toBeNull()
  })

  it('loads, paginates, marks unread through, sends scoped text safely, and blocks concurrent sends', async () => {
    const unsafe = '<img src=x onerror=alert(1)>'
    mocks.api.conversation
      .mockResolvedValueOnce({ messages: [{ id: 'm2', linkId: 'cal_1', senderId: 'coach_1', recipientId: 'athlete_1', content: unsafe, category: 'workout_feedback', createdAt: 20, readAt: null }], page: page(true, 'older') })
      .mockResolvedValueOnce({ messages: [{ id: 'm1', linkId: 'cal_1', senderId: 'athlete_1', recipientId: 'coach_1', content: 'Anterior', category: 'general', createdAt: 10, readAt: 11 }], page: page() })
    mocks.api.readThrough.mockResolvedValue({ readCount: 1 })
    const sending = deferred()
    mocks.api.sendMessage.mockReturnValue(sending.promise)
    const update = vi.fn()
    await render(<CommunicationPanel link={activeLink} side="athlete" actorId="athlete_1" conversation={{ unreadCount: 1, lastMessage: { content: unsafe }, lastMessageAt: 20 }} onConversationChange={update} />)

    await click(host.querySelector('.pro-comm-toggle'))
    expect(mocks.api.conversation).toHaveBeenCalledWith(expect.objectContaining({ side: 'athlete', counterpartId: 'coach_1', linkId: 'cal_1' }))
    expect(mocks.api.readThrough).toHaveBeenCalledWith('cal_1', 'm2')
    expect(host.textContent).toContain(unsafe)
    expect(host.querySelector('img')).toBeNull()
    expect(host.querySelector('[aria-label="Conversation history"]')).not.toBeNull()

    await click(button('Load earlier messages'))
    expect(mocks.api.conversation).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'older' }))
    expect(host.textContent).toContain('Anterior')

    const category = host.querySelector('.pro-message-form select')
    expect([...category.options].map(option => option.value)).toEqual(['general', 'workout_feedback', 'nutrition_feedback'])
    await setValue(category, 'nutrition_feedback')
    const textarea = host.querySelector('.pro-message-form textarea')
    await setValue(textarea, 'Ótimo registro')
    await act(async () => { button('Send message').click(); button('Send message').click() })
    expect(mocks.api.sendMessage).toHaveBeenCalledTimes(1)
    expect(button('Sending…').disabled).toBe(true)
    sending.resolve({ message: { id: 'm3', linkId: 'cal_1', senderId: 'athlete_1', recipientId: 'coach_1', content: 'Ótimo registro', category: 'nutrition_feedback', createdAt: 30, readAt: null } })
    await settle()
    expect(mocks.api.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ category: 'nutrition_feedback', content: 'Ótimo registro' }))
    expect(textarea.value).toBe('')
    expect(host.querySelector('[role="status"]').textContent).toContain('Message sent.')
  })

  it('keeps prior messages and offers retry when loading an older page fails', async () => {
    mocks.api.conversation
      .mockResolvedValueOnce({ messages: [{ id: 'm2', senderId: 'coach_1', recipientId: 'athlete_1', content: 'Mantida', category: 'general', createdAt: 20, readAt: 1 }], page: page(true, 'older') })
      .mockRejectedValueOnce(new Error('raw pagination failure'))
      .mockResolvedValueOnce({ messages: [{ id: 'm1', senderId: 'athlete_1', recipientId: 'coach_1', content: 'Anterior', category: 'general', createdAt: 10, readAt: 1 }], page: page() })
    await render(<CommunicationPanel link={activeLink} side="athlete" actorId="athlete_1" />)
    await click(host.querySelector('.pro-comm-toggle'))
    await click(button('Load earlier messages'))
    expect(host.textContent).toContain('Mantida')
    expect(host.textContent).toContain('Could not refresh this conversation.')
    expect(host.textContent).not.toContain('raw pagination failure')
    await click(button('Try again'))
    expect(host.textContent).toContain('Anterior')
  })

  it('preserves the draft on a safe error and keeps ended relationships read-only', async () => {
    mocks.api.conversation.mockResolvedValue({ messages: [], page: page(), relationship: { readOnly: false } })
    mocks.api.sendMessage.mockRejectedValue(Object.assign(new Error('internal database path'), { status: 503, code: 'storage_unavailable' }))
    await render(<CommunicationPanel link={{ ...activeLink, scopes: ['training'] }} side="coach" actorId="coach_1" />)
    await click(host.querySelector('.pro-comm-toggle'))
    expect([...host.querySelectorAll('.pro-message-form option')].map(option => option.value)).toEqual(['general', 'workout_feedback'])
    const textarea = host.querySelector('textarea')
    await setValue(textarea, 'Rascunho preservado')
    await click(button('Send message'))
    expect(textarea.value).toBe('Rascunho preservado')
    expect(host.textContent).not.toContain('internal database path')
    expect(host.querySelector('[role="alert"]')).not.toBeNull()

    await render(<CommunicationPanel key="ended" link={{ ...activeLink, status: 'ended' }} side="coach" actorId="coach_1" />)
    await click(host.querySelector('.pro-comm-toggle'))
    expect(host.textContent).toContain('read-only')
    expect(host.querySelector('.pro-message-form')).toBeNull()
  })
})

describe('CoachHabitsPanel', () => {
  it('shows independent initial errors without empty states and retries successfully', async () => {
    mocks.api.coachHabits.mockRejectedValueOnce(new Error('raw habits failure')).mockResolvedValueOnce({ habits: [] })
    mocks.api.summary.mockRejectedValueOnce(new Error('raw summary failure')).mockResolvedValueOnce({ summary: summary(40) })
    mocks.api.checkins.mockRejectedValueOnce(new Error('raw history failure')).mockResolvedValueOnce({ checkins: [], page: page() })
    await render(<CoachHabitsPanel link={activeLink} />)
    await click(host.querySelector('.pro-comm-toggle'))
    expect(host.textContent).toContain('Could not load habits.')
    expect(host.textContent).toContain('Could not load adherence summary.')
    expect(host.textContent).toContain('Could not load check-in history.')
    expect(host.textContent).not.toContain('No habits yet')
    expect(host.textContent).not.toContain('No check-ins in this period.')
    expect(host.textContent).not.toContain('raw habits failure')
    await click(button('Try again'))
    expect(host.textContent).toContain('40%')
    expect(host.textContent).toContain('No habits yet')
    expect(host.textContent).toContain('No check-ins in this period.')
  })

  it('creates, edits, archives, reactivates and deletes with labels, history, streaks and focus', async () => {
    let habits = [{ id: 'hab_1', title: 'Água', description: 'Meta diária', targetValue: 2000, unit: 'ml', frequency: 'daily', status: 'active' }]
    mocks.api.coachHabits.mockImplementation(async () => ({ habits }))
    mocks.api.summary.mockResolvedValue({ summary: summary(66.7) })
    mocks.api.checkins.mockResolvedValue({ checkins: [{ id: 'chk_1', habitId: 'hab_1', date: '2026-11-06', value: 2000, completed: true, notes: 'Tudo certo' }], page: page() })
    mocks.api.createHabit.mockImplementation(async (_athlete, input) => { habits = [...habits, { id: 'hab_2', ...input, status: 'active' }]; return { habit: habits[1] } })
    mocks.api.updateHabit.mockImplementation(async (_athlete, id, patch) => { habits = habits.map(item => item.id === id ? { ...item, ...patch } : item); return { habit: habits.find(item => item.id === id) } })
    mocks.api.deleteHabit.mockImplementation(async (_athlete, id) => { habits = habits.filter(item => item.id !== id); return { deleted: true } })
    await render(<CoachHabitsPanel link={activeLink} timeZone="America/Sao_Paulo" />)
    await click(host.querySelector('.pro-comm-toggle'))

    expect(host.textContent).toContain('66.7%')
    expect(host.textContent).toContain('Current streak: 2')
    expect(host.textContent).toContain('Longest streak in selected period: 3')
    expect(host.textContent).toContain('Tudo certo')
    expect(host.textContent).toContain('Timezone: America/Sao_Paulo')
    expect(host.querySelector('label[for="create-cal_1-title"]')).not.toBeNull()

    await setValue(host.querySelector('#create-cal_1-title'), 'Passos')
    await setValue(host.querySelector('#create-cal_1-target'), '8000')
    await setValue(host.querySelector('#create-cal_1-unit'), 'passos')
    await click(button('Create habit'))
    expect(mocks.api.createHabit).toHaveBeenCalledWith('athlete_1', expect.objectContaining({ title: 'Passos', targetValue: 8000, unit: 'passos' }))

    const agua = [...host.querySelectorAll('.pro-habit')].find(item => item.textContent.includes('Água'))
    await click(button('Edit', agua))
    await setValue(agua.querySelector('input[id^="edit-"][id$="-title"]'), 'Hidratação')
    await click(button('Save changes', agua))
    expect(mocks.api.updateHabit).toHaveBeenCalledWith('athlete_1', 'hab_1', expect.objectContaining({ title: 'Hidratação' }))

    let edited = [...host.querySelectorAll('.pro-habit')].find(item => item.textContent.includes('Hidratação'))
    await click(button('Archive', edited))
    expect(mocks.api.updateHabit).toHaveBeenCalledWith('athlete_1', 'hab_1', { status: 'archived' })
    edited = [...host.querySelectorAll('.pro-habit')].find(item => item.textContent.includes('Hidratação'))
    await click(button('Reactivate', edited))
    edited = [...host.querySelectorAll('.pro-habit')].find(item => item.textContent.includes('Hidratação'))
    await click(button('Delete', edited))
    expect(document.activeElement.textContent).toBe('Confirm delete')
    await click(button('Confirm delete', edited))
    expect(mocks.api.deleteHabit).toHaveBeenCalledWith('athlete_1', 'hab_1')
  })

  it('ignores stale period responses and renders suspended history without mutation controls', async () => {
    mocks.api.coachHabits.mockResolvedValue({ habits: [{ id: 'hab_1', title: 'Água', targetValue: 1, unit: 'vezes', frequency: 'daily', status: 'active' }] })
    mocks.api.checkins.mockResolvedValue({ checkins: [], page: page() })
    const seven = deferred()
    mocks.api.summary.mockImplementation(({ period }) => period === 7 ? seven.promise : Promise.resolve({ summary: summary(period) }))
    await render(<CoachHabitsPanel link={activeLink} />)
    await click(host.querySelector('.pro-comm-toggle'))
    const period = host.querySelector('.pro-period-row select')
    await setValue(period, '7')
    await setValue(period, '90')
    await settle()
    expect(host.textContent).toContain('90%')
    seven.resolve({ summary: summary(7) })
    await settle()
    expect(host.textContent).toContain('90%')
    expect(host.textContent).not.toContain('7%')

    await render(<CoachHabitsPanel key="suspended" link={{ ...activeLink, status: 'suspended' }} />)
    await click(host.querySelector('.pro-comm-toggle'))
    expect(host.textContent).toContain('read-only')
    expect(button('Create habit')).toBeUndefined()
    expect(button('Archive')).toBeUndefined()
  })

  it('keeps previous habits, summary and history when a refresh fails', async () => {
    mocks.api.coachHabits.mockResolvedValue({ habits: [{ id: 'hab_1', title: 'Água', targetValue: 1, unit: 'vezes', frequency: 'daily', status: 'active' }] })
    mocks.api.summary.mockResolvedValueOnce({ summary: summary(60) }).mockRejectedValueOnce(new Error('raw summary refresh')).mockResolvedValueOnce({ summary: summary(70) })
    mocks.api.checkins.mockResolvedValueOnce({ checkins: [{ id: 'chk_1', habitId: 'hab_1', date: '2026-11-07', value: 1, completed: true, notes: 'Mantido' }], page: page() })
      .mockRejectedValueOnce(new Error('raw history refresh')).mockResolvedValueOnce({ checkins: [{ id: 'chk_2', habitId: 'hab_1', date: '2026-11-07', value: 2, completed: true, notes: 'Novo' }], page: page() })
    await render(<CoachHabitsPanel link={activeLink} />)
    await click(host.querySelector('.pro-comm-toggle'))
    await setValue(host.querySelector('.pro-period-row select'), '7')
    await settle()
    expect(host.textContent).toContain('Água')
    expect(host.textContent).toContain('60%')
    expect(host.textContent).toContain('Mantido')
    expect(host.textContent).toContain('previous summary is still shown')
    expect(host.textContent).toContain('previous check-ins are still shown')
    expect(host.textContent).not.toContain('No check-ins in this period.')
    await click(button('Try again'))
    expect(host.textContent).toContain('70%')
    expect(host.textContent).toContain('Novo')
  })
})

describe('AthleteHabitsDashboard', () => {
  it('does not render an empty habit state on initial failure and retries successfully', async () => {
    mocks.api.athleteHabits.mockRejectedValueOnce(new Error('raw athlete habits failure')).mockResolvedValueOnce({ date: '2026-11-07', habits: [] })
    mocks.api.summary.mockResolvedValue({ summary: summary(50) })
    mocks.api.checkins.mockResolvedValue({ checkins: [], page: page() })
    await render(<AthleteHabitsDashboard links={[activeLink]} />)
    expect(host.textContent).toContain('Could not load habits.')
    expect(host.textContent).not.toContain('No habits for today')
    expect(host.textContent).not.toContain('raw athlete habits failure')
    await click(button('Try again'))
    expect(host.textContent).toContain('No habits for today')
  })

  it('uses an explicit IANA timezone, saves idempotent-shaped check-ins once, and shows own history', async () => {
    const links = [activeLink, { ...activeLink, id: 'cal_old', status: 'ended', coach: { id: 'coach_2', name: 'Bia' } }]
    mocks.api.athleteHabits.mockResolvedValue({ date: '2026-11-07', timezone: 'America/Sao_Paulo', habits: [
      { id: 'hab_1', title: 'Água', description: '', targetValue: 2000, unit: 'ml', frequency: 'daily', checkin: null, relationship: { linkId: 'cal_1', status: 'active', readOnly: false } },
      { id: 'hab_2', title: 'Sono', description: '', targetValue: 8, unit: 'horas', frequency: 'daily', checkin: null, relationship: { linkId: 'cal_old', status: 'ended', readOnly: true } },
    ] })
    mocks.api.summary.mockResolvedValueOnce({ summary: summary(50, 4) }).mockResolvedValueOnce({ summary: summary(75, 6) })
    mocks.api.checkins.mockResolvedValueOnce({ checkins: [{ id: 'chk_1', habitId: 'hab_1', date: '2026-11-06', value: 1800, completed: false, notes: 'Quase' }], page: page() })
      .mockResolvedValueOnce({ checkins: [{ id: 'chk_new', habitId: 'hab_1', date: '2026-11-07', value: 2000, completed: false, notes: 'Atualizado' }], page: page() })
    const saved = deferred()
    mocks.api.checkin.mockReturnValue(saved.promise)
    await render(<AthleteHabitsDashboard links={links} />)

    expect(host.textContent).toContain('Today in America/Sao_Paulo')
    expect(host.textContent).toContain('browser IANA timezone')
    expect(mocks.api.athleteHabits).toHaveBeenCalledWith('America/Sao_Paulo')
    expect(host.textContent).toContain('Quase')
    expect(host.textContent).toContain('Current streak: 4')
    expect([...host.querySelectorAll('.pro-athlete-habit')].find(item => item.textContent.includes('Sono')).querySelector('form')).toBeNull()

    const agua = [...host.querySelectorAll('.pro-athlete-habit')].find(item => item.textContent.includes('Água'))
    await setValue(agua.querySelector('input[type="number"]'), '2000')
    await act(async () => { button('Save check-in', agua).click(); button('Save check-in', agua).click() })
    expect(mocks.api.checkin).toHaveBeenCalledTimes(1)
    expect(mocks.api.checkin).toHaveBeenCalledWith('America/Sao_Paulo', { habitId: 'hab_1', date: '2026-11-07', value: 2000, completed: false, notes: '' })
    saved.resolve({ checkin: { id: 'chk_new', habitId: 'hab_1', date: '2026-11-07', value: 2000, completed: false, notes: '', updatedAt: 1 } })
    await settle()
    expect(host.textContent).toContain('Check-in saved.')
    expect(host.textContent).toContain('75%')
    expect(host.textContent).toContain('Current streak: 6')
    expect(host.textContent).toContain('Atualizado')
    expect(host.querySelectorAll('[role="alert"]').length).toBe(0)
  })

  it('keeps the saved check-in and previous metrics when projection refresh fails, then retries', async () => {
    mocks.api.athleteHabits.mockResolvedValue({ date: '2026-11-07', habits: [
      { id: 'hab_1', title: 'Água', description: '', targetValue: 1, unit: 'vezes', frequency: 'daily', checkin: null, relationship: { linkId: 'cal_1', status: 'active', readOnly: false } },
    ] })
    mocks.api.summary.mockResolvedValueOnce({ summary: summary(50, 4) }).mockRejectedValueOnce(new Error('raw summary refresh')).mockResolvedValueOnce({ summary: summary(80, 7) })
    mocks.api.checkins.mockResolvedValueOnce({ checkins: [{ id: 'chk_old', habitId: 'hab_1', date: '2026-11-06', value: 1, completed: true, notes: 'Anterior' }], page: page() })
      .mockRejectedValueOnce(new Error('raw history refresh')).mockResolvedValueOnce({ checkins: [{ id: 'chk_new', habitId: 'hab_1', date: '2026-11-07', value: 2, completed: true, notes: 'Confirmado' }], page: page() })
    mocks.api.checkin.mockResolvedValue({ checkin: { id: 'chk_new', habitId: 'hab_1', date: '2026-11-07', value: 2, completed: true, notes: 'Salvo', updatedAt: 1 } })
    await render(<AthleteHabitsDashboard links={[activeLink]} />)
    const habit = host.querySelector('.pro-athlete-habit')
    await setValue(habit.querySelector('input[type="number"]'), '2')
    await click(habit.querySelector('input[type="checkbox"]'))
    await setValue(habit.querySelector('textarea'), 'Salvo')
    await click(button('Save check-in', habit))
    expect(host.textContent).toContain('Check-in saved.')
    expect(host.textContent).toContain('Salvo')
    expect(host.textContent).toContain('50%')
    expect(host.textContent).toContain('previous summary is still shown')
    expect(host.textContent).toContain('previous check-ins are still shown')
    expect(host.textContent).not.toContain('No check-ins in this period.')
    await click(button('Try again'))
    expect(host.textContent).toContain('80%')
    expect(host.textContent).toContain('Current streak: 7')
    expect(host.textContent).toContain('Confirmado')
  })
})
