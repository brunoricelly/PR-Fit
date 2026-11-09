import { useState, useEffect } from 'react'
import { MOBILE } from './mobile.js'

let swRegistration = null
let waitingWorker = null
let deferredInstallPrompt = null
let reloadOnControllerChange = false
let updateDismissed = false
const listeners = new Set()

export function getPwaState() {
  return {
    updateAvailable: Boolean(waitingWorker && !updateDismissed),
    canInstall: Boolean(deferredInstallPrompt),
    isOffline: typeof navigator !== 'undefined' ? navigator.onLine === false : false,
    updateDismissed,
  }
}

export function notifyPwaListeners() {
  const state = getPwaState()
  for (const listener of listeners) {
    try {
      listener(state)
    } catch {
      // listener errors should not break subscriber loop
    }
  }
}

export function subscribePwa(listener) {
  listeners.add(listener)
  listener(getPwaState())
  return () => {
    listeners.delete(listener)
  }
}

export function applyUpdate() {
  if (waitingWorker) {
    reloadOnControllerChange = true
    try {
      waitingWorker.postMessage({ type: 'SKIP_WAITING' })
    } catch {
      // fallback if postMessage fails
    }
    setTimeout(() => {
      if (typeof window !== 'undefined') window.location.reload()
    }, 800)
    return
  }
  if (typeof window !== 'undefined') {
    window.location.reload()
  }
}

export function dismissUpdate() {
  updateDismissed = true
  notifyPwaListeners()
}

export async function promptInstall() {
  if (!deferredInstallPrompt) return false
  const promptEvent = deferredInstallPrompt
  deferredInstallPrompt = null
  notifyPwaListeners()
  try {
    promptEvent.prompt()
    const choice = await promptEvent.userChoice
    return choice?.outcome === 'accepted'
  } catch {
    return false
  }
}

let initialized = false

export function initPwa() {
  if (initialized || MOBILE || typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    return () => {}
  }
  initialized = true

  const onOnlineChange = () => notifyPwaListeners()
  window.addEventListener('online', onOnlineChange)
  window.addEventListener('offline', onOnlineChange)

  const onBeforeInstallPrompt = e => {
    e.preventDefault()
    deferredInstallPrompt = e
    notifyPwaListeners()
  }
  window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt)

  const onAppInstalled = () => {
    deferredInstallPrompt = null
    notifyPwaListeners()
  }
  window.addEventListener('appinstalled', onAppInstalled)

  const onControllerChange = () => {
    if (reloadOnControllerChange && typeof window !== 'undefined') {
      window.location.reload()
    }
  }
  navigator.serviceWorker.addEventListener('controllerchange', onControllerChange)

  if (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
    navigator.serviceWorker.register('sw.js').then(reg => {
      swRegistration = reg

      if (reg.waiting) {
        waitingWorker = reg.waiting
        notifyPwaListeners()
      }

      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing
        if (!newWorker) return
        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            waitingWorker = newWorker
            notifyPwaListeners()
          }
        })
      })
    }).catch(() => {})
  }

  return () => {
    window.removeEventListener('online', onOnlineChange)
    window.removeEventListener('offline', onOnlineChange)
    window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt)
    window.removeEventListener('appinstalled', onAppInstalled)
    navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange)
    initialized = false
  }
}

export function usePWA() {
  const [state, setState] = useState(getPwaState)
  useEffect(() => {
    return subscribePwa(setState)
  }, [])
  return {
    ...state,
    applyUpdate,
    dismissUpdate,
    promptInstall,
  }
}

export function __testResetPwa() {
  swRegistration = null
  waitingWorker = null
  deferredInstallPrompt = null
  reloadOnControllerChange = false
  updateDismissed = false
  listeners.clear()
  initialized = false
}

export function __testSetWaitingWorker(worker) {
  waitingWorker = worker
  updateDismissed = false
  notifyPwaListeners()
}

export function __testSetDeferredPrompt(prompt) {
  deferredInstallPrompt = prompt
  notifyPwaListeners()
}
