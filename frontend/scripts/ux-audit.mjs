#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROFESSIONAL_PT_BR } from '../src/lib/professional-copy.js'

const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(frontendRoot, '..')
const appFile = join(frontendRoot, 'src/App.jsx')
const routeDocFile = join(repoRoot, 'docs/ux-audit/route-inventory.md')
const languageBaselineFile = join(frontendRoot, 'scripts/ux-audit-language-baseline.json')
const allowlistFile = join(frontendRoot, 'scripts/ux-audit-allowlist.json')

const ROUTE_START = '<!-- ux-audit:routes:start -->'
const ROUTE_END = '<!-- ux-audit:routes:end -->'

export function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!['locales', 'instr', 'exercise-names', 'exercise-desc', 'node_modules'].includes(entry.name)) walk(path, out)
    } else if (/\.(js|jsx|mjs)$/.test(entry.name) && !/\.test\.(js|jsx|mjs)$/.test(entry.name)) {
      out.push(path)
    }
  }
  return out
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length
}

function normalizeSpace(value) {
  return value.replace(/\s+/g, ' ').trim()
}

function importedViews(source) {
  const views = new Map()
  for (const match of source.matchAll(/import\s+([A-Za-z0-9_]+)\s+from\s+['"](\.\/views\/[^'"]+)['"]/g)) {
    views.set(match[1], { mode: 'eager', file: match[2].replace(/^\.\//, 'frontend/src/') })
  }
  for (const match of source.matchAll(/const\s+([A-Za-z0-9_]+)\s*=\s*lazyView\(\(\)\s*=>\s*import\(['"](\.\/views\/[^'"]+)['"]\)/g)) {
    views.set(match[1], { mode: 'lazy', file: match[2].replace(/^\.\//, 'frontend/src/') })
  }
  return views
}

function actorFor(path, expression) {
  if (path === '/admin') return 'Admin'
  if (/^\/coach\/(groups|challenges|programs)$/.test(path)) return 'Profissional (`kind=coach`), incl. Nutricionista'
  if (/^\/athlete\//.test(path) || path === '/join') return 'Atleta; dual-role no modo atleta'
  if (['/professionals', '/scheduling', '/community', '/groups', '/challenges', '/group-programs'].includes(path)) return 'Atleta, profissional e dual-role'
  if (/^\/coach(\/|$)/.test(path)) return 'Todos os perfis; “Coach” aqui é IA'
  if (expression.includes('Navigate') && path === '*') return 'Qualquer visitante do shell'
  return 'Atleta, profissional, dual-role e admin'
}

function protectionFor(path, expression, module) {
  const parts = ['shell: conta ou modo local']
  if (module) parts.push(`módulo \`${module}\``)
  if (expression.includes("profile?.kind === 'coach'")) parts.push('guard de papel no router')
  else if (path === '/admin') parts.push('guard `user.admin` no router')
  else if (/^\/athlete\//.test(path)) parts.push('sem guard de papel no router; API protege mutações')
  else if (['/professionals', '/scheduling', '/community'].includes(path)) parts.push('modo/papel decidido dentro da view')
  return parts.join('; ')
}

function routeModule(line) {
  return line.match(/isOn\(S, ['"]([^'"]+)['"]\)/)?.[1] || '—'
}

function routeComponent(expression) {
  const tags = [...expression.matchAll(/<([A-Z][A-Za-z0-9_]*)\b/g)].map(match => match[1])
  return tags.find(tag => !['Route', 'Navigate'].includes(tag)) || (expression.includes('<Navigate') ? 'redirect' : 'desconhecido')
}

function redirectTargets(expression) {
  return [...expression.matchAll(/<Navigate\s+to=['"]([^'"]+)['"]/g)].map(match => match[1])
}

function routeOrigins(path, sourceFiles) {
  if (path === '*') return ['fallback do router']
  const plain = path.replace(/:\w+/g, '')
  const hits = []
  for (const file of sourceFiles) {
    if (file === appFile || /\.test\./.test(file)) continue
    const text = readFileSync(file, 'utf8')
    const escaped = plain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(`['\"]${escaped}(?:['\"?+/])`)
    if (!pattern.test(text)) continue
    const rel = relative(repoRoot, file)
    if (rel.endsWith('components/TabBar.jsx')) hits.push('tab bar')
    else if (rel.endsWith('lib/tour.js')) hits.push('tour guiado')
    else if (rel.endsWith('views/Settings.jsx')) hits.push('Configurações')
    else if (rel.endsWith('views/Home.jsx')) hits.push('Home')
    else if (rel.endsWith('views/ProfessionalHub.jsx')) hits.push('hub profissional')
    else if (rel.endsWith('views/CommunityHub.jsx')) hits.push('hub Comunidade')
    else hits.push(basename(rel).replace(/\.(jsx?|mjs)$/, ''))
  }
  return [...new Set(hits)].slice(0, 5)
}

export function inventoryRoutes(appSource, sourceFiles = walk(join(frontendRoot, 'src'))) {
  const views = importedViews(appSource)
  const routes = []
  for (const [index, line] of appSource.split('\n').entries()) {
    const match = line.match(/<Route\s+path=['"]([^'"]+)['"]\s+element=\{(.+)\}\s*\/>/)
    if (!match) continue
    const path = match[1]
    const expression = match[2]
    const component = routeComponent(expression)
    const view = views.get(component)
    const module = routeModule(line)
    const redirects = redirectTargets(expression)
    routes.push({
      path,
      actor: actorFor(path, expression),
      origin: routeOrigins(path, sourceFiles),
      component,
      file: view?.file || (component === 'redirect' ? 'frontend/src/App.jsx' : '—'),
      loading: view?.mode || (component === 'redirect' ? 'n/a' : 'eager'),
      module,
      protection: protectionFor(path, expression, module === '—' ? null : module),
      redirects,
      line: index + 1,
    })
  }
  return routes
}

function markdownEscape(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

export function renderRouteTable(routes) {
  const rows = routes.map(route => {
    const destination = route.redirects.length ? ` → ${route.redirects.map(value => `\`${value}\``).join(' / ')}` : ''
    const origin = route.origin.length ? route.origin.join(', ') : 'deep link / sem origem estática encontrada'
    const module = route.module === '—' ? '—' : `\`${route.module}\``
    const component = route.component === 'redirect' ? `redirect${destination}` : `\`${route.component}\``
    return `| \`${markdownEscape(route.path)}\` | ${markdownEscape(route.actor)} | ${markdownEscape(origin)} | ${module} | ${component} | ${route.loading} | ${markdownEscape(route.protection)} |`
  })
  return [
    ROUTE_START,
    '| Rota | Ator permitido | Origem na navegação | Módulo | View / destino | Carga | Proteção observada |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
    ROUTE_END,
  ].join('\n')
}

export function replaceGeneratedRouteTable(document, table) {
  if (!document.includes(ROUTE_START) || !document.includes(ROUTE_END)) throw new Error('route inventory is missing generator markers')
  return document.replace(new RegExp(`${ROUTE_START}[\\s\\S]*?${ROUTE_END}`), table)
}

function readAllowlist() {
  const parsed = JSON.parse(readFileSync(allowlistFile, 'utf8'))
  return { exact: new Set(parsed.exact), patterns: parsed.patterns.map(pattern => new RegExp(pattern)) }
}

const ENGLISH_WORDS = new Set([
  'active', 'activity', 'admin', 'already', 'and', 'are', 'back', 'can', 'clear', 'code', 'copy', 'delete',
  'disabled', 'email', 'failed', 'for', 'from', 'invitation', 'is', 'log', 'more', 'new', 'no', 'nothing',
  'of', 'or', 'owner', 'refresh', 'revoke', 'show', 'sign', 'that', 'the', 'this', 'to', 'training', 'try',
  'unused', 'used', 'user', 'users', 'when', 'will', 'with', 'workout', 'workouts', 'yet', 'you', 'your',
])

function isObviousEnglish(value) {
  const words = value.toLowerCase().match(/[a-z]+/g) || []
  return words.some(word => ENGLISH_WORDS.has(word))
}

function allowlisted(value, allowlist) {
  return allowlist.exact.has(value) || allowlist.patterns.some(pattern => pattern.test(value))
}

function professionalTextAliases(source) {
  const aliases = new Set()
  for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"][^'"]*professional-copy\.js['"]/g)) {
    for (const specifier of match[1].split(',')) {
      const imported = specifier.trim().match(/^professionalText(?:\s+as\s+([A-Za-z_$][\w$]*))?$/)
      if (imported) aliases.add(imported[1] || 'professionalText')
    }
  }
  return aliases
}

export function scanVisibleEnglish(files, allowlist = readAllowlist()) {
  const findings = []
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    const candidates = []
    for (const match of source.matchAll(/>([^<>{}\n]*[A-Za-z][^<>{}\n]*)</g)) {
      candidates.push({ kind: 'jsx-text', value: normalizeSpace(match[1]), index: match.index + 1 })
    }
    for (const match of source.matchAll(/\b(aria-label|title|subtitle|placeholder|alt|label)=['"]([^'"]*[A-Za-z][^'"]*)['"]/g)) {
      candidates.push({ kind: match[1], value: normalizeSpace(match[2]), index: match.index })
    }
    for (const alias of professionalTextAliases(source)) {
      const escapedAlias = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const callPattern = new RegExp(`\\b${escapedAlias}\\(\\s*(['"])(.*?)\\1`, 'g')
      for (const match of source.matchAll(callPattern)) {
        const value = normalizeSpace(match[2])
        if (!PROFESSIONAL_PT_BR[value]) candidates.push({ kind: 'professional-copy', value, index: match.index })
      }
    }
    for (const candidate of candidates) {
      const lineStart = source.lastIndexOf('\n', candidate.index) + 1
      if (source.slice(lineStart, candidate.index).trimStart().startsWith('//')) continue
      if (candidate.kind === 'jsx-text' && (/^(\/\/|\/\*|:)/.test(candidate.value) || /=>|===|&&|\|\||\?\.|\b(const|return|function|if|else|new Set)\b/.test(candidate.value))) continue
      if (!candidate.value || allowlisted(candidate.value, allowlist)) continue
      if (candidate.kind !== 'professional-copy' && !isObviousEnglish(candidate.value)) continue
      findings.push({
        file: relative(repoRoot, file),
        line: lineOf(source, candidate.index),
        kind: candidate.kind,
        value: candidate.value,
      })
    }
  }
  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.value.localeCompare(b.value))
}

export function findingFingerprint(finding) {
  return `${finding.file}:${finding.kind}:${finding.value}`
}

export function auditViewSource(source) {
  const headings = Object.fromEntries([1, 2, 3, 4, 5, 6].map(level => [level, (source.match(new RegExp(`<h${level}\\b`, 'g')) || []).length]))
  const landmarks = Object.fromEntries(['main', 'nav', 'header', 'footer', 'aside'].map(tag => [tag, (source.match(new RegExp(`<${tag}\\b`, 'g')) || []).length]))
  return {
    headings,
    landmarks,
    states: {
      loading: /loading|Loading|Skeleton|busy/.test(source),
      empty: /empty|EmptyState|No [A-Za-z]/.test(source),
      error: /error|Error|role=['"]alert['"]/.test(source),
      offline: /offline|connection|Connection|sync/.test(source),
      retry: /retry|Retry|Try again/.test(source),
    },
  }
}

export function auditDocument(document, { minTouch = 44 } = {}) {
  const touchTargets = []
  for (const element of document.querySelectorAll('button, a[href], input, select, textarea, [role="button"]')) {
    if (element.disabled || element.getAttribute('aria-hidden') === 'true') continue
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) continue
    if (rect.width < minTouch || rect.height < minTouch) {
      touchTargets.push({ tag: element.tagName.toLowerCase(), label: element.getAttribute('aria-label') || element.textContent.trim(), width: rect.width, height: rect.height })
    }
  }
  const root = document.documentElement
  const overflow = root.scrollWidth > root.clientWidth ? root.scrollWidth - root.clientWidth : 0
  const headingLevels = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].map(element => Number(element.tagName.slice(1)))
  const headingJumps = []
  for (let index = 1; index < headingLevels.length; index++) {
    if (headingLevels[index] > headingLevels[index - 1] + 1) headingJumps.push([headingLevels[index - 1], headingLevels[index]])
  }
  return {
    touchTargets,
    overflow,
    headingLevels,
    headingJumps,
    landmarks: document.querySelectorAll('main, nav, header, footer, aside, [role="main"], [role="navigation"], [role="banner"], [role="contentinfo"], [role="complementary"]').length,
  }
}

export async function withConsoleAudit(run, target = console) {
  const errors = []
  const warnings = []
  const oldError = target.error
  const oldWarn = target.warn
  target.error = (...args) => { errors.push(args.map(String).join(' ')) }
  target.warn = (...args) => { warnings.push(args.map(String).join(' ')) }
  try {
    await run()
  } finally {
    target.error = oldError
    target.warn = oldWarn
  }
  return { errors, warnings }
}

export function criticalViewAudit() {
  const files = [
    'src/views/Home.jsx',
    'src/views/Plan.jsx',
    'src/views/Workout.jsx',
    'src/views/Stats.jsx',
    'src/views/ProfessionalHub.jsx',
    'src/views/SchedulingView.jsx',
    'src/views/CommunityHub.jsx',
    'src/views/Admin.jsx',
  ]
  return Object.fromEntries(files.map(file => [file, auditViewSource(readFileSync(join(frontendRoot, file), 'utf8'))]))
}

function currentLanguageFindings() {
  const roots = [join(frontendRoot, 'src/views'), join(frontendRoot, 'src/components')]
  return scanVisibleEnglish(roots.flatMap(root => walk(root)))
}

function verify() {
  const appSource = readFileSync(appFile, 'utf8')
  const routeTable = renderRouteTable(inventoryRoutes(appSource))
  const routeDoc = readFileSync(routeDocFile, 'utf8')
  if (!routeDoc.includes(routeTable)) throw new Error('route inventory is stale; run node scripts/ux-audit.mjs --write-route-doc')

  const expected = JSON.parse(readFileSync(languageBaselineFile, 'utf8')).findings
  const actual = currentLanguageFindings().map(findingFingerprint)
  const added = actual.filter(value => !expected.includes(value))
  const removed = expected.filter(value => !actual.includes(value))
  if (added.length || removed.length) {
    throw new Error(`visible-English baseline changed\nadded: ${added.join('\n  ')}\nremoved: ${removed.join('\n  ')}`)
  }
  console.log(`UX audit: ${inventoryRoutes(appSource).length} routes current; ${actual.length} known visible-English findings; generated inventory current.`)
}

function main() {
  const args = new Set(process.argv.slice(2))
  if (args.has('--write-route-doc')) {
    const source = readFileSync(appFile, 'utf8')
    const table = renderRouteTable(inventoryRoutes(source))
    writeFileSync(routeDocFile, replaceGeneratedRouteTable(readFileSync(routeDocFile, 'utf8'), table))
    console.log(`updated ${relative(repoRoot, routeDocFile)}`)
    return
  }
  if (args.has('--write-language-baseline')) {
    const findings = currentLanguageFindings()
    writeFileSync(languageBaselineFile, JSON.stringify({
      generatedFrom: ['frontend/src/views', 'frontend/src/components'],
      allowlist: 'frontend/scripts/ux-audit-allowlist.json',
      findings: findings.map(findingFingerprint),
      details: findings,
    }, null, 2) + '\n')
    console.log(`wrote ${findings.length} findings to ${relative(repoRoot, languageBaselineFile)}`)
    return
  }
  if (args.has('--json')) {
    const outputIndex = process.argv.indexOf('--json') + 1
    const report = {
      routes: inventoryRoutes(readFileSync(appFile, 'utf8')),
      visibleEnglish: currentLanguageFindings(),
      criticalViews: criticalViewAudit(),
      browserAvailable: ['chromium', 'chromium-browser', 'google-chrome', 'firefox'].some(binary => existsSync(`/usr/bin/${binary}`)),
    }
    const json = JSON.stringify(report, null, 2) + '\n'
    if (process.argv[outputIndex] && !process.argv[outputIndex].startsWith('--')) writeFileSync(process.argv[outputIndex], json)
    else process.stdout.write(json)
    return
  }
  verify()
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
