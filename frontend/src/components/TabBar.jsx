import { useLocation, useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { effectiveRoutineIds, effectiveRoutines } from '../lib/history.js'
import { todayISO } from '../lib/format.js'
import { t } from '../lib/i18n.js'
import Icon from './Icon.jsx'
import Elapsed from './Elapsed.jsx'
import { useConnectionTrouble } from './SyncBanner.jsx'
import { retapTab } from '../lib/scroll-top.js'
import { useActiveRole } from '../lib/roles.js'

function Tab({ active, icon, label, onClick, dot, tour }) {
  return (
    <button
      className={active ? 'on' : ''}
      onClick={onClick}
      data-tour={tour}
      aria-label={dot ? label + ', ' + t('Connection problem') : undefined}
    >
      <span className="tab-ic">
        <Icon name={icon} />
        {dot && <span className="tab-dot" aria-hidden="true" />}
      </span>
      <span>{label}</span>
    </button>
  )
}

function resolveActiveTabKey(pathname, search, role, availableKeys, state) {
  const parts = pathname.split('/')
  const cur = parts[1] || 'home'
  const sub = parts[2] || ''

  if (role === 'coach') {
    if (cur === 'professionals') {
      if (search.includes('tab=nutrition') && availableKeys.has('nutrition')) {
        return 'nutrition'
      }
      return 'professionals'
    }
    if (cur === 'home' || cur === 'checkin') return 'home'
    if (cur === 'plan') return 'plan'
    if (cur === 'scheduling') return 'scheduling'
    if (cur === 'community' || cur === 'groups' || cur === 'challenges' || cur === 'group-programs' || (cur === 'coach' && ['groups', 'challenges', 'programs'].includes(sub))) {
      return 'community'
    }
    if (cur === 'settings' || cur === 'admin') return 'settings'
    if (availableKeys.has(cur)) return cur
    return 'home'
  }

  if (role === 'athlete') {
    if (cur === 'home' || cur === 'checkin') return 'home'
    if (cur === 'plan') return 'plan'
    if (['stats', 'history', 'structural-balance', 'progress-photos', 'measurements'].includes(cur)) return 'stats'
    if (cur === 'muscles') return 'stats'
    if (cur === 'community' || cur === 'join' || cur === 'groups' || cur === 'challenges' || cur === 'group-programs' || cur === 'athlete') {
      return 'community'
    }
    if (cur === 'settings' || cur === 'professionals' || cur === 'scheduling' || cur === 'admin') return 'settings'
    if (availableKeys.has(cur)) return cur
    return 'home'
  }

  // Legacy resolution
  if (cur === 'workout') return 'workout'
  const PARENT = {
    history: 'stats',
    'structural-balance': 'stats',
    'progress-photos': 'stats',
    measurements: 'stats',
    settings: 'home',
    professionals: 'home',
    scheduling: 'home',
    checkin: 'home',
    muscles: 'library',
    coach: 'home',
    athlete: 'home',
    groups: 'home',
    challenges: 'home',
    'group-programs': 'home',
    community: 'home',
    join: 'home',
  }
  const parent = cur === 'muscles' && state?.from === '/stats' ? 'stats' : PARENT[cur]
  if (availableKeys.has(cur)) return cur
  if (parent && availableKeys.has(parent)) return parent
  return 'home'
}

export default function TabBar({ onStart }) {
  const nav = useNavigate()
  const loc = useLocation()
  const S = useStore(s => s.S)
  const user = useStore(s => s.user)
  const isGuest = useStore(s => s.isGuest())
  const trouble = useConnectionTrouble()
  const [activeRole] = useActiveRole(user)

  if (!user && !isGuest) return null

  const switchTab = path => {
    if (loc.pathname !== path || loc.search) nav(path, { replace: true })
    else retapTab(path)
  }

  const cur = loc.pathname.split('/')[1] || 'home'
  const running = !!S.active && cur !== 'workout' && !S.active.editingWorkoutId && !S.active.backfill && S.active.start > 0

  const startWorkout = () => {
    if (!S.active) {
      if (effectiveRoutines(S, todayISO()).some(r => r.ex.length)) {
        onStart(effectiveRoutineIds(S, todayISO()))
        return
      }
    }
    nav('/workout')
  }

  // Determine role-based vs legacy structure
  const hasProfileKind = Boolean(user?.profile?.kind)
  const isCoach = hasProfileKind && activeRole === 'coach'
  const isAthlete = hasProfileKind && activeRole === 'athlete'

  if (isCoach) {
    const hasNutrition = Boolean(
      user?.profile?.coachSpecialties?.includes('nutrition') ||
      user?.coachSpecialties?.includes('nutrition')
    )

    const coachTabs = [
      { key: 'home', path: '/home', icon: 'house', label: t('Home'), tour: 'tab-home', dot: trouble },
      { key: 'professionals', path: '/professionals', icon: 'person', label: t('Athletes'), tour: 'tab-athletes' },
      { key: 'plan', path: '/plan', icon: 'calendar', label: t('Workouts'), tour: 'tab-plan' },
      ...(hasNutrition ? [{ key: 'nutrition', path: '/professionals?tab=nutrition', icon: 'scale', label: t('Nutrition'), tour: 'tab-nutrition' }] : []),
      { key: 'scheduling', path: '/scheduling', icon: 'clock', label: t('Schedule'), tour: 'tab-schedule' },
      { key: 'community', path: '/community', icon: 'trophy', label: t('Community'), tour: 'tab-community' },
      { key: 'settings', path: '/settings', icon: 'gear', label: t('Settings'), tour: 'tab-settings' },
    ]

    const availableKeys = new Set(coachTabs.map(t => t.key))
    const activeKey = resolveActiveTabKey(loc.pathname, loc.search, 'coach', availableKeys, loc.state)

    return (
      <nav id="tabbar" className="coach-tabbar">
        {coachTabs.map(tab => (
          <Tab
            key={tab.key}
            active={tab.key === activeKey}
            icon={tab.icon}
            label={tab.label}
            dot={tab.dot}
            onClick={() => switchTab(tab.path)}
            tour={tab.tour}
          />
        ))}
      </nav>
    )
  }

  if (isAthlete) {
    const athleteTabs = [
      { key: 'home', path: '/home', icon: 'house', label: t('Today'), tour: 'tab-home', dot: trouble },
      { key: 'plan', path: '/plan', icon: 'calendar', label: t('My plan'), tour: 'tab-plan' },
      { key: 'stats', path: '/stats', icon: 'chart', label: t('Evolution'), tour: 'tab-stats' },
      { key: 'community', path: '/community', icon: 'trophy', label: t('Community'), tour: 'tab-community' },
      { key: 'settings', path: '/settings', icon: 'person', label: t('Profile'), tour: 'tab-settings' },
    ]

    const availableKeys = new Set(athleteTabs.map(t => t.key))
    const activeKey = resolveActiveTabKey(loc.pathname, loc.search, 'athlete', availableKeys, loc.state)

    return (
      <nav id="tabbar" className="athlete-tabbar">
        {athleteTabs.map(tab => (
          <Tab
            key={tab.key}
            active={tab.key === activeKey}
            icon={tab.icon}
            label={tab.label}
            dot={tab.dot}
            onClick={() => switchTab(tab.path)}
            tour={tab.tour}
          />
        ))}
      </nav>
    )
  }

  // Legacy fallback for tests or unconfigured profiles
  const legacyKeys = new Set(['home', 'plan', 'workout', 'stats', 'library'])
  const activeKey = resolveActiveTabKey(loc.pathname, loc.search, 'legacy', legacyKeys, loc.state)

  return (
    <nav id="tabbar">
      <Tab active={activeKey === 'home'} icon="house" label={t('Home')} dot={trouble} onClick={() => switchTab('/home')} tour="tab-home" />
      <Tab active={activeKey === 'plan'} icon="calendar" label={t('Plan')} onClick={() => switchTab('/plan')} tour="tab-plan" />
      <button
        data-tour="start"
        className={'start' + (S.active ? ' rec' : '') + (activeKey === 'workout' ? ' on' : '')}
        onClick={startWorkout}
        aria-label={running ? t('Resume') : undefined}
      >
        <span className="cir"><Icon name="play" /></span>
        {running ? <span className="tab-time"><Elapsed start={S.active.start} /></span>
          : <span>{S.active ? (cur === 'workout' ? t('Workout') : S.active.editingWorkoutId ? t('Edit workout') : t('Resume')) : t('Start')}</span>}
      </button>
      <Tab active={activeKey === 'stats'} icon="chart" label={t('Stats')} onClick={() => switchTab('/stats')} tour="tab-stats" />
      <Tab active={activeKey === 'library'} icon="dumbbell" label={t('Exercises')} onClick={() => switchTab('/library')} tour="tab-library" />
    </nav>
  )
}
