// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Toast from './Toast.jsx'
import { useUI } from '../store/useUI.js'

let host
let root

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers()
  useUI.setState({ toastMsg: '', toastAction: null })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<Toast />))
})

afterEach(() => {
  if (root) act(() => root.unmount())
  host.remove()
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('Toast timer lifecycle', () => {
  it('cancels its pending timeout on unmount without a late store update', () => {
    const listener = vi.fn()
    const unsubscribe = useUI.subscribe(listener)
    act(() => useUI.getState().toast('Saved'))
    expect(vi.getTimerCount()).toBe(1)

    act(() => root.unmount())
    root = null
    expect(vi.getTimerCount()).toBe(0)
    listener.mockClear()
    act(() => vi.advanceTimersByTime(5000))
    expect(listener).not.toHaveBeenCalled()
    unsubscribe()
  })
})
