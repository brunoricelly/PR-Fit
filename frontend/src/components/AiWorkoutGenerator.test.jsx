// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { guardReactWarnings } from '../test/react-warning-guard.js'
import AiWorkoutGeneratorModal from './AiWorkoutGeneratorModal.jsx'
import {
  generateAiWorkout,
  getCleanPtExerciseName,
  LEVELS,
  OBJECTIVES,
  RESTRICTIONS,
  SPLITS,
} from '../lib/ai-workout-copilot.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let host, root, assertNoReactWarnings

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  assertNoReactWarnings = guardReactWarnings()
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  // Clean up any portaled modal leftovers in document.body
  document.querySelectorAll('.ds-modal-backdrop').forEach(el => el.remove())
  assertNoReactWarnings()
})

describe('ai-workout-copilot prescription engine', () => {
  it('exposes valid objectives, splits, levels, and restrictions in PT-BR', () => {
    expect(OBJECTIVES.map(o => o.id)).toEqual(['hipertrofia', 'emagrecimento', 'forca', 'condicionamento'])
    expect(SPLITS.map(s => s.id)).toEqual(['ppl', 'upper_lower', 'full_body'])
    expect(LEVELS.map(l => l.id)).toEqual(['iniciante', 'intermediario', 'avancado'])
    expect(RESTRICTIONS.map(r => r.id)).toEqual(['joelho', 'ombro', 'lombar'])
  })

  it('generates a valid Push / Pull / Legs (PPL) hypertrophy routine with 3 divisions', () => {
    const workout = generateAiWorkout({
      objective: 'hipertrofia',
      split: 'ppl',
      level: 'intermediario',
      restrictions: [],
    })

    expect(workout.name).toContain('Hipertrofia')
    expect(workout.divisions).toHaveLength(3)
    expect(workout.divisions[0].name).toContain('Push')
    expect(workout.divisions[1].name).toContain('Pull')
    expect(workout.divisions[2].name).toContain('Legs')

    // Each division has valid exercises
    workout.divisions.forEach(division => {
      expect(division.exercises.length).toBeGreaterThanOrEqual(5)
      division.exercises.forEach(ex => {
        expect(ex.id).toBeTruthy()
        expect(ex.name).toBeTruthy()
        expect(Number(ex.sets)).toBeGreaterThanOrEqual(1)
        expect(ex.reps).toMatch(/\d+-\d+/)
        expect(Number(ex.restSeconds)).toBeGreaterThanOrEqual(30)
      })
    })
  })

  it('adjusts sets, reps and rest times based on objective', () => {
    const forca = generateAiWorkout({ objective: 'forca', level: 'avancado' })
    const emagrecimento = generateAiWorkout({ objective: 'emagrecimento', level: 'iniciante' })
    const condicionamento = generateAiWorkout({ objective: 'condicionamento', level: 'intermediario' })

    // Força has heavy compound rest (150s) and lower reps (3-5 or 4-6)
    const forcaCompound = forca.divisions[0].exercises[0]
    expect(Number(forcaCompound.restSeconds)).toBeGreaterThanOrEqual(90)
    expect(forcaCompound.reps).toMatch(/3-5|4-6|6-8/)

    // Emagrecimento has short rest (30-45s) and higher reps (10-15)
    const emagrecimentoEx = emagrecimento.divisions[0].exercises[0]
    expect(Number(emagrecimentoEx.restSeconds)).toBeLessThanOrEqual(45)
    expect(emagrecimentoEx.reps).toMatch(/10-12|12-15/)

    // Condicionamento has high reps (15-20)
    const condEx = condicionamento.divisions[0].exercises[0]
    expect(condEx.reps).toBe('15-20')
    expect(Number(condEx.restSeconds)).toBe(30)
  })

  it('respects knee restriction: replaces barbell back squats with safe alternatives', () => {
    const workoutWithKnee = generateAiWorkout({
      split: 'ppl',
      restrictions: ['joelho'],
      seed: 0,
    })
    const legsWithKnee = workoutWithKnee.divisions.find(d => d.name.includes('Legs'))

    // Knee restriction avoids high knee stress squat 3593
    expect(legsWithKnee.exercises.some(e => e.id === '3593')).toBe(false)
    // Chooses hip-dominant / safe alternatives (like hip thrust 1060 or leg press 1027 or flexora 3415)
    expect(legsWithKnee.exercises.some(e => ['1060', '1027', '3415', '1409'].includes(e.id))).toBe(true)
    // Notes include safety alerts
    expect(workoutWithKnee.summary.safetyNotes.some(note => note.toLowerCase().includes('joelho'))).toBe(true)
  })

  it('respects shoulder restriction: replaces aggressive overhead/dips with neutral grip/safe exercises', () => {
    const workoutWithShoulder = generateAiWorkout({
      split: 'ppl',
      restrictions: ['ombro'],
      seed: 0,
    })
    const pushWithShoulder = workoutWithShoulder.divisions.find(d => d.name.includes('Push'))

    // Avoids overhead barbell press 0091 and barbell bench press 0025
    expect(pushWithShoulder.exercises.some(e => e.id === '0091')).toBe(false)
    expect(pushWithShoulder.exercises.some(e => e.id === '0025')).toBe(false)
    // Prioritizes dumbbell bench press (0289) and lateral raise (0334 or 0178)
    expect(pushWithShoulder.exercises.some(e => ['0289', '0334', '0178', '1030'].includes(e.id))).toBe(true)
    expect(workoutWithShoulder.summary.safetyNotes.some(note => note.toLowerCase().includes('ombro'))).toBe(true)
  })

  it('respects lumbar restriction: replaces bent over row and deadlifts with chest-supported/cable rows', () => {
    const workoutWithLumbar = generateAiWorkout({
      split: 'ppl',
      restrictions: ['lombar'],
      seed: 0,
    })
    const pullWithLumbar = workoutWithLumbar.divisions.find(d => d.name.includes('Pull'))

    // Avoids unsupported bent over barbell row 0027
    expect(pullWithLumbar.exercises.some(e => e.id === '0027')).toBe(false)
    // Uses chest-supported row 9698 or seated cable row 0180
    expect(pullWithLumbar.exercises.some(e => ['9698', '0180', '0150', '1047'].includes(e.id))).toBe(true)
    expect(workoutWithLumbar.summary.safetyNotes.some(note => note.toLowerCase().includes('lombar'))).toBe(true)
  })

  it('respects multiple simultaneous restrictions (knee + shoulder + lumbar)', () => {
    const workout = generateAiWorkout({
      split: 'ppl',
      restrictions: ['joelho', 'ombro', 'lombar'],
      seed: 0,
    })

    expect(workout.summary.safetyNotes).toHaveLength(3)
    const allExercises = workout.divisions.flatMap(d => d.exercises)
    expect(allExercises.some(e => e.id === '3593')).toBe(false) // no back squat
    expect(allExercises.some(e => e.id === '0027')).toBe(false) // no barbell row
    expect(allExercises.some(e => e.id === '0091')).toBe(false) // no overhead press
    expect(allExercises.some(e => e.id === '0025')).toBe(false) // no flat barbell bench
  })

  it('guarantees unique exercises within each division (no duplicates)', () => {
    const workout = generateAiWorkout({
      split: 'ppl',
      level: 'avancado',
      restrictions: ['lombar'],
    })

    workout.divisions.forEach(division => {
      const ids = division.exercises.map(e => e.id)
      const uniqueIds = new Set(ids)
      expect(uniqueIds.size).toBe(ids.length)
    })
  })

  it('formats clean Portuguese names', () => {
    expect(getCleanPtExerciseName('0025')).toBe('Supino reto com barra')
    expect(getCleanPtExerciseName('0289')).toBe('Supino reto com halteres')
    expect(getCleanPtExerciseName('1060')).toBe('Elevação pélvica com barra (Hip Thrust)')
    expect(getCleanPtExerciseName('9698')).toBe('Remada com apoio no peito com halteres')
  })
})

