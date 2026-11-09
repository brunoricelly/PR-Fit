const LIVE_SELECTOR = '[role="status"], [role="alert"], [aria-live]:not([aria-live="off"])'
const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'option', 'combobox', 'slider', 'spinbutton', 'searchbox', 'textbox', 'treeitem',
])
const REFERENCE_ATTRIBUTES = ['aria-labelledby', 'aria-describedby', 'aria-controls']

const normalizedText = value => value?.replace(/\s+/g, ' ').trim() || ''
const elementsIncludingRoot = root => [
  ...(root?.nodeType === 1 ? [root] : []),
  ...(root?.querySelectorAll?.('*') || []),
]

const hiddenByStyle = element => {
  for (let current = element; current?.nodeType === 1; current = current.parentElement) {
    const style = globalThis.getComputedStyle?.(current)
    if (style?.display === 'none' || style?.visibility === 'hidden') return true
  }
  return false
}

export function isA11yHidden(element) {
  if (!element) return true
  if (element.closest?.('[hidden], [inert], [aria-hidden="true"]')) return true
  return hiddenByStyle(element)
}

const exposedText = element => {
  if (!element || isA11yHidden(element)) return ''
  const visit = node => {
    if (node.nodeType === 3) return normalizedText(node.nodeValue)
    if (node.nodeType !== 1 || isA11yHidden(node)) return ''
    if (node.tagName === 'IMG') return normalizedText(node.getAttribute('alt'))
    if (node.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes(node.type)) return normalizedText(node.value)
    return normalizedText([...node.childNodes].map(visit).filter(Boolean).join(' '))
  }
  return visit(element)
}

const idIndex = root => {
  const index = new Map()
  for (const element of elementsIncludingRoot(root)) {
    const id = element.id?.trim()
    if (!id) continue
    const matches = index.get(id) || []
    matches.push(element)
    index.set(id, matches)
  }
  return index
}

const referencedElements = (element, attribute, root) => {
  const index = idIndex(root)
  return (element.getAttribute(attribute) || '').trim().split(/\s+/).filter(Boolean)
    .flatMap(id => index.get(id)?.length === 1 ? index.get(id) : [])
}

export function accessibleName(element, root = document) {
  if (!element) return ''
  const direct = element.getAttribute('aria-label')?.trim()
  if (direct) return direct
  if (element.getAttribute('aria-labelledby')) {
    const value = referencedElements(element, 'aria-labelledby', root).map(exposedText).filter(Boolean).join(' ')
    if (value) return normalizedText(value)
  }
  if (element.id) {
    const label = [...root.querySelectorAll('label[for]')].find(item => item.htmlFor === element.id && !isA11yHidden(item))
    const value = exposedText(label)
    if (value) return value
  }
  const wrappingLabel = element.closest?.('label')
  if (wrappingLabel && !isA11yHidden(wrappingLabel)) {
    const value = exposedText(wrappingLabel)
    if (value) return value
  }
  if (element.tagName === 'IMG' || (element.tagName === 'INPUT' && element.type === 'image')) return element.getAttribute('alt')?.trim() || ''
  if (element.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes(element.type)) return element.value?.trim() || ''
  const ownText = exposedText(element)
  if (ownText) return ownText
  return element.getAttribute('title')?.trim() || ''
}

const describe = (element, root) => {
  const id = element.id ? `#${element.id}` : ''
  const role = element.getAttribute('role') ? `[role=${element.getAttribute('role')}]` : ''
  const label = accessibleName(element, root)
  return `${element.tagName.toLowerCase()}${id}${role}${label ? ` "${label}"` : ''}`
}

const roleOf = element => element.getAttribute('role')?.trim().split(/\s+/)[0] || ''
const needsInteractiveName = element => element.matches('button, a[href], summary') || INTERACTIVE_ROLES.has(roleOf(element))

