import React from 'react'
import Icon from './Icon.jsx'
import { t } from '../lib/i18n.js'
import './RoleSwitcher.css'

export default function RoleSwitcher({ activeRole, onSwitch, className = '' }) {
  return (
    <div className={`ds-role-switcher-container ${className}`.trim()}>
      <div
        className="ds-role-switcher"
        role="group"
        aria-label={t('Role switch')}
      >
        <button
          type="button"
          aria-pressed={activeRole === 'coach'}
          className={`ds-role-tab ${activeRole === 'coach' ? 'active' : ''}`}
          onClick={() => onSwitch('coach')}
        >
          <Icon name="person" />
          <span>{t('Coach view')}</span>
        </button>
        <button
          type="button"
          aria-pressed={activeRole === 'athlete'}
          className={`ds-role-tab ${activeRole === 'athlete' ? 'active' : ''}`}
          onClick={() => onSwitch('athlete')}
        >
          <Icon name="dumbbell" />
          <span>{t('Athlete view')}</span>
        </button>
      </div>
    </div>
  )
}
