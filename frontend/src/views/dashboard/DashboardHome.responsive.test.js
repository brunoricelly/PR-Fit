import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const css = readFileSync(resolve(process.cwd(), 'src/views/dashboard/DashboardHome.css'), 'utf8')

describe('dashboard onboarding responsive CSS', () => {
  it.each([375, 412])('mantém ações móveis flexíveis em %ipx', width => {
    expect(width).toBeLessThan(480)
    expect(css).toMatch(/@media \(max-width: 30rem\)[\s\S]*\.first-steps-header \{ display: grid; \}/)
    expect(css).toMatch(/\.first-steps-item \{[^}]*grid-template-columns: 2rem minmax\(0, 1fr\)/)
    expect(css).toMatch(/\.first-steps-actions \.ds-button \{[^}]*min-width: min\(100%, 9rem\)/)
  })

  it.each([768, 1440])('usa grade desktop sem ultrapassar o shell em %ipx', width => {
    expect(width).toBeGreaterThanOrEqual(768)
    expect(css).toMatch(/\.dashboard-shell \{[^}]*width: min\(100%, 74rem\)/)
    expect(css).toMatch(/@media \(min-width: 48rem\)[\s\S]*\.first-steps-list \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/)
  })

  it('desativa movimento não essencial quando solicitado', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/)
  })
})
