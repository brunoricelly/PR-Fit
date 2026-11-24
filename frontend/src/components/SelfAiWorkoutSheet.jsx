import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api.js'
import { uid } from '../lib/format.js'
import { Button } from './ui.jsx'
import { interpretResult } from './AiWorkoutGeneratorModal.jsx'
import { routinesFromPlan } from '../lib/self-ai-workout.js'

const TIMEOUT_MS = 50000
const ERRORS = {
  409: 'Você tem um treinador ativo. Peça a ficha a ele.',
  429: 'Você pediu muitas fichas seguidas. Tente de novo mais tarde.',
  401: 'Entre na sua conta para montar o treino.',
  403: 'Esta conta não pode montar treino sozinha.',
}
const BLOCKED = 'Pelos dados que você informou, uma ficha automática não é segura. Procure um profissional de educação física ou um treinador do app para montar o seu treino.'

/** "Montar meu treino": a conservative starter plan from the athlete's own answers. Shown, then saved on request. */
export default function SelfAiWorkoutSheet({ S, update, toast, close }) {
  const [state, setState] = useState({ status: 'loading' })
  const ctl = useRef(null)
  const saving = useRef(false)

  const run = async () => {
    ctl.current?.abort()
    const c = new AbortController(); ctl.current = c
    setState({ status: 'loading' })
    try {
      const result = await api('/api/athlete/ai-workout', { method: 'POST', body: '{}', timeout: TIMEOUT_MS, signal: c.signal })
      if (c.signal.aborted) return
      if (result?.rulesBlocked) return setState({ status: 'blocked' })
      const view = interpretResult(result)
      if (!view.plan) return setState({ status: 'blocked' })
      setState({ status: 'ready', plan: view.plan, ai: view.status === 'ready', reason: view.reason, review: result.manualReview === true })
    } catch (e) {
      if (c.signal.aborted) return
      setState({ status: 'error', text: ERRORS[e?.status] || 'Não foi possível montar agora. Tente de novo em instantes.' })
    }
  }
  useEffect(() => { run(); return () => ctl.current?.abort() }, [])

  const save = () => {
    if (saving.current || state.status !== 'ready') return
    const existing = new Set((S.routines || []).map(r => r.id))
    const routines = routinesFromPlan(state.plan, uid, existing)
    if (!routines) { setState({ status: 'blocked' }); return }
    saving.current = true
    update(s => { s.routines = [...(s.routines || []), ...routines] })
    toast('Treino adicionado às suas rotinas')
    close()
  }

  return <div className="chat-menu" data-testid="self-ai-sheet">
    <h3>Montar meu treino</h3>
    <div className="sect-b" style={{ padding: '0 16px' }}>
      {state.status === 'loading' && <p role="status" data-testid="self-ai-loading">Montando com a IA… pode levar até um minuto.</p>}
      {state.status === 'blocked' && <p role="alert" data-testid="self-ai-blocked">{BLOCKED}</p>}
      {state.status === 'error' && <p role="alert" data-testid="self-ai-error">{state.text}</p>}
      {state.status === 'ready' && <>
        <p className="muted small" data-testid="self-ai-note">
          {state.ai ? 'Sugestão automática da IA, feita só com o que você informou e com exercícios do app.' : 'Sugestão automática por regras (a IA não respondeu), feita com o que você informou.'}
          {' '}Não substitui um profissional. Comece leve e pare se sentir dor.
          {state.review ? ' Você ainda não preencheu todas as respostas; a ficha é genérica.' : ''}
        </p>
        {state.plan.divisions.map(d => <div key={d.name} style={{ marginBottom: 10 }}>
          <strong>{d.name}</strong>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{d.exercises.map(e => <li key={e.catalogueId || e.id}>{e.name} · {e.sets}x{e.reps}</li>)}</ul>
        </div>)}
      </>}
    </div>
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: 8, padding: '8px 16px 16px' }}>
      {state.status === 'ready' && <Button variant="primary" onClick={save} data-testid="self-ai-save">Adicionar às minhas rotinas</Button>}
      {(state.status === 'error' || state.status === 'ready') && <Button onClick={run} data-testid="self-ai-retry">Gerar outra</Button>}
      <Button onClick={close}>Fechar</Button>
    </div>
  </div>
}
