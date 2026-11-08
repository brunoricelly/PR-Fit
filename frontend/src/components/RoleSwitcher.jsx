import React from 'react'
import Icon from './Icon.jsx'
import './RoleSwitcher.css'

export default function RoleSwitcher({ activeRole, onSwitch, className = '' }) {
  return (
    <div className={`ds-role-switcher-container ${className}`.trim()}>
      <div
        className="ds-role-switcher"
        role="tablist"
        aria-label="Alternar papel"
      >
        <button
          type="button"
          role="tab"
          id="role-tab-coach"
          aria-selected={activeRole === 'coach'}
          aria-controls="role-panel"
          className={`ds-role-tab ${activeRole === 'coach' ? 'active' : ''}`}
          onClick={() => onSwitch('coach')}
        >
          <Icon name="person" />
          <span>Visão do Treinador</span>
        </button>
        <button
          type="button"
          role="tab"
          id="role-tab-athlete"
          aria-selected={activeRole === 'athlete'}
          aria-controls="role-panel"
          className={`ds-role-tab ${activeRole === 'athlete' ? 'active' : ''}`}
          onClick={() => onSwitch('athlete')}
        >
          <Icon name="dumbbell" />
          <span>Visão do Aluno</span>
        </button>
      </div>
    </div>
  )
}
