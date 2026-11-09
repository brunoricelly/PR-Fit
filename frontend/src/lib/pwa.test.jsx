// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import {
  getPwaState,
  subscribePwa,
  applyUpdate,
  dismissUpdate,
  promptInstall,
  initPwa,
  usePWA,
  __testResetPwa,
  __testSetWaitingWorker,
  __testSetDeferredPrompt,
} from './pwa.js'
import PwaBanner from '../components/PwaBanner.jsx'
import { guardReactWarnings } from '../test/react-warning-guard.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

describe('PWA state and Service Worker update lifecycle', () => {
  let container = null
  let root = null
  let assertNoReactWarnings

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    assertNoReactWarnings = guardReactWarnings()
    __testResetPwa()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container, { onCaughtError: () => {} })
  })

  afterEach(() => {
    if (root) {
      act(() => {
        root.unmount()
      })
      root = null
    }
    if (container && container.parentNode) {
      container.parentNode.removeChild(container)
      container = null
    }
    __testResetPwa()
    assertNoReactWarnings()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('reports initial PWA state accurately', () => {
    const state = getPwaState()
    expect(state.updateAvailable).toBe(false)
    expect(state.canInstall).toBe(false)
    expect(state.updateDismissed).toBe(false)
    expect(state.isOffline).toBe(false)
  })

  it('notifies subscribers when a new worker is waiting', () => {
    const updates = []
    const unsub = subscribePwa(s => updates.push(s))

    expect(updates[0].updateAvailable).toBe(false)

    const mockWorker = { postMessage: vi.fn() }
    __testSetWaitingWorker(mockWorker)

    expect(updates[updates.length - 1].updateAvailable).toBe(true)
    unsub()
  })

  it('dismisses update without blocking future navigation or actions', () => {
    const mockWorker = { postMessage: vi.fn() }
    __testSetWaitingWorker(mockWorker)
    expect(getPwaState().updateAvailable).toBe(true)

    dismissUpdate()
    expect(getPwaState().updateAvailable).toBe(false)
    expect(getPwaState().updateDismissed).toBe(true)
  })

  it('sends SKIP_WAITING to waiting worker when update is applied', () => {
    const mockWorker = { postMessage: vi.fn() }
    __testSetWaitingWorker(mockWorker)

    applyUpdate()
    expect(mockWorker.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' })
  })

  it('handles deferred install prompt and executes user choice', async () => {
    const promptMock = vi.fn()
    const mockEvent = {
      prompt: promptMock,
      userChoice: Promise.resolve({ outcome: 'accepted' }),
    }
    __testSetDeferredPrompt(mockEvent)
    expect(getPwaState().canInstall).toBe(true)

    const accepted = await promptInstall()
    expect(promptMock).toHaveBeenCalled()
    expect(accepted).toBe(true)
    expect(getPwaState().canInstall).toBe(false)
  })

  it('encapsulates usePWA state transitions within act when waiting worker arrives and dismisses', () => {
    let latest
    function Consumer() {
      const pwa = usePWA()
      latest = pwa
      return <div data-status={pwa.updateAvailable ? 'available' : 'idle'} />
    }

    act(() => {
      root.render(<Consumer />)
    })

    expect(latest.updateAvailable).toBe(false)
    expect(container.querySelector('[data-status="idle"]')).not.toBeNull()

    const mockWorker = { postMessage: vi.fn() }
    act(() => {
      __testSetWaitingWorker(mockWorker)
    })

    expect(latest.updateAvailable).toBe(true)
    expect(container.querySelector('[data-status="available"]')).not.toBeNull()

    act(() => {
      latest.dismissUpdate()
    })

    expect(latest.updateAvailable).toBe(false)
    expect(container.querySelector('[data-status="idle"]')).not.toBeNull()
  })

  it('renders PwaBanner when update is available and allows update or dismiss', () => {
    const mockWorker = { postMessage: vi.fn() }

    act(() => {
      root.render(<PwaBanner />)
    })

    expect(container.querySelector('.pwa-banner')).toBeNull()

    act(() => {
      __testSetWaitingWorker(mockWorker)
    })

    const banner = container.querySelector('.pwa-banner')
    expect(banner).not.toBeNull()
    expect(banner.textContent).toContain('Atualização disponível')

    const updateBtn = container.querySelector('.pwa-update-btn')
    const dismissBtn = container.querySelector('.pwa-dismiss-btn')
    expect(updateBtn).not.toBeNull()
    expect(dismissBtn).not.toBeNull()

    act(() => {
      dismissBtn.click()
    })

    expect(container.querySelector('.pwa-banner')).toBeNull()
  })

  it('triggers applyUpdate when clicking update button in PwaBanner within act', () => {
    const mockWorker = { postMessage: vi.fn() }

    act(() => {
      root.render(<PwaBanner />)
    })

    act(() => {
      __testSetWaitingWorker(mockWorker)
    })

    const updateBtn = container.querySelector('.pwa-update-btn')
    expect(updateBtn).not.toBeNull()

    act(() => {
      updateBtn.click()
    })

    expect(mockWorker.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' })
  })

  it('falls back to direct window reload when applyUpdate is invoked without a waiting worker', () => {
    const reloadSpy = vi.spyOn(window.location, 'reload').mockImplementation(() => {})

    applyUpdate()
    expect(reloadSpy).toHaveBeenCalledTimes(1)
  })

  it('falls back to window reload if controller change does not occur within timeout', () => {
    vi.useFakeTimers()
    const reloadSpy = vi.spyOn(window.location, 'reload').mockImplementation(() => {})
    const mockWorker = { postMessage: vi.fn() }
    __testSetWaitingWorker(mockWorker)

    applyUpdate()
    expect(mockWorker.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' })
    expect(reloadSpy).not.toHaveBeenCalled()

    vi.advanceTimersByTime(800)
    expect(reloadSpy).toHaveBeenCalledTimes(1)
  })

  it('handles postMessage failure gracefully and still schedules fallback reload', () => {
    vi.useFakeTimers()
    const reloadSpy = vi.spyOn(window.location, 'reload').mockImplementation(() => {})
    const mockWorker = {
      postMessage: vi.fn(() => {
        throw new Error('Worker disconnected')
      }),
    }
    __testSetWaitingWorker(mockWorker)

    expect(() => applyUpdate()).not.toThrow()
    expect(reloadSpy).not.toHaveBeenCalled()

    vi.advanceTimersByTime(800)
    expect(reloadSpy).toHaveBeenCalledTimes(1)
  })

  it('manages lifecycle events and reloads on controllerchange when update was requested', () => {
    const reloadSpy = vi.spyOn(window.location, 'reload').mockImplementation(() => {})
    const swListeners = {}
    const mockWorker = { postMessage: vi.fn() }
    const registration = {
      waiting: null,
      installing: null,
      addEventListener: vi.fn(),
    }

    const originalSW = navigator.serviceWorker
    Object.defineProperty(navigator, 'serviceWorker', {
      value: {
        addEventListener: vi.fn((event, handler) => {
          swListeners[event] = handler
        }),
        removeEventListener: vi.fn((event, handler) => {
          if (swListeners[event] === handler) delete swListeners[event]
        }),
        register: vi.fn().mockResolvedValue(registration),
        controller: {},
      },
      configurable: true,
      writable: true,
    })

    try {
      const cleanup = initPwa()

      swListeners.controllerchange?.()
      expect(reloadSpy).not.toHaveBeenCalled()

      __testSetWaitingWorker(mockWorker)
      applyUpdate()

      swListeners.controllerchange?.()
      expect(reloadSpy).toHaveBeenCalledTimes(1)

      const beforeInstallEvent = new Event('beforeinstallprompt')
      beforeInstallEvent.prompt = vi.fn()
      window.dispatchEvent(beforeInstallEvent)
      expect(getPwaState().canInstall).toBe(true)

      window.dispatchEvent(new Event('appinstalled'))
      expect(getPwaState().canInstall).toBe(false)

      cleanup()
      expect(navigator.serviceWorker.removeEventListener).toHaveBeenCalledWith(
        'controllerchange',
        expect.any(Function),
      )
    } finally {
      if (originalSW) {
        Object.defineProperty(navigator, 'serviceWorker', {
          value: originalSW,
          configurable: true,
          writable: true,
        })
      } else {
        delete navigator.serviceWorker
      }
    }
  })

  it('detects existing waiting worker on service worker registration', async () => {
    const waitingWorker = { postMessage: vi.fn() }
    const registration = {
      waiting: waitingWorker,
      addEventListener: vi.fn(),
    }

    const originalSW = navigator.serviceWorker
    Object.defineProperty(navigator, 'serviceWorker', {
      value: {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        register: vi.fn().mockResolvedValue(registration),
        controller: {},
      },
      configurable: true,
      writable: true,
    })

    try {
      const cleanup = initPwa()
      await Promise.resolve()
      await Promise.resolve()

      expect(getPwaState().updateAvailable).toBe(true)
      cleanup()
    } finally {
      if (originalSW) {
        Object.defineProperty(navigator, 'serviceWorker', {
          value: originalSW,
          configurable: true,
          writable: true,
        })
      } else {
        delete navigator.serviceWorker
      }
    }
  })
})
