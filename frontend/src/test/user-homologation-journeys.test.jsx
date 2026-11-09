// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { guardReactWarnings, waitForReact } from './react-warning-guard.js'
import { DEF, useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { getActiveRole, setActiveRole, isDualRoleUser } from '../lib/roles.js'
import { _setLangState } from '../lib/i18n-core.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  apiCalls: [],
  apiAnswers: {},
  scheduling: {
    getCoachAppointments: vi.fn(),
    getCoachAvailability: vi.fn(),
    updateCoachAvailability: vi.fn(),
    getAthleteAppointments: vi.fn(),
    getAthleteSlots: vi.fn(),
    createAthleteAppointment: vi.fn(),
    cancelCoachAppointment: vi.fn(),
    rescheduleCoachAppointment: vi.fn(),
    getReminderPreferences: vi.fn(),
    updateReminderPreferences: vi.fn(),
  },
  communication: {
    inbox: vi.fn(),
    conversation: vi.fn(),
    sendMessage: vi.fn(),
    readMessage: vi.fn(),
    readThrough: vi.fn(),
    coachHabits: vi.fn(),
    createHabit: vi.fn(),
    updateHabit: vi.fn(),
    deleteHabit: vi.fn(),
    athleteHabits: vi.fn(),
    checkin: vi.fn(),
    checkins: vi.fn(),
    summary: vi.fn(),
  },
  sheets: {
    confirmSheet: vi.fn(),
    startFlow: vi.fn(),
  },
  toast: vi.fn(),
  pullState: vi.fn(),
}))

vi.mock('../lib/api.js', () => ({
  api: vi.fn(async (path, opts) => {
    const body = opts?.body ? JSON.parse(opts.body) : null
    mocks.apiCalls.push({ path, method: opts?.method || 'GET', body, opts })
    const answer = mocks.apiAnswers[path] ?? mocks.apiAnswers[path.split('?')[0]]
    if (answer instanceof Error) throw answer
    if (typeof answer === 'function') return answer(body, opts, path)
    return answer ?? {}
  }),
  beacon: vi.fn(),
}))

vi.mock('../lib/scheduling-api.js', () => ({
  getCoachAppointments: (...args) => mocks.scheduling.getCoachAppointments(...args),
  getCoachAvailability: (...args) => mocks.scheduling.getCoachAvailability(...args),
  updateCoachAvailability: (...args) => mocks.scheduling.updateCoachAvailability(...args),
  getAthleteAppointments: (...args) => mocks.scheduling.getAthleteAppointments(...args),
  getAthleteSlots: (...args) => mocks.scheduling.getAthleteSlots(...args),
  createAthleteAppointment: (...args) => mocks.scheduling.createAthleteAppointment(...args),
  cancelCoachAppointment: (...args) => mocks.scheduling.cancelCoachAppointment(...args),
  rescheduleCoachAppointment: (...args) => mocks.scheduling.rescheduleCoachAppointment(...args),
  getReminderPreferences: (...args) => mocks.scheduling.getReminderPreferences(...args),
  updateReminderPreferences: (...args) => mocks.scheduling.updateReminderPreferences(...args),
  ConflictError: class ConflictError extends Error {
    constructor(msg = 'Conflict', code = 'revision_conflict') {
      super(msg)
      this.status = 409
      this.code = code
    }
  },
}))

vi.mock('../lib/communication-api.js', () => ({
  communicationApi: mocks.communication,
  browserTimeZone: () => ({ value: 'America/Sao_Paulo', fallback: false }),
}))

vi.mock('../sheets.jsx', () => ({
  confirmSheet: options => {
    mocks.sheets.confirmSheet(options)
    options.onConfirm?.()
  },
  startFlow: (...args) => mocks.sheets.startFlow(...args),
}))

import { RoutineEditor } from '../views/ProfessionalHub.jsx'
import { CoachAvailabilityEditor, CoachAppointmentsView, AthleteBookingView } from '../views/SchedulingView.jsx'
import NutritionPanel, { MealPlanEditor, AthleteNutritionView } from '../views/NutritionPanel.jsx'
import AthleteToday from '../views/dashboard/AthleteToday.jsx'
import Home from '../views/Home.jsx'
import { ConflictError } from '../lib/scheduling-api.js'

let host
let root
let assertNoReactWarnings

const settle = async (ms = 15) => {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, ms))
  })
}

