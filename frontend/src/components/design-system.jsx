import React, { Children, cloneElement, forwardRef, isValidElement, useId, useState } from 'react'
import Icon from './Icon.jsx'
import EmptyStateBase from './EmptyState.jsx'
import Modal, { Drawer } from './Modal.jsx'
import Toast from './Toast.jsx'
import {
  Button as BaseButton,
  IconButton,
  NumberField as BaseNumberField,
  Switch as BaseSwitch,
} from './ui.jsx'

export function Button({ variant = 'secondary', className = '', ...props }) {
  return <BaseButton variant={variant} className={`ds-button${className ? ` ${className}` : ''}`} {...props} />
}

export { IconButton, Modal, Drawer, Toast }

export const Input = forwardRef(function Input({ className = '', ...props }, ref) {
  return <input ref={ref} className={`ds-input${className ? ` ${className}` : ''}`} {...props} />
})

export const Textarea = forwardRef(function Textarea({ className = '', ...props }, ref) {
  return <textarea ref={ref} className={`ds-input${className ? ` ${className}` : ''}`} {...props} />
})

export const Select = forwardRef(function Select({ className = '', children, ...props }, ref) {
  return <select ref={ref} className={`ds-select${className ? ` ${className}` : ''}`} {...props}>{children}</select>
})

export function NumberInput({ className = '', ...props }) {
  return <BaseNumberField className={`ds-input${className ? ` ${className}` : ''}`} {...props} />
}

export function Checkbox({ label, className = '', ...props }) {
  return (
    <label className={`ds-checkbox${className ? ` ${className}` : ''}`}>
      <input type="checkbox" className="ds-checkbox-control" {...props} />
      <span>{label}</span>
    </label>
  )
}

export function Switch({ className = '', ...props }) {
  return <BaseSwitch className={`ds-switch${className ? ` ${className}` : ''}`} {...props} />
}

export function Field({ label, help, error, required = false, children, className = '', id }) {
  const generatedId = useId()
  const fieldId = id || `field-${generatedId.replace(/:/g, '')}`
  const controlId = isValidElement(children) && children.props.id ? children.props.id : fieldId
  const helpId = help ? `${fieldId}-help` : undefined
  const errorId = error ? `${fieldId}-error` : undefined
  const control = isValidElement(children) ? cloneElement(children, {
    id: controlId,
    'aria-invalid': error ? true : children.props['aria-invalid'],
    'aria-describedby': [children.props['aria-describedby'], errorId, helpId].filter(Boolean).join(' ') || undefined,
    required: children.props.required ?? required,
  }) : children
  return (
    <div className={`ds-field${className ? ` ${className}` : ''}`}>
      {label && <label className="ds-field-label" htmlFor={controlId}>{label}{required && <span className="ds-field-required" aria-hidden="true"> *</span>}</label>}
      {control}
      {error && <p id={errorId} className="ds-field-error" role="alert">{error}</p>}
      {help && <p id={helpId} className="ds-field-help">{help}</p>}
    </div>
  )
}

export function Surface({ as: Element = 'section', className = '', children, ...props }) {
  return <Element className={`ds-surface${className ? ` ${className}` : ''}`} {...props}>{children}</Element>
}

export function Card({ as: Element = 'article', tone = 'default', className = '', children, ...props }) {
  return <Element className={`ds-card ${tone}${className ? ` ${className}` : ''}`} {...props}>{children}</Element>
}

export function PageHeader({ eyebrow, title, description, actions, className = '', headingLevel = 1, headingId }) {
  const Heading = `h${Math.min(6, Math.max(1, headingLevel))}`
  return (
    <header className={`ds-page-header${className ? ` ${className}` : ''}`}>
      <div className="ds-page-header-copy">
        {eyebrow && <span className="ds-page-header-eyebrow">{eyebrow}</span>}
        <Heading id={headingId}>{title}</Heading>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="ds-page-header-actions">{actions}</div>}
    </header>
  )
}

export function Alert({ tone = 'info', title, children, action, onRetry, retryLabel = 'Tentar novamente', className = '' }) {
  const liveRole = tone === 'error' ? 'alert' : 'status'
  const resolvedAction = action || (onRetry ? (
    <Button variant="ghost" size="sm" onClick={onRetry} className="ds-alert-retry">
      <Icon name="arrow-clockwise" />
      <span>{retryLabel}</span>
    </Button>
  ) : null)
  return (
    <div className={`ds-alert ${tone}${className ? ` ${className}` : ''}`} role={liveRole}>
      <div className="ds-alert-content">
        {title && <strong className="ds-alert-title">{title}</strong>}
        {children}
      </div>
      {resolvedAction}
    </div>
  )
}

export function Badge({ tone = 'neutral', className = '', children, ...props }) {
  return <span className={`ds-badge ${tone}${className ? ` ${className}` : ''}`} {...props}>{children}</span>
}

