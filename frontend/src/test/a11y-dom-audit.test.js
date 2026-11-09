// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { accessibleName, auditA11y } from './a11y-dom-audit.js'

const render = markup => {
  const root = document.createElement('div')
  root.innerHTML = `<main><h1>Audit fixture</h1>${markup}</main>`
  document.body.appendChild(root)
  return root
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('a11y DOM audit', () => {
  it('reports duplicate non-empty ids', () => {
    const root = render('<p id="duplicate">One</p><p id="duplicate">Two</p>')
    expect(auditA11y(root)).toContain('duplicate id: duplicate (2 elements)')
  })

  it('does not use aria-hidden descendants as a button name', () => {
    const root = render('<button><span aria-hidden="true">Hidden action</span></button>')
    expect(accessibleName(root.querySelector('button'), root)).toBe('')
    expect(auditA11y(root)).toContain('control without name: button')
  })

  it('reports unnamed interactive ARIA controls', () => {
    const root = render('<div role="button" tabindex="0"></div>')
    expect(auditA11y(root)).toContain('control without name: div[role=button]')
  })

  it('accepts native labels and valid aria-labelledby names', () => {
    const root = render(`
      <label for="email">Email address</label><input id="email">
      <span id="save-label">Save changes</span><div role="button" tabindex="0" aria-labelledby="save-label"></div>
    `)
    expect(auditA11y(root)).toEqual([])
  })

  it('reports missing and ambiguous id references', () => {
    const root = render(`
      <span id="shared">First</span><span id="shared">Second</span>
      <button aria-labelledby="missing">Action</button>
      <button aria-describedby="shared">Another action</button>
      <button aria-controls="absent">More</button>
    `)
    const findings = auditA11y(root)
    expect(findings).toContain('aria-labelledby references missing id: missing')
    expect(findings).toContain('aria-describedby references ambiguous id: shared')
    expect(findings).toContain('aria-controls references missing id: absent')
  })

  it('reports invalid tab and tabpanel associations', () => {
    const root = render(`
      <div role="tablist" aria-label="Example tabs">
        <button id="tab-one" role="tab" aria-selected="false" aria-controls="panel-one" tabindex="-1">One</button>
        <button id="tab-two" role="tab" aria-selected="false" aria-controls="panel-missing" tabindex="-1">Two</button>
      </div>
      <section id="panel-one" role="tabpanel" aria-labelledby="missing-tab"></section>
    `)
    const findings = auditA11y(root)
    expect(findings).toContain('tablist must have one selected tab')
    expect(findings).toContain('tablist must have one tab stop')
    expect(findings).toContain('tab without matching panel: panel-missing')
    expect(findings).toContain('tabpanel without matching tab: missing-tab')
  })

  it('reports duplicate non-empty live announcements but permits empty live regions', () => {
    const duplicate = render('<div role="status">Saved</div><p aria-live="polite"> saved </p>')
    expect(auditA11y(duplicate)).toContain('duplicate live region text: saved')
    duplicate.remove()

    const empty = render('<div role="status"></div><p aria-live="polite"></p>')
    expect(auditA11y(empty)).toEqual([])
  })

  it('reports nested interactive controls', () => {
    const root = render('<button type="button">Parent <button type="button">Child</button></button>')
    expect(auditA11y(root).some(f => f.includes('nested interactive control'))).toBe(true)
  })
})
