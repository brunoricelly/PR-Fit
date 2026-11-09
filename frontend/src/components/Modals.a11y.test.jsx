// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Modals from './Modals.jsx'

const mocks = vi.hoisted(() => {
  const listeners = new Set()
  const state = {
    sheets: [],
    closeSheet(id) {
      state.sheets = state.sheets.filter(sheet => sheet.id !== id)
      listeners.forEach(listener => listener())
    },
  }
  return {
    state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    setSheets(sheets) { state.sheets = sheets; listeners.forEach(listener => listener()) },
  }
})

vi.mock('../store/useUI.js', async () => {
  const ReactModule = await import('react')
  const useUI = (selector = state => state) => ReactModule.useSyncExternalStore(
    mocks.subscribe,
    () => selector(mocks.state),
    () => selector(mocks.state),
  )
  useUI.getState = () => mocks.state
  return { useUI }
})

let host
let pageButton
let modalHost
let root

const sheet = (id, options = {}) => ({
  id,
  kind: options.kind || 'sheet',
  locked: options.locked || false,
  wide: options.wide || false,
  label: options.label,
  render: options.render || (() => <><h3>{options.title || id}</h3><button type="button">Primeiro</button><button type="button">Último</button></>),
})

const setSheets = sheets => act(async () => { mocks.setSheets(sheets) })

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  mocks.state.sheets = []
  window.scrollTo = vi.fn()
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener() {}, removeEventListener() {} })
  history.replaceState({}, '', '#/test')
  host = document.createElement('div')
  host.id = 'page'
  pageButton = document.createElement('button')
  pageButton.textContent = 'Abrir'
  host.appendChild(pageButton)
  document.body.appendChild(host)
  modalHost = document.createElement('div')
  document.body.appendChild(modalHost)
  root = createRoot(modalHost)
  await act(async () => { root.render(<Modals />) })
})

afterEach(async () => {
  if (root) await act(async () => { root.unmount() })
  document.body.innerHTML = ''
  document.body.style.cssText = ''
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('Modals accessible overlay behavior', () => {
  it('names sheets and centers, traps Tab both ways, handles Escape and restores the page', async () => {
    pageButton.focus()
    await setSheets([sheet('settings', { title: 'Configurações do treino' })])

    const dialog = document.querySelector('[role="dialog"]')
    const buttons = dialog.querySelectorAll('button')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('aria-labelledby')).toBe(dialog.querySelector('h3').id)
    expect(document.activeElement).toBe(buttons[0])
    expect(host.hasAttribute('inert')).toBe(true)
    expect(document.body.style.position).toBe('fixed')

    buttons[buttons.length - 1].focus()
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })))
    expect(document.activeElement).toBe(buttons[0])

    buttons[0].focus()
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true })))
    expect(document.activeElement).toBe(buttons[buttons.length - 1])

    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(host.hasAttribute('inert')).toBe(false)
    expect(document.body.style.position).toBe('')
    expect(document.activeElement).toBe(pageButton)

    await setSheets([sheet('confirm', { kind: 'center', title: 'Confirmar exclusão' })])
    expect(document.querySelector('.center[role="dialog"]')).toBeTruthy()
  })

  it('keeps focus on the dialog when it has no focusable descendants and closes from the backdrop', async () => {
    await setSheets([sheet('empty', { render: () => <h3>Somente leitura</h3> })])
    const dialog = document.querySelector('[role="dialog"]')
    expect(document.activeElement).toBe(dialog)
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })))
    expect(document.activeElement).toBe(dialog)

    act(() => document.querySelector('.mback').click())
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('honors lock changes while open before allowing Escape', async () => {
    await setSheets([sheet('locked', { locked: true, title: 'Bloqueado' })])
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(document.querySelector('[role="dialog"]')).toBeTruthy()

    await setSheets([sheet('locked', { locked: false, title: 'Liberado' })])
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('does not let a closed sheet restore focus over a stacked replacement', async () => {
    const frames = []
    window.requestAnimationFrame = callback => { frames.push(callback); return frames.length }
    window.cancelAnimationFrame = vi.fn()
    pageButton.focus()

    await setSheets([sheet('one', { title: 'Um' })])
    const firstButton = document.querySelector('[role="dialog"] button')
    firstButton.focus()
    await setSheets([sheet('two', { title: 'Dois' })])
    const replacementButton = document.querySelector('[role="dialog"] button')
    expect(document.activeElement).toBe(replacementButton)

    act(() => frames.splice(0).forEach(frame => frame()))
    expect(document.activeElement).toBe(replacementButton)
  })

  it('restores focus through a nested stack and cancels obsolete restore frames', async () => {
    const frames = []
    window.requestAnimationFrame = callback => { frames.push(callback); return frames.length }
    window.cancelAnimationFrame = vi.fn()
    pageButton.focus()

    const first = sheet('one', { title: 'Um' })
    const second = sheet('two', { kind: 'center', title: 'Dois' })
    await setSheets([first])
    const firstButton = document.querySelector('[role="dialog"] button')
    firstButton.focus()
    await setSheets([first, second])
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(2)

    await setSheets([first])
    expect(document.activeElement).toBe(firstButton)
    await setSheets([])
    expect(document.activeElement).toBe(pageButton)
    expect(window.cancelAnimationFrame).toHaveBeenCalled()

    act(() => frames.splice(0).forEach(frame => frame()))
    expect(document.activeElement).toBe(pageButton)
  })

  it('dismisses swipe immediately when reduced motion is requested', async () => {
    vi.useFakeTimers()
    window.matchMedia = vi.fn().mockReturnValue({ matches: true, addEventListener() {}, removeEventListener() {} })
    const timeout = vi.spyOn(window, 'setTimeout')
    await setSheets([sheet('swipe', { title: 'Arrastar' })])
    const dialog = document.querySelector('.sheet')

    act(() => {
      dialog.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 0, clientY: 0 }))
      dialog.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 0, clientY: 120 }))
      dialog.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 0, clientY: 120 }))
    })

    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(timeout.mock.calls.some(([, delay]) => delay === 180)).toBe(false)
  })
})