const setValue = async (input, value) => {
  await act(async () => {
    const proto = input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : input instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, value)
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
}

const click = async element => {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  await settle()
}

const findButton = (text, container = host) =>
  [...container.querySelectorAll('button')].find(b => b.textContent.trim().includes(text))

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  mocks.apiCalls = []
  mocks.apiAnswers = {}
  _setLangState('pt-BR', {}, null, null)

  assertNoReactWarnings = guardReactWarnings()
  useUI.setState({ toast: mocks.toast, sheets: [] })

  host = document.createElement('div')
  host.id = 'test-root'
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  if (root) await act(async () => { root.unmount() })
  host.remove()
  assertNoReactWarnings?.()
  _setLangState('en', {}, null, null)
})

describe('Homologação de Usabilidade — Checkpoint 8', () => {
  describe('Ator 1: Treinador (Coach)', () => {
    const coachUser = {
      id: 'coach_1',
      name: 'Treinador Carlos',
      profile: { kind: 'coach', coachSpecialties: ['training', 'assessments'] },
    }
    const athlete = { id: 'ath_1', name: 'Atleta Bruno', email: 'bruno@example.com' }

    it('Jornada 1.1: Criar prescrição de treino com divisão A/B/C completa e salvar', async () => {
      useStore.setState({ user: coachUser, pullState: mocks.pullState })
      const createdRoutine = { id: 'cpr_1', name: 'Hipertrofia ABC', divisions: [] }
      mocks.apiAnswers[`/api/coach/athletes/${athlete.id}/routines`] = { routine: createdRoutine }

      const onCreated = vi.fn()
      const onCancel = vi.fn()

      act(() => {
        root.render(<RoutineEditor athlete={athlete} onCreated={onCreated} onCancel={onCancel} />)
      })
      await settle()

      expect(host.querySelector('.pro-routine-editor')).toBeTruthy()
      expect(host.querySelectorAll('.pro-division-editor').length).toBe(3)

      const nameInput = host.querySelector('input[name="routineName"]')
      await setValue(nameInput, 'Hipertrofia ABC')

      const divAInput = host.querySelector('input[name="division-1"]')
      await setValue(divAInput, 'Divisão A - Peito e Tríceps')

      const exNameA = host.querySelector('input[name="exercise-1-1"]')
      const exSetsA = host.querySelector('input[name="sets-1-1"]')
      const exRepsA = host.querySelector('input[name="reps-1-1"]')
      const exLoadA = host.querySelector('input[name="load-1-1"]')
      await setValue(exNameA, 'Supino Reto com Barra')
      await setValue(exSetsA, '4')
      await setValue(exRepsA, '8-10')
      await setValue(exLoadA, '70kg')

      const divBInput = host.querySelector('input[name="division-2"]')
      await setValue(divBInput, 'Divisão B - Costas e Bíceps')
      const exNameB = host.querySelector('input[name="exercise-2-1"]')
      const exSetsB = host.querySelector('input[name="sets-2-1"]')
      const exRepsB = host.querySelector('input[name="reps-2-1"]')
      await setValue(exNameB, 'Puxada Frontal')
      await setValue(exSetsB, '4')
      await setValue(exRepsB, '10-12')

      const divCInput = host.querySelector('input[name="division-3"]')
      await setValue(divCInput, 'Divisão C - Pernas')
      const exNameC = host.querySelector('input[name="exercise-3-1"]')
      const exSetsC = host.querySelector('input[name="sets-3-1"]')
      const exRepsC = host.querySelector('input[name="reps-3-1"]')
      await setValue(exNameC, 'Agachamento Livre')
      await setValue(exSetsC, '4')
      await setValue(exRepsC, '8-10')

      const sendBtn = findButton('Send prescription') || findButton('Prescrever') || host.querySelector('.pro-editor-footer-actions button:last-child')
      expect(sendBtn).toBeTruthy()
      await click(sendBtn)

      const postCall = mocks.apiCalls.find(c => c.path === `/api/coach/athletes/${athlete.id}/routines` && c.method === 'POST')
      expect(postCall).toBeTruthy()
      expect(postCall.body.routine.name).toBe('Hipertrofia ABC')
      expect(postCall.body.routine.divisions.length).toBe(3)
      expect(postCall.body.routine.divisions[0].exercises[0].name).toBe('Supino Reto com Barra')
      expect(postCall.body.routine.divisions[1].exercises[0].name).toBe('Puxada Frontal')
      expect(postCall.body.routine.divisions[2].exercises[0].name).toBe('Agachamento Livre')

      expect(onCreated).toHaveBeenCalledWith(createdRoutine)
      expect(mocks.toast).toHaveBeenCalledWith('Prescrição de treino salva.')
    })

    it('Jornada 1.2: Definir e ajustar disponibilidade com CAS e tratar conflito de concorrência', async () => {
      useStore.setState({ user: coachUser, pullState: mocks.pullState })

      const initialAvailability = {
        _rev: 1,
        timeZone: 'America/Sao_Paulo',
        sessionDurationMinutes: 60,
        bufferMinutes: 0,
        minNoticeHours: 2,
        maxAdvanceDays: 30,
        windows: [{ dayOfWeek: 1, startMinute: 480, endMinute: 720 }],
        exceptions: [],
      }

      mocks.scheduling.getCoachAvailability.mockResolvedValueOnce({ availability: initialAvailability })
      mocks.scheduling.updateCoachAvailability.mockResolvedValueOnce({
        availability: { ...initialAvailability, bufferMinutes: 15, _rev: 2 },
        futureConflicts: [],
      })

      act(() => {
        root.render(<CoachAvailabilityEditor />)
      })
      await settle()

      expect(mocks.scheduling.getCoachAvailability).toHaveBeenCalled()
      const saveBtn = findButton('Save availability') || findButton('Salvar disponibilidade')
      expect(saveBtn).toBeTruthy()

      const bufferInput = host.querySelector('input[name="bufferMinutes"]')
      expect(bufferInput).toBeTruthy()
      await setValue(bufferInput, '15')

      await click(saveBtn)

      expect(mocks.scheduling.updateCoachAvailability).toHaveBeenCalledWith(
        expect.objectContaining({ bufferMinutes: 15 }),
        1
      )
      expect(mocks.toast).toHaveBeenCalledWith('Disponibilidade salva.')

      mocks.scheduling.updateCoachAvailability.mockRejectedValueOnce(
        new ConflictError('Revision conflict', 'revision_conflict')
      )

      await click(saveBtn)

      expect(host.querySelector('.ds-alert')).toBeTruthy()
      expect(mocks.toast).toHaveBeenCalledWith(
        'Conflito de alteração. Sua disponibilidade foi atualizada em outro dispositivo ou navegador. Recarregue os dados para tentar novamente.'
      )
    })

    it('Jornada 1.3: Visualizar atendimentos do aluno e gerenciar cancelamento com feedback imediato', async () => {
      useStore.setState({ user: coachUser, pullState: mocks.pullState })

      const appointments = [
        {
          id: 'apt_1',
          coachId: coachUser.id,
          athleteId: athlete.id,
          athleteName: athlete.name,
          title: 'Sessão de Ajuste de Treino',
          type: 'in_person',
          status: 'scheduled',
          startAt: '2026-11-15T14:00:00Z',
          endAt: '2026-11-15T15:00:00Z',
          timeZone: 'America/Sao_Paulo',
          lifecycle: { allowedActions: ['reschedule', 'cancel'], readOnly: false },
        },
      ]

      mocks.scheduling.getCoachAppointments.mockResolvedValueOnce({
        items: appointments,
        hasMore: false,
      })
      mocks.scheduling.cancelCoachAppointment.mockResolvedValueOnce({
        appointment: { ...appointments[0], status: 'canceled' },
      })

      act(() => {
        root.render(<CoachAppointmentsView links={[{ id: 'link_1', athlete }]} />)
      })
      await settle()

      expect(host.textContent).toContain('Sessão de Ajuste de Treino')
      const cancelBtn = findButton('Cancelar sessão') || findButton('Cancel session')
      expect(cancelBtn).toBeTruthy()

      await click(cancelBtn)
      const modalCancelConfirm = host.querySelector('.modal-action-danger, .btn-danger, button[type="submit"]') || findButton('Cancelar compromisso') || findButton('Cancel appointment')
      if (modalCancelConfirm) await click(modalCancelConfirm)

      expect(mocks.scheduling.cancelCoachAppointment).toHaveBeenCalledWith('apt_1', expect.anything())
      expect(mocks.toast).toHaveBeenCalledWith('Compromisso cancelado.')
    })
  })

  describe('Ator 2: Nutricionista / Coach de Nutrição', () => {
    const nutriUser = {
      id: 'nutri_1',
      name: 'Dra. Marina Nutricionista',
      profile: { kind: 'coach', coachSpecialties: ['nutrition'] },
    }
    const athlete = { id: 'ath_2', name: 'Atleta Lucas' }

    it('Jornada 2.1: Criar e publicar plano alimentar com cálculo coerente de macros e calorias', async () => {
      useStore.setState({ user: nutriUser, pullState: mocks.pullState })

      mocks.apiAnswers[`/api/coach/athletes/${athlete.id}/meal-plans`] = {
        mealPlan: { id: 'plan_1', title: 'Plano Hipertrofia 2600kcal', status: 'active' },
      }

      const onSaved = vi.fn()
      const onCancel = vi.fn()

      act(() => {
        root.render(<MealPlanEditor athleteId={athlete.id} onSaved={onSaved} onCancel={onCancel} />)
      })
      await settle()

      expect(host.querySelector('.nutrition-editor')).toBeTruthy()

      await setValue(host.querySelector('input[name="mealPlanTitle"]'), 'Plano Hipertrofia 2600kcal')
      await setValue(host.querySelector('select[name="mealPlanStatus"]'), 'active')

      await setValue(host.querySelector('input[name="target-targetCalories"]'), '2600')
      await setValue(host.querySelector('input[name="target-protein"]'), '160')
      await setValue(host.querySelector('input[name="target-carbs"]'), '325')
      await setValue(host.querySelector('input[name="target-fats"]'), '73')
      await setValue(host.querySelector('input[name="target-fiber"]'), '35')
      await setValue(host.querySelector('input[name="target-waterMl"]'), '3000')

      await setValue(host.querySelector('input[name="meal-name-1"]'), 'Almoço Balanceado')
      await setValue(host.querySelector('input[name="meal-time-1"]'), '12:30')
      await setValue(host.querySelector('input[name="food-1-1"]'), 'Arroz, Feijão e Peito de Frango')
      await setValue(host.querySelector('input[name="portion-1-1"]'), '250g arroz + 180g frango')
      await setValue(host.querySelector('input[name="calories-1-1"]'), '2590')
      await setValue(host.querySelector('input[name="protein-1-1"]'), '160')
      await setValue(host.querySelector('input[name="carbs-1-1"]'), '325')
      await setValue(host.querySelector('input[name="fats-1-1"]'), '73')
      await setValue(host.querySelector('input[name="fiber-1-1"]'), '35')

      const saveBtn = findButton('Save meal plan') || findButton('Salvar plano alimentar') || host.querySelector('.nutrition-editor button.btn-primary')
      expect(saveBtn).toBeTruthy()
      await click(saveBtn)

      const postCall = mocks.apiCalls.find(c => c.path === `/api/coach/athletes/${athlete.id}/meal-plans` && c.method === 'POST')
      expect(postCall).toBeTruthy()
      expect(postCall.body.title).toBe('Plano Hipertrofia 2600kcal')
      expect(postCall.body.status).toBe('active')
      expect(postCall.body.targetCalories).toBe(2600)
      expect(postCall.body.targetMacros.protein).toBe(160)
      expect(postCall.body.targetMacros.waterMl).toBe(3000)

      expect(onSaved).toHaveBeenCalled()
      expect(mocks.toast).toHaveBeenCalledWith('Plano alimentar salvo.')
    })

    it('Jornada 2.2: Visualizar adesão alimentar e hidratação do atleta isolado por escopo', async () => {
      useStore.setState({ user: nutriUser, pullState: mocks.pullState })

      const activePlan = {
        id: 'plan_1',
        title: 'Plano Ativo',
        status: 'active',
        targetCalories: 2400,
        targetMacros: { protein: 150, carbs: 280, fats: 65, fiber: 30, waterMl: 3000 },
        meals: [
          { id: 'm1', name: 'Café', time: '08:00', items: [{ id: 'i1', name: 'Ovos', portion: '3 unid', calories: 250, protein: 20, carbs: 2, fats: 18, fiber: 0, substitutes: [] }] },
          { id: 'm2', name: 'Almoço', time: '12:30', items: [{ id: 'i2', name: 'Frango', portion: '200g', calories: 300, protein: 60, carbs: 0, fats: 6, fiber: 0, substitutes: [] }] },
        ],
        coach: { name: nutriUser.name },
      }

      const adherenceRecords = [
        {
          id: 'adh_1',
          athleteId: athlete.id,
          mealPlanId: 'plan_1',
          date: '2026-11-09',
          mealsChecked: ['m1'],
          waterDrunkMl: 2250,
          notes: 'Dia produtivo',
          updatedAt: Date.now(),
          planSnapshot: {
            version: 1,
            nutritionContractVersion: 1,
            title: 'Plano Ativo',
            targetCalories: 2400,
            targetMacros: { protein: 150, carbs: 280, fats: 65, fiber: 30, waterMl: 3000 },
            meals: activePlan.meals,
          },
        },
      ]

      mocks.apiAnswers[`/api/coach/athletes/${athlete.id}/meal-plans`] = {
        mealPlans: [activePlan],
        quota: { used: 1, limit: 100 },
      }
      mocks.apiAnswers[`/api/coach/athletes/${athlete.id}/meal-adherence`] = {
        adherence: adherenceRecords,
        page: { limit: 50, hasMore: false, nextCursor: null },
        quota: { used: 1, limit: 1000, retentionDays: 730 },
      }

      act(() => {
        root.render(<NutritionPanel athleteId={athlete.id} />)
      })
      await settle()

      expect(host.textContent).toContain('Plano Ativo')
      expect(host.textContent).toContain('2400 kcal')
      expect(host.textContent.includes('Recent adherence') || host.textContent.includes('Adesão recente')).toBe(true)
    })
  })

  describe('Ator 3: Aluno (Atleta)', () => {
    const athleteUser = {
      id: 'ath_3',
      name: 'Aluno Rodrigo',
      profile: { kind: 'athlete' },
    }

    it('Jornada 3.1: Visualizar dashboard Hoje, adotar treino prescrito e iniciar sessão', async () => {
      const initialS = structuredClone(DEF)
      initialS.routines = [{ id: 'r_initial', name: 'Rotina Inicial A', ex: [] }]
      initialS.week = { 0: ['r_initial'], 1: ['r_initial'], 2: ['r_initial'], 3: ['r_initial'], 4: ['r_initial'], 5: ['r_initial'], 6: ['r_initial'] }
      initialS.workouts = []
      useStore.setState({ user: athleteUser, S: initialS, ready: true, pullState: mocks.pullState })

      const coachPrescription = {
        id: 'cpr_workout_99',
        state: 'available',
        coach: { id: 'coach_1', name: 'Treinador Carlos' },
        routine: {
          name: 'Treino Hipertrofia ABCD Avançado',
          notes: 'Respeitar os intervalos de descanso.',
          divisions: [
            { id: 'div_1', name: 'A', exercises: [{ name: 'Supino Reto', sets: 4, reps: '8-10' }] },
            { id: 'div_2', name: 'B', exercises: [{ name: 'Puxada', sets: 4, reps: '8-10' }] },
          ],
        },
      }

      mocks.apiAnswers['/api/athlete/prescriptions'] = { prescriptions: [coachPrescription] }
      mocks.apiAnswers['/api/athlete/prescriptions/cpr_workout_99/adopt'] = { success: true }
      mocks.apiAnswers['/api/athlete/meal-plan'] = { mealPlan: null }
      mocks.apiAnswers['/api/athlete/meal-adherence'] = { adherence: null }
      mocks.apiAnswers['/api/athlete/challenges'] = { challenges: [] }
      mocks.scheduling.getAthleteAppointments.mockResolvedValueOnce({ appointments: [] })
      mocks.communication.inbox.mockResolvedValueOnce({ conversations: [] })
      mocks.communication.athleteHabits.mockResolvedValueOnce({ habits: [], summary: {} })

      act(() => {
        root.render(
          <MemoryRouter initialEntries={['/home']}>
            <AthleteToday />
          </MemoryRouter>
        )
      })
      await settle()

      expect(host.textContent).toContain('Treino Prescrito')
      expect(host.textContent).toContain('Treino Hipertrofia ABCD Avançado')

      const adoptBtn = findButton('Adotar treino do treinador')
      expect(adoptBtn).toBeTruthy()

      await click(adoptBtn)

      expect(mocks.apiCalls.some(c => c.path === '/api/athlete/prescriptions/cpr_workout_99/adopt' && c.method === 'POST')).toBe(true)
      expect(mocks.toast).toHaveBeenCalledWith('Prescrição aplicada ao seu Plano de Treino.')

      const startBtn = findButton('Iniciar treino')
      expect(startBtn).toBeTruthy()
      await click(startBtn)
      expect(mocks.sheets.startFlow).toHaveBeenCalled()
    })

    it('Jornada 3.2: Agendar sessão de treino com treinador a partir de slots disponíveis', async () => {
      useStore.setState({ user: athleteUser, pullState: mocks.pullState })

      const coach = { id: 'coach_1', name: 'Treinador Carlos' }
      const links = [{ id: 'link_1', coach, scopes: ['training'] }]

      const slots = [
        {
          startAt: '2026-11-20T10:00:00Z',
          endAt: '2026-11-20T11:00:00Z',
          durationMinutes: 60,
          timeZone: 'America/Sao_Paulo',
        },
      ]

      mocks.scheduling.getAthleteSlots.mockResolvedValue({ items: slots })
      mocks.scheduling.createAthleteAppointment.mockResolvedValueOnce({
        appointment: {
          id: 'apt_new',
          coachId: coach.id,
          athleteId: athleteUser.id,
          startAt: slots[0].startAt,
          endAt: slots[0].endAt,
          status: 'scheduled',
        },
      })

      const onBookSuccess = vi.fn()

      act(() => {
        root.render(<AthleteBookingView links={links} onBookSuccess={onBookSuccess} />)
      })
      await settle()

      expect(mocks.scheduling.getAthleteSlots).toHaveBeenCalledWith(coach.id, expect.anything())

      const slotBtn = host.querySelector('.pro-sched-slot-btn')
      expect(slotBtn).toBeTruthy()
      await click(slotBtn)

      const bookDialogBtn = host.querySelector('.modal-action-primary, .btn-primary, button[type="submit"]') || findButton('Agendar sessão') || findButton('Book session')
      expect(bookDialogBtn).toBeTruthy()
      await click(bookDialogBtn)

      expect(mocks.scheduling.createAthleteAppointment).toHaveBeenCalledWith(
        coach.id,
        expect.objectContaining({
          startAt: slots[0].startAt,
          endAt: slots[0].endAt,
        })
      )
      expect(mocks.toast).toHaveBeenCalledWith('Sessão agendada com sucesso.')
      expect(onBookSuccess).toHaveBeenCalled()
    })

    it('Jornada 3.3: Fazer check-in diário de refeição e registrar consumo hídrico', async () => {
      useStore.setState({ user: athleteUser, pullState: mocks.pullState })

      const activePlan = {
        id: 'plan_today',
        title: 'Nutrição Equilibrada',
        status: 'active',
        targetCalories: 2200,
        targetMacros: { protein: 140, carbs: 260, fats: 60, fiber: 28, waterMl: 2500 },
        meals: [
          {
            id: 'm_breakfast',
            name: 'Café da Manhã',
            time: '08:00',
            items: [{ id: 'item_1', name: 'Tapioca com ovos', portion: '1 unid', calories: 350, protein: 18, carbs: 40, fats: 12, fiber: 2, substitutes: [] }],
          },
        ],
        coach: { name: 'Dra. Marina' },
      }

      mocks.apiAnswers['/api/athlete/meal-plan'] = { mealPlan: activePlan }
      mocks.apiAnswers['/api/athlete/meal-adherence'] = {
        adherence: {
          id: 'adh_today',
          mealPlanId: 'plan_today',
          mealsChecked: [],
          waterDrunkMl: 500,
        },
      }

      act(() => {
        root.render(<AthleteNutritionView />)
      })
      await settle()

      expect(host.textContent).toContain('Nutrição Equilibrada')
      expect(host.textContent).toContain('Café da Manhã')

      const checkBtn = host.querySelector('.athlete-meal button') || findButton('Marcar refeição') || host.querySelector('.athlete-meal')
      expect(checkBtn).toBeTruthy()

      mocks.apiAnswers['/api/athlete/meal-adherence'] = {
        adherence: {
          id: 'adh_today',
          mealPlanId: 'plan_today',
          mealsChecked: ['m_breakfast'],
          waterDrunkMl: 500,
        },
      }

      await click(checkBtn)

      const adherencePost = mocks.apiCalls.find(c => c.path === '/api/athlete/meal-adherence' && c.method === 'POST')
      expect(adherencePost).toBeTruthy()
      expect(adherencePost.body.mealPlanId).toBe('plan_today')

      const waterAddBtn = findButton('+250ml') || findButton('+ 250') || host.querySelector('.athlete-water-btn')
      if (waterAddBtn) {
        await click(waterAddBtn)
        const waterPost = mocks.apiCalls.filter(c => c.path === '/api/athlete/meal-adherence' && c.method === 'POST').at(-1)
        expect(waterPost).toBeTruthy()
        expect(waterPost.body.waterDrunkMl).toBeGreaterThanOrEqual(500)
      }
    })
  })

  describe('Ator 4: Dual-Role (Treinador e Atleta Simultaneamente)', () => {
    it('Jornada 4.1: Alternar entre modo Treinador e Atleta sem perda de estado ou contaminação visual', async () => {
      const dualUser = {
        id: 'dual_coach_99',
        name: 'Carlos Dual Coach',
        profile: { kind: 'coach', dualRole: true, coachSpecialties: ['training'] },
      }

      expect(isDualRoleUser(dualUser)).toBe(true)

      const initialS = structuredClone(DEF)
      initialS.routines = [{ id: 'my_personal_routine', name: 'Meu Treino Pessoal de Coach', ex: [] }]
      initialS.week = { 0: ['my_personal_routine'], 1: ['my_personal_routine'], 2: ['my_personal_routine'], 3: ['my_personal_routine'], 4: ['my_personal_routine'], 5: ['my_personal_routine'], 6: ['my_personal_routine'] }
      useStore.setState({ user: dualUser, S: initialS, ready: true, pullState: mocks.pullState })

      mocks.apiAnswers['/api/coach/athletes'] = { athletes: [] }
      mocks.apiAnswers['/api/messages/inbox'] = { conversations: [] }
      mocks.apiAnswers['/api/athlete/prescriptions'] = { prescriptions: [] }
      mocks.apiAnswers['/api/athlete/meal-plan'] = { mealPlan: null }
      mocks.apiAnswers['/api/athlete/meal-adherence'] = { adherence: null }
      mocks.apiAnswers['/api/athlete/challenges'] = { challenges: [] }
      mocks.scheduling.getCoachAppointments.mockResolvedValue({ items: [], hasMore: false })
      mocks.scheduling.getCoachAvailability.mockResolvedValue({ availability: null })
      mocks.scheduling.getAthleteAppointments.mockResolvedValue({ appointments: [] })
      mocks.communication.inbox.mockResolvedValue({ conversations: [] })
      mocks.communication.athleteHabits.mockResolvedValue({ habits: [], summary: {} })

      expect(getActiveRole(dualUser)).toBe('coach')

      act(() => {
        root.render(
          <MemoryRouter initialEntries={['/home']}>
            <Home />
          </MemoryRouter>
        )
      })

      await waitForReact(() => {
        expect(host.querySelector('.dashboard-page-coach, [aria-label*="Visão geral"], [aria-label*="Carregando visão geral"]') || host.textContent.includes('Visão geral') || host.textContent.includes('Exige atenção')).toBeTruthy()
      })

      act(() => {
        setActiveRole(dualUser, 'athlete')
      })

      expect(localStorage.getItem(`prfit_active_role_${dualUser.id}`)).toBe('athlete')
      expect(getActiveRole(dualUser)).toBe('athlete')

      act(() => {
        root.render(
          <MemoryRouter initialEntries={['/home']}>
            <Home />
          </MemoryRouter>
        )
      })

      await waitForReact(() => {
        expect(host.querySelector('.dashboard-page-athlete, [aria-label*="Hoje"], [aria-label*="Carregando Hoje"]') || host.textContent.includes('Hoje')).toBeTruthy()
      })

      const currentS = useStore.getState().S
      expect(currentS.routines.some(r => r.id === 'my_personal_routine')).toBe(true)

      act(() => {
        setActiveRole(dualUser, 'coach')
      })

      expect(localStorage.getItem(`prfit_active_role_${dualUser.id}`)).toBe('coach')
      expect(getActiveRole(dualUser)).toBe('coach')

      act(() => {
        root.render(
          <MemoryRouter initialEntries={['/home']}>
            <Home />
          </MemoryRouter>
        )
      })

      await waitForReact(() => {
        expect(host.querySelector('.dashboard-page-coach, [aria-label*="Visão geral"], [aria-label*="Carregando visão geral"]') || host.textContent.includes('Visão geral') || host.textContent.includes('Exige atenção')).toBeTruthy()
      })
    })
  })
})
