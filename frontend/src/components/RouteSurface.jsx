import { Component, Suspense, lazy, useMemo, useState } from 'react'
import { Alert, Button, Skeleton } from './design-system.jsx'

class RouteChunkError extends Error {
  constructor(cause) {
    super('Não foi possível carregar esta área.')
    this.cause = cause
  }
}

class RouteImportBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    if (!(error instanceof RouteChunkError)) throw error
    return <RouteLoadError label={this.props.label} onRetry={this.props.onRetry} />
  }
}

export function RouteLoading({ label }) {
  return (
    <div className="ds-scope route-load-state" aria-busy="true" aria-label={`Carregando ${label}`}>
      <h1 className="sr-only">Carregando {label}</h1>
      <span className="sr-only" role="status">Carregando {label}…</span>
      <div className="route-load-skeleton" aria-hidden="true">
        <Skeleton announce={false} width="7rem" height="1rem" />
        <Skeleton announce={false} width="min(28rem, 82%)" height="2.25rem" />
        <Skeleton announce={false} width="min(38rem, 100%)" height="1rem" />
        <div className="route-load-grid">
          <Skeleton announce={false} height="9rem" />
          <Skeleton announce={false} height="9rem" />
        </div>
      </div>
    </div>
  )
}

function RouteLoadError({ label, onRetry }) {
  return (
    <div className="ds-scope route-load-state route-load-error">
      <h1 className="sr-only">Não foi possível carregar {label}</h1>
      <Alert tone="error" title={`Não foi possível carregar ${label}.`}>
        <p>Verifique sua conexão e tente novamente. Seus dados continuam seguros neste dispositivo.</p>
        <Button variant="secondary" onClick={onRetry}>Tentar novamente</Button>
      </Alert>
    </div>
  )
}

export function RouteSurface({ load, label, componentProps }) {
  const [attempt, setAttempt] = useState(0)
  const LazyView = useMemo(() => lazy(() => load().catch(error => {
    throw new RouteChunkError(error)
  })), [load, attempt])

  return (
    <RouteImportBoundary key={attempt} label={label} onRetry={() => setAttempt(value => value + 1)}>
      <Suspense fallback={<RouteLoading label={label} />}>
        <LazyView {...componentProps} />
      </Suspense>
    </RouteImportBoundary>
  )
}

export function createRouteSurface(load, label) {
  let View, loading
  const loadView = () => loading || (loading = load().then(
    module => (View = module.default, module),
    error => { loading = null; throw error }
  ))
  return function LazyRouteSurface(props) {
    return View ? <View {...props} /> : <RouteSurface load={loadView} label={label} componentProps={props} />
  }
}
