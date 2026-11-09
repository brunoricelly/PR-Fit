import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../../lib/api.js'
import { communicationApi, browserTimeZone } from '../../lib/communication-api.js'
import { getCoachAppointments, getCoachAvailability } from '../../lib/scheduling-api.js'
import { useStore } from '../../store/useStore.js'
import { useOnline } from '../../components/ServerSync.jsx'
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  PageHeader,
  Skeleton,
  Surface,
} from '../../components/design-system.jsx'
import Icon from '../../components/Icon.jsx'
import FirstSteps from '../../components/FirstSteps.jsx'
import {
  loadingSource,
  mapSettledWithConcurrency,
  normalizeAvailability,
  normalizeAppointments,
  normalizeConversations,
  normalizeLinks,
  normalizeSummary,
  settledSource,
  sourceSucceeded,
  summariesUnavailableSource,
} from './dashboard-data.js'
import './DashboardHome.css'

const SUMMARY_CONCURRENCY = 3
const sourceEmpty = data => !data || data.length === 0

const dayBounds = date => {
  const start = new Date(date)
  start.setHours(0, 0, 0, 0)
  const end = new Date(start)
  end.setDate(end.getDate() + 1)
  end.setMilliseconds(-1)
  return { from: start.toISOString(), to: end.toISOString() }
}

const athleteName = link => link.athlete?.name || 'Aluno sem nome disponível'

function CoachLoading() {
  return <main className="ds-scope dashboard-page dashboard-page-coach" aria-busy="true" aria-label="Carregando visão geral">
    <span className="sr-only" role="status">Carregando visão geral</span>
    <div className="dashboard-shell">
      <Skeleton announce={false} width="9rem" height="1rem" />
      <Skeleton announce={false} width="min(28rem, 88%)" height="2.5rem" />
      <Skeleton announce={false} width="min(36rem, 100%)" height="1.25rem" />
      <div className="dashboard-loading-grid" aria-hidden="true">
        <Skeleton announce={false} height="12rem" />
        <Skeleton announce={false} height="12rem" />
        <Skeleton announce={false} height="9rem" />
      </div>
    </div>
  </main>
}

function UnavailableState({ text }) {
  return <Surface className="dashboard-pulse-empty dashboard-pulse-unavailable" role="status">
    <Icon name="cloudSlash" aria-hidden="true" /><span>{text}</span>
  </Surface>
}

const summaryUnavailableText = source => source.countsKnown
  ? `${source.failed} de ${source.requested} resumos de adesão ficaram indisponíveis.`
  : 'Resumos de adesão indisponíveis porque os vínculos não carregaram.'

