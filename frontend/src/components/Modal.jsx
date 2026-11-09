import React, { useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import Icon from './Icon.jsx'
import { useOverlayA11y } from './overlay-a11y.js'

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
  const backdropRef = useRef(null)
  useOverlayA11y({
    dialogRef,
    layerRef: backdropRef,
    onClose,
    closeOnEscape: typeof onClose === 'function',
    fallbackLabel: title,
    lockBodyScroll: true,
  })

  const titleId = `${modalId}-title`
  const descriptionId = description ? `${modalId}-description` : undefined

  const content = (
    <div
      ref={backdropRef}
      className="ds-modal-backdrop"
      onClick={event => {
        if (event.target === event.currentTarget && !event.currentTarget.hasAttribute('inert')) onClose?.()
      }}
    >
      <div
        id={modalId}
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
