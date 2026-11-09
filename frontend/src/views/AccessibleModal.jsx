import React, { useId, useRef } from 'react'
import Icon from '../components/Icon.jsx'
import { useOverlayA11y } from '../components/overlay-a11y.js'
import { professionalText as p } from '../lib/professional-copy.js'

export default function AccessibleModal({
  id,
  title,
  onClose,
  children,
  className = '',
  restoreFocusTo,
}) {
  const generatedId = useId()
  const modalId = id || `modal-${generatedId.replace(/:/g, '')}`
  const titleId = `${modalId}-title`
  const dialogRef = useRef(null)
  const layerRef = useRef(null)

  useOverlayA11y({
    dialogRef,
    layerRef,
    onClose,
    closeOnEscape: typeof onClose === 'function',
    fallbackLabel: title,
    lockBodyScroll: true,
    restoreFocusTo,
  })

  return (
    <div
      ref={layerRef}
      className="pro-modal-backdrop"
      onClick={e => {
        if (e.target === e.currentTarget && !layerRef.current?.hasAttribute('inert')) onClose?.()
      }}
    >
      <div
        ref={dialogRef}
        id={modalId}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`pro-modal-container card ${className}`}
      >
        <div className="pro-modal-head">
          <h2 id={titleId}>{title}</h2>
          <button
            type="button"
            className="pro-modal-close ds-icon-button ghost"
            onClick={onClose}
            aria-label={p('Close')}
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
