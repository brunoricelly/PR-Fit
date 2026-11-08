import React, { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import Icon from './Icon.jsx'

const modalStack = []
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
  if (element.closest?.('[aria-hidden="true"], [hidden]')) return false
  if (element.tagName === 'INPUT' && element.type === 'hidden') return false

  if (typeof window !== 'undefined') {
    let current = element
    while (current && current !== document.body && current !== document.documentElement) {
      if (current.hasAttribute('hidden') || current.getAttribute('aria-hidden') === 'true') return false
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
      // ignore
    }
  }

  return true
}

function getFocusableElements(container) {
  if (!container) return []
  return Array.from(container.querySelectorAll(focusableSelector)).filter(isElementVisible)
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

export default function Modal({
  id,
  title,
  description,
  onClose,
  children,
  className = '',
  variant = 'modal',
  closeLabel = 'Fechar',
}) {
  const generatedId = useId()
  const modalId = id || `modal-${generatedId.replace(/:/g, '')}`
  const dialogRef = useRef(null)
  const previousFocusRef = useRef(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    const dialog = dialogRef.current
    previousFocusRef.current = document.activeElement
    modalStack.push(dialog)
    lockScroll()

    const focusable = getFocusableElements(dialog)
    const autofocusTarget = dialog?.querySelector('[autofocus]')
    const preferredFocus = (autofocusTarget && isElementVisible(autofocusTarget)) ? autofocusTarget : focusable[0]
    if (preferredFocus) preferredFocus.focus()
    else dialog?.focus()

    const onKeyDown = event => {
      if (modalStack.at(-1) !== dialog) return
      if (event.key === 'Escape') {
        event.preventDefault()
        onCloseRef.current?.()
        return
      }
      if (event.key !== 'Tab') return
      const nodes = getFocusableElements(dialog)
      if (!nodes.length) {
        event.preventDefault()
        dialog?.focus()
        return
      }
      const first = nodes[0]
      const last = nodes[nodes.length - 1]
      if (!dialog?.contains(document.activeElement)) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      const index = modalStack.lastIndexOf(dialog)
      if (index !== -1) modalStack.splice(index, 1)
      unlockScroll()
      const previousFocus = previousFocusRef.current
      if (previousFocus?.isConnected && typeof previousFocus.focus === 'function') previousFocus.focus()
    }
  }, [])

  const titleId = `${modalId}-title`
  const descriptionId = description ? `${modalId}-description` : undefined

  const content = (
    <div
      className="ds-modal-backdrop"
      onClick={event => {
        if (event.target === event.currentTarget && modalStack.at(-1) === dialogRef.current) onClose?.()
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        className={`ds-modal pro-modal-container ${variant === 'drawer' ? 'drawer' : ''}${className ? ` ${className}` : ''}`}
      >
        <div className="ds-modal-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" onClick={onClose} aria-label={closeLabel} className="ds-icon-button ghost">
            <Icon name="xmark" />
          </button>
        </div>
        <div className="ds-modal-body">
          {description && <p id={descriptionId} className="ds-field-help">{description}</p>}
          {children}
        </div>
      </div>
    </div>
  )

  const portalTarget = typeof document !== 'undefined'
    ? (document.getElementById('modal-root') || document.body)
    : null

  return portalTarget ? createPortal(content, portalTarget) : content
}

export function Drawer(props) {
  return <Modal {...props} variant="drawer" />
}
