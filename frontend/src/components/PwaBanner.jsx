import React from 'react'
import { usePWA } from '../lib/pwa.js'
import Icon from './Icon.jsx'

export default function PwaBanner() {
  const { updateAvailable, applyUpdate, dismissUpdate } = usePWA()

  if (!updateAvailable) return null

  return (
    <aside
      className="pwa-banner"
      role="status"
      aria-live="polite"
      aria-label="Atualização do aplicativo"
    >
      <div className="pwa-banner-copy">
        <Icon name="arrow-clockwise" />
        <span>Atualização disponível</span>
      </div>
      <div className="pwa-banner-actions">
        <button
          type="button"
          className="btn sm primary pwa-update-btn"
          onClick={applyUpdate}
        >
          Atualizar
        </button>
        <button
          type="button"
          className="btn sm ghost pwa-dismiss-btn"
          onClick={dismissUpdate}
          aria-label="Dispensar"
        >
          Dispensar
        </button>
      </div>
    </aside>
  )
}
