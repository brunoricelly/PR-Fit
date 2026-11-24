import React, { useEffect, useMemo, useRef, useState } from 'react'
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
import { api } from '../lib/api.js'
import './AiWorkoutGeneratorModal.css'

const AI_TIMEOUT_MS = 50000
const FALLBACK_TEXT = {
  ai_not_configured: 'A IA não está configurada neste servidor.',
  timeout: 'A IA demorou demais para responder.',
  gateway_busy: 'A IA está ocupada no momento.',
  gateway_auth: 'A IA recusou a credencial do servidor.',
  gateway_error: 'A IA está indisponível agora.',
  network: 'Não foi possível falar com a IA.',
  not_json: 'A IA devolveu uma resposta que não pôde ser usada.',
  empty: 'A IA devolveu uma resposta vazia.',
  no_valid_exercises: 'A IA não sugeriu exercícios válidos.',
  too_few_divisions: 'A IA devolveu menos treinos do que o pedido.',
}

// The server's validated routine in the shape the preview and the editor already use.
export function aiPlanFrom(result) {
  const r = result.resolved
  const divisions = result.routine.divisions.map((division, index) => ({
    name: division.name,
    description: division.exercises.map(e => e.targetMuscle).filter((m, i, a) => m && a.indexOf(m) === i).slice(0, 4).join(', ') || `Treino ${String.fromCharCode(65 + index)}`,
    exercises: division.exercises.map(e => ({ ...e, safetyAlert: null })),
  }))
  const safetyNotes = (r.restrictions || []).map(x => `Exercícios com carga alta em ${x} foram removidos da ficha.`)
  return {
    name: result.routine.name,
    frequency: `${r.daysPerWeek}x por semana`,
    notes: result.routine.rationale || result.routine.notes || '',
    objective: r.objective, split: r.split, level: r.level, restrictions: r.restrictions || [],
    summary: { totalExercises: divisions.reduce((n, d) => n + d.exercises.length, 0), estimatedDurationMinutes: r.level === 'iniciante' ? 45 : r.level === 'avancado' ? 65 : 55, safetyNotes },
    divisions,
    source: 'ai',
  }
}

