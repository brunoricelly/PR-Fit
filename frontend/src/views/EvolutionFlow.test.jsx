// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/api.js', () => ({
  api: vi.fn(async () => ({})),
  apiUpload: vi.fn(async () => ({})),
}))

import { DEF, useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import Measurements, { measurementLogSheet } from './Measurements.jsx'
import Stats from './Stats.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const clone = v => JSON.parse(JSON.stringify(v))
let mounted = []
function render(el) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push(root)
  act(() => root.render(<MemoryRouter>{el}</MemoryRouter>))
  return host
}
const topSheet = () => {
  const s = useUI.getState().sheets.at(-1)
  return s ? render(s.render(() => useUI.getState().closeSheet(s.id))) : null
}

beforeEach(() => {
  localStorage.clear()
  useUI.setState({ sheets: [], toastMsg: '' })
  document.body.innerHTML = ''
})
afterEach(() => {
  act(() => { mounted.splice(0).forEach(r => r.unmount()) })
})

describe('Measurements flow modernizations', () => {
  it('renders grouped fieldsets in the measurement logging form', () => {
    useStore.setState({
      S: Object.assign(clone(DEF), {
        unit: 'kg',
        measurementEnabled: ['neck', 'waist', 'upperArmLeft', 'thighLeft', 'bodyFat'],
        measurements: [],
      }),
      user: null,
    })

    act(() => measurementLogSheet())
    const form = topSheet()
    expect(form).not.toBeNull()

    const legends = [...form.querySelectorAll('fieldset.measure-group legend')].map(l => l.textContent)
    expect(legends).toContain('Torso')
    expect(legends).toContain('Arms')
    expect(legends).toContain('Legs')
    expect(legends).toContain('Other')
  })

  it('renders recent measurements card on Stats Body section when measurements exist', () => {
    useStore.setState({
      S: Object.assign(clone(DEF), {
        unit: 'kg',
        bodyweight: [{ d: '2026-11-01', w: 75 }],
        measurements: [{ d: '2026-11-01', t: 1, waist: 82, bodyFat: 15, other: [] }],
      }),
      user: null,
      ready: true,
    })

    const screen = render(<Stats />)
    expect(screen.textContent).toContain('Body measurements')
    expect(screen.textContent).toContain('82')
    expect(screen.textContent).toContain('15')
  })

  it('displays empty state with accessible CTA when no measurements configured', () => {
    useStore.setState({
      S: Object.assign(clone(DEF), {
        unit: 'kg',
        measurementEnabled: [],
        measurements: [],
      }),
      user: null,
    })

    const screen = render(<Measurements />)
    expect(screen.textContent).toContain('No measurements yet')
    expect(screen.textContent).toContain('Choose measurements')
  })
})
