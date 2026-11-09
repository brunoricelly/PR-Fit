// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRouteSurface, RouteSurface } from './RouteSurface.jsx'
import { guardReactWarnings } from '../test/react-warning-guard.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let host
let root
let assertNoReactWarnings

const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const settle = () => act(async () => {
  await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
})

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host, { onCaughtError: () => {} })
  assertNoReactWarnings = guardReactWarnings()
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  assertNoReactWarnings()
  vi.restoreAllMocks()
})

describe('RouteSurface', () => {
  it('announces one accessible fallback while the route chunk is pending', async () => {
    const pending = deferred()
    const load = vi.fn(() => pending.promise)

    act(() => root.render(<RouteSurface load={load} label="a agenda" />))

    const busy = host.querySelector('[aria-busy="true"]')
    expect(busy?.getAttribute('aria-label')).toBe('Carregando a agenda')
    expect(host.querySelectorAll('[role="status"]')).toHaveLength(1)
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Carregando a agenda…')
    expect(host.querySelectorAll('.ds-skeleton[aria-hidden="true"]')).toHaveLength(5)

    await act(async () => {
      pending.resolve({ default: () => <h1>Agenda pronta</h1> })
      await pending.promise
    })

    expect(host.textContent).toContain('Agenda pronta')
    expect(host.querySelectorAll('[role="status"]')).toHaveLength(0)
  })

  it('renders the resolved route component', async () => {
    const load = vi.fn().mockResolvedValue({ default: ({ name }) => <h1>Olá, {name}</h1> })

    act(() => root.render(<RouteSurface load={load} label="a comunidade" componentProps={{ name: 'Ana' }} />))
    await settle()

    expect(host.querySelector('h1')?.textContent).toBe('Olá, Ana')
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('recovers from an import failure with one explicit retry', async () => {
    const load = vi.fn()
      .mockRejectedValueOnce(new Error('chunk unavailable'))
      .mockResolvedValueOnce({ default: () => <h1>Relatórios carregados</h1> })

    act(() => root.render(<RouteSurface load={load} label="os relatórios" />))
    await settle()

    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Não foi possível carregar os relatórios.')
    const retry = [...host.querySelectorAll('button')].find(button => button.textContent === 'Tentar novamente')
    expect(retry).toBeTruthy()

    await act(async () => { retry.click() })
    await settle()

    expect(host.querySelector('h1')?.textContent).toBe('Relatórios carregados')
    expect(load).toHaveBeenCalledTimes(2)
    expect(host.querySelector('[role="alert"]')).toBeNull()
  })

  it('shares one pending import across concurrent mounts and re-renders', async () => {
    const pending = deferred()
    const load = vi.fn(() => pending.promise)
    const Surface = createRouteSurface(load, 'a agenda')

    act(() => root.render(<><Surface name="Ana" /><Surface name="Bia" /></>))
    expect(load).toHaveBeenCalledTimes(1)

    act(() => root.render(<><Surface name="Ana Maria" /><Surface name="Bia" /></>))
    expect(load).toHaveBeenCalledTimes(1)

    await act(async () => {
      pending.resolve({ default: ({ name }) => <p>{name}</p> })
      await pending.promise
    })

    expect([...host.querySelectorAll('p')].map(node => node.textContent)).toEqual(['Ana Maria', 'Bia'])
  })

  it('keeps a newer load generation when an older import resolves last', async () => {
    const older = deferred()
    const newer = deferred()
    const oldLoad = vi.fn(() => older.promise)
    const newLoad = vi.fn(() => newer.promise)

    act(() => root.render(<RouteSurface load={oldLoad} label="a rota" />))
    act(() => root.render(<RouteSurface load={newLoad} label="a rota" />))

    await act(async () => {
      newer.resolve({ default: () => <h1>Nova rota</h1> })
      await newer.promise
    })
    await act(async () => {
      older.resolve({ default: () => <h1>Rota antiga</h1> })
      await Promise.resolve()
    })

    expect(host.querySelector('h1')?.textContent).toBe('Nova rota')
  })
})