describe('AiWorkoutGeneratorModal component', () => {
  it('renders modal with title, options, and preview when open', async () => {
    await act(async () => {
      root.render(
        <AiWorkoutGeneratorModal
          isOpen={true}
          onClose={vi.fn()}
          onApply={vi.fn()}
        />
      )
    })

    const modalBody = document.body
    expect(modalBody.textContent).toContain('Prescrição Expressa com IA')
    expect(modalBody.textContent).toContain('Objetivo Principal')
    expect(modalBody.textContent).toContain('Hipertrofia')
    expect(modalBody.textContent).toContain('Divisão de Treino')
    expect(modalBody.textContent).toContain('Push / Pull / Legs (ABC)')
    expect(modalBody.textContent).toContain('Restrições Articulares')
    expect(modalBody.textContent).toContain('Joelho')
    expect(modalBody.textContent).toContain('Ombro')
    expect(modalBody.textContent).toContain('Lombar')
    expect(modalBody.textContent).toContain('Aplicar este treino')
  })

  it('does not render when isOpen is false', async () => {
    await act(async () => {
      root.render(
        <AiWorkoutGeneratorModal
          isOpen={false}
          onClose={vi.fn()}
          onApply={vi.fn()}
        />
      )
    })

    expect(document.querySelector('#ai-workout-generator-modal')).toBeNull()
  })

  it('toggles joint restrictions when clicked', async () => {
    await act(async () => {
      root.render(
        <AiWorkoutGeneratorModal
          isOpen={true}
          onClose={vi.fn()}
          onApply={vi.fn()}
        />
      )
    })

    const kneeButton = [...document.body.querySelectorAll('button')].find(btn => btn.textContent.includes('Joelho'))
    expect(kneeButton).toBeTruthy()
    expect(kneeButton.getAttribute('aria-checked')).toBe('false')

    // Click knee button
    await act(async () => {
      kneeButton.click()
    })

    expect(kneeButton.getAttribute('aria-checked')).toBe('true')
    expect(document.body.textContent).toContain('Ajustes de segurança ativados:')
    expect(document.body.textContent).toContain('joelho')
  })

  it('switches division tabs and shows corresponding exercises', async () => {
    await act(async () => {
      root.render(
        <AiWorkoutGeneratorModal
          isOpen={true}
          onClose={vi.fn()}
          onApply={vi.fn()}
        />
      )
    })

    const tabs = [...document.body.querySelectorAll('[role="tab"]')]
    expect(tabs.length).toBeGreaterThanOrEqual(3) // Treino A, Treino B, Treino C

    expect(tabs[0].getAttribute('aria-selected')).toBe('true')
    expect(document.body.textContent).toContain('Push')

    // Click Treino B (Pull)
    await act(async () => {
      tabs[1].click()
    })

    expect(tabs[1].getAttribute('aria-selected')).toBe('true')
    expect(document.body.textContent).toContain('Pull')
  })

  it('calls onApply with generated plan and closes modal when "Aplicar este treino" is clicked', async () => {
    const handleApply = vi.fn()
    const handleClose = vi.fn()

    await act(async () => {
      root.render(
        <AiWorkoutGeneratorModal
          isOpen={true}
          onClose={handleClose}
          onApply={handleApply}
        />
      )
    })

    const applyBtn = document.body.querySelector('[data-testid="apply-ai-workout-btn"]')
    expect(applyBtn).toBeTruthy()

    await act(async () => {
      applyBtn.click()
    })

    expect(handleApply).toHaveBeenCalledTimes(1)
    const appliedPlan = handleApply.mock.calls[0][0]
    expect(appliedPlan.name).toBeTruthy()
    expect(appliedPlan.divisions).toHaveLength(3)
    expect(handleClose).toHaveBeenCalledTimes(1)
  })

  it('regenerates alternative exercise selections when clicking "Regenerar sugestão"', async () => {
    await act(async () => {
      root.render(
        <AiWorkoutGeneratorModal
          isOpen={true}
          onClose={vi.fn()}
          onApply={vi.fn()}
        />
      )
    })

    const regenBtn = [...document.body.querySelectorAll('button')].find(btn => btn.textContent.includes('Regenerar sugestão'))
    expect(regenBtn).toBeTruthy()

    await act(async () => {
      regenBtn.click()
    })

    expect(document.body.textContent).toContain('Prescrição Expressa com IA')
  })
})