export function Skeleton({ width = '100%', height = '1rem', className = '', label = 'Carregando', announce = true, style, ...props }) {
  return <span className={`ds-skeleton${className ? ` ${className}` : ''}`} style={{ width, height, ...style }} {...(announce ? { role: 'status', 'aria-label': label } : { 'aria-hidden': 'true' })} {...props} />
}

export function SkeletonCard({ className = '' }) {
  return (
    <Card className={`ds-skeleton-card${className ? ` ${className}` : ''}`} aria-hidden="true">
      <Skeleton announce={false} width="42%" height="1.25rem" />
      <Skeleton announce={false} width="70%" height="0.875rem" />
      <Skeleton announce={false} width="100%" height="0.5rem" />
      <Skeleton announce={false} width="8rem" height="2.75rem" />
    </Card>
  )
}

export function EmptyState(props) {
  return <EmptyStateBase {...props} designSystem />
}

export function ErrorState({ title, text, action, onRetry, retryLabel = 'Tentar novamente', icon = 'warning', className = '' }) {
  const resolvedAction = action || (onRetry ? (
    <Button variant="secondary" onClick={onRetry} className="ds-error-retry">
      <Icon name="arrow-clockwise" />
      <span>{retryLabel}</span>
    </Button>
  ) : null)
  return <EmptyStateBase icon={icon} title={title} text={text} action={resolvedAction} designSystem className={`ds-error-state${className ? ` ${className}` : ''}`} />
}

export function Spinner({ size = '1.25rem', label = 'Carregando…', className = '', inline = false, ...props }) {
  return (
    <span
      className={`ds-spinner${inline ? ' inline' : ''}${className ? ` ${className}` : ''}`}
      style={{ width: size, height: size }}
      role="status"
      aria-label={label}
      {...props}
    >
      <span className="ds-spinner-inner" aria-hidden="true" />
    </span>
  )
}

export function LiveFeedback({ success, error, className = '', id }) {
  const hasContent = Boolean(success || error)
  const message = error || success || ''
  return (
    <div
      id={id}
      className={`ds-live-feedback pro-live ${hasContent ? (error ? 'is-error' : 'is-success') : ''}${className ? ` ${className}` : ''}`}
      role={error ? 'alert' : 'status'}
      aria-atomic="true"
    >
      {message && <span className={error ? 'ds-live-feedback-error' : 'ds-live-feedback-success'}>{message}</span>}
    </div>
  )
}

export function Tabs({ tabs, value, onChange, ariaLabel, className = '' }) {
  const baseId = `tabs-${useId().replace(/:/g, '')}`
  const selectedIndex = Math.max(0, tabs.findIndex(tab => tab.value === value))
  const selectAt = index => onChange(tabs[(index + tabs.length) % tabs.length].value)
  return (
    <div className={`ds-tabs${className ? ` ${className}` : ''}`}>
      <div className="ds-tab-list" role="tablist" aria-label={ariaLabel}>
        {tabs.map((tab, index) => (
          <button
            key={tab.value}
            type="button"
            id={`${baseId}-tab-${tab.value}`}
            className="ds-tab"
            role="tab"
            aria-selected={index === selectedIndex}
            aria-controls={`${baseId}-panel-${tab.value}`}
            tabIndex={index === selectedIndex ? 0 : -1}
            onClick={() => onChange(tab.value)}
            onKeyDown={event => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
              event.preventDefault()
              const rtl = typeof document !== 'undefined' && document.documentElement.dir === 'rtl'
              const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
                : event.key === 'ArrowRight' ? (rtl ? selectedIndex - 1 : selectedIndex + 1)
                : (rtl ? selectedIndex + 1 : selectedIndex - 1)
              selectAt(nextIndex)
              const normalized = (nextIndex + tabs.length) % tabs.length
              event.currentTarget.parentElement?.querySelectorAll('[role="tab"]')[normalized]?.focus()
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {tabs.map((tab, index) => (
        <div key={tab.value} id={`${baseId}-panel-${tab.value}`} role="tabpanel" aria-labelledby={`${baseId}-tab-${tab.value}`} tabIndex={index === selectedIndex ? 0 : -1} hidden={index !== selectedIndex}>
          {index === selectedIndex ? tab.content : null}
        </div>
      ))}
    </div>
  )
}

export function Tooltip({ content, children }) {
  const [open, setOpen] = useState(false)
  const tooltipId = useId()
  const child = Children.only(children)
  return (
    <span className="ds-tooltip" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      {cloneElement(child, {
        className: `${child.props.className || ''} ds-tooltip-trigger`.trim(),
        'aria-describedby': open ? tooltipId : child.props['aria-describedby'],
        onFocus: event => { child.props.onFocus?.(event); setOpen(true) },
        onBlur: event => { child.props.onBlur?.(event); setOpen(false) },
      })}
      {open && <span id={tooltipId} role="tooltip" className="ds-tooltip-content">{content}</span>}
    </span>
  )
}

export { Icon }
