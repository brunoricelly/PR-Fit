// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const css = [
  readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8'),
  readFileSync(resolve(process.cwd(), 'src/design-system.css'), 'utf8'),
].join('\n')

const rgba = value => {
  if (/^#[0-9a-f]{6}$/i.test(value)) {
    return { rgb: [1, 3, 5].map(index => parseInt(value.slice(index, index + 2), 16)), alpha: 1 }
  }
  if (/^#[0-9a-f]{3}$/i.test(value)) {
    return { rgb: value.slice(1).split('').map(channel => parseInt(channel + channel, 16)), alpha: 1 }
  }
  const match = value.match(/rgba?\(([^)]+)\)/)
  if (!match) throw new Error(`Unsupported computed color: ${value}`)
  const parts = match[1].split(/[\s,\/]+/).filter(Boolean).map(Number)
  return { rgb: parts.slice(0, 3), alpha: parts[3] ?? 1 }
}
const luminance = rgb => {
  const values = rgb.map(value => {
    const channel = value / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2]
}
const blend = (foreground, background) => foreground.rgb.map((value, index) => value * foreground.alpha + background.rgb[index] * (1 - foreground.alpha))
const contrast = (foreground, background) => {
  const fg = luminance(blend(foreground, background))
  const bg = luminance(background.rgb)
  return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05)
}

let style

beforeEach(() => {
  style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)
  document.body.innerHTML = ''
  document.documentElement.removeAttribute('data-theme')
})

afterEach(() => {
  style.remove()
  document.body.innerHTML = ''
  document.documentElement.removeAttribute('data-theme')
})

describe('critical accessibility styles from computed DOM', () => {
  it.each([['dark', null], ['light', 'light']])('keeps secondary text above 4.5:1 in %s theme', (_name, theme) => {
    if (theme) document.documentElement.dataset.theme = theme
    const card = document.createElement('div')
    card.className = 'card'
    const copy = document.createElement('span')
    copy.className = 'muted'
    copy.textContent = 'Texto secundário'
    card.appendChild(copy)
    document.body.appendChild(card)

    const cardStyle = getComputedStyle(card)
    const copyStyle = getComputedStyle(copy)
    expect(contrast(rgba(copyStyle.color), rgba(cardStyle.backgroundColor))).toBeGreaterThanOrEqual(4.5)
  })

  it('computes safe focus offsets and a 44px skip-link target', () => {
    const skip = document.createElement('a')
    skip.className = 'skip-link'
    skip.href = '#main-content'
    skip.textContent = 'Pular para o conteúdo principal'
    const main = document.createElement('main')
    main.id = 'main-content'
    main.tabIndex = -1
    document.body.append(skip, main)

    const rootStyle = getComputedStyle(document.documentElement)
    const skipStyle = getComputedStyle(skip)
    const mainStyle = getComputedStyle(main)
    expect(rootStyle.scrollPaddingBottom).not.toBe('')
    expect(mainStyle.scrollMarginTop).not.toBe('')
    expect(skipStyle.position).toBe('fixed')
    expect(parseFloat(skipStyle.minHeight)).toBeGreaterThanOrEqual(44)
  })

  it('computes a visible focus indicator with at least 3:1 contrast', () => {
    const button = document.createElement('button')
    button.textContent = 'Ação'
    document.body.appendChild(button)
    button.focus()

    const buttonStyle = getComputedStyle(button)
    const bodyStyle = getComputedStyle(document.body)
    expect(parseFloat(buttonStyle.outlineWidth)).toBeGreaterThanOrEqual(2)
    expect(buttonStyle.outlineStyle).not.toBe('none')
    expect(contrast(rgba(buttonStyle.outlineColor), rgba(bodyStyle.backgroundColor))).toBeGreaterThanOrEqual(3)
  })
})
