import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('#modal-root visibility', () => {
  it('shows the root when the design-system Modal portals a backdrop into it', () => {
    const css = readFileSync(new URL('./index.css', import.meta.url), 'utf8')
    expect(css).toMatch(/#modal-root\{[^}]*display:none/)
    expect(css).toMatch(/#modal-root:has\(>\.ds-modal-backdrop\)\{display:block\}/)
  })
})
