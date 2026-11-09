import React, { useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { professionalText as p } from '../lib/professional-copy.js'
import { useActiveRole } from '../lib/roles.js'
import Icon from '../components/Icon.jsx'
import CoachGroupsView from './coach/CoachGroupsView.jsx'
import CoachChallengesView from './coach/CoachChallengesView.jsx'
import CoachGroupProgramsView from './coach/CoachGroupProgramsView.jsx'
import AthleteGroupsView from './athlete/AthleteGroupsView.jsx'
import AthleteChallengesView from './athlete/AthleteChallengesView.jsx'
import AthleteGroupProgramsView from './athlete/AthleteGroupProgramsView.jsx'
import './GroupChallenges.css'

const isCommunityRole = role => role === 'coach' || role === 'athlete'
const COMMUNITY_SECTIONS = ['groups', 'challenges', 'programs']

const normalizeCommunityRole = (requestedRole, baseRole, isDual) => {
  if (!isDual) return baseRole
  return isCommunityRole(requestedRole) ? requestedRole : baseRole
}

export default function CommunityHub({ embedded = false, defaultSection = 'groups', defaultRole }) {
  const tabsId = `community-${React.useId().replace(/:/g, '')}`
  const tabId = section => `${tabsId}-tab-${section}`
  const panelId = section => `${tabsId}-panel-${section}`
  const user = useStore(state => state.user)
  const location = useLocation()
  const navigate = useNavigate()

  const isCoach = user?.profile?.kind === 'coach'
  const baseRole = isCoach ? 'coach' : 'athlete'

  const querySection = useMemo(() => {
    const requested = new URLSearchParams(location.search).get('section') || defaultSection
    return COMMUNITY_SECTIONS.includes(requested) ? requested : 'groups'
  }, [location.search, defaultSection])

  const queryRole = useMemo(() => {
    return new URLSearchParams(location.search).get('role') || ''
  }, [location.search])

  const [globalRole, setGlobalRole, isDual] = useActiveRole(user)
  const explicitRole = isCommunityRole(defaultRole)
    ? defaultRole
    : isCommunityRole(queryRole)
      ? queryRole
      : null

  const [roleMode, setRoleMode] = useState(() => {
    return normalizeCommunityRole(explicitRole || globalRole, baseRole, isDual)
  })

  React.useEffect(() => {
    setRoleMode(currentRole => {
      const nextRole = normalizeCommunityRole(explicitRole || currentRole, baseRole, isDual)
      return nextRole === currentRole ? currentRole : nextRole
    })
  }, [explicitRole, baseRole, isDual])

  React.useEffect(() => {
    if (explicitRole) return
    setRoleMode(currentRole => {
      const nextRole = normalizeCommunityRole(globalRole, baseRole, isDual)
      return nextRole === currentRole ? currentRole : nextRole
    })
  }, [globalRole, explicitRole, baseRole, isDual])

  const authorizedRoleMode = normalizeCommunityRole(roleMode, baseRole, isDual)

  const handleRoleSwitch = mode => {
    const nextRole = normalizeCommunityRole(mode, baseRole, isDual)
    setRoleMode(currentRole => currentRole === nextRole ? currentRole : nextRole)
    if (isDual && isCommunityRole(mode)) setGlobalRole(nextRole)
  }

  const [section, setSection] = useState(querySection)
  const handleSectionKeyDown = event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const rtl = typeof document !== 'undefined' && document.documentElement.dir === 'rtl'
    const currentIndex = COMMUNITY_SECTIONS.indexOf(section)
    const len = COMMUNITY_SECTIONS.length
    const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? COMMUNITY_SECTIONS.length - 1
      : event.key === 'ArrowRight' ? (rtl ? (currentIndex - 1 + len) % len : (currentIndex + 1) % len)
      : (rtl ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len)
    const nextSection = COMMUNITY_SECTIONS[nextIndex]
    setSection(nextSection)
    event.currentTarget.parentElement?.querySelector(`[data-community-tab="${nextSection}"]`)?.focus()
  }

  const canSwitchRole = isDual

  return (
    <div className={`gc-page ${embedded ? 'embedded' : 'narrow'}`}>
      {!embedded && (
        <div className="pro-nav">
          <button type="button" onClick={() => navigate(location.state?.from || '/home')}>
            <Icon name="chevronLeft" />
            <span>Início</span>
          </button>
        </div>
      )}

      {/* Role Switcher if dual role */}
      {canSwitchRole && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
          <div className="gc-filter-group" role="group" aria-label={p('Role switch')}>
            <button
              type="button"
              aria-pressed={authorizedRoleMode === 'coach'}
              className={`gc-filter-btn ${authorizedRoleMode === 'coach' ? 'active' : ''}`}
              onClick={() => handleRoleSwitch('coach')}
            >
              {p('Coach view')}
            </button>
            <button
              type="button"
              aria-pressed={authorizedRoleMode === 'athlete'}
              className={`gc-filter-btn ${authorizedRoleMode === 'athlete' ? 'active' : ''}`}
              onClick={() => handleRoleSwitch('athlete')}
            >
              {p('Athlete view')}
            </button>
          </div>
        </div>
      )}

      {/* Section navigation tabs */}
      <nav aria-label={p('Community')} style={{ marginBottom: 12 }}>
        <div className="gc-nav-tabs" role="tablist" aria-label={p('Community')}>
        <button
          type="button"
          role="tab"
          id={tabId('groups')}
          data-community-tab="groups"
          aria-controls={panelId('groups')}
          aria-selected={section === 'groups'}
          tabIndex={section === 'groups' ? 0 : -1}
          className={`gc-tab ${section === 'groups' ? 'active' : ''}`}
          onClick={() => setSection('groups')}
          onKeyDown={handleSectionKeyDown}
        >
          <Icon name="person" />
          <span>{authorizedRoleMode === 'coach' ? p('Groups') : p('My groups')}</span>
        </button>
        <button
          type="button"
          role="tab"
          id={tabId('challenges')}
          data-community-tab="challenges"
          aria-controls={panelId('challenges')}
          aria-selected={section === 'challenges'}
          tabIndex={section === 'challenges' ? 0 : -1}
          className={`gc-tab ${section === 'challenges' ? 'active' : ''}`}
          onClick={() => setSection('challenges')}
          onKeyDown={handleSectionKeyDown}
        >
          <Icon name="trophy" />
          <span>{p('Group challenges')}</span>
        </button>
        <button
          type="button"
          role="tab"
          id={tabId('programs')}
          data-community-tab="programs"
          aria-controls={panelId('programs')}
          aria-selected={section === 'programs'}
          tabIndex={section === 'programs' ? 0 : -1}
          className={`gc-tab ${section === 'programs' ? 'active' : ''}`}
          onClick={() => setSection('programs')}
          onKeyDown={handleSectionKeyDown}
        >
          <Icon name="calendar" />
          <span>{p('Collective programs')}</span>
        </button>
        </div>
      </nav>

      {/* Section View */}
      {COMMUNITY_SECTIONS.map(panel => (
        <div
          key={panel}
          id={panelId(panel)}
          role="tabpanel"
          aria-labelledby={tabId(panel)}
          data-community-panel={panel}
          tabIndex={panel === section ? 0 : -1}
          hidden={panel !== section}
        >
          {panel === section && (authorizedRoleMode === 'coach' ? (
            panel === 'groups' ? (
              <CoachGroupsView embedded headingLevel={embedded ? 2 : 1} />
            ) : panel === 'challenges' ? (
              <CoachChallengesView embedded headingLevel={embedded ? 2 : 1} />
            ) : (
              <CoachGroupProgramsView embedded headingLevel={embedded ? 2 : 1} />
            )
          ) : (
            panel === 'groups' ? (
              <AthleteGroupsView embedded headingLevel={embedded ? 2 : 1} />
            ) : panel === 'challenges' ? (
              <AthleteChallengesView embedded headingLevel={embedded ? 2 : 1} />
            ) : (
              <AthleteGroupProgramsView embedded headingLevel={embedded ? 2 : 1} />
            )
          ))}
        </div>
      ))}
    </div>
  )
}
