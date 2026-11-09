// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  auditDocument,
  findingFingerprint,
  inventoryRoutes,
  renderRouteTable,
  replaceGeneratedRouteTable,
  scanVisibleEnglish,
  walk,
  withConsoleAudit,
} from './ux-audit.mjs'

const frontend = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repo = resolve(frontend, '..')

describe('UX audit route inventory', () => {
  it('derives lazy loading, module and router guards from App source', () => {
    const source = `
      import Home from './views/Home.jsx'
      const Admin = lazyView(() => import('./views/Admin.jsx'))
      const Stats = createRouteSurface(() => import('./views/Stats.jsx'), 'a evolução')
      {isOn(S, 'body') && <Route path="/body" element={<Home />} />}
      <Route path="/stats" element={<Stats />} />
      <Route path="/admin" element={user?.admin ? <Admin /> : <Navigate to="/home" replace />} />
      <Route path="*" element={<Navigate to="/home" replace />} />
    `
    const routes = inventoryRoutes(source, [])
    expect(routes.map(route => ({ path: route.path, component: route.component, loading: route.loading, module: route.module, redirects: route.redirects }))).toEqual([
      { path: '/body', component: 'Home', loading: 'eager', module: 'body', redirects: [] },
      { path: '/stats', component: 'Stats', loading: 'lazy', module: '—', redirects: [] },
      { path: '/admin', component: 'Admin', loading: 'lazy', module: '—', redirects: ['/home'] },
      { path: '*', component: 'redirect', loading: 'n/a', module: '—', redirects: ['/home'] },
    ])
  })

  it('keeps the checked-in route table generated from App.jsx', () => {
    const table = renderRouteTable(inventoryRoutes(readFileSync(join(frontend, 'src/App.jsx'), 'utf8')))
    const document = readFileSync(join(repo, 'docs/ux-audit/route-inventory.md'), 'utf8')
    expect(document).toContain(table)
    expect(replaceGeneratedRouteTable(document, table)).toBe(document)
  })
})

describe('UX audit visible-English detector', () => {
  it('finds untranslated JSX and attributes while honoring the documented allowlist', () => {
    const file = join(frontend, 'scripts/fixtures/ux-audit-visible.jsx')
    const findings = scanVisibleEnglish([file], { exact: new Set(['HH:MM']), patterns: [] })
    expect(findings.map(finding => [finding.kind, finding.value])).toEqual([
      ['aria-label', 'Back'],
      ['jsx-text', 'Try again'],
      ['professional-copy', 'Untranslated professional action'],
    ])
  })

  it('matches the checked-in known-debt baseline', () => {
    const baseline = JSON.parse(readFileSync(join(frontend, 'scripts/ux-audit-language-baseline.json'), 'utf8'))
    const allowlistData = JSON.parse(readFileSync(join(frontend, 'scripts/ux-audit-allowlist.json'), 'utf8'))
    const allowlist = { exact: new Set(allowlistData.exact), patterns: allowlistData.patterns.map(pattern => new RegExp(pattern)) }
    const files = baseline.generatedFrom.flatMap(root => walk(join(repo, root)))
    const current = scanVisibleEnglish(files, allowlist).map(findingFingerprint)
    expect(current).toEqual(baseline.findings)
    expect(baseline.findings).toEqual(baseline.details.map(findingFingerprint))
  })
})

describe('UX audit browser probes', () => {
  it('reports small targets, horizontal overflow, heading jumps and missing landmarks', () => {
    document.body.innerHTML = '<h1>Title</h1><h3>Skipped</h3><button aria-label="Save">Save</button>'
    Object.defineProperties(document.documentElement, { clientWidth: { configurable: true, value: 375 }, scrollWidth: { configurable: true, value: 401 } })
    document.querySelector('button').getBoundingClientRect = () => ({ width: 32, height: 40 })
    expect(auditDocument(document)).toEqual({
      touchTargets: [{ tag: 'button', label: 'Save', width: 32, height: 40 }],
      overflow: 26,
      headingLevels: [1, 3],
      headingJumps: [[1, 3]],
      landmarks: 0,
    })
  })

  it('captures console warnings and errors without leaking instrumentation', async () => {
    const fake = { error: () => {}, warn: () => {} }
    const originalError = fake.error
    const result = await withConsoleAudit(() => { fake.warn('slow'); fake.error('boom') }, fake)
    expect(result).toEqual({ errors: ['boom'], warnings: ['slow'] })
    expect(fake.error).toBe(originalError)
  })
})
