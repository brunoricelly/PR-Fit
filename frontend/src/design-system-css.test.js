import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(join(import.meta.dirname, 'design-system.css'), 'utf8')
const coachCss = readFileSync(join(import.meta.dirname, 'views/coach/CoachGroupsView.css'), 'utf8')
const dashboardCss = readFileSync(join(import.meta.dirname, 'views/dashboard/DashboardHome.css'), 'utf8')

function variablesFor(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const block = css.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`))?.[1] || ''
  return Object.fromEntries([...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(match => [match[1], match[2].trim()]))
}

function luminance(hex) {
  const channels = hex.slice(1).match(/.{2}/g).map(value => parseInt(value, 16) / 255)
  const linear = channels.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
}

function contrast(foreground, background) {
  const values = [luminance(foreground), luminance(background)].sort((left, right) => right - left)
  return (values[0] + 0.05) / (values[1] + 0.05)
}

describe('PR Fit semantic tokens', () => {
  it('defines the canonical token families and legacy migration bridge', () => {
    for (const token of [
      '--ds-surface-page', '--ds-text-primary', '--ds-border-subtle', '--ds-state-danger',
      '--ds-space-4', '--ds-font-size-md', '--ds-radius-md', '--ds-shadow-md',
      '--ds-motion-duration-base', '--ds-z-overlay', '--ds-breakpoint-md',
    ]) expect(css).toContain(`${token}:`)
    expect(css).toMatch(/\.ds-scope\s*\{[\s\S]*--surface:\s*var\(--ds-surface-base\)/)
    expect(css).toMatch(/--acc:\s*var\(--ds-color-brand\)/)
  })

  it('keeps principal light and dark color pairs at WCAG AA contrast', () => {
    const dark = variablesFor(':root')
    const light = { ...dark, ...variablesFor(':root[data-theme="light"]') }
    const pairs = [
      [dark['--ds-text-primary'], dark['--ds-surface-page']],
      [dark['--ds-text-secondary'], dark['--ds-surface-page']],
      [dark['--ds-color-on-brand'], dark['--ds-color-brand']],
      [dark['--ds-state-danger'], dark['--ds-state-danger-surface']],
      [light['--ds-text-primary'], light['--ds-surface-page']],
      [light['--ds-text-secondary'], light['--ds-surface-page']],
      [light['--ds-color-on-brand'], light['--ds-color-brand']],
      [light['--ds-state-on-danger'], light['--ds-state-danger']],
    ]
    for (const [foreground, background] of pairs) expect(contrast(foreground, background)).toBeGreaterThanOrEqual(4.5)
  })

  it('codifies 44px targets, reduced motion and responsive structure', () => {
    expect(css).toMatch(/\.ds-button,[\s\S]*min-height:\s*44px/)
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
    expect(css).toContain('animation-duration: 0.01ms !important')
    expect(coachCss).toContain('@media (max-width:30rem)')
    expect(coachCss).toContain('@media (min-width:48rem)')
    expect(coachCss).toContain('grid-template-columns:repeat(2,minmax(0,1fr))')
    expect(dashboardCss).toContain('@media (max-width: 30rem)')
    expect(dashboardCss).toContain('@media (min-width: 48rem)')
    expect(dashboardCss).toContain('@media (min-width: 64rem)')
    expect(dashboardCss).toContain('grid-template-columns: repeat(2, minmax(0, 1fr))')
    expect(dashboardCss).toContain('grid-template-columns: repeat(3, minmax(0, 1fr))')
    expect(dashboardCss).toContain('min-height: 44px')
  })

  it('does not style unavailable dashboard icons as success', () => {
    expect(dashboardCss).toMatch(/\.dashboard-pulse-empty \.ico\s*\{\s*color:\s*var\(--ds-state-success\)/)
    expect(dashboardCss).toMatch(/\.dashboard-pulse-unavailable \.ico\s*\{\s*color:\s*var\(--ds-state-warning\)/)
  })

  it('enforces tactile active microinteractions and reduced motion resets', () => {
    expect(css).toContain('.ds-button:not(:disabled):active')
    expect(css).toContain('.ds-icon-button:not(:disabled):active')
    expect(css).toContain('.ds-tab:not(:disabled):active')
    expect(css).toContain('.ds-card.interactive:active')
    expect(css).toContain('.ds-modal-backdrop')
    expect(css).toContain('overscroll-behavior: contain')
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*transform:\s*none !important/)
  })
})
