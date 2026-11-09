// @vitest-environment happy-dom
import React, { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AccessibleModal from '../views/AccessibleModal.jsx'
import Modals from '../components/Modals.jsx'
import { filmSetSheet } from '../components/SetVideo.jsx'
import { Tabs } from '../components/design-system.jsx'
import { Segmented, Button } from '../components/ui.jsx'
import { useUI } from '../store/useUI.js'
import { useStore, DEF } from '../store/useStore.js'
import { guardReactWarnings } from './react-warning-guard.js'

let host
let root
let triggerButton
let assertNoReactWarnings

const pressKey = (key, options = {}) => {
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options }))
  })
}

const pressKeyOn = (target, key, options = {}) => {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options }))
  })
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  assertNoReactWarnings = guardReactWarnings()
  useUI.setState({ sheets: [] })
  useStore.setState({ S: structuredClone(DEF), user: { id: 'u1', name: 'User' }, config: null })
  window.scrollTo = vi.fn()
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener() {}, removeEventListener() {} })
  document.documentElement.dir = 'ltr'

  host = document.createElement('div')
  host.id = 'page-root'
  triggerButton = document.createElement('button')
  triggerButton.id = 'trigger-btn'
  triggerButton.textContent = 'Abrir Modal'
  host.appendChild(triggerButton)
  document.body.appendChild(host)

  const modalRoot = document.createElement('div')
  modalRoot.id = 'modal-host'
  document.body.appendChild(modalRoot)
  root = createRoot(modalRoot)
})

afterEach(async () => {
  if (root) await act(async () => { root.unmount() })
  document.body.innerHTML = ''
  document.body.style.cssText = ''
  document.documentElement.dir = 'ltr'
  assertNoReactWarnings?.()
  vi.restoreAllMocks()
})

