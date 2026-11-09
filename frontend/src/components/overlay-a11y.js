import { useLayoutEffect, useRef } from 'react'

const overlays = []
const managedElements = new Map()
let focusGeneration = 0
let pendingRestore = null
let generatedLabelId = 0
let scrollLockCount = 0
let savedBodyOverflow = ''
let savedBodyPaddingRight = ''

const focusableSelector = [
  'button:not([disabled]):not([aria-hidden="true"])',
  '[href]:not([aria-hidden="true"])',
  'input:not([disabled]):not([type="hidden"]):not([aria-hidden="true"])',
  'select:not([disabled]):not([aria-hidden="true"])',
  'textarea:not([disabled]):not([aria-hidden="true"])',
  '[tabindex]:not([tabindex="-1"]):not([aria-hidden="true"])',
].join(', ')

function isElementVisible(element) {
  if (!element || element.nodeType !== 1) return false
  if (element.hasAttribute('hidden') || element.getAttribute('aria-hidden') === 'true') return false
  if (element.closest?.('[aria-hidden="true"], [hidden], [inert]')) return false
  if (element.tagName === 'INPUT' && element.type === 'hidden') return false

  if (typeof window !== 'undefined') {
    let current = element
    while (current && current !== document.body && current !== document.documentElement) {
      if (current.hasAttribute('hidden') || current.getAttribute('aria-hidden') === 'true' || current.hasAttribute('inert')) return false
      if (current.style && (current.style.display === 'none' || current.style.visibility === 'hidden')) return false
      if (typeof window.getComputedStyle === 'function') {
        const computed = window.getComputedStyle(current)
        if (computed && (computed.display === 'none' || computed.visibility === 'hidden')) return false
      }
      current = current.parentElement
    }
  }

  if (typeof element.checkVisibility === 'function') {
    try {
      if (!element.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })) return false
    } catch {
      // ignore unsupported visibility options
    }
  }

  return true
}

function getFocusableElements(container) {
  if (!container) return []
  return Array.from(container.querySelectorAll(focusableSelector)).filter(isElementVisible)
}

function saveAccessibilityState(element) {
  if (managedElements.has(element)) return
  managedElements.set(element, {
    ariaHidden: element.getAttribute('aria-hidden'),
    hadInertAttribute: element.hasAttribute('inert'),
    inert: typeof element.inert === 'boolean' ? element.inert : undefined,
  })
}

function hideFromAccessibilityTree(element) {
  if (!element) return
  saveAccessibilityState(element)
  element.setAttribute('aria-hidden', 'true')
  element.setAttribute('inert', '')
  try { element.inert = true } catch { /* inert attribute remains the fallback */ }
}

function restoreManagedElements() {
  for (const [element, state] of managedElements) {
    if (!element) continue
    if (state.ariaHidden === null) element.removeAttribute('aria-hidden')
    else element.setAttribute('aria-hidden', state.ariaHidden)
    if (state.hadInertAttribute) element.setAttribute('inert', '')
    else element.removeAttribute('inert')
    if (state.inert !== undefined) {
      try { element.inert = state.inert } catch { /* attribute restoration is enough */ }
    }
  }
  managedElements.clear()
}

function syncBackgroundAccessibility() {
  restoreManagedElements()
  const top = overlays.at(-1)
  if (!top || typeof document === 'undefined') return

  const activeBodyChild = Array.from(document.body.children).find(child => child === top.layer || child.contains(top.layer))
  for (const child of Array.from(document.body.children)) {
    if (child !== activeBodyChild) hideFromAccessibilityTree(child)
  }
  for (const overlay of overlays) {
    if (overlay !== top && overlay.layer !== activeBodyChild) hideFromAccessibilityTree(overlay.layer)
  }
}

function cancelPendingRestore() {
  focusGeneration += 1
  if (!pendingRestore) return
  if (pendingRestore.frame !== null && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
    window.cancelAnimationFrame(pendingRestore.frame)
  }
  pendingRestore = null
}

function focusElement(element) {
  if (!element?.isConnected || typeof element.focus !== 'function') return false
  try { element.focus(); return document.activeElement === element } catch { return false }
}

