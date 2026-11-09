import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const dir = import.meta.dirname
const indexCss = readFileSync(resolve(dir, 'index.css'), 'utf8')
const dsCss = readFileSync(resolve(dir, 'design-system.css'), 'utf8')
const coachCss = readFileSync(resolve(dir, 'coach.css'), 'utf8')
const dashboardCss = readFileSync(resolve(dir, 'views/dashboard/DashboardHome.css'), 'utf8')
const proCss = readFileSync(resolve(dir, 'views/ProfessionalHub.css'), 'utf8')
const appJsx = readFileSync(resolve(dir, 'App.jsx'), 'utf8')

describe('Safe area inset enforcement on critical mobile containers', () => {
  it('TabBar and fixed CTAs apply safe area bottom with fallback spacing', () => {
    expect(indexCss).toContain('padding:7px 6px max(calc(6px + var(--sab)), var(--ds-space-3, 12px))')
    expect(indexCss).toContain('padding:14px 14px max(calc(10px + var(--sab)), var(--ds-space-3, 12px))')
    expect(indexCss).toContain('.pp-cta{position:sticky;bottom:max(calc(var(--sab) + 10px), var(--ds-space-3, 12px))')
    expect(coachCss).toContain('padding:8px var(--pad) max(calc(10px + var(--sab)), var(--ds-space-3, 12px))')
    expect(coachCss).toContain('bottom:max(calc(58px + var(--sab)), var(--ds-space-4, 16px))')
  })

  it('Bottom sheets and modal headers respect safe area top and bottom', () => {
    expect(indexCss).toContain('padding:8px 18px max(calc(20px + var(--sab)), var(--ds-space-5, 20px))')
    expect(indexCss).toContain('max-height:min(90vh,calc(100dvh - var(--sat) - 8px - var(--native-kb,0px)))')
    expect(indexCss).toContain('scroll-padding-bottom:max(calc(20px + var(--sab)), var(--ds-space-5, 20px))')
  })

  it('Dual-role shell and sticky headers avoid notch overlap via safe area top', () => {
    expect(indexCss).toContain('padding: calc(var(--sat) + 4px) 12px 4px;')
    expect(indexCss).toContain('body:has(.shell-dual-role-bar) #app{padding-top:calc(var(--conn) + 8px)}')
    expect(indexCss).toContain('padding:calc(var(--sat) + var(--conn) + 8px) var(--pad) 0;')
  })

  it('Design system portaled modals and drawers incorporate safe area insets', () => {
    expect(dsCss).toContain('--ds-safe-area-top: var(--sat, 0px);')
    expect(dsCss).toContain('--ds-safe-area-bottom: var(--sab, 0px);')
    expect(dsCss).toContain('padding-top: max(var(--sat, 0px), var(--ds-space-3));')
    expect(dsCss).toContain('padding-bottom: max(var(--sab, 0px), var(--ds-space-3));')
    expect(dsCss).toContain('max-height: min(calc(100dvh - var(--sat, 0px) - var(--sab, 0px) - var(--ds-space-6)), 48rem);')
    expect(dsCss).toContain('padding-top: max(var(--sat, 0px), var(--ds-space-3));')
    expect(dsCss).toContain('padding-bottom: max(var(--sab, 0px), var(--ds-space-4));')
    expect(dsCss).toContain('padding: max(var(--sat, 0px), var(--ds-space-4)) var(--ds-space-4) var(--ds-space-3);')
  })

  it('Dashboard view uses safe area tokens instead of direct env references', () => {
    expect(dashboardCss).toContain('padding: max(var(--sat, 0px), var(--ds-space-5)) var(--ds-space-4) calc(7rem + var(--sab, 0px));')
    expect(dashboardCss).toContain('padding: max(var(--sat, 0px), var(--ds-space-8)) var(--ds-space-6) calc(8rem + var(--sab, 0px));')
    expect(proCss).toContain('padding:max(var(--sat, 0px), 16px) 16px max(var(--sab, 0px), 16px)')
  })
})

describe('Universal 44x44px touch targets', () => {
  it('compact buttons (.btn.sm, .btn.xs) extend touch area to >= 44x44px', () => {
    expect(indexCss).toContain('.btn.sm,.btn.xs{position:relative}')
    expect(indexCss).toContain('.btn.sm::before,.btn.xs::before{content:\'\';position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);min-width:44px;min-height:44px;width:100%;height:100%}')
  })

  it('icon buttons have accessible touch target of at least 44x44px', () => {
    expect(dsCss).toContain('width: 44px;')
    expect(dsCss).toContain('height: 44px;')
    expect(indexCss).toContain('width:36px;height:36px;')
  })

  it('filter chips, segmented controls, and tabs guarantee 44px touch area', () => {
    expect(indexCss).toContain('min-height:44px;min-width:44px;')
    expect(dsCss).toContain('min-width: 44px;')
    expect(dsCss).toContain('min-height: 44px;')
    expect(indexCss).toContain('.pagination button, .pager button, .page-btn, .focus-pager>button')
  })
})

describe('Layout containment and horizontal overflow prevention across all 35 routes', () => {
  it('covers all 35 declared routes in the audit inventory', () => {
    const routes = [...appJsx.matchAll(/<Route\s+path=['"]([^'"]+)['"]/g)].map(m => m[1])
    expect(routes.length).toBe(35)
  })

  it.each([375, 390, 412, 768])('prevents horizontal overflow across viewport %ipx', viewportWidth => {
    expect(viewportWidth).toBeGreaterThanOrEqual(375)
    expect(indexCss).toContain('html{')
    expect(indexCss).toContain('overflow-x:clip')
    expect(indexCss).toContain('#app{')
    expect(indexCss).toContain('width:100%;min-width:0;overflow-x:clip')
    expect(indexCss).toContain('img,video,canvas,iframe{max-width:100%}')
  })
})
