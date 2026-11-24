// 320px phone, coach side (measured in a real browser): "Remover exercício" ran 159..336 past the screen
// because .btn is width:100% inside a flex:none head, and the metric title "Treinos por semana" lost
// to its value. The CSS rules that fixed both stay put.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const css = readFileSync(resolve(process.cwd(), 'src/views/ProfessionalHub.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

describe('professional editor on a narrow phone', () => {
  it('lets the exercise head wrap and its button take its natural width', () => {
    expect(css).toMatch(/\.pro-editor-head\s*\{\s*flex-wrap:\s*wrap;\s*\}/)
    const rule = css.match(/\.pro-division-head \.btn,\s*\.pro-editor-head \.btn \{([^}]*width:\s*auto[^}]*)\}/)?.[1] || ''
    expect(rule).toMatch(/max-width:\s*100%/)
    expect(rule).toMatch(/min-width:\s*0/)
  })
  it('drops the metric value under its title at 340px and below', () => {
    expect(css).toMatch(/@media \(max-width: 340px\) \{\s*\.pro-metric-card \.pro-link-head\{flex-wrap:wrap\}/)
  })
})
