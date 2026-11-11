import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const dir = import.meta.dirname
const roleSwitcherCss = readFileSync(resolve(dir, 'components/RoleSwitcher.css'), 'utf8')
const indexCss = readFileSync(resolve(dir, 'index.css'), 'utf8')
const dashboardCss = readFileSync(resolve(dir, 'views/dashboard/DashboardHome.css'), 'utf8')
const proHubCss = readFileSync(resolve(dir, 'views/ProfessionalHub.css'), 'utf8')
const nutritionCss = readFileSync(resolve(dir, 'views/NutritionPanel.css'), 'utf8')

describe('Responsive breakpoints and mobile/tablet/desktop rules', () => {
  describe('RoleSwitcher mobile rules (<= 480px)', () => {
    it('applies fluid 100% width and centered layout on screens <= 480px', () => {
      expect(roleSwitcherCss).toMatch(/@media \(max-width:\s*480px\)/)
      expect(roleSwitcherCss).toMatch(/\.ds-role-switcher-container\s*\{[^}]*width:\s*100%/)
      expect(roleSwitcherCss).toMatch(/\.ds-role-switcher-container\s*\{[^}]*justify-content:\s*center/)
      expect(roleSwitcherCss).toMatch(/\.ds-role-switcher-container\s*\{[^}]*padding:\s*4px 0 6px/)
      expect(roleSwitcherCss).toMatch(/\.ds-role-switcher\s*\{[^}]*width:\s*100%/)
      expect(roleSwitcherCss).toMatch(/\.ds-role-switcher\s*\{[^}]*max-width:\s*100%/)
      expect(roleSwitcherCss).toMatch(/\.ds-role-switcher\s*\{[^}]*display:\s*flex/)
    })

    it('ensures tabs flex equally without text overflow', () => {
      expect(roleSwitcherCss).toMatch(/\.ds-role-tab\s*\{[^}]*flex:\s*1/)
      expect(roleSwitcherCss).toMatch(/\.ds-role-tab\s*\{[^}]*min-width:\s*0/)
      expect(roleSwitcherCss).toMatch(/\.ds-role-tab\s*\{[^}]*padding:\s*6px 8px/)
      expect(roleSwitcherCss).toMatch(/\.ds-role-tab\s*\{[^}]*font-size:\s*13px/)
      expect(roleSwitcherCss).toMatch(/\.ds-role-tab span\s*\{[^}]*overflow:\s*hidden/)
      expect(roleSwitcherCss).toMatch(/\.ds-role-tab span\s*\{[^}]*text-overflow:\s*ellipsis/)
      expect(roleSwitcherCss).toMatch(/\.ds-role-tab span\s*\{[^}]*white-space:\s*nowrap/)
    })
  })

  describe('Global index.css tablet and mobile rules', () => {
    it('supports tablet breakpoint (600px–999px) expanding #app to 760px', () => {
      expect(indexCss).toMatch(/@media \(min-width:\s*600px\) and \(max-width:\s*999px\)/)
      expect(indexCss).toMatch(/#app\s*\{[^}]*max-width:\s*760px;[^}]*padding-inline:\s*24px;/)
    })

    it('optimizes mobile tabbar on screens <= 440px and <= 360px', () => {
      expect(indexCss).toMatch(/@media \(max-width:\s*440px\)/)
      expect(indexCss).toContain('overflow-x: auto;')
      expect(indexCss).toContain('scrollbar-width: none;')
      expect(indexCss).toContain('-webkit-overflow-scrolling: touch;')
      expect(indexCss).toMatch(/font-size:\s*8\.5px;/)
      expect(indexCss).toMatch(/font-size:\s*20px;/)

      expect(indexCss).toMatch(/@media \(max-width:\s*360px\)/)
      expect(indexCss).toMatch(/font-size:\s*7\.5px;/)
      expect(indexCss).toMatch(/font-size:\s*18px;/)
    })
  })

  describe('DashboardHome responsive rules', () => {
    it('guarantees single column for priorities under 600px with min 44px touch targets', () => {
      expect(dashboardCss).toMatch(/@media \(max-width:\s*599px\)/)
      expect(dashboardCss).toMatch(/\.dashboard-priority-grid\s*\{\s*grid-template-columns:\s*1fr;\s*\}/)
      expect(dashboardCss).toMatch(/\.dashboard-quick-actions \.ds-button[^}]*min-height:\s*44px/)
    })

    it('adapts mobile layout on <= 480px ensuring no item overflows', () => {
      expect(dashboardCss).toMatch(/\.dashboard-shell\s*\{[^}]*max-width:\s*100%/)
      expect(dashboardCss).toMatch(/\.dashboard-quick-actions > div\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/)
    })

    it('optimizes spacing for tablets (600px–999px)', () => {
      expect(dashboardCss).toMatch(/@media \(min-width:\s*600px\) and \(max-width:\s*999px\)/)
    })
  })
  describe('ProfessionalHub mobile rules', () => {
    it('handles mobile prescription button and athlete cards on screens <= 480px and <= 600px', () => {
      expect(proHubCss).toMatch(/@media \(max-width:\s*480px\)/)
      expect(proHubCss).toMatch(/\.pro-panel-head\s*\{[^}]*flex-wrap:\s*wrap/)
      expect(proHubCss).toMatch(/@media \(max-width:\s*600px\)/)
      expect(proHubCss).toMatch(/\.pro-actions button/)
      expect(proHubCss).toMatch(/min-width:\s*120px/)
    })

    it('keeps card action buttons and status filter chips compact on mobile', () => {
      expect(proHubCss).toMatch(/\.pro-card-actions\s*\{/)
      expect(proHubCss).toMatch(/\.pro-card-actions (?:\.btn|button|\.ds-button)/)
      expect(proHubCss).toMatch(/min-height:\s*32px\s*!important/)
      expect(proHubCss).toMatch(/height:\s*32px\s*!important/)
      expect(proHubCss).toMatch(/font-size:\s*12px\s*!important/)
      expect(proHubCss).toMatch(/\.pro-status-filter \.pro-choice\s*\{[^}]*flex:\s*0 0 auto/)
      expect(proHubCss).toMatch(/\.pro-status-filter \.pro-choice\s*\{[^}]*font-size:\s*12px/)
      expect(proHubCss).toMatch(/\.pro-status-filter \.pro-choice\s*\{[^}]*min-height:\s*32px/)
    })

    it('prevents right-edge clipping and wraps card quota text on mobile', () => {
      expect(proHubCss).toMatch(/\.card[^{]*\.pro-link[^{]*\{[^}]*overflow-x:\s*(?:clip|hidden)/)
      expect(proHubCss).toMatch(/\.pro-panel-head\s*\{[^}]*justify-content:\s*space-between/)
      expect(proHubCss).toMatch(/\.pro-panel-head\s*\{[^}]*width:\s*100%/)
      expect(proHubCss).toMatch(/\.pro-panel-head\s*\{[^}]*box-sizing:\s*border-box/)
      expect(proHubCss).toMatch(/\.pro-panel-head (?:button|\.btn|\.ds-button)[^{]*\{[^}]*flex-shrink:\s*0/)
      expect(proHubCss).toMatch(/\.pro-panel-head (?:button|\.btn|\.ds-button)[^{]*\{[^}]*margin-right:\s*0/)
      expect(proHubCss).toMatch(/\.nutrition-quota[^{]*\{[^}]*overflow-wrap:\s*break-word\s*!important/)
      expect(proHubCss).toMatch(/\.nutrition-quota[^{]*\{[^}]*white-space:\s*normal\s*!important/)
      expect(nutritionCss).toMatch(/\.pro-panel-head\s*\{[^}]*justify-content:\s*space-between/)
      expect(nutritionCss).toMatch(/\.pro-panel-head (?:button|\.btn|\.ds-button)[^{]*\{[^}]*flex-shrink:\s*0/)
      expect(nutritionCss).toMatch(/\.nutrition-quota[^{]*\{[^}]*overflow-wrap:\s*break-word\s*!important/)
      expect(nutritionCss).toMatch(/\.card[^{]*\.nutrition-panel[^{]*\{[^}]*overflow-x:\s*(?:clip|hidden)/)
    })
  })
});