const SOURCE_TEXT = { coach: 'definido por você', athlete: 'vindo do aluno', 'coach+athlete': 'você + aluno', default: 'padrão (sem dado do aluno)', none: 'nenhuma' }

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
  const [touched, setTouched] = useState({})
  const [ai, setAi] = useState({ status: 'idle' })
  const abortRef = useRef(null)
  const athleteId = initialAthlete?.id || null
  const touch = key => { setTouched(c => ({ ...c, [key]: true })); setAi(c => (c.status === 'loading' ? c : { status: 'idle' })) }
  useEffect(() => () => abortRef.current?.abort(), [])

  const buildWithAthleteData = async () => {
    if (!athleteId || ai.status === 'loading') return
    abortRef.current?.abort()
    const ctl = new AbortController()
    abortRef.current = ctl
    setAi({ status: 'loading' })
    const body = {}
    if (touched.objective) body.objective = objective
    if (touched.level) body.level = level
    if (touched.split) body.split = split
    if (touched.restrictions) body.restrictions = restrictions
    try {
      const result = await api(`/api/coach/athletes/${encodeURIComponent(athleteId)}/ai-workout`, { method: 'POST', body: JSON.stringify(body), timeout: AI_TIMEOUT_MS, signal: ctl.signal })
      if (ctl.signal.aborted) return
      const r = result.resolved || {}
      if (r.objective) setObjective(r.objective)
      if (r.level) setLevel(r.level)
      if (r.split) setSplit(r.split)
      if (Array.isArray(r.restrictions)) setRestrictions(r.restrictions)
      setActiveDivisionTab(0)
      if (result.source === 'ai' && result.routine) setAi({ status: 'ready', result, plan: aiPlanFrom(result) })
      else setAi({ status: 'fallback', result, reason: FALLBACK_TEXT[result.fallbackReason] || 'A IA não respondeu.' })
    } catch (error) {
      if (ctl.signal.aborted) return
      setAi({ status: 'error', message: error?.status === 403 || error?.status === 404 ? 'Sem vínculo ativo com permissão de treino para este aluno.' : error?.status === 429 ? 'Muitas tentativas seguidas. Aguarde um pouco.' : error?.code === 'timeout' ? 'O servidor demorou demais para responder.' : 'Não foi possível montar com a IA agora.' })
    }
  }

  const toggleRestriction = restrictionId => {
    setRestrictions(current =>
      current.includes(restrictionId)
        ? current.filter(id => id !== restrictionId)
        : [...current, restrictionId]
    )
  }

  const rulesWorkout = useMemo(() => {
    return generateAiWorkout({
      objective,
      split,
      level,
      restrictions,
      focus,
      seed,
    })
  }, [objective, split, level, restrictions, focus, seed])
  const generatedWorkout = ai.status === 'ready' ? ai.plan : rulesWorkout

  const safeDivisionIndex = Math.min(activeDivisionTab, generatedWorkout.divisions.length - 1)
  const activeDivision = generatedWorkout.divisions[safeDivisionIndex] || generatedWorkout.divisions[0]

  const handleApply = () => {
    if (typeof onApply === 'function') {
      onApply(generatedWorkout, safeDivisionIndex)
    }
    onClose?.()
  }

  const handleRegenerate = () => {
    if (athleteId && ai.status !== 'idle' && ai.status !== 'error') { buildWithAthleteData(); return }
    setAi({ status: 'idle' })
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
                  onClick={() => { setObjective(obj.id); touch('objective') }}
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
                    touch('split')
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
                  onClick={() => { setLevel(lvl.id); touch('level') }}
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
                  onClick={() => { toggleRestriction(rest.id); touch('restrictions') }}
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
            {ai.status === 'ready' ? 'Ficha montada pela IA com os dados do aluno' : 'Ficha por regras do catálogo PR Fit'}
          </span>
          {athleteId && (
            <Button
              type="button"
              size="sm"
              variant="primary"
              disabled={ai.status === 'loading'}
              onClick={buildWithAthleteData}
              data-testid="ai-build-with-athlete"
            >
              <Icon name="sparkles" />
              <span style={{ marginLeft: 6 }}>{ai.status === 'loading' ? 'Montando com a IA…' : 'Montar com os dados do aluno'}</span>
            </Button>
          )}
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

        {ai.status === 'loading' && (
          <p className="ai-copilot-status" role="status" data-testid="ai-status">Lendo o perfil e o histórico do aluno e montando a ficha. Leva até alguns segundos; as opções acima continuam valendo.</p>
        )}
        {ai.status === 'fallback' && (
          <p className="ai-copilot-status warn" role="alert" data-testid="ai-status">{ai.reason} Mostrando a ficha por regras, já com o perfil do aluno aplicado.</p>
        )}
        {ai.status === 'error' && (
          <p className="ai-copilot-status warn" role="alert" data-testid="ai-status">{ai.message} Você ainda pode usar a ficha por regras abaixo.</p>
        )}
        {ai.status === 'ready' && (
          <div className="ai-copilot-status ok" data-testid="ai-rationale">
            <strong>Por que esta ficha:</strong> {ai.result.routine.rationale || 'Montada com base nos dados do aluno.'}
            <div className="ai-copilot-sources">
              Objetivo: {SOURCE_TEXT[ai.result.resolved.sources.objective]} · Nível: {SOURCE_TEXT[ai.result.resolved.sources.level]} · Dias/semana: {SOURCE_TEXT[ai.result.resolved.sources.daysPerWeek]} · Restrições: {SOURCE_TEXT[ai.result.resolved.sources.restrictions]}
              {!ai.result.facts.hasIntake && ' · O aluno ainda não preencheu o perfil: revise a ficha com atenção.'}
            </div>
          </div>
        )}

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
