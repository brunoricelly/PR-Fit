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
  __testResetPwa,
  __testSetWaitingWorker,
  __testSetDeferredPrompt,
} from './pwa.js'
import PwaBanner from '../components/PwaBanner.jsx'

describe('PWA state and Service Worker update lifecycle', () => {
  let container = null
  let root = null

  beforeEach(() => {
    __testResetPwa()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root.unmount()
      })
    }
    if (container && container.parentNode) {
      container.parentNode.removeChild(container)
    }
    vi.restoreAllMocks()
  })

  it('reports initial PWA state accurately', () => {
    const state = getPwaState()
    expect(state.updateAvailable).toBe(false)
    expect(state.canInstall).toBe(false)
    expect(state.updateDismissed).toBe(false)
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

  it('renders PwaBanner when update is available and allows update or dismiss', async () => {
    const mockWorker = { postMessage: vi.fn() }

    await act(async () => {
      root.render(<PwaBanner />)
    })

    expect(container.querySelector('.pwa-banner')).toBeNull()

    await act(async () => {
      __testSetWaitingWorker(mockWorker)
    })

    const banner = container.querySelector('.pwa-banner')
    expect(banner).not.toBeNull()
    expect(banner.textContent).toContain('Atualização disponível')

    const updateBtn = container.querySelector('.pwa-update-btn')
    const dismissBtn = container.querySelector('.pwa-dismiss-btn')
    expect(updateBtn).not.toBeNull()
    expect(dismissBtn).not.toBeNull()

    await act(async () => {
      dismissBtn.click()
    })

    expect(container.querySelector('.pwa-banner')).toBeNull()
  })
})
