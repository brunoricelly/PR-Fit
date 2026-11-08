import React, { useEffect, useRef } from 'react'
import Icon from '../components/Icon.jsx'
import { professionalText as p } from '../lib/professional-copy.js'

export default function AccessibleModal({ id, title, onClose, children, className = '' }) {
  const dialogRef = useRef(null)
  const previousFocusRef = useRef(null)

  useEffect(() => {
    previousFocusRef.current = document.activeElement
    const focusable = dialogRef.current?.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    )
    if (focusable && focusable.length > 0) {
      focusable[0].focus()
    } else {
      dialogRef.current?.focus()
    }

    const onKeyDown = event => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key === 'Tab') {
        const nodes = Array.from(dialogRef.current?.querySelectorAll(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        ) || [])
        if (!nodes.length) return
        const first = nodes[0]
        const last = nodes[nodes.length - 1]
        if (event.shiftKey) {
          if (document.activeElement === first) {
            event.preventDefault()
            last.focus()
          }
        } else {
          if (document.activeElement === last) {
            event.preventDefault()
            first.focus()
          }
        }
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      if (previousFocusRef.current && typeof previousFocusRef.current.focus === 'function') {
        previousFocusRef.current.focus()
      }
    }
  }, [onClose])

  return (
    <div className="pro-modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        tabIndex={-1}
        className={`pro-modal-container card ${className}`}
      >
        <div className="pro-modal-head">
          <h2 id={`${id}-title`}>{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={p('Close') || 'Close'}
            className="pro-modal-close"
          >
            <Icon name="xmark" />
          </button>
        </div>
        <div className="pro-modal-body">
          {children}
        </div>
      </div>
    </div>
  )
}
