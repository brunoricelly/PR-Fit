import { useCallback, useEffect, useMemo, useState } from 'react'
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
import { useOnline } from '../../components/ServerSync.jsx'
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  PageHeader,
  Skeleton,
  Surface,
} from '../../components/design-system.jsx'
import Icon from '../../components/Icon.jsx'
import './DashboardHome.css'

const localToday = () => todayISO()

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

export default function AthleteToday() {
  const navigate = useNavigate()
  const S = useStore(state => state.S)
  const user = useStore(state => state.user)
  const ready = useStore(state => state.ready)
  const online = useOnline()
  const [remote, setRemote] = useState(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  const load = useCallback(async () => {
    if (!user?.id) return
    setLoading(true)
    setFailed(false)
    const date = localToday()
    const now = new Date()
    const until = new Date(now)
    until.setDate(until.getDate() + 30)
    const requests = [
      communicationApi.inbox({ limit: 100 }),
      getAthleteAppointments({ status: 'scheduled', from: now.toISOString(), to: until.toISOString(), limit: 20 }),
      Promise.all([api('/api/athlete/meal-plan'), api(`/api/athlete/meal-adherence?date=${date}`)]),
    ]
    if (user.profile?.kind !== 'coach') requests.push(communicationApi.athleteHabits(browserTimeZone().value))
    const [inboxResult, appointmentsResult, nutritionResult, habitsResult] = await Promise.allSettled(requests)
    const planPayload = nutritionResult.status === 'fulfilled' ? nutritionResult.value[0] : null
    const adherencePayload = nutritionResult.status === 'fulfilled' ? nutritionResult.value[1] : null
    const plan = planPayload?.mealPlan || null
    const adherence = (adherencePayload?.adherenceRecords || [adherencePayload?.adherence])
      .find(item => item?.mealPlanId === plan?.id) || null
    setRemote({
      conversations: inboxResult.status === 'fulfilled' ? inboxResult.value.conversations || [] : [],
      appointments: appointmentsResult.status === 'fulfilled' ? appointmentsResult.value.items || [] : [],
      nutrition: plan ? { plan, adherence } : null,
      habits: habitsResult?.status === 'fulfilled' ? habitsResult.value.habits || [] : [],
    })
    setFailed([inboxResult, appointmentsResult, nutritionResult, habitsResult].filter(Boolean).some(result => result.status === 'rejected'))
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

  const firstName = user?.name?.trim().split(/\s+/)[0] || 'Atleta'
  const activeSession = !!S.active
  const editingWorkout = !!S.active?.editingWorkoutId
  const action = activeSession
    ? { label: editingWorkout ? 'Continuar edição' : 'Continuar treino', detail: S.active.name || (editingWorkout ? 'Edição em andamento' : 'Treino em andamento'), run: () => navigate('/workout'), icon: editingWorkout ? 'pencil' : 'play' }
    : local.routines.length && !local.done
      ? { label: 'Iniciar treino', detail: local.routines.map(routine => routine.name).join(' + '), run: () => startFlow(effectiveRoutineIds(S, localToday())), icon: 'play' }
      : local.done
        ? { label: 'Ver treino concluído', detail: local.routines.map(routine => routine.name).join(' + '), run: () => navigate('/history'), icon: 'checkCircle' }
        : { label: 'Montar meu plano', detail: 'Nenhum treino programado para hoje', run: () => navigate('/plan'), icon: 'calendar' }

  const nextAppointment = remote?.appointments.slice().sort((left, right) => new Date(left.startAt) - new Date(right.startAt))[0]
  const unread = remote?.conversations.reduce((sum, item) => sum + (item.unreadCount || 0), 0) || 0
  const checkedMeals = new Set(remote?.nutrition?.adherence?.mealsChecked || []).size
  const mealCount = remote?.nutrition?.plan?.meals?.length || 0
  const water = remote?.nutrition?.adherence?.waterDrunkMl || 0
  const waterGoal = remote?.nutrition?.plan?.targetMacros?.waterMl || 0
  const completedHabits = remote?.habits.filter(habit => habit.checkin?.completed).length || 0
  const hasRemoteContent = !!(nextAppointment || unread || remote?.nutrition || remote?.habits.length)

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

      {!online && <Alert tone="warning" title="Você está offline">
        O treino continua disponível neste dispositivo. Agenda, mensagens e acompanhamentos serão atualizados quando a conexão voltar.
      </Alert>}
      {online && failed && <Alert tone="warning" title="Alguns resumos não carregaram" action={<Button size="sm" onClick={load}>Tentar novamente</Button>}>
        Seu treino continua disponível. Tente atualizar agenda, mensagens e acompanhamentos.
      </Alert>}

      <section className="athlete-today-grid" aria-labelledby="today-summary-title">
        <div className="dashboard-section-heading dashboard-section-heading-row athlete-summary-heading">
          <div><span className="dashboard-kicker">Resumo</span><h2 id="today-summary-title">Seu dia</h2></div>
          {local.weekly?.planned > 0 && <Badge tone={local.weekly.done >= local.weekly.planned ? 'success' : 'neutral'}>{local.weekly.done}/{local.weekly.planned} na semana</Badge>}
        </div>

        {loading && !remote ? <div className="dashboard-loading-grid athlete-remote-loading" aria-label="Carregando resumos"><Skeleton height="8rem" /><Skeleton height="8rem" /></div> : <>
          {remote?.nutrition && <Card className="athlete-summary-card">
            <div className="dashboard-section-heading"><div><span className="dashboard-kicker">Alimentação</span><h3>{remote.nutrition.plan.title}</h3></div><Icon name="scale" aria-hidden="true" /></div>
            <p>{checkedMeals} de {mealCount} refeições marcadas</p>
            {waterGoal > 0 && <div className="athlete-meter"><span>Água</span><strong>{water} / {waterGoal} ml</strong><progress max={waterGoal} value={Math.min(water, waterGoal)} /></div>}
            <Button variant="ghost" onClick={() => navigate('/professionals')}>Abrir alimentação</Button>
          </Card>}

          {remote?.habits.length > 0 && <Card className="athlete-summary-card">
            <div className="dashboard-section-heading"><div><span className="dashboard-kicker">Hábitos</span><h3>{completedHabits} de {remote.habits.length} concluídos</h3></div><Icon name="checkCircle" aria-hidden="true" /></div>
            <ul className="athlete-mini-list">{remote.habits.slice(0, 3).map(habit => <li key={habit.id}><span>{habit.title}</span><Badge tone={habit.checkin?.completed ? 'success' : 'neutral'}>{habit.checkin?.completed ? 'Feito' : 'Pendente'}</Badge></li>)}</ul>
            <Button variant="ghost" onClick={() => navigate('/professionals')}>Abrir hábitos</Button>
          </Card>}

          {nextAppointment && <Card className="athlete-summary-card">
            <div className="dashboard-section-heading"><div><span className="dashboard-kicker">Próximo compromisso</span><h3>{nextAppointment.title || 'Sessão'}</h3></div><Icon name="calendar" aria-hidden="true" /></div>
            <p>{new Date(nextAppointment.startAt).toLocaleString('pt-BR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</p>
            <p className="dashboard-muted">{nextAppointment.coach?.name || 'Profissional'}</p>
            <Button variant="ghost" onClick={() => navigate('/scheduling')}>Ver agenda</Button>
          </Card>}

          {unread > 0 && <Card className="athlete-summary-card">
            <div className="dashboard-section-heading"><div><span className="dashboard-kicker">Mensagens</span><h3>{unread} {unread === 1 ? 'aviso não lido' : 'avisos não lidos'}</h3></div><Icon name="chat" aria-hidden="true" /></div>
            <p>Confira as atualizações dos seus profissionais.</p>
            <Button variant="ghost" onClick={() => navigate('/professionals')}>Ler mensagens</Button>
          </Card>}

          {local.weekly?.planned > 0 && <Surface className="athlete-week-progress">
            <div><span className="dashboard-kicker">Progresso semanal</span><strong>{local.weekly.done} de {local.weekly.planned} treinos concluídos</strong></div>
            <progress max={local.weekly.planned} value={Math.min(local.weekly.done, local.weekly.planned)} />
            <Button variant="ghost" onClick={() => navigate('/stats')}>Ver evolução</Button>
          </Surface>}

          {!hasRemoteContent && !local.weekly?.planned && !local.routines.length && !S.active && <EmptyState
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
