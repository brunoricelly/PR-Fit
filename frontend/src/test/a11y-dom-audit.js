const LIVE_SELECTOR = '[role="status"], [role="alert"], [aria-live]:not([aria-live="off"])'

const text = element => element?.textContent?.replace(/\s+/g, ' ').trim() || ''

export function isA11yHidden(element) {
  if (!element) return true
  if (element.closest('[hidden], [inert], [aria-hidden="true"]')) return true
  const style = globalThis.getComputedStyle?.(element)
  return style?.display === 'none' || style?.visibility === 'hidden'
}

export function accessibleName(element, root = document) {
  const direct = element.getAttribute('aria-label')?.trim()
  if (direct) return direct
  const labelledBy = element.getAttribute('aria-labelledby')
  if (labelledBy) {
    const value = labelledBy.split(/\s+/)
      .map(id => text(root.querySelector?.(`[id="${id.replaceAll('"', '\\"')}"]`) || root.ownerDocument?.getElementById(id)))
      .filter(Boolean)
      .join(' ')
    if (value) return value
  }
  if (element.id) {
    const label = [...root.querySelectorAll('label[for]')].find(item => item.htmlFor === element.id)
    if (label && text(label)) return text(label)
  }
  const wrappingLabel = element.closest('label')
  if (wrappingLabel && text(wrappingLabel)) return text(wrappingLabel)
  if (element.tagName === 'IMG') return element.getAttribute('alt') || ''
  const ownText = text(element)
  if (ownText) return ownText
  return element.getAttribute('title')?.trim() || ''
}

const describe = element => {
  const id = element.id ? `#${element.id}` : ''
  const role = element.getAttribute('role') ? `[role=${element.getAttribute('role')}]` : ''
  const label = accessibleName(element)
  return `${element.tagName.toLowerCase()}${id}${role}${label ? ` "${label}"` : ''}`
}

export function auditA11y(root) {
  const findings = []
  const visible = selector => [...root.querySelectorAll(selector)].filter(element => !isA11yHidden(element))
  const mains = visible('main')
  if (mains.length !== 1) findings.push(`expected one visible main, found ${mains.length}`)

  const headings = visible('h1, h2, h3, h4, h5, h6')
  const h1s = headings.filter(heading => heading.tagName === 'H1')
  if (h1s.length !== 1) findings.push(`expected one visible h1, found ${h1s.length}`)
  headings.reduce((previous, heading) => {
    const level = Number(heading.tagName.slice(1))
    if (previous && level > previous + 1) findings.push(`heading jump h${previous} to h${level}: ${text(heading)}`)
    return level
  }, 0)

  for (const landmark of ['nav', 'aside']) {
    const landmarks = visible(landmark)
    if (landmarks.length > 1) {
      for (const element of landmarks) {
        if (!element.getAttribute('aria-label') && !element.getAttribute('aria-labelledby')) findings.push(`unnamed repeated ${landmark}`)
      }
    }
  }

  for (const element of visible('button, a[href]')) {
    if (!accessibleName(element, root)) findings.push(`control without name: ${describe(element)}`)
  }

  const nativeControls = new Set(['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY'])
  for (const element of visible('*')) {
    const clickable = typeof element.onclick === 'function' || element.getAttribute('role') === 'button'
    if (!clickable || nativeControls.has(element.tagName)) continue
    if (element.getAttribute('role') !== 'button') findings.push(`non-native clickable without button role: ${describe(element)}`)
    else if (element.tabIndex < 0) findings.push(`non-native button outside tab order: ${describe(element)}`)
  }

  for (const control of visible('input, select, textarea')) {
    if (['hidden', 'button', 'submit', 'reset', 'image'].includes(control.type)) continue
    if (!accessibleName(control, root)) findings.push(`form control without label: ${describe(control)}`)
    if (control.getAttribute('aria-invalid') === 'true' && !control.getAttribute('aria-describedby')) {
      findings.push(`invalid control without description: ${describe(control)}`)
    }
  }

  for (const image of visible('img')) {
    if (!image.hasAttribute('alt')) findings.push(`image without alt: ${describe(image)}`)
  }

  for (const table of visible('table')) {
    if (!table.querySelector('caption') && !accessibleName(table, root)) findings.push('table without caption or name')
    for (const header of table.querySelectorAll('th')) {
      if (!header.getAttribute('scope') && !header.id) findings.push(`table header without scope: ${text(header)}`)
    }
  }

  for (const tablist of visible('[role="tablist"]')) {
    if (!accessibleName(tablist, root)) findings.push('tablist without name')
    const tabs = [...tablist.querySelectorAll('[role="tab"]')].filter(tab => !isA11yHidden(tab))
    if (tabs.filter(tab => tab.getAttribute('aria-selected') === 'true').length !== 1) findings.push('tablist must have one selected tab')
    if (tabs.filter(tab => tab.tabIndex === 0).length !== 1) findings.push('tablist must have one tab stop')
    for (const tab of tabs) {
      const panelId = tab.getAttribute('aria-controls')
      if (!panelId) findings.push(`tab without aria-controls: ${describe(tab)}`)
      else if (!root.querySelector(`[id="${panelId.replaceAll('"', '\\"')}"][role="tabpanel"]`)) findings.push(`tab without matching panel: ${panelId}`)
    }
  }

  for (const disclosure of visible('[aria-expanded]')) {
    const controlledId = disclosure.getAttribute('aria-controls')
    if (!controlledId) findings.push(`disclosure without aria-controls: ${describe(disclosure)}`)
    else if (!root.querySelector(`[id="${controlledId.replaceAll('"', '\\"')}"]`)) findings.push(`disclosure without controlled region: ${controlledId}`)
  }

  for (const live of visible(LIVE_SELECTOR)) {
    const parentLive = live.parentElement?.closest(LIVE_SELECTOR)
    if (parentLive && !isA11yHidden(parentLive)) findings.push(`nested live region: ${describe(live)}`)
  }

  return findings
}