function focusDialog(dialog, initialFocus) {
  const autofocusTarget = dialog?.querySelector('[autofocus], [data-autofocus]')
  const focusable = getFocusableElements(dialog)
  const preferred = autofocusTarget && isElementVisible(autofocusTarget) ? autofocusTarget : focusable[0]
  if (initialFocus === 'dialog') {
    if (!focusElement(dialog)) focusElement(preferred)
    return
  }
  if (!focusElement(preferred)) focusElement(dialog)
}

function scheduleFocusRestore(previousFocus) {
  const owner = overlays.at(-1) || null
  const target = owner && !owner.dialog.contains(previousFocus) ? owner.dialog : previousFocus
  const generation = focusGeneration
  const canRestore = () => {
    if (generation !== focusGeneration) return false
    if ((overlays.at(-1) || null) !== owner) return false
    return !!target?.isConnected
  }
  if (canRestore()) focusElement(target)
  if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') return
  const frame = window.requestAnimationFrame(() => {
    if (pendingRestore?.generation !== generation) return
    pendingRestore = null
    if (canRestore()) focusElement(target)
  })
  pendingRestore = { generation, frame }
}

function ensureAccessibleName(dialog, fallbackLabel) {
  if (!dialog || dialog.hasAttribute('aria-label') || dialog.hasAttribute('aria-labelledby')) return
  const heading = dialog.querySelector('[data-dialog-title], h1, h2, h3, h4, legend, [role="heading"]')
  if (heading) {
    if (!heading.id) heading.id = `overlay-title-${++generatedLabelId}`
    dialog.setAttribute('aria-labelledby', heading.id)
  } else {
    dialog.setAttribute('aria-label', fallbackLabel || 'Dialog')
  }
}

function lockScroll() {
  if (scrollLockCount === 0) {
    savedBodyOverflow = document.body.style.overflow
    savedBodyPaddingRight = document.body.style.paddingRight
    const scrollbarWidth = Math.max(0, window.innerWidth - document.documentElement.clientWidth)
    document.body.style.overflow = 'hidden'
    if (scrollbarWidth) document.body.style.paddingRight = `${scrollbarWidth}px`
  }
  scrollLockCount += 1
}

function unlockScroll() {
  scrollLockCount = Math.max(0, scrollLockCount - 1)
  if (scrollLockCount === 0) {
    document.body.style.overflow = savedBodyOverflow
    document.body.style.paddingRight = savedBodyPaddingRight
  }
}

export function useOverlayA11y({
  dialogRef,
  layerRef,
  onClose,
  closeOnEscape = true,
  fallbackLabel,
  lockBodyScroll = false,
  restoreFocusTo,
  initialFocus,
}) {
  const onCloseRef = useRef(onClose)
  const closeOnEscapeRef = useRef(closeOnEscape)
  onCloseRef.current = onClose
  closeOnEscapeRef.current = closeOnEscape

  useLayoutEffect(() => {
    const dialog = dialogRef.current
    const layer = layerRef?.current || dialog
    if (!dialog || !layer) return

    cancelPendingRestore()
    const explicitTarget = restoreFocusTo && (restoreFocusTo.current || restoreFocusTo)
    const previousFocus = (explicitTarget?.isConnected ? explicitTarget : null) || document.activeElement
    const overlay = { dialog, layer }
    overlays.push(overlay)
    ensureAccessibleName(dialog, fallbackLabel)
    if (lockBodyScroll) lockScroll()
    syncBackgroundAccessibility()
    focusDialog(dialog, initialFocus)

    const onKeyDown = event => {
      if (overlays.at(-1) !== overlay) return
      if (event.key === 'Escape' && closeOnEscapeRef.current) {
        event.preventDefault()
        onCloseRef.current?.()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = getFocusableElements(dialog)
      if (!focusable.length) {
        event.preventDefault()
        focusElement(dialog)
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (!dialog.contains(document.activeElement)) {
        event.preventDefault()
        focusElement(event.shiftKey ? last : first)
      } else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        event.preventDefault()
        focusElement(last)
      } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog)) {
        event.preventDefault()
        focusElement(first)
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      const index = overlays.lastIndexOf(overlay)
      if (index !== -1) overlays.splice(index, 1)
      if (lockBodyScroll) unlockScroll()
      cancelPendingRestore()
      syncBackgroundAccessibility()
      scheduleFocusRestore(previousFocus)
    }
  }, [])
}
