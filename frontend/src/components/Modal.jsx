import React, { useEffect, useId, useRef } from 'react'
import Icon from './Icon.jsx'

const modalStack = []
let scrollLockCount = 0
let savedBodyOverflow = ''
let savedBodyPaddingRight = ''

const focusableSelector = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

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

    const focusable = dialog?.querySelectorAll(focusableSelector)
    const preferredFocus = dialog?.querySelector('[autofocus]') || focusable?.[0]
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
      const nodes = Array.from(dialog?.querySelectorAll(focusableSelector) || [])
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

  return (
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
}

export function Drawer(props) {
  return <Modal {...props} variant="drawer" />
}
