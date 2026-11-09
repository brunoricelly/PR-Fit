import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../../lib/api.js'
import { communicationApi, browserTimeZone } from '../../lib/communication-api.js'
import { getAthleteAppointments } from '../../lib/scheduling-api.js'
import { effectiveRoutineIds, effectiveRoutines } from '../../lib/history.js'
import { todayISO } from '../../lib/format.js'
import { queueOf, weekTally } from '../../lib/queue.js'
import { isOn } from '../../lib/modules.js'
import { startFlow } from '../../sheets.jsx'
import { useStore } from '../../store/useStore.js'
import { useUI } from '../../store/useUI.js'
import { useOnline } from '../../components/ServerSync.jsx'
import { latestMeasurement } from '../../lib/measurements.js'
import { fmtNum } from '../../lib/format.js'
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  LiveFeedback,
  PageHeader,
  Skeleton,
  Surface,
} from '../../components/design-system.jsx'
import Icon from '../../components/Icon.jsx'
import FirstSteps from '../../components/FirstSteps.jsx'
import {
  loadingSource,
  normalizeAppointments,
  normalizeChallenges,
  normalizeConversations,
  normalizeHabits,
  normalizeMealAdherence,
  normalizeMealPlan,
  settledSource,
  sourceSucceeded,
  unavailableSource,
} from './dashboard-data.js'
import './DashboardHome.css'

const localToday = () => todayISO()
const sourceEmpty = data => !data || data.length === 0
const planEmpty = plan => plan === null
const normalizePrescriptions = payload => (Array.isArray(payload?.prescriptions) ? payload.prescriptions : [])

function AthleteLoading() {
  return <main className="ds-scope dashboard-page dashboard-page-athlete" aria-busy="true" aria-label="Carregando Hoje">
    <div className="dashboard-shell">
      <Skeleton width="6rem" height="1rem" />
      <Skeleton width="min(24rem, 84%)" height="2.5rem" />
      <Skeleton height="13rem" />
      <div className="dashboard-loading-grid" aria-hidden="true"><Skeleton height="9rem" /><Skeleton height="9rem" /></div>
    </div>
  </main>
}

function UnavailableSummary({ title, text }) {
  return <Surface className="dashboard-pulse-empty dashboard-pulse-unavailable" role="status">
    <Icon name="cloudSlash" aria-hidden="true" /><span><strong>{title}</strong><br />{text}</span>
  </Surface>
}

