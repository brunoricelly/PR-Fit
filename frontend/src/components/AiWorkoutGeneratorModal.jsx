import React, { useId, useMemo, useState } from 'react'
import Modal from './Modal.jsx'
import Icon from './Icon.jsx'
import { Badge, Button } from './design-system.jsx'
import {
  FOCUS_AREAS,
  generateAiWorkout,
  LEVELS,
  OBJECTIVES,
  RESTRICTIONS,
  SPLITS,
} from '../lib/ai-workout-copilot.js'
import './AiWorkoutGeneratorModal.css'

export default function AiWorkoutGeneratorModal({
  isOpen,
  onClose,
  onApply,
  initialAthlete,
  targetMode = 'prescription',
}) {
  const [objective, setObjective] = useState('hipertrofia')
  const [split, setSplit] = useState('ppl')
  const [level, setLevel] = useState('intermediario')
  const [restrictions, setRestrictions] = useState([])
  const [focus, setFocus] = useState('equilibrado')
  const [seed, setSeed] = useState(0)
  const [activeDivisionTab, setActiveDivisionTab] = useState(0)

  const toggleRestriction = restrictionId => {
    setRestrictions(current =>
      current.includes(restrictionId)
        ? current.filter(id => id !== restrictionId)
        : [...current, restrictionId]
    )
  }

  const generatedWorkout = useMemo(() => {
    return generateAiWorkout({
      objective,
      split,
      level,
      restrictions,
      focus,
      seed,
    })
  }, [objective, split, level, restrictions, focus, seed])

  const safeDivisionIndex = Math.min(activeDivisionTab, generatedWorkout.divisions.length - 1)
  const activeDivision = generatedWorkout.divisions[safeDivisionIndex] || generatedWorkout.divisions[0]

  const handleApply = () => {
    if (typeof onApply === 'function') {
      onApply(generatedWorkout, safeDivisionIndex)
    }
    onClose?.()
  }

  const handleRegenerate = () => {
    setSeed(s => s + 1)
  }

  if (!isOpen) return null

  const modalTitle = initialAthlete?.name
    ? `Prescrição com IA · ${initialAthlete.name}`
    : 'Prescrição Expressa com IA'

  return (
    <Modal
      id="ai-workout-generator-modal"
      title={modalTitle}
      onClose={onClose}
      className="ai-copilot-modal"
      closeLabel="Fechar copiloto"
    >
      <div className="ai-copilot-content">
        <p className="ai-copilot-intro">
          Copiloto inteligente para o treinador. Selecione as preferências e o PR Fit gera
          a ficha com exercícios do catálogo oficial, séries, reps, descansos e proteção articular.
        </p>

        {/* 1. Objetivo */}
        <fieldset className="ai-copilot-fieldset">
          <legend className="ai-copilot-legend">Objetivo Principal</legend>
          <div className="ai-copilot-pills" role="radiogroup" aria-label="Objetivo do treino">
            {OBJECTIVES.map(obj => {
              const active = objective === obj.id
              return (
                <button
                  key={obj.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  className={`ai-copilot-pill ${active ? 'active' : ''}`}
                  onClick={() => setObjective(obj.id)}
                >
                  <Icon name={obj.id === 'forca' ? 'figureStrength' : obj.id === 'emagrecimento' ? 'flame' : obj.id === 'condicionamento' ? 'bolt' : 'dumbbell'} />
                  <span>{obj.label}</span>
                </button>
              )
            })}
          </div>
        </fieldset>

        {/* 2. Divisão */}
        <fieldset className="ai-copilot-fieldset">
          <legend className="ai-copilot-legend">Divisão de Treino</legend>
          <div className="ai-copilot-pills" role="radiogroup" aria-label="Divisão de treino">
            {SPLITS.map(s => {
              const active = split === s.id
              return (
                <button
                  key={s.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  className={`ai-copilot-pill ${active ? 'active' : ''}`}
                  onClick={() => {
                    setSplit(s.id)
                    setActiveDivisionTab(0)
                  }}
                >
                  <Icon name="calendar" />
                  <span>{s.label}</span>
                </button>
              )
            })}
          </div>
        </fieldset>

        {/* 3. Nível */}
        <fieldset className="ai-copilot-fieldset">
          <legend className="ai-copilot-legend">Nível do Aluno</legend>
          <div className="ai-copilot-pills" role="radiogroup" aria-label="Nível do aluno">
            {LEVELS.map(lvl => {
              const active = level === lvl.id
              return (
                <button
                  key={lvl.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  className={`ai-copilot-pill ${active ? 'active' : ''}`}
                  onClick={() => setLevel(lvl.id)}
                >
                  <Icon name={lvl.id === 'avancado' ? 'trophy' : lvl.id === 'iniciante' ? 'target' : 'chart'} />
                  <span>{lvl.label}</span>
                </button>
              )
            })}
          </div>
        </fieldset>

        {/* 4. Restrições Articulares */}
        <fieldset className="ai-copilot-fieldset">
          <legend className="ai-copilot-legend">Restrições Articulares (Dores / Lesões)</legend>
          <div className="ai-copilot-pills" role="group" aria-label="Restrições articulares">
            {RESTRICTIONS.map(rest => {
              const active = restrictions.includes(rest.id)
              return (
                <button
                  key={rest.id}
                  type="button"
                  role="checkbox"
                  aria-checked={active}
                  className={`ai-copilot-pill restriction ${active ? 'active' : ''}`}
                  onClick={() => toggleRestriction(rest.id)}
                  title={rest.hint}
                >
                  <Icon name="shield" />
                  <span>{rest.label}</span>
                  {active && <Icon name="check" />}
                </button>
              )
            })}
          </div>
        </fieldset>

        {/* 5. Ações de regeneração e status */}
        <div className="ai-copilot-actions-bar">
          <span style={{ fontSize: 'var(--fs-footnote)', color: 'var(--label-2)' }}>
            Ficha gerada dinamicamente via catálogo PR Fit
          </span>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={handleRegenerate}
            aria-label="Regenerar sugestão com IA"
          >
            <Icon name="sparkles" />
            <span style={{ marginLeft: 6 }}>Regenerar sugestão</span>
          </Button>
        </div>

        {/* 6. Pré-visualização da Ficha */}
        <section className="ai-preview-card" aria-label="Ficha de treino sugerida">
          <div className="ai-preview-header">
            <div className="ai-preview-title-row">
              <h3>{generatedWorkout.name}</h3>
              <div className="ai-preview-badges">
                <Badge tone="neutral">{generatedWorkout.frequency}</Badge>
                <Badge tone="neutral">~{generatedWorkout.summary.estimatedDurationMinutes} min</Badge>
                <Badge tone="neutral">{generatedWorkout.summary.totalExercises} exercícios no total</Badge>
              </div>
            </div>

            {generatedWorkout.summary.safetyNotes.length > 0 && (
              <div className="ai-safety-alert" role="status">
                <Icon name="shield" />
                <div>
                  <strong>Ajustes de segurança ativados:</strong>{' '}
                  {generatedWorkout.summary.safetyNotes.join(' ')}
                </div>
              </div>
            )}
          </div>

          {/* Abas das Divisões */}
          {generatedWorkout.divisions.length > 1 && (
            <div className="ai-division-tabs" role="tablist" aria-label="Divisões do treino">
              {generatedWorkout.divisions.map((div, index) => {
                const isActive = index === safeDivisionIndex
                return (
                  <button
                    key={index}
                    type="button"
                    role="tab"
                    id={`division-tab-${index}`}
                    aria-selected={isActive}
                    aria-controls={`division-panel-${index}`}
                    className={`ai-division-tab ${isActive ? 'active' : ''}`}
                    onClick={() => setActiveDivisionTab(index)}
                  >
                    {div.name.split(' - ')[0] || `Treino ${String.fromCharCode(65 + index)}`}
                  </button>
                )
              })}
            </div>
          )}

          {/* Lista de Exercícios da Divisão Selecionada */}
          <div
            id={`division-panel-${safeDivisionIndex}`}
            role="tabpanel"
            aria-labelledby={`division-tab-${safeDivisionIndex}`}
            className="ai-exercises-list"
          >
            <div style={{ padding: '0 4px 6px', color: 'var(--label-2)', fontSize: 'var(--fs-footnote)' }}>
              <strong>{activeDivision.name}</strong> · {activeDivision.description}
            </div>

            {activeDivision.exercises.map((exercise, exerciseIndex) => (
              <article key={exerciseIndex} className="ai-exercise-card">
                <div className="ai-exercise-top">
                  <div className="ai-exercise-name">
                    {exerciseIndex + 1}. {exercise.name}
                  </div>
                  <span className="ai-exercise-meta">
                    {exercise.targetMuscle} · {exercise.equipment}
                  </span>
                </div>

                <div className="ai-exercise-stats">
                  <span className="ai-stat-chip">
                    <strong>{exercise.sets}</strong> séries
                  </span>
                  <span className="ai-stat-chip">
                    <strong>{exercise.reps}</strong> reps
                  </span>
                  <span className="ai-stat-chip">
                    <strong>{exercise.restSeconds}s</strong> descanso
                  </span>
                </div>

                {exercise.notes && (
                  <p className="ai-exercise-notes">{exercise.notes}</p>
                )}

                {exercise.safetyAlert && (
                  <div className="ai-exercise-safety">
                    <Icon name="shield" />
                    <span>{exercise.safetyAlert}</span>
                  </div>
                )}
              </article>
            ))}
          </div>
        </section>

        {/* Rodapé */}
        <div className="ai-copilot-footer">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            type="button"
            variant="primary"
            onClick={handleApply}
            data-testid="apply-ai-workout-btn"
          >
            <Icon name="check" />
            <span style={{ marginLeft: 6 }}>
              {targetMode === 'routine' && generatedWorkout.divisions.length > 1
                ? `Aplicar ${activeDivision.name.split(' - ')[0]} à rotina`
                : 'Aplicar este treino'}
            </span>
          </Button>
        </div>
      </div>
    </Modal>
  )
}
