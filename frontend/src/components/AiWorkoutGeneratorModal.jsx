import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Modal from './Modal.jsx'
import Icon from './Icon.jsx'
import { Badge, Button } from './design-system.jsx'
import {
  FOCUS_AREAS,
  generateAiWorkout,
  LEVELS,
  OBJECTIVES,
  RESTRICTIONS,
  RULES_LEVEL_BOUNDS,
  SPLITS,
  verifyWorkoutPlan,
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
const DENIED = new Set([401, 403, 404])
const SEED_TRIES = 8
const IDLE = Object.freeze({ status: 'idle' })
const known = (list, id) => list.some(item => item.id === id)

// Level caps from the API (`levelBounds`: either one bounds object or a map keyed by level), else the local ones.
function boundsFor(result, level) {
  const raw = result?.levelBounds ?? result?.resolved?.levelBounds
  const own = raw && typeof raw === 'object' ? (raw[level] && typeof raw[level] === 'object' ? raw[level] : raw) : null
  const clean = own && (Number.isFinite(+own.maxSets) || Number.isFinite(+own.maxExercisesPerDivision)) ? own : null
  return { api: clean, rules: clean || RULES_LEVEL_BOUNDS[level] || null }
}

// First rules plan (a few seeds) that passes the independent verification, else null.
function findSafeRulesPlan({ objective, split, level, restrictions, focus = 'equilibrado', seed = 0 }, check) {
  for (let k = 0; k < SEED_TRIES; k++) {
    const plan = generateAiWorkout({ objective, split, level, restrictions, focus, seed: seed + k, allowedIds: check.allowedIds })
    if (verifyWorkoutPlan(plan, check).ok) return plan
  }
  return null
}

// Turns the server answer into what the modal shows. Never produces a plan that failed verification.
function interpretResult(result) {
  const r = result?.resolved || {}
  const allowed = Array.isArray(result?.allowedExerciseIds) ? result.allowedExerciseIds.map(String) : null
  const bounds = boundsFor(result, r.level)
  const restrictions = Array.isArray(r.restrictions) ? r.restrictions : []
  let reason = FALLBACK_TEXT[result?.fallbackReason] || 'A IA não respondeu.'
  if (result?.source === 'ai' && Array.isArray(result?.routine?.divisions)) {
    let plan = null
    try { plan = aiPlanFrom(result) } catch { plan = null }
    if (plan && verifyWorkoutPlan(plan, { allowedIds: allowed, restrictions, bounds: bounds.api, trustUnknownFlags: true }).ok) {
      return { status: 'ready', result, plan, manualReview: result.manualReview === true }
    }
    reason = 'A ficha da IA não passou na verificação de segurança.'
  }
  const complete = known(OBJECTIVES, r.objective) && known(SPLITS, r.split) && known(LEVELS, r.level)
  // Personalized fallback needs the server's authoritative exercise list; without it nothing can be proven safe.
  const plan = complete && allowed && result?.manualReview !== true
    ? findSafeRulesPlan({ objective: r.objective, split: r.split, level: r.level, restrictions }, { allowedIds: allowed, restrictions, bounds: bounds.rules })
    : null
  return { status: 'fallback', result, reason, plan: plan ? { ...plan, source: 'rules' } : null }
}

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
  const [ai, setAi] = useState(IDLE)
  const reqRef = useRef({ id: 0, ctl: null })
  const inFlightRef = useRef(false)
  const appliedRef = useRef(false)
  const athleteId = initialAthlete?.id || null

  // Invalidates whatever request is pending: its answer can no longer change anything.
  const cancelPending = useCallback(() => {
    reqRef.current.id += 1
    reqRef.current.ctl?.abort()
    reqRef.current.ctl = null
    inFlightRef.current = false
  }, [])
  useEffect(() => () => cancelPending(), [cancelPending])

  // Closing/reopening or switching athlete starts from scratch: nothing from the previous athlete may leak.
  const identity = `${isOpen ? 1 : 0}|${athleteId || ''}`
  const identityRef = useRef(identity)
  useEffect(() => {
    if (identityRef.current === identity) return
    identityRef.current = identity
    cancelPending()
    appliedRef.current = false
    setObjective('hipertrofia'); setSplit('ppl'); setLevel('intermediario'); setRestrictions([]); setFocus('equilibrado')
    setSeed(0); setActiveDivisionTab(0); setTouched({}); setAi(IDLE)
  }, [identity, cancelPending])

  // A plan shown for another athlete (render before the reset effect ran) is never used.
  const aiView = ai.athleteId !== undefined && ai.athleteId !== athleteId ? IDLE : ai

  // A coach edit wins over any answer still on its way: the pending request is dropped, not merged.
  const touch = key => {
    setTouched(c => ({ ...c, [key]: true }))
    appliedRef.current = false
    if (inFlightRef.current) {
      cancelPending()
      setAi({ status: 'idle', notice: 'Você alterou as opções enquanto a IA respondia; essa resposta foi descartada. Monte de novo para usar os dados do aluno.' })
    } else setAi(c => (c.status === 'idle' && c.notice ? c : IDLE))
  }

  const buildWithAthleteData = async () => {
    if (!athleteId || inFlightRef.current) return
    cancelPending()
    const ctl = new AbortController()
    const id = reqRef.current.id
    reqRef.current.ctl = ctl
    inFlightRef.current = true
    appliedRef.current = false
    const requestedFor = athleteId
    setAi({ status: 'loading', athleteId: requestedFor })
    const body = {}
    if (touched.objective) body.objective = objective
    if (touched.level) body.level = level
    if (touched.split) body.split = split
    if (touched.restrictions) body.restrictions = restrictions
    const stale = () => reqRef.current.id !== id || ctl.signal.aborted
    try {
      const result = await api(`/api/coach/athletes/${encodeURIComponent(requestedFor)}/ai-workout`, { method: 'POST', body: JSON.stringify(body), timeout: AI_TIMEOUT_MS, signal: ctl.signal })
      if (stale()) return
      inFlightRef.current = false
      const r = result?.resolved || {}
      if (known(OBJECTIVES, r.objective)) setObjective(r.objective)
      if (known(LEVELS, r.level)) setLevel(r.level)
      if (known(SPLITS, r.split)) setSplit(r.split)
      if (Array.isArray(r.restrictions)) setRestrictions(r.restrictions)
      setActiveDivisionTab(0)
      setAi({ ...interpretResult(result), athleteId: requestedFor })
    } catch (error) {
      if (stale()) return
      inFlightRef.current = false
      const status = error?.status
      setAi({
        status: 'error', athleteId: requestedFor, denied: DENIED.has(status),
        message: status === 401 ? 'Sua sessão expirou ou não tem permissão. Entre de novo para usar os dados do aluno.'
          : status === 403 || status === 404 ? 'Sem vínculo ativo com permissão de treino para este aluno.'
            : status === 429 ? 'Muitas tentativas seguidas. Aguarde um pouco.'
              : error?.code === 'timeout' ? 'O servidor demorou demais para responder.' : 'Não foi possível montar com a IA agora.',
      })
    }
  }

  const toggleRestriction = restrictionId => {
    setRestrictions(current =>
      current.includes(restrictionId)
        ? current.filter(id => id !== restrictionId)
        : [...current, restrictionId]
    )
  }

  // Local rules plan (no athlete data). null when no variation passes the safety verification.
  const rulesWorkout = useMemo(() => findSafeRulesPlan(
    { objective, split, level, restrictions, focus, seed },
    { restrictions, bounds: RULES_LEVEL_BOUNDS[level] || null },
  ), [objective, split, level, restrictions, focus, seed])

  const loading = aiView.status === 'loading'
  const denied = aiView.status === 'error' && aiView.denied === true
  const manualReview = (aiView.status === 'fallback' && !aiView.plan) || (aiView.status !== 'ready' && aiView.status !== 'fallback' && !rulesWorkout)
  const generatedWorkout = aiView.status === 'ready' || (aiView.status === 'fallback' && aiView.plan) ? aiView.plan : aiView.status === 'fallback' ? null : rulesWorkout
  const canApply = !!generatedWorkout && !loading && !denied

  const safeDivisionIndex = generatedWorkout ? Math.min(activeDivisionTab, generatedWorkout.divisions.length - 1) : 0
  const activeDivision = generatedWorkout ? (generatedWorkout.divisions[safeDivisionIndex] || generatedWorkout.divisions[0]) : null

  const handleClose = () => { cancelPending(); onClose?.() }

  const handleApply = () => {
    if (!canApply || appliedRef.current) return
    appliedRef.current = true
    cancelPending()
    try {
      if (typeof onApply === 'function') onApply(generatedWorkout, safeDivisionIndex)
    } catch (error) { appliedRef.current = false; throw error }
    onClose?.()
  }

  const handleRegenerate = () => {
    if (loading || inFlightRef.current) return
    if (athleteId && aiView.status !== 'idle' && aiView.status !== 'error') { buildWithAthleteData(); return }
    setAi(IDLE)
    appliedRef.current = false
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
      onClose={handleClose}
      className="ai-copilot-modal"
      closeLabel="Fechar copiloto"
    >
      <div className="ai-copilot-content">
        <p className="ai-copilot-intro">
          Copiloto para o treinador. Selecione as preferências: a ficha por regras usa exercícios do catálogo
          do PR Fit, com séries, reps, descansos e filtro de restrições articulares. {athleteId
            ? 'Para a IA usar o perfil e o histórico do aluno, use “Montar com os dados do aluno”.'
            : 'Sem aluno vinculado, a ficha é sempre por regras locais, sem IA.'}
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
            {aiView.status === 'ready' ? 'Ficha montada pela IA com os dados do aluno'
              : aiView.status === 'fallback' ? (aiView.plan ? 'Ficha por regras, não gerada pela IA' : 'Sem ficha segura automática')
                : denied ? 'Sem acesso aos dados do aluno'
                  : 'Ficha por regras locais (sem IA, sem dados do aluno)'}
          </span>
          {athleteId && (
            <Button
              type="button"
              size="sm"
              variant="primary"
              disabled={loading}
              onClick={buildWithAthleteData}
              data-testid="ai-build-with-athlete"
            >
              <Icon name="sparkles" />
              <span style={{ marginLeft: 6 }}>{loading ? 'Montando com a IA…' : 'Montar com os dados do aluno'}</span>
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={handleRegenerate}
            disabled={loading}
            aria-label={athleteId && aiView.status !== 'idle' && aiView.status !== 'error' ? 'Regenerar sugestão com IA' : 'Gerar outra variação por regras'}
          >
            <Icon name="sparkles" />
            <span style={{ marginLeft: 6 }}>Regenerar sugestão</span>
          </Button>
        </div>

        {aiView.status === 'idle' && aiView.notice && (
          <p className="ai-copilot-status warn" role="status" data-testid="ai-status">{aiView.notice}</p>
        )}
        {loading && (
          <p className="ai-copilot-status" role="status" data-testid="ai-status">Lendo o perfil e o histórico do aluno e montando a ficha. Leva até alguns segundos. Se você mudar uma opção agora, a resposta da IA será descartada.</p>
        )}
        {aiView.status === 'fallback' && aiView.plan && (
          <p className="ai-copilot-status warn" role="alert" data-testid="ai-status">{aiView.reason} Mostrando uma ficha por regras (não é da IA), filtrada pela lista de exercícios permitidos para este aluno. Revise antes de aplicar.</p>
        )}
        {aiView.status === 'fallback' && !aiView.plan && (
          <p className="ai-copilot-status warn" role="alert" data-testid="ai-status">{aiView.reason} Não foi possível montar uma ficha automática segura para este aluno. Monte ou edite a ficha manualmente no editor; nada foi aplicado.</p>
        )}
        {aiView.status === 'error' && (
          <p className="ai-copilot-status warn" role="alert" data-testid="ai-status">{aiView.message} {denied
            ? 'A ficha automática foi desativada. Altere uma opção acima para usar apenas a ficha local por regras, sem dados do aluno.'
            : 'Você ainda pode usar a ficha local por regras abaixo (sem IA e sem dados do aluno).'}</p>
        )}
        {aiView.status === 'ready' && (
          <div className="ai-copilot-status ok" data-testid="ai-rationale">
            <strong>Por que esta ficha:</strong> {aiView.result.routine.rationale || 'Montada com base nos dados do aluno.'}
            <div className="ai-copilot-sources">
              Objetivo: {SOURCE_TEXT[aiView.result.resolved.sources?.objective] || SOURCE_TEXT.none} · Nível: {SOURCE_TEXT[aiView.result.resolved.sources?.level] || SOURCE_TEXT.none} · Dias/semana: {SOURCE_TEXT[aiView.result.resolved.sources?.daysPerWeek] || SOURCE_TEXT.none} · Restrições: {SOURCE_TEXT[aiView.result.resolved.sources?.restrictions] || SOURCE_TEXT.none}
              {!aiView.result.facts?.hasIntake && ' · O aluno ainda não preencheu o perfil: revise a ficha com atenção.'}
              {aiView.manualReview && ' · O servidor pediu revisão manual: confira cada exercício antes de aplicar.'}
            </div>
          </div>
        )}
        {!generatedWorkout && aiView.status !== 'fallback' && !denied && !loading && (
          <p className="ai-copilot-status warn" role="alert" data-testid="ai-manual-only">Nenhuma ficha automática passou na verificação de segurança com estas opções. Monte a ficha manualmente no editor.</p>
        )}

        {/* 6. Pré-visualização da Ficha */}
        {generatedWorkout && !denied && (
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
        )}

        {/* Rodapé */}
        <div className="ai-copilot-footer">
          <Button type="button" variant="secondary" onClick={handleClose}>
            Cancelar
          </Button>
          <Button
            type="button"
            variant="primary"
            onClick={handleApply}
            disabled={!canApply}
            data-testid="apply-ai-workout-btn"
          >
            <Icon name="check" />
            <span style={{ marginLeft: 6 }}>
              {targetMode === 'routine' && generatedWorkout && generatedWorkout.divisions.length > 1
                ? `Aplicar ${activeDivision.name.split(' - ')[0]} à rotina`
                : 'Aplicar este treino'}
            </span>
          </Button>
        </div>
      </div>
    </Modal>
  )
}
