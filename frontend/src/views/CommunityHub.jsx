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

export default function CommunityHub({ embedded = false, defaultSection = 'groups', defaultRole }) {
  const user = useStore(state => state.user)
  const location = useLocation()
  const navigate = useNavigate()

  const isCoach = user?.profile?.kind === 'coach'

  const querySection = useMemo(() => {
    return new URLSearchParams(location.search).get('section') || defaultSection
  }, [location.search, defaultSection])

  const queryRole = useMemo(() => {
    return new URLSearchParams(location.search).get('role') || ''
  }, [location.search])

  const [globalRole, setGlobalRole, isDual] = useActiveRole(user)

  const [roleMode, setRoleMode] = useState(() => {
    if (defaultRole) return defaultRole
    if (queryRole === 'coach') return 'coach'
    if (queryRole === 'athlete') return 'athlete'
    return globalRole || (isCoach ? 'coach' : 'athlete')
  })

  React.useEffect(() => {
    if (!defaultRole && !queryRole && globalRole && globalRole !== roleMode) {
      setRoleMode(globalRole)
    }
  }, [globalRole, defaultRole, queryRole, roleMode])

  const handleRoleSwitch = mode => {
    setRoleMode(mode)
    setGlobalRole(mode)
  }

  const [section, setSection] = useState(querySection)

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
          <div className="gc-filter-group" role="tablist" aria-label={p('Role switch') || 'Role switch'}>
            <button
              type="button"
              role="tab"
              aria-selected={roleMode === 'coach'}
              className={`gc-filter-btn ${roleMode === 'coach' ? 'active' : ''}`}
              onClick={() => handleRoleSwitch('coach')}
            >
              {p('Coach view') || 'Coach view'}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={roleMode === 'athlete'}
              className={`gc-filter-btn ${roleMode === 'athlete' ? 'active' : ''}`}
              onClick={() => handleRoleSwitch('athlete')}
            >
              {p('Athlete view') || 'Athlete view'}
            </button>
          </div>
        </div>
      )}

      {/* Section navigation tabs */}
      <nav className="gc-nav-tabs" role="tablist" style={{ marginBottom: 12 }}>
        <button
          type="button"
          role="tab"
          aria-selected={section === 'groups'}
          className={`gc-tab ${section === 'groups' ? 'active' : ''}`}
          onClick={() => setSection('groups')}
        >
          <Icon name="person" />
          <span>{roleMode === 'coach' ? p('Groups') : p('My groups')}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={section === 'challenges'}
          className={`gc-tab ${section === 'challenges' ? 'active' : ''}`}
          onClick={() => setSection('challenges')}
        >
          <Icon name="trophy" />
          <span>{p('Group challenges')}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={section === 'programs'}
          className={`gc-tab ${section === 'programs' ? 'active' : ''}`}
          onClick={() => setSection('programs')}
        >
          <Icon name="calendar" />
          <span>{p('Collective programs')}</span>
        </button>
      </nav>

      {/* Section View */}
      {roleMode === 'coach' ? (
        section === 'groups' ? (
          <CoachGroupsView embedded />
        ) : section === 'challenges' ? (
          <CoachChallengesView embedded />
        ) : (
          <CoachGroupProgramsView embedded />
        )
      ) : (
        section === 'groups' ? (
          <AthleteGroupsView embedded />
        ) : section === 'challenges' ? (
          <AthleteChallengesView embedded />
        ) : (
          <AthleteGroupProgramsView embedded />
        )
      )}
    </div>
  )
}