export function auditA11y(root) {
  const findings = []
  const allElements = elementsIncludingRoot(root)
  const ids = idIndex(root)
  const visible = selector => [...root.querySelectorAll(selector)].filter(element => !isA11yHidden(element))

  for (const [id, elements] of ids) {
    if (elements.length > 1) findings.push(`duplicate id: ${id} (${elements.length} elements)`)
  }

  for (const element of allElements) {
    for (const attribute of REFERENCE_ATTRIBUTES) {
      const references = (element.getAttribute(attribute) || '').trim().split(/\s+/).filter(Boolean)
      for (const id of references) {
        const matches = ids.get(id) || []
        if (matches.length === 0) findings.push(`${attribute} references missing id: ${id}`)
        else if (matches.length > 1) findings.push(`${attribute} references ambiguous id: ${id}`)
      }
    }
  }

  const mains = visible('main')
  if (mains.length !== 1) findings.push(`expected one visible main, found ${mains.length}`)
  const headings = visible('h1, h2, h3, h4, h5, h6')
  const h1s = headings.filter(heading => heading.tagName === 'H1')
  if (h1s.length !== 1) findings.push(`expected one visible h1, found ${h1s.length}`)
  headings.reduce((previous, heading) => {
    const level = Number(heading.tagName.slice(1))
    if (previous && level > previous + 1) findings.push(`heading jump h${previous} to h${level}: ${exposedText(heading)}`)
    return level
  }, 0)

  for (const landmark of ['nav', 'aside']) {
    const landmarks = visible(landmark)
    if (landmarks.length > 1) {
      for (const element of landmarks) if (!accessibleName(element, root)) findings.push(`unnamed repeated ${landmark}`)
    }
  }

  for (const element of visible('button, a[href], summary, [role]')) {
    if (needsInteractiveName(element) && !accessibleName(element, root)) findings.push(`control without name: ${describe(element, root)}`)
  }

  const nativeControls = new Set(['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY'])
  for (const interactive of visible('button, a[href], [role="button"], [role="link"]')) {
    const nested = interactive.querySelectorAll('button, a[href], [role="button"], [role="link"]')
    for (const child of nested) {
      if (!isA11yHidden(child)) {
        findings.push(`nested interactive control: ${describe(child, root)} inside ${describe(interactive, root)}`)
      }
    }
  }

  for (const element of visible('*')) {
    const clickable = typeof element.onclick === 'function' || roleOf(element) === 'button'
    if (!clickable || nativeControls.has(element.tagName)) continue
    if (roleOf(element) !== 'button') findings.push(`non-native clickable without button role: ${describe(element, root)}`)
    else if (element.tabIndex < 0) findings.push(`non-native button outside tab order: ${describe(element, root)}`)
  }

  for (const control of visible('input, select, textarea')) {
    if (['hidden', 'button', 'submit', 'reset', 'image'].includes(control.type)) continue
    if (!accessibleName(control, root)) findings.push(`form control without label: ${describe(control, root)}`)
    if (control.getAttribute('aria-invalid') === 'true' && !control.getAttribute('aria-describedby')) findings.push(`invalid control without description: ${describe(control, root)}`)
  }

  for (const image of visible('img')) if (!image.hasAttribute('alt')) findings.push(`image without alt: ${describe(image, root)}`)
  for (const table of visible('table')) {
    if (!table.querySelector('caption') && !accessibleName(table, root)) findings.push('table without caption or name')
    for (const header of table.querySelectorAll('th')) if (!header.getAttribute('scope') && !header.id) findings.push(`table header without scope: ${exposedText(header)}`)
  }

  for (const tablist of visible('[role="tablist"]')) {
    if (!accessibleName(tablist, root)) findings.push('tablist without name')
    const tabs = [...tablist.querySelectorAll('[role="tab"]')].filter(tab => !isA11yHidden(tab))
    if (tabs.filter(tab => tab.getAttribute('aria-selected') === 'true').length !== 1) findings.push('tablist must have one selected tab')
    if (tabs.filter(tab => tab.tabIndex === 0).length !== 1) findings.push('tablist must have one tab stop')
    for (const tab of tabs) {
      const panelIds = (tab.getAttribute('aria-controls') || '').trim().split(/\s+/).filter(Boolean)
      if (panelIds.length !== 1) findings.push(`tab without aria-controls: ${describe(tab, root)}`)
      else {
        const panels = ids.get(panelIds[0]) || []
        if (panels.length !== 1 || roleOf(panels[0]) !== 'tabpanel') findings.push(`tab without matching panel: ${panelIds[0]}`)
      }
    }
  }

  for (const panel of allElements.filter(element => roleOf(element) === 'tabpanel')) {
    const tabIds = (panel.getAttribute('aria-labelledby') || '').trim().split(/\s+/).filter(Boolean)
    if (tabIds.length !== 1) {
      findings.push(`tabpanel without aria-labelledby: ${describe(panel, root)}`)
      continue
    }
    const tabs = ids.get(tabIds[0]) || []
    if (tabs.length !== 1 || roleOf(tabs[0]) !== 'tab') {
      findings.push(`tabpanel without matching tab: ${tabIds[0]}`)
      continue
    }
    const controlledIds = (tabs[0].getAttribute('aria-controls') || '').trim().split(/\s+/).filter(Boolean)
    if (!panel.id || !controlledIds.includes(panel.id)) findings.push(`tabpanel not controlled by labelled tab: ${panel.id || tabIds[0]}`)
    if (!isA11yHidden(panel) && tabs[0].getAttribute('aria-selected') !== 'true') findings.push(`visible tabpanel labelled by unselected tab: ${panel.id || tabIds[0]}`)
  }

  for (const disclosure of visible('[aria-expanded]')) {
    const controlledIds = (disclosure.getAttribute('aria-controls') || '').trim().split(/\s+/).filter(Boolean)
    if (controlledIds.length === 0) findings.push(`disclosure without aria-controls: ${describe(disclosure, root)}`)
    else if (controlledIds.some(id => (ids.get(id) || []).length !== 1)) findings.push(`disclosure without controlled region: ${controlledIds.join(' ')}`)
  }

  const liveText = new Map()
  for (const live of visible(LIVE_SELECTOR)) {
    const parentLive = live.parentElement?.closest(LIVE_SELECTOR)
    if (parentLive && !isA11yHidden(parentLive)) findings.push(`nested live region: ${describe(live, root)}`)
    const announcement = exposedText(live).toLocaleLowerCase()
    if (!announcement) continue
    const count = (liveText.get(announcement) || 0) + 1
    liveText.set(announcement, count)
    if (count === 2) findings.push(`duplicate live region text: ${announcement}`)
  }

  return findings
}