describe('Keyboard Navigation & Focus Management (Etapa 7B)', () => {
  describe('Focus trap and overlay lifecycle', () => {
    it('traps Tab, isolates background as inert, closes on Escape and restores focus to trigger in AccessibleModal', async () => {
      triggerButton.focus()
      expect(document.activeElement).toBe(triggerButton)

      let open = true
      const onClose = () => { open = false }

      const TestModal = () => open ? (
        <AccessibleModal id="test-accessible-modal" title="Teste de Foco" onClose={onClose}>
          <button type="button" id="first-inner">Primeiro</button>
          <button type="button" id="second-inner">Segundo</button>
        </AccessibleModal>
      ) : null

      await act(async () => { root.render(<TestModal />) })

      const dialog = document.querySelector('[role="dialog"]')
      expect(dialog).toBeTruthy()
      expect(dialog.getAttribute('aria-modal')).toBe('true')
      expect(host.hasAttribute('inert')).toBe(true)

      const innerButtons = dialog.querySelectorAll('button')
      expect(document.activeElement).toBe(innerButtons[0])

      // Tab wrapping from last to first
      innerButtons[innerButtons.length - 1].focus()
      pressKey('Tab')
      expect(document.activeElement).toBe(innerButtons[0])

      // Shift+Tab wrapping from first to last
      pressKey('Tab', { shiftKey: true })
      expect(document.activeElement).toBe(innerButtons[innerButtons.length - 1])

      // Escape closes and restores focus to triggerButton
      pressKey('Escape')
      expect(open).toBe(false)
      await act(async () => { root.render(<TestModal />) })

      expect(document.querySelector('[role="dialog"]')).toBeNull()
      expect(host.hasAttribute('inert')).toBe(false)
      expect(document.activeElement).toBe(triggerButton)
    })

    it('manages FilmSetSheet inside Modals with initial accessible focus, Tab trap and focus restoration', async () => {
      triggerButton.focus()
      expect(document.activeElement).toBe(triggerButton)

      await act(async () => { root.render(<Modals />) })

      act(() => {
        filmSetSheet({ entry: 0, set: 0 }, 'Gravar execução da série')
      })

      const dialog = document.querySelector('[role="dialog"]')
      expect(dialog).toBeTruthy()
      expect(dialog.getAttribute('aria-modal')).toBe('true')
      expect(host.hasAttribute('inert')).toBe(true)

      const recordBtn = dialog.querySelector('[data-autofocus]') || dialog.querySelector('button')
      expect(document.activeElement).toBe(recordBtn)

      // Tab wrap test
      const buttons = dialog.querySelectorAll('button:not([disabled])')
      buttons[buttons.length - 1].focus()
      pressKey('Tab')
      expect(document.activeElement).toBe(buttons[0])

      pressKey('Tab', { shiftKey: true })
      expect(document.activeElement).toBe(buttons[buttons.length - 1])

      // Escape closes sheet and restores focus
      pressKey('Escape')
      expect(document.querySelector('[role="dialog"]')).toBeNull()
      expect(host.hasAttribute('inert')).toBe(false)
      expect(document.activeElement).toBe(triggerButton)
    })
  })

  describe('Roving Tabindex on Tablists', () => {
    it('implements W3C APG roving tabindex with Arrow keys, Home, and End in Tabs', async () => {
      const TabHarness = () => {
        const [value, setValue] = useState('one')
        return (
          <Tabs
            ariaLabel="Test tabs"
            value={value}
            onChange={setValue}
            tabs={[
              { value: 'one', label: 'Aba 1', content: <div>Conteúdo 1</div> },
              { value: 'two', label: 'Aba 2', content: <div>Conteúdo 2</div> },
              { value: 'three', label: 'Aba 3', content: <div>Conteúdo 3</div> },
            ]}
          />
        )
      }

      await act(async () => { root.render(<TabHarness />) })

      const tabs = document.querySelectorAll('[role="tab"]')
      expect(tabs).toHaveLength(3)
      expect(tabs[0].tabIndex).toBe(0)
      expect(tabs[1].tabIndex).toBe(-1)
      expect(tabs[2].tabIndex).toBe(-1)

      tabs[0].focus()
      expect(document.activeElement).toBe(tabs[0])

      // ArrowRight advances to tab 2
      pressKeyOn(tabs[0], 'ArrowRight')
      expect(tabs[1].getAttribute('aria-selected')).toBe('true')
      expect(tabs[1].tabIndex).toBe(0)
      expect(tabs[0].tabIndex).toBe(-1)
      expect(document.activeElement).toBe(tabs[1])

      // End jumps to last tab
      pressKeyOn(tabs[1], 'End')
      expect(tabs[2].getAttribute('aria-selected')).toBe('true')
      expect(tabs[2].tabIndex).toBe(0)
      expect(document.activeElement).toBe(tabs[2])

      // Home jumps to first tab
      pressKeyOn(tabs[2], 'Home')
      expect(tabs[0].getAttribute('aria-selected')).toBe('true')
      expect(tabs[0].tabIndex).toBe(0)
      expect(document.activeElement).toBe(tabs[0])

      // ArrowLeft wraps to last tab
      pressKeyOn(tabs[0], 'ArrowLeft')
      expect(tabs[2].getAttribute('aria-selected')).toBe('true')
      expect(tabs[2].tabIndex).toBe(0)
      expect(document.activeElement).toBe(tabs[2])
    })

    it('implements roving tabindex and arrow keys on training Segmented control with RTL awareness', async () => {
      const SegHarness = ({ dir = 'ltr' }) => {
        const [value, setValue] = useState('schedule')
        return (
          <div dir={dir}>
            <Segmented
              ariaLabel="Visualização de treino"
              value={value}
              onChange={setValue}
              options={[
                { value: 'schedule', label: 'Agenda' },
                { value: 'routines', label: 'Rotinas' },
                { value: 'stats', label: 'Estatísticas' },
              ]}
            />
          </div>
        )
      }

      await act(async () => { root.render(<SegHarness />) })

      const buttons = document.querySelectorAll('.seg button')
      expect(buttons).toHaveLength(3)
      expect(buttons[0].tabIndex).toBe(0)
      expect(buttons[1].tabIndex).toBe(-1)
      expect(buttons[2].tabIndex).toBe(-1)

      buttons[0].focus()
      pressKeyOn(buttons[0], 'ArrowRight')
      expect(buttons[1].getAttribute('aria-pressed')).toBe('true')
      expect(buttons[1].tabIndex).toBe(0)
      expect(buttons[0].tabIndex).toBe(-1)

      // RTL mirroring
      document.documentElement.dir = 'rtl'
      pressKeyOn(buttons[1], 'ArrowRight') // in RTL, ArrowRight moves backwards to 0
      expect(buttons[0].getAttribute('aria-pressed')).toBe('true')
      expect(buttons[0].tabIndex).toBe(0)
    })
  })

  describe('User Preferences & Non-nesting Verification', () => {
    it('ensures clickable elements are native controls or semantically complete', async () => {
      await act(async () => {
        root.render(
          <div>
            <Button variant="primary">Ação Primária</Button>
            <button type="button" className="btn">Nativo</button>
            <div role="button" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') e.preventDefault() }}>
              Semântico Completo
            </div>
          </div>
        )
      })

      const clickables = document.querySelectorAll('button, [role="button"]')
      for (const el of clickables) {
        expect(el.tabIndex).toBeGreaterThanOrEqual(0)
        expect(el.querySelectorAll('button, [role="button"]')).toHaveLength(0)
      }
    })
  })
})