export default function AthleteToday() {
  const navigate = useNavigate()
  const S = useStore(state => state.S)
  const user = useStore(state => state.user)
  const ready = useStore(state => state.ready)
  const online = useOnline()
  const [remoteState, setRemoteState] = useState(null)
  const [loading, setLoading] = useState(true)
  const generationRef = useRef(0)
  const controllerRef = useRef(null)
  const mountedRef = useRef(false)
  const userIdRef = useRef(user?.id)
  userIdRef.current = user?.id

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      generationRef.current += 1
      controllerRef.current?.abort()
    }
  }, [])

  const load = useCallback(async () => {
    const userId = user?.id
    if (!userId) return
    const dualRole = user.profile?.kind === 'coach'
    const generation = generationRef.current + 1
    generationRef.current = generation
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    const current = () => mountedRef.current && generationRef.current === generation
      && userIdRef.current === userId && !controller.signal.aborted
    const pendingSources = {
      inbox: dualRole
        ? unavailableSource('O inbox não separa os papéis desta conta.')
        : loadingSource(),
      appointments: loadingSource(),
      nutritionPlan: loadingSource(),
      nutritionAdherence: loadingSource(),
      habits: dualRole
        ? unavailableSource('Hábitos exigem uma identidade contratualmente autorizada como atleta.')
        : loadingSource(),
      prescriptions: dualRole
        ? unavailableSource('Prescrições exigem perfil de atleta.')
        : loadingSource(),
      challenges: loadingSource(),
    }
    setRemoteState({ userId, sources: pendingSources })
    setLoading(true)

    const date = localToday()
    const now = new Date()
    const until = new Date(now)
    until.setDate(until.getDate() + 30)
    const requestOptions = { signal: controller.signal }
    const requests = [
      dualRole ? Promise.resolve(null) : communicationApi.inbox({ limit: 100 }, requestOptions),
      getAthleteAppointments({ status: 'scheduled', from: now.toISOString(), to: until.toISOString(), limit: 20 }, requestOptions),
      api('/api/athlete/meal-plan', requestOptions),
      api(`/api/athlete/meal-adherence?date=${date}`, requestOptions),
      dualRole ? Promise.resolve(null) : communicationApi.athleteHabits(browserTimeZone().value, requestOptions),
      dualRole ? Promise.resolve(null) : api('/api/athlete/prescriptions', requestOptions),
      api('/api/athlete/challenges?limit=10', requestOptions),
    ]
    const [inboxResult, appointmentsResult, planResult, adherenceResult, habitsResult, prescriptionsResult, challengesResult] = await Promise.allSettled(requests)
    if (!current()) return

    const sources = {
      inbox: dualRole
        ? pendingSources.inbox
        : settledSource(inboxResult, normalizeConversations, sourceEmpty),
      appointments: settledSource(appointmentsResult, normalizeAppointments, sourceEmpty),
      nutritionPlan: settledSource(planResult, normalizeMealPlan, planEmpty),
      nutritionAdherence: settledSource(adherenceResult, normalizeMealAdherence, sourceEmpty),
      habits: dualRole
        ? pendingSources.habits
        : settledSource(habitsResult, normalizeHabits, sourceEmpty),
      prescriptions: dualRole
        ? pendingSources.prescriptions
        : settledSource(prescriptionsResult, normalizePrescriptions, sourceEmpty),
      challenges: settledSource(challengesResult, normalizeChallenges, sourceEmpty),
    }
    setRemoteState({ userId, sources })
    setLoading(false)
  }, [user?.id, user?.profile?.kind])

  useEffect(() => { if (ready) load() }, [load, ready])
  useEffect(() => {
    const retry = () => load()
    window.addEventListener('online', retry)
    return () => window.removeEventListener('online', retry)
  }, [load])

  const local = useMemo(() => {
    const routines = effectiveRoutines(S, localToday())
    const logged = S.workouts.filter(workout => workout.d === localToday())
    const queueIds = queueOf(S)?.ids || []
    const covered = id => !queueIds.includes(id) && logged.some(workout => (Array.isArray(workout.routineIds) ? workout.routineIds : [workout.routineId]).includes(id))
    const done = routines.length > 0 && routines.every(routine => covered(routine.id))
    let weekly = null
    try { weekly = weekTally(S, localToday()) } catch { weekly = null }
    return { routines, done, weekly }
  }, [S])

  if (!ready) return <AthleteLoading />

  const remote = remoteState && remoteState.userId === user?.id ? remoteState.sources : null
  const firstName = user?.name?.trim().split(/\s+/)[0] || 'Atleta'
  const activeSession = !!S.active
  const editingWorkout = !!S.active?.editingWorkoutId
  const workoutInProgress = activeSession && !editingWorkout
  const action = activeSession
    ? { label: editingWorkout ? 'Continuar edição' : 'Continuar treino', detail: S.active.name || (editingWorkout ? 'Edição em andamento' : 'Treino em andamento'), run: () => navigate('/workout'), icon: editingWorkout ? 'pencil' : 'play' }
    : local.routines.length && !local.done
      ? { label: 'Iniciar treino', detail: local.routines.map(routine => routine.name).join(' + '), run: () => startFlow(effectiveRoutineIds(S, localToday())), icon: 'play' }
      : local.done
        ? { label: 'Ver treino concluído', detail: local.routines.map(routine => routine.name).join(' + '), run: () => navigate('/history'), icon: 'checkCircle' }
        : { label: 'Montar meu plano', detail: 'Nenhum treino programado para hoje', run: () => navigate('/plan'), icon: 'calendar' }

  const challenges = remote?.challenges?.data || []
  const activeChallenge = sourceSucceeded(remote?.challenges)
    ? challenges.find(c => c.status === "active") || null
    : null
  const appointments = remote?.appointments?.data || []
  const nextAppointment = appointments.slice().sort((left, right) => new Date(left.startAt) - new Date(right.startAt))[0]
  const conversations = remote?.inbox?.data || []
  const unread = sourceSucceeded(remote?.inbox)
    ? conversations.reduce((sum, item) => sum + item.unreadCount, 0)
    : 0
  const plan = remote?.nutritionPlan?.data || null
  const adherenceRecords = remote?.nutritionAdherence?.data || []
  const adherence = plan && sourceSucceeded(remote?.nutritionAdherence)
    ? adherenceRecords.find(item => item.mealPlanId === plan.id) || null
    : null

  const pullState = useStore(state => state.pullState)
  const toast = useUI(state => state.toast)
  const [adoptingPrescription, setAdoptingPrescription] = useState(null)
  const [checkingInId, setCheckingInId] = useState(null)
  const [habitLiveFeedback, setHabitLiveFeedback] = useState('')

  const adoptPrescription = async prescription => {
    setAdoptingPrescription(prescription.id)
    try {
      await api(`/api/athlete/prescriptions/${prescription.id}/adopt`, { method: 'POST', body: '{}' })
      if (pullState) await pullState()
      toast('Prescrição aplicada ao seu Plano de Treino.')
      await load()
    } catch {
      toast('Não foi possível adotar a rotina. Tente novamente.')
    } finally {
      setAdoptingPrescription(null)
    }
  }

  const handleQuickCheckin = async habit => {
    if (checkingInId || habit.relationship?.readOnly) return
    const isCompleted = !!habit.checkin?.completed
    const nextCompleted = !isCompleted
    const targetValue = Number(habit.targetValue || 1)
    const timeZone = browserTimeZone().value
    const habitDate = habit.date || localToday()
    setCheckingInId(habit.id)
    setHabitLiveFeedback('')
    try {
      if (typeof communicationApi?.checkin !== 'function') throw new Error('checkin not supported')
      const result = await communicationApi.checkin(timeZone, {
        habitId: habit.id,
        date: habitDate,
        value: nextCompleted ? targetValue : 0,
        completed: nextCompleted,
        notes: habit.checkin?.notes || '',
      })
      setRemoteState(current => {
        if (!current?.sources?.habits?.data) return current
        const nextHabits = current.sources.habits.data.map(item => {
          if (item.id !== habit.id) return item
          const streakDelta = nextCompleted ? 1 : (item.currentStreak > 0 ? -1 : 0)
          const currentStreak = typeof item.currentStreak === 'number' ? Math.max(0, item.currentStreak + streakDelta) : undefined
          return {
            ...item,
            checkin: result.checkin,
            ...(currentStreak !== undefined ? { currentStreak } : {}),
          }
        })
        return {
          ...current,
          sources: {
            ...current.sources,
            habits: {
              ...current.sources.habits,
              data: nextHabits,
            },
          },
        }
      })
      const msg = nextCompleted ? 'Check-in realizado com sucesso.' : 'Check-in marcado como pendente.'
      setHabitLiveFeedback(msg)
      toast(msg)
    } catch {
      const errMsg = 'Não foi possível salvar o check-in. Tente novamente.'
      setHabitLiveFeedback(errMsg)
      toast(errMsg)
    } finally {
      setCheckingInId(null)
    }
  }

  const prescriptions = remote?.prescriptions?.data || []
  const availablePrescription = prescriptions.find(item => item.state === 'available' || (!item.adoptedRoutineIds?.length && item.state !== 'withdrawn'))
  const checkedMeals = new Set(adherence?.mealsChecked || []).size
  const mealCount = plan?.meals.length || 0
  const water = adherence?.waterDrunkMl || 0
  const waterGoal = plan?.targetMacros?.waterMl || 0
  const habits = remote?.habits?.data || []
  const completedHabits = habits.filter(habit => habit.checkin?.completed).length
  const remoteErrors = remote ? Object.values(remote).filter(source => source.status === 'error') : []
  const remoteContent = !!(nextAppointment || unread || plan || habits.length)
  const sourcesKnownEmpty = remote && ['inbox', 'appointments', 'nutritionPlan', 'nutritionAdherence', 'habits']
    .every(key => remote[key].status === 'empty')
  const athleteSteps = [
    { id: 'profile', title: 'Revise seu perfil', text: 'Confira seus dados e preferências.', route: '/settings', cta: 'Abrir perfil', completion: 'visit' },
    { id: 'plan', title: 'Entenda seu plano', text: 'Veja os treinos e a organização da semana.', route: '/plan', cta: 'Abrir Meu plano', completion: 'visit', completed: S.routines.length > 0 },
    { id: 'first-workout', title: workoutInProgress ? 'Continue seu treino' : 'Inicie seu primeiro treino', text: workoutInProgress ? 'Seu treino em andamento está pronto para continuar.' : 'Comece quando houver um treino pronto para você.', route: workoutInProgress ? '/workout' : '/plan', cta: workoutInProgress ? 'Continuar treino' : 'Ver treinos', completion: 'evidence', completed: workoutInProgress || S.workouts.length > 0 },
    { id: 'evolution', title: 'Conheça sua Evolução', text: 'Acompanhe histórico, volume e medidas.', route: '/stats', cta: 'Abrir Evolução', completion: 'visit' },
    { id: 'community', title: 'Conheça a Comunidade', text: 'Explore grupos, programas e desafios.', route: '/community', cta: 'Abrir Comunidade', completion: 'visit' },
  ]

  return <main className="ds-scope dashboard-page dashboard-page-athlete">
    <div className="dashboard-shell">
      <PageHeader
        eyebrow="Hoje"
        title={`Olá, ${firstName}.`}
        description={new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' })}
      />

      <Card className="athlete-primary-card">
        <div className="athlete-primary-copy">
          <span className="athlete-primary-icon"><Icon name={action.icon} aria-hidden="true" /></span>
          <div><span className="dashboard-kicker">Seu próximo passo</span><h2>{action.detail}</h2>
            {local.done && <p>Treino do dia concluído. Ótimo trabalho.</p>}
          </div>
        </div>
        <Button variant="primary" onClick={action.run}>{action.label}</Button>
        {!activeSession && local.routines.length > 0 && !local.done && <Button variant="ghost" onClick={() => navigate('/workout')}>Escolher outro treino</Button>}
      </Card>

      <FirstSteps key={`${user.id}:athlete`} userId={user.id} role="athlete" steps={athleteSteps} />

      {availablePrescription && (
        <Card className="athlete-prescription-banner" tone="accent" style={{ margin: '14px 0', border: '1.5px solid var(--acc)' }}>
          <div className="dashboard-section-heading">
            <div>
              <span className="dashboard-kicker">Treino Prescrito</span>
              <h3>{availablePrescription.routine.name}</h3>
            </div>
            <Badge tone="success">Novo</Badge>
          </div>
          <p className="dashboard-muted">
            Prescrito por {availablePrescription.coach?.name || 'Treinador'} · {availablePrescription.routine.divisions.length} divisões
          </p>
          {availablePrescription.routine.notes && (
            <p className="athlete-prescription-notes" style={{ margin: '6px 0', fontSize: 'var(--fs-footnote)' }}>
              {availablePrescription.routine.notes}
            </p>
          )}
          <p className="athlete-prescription-guarantee" style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '8px 0', fontSize: 'var(--fs-footnote)', color: 'var(--label-2)' }}>
            <Icon name="checkCircle" style={{ color: 'var(--green)' }} aria-hidden="true" />
            <span>Ao adotar, o treino entra como sua rotina ativa mantendo seu histórico e marcas anteriores 100% seguros.</span>
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
            <Button
              variant="primary"
              disabled={adoptingPrescription === availablePrescription.id}
              onClick={() => adoptPrescription(availablePrescription)}
            >
              {adoptingPrescription === availablePrescription.id ? 'Adotando…' : 'Adotar treino do treinador'}
            </Button>
            <Button variant="ghost" onClick={() => navigate('/professionals')}>
              Ver detalhes
            </Button>
          </div>
        </Card>
      )}

      {!online && <Alert tone="warning" title="Você está offline">
        O treino continua disponível neste dispositivo. Agenda, mensagens e acompanhamentos serão atualizados quando a conexão voltar.
      </Alert>}
      {online && remoteErrors.length > 0 && <Alert tone="warning" title="Alguns resumos não carregaram" action={<Button size="sm" onClick={load}>Tentar novamente</Button>}>
        Seu treino continua disponível. As seções sem dados confiáveis estão marcadas como indisponíveis.
      </Alert>}

      <section className="athlete-today-grid" aria-labelledby="today-summary-title">
        <div className="dashboard-section-heading dashboard-section-heading-row athlete-summary-heading">
          <div><span className="dashboard-kicker">Resumo</span><h2 id="today-summary-title">Seu dia</h2></div>
          {local.weekly?.planned > 0 && <Badge tone={local.weekly.done >= local.weekly.planned ? 'success' : 'neutral'}>{local.weekly.done}/{local.weekly.planned} na semana</Badge>}
        </div>

        {activeChallenge && (
          <Card className="athlete-summary-card athlete-challenge-summary-card">
            <div className="dashboard-section-heading">
              <div>
                <span className="dashboard-kicker">Desafio da comunidade</span>
                <h3>{activeChallenge.title}</h3>
              </div>
              <Icon name="trophy" aria-hidden="true" />
            </div>
            {activeChallenge.description && (
              <p className="pro-routine-note" style={{ margin: "4px 0 8px" }}>
                {activeChallenge.description}
              </p>
            )}
            <div className="athlete-target-pills" aria-label="Detalhes do desafio">
              <Badge tone="success">Ativo</Badge>
              <span className="athlete-target-pill">
                {activeChallenge.type === "workouts_count"
                  ? "Contagem de treinos"
                  : activeChallenge.type === "volume_load"
                    ? "Volume de carga"
                    : activeChallenge.type === "habits_consistency"
                      ? "Consistência de hábitos"
                      : "Pontos"}
              </span>
              {activeChallenge.endAt && (
                <span className="athlete-target-pill">
                  Termina em {new Date(activeChallenge.endAt).toLocaleDateString("pt-BR")}
                </span>
              )}
            </div>
            <div style={{ marginTop: 12 }}>
              <Button variant="ghost" onClick={() => navigate("/athlete/challenges")}>
                Ver classificação e progresso
              </Button>
            </div>
          </Card>
        )}

        {loading && !remote ? <div className="dashboard-loading-grid athlete-remote-loading" aria-label="Carregando resumos"><Skeleton height="8rem" /><Skeleton height="8rem" /></div> : <>
          {plan && <Card className="athlete-summary-card">
            <div className="dashboard-section-heading"><div><span className="dashboard-kicker">Alimentação</span><h3>{plan.title}</h3></div><Icon name="scale" aria-hidden="true" /></div>
            {plan.coach?.name && <p className="pro-meta" style={{ marginTop: '-4px', marginBottom: '8px' }}>Prescrito por {plan.coach.name}</p>}
            {(plan.targetCalories > 0 || plan.targetMacros?.protein > 0) && (
              <div className="athlete-target-pills" aria-label="Metas nutricionais prescritas">
                {plan.targetCalories > 0 && <span className="athlete-target-pill"><strong>{plan.targetCalories}</strong> kcal</span>}
                {plan.targetMacros?.protein > 0 && <span className="athlete-target-pill">P: {plan.targetMacros.protein}g</span>}
                {plan.targetMacros?.carbs > 0 && <span className="athlete-target-pill">C: {plan.targetMacros.carbs}g</span>}
                {plan.targetMacros?.fats > 0 && <span className="athlete-target-pill">G: {plan.targetMacros.fats}g</span>}
              </div>
            )}
            {sourceSucceeded(remote?.nutritionAdherence)
              ? (() => {
                const mealPercent = mealCount > 0 ? Math.round((checkedMeals / mealCount) * 100) : 0
                return <>
                  <p>{checkedMeals} de {mealCount} refeições marcadas</p>
                  {mealCount > 0 && <div className="athlete-meter"><span>Refeições</span><strong>{mealPercent}% ({checkedMeals} de {mealCount})</strong><progress aria-label="Progresso das refeições" aria-valuenow={mealPercent} aria-valuemin="0" aria-valuemax="100" max={mealCount} value={checkedMeals} /></div>}
                </>
              })()
              : <p>Adesão indisponível agora.</p>}
            {sourceSucceeded(remote?.nutritionAdherence) && waterGoal > 0 && (() => {
              const waterPercent = Math.round((Math.min(water, waterGoal) / waterGoal) * 100)
              return <div className="athlete-meter"><span>Água</span><strong>{waterPercent}% ({water} / {waterGoal} ml)</strong><progress aria-label="Progresso da meta de água" aria-valuenow={waterPercent} aria-valuemin="0" aria-valuemax="100" max={waterGoal} value={Math.min(water, waterGoal)} /></div>
            })()}
            <Button variant="ghost" onClick={() => navigate('/professionals?tab=nutrition')}>Abrir alimentação</Button>
          </Card>}

          {habits.length > 0 && <Card className="athlete-summary-card athlete-habits-summary-card">
            <div className="dashboard-section-heading"><div><span className="dashboard-kicker">Hábitos</span><h3>{completedHabits} de {habits.length} concluídos</h3></div><Icon name="checkCircle" aria-hidden="true" /></div>
            <LiveFeedback success={habitLiveFeedback} className="athlete-habit-live" />
            <ul className="athlete-mini-list">
              {habits.slice(0, 3).map(habit => {
                const isCompleted = !!habit.checkin?.completed
                const isPending = checkingInId === habit.id
                return (
                  <li key={habit.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', minHeight: '44px', gap: '8px' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                      <span>{habit.title}</span>
                      <small className="dashboard-muted" style={{ fontSize: 'var(--fs-caption2)' }}>
                        {habit.targetValue} {habit.unit}
                        {typeof habit.currentStreak === 'number' ? ` · ${habit.currentStreak} dias seguidos` : ''}
                      </small>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                      <Badge tone={isCompleted ? 'success' : 'neutral'}>{isCompleted ? 'Feito' : 'Pendente'}</Badge>
                      {!habit.relationship?.readOnly && (
                        <Button
                          size="sm"
                          variant={isCompleted ? 'secondary' : 'primary'}
                          disabled={isPending}
                          onClick={() => handleQuickCheckin(habit)}
                          aria-label={`${isCompleted ? 'Desmarcar' : 'Concluir'} ${habit.title}`}
                          style={{ minHeight: '44px', minWidth: '44px' }}
                        >
                          {isPending ? '…' : isCompleted ? 'Desfazer' : 'Concluir'}
                        </Button>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
            <Button variant="ghost" onClick={() => navigate('/professionals')}>Abrir hábitos</Button>
          </Card>}

          {(() => {
            const waistData = latestMeasurement(S, "waist")
            const fatData = latestMeasurement(S, "bodyFat")
            if (!waistData && !fatData) return null
            const unit = S.unit === "lb" ? "in" : "cm"
            const waistDisplay = waistData ? (S.unit === "lb" ? Math.round(waistData.value / 2.54 * 10) / 10 : waistData.value) : null
            return <Card className="athlete-summary-card">
              <div className="dashboard-section-heading"><div><span className="dashboard-kicker">Evolução corporal</span><h3>Últimas medidas</h3></div><Icon name="chart" aria-hidden="true" /></div>
              <div style={{ display: "flex", gap: 16, margin: "8px 0" }}>
                {waistData && <div><span className="dashboard-muted">Cintura</span><strong style={{ display: "block" }}>{fmtNum(waistDisplay)} {unit}</strong></div>}
                {fatData && <div><span className="dashboard-muted">% gordura</span><strong style={{ display: "block" }}>{fmtNum(fatData.value)}%</strong></div>}
              </div>
              <Button variant="ghost" onClick={() => navigate("/measurements")}>Ver evolução</Button>
            </Card>
          })()}

          {nextAppointment && <Card className="athlete-summary-card">
            <div className="dashboard-section-heading"><div><span className="dashboard-kicker">Próximo compromisso</span><h3>{nextAppointment.title || 'Sessão'}</h3></div><Icon name="calendar" aria-hidden="true" /></div>
            <p>{new Date(nextAppointment.startAt).toLocaleString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: nextAppointment.timeZone || undefined })}{nextAppointment.timeZone ? ' (' + nextAppointment.timeZone + ')' : ''}</p>
            <p className="dashboard-muted">{nextAppointment.coach?.name || 'Profissional'}</p>
            <Button variant="ghost" onClick={() => navigate('/scheduling')}>Ver agenda</Button>
          </Card>}

          {unread > 0 && <Card className="athlete-summary-card">
            <div className="dashboard-section-heading"><div><span className="dashboard-kicker">Mensagens</span><h3>{unread} {unread === 1 ? 'aviso não lido' : 'avisos não lidos'}</h3></div><Icon name="chat" aria-hidden="true" /></div>
            <p>Confira as atualizações dos seus profissionais.</p>
            <Button variant="ghost" onClick={() => navigate('/professionals')}>Ler mensagens</Button>
          </Card>}

          {remote?.appointments?.status === 'error' && <UnavailableSummary title="Agenda indisponível" text="Não foi possível confirmar seus próximos compromissos." />}
          {['error', 'unavailable'].includes(remote?.inbox?.status) && <UnavailableSummary title="Mensagens indisponíveis" text={remote.inbox.reason || 'Não foi possível confirmar mensagens pendentes.'} />}
          {remote?.nutritionPlan?.status === 'error' && <UnavailableSummary title="Alimentação indisponível" text="Não foi possível confirmar seu plano alimentar." />}
          {remote?.nutritionAdherence?.status === 'error' && !plan && <UnavailableSummary title="Adesão alimentar indisponível" text="Não foi possível confirmar sua adesão de hoje." />}
          {['error', 'unavailable'].includes(remote?.habits?.status) && <UnavailableSummary title="Hábitos indisponíveis" text={remote.habits.reason || 'Não foi possível confirmar seus hábitos de hoje.'} />}

          {local.weekly?.planned > 0 && <Surface className="athlete-week-progress">
            <div><span className="dashboard-kicker">Progresso semanal</span><strong>{local.weekly.done} de {local.weekly.planned} treinos concluídos</strong></div>
            <progress aria-label="Progresso semanal de treinos" max={local.weekly.planned} value={Math.min(local.weekly.done, local.weekly.planned)} />
            <Button variant="ghost" onClick={() => navigate('/stats')}>Ver evolução</Button>
          </Surface>}

          {sourcesKnownEmpty && !remoteContent && !local.weekly?.planned && !local.routines.length && !S.active && <EmptyState
            title="Seu dia está livre"
            text="Crie um plano para deixar o próximo treino pronto e acompanhar sua semana."
            action={<Button onClick={() => navigate('/plan')}>Criar plano</Button>}
          />}
        </>}
      </section>

      {isOn(S, 'checkin') && S.gymCards?.length > 0 && <nav className="dashboard-quick-actions athlete-quick-actions" aria-label="Atalhos de hoje">
        <h2>Atalhos</h2><div>
          <Button onClick={() => navigate('/plan')}><Icon name="calendar" />Meu plano</Button>
          <Button onClick={() => navigate('/stats')}><Icon name="chart" />Evolução</Button>
          <Button onClick={() => navigate('/checkin')}><Icon name="qr" />Check-in</Button>
        </div>
      </nav>}
    </div>
  </main>
}
