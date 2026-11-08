// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import {
  FIRST_STEPS_STORAGE_KEY,
  FIRST_STEPS_VERSION,
  getFirstStepsState,
  migrateFirstStepsPayload,
  readFirstStepsPayload,
  setFirstStepCompleted,
  setFirstStepsDismissed,
  validateFirstStepsPayload,
} from './first-steps-store.js'

beforeEach(() => localStorage.clear())

describe('first steps persistence', () => {
  it('isola conclusão e dismiss por conta e papel ativo', () => {
    setFirstStepCompleted('dual_1', 'coach', 'profile')
    setFirstStepsDismissed('dual_1', 'coach', true)
    setFirstStepCompleted('dual_1', 'athlete', 'plan')
    setFirstStepCompleted('athlete_2', 'athlete', 'community')

    expect(getFirstStepsState('dual_1', 'coach')).toEqual({ dismissed: true, completed: ['profile'] })
    expect(getFirstStepsState('dual_1', 'athlete')).toEqual({ dismissed: false, completed: ['plan'] })
    expect(getFirstStepsState('athlete_2', 'athlete')).toEqual({ dismissed: false, completed: ['community'] })
  })

  it('falha fechado para JSON corrompido ou payload inválido', () => {
    localStorage.setItem(FIRST_STEPS_STORAGE_KEY, '{quebrado')
    expect(readFirstStepsPayload()).toEqual({ version: FIRST_STEPS_VERSION, entries: [] })

    localStorage.setItem(FIRST_STEPS_STORAGE_KEY, JSON.stringify({ version: FIRST_STEPS_VERSION, entries: [{ userId: 'u1' }] }))
    expect(getFirstStepsState('u1', 'coach')).toEqual({ dismissed: false, completed: [] })
  })

  it('rejeita versões futuras sem reaproveitar estado desconhecido', () => {
    localStorage.setItem(FIRST_STEPS_STORAGE_KEY, JSON.stringify({
      version: FIRST_STEPS_VERSION + 1,
      entries: [{ userId: 'u1', role: 'coach', dismissed: true, completed: ['profile'], updatedAt: 1 }],
    }))
    expect(getFirstStepsState('u1', 'coach')).toEqual({ dismissed: false, completed: [] })
    expect(validateFirstStepsPayload({ version: FIRST_STEPS_VERSION + 1, entries: [] })).toBeNull()
    expect(migrateFirstStepsPayload({ version: FIRST_STEPS_VERSION + 1, entries: [] })).toBeNull()
  })

  it('persiste fechar, retomar e concluir sem duplicar itens', () => {
    setFirstStepsDismissed('u1', 'athlete', true)
    setFirstStepsDismissed('u1', 'athlete', false)
    setFirstStepCompleted('u1', 'athlete', 'profile')
    setFirstStepCompleted('u1', 'athlete', 'profile')
    setFirstStepCompleted('u1', 'athlete', 'profile', false)

    expect(getFirstStepsState('u1', 'athlete')).toEqual({ dismissed: false, completed: [] })
    expect(JSON.parse(localStorage.getItem(FIRST_STEPS_STORAGE_KEY))).toMatchObject({ version: FIRST_STEPS_VERSION })
  })
})