export default function CoachDashboard() {
  const navigate = useNavigate()
  const user = useStore(state => state.user)
  const ready = useStore(state => state.ready)
  const online = useOnline()
  const [dashboardState, setDashboardState] = useState(null)
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
    const generation = generationRef.current + 1
    generationRef.current = generation
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    const current = () => mountedRef.current && generationRef.current === generation
      && userIdRef.current === userId && !controller.signal.aborted
    const requestOptions = { signal: controller.signal }
    setDashboardState({
      userId,
      sources: {
        links: loadingSource(),
        inbox: loadingSource(),
        appointments: loadingSource(),
        availability: loadingSource(),
        summaries: loadingSource(),
      },
    })
    setLoading(true)

    const bounds = dayBounds(new Date())
    const [linksResult, inboxResult, appointmentsResult, availabilityResult] = await Promise.allSettled([
      api('/api/coach/athletes', requestOptions),
      communicationApi.inbox({ limit: 100 }, requestOptions),
      getCoachAppointments({ status: 'scheduled', ...bounds, limit: 100 }, requestOptions),
      getCoachAvailability(requestOptions),
    ])
    if (!current()) return

    const linksSource = settledSource(linksResult, normalizeLinks, sourceEmpty)
    const inboxSource = settledSource(inboxResult, normalizeConversations, sourceEmpty)
    const appointmentsSource = settledSource(appointmentsResult, normalizeAppointments, sourceEmpty)
    const availabilitySource = settledSource(availabilityResult, normalizeAvailability, availability => availability === null)
    const unavailableSummaries = summariesUnavailableSource(new Error('Vínculos indisponíveis'))
    setDashboardState({
      userId,
      sources: {
        links: linksSource,
        inbox: inboxSource,
        appointments: appointmentsSource,
        availability: availabilitySource,
        summaries: sourceSucceeded(linksSource) ? loadingSource([]) : unavailableSummaries,
      },
    })
    setLoading(false)

    if (!sourceSucceeded(linksSource)) {
      return
    }

    const trainingLinks = linksSource.data.filter(link => link.status === 'active'
      && link.scopes.includes('training') && typeof link.athlete?.id === 'string')
    const results = await mapSettledWithConcurrency(trainingLinks, SUMMARY_CONCURRENCY, link => communicationApi.summary({
      side: 'coach',
      athleteId: link.athlete.id,
      linkId: link.id,
      period: 7,
      timeZone: browserTimeZone().value,
    }, requestOptions), () => !controller.signal.aborted)
    if (!current()) return
    const items = []
    let failed = 0
    results.forEach((result, index) => {
      const source = settledSource(result, normalizeSummary, summary => summary === null)
      if (source.status === 'error') failed += 1
      else if (source.data) items.push({ link: trainingLinks[index], summary: source.data })
    })
    const summariesSource = {
      status: failed > 0 ? 'error' : items.length > 0 ? 'ok' : 'empty',
      data: items,
      requested: trainingLinks.length,
      failed,
      countsKnown: true,
    }

    setDashboardState({
      userId,
      sources: {
        links: linksSource,
        inbox: inboxSource,
        appointments: appointmentsSource,
        availability: availabilitySource,
        summaries: summariesSource,
      },
    })
  }, [user?.id])

  useEffect(() => { if (ready) load() }, [load, ready])
  useEffect(() => {
    const retry = () => load()
    window.addEventListener('online', retry)
    return () => window.removeEventListener('online', retry)
  }, [load])

  const sources = dashboardState && dashboardState.userId === user?.id ? dashboardState.sources : null
  const view = useMemo(() => {
    if (!sources) return null
    const links = sources.links.data || []
    const coachLinkIds = new Set(sourceSucceeded(sources.links) ? links.map(link => link.id) : [])
    const roleInboxKnown = sourceSucceeded(sources.links) && sourceSucceeded(sources.inbox)
    const conversations = roleInboxKnown
      ? (sources.inbox.data || []).filter(item => coachLinkIds.has(item.linkId))
      : []
    const conversationByLink = new Map(conversations.map(item => [item.linkId, item]))
    const adherence = sources.summaries.data || []
    const summaryByLink = new Map(adherence.map(item => [item.link.id, item.summary]))
    const attention = sourceSucceeded(sources.links) ? links.flatMap(link => {
      const reasons = []
      const unread = roleInboxKnown ? conversationByLink.get(link.id)?.unreadCount || 0 : 0
      const summary = summaryByLink.get(link.id)
      if (unread > 0) reasons.push(`${unread} ${unread === 1 ? 'mensagem não lida' : 'mensagens não lidas'}`)
      if (summary?.scheduledDays > 0 && summary.completedDays === 0) reasons.push('nenhum check-in concluído nesta semana')
      if (link.status === 'pending') reasons.push('convite ainda pendente')
      if (link.status === 'suspended') reasons.push('acesso suspenso')
      return reasons.length ? [{ link, reasons }] : []
    }) : []
    const unreadTotal = conversations.reduce((sum, item) => sum + item.unreadCount, 0)
    const appointments = sourceSucceeded(sources.appointments)
      ? [...sources.appointments.data].sort((left, right) => new Date(left.startAt) - new Date(right.startAt))
      : []
    const sortedAdherence = adherence.filter(item => item.summary.scheduledDays > 0)
      .sort((left, right) => left.summary.adherencePercent - right.summary.adherencePercent)
    const priorityComplete = sourceSucceeded(sources.links) && roleInboxKnown && sourceSucceeded(sources.summaries)
    const pulseComplete = roleInboxKnown && sourceSucceeded(sources.summaries)
    const overviewComplete = priorityComplete && sourceSucceeded(sources.appointments)
    return { attention, unreadTotal, appointments, adherence: sortedAdherence, roleInboxKnown, priorityComplete, pulseComplete, overviewComplete }
  }, [sources])

  if (!ready) return <CoachLoading />
  if (loading && (!sources || Object.values(sources).every(source => source.status === 'loading'))) return <CoachLoading />

  const allCoreFailed = sources && ['links', 'inbox', 'appointments'].every(key => sources[key].status === 'error')
  if (allCoreFailed && !online) return <main className="ds-scope dashboard-page"><div className="dashboard-shell">
    <ErrorState title="Você está offline" text="A visão do coach precisa da conexão para buscar alunos, agenda e mensagens." action={<Button onClick={load}>Tentar novamente</Button>} icon="cloudSlash" />
  </div></main>
  if (allCoreFailed) return <main className="ds-scope dashboard-page"><div className="dashboard-shell">
    <ErrorState title="Não foi possível abrir sua visão geral" text="Tente carregar novamente. Seus dados e permissões não foram alterados." action={<Button onClick={load}>Tentar novamente</Button>} />
  </div></main>
  if (!sources || !view) return <CoachLoading />

  const firstName = user?.name?.trim().split(/\s+/)[0] || 'Treinador'
  const today = new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' })
  const errors = [
    sources.links.status === 'error' && 'alunos',
    sources.inbox.status === 'error' && 'mensagens',
    sources.appointments.status === 'error' && 'agenda',
    sources.availability.status === 'error' && 'disponibilidade',
    sources.summaries.status === 'error' && 'adesão',
  ].filter(Boolean)
  const primaryLabel = view.attention.length ? 'Revisar alunos' : 'Organizar treinos'
  const coachSteps = [
    { id: 'profile', title: 'Revise seu perfil', text: 'Confira dados da conta e preferências do app.', route: '/settings', cta: 'Abrir configurações', completion: 'visit' },
    { id: 'first-athlete', title: 'Adicione seu primeiro aluno', text: 'Crie um convite ou acompanhe um vínculo existente.', route: '/professionals', cta: 'Gerenciar alunos', completion: 'evidence', completed: sourceSucceeded(sources.links) && sources.links.data.length > 0 },
    { id: 'first-workout', title: 'Prescreva o primeiro treino', text: 'Abra um aluno com acesso a treino e organize a rotina.', route: '/professionals', cta: 'Abrir alunos', completion: 'manual' },
    { id: 'availability', title: 'Configure sua disponibilidade', text: 'Defina quando seus alunos podem agendar sessões.', route: '/scheduling?tab=availability', cta: 'Configurar agenda', completion: 'evidence', completed: sourceSucceeded(sources.availability) && sources.availability.data !== null },
    { id: 'community', title: 'Conheça a Comunidade', text: 'Explore grupos, programas e desafios.', route: '/community', cta: 'Abrir Comunidade', completion: 'visit' },
  ]

  return <main className="ds-scope dashboard-page dashboard-page-coach">
    <div className="dashboard-shell">
      <PageHeader
        eyebrow={`Hoje, ${today}`}
        title={`Olá, ${firstName}.`}
        description={view.priorityComplete && view.attention.length
          ? `${view.attention.length} ${view.attention.length === 1 ? 'aluno precisa' : 'alunos precisam'} da sua atenção.`
          : view.overviewComplete
            ? 'Sua agenda e seus alunos estão organizados para hoje.'
          : 'Confira os dados disponíveis; algumas fontes ainda não puderam ser confirmadas.'}
        actions={<Button variant="primary" onClick={() => navigate('/professionals')}>{primaryLabel}</Button>}
      />

      {!online && <Alert tone="warning" title="Sem conexão">
        Você está vendo os últimos dados carregados. Reconecte para atualizar a visão geral.
      </Alert>}
      {errors.length > 0 && <Alert tone="warning" title="Parte da visão geral não atualizou" action={<Button size="sm" onClick={load}>Tentar novamente</Button>}>
        Não foi possível atualizar {errors.join(', ')}. O restante continua disponível.
      </Alert>}

      <FirstSteps key={`${user.id}:coach`} userId={user.id} role="coach" steps={coachSteps} />

      <section className="dashboard-priority-grid" aria-label="Prioridades de hoje">
        <Card className="dashboard-priority-card">
          <div className="dashboard-section-heading">
            <div><span className="dashboard-kicker">Prioridade</span><h2>Alunos que exigem atenção</h2></div>
            {view.attention.length > 0 && <Badge tone="warning">{view.attention.length}</Badge>}
          </div>
          {view.attention.length ? <>
            <ul className="dashboard-list">
              {view.attention.slice(0, 3).map(({ link, reasons }) => <li key={link.id}>
                <button type="button" onClick={() => navigate('/professionals')}>
                  <span><strong>{athleteName(link)}</strong><small>{reasons.join(' · ')}</small></span>
                  <Icon name="chevronRight" aria-hidden="true" />
                </button>
              </li>)}
            </ul>
            {view.attention.length > 3 && <details className="dashboard-details"><summary>Ver mais {view.attention.length - 3}</summary>
              <ul className="dashboard-list compact">{view.attention.slice(3).map(({ link, reasons }) => <li key={link.id}><span><strong>{athleteName(link)}</strong><small>{reasons.join(' · ')}</small></span></li>)}</ul>
            </details>}
          </> : view.priorityComplete
            ? <EmptyState title="Nenhuma pendência agora" text="Mensagens, vínculos e check-ins da semana estão em dia." action={<Button onClick={() => navigate('/professionals')}>Ver alunos</Button>} />
            : <UnavailableState text="As pendências conhecidas aparecem aqui, mas ainda faltam dados para afirmar que está tudo em dia." />}
        </Card>

        <Card className="dashboard-priority-card">
          <div className="dashboard-section-heading">
            <div><span className="dashboard-kicker">Agenda</span><h2>Compromissos de hoje</h2></div>
            {view.appointments.length > 0 && <Badge>{view.appointments.length}</Badge>}
          </div>
          {view.appointments.length ? <ul className="dashboard-list">
            {view.appointments.slice(0, 4).map(item => <li key={item.id}>
              <span className="dashboard-time">{new Date(item.startAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>
              <span><strong>{item.title || 'Sessão'}</strong><small>{item.athlete?.name || 'Aluno'}</small></span>
            </li>)}
          </ul> : sources.appointments.status === 'empty'
            ? <EmptyState title="Agenda livre hoje" text="Use este espaço para acompanhar alunos ou preparar os próximos treinos." action={<Button onClick={() => navigate('/scheduling')}>Abrir agenda</Button>} />
            : <UnavailableState text="Agenda indisponível. Tente novamente para confirmar os compromissos de hoje." />}
        </Card>
      </section>

      <section className="dashboard-secondary" aria-labelledby="coach-pulse-title">
        <div className="dashboard-section-heading dashboard-section-heading-row">
          <div><span className="dashboard-kicker">Acompanhamento</span><h2 id="coach-pulse-title">Pulso da semana</h2></div>
          <Button variant="ghost" onClick={() => navigate('/professionals')}>Ver detalhes</Button>
        </div>
        <div className="dashboard-pulse-grid">
          {view.unreadTotal > 0 && <Surface className="dashboard-pulse-item">
            <Icon name="chat" aria-hidden="true" /><strong>{view.unreadTotal}</strong><span>{view.unreadTotal === 1 ? 'mensagem não lida' : 'mensagens não lidas'}</span>
          </Surface>}
          {view.adherence.slice(0, 3).map(({ link, summary }) => <Surface className="dashboard-pulse-item" key={link.id}>
            <span className="dashboard-progress-value">{summary.adherencePercent}%</span>
            <strong>{athleteName(link)}</strong>
            <span>{summary.completedDays} de {summary.scheduledDays} check-ins concluídos</span>
          </Surface>)}
          {!view.roleInboxKnown && <UnavailableState text="Mensagens do papel Coach indisponíveis; o inbox geral não será contado como se pertencesse a este papel." />}
          {sources.summaries.status === 'loading' && <Surface className="dashboard-pulse-empty" role="status"><span>Carregando resumos de adesão…</span></Surface>}
          {sources.summaries.status === 'error' && <UnavailableState text={summaryUnavailableText(sources.summaries)} />}
          {!view.unreadTotal && !view.adherence.length && view.pulseComplete && <Surface className="dashboard-pulse-empty">
            <Icon name="checkCircle" aria-hidden="true" /><span>Sem mensagens pendentes ou dados de adesão para mostrar.</span>
          </Surface>}
        </div>
      </section>

      <nav className="dashboard-quick-actions" aria-label="Ações rápidas">
        <h2>Ações rápidas</h2>
        <div>
          <Button onClick={() => navigate('/professionals')}><Icon name="person" />Alunos</Button>
          <Button onClick={() => navigate('/professionals')}><Icon name="dumbbell" />Treinos</Button>
          <Button onClick={() => navigate('/scheduling')}><Icon name="calendar" />Agenda</Button>
          <Button onClick={() => navigate('/community')}><Icon name="trophy" />Comunidade</Button>
        </div>
      </nav>
    </div>
  </main>
}
