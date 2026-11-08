import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../../store/useStore.js'
import { useUI } from '../../store/useUI.js'
import { api } from '../../lib/api.js'
import { professionalError, professionalText as p } from '../../lib/professional-copy.js'
import {
  listCoachChallenges,
  createCoachChallenge,
  getCoachChallenge,
  updateCoachChallenge,
  deleteCoachChallenge,
  getCoachChallengeLeaderboard,
  awardCustomPoints,
  listCoachGroups,
  generateIdempotencyKey,
} from '../../lib/group-challenges-api.js'
import Icon from '../../components/Icon.jsx'
import EmptyState from '../../components/EmptyState.jsx'
import { Button, TextField, TextArea, NumberField } from '../../components/ui.jsx'
import AccessibleModal from '../AccessibleModal.jsx'
import '../GroupChallenges.css'

function formatChallengeTime(isoString, timeZone) {
  if (!isoString) return ''
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: timeZone || 'UTC',
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(isoString))
  } catch {
    return new Date(isoString).toLocaleString()
  }
}

export default function CoachChallengesView({ embedded = false }) {
  const user = useStore(state => state.user)
  const toast = useUI(state => state.toast)
  const navigate = useNavigate()

  const [challenges, setChallenges] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [statusFilter, setStatusFilter] = useState('all') // all | draft | active | completed | archived
  const [page, setPage] = useState(null)
  const [loadingMore, setLoadingMore] = useState(false)

  // Groups and athletes for creation / points assignment
  const [groups, setGroups] = useState([])
  const [coachAthletes, setCoachAthletes] = useState([])

  // Details & Leaderboard Modal
  const [selectedChallengeId, setSelectedChallengeId] = useState(null)
  const [leaderboardData, setLeaderboardData] = useState(null)
  const [loadingLeaderboard, setLoadingLeaderboard] = useState(false)
  const [leaderboardError, setLeaderboardError] = useState(null)

  // Create Challenge Modal
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState(null)
  const [createForm, setCreateForm] = useState({
    title: '',
    description: '',
    scope: 'group', // 'group' | 'coach_students'
    groupId: '',
    type: 'workouts_count', // 'workouts_count' | 'volume_load' | 'habits_consistency' | 'custom_points'
    pointsPerWorkout: 10,
    pointsPer1000: 5,
    pointsPerCheckin: 5,
    maxPointsPerAdjustment: 50,
    maxAbsoluteScore: 1000,
    startAt: new Date().toISOString().slice(0, 16),
    endAt: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 16),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    status: 'active', // 'draft' | 'active'
  })

  // Award Points Modal
  const [showAwardModal, setShowAwardModal] = useState(false)
  const [awarding, setAwarding] = useState(false)
  const [awardError, setAwardError] = useState(null)
  const [awardForm, setAwardForm] = useState({
    athleteId: '',
    points: 10,
    reason: '',
    correctionOf: '',
  })

  // Lifecycle action state
  const [transitioning, setTransitioning] = useState(false)

  // Load Challenges
  const loadChallenges = useCallback(async (cursor = null) => {
    if (!cursor) setLoading(true)
    else setLoadingMore(true)
    setError(null)

    try {
      const res = await listCoachChallenges({ cursor, limit: 30 })
      if (cursor) {
        setChallenges(prev => [...prev, ...(res.challenges || [])])
      } else {
        setChallenges(res.challenges || [])
      }
      setPage(res.page || null)
    } catch (err) {
      setError(professionalError(err))
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  }, [])

  useEffect(() => {
    loadChallenges()
  }, [loadChallenges])

  // Load Groups and Athletes
  useEffect(() => {
    listCoachGroups().then(res => setGroups(res?.groups || [])).catch(() => {})
    api('/api/coach/athletes').then(res => {
      const links = res?.links || []
      const eligible = links
        .filter(l => l.status === 'active' && (!l.scopes || l.scopes.includes('training')))
        .map(l => ({
          id: l.athleteId || l.athlete?.id,
          name: l.athlete?.name || l.athleteName || p('Athlete'),
        }))
      setCoachAthletes(eligible)
    }).catch(() => {})
  }, [])

  // Load Leaderboard for Selected Challenge
  const openChallengeLeaderboard = async (challengeId) => {
    setSelectedChallengeId(challengeId)
    setLoadingLeaderboard(true)
    setLeaderboardData(null)
    setLeaderboardError(null)

    try {
      const res = await getCoachChallengeLeaderboard(challengeId, { limit: 50, feedlimit: 30 })
      setLeaderboardData(res)
    } catch (err) {
      setLeaderboardError(professionalError(err))
    } finally {
      setLoadingLeaderboard(false)
    }
  }

  // Handle Lifecycle Transitions
  const handleTransition = async (targetStatus, challengeId = null) => {
    const id = challengeId || selectedChallengeId
    if (!id || transitioning) return
    setTransitioning(true)
    try {
      if (targetStatus === 'deleted') {
        await deleteCoachChallenge(id)
        toast(p('Challenge deleted.'))
        setSelectedChallengeId(null)
      } else {
        await updateCoachChallenge(id, { status: targetStatus })
        toast(p(`Challenge status updated to ${targetStatus}.`))
        // Refresh challenge leaderboard details if open
        if (selectedChallengeId === id) {
          const updated = await getCoachChallengeLeaderboard(id, { limit: 50, feedlimit: 30 })
          setLeaderboardData(updated)
        }
      }
      loadChallenges()
    } catch (err) {
      toast(professionalError(err))
    } finally {
      setTransitioning(false)
    }
  }

  // Handle Create Challenge Submit
  const handleCreateSubmit = async (e) => {
    e?.preventDefault?.()
    if (!createForm.title.trim()) {
      setCreateError(p('Enter a challenge title.'))
      return
    }
    if (createForm.scope === 'group' && !createForm.groupId) {
      setCreateError(p('Select a group for this challenge.'))
      return
    }

    setCreating(true)
    setCreateError(null)

    let rules = {}
    if (createForm.type === 'workouts_count') {
      rules = { pointsPerWorkout: Number(createForm.pointsPerWorkout) || 10 }
    } else if (createForm.type === 'volume_load') {
      rules = { pointsPer1000: Number(createForm.pointsPer1000) || 5 }
    } else if (createForm.type === 'habits_consistency') {
      rules = { pointsPerCheckin: Number(createForm.pointsPerCheckin) || 5, habitIds: ['habit_1'] }
    } else if (createForm.type === 'custom_points') {
      rules = {
        maxPointsPerAdjustment: Number(createForm.maxPointsPerAdjustment) || 50,
        maxAbsoluteScore: Number(createForm.maxAbsoluteScore) || 1000,
      }
    }

    try {
      const startIso = new Date(createForm.startAt).toISOString()
      const endIso = new Date(createForm.endAt).toISOString()

      const payload = {
        title: createForm.title.trim(),
        description: createForm.description?.trim() || '',
        scope: createForm.scope,
        groupId: createForm.scope === 'group' ? createForm.groupId : undefined,
        type: createForm.type,
        startAt: startIso,
        endAt: endIso,
        timeZone: createForm.timeZone || 'UTC',
        rules,
        status: createForm.status || 'active',
      }

      const res = await createCoachChallenge(payload)
      toast(p('Challenge created successfully.'))
      setShowCreateModal(false)
      loadChallenges()
      if (res?.challenge?.id) {
        openChallengeLeaderboard(res.challenge.id)
      }
    } catch (err) {
      setCreateError(professionalError(err))
    } finally {
      setCreating(false)
    }
  }

  // Handle Award Custom Points Submit
  const handleAwardSubmit = async (e) => {
    e?.preventDefault?.()
    if (!awardForm.athleteId) {
      setAwardError(p('Select an athlete.'))
      return
    }
    if (!awardForm.reason.trim()) {
      setAwardError(p('Provide a reason or justification.'))
      return
    }
    const points = Number(awardForm.points)
    if (!points || !Number.isInteger(points)) {
      setAwardError(p('Points must be a non-zero integer.'))
      return
    }

    setAwarding(true)
    setAwardError(null)

    try {
      const key = generateIdempotencyKey('pts')
      await awardCustomPoints(
        selectedChallengeId,
        {
          athleteId: awardForm.athleteId,
          points,
          reason: awardForm.reason.trim(),
          correctionOf: awardForm.correctionOf?.trim() || undefined,
        },
        { idempotencyKey: key }
      )

      toast(p('Points awarded successfully.'))
      setShowAwardModal(false)
      setAwardForm({ athleteId: '', points: 10, reason: '', correctionOf: '' })

      // Refresh leaderboard
      const updated = await getCoachChallengeLeaderboard(selectedChallengeId, { limit: 50, feedlimit: 30 })
      setLeaderboardData(updated)
    } catch (err) {
      setAwardError(professionalError(err))
    } finally {
      setAwarding(false)
    }
  }

  // Filtered challenges
  const filteredChallenges = useMemo(() => {
    if (statusFilter === 'all') return challenges
    return challenges.filter(c => c.status === statusFilter)
  }, [challenges, statusFilter])

  const typeName = (type) => {
    switch (type) {
      case 'workouts_count': return p('Workouts count')
      case 'volume_load': return p('Volume load')
      case 'habits_consistency': return p('Habits consistency')
      case 'custom_points': return p('Custom points')
      default: return type
    }
  }

  return (
    <div className={`gc-page ${embedded ? 'embedded' : 'narrow'}`}>
      {!embedded && (
        <div className="pro-nav">
          <button type="button" onClick={() => navigate('/professionals')}>
            <Icon name="chevronLeft" />
            <span>{p('My athletes')}</span>
          </button>
        </div>
      )}

      <header className="pro-hero gc-header">
        <div>
          <span className="pro-kicker">{p('Community')}</span>
          <h1>{p('Group challenges')}</h1>
          <p>{p('Set goals, motivate your community with friendly competition, and track real-time leaderboards.')}</p>
        </div>
        <Icon name="trophy" />
      </header>

      {/* Toolbar & Filters */}
      <div className="gc-toolbar">
        <div className="gc-filter-group" role="tablist">
          {['all', 'draft', 'active', 'completed', 'archived'].map(filter => (
            <button
              key={filter}
              role="tab"
              aria-selected={statusFilter === filter}
              className={`gc-filter-btn ${statusFilter === filter ? 'active' : ''}`}
              onClick={() => setStatusFilter(filter)}
            >
              {filter === 'all' ? p('All') : filter === 'draft' ? p('Draft') : filter === 'active' ? p('Active') : filter === 'completed' ? p('Completed') : p('Archived')}
            </button>
          ))}
        </div>
        <Button
          variant="accent"
          icon="plus"
          onClick={() => {
            setShowCreateModal(true)
            setCreateError(null)
            if (groups.length > 0 && !createForm.groupId) {
              setCreateForm(prev => ({ ...prev, groupId: groups[0].id }))
            }
          }}
        >
          {p('New challenge')}
        </Button>
      </div>

      {error && (
        <div className="card gc-alert error" role="alert">
          <span>{error}</span>
          <Button size="sm" onClick={() => loadChallenges()}>{p('Try again')}</Button>
        </div>
      )}

      {loading ? (
        <div className="gc-card-list">
          <div className="gc-skeleton-card" />
          <div className="gc-skeleton-card" />
        </div>
      ) : filteredChallenges.length === 0 ? (
        <EmptyState
          icon="trophy"
          title={statusFilter === 'all' ? p('No challenges created yet') : p('No challenges with this status')}
          description={p('Create a challenge to boost training volume, consistency, or custom goals.')}
          action={
            <Button variant="accent" onClick={() => setShowCreateModal(true)}>
              {p('Create challenge')}
            </Button>
          }
        />
      ) : (
        <div className="gc-card-list">
          {filteredChallenges.map(challenge => {
            const groupMatch = groups.find(g => g.id === challenge.groupId)
            return (
              <article key={challenge.id} className="gc-card">
                <div className="gc-card-header">
                  <div className="gc-card-title-group">
                    <h3>{challenge.title}</h3>
                    <div className="gc-badge-row">
                      <span className={`gc-badge status-${challenge.status}`}>
                        {challenge.status === 'draft' ? p('Draft') : challenge.status === 'active' ? p('Active') : challenge.status === 'completed' ? p('Completed') : p('Archived')}
                      </span>
                      <span className="gc-badge">{typeName(challenge.type)}</span>
                      <span className="gc-badge">
                        {challenge.scope === 'group' ? (groupMatch?.name ? `${p('Group')}: ${groupMatch.name}` : p('Group scope')) : p('All students')}
                      </span>
                    </div>
                  </div>
                </div>

                {challenge.description && (
                  <p className="pro-routine-note">{challenge.description}</p>
                )}

                <div className="gc-card-subtitle">
                  {formatChallengeTime(challenge.startAt, challenge.timeZone)} — {formatChallengeTime(challenge.endAt, challenge.timeZone)}
                  {' '}({challenge.timeZone || 'UTC'})
                </div>

                <div className="gc-card-actions">
                  <Button size="sm" variant="tinted" icon="chart" onClick={() => openChallengeLeaderboard(challenge.id)}>
                    {p('Leaderboard')} & {p('Activity feed')}
                  </Button>
                  {challenge.status === 'draft' && (
                    <Button
                      size="sm"
                      variant="plain"
                      onClick={() => {
                        setSelectedChallengeId(challenge.id)
                        handleTransition('active', challenge.id)
                      }}
                    >
                      {p('Activate challenge')}
                    </Button>
                  )}
                  {challenge.status === 'active' && (
                    <Button
                      size="sm"
                      variant="plain"
                      onClick={() => {
                        setSelectedChallengeId(challenge.id)
                        handleTransition('completed', challenge.id)
                      }}
                    >
                      {p('End challenge')}
                    </Button>
                  )}
                  {challenge.status === 'completed' && (
                    <Button
                      size="sm"
                      variant="plain"
                      onClick={() => {
                        setSelectedChallengeId(challenge.id)
                        handleTransition('archived', challenge.id)
                      }}
                    >
                      {p('Archive challenge')}
                    </Button>
                  )}
                </div>
              </article>
            )
          })}

          {page?.hasMore && (
            <div className="pro-actions">
              <Button size="sm" disabled={loadingMore} onClick={() => loadChallenges(page.nextCursor)}>
                {loadingMore ? p('Loading…') : p('Load more')}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Leaderboard and Activity Feed Modal */}
      {selectedChallengeId && (
        <AccessibleModal
          id="challenge-details"
          title={leaderboardData?.challenge?.title || p('Challenge details')}
          onClose={() => { setSelectedChallengeId(null); setLeaderboardData(null); }}
        >
          {loadingLeaderboard || !leaderboardData ? (
            <div className="pro-loading">{p('Loading leaderboard & feed…')}</div>
          ) : leaderboardError ? (
            <div className="card gc-alert error" role="alert">
              <span>{leaderboardError}</span>
              <Button size="sm" onClick={() => openChallengeLeaderboard(selectedChallengeId)}>{p('Try again')}</Button>
            </div>
          ) : (
            <div className="pro-modal-form">
              {/* Header Info */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                <div className="gc-badge-row">
                  <span className={`gc-badge status-${leaderboardData.challenge?.status}`}>
                    {leaderboardData.challenge?.status}
                  </span>
                  <span className="gc-badge">{typeName(leaderboardData.challenge?.type)}</span>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {leaderboardData.challenge?.status === 'active' && (
                    <Button size="sm" variant="accent" icon="star" onClick={() => setShowAwardModal(true)}>
                      {p('Award points')}
                    </Button>
                  )}
                  <Button size="sm" icon="arrowPath" onClick={() => openChallengeLeaderboard(selectedChallengeId)}>
                    {p('Refresh') || 'Refresh'}
                  </Button>
                </div>
              </div>

              {/* Status Actions */}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                {leaderboardData.challenge?.status === 'draft' && (
                  <Button size="sm" variant="accent" disabled={transitioning} onClick={() => handleTransition('active')}>
                    {p('Activate challenge')}
                  </Button>
                )}
                {leaderboardData.challenge?.status === 'active' && (
                  <Button size="sm" variant="danger" disabled={transitioning} onClick={() => handleTransition('completed')}>
                    {p('End challenge')}
                  </Button>
                )}
                {leaderboardData.challenge?.status === 'completed' && (
                  <Button size="sm" disabled={transitioning} onClick={() => handleTransition('archived')}>
                    {p('Archive challenge')}
                  </Button>
                )}
                {leaderboardData.challenge?.status === 'draft' && (
                  <Button size="sm" variant="danger" disabled={transitioning} onClick={() => handleTransition('deleted')}>
                    {p('Delete challenge') || 'Delete'}
                  </Button>
                )}
              </div>

              {/* Leaderboard Table */}
              <h3 style={{ margin: '16px 0 6px', fontSize: 'var(--fs-title3)' }}>
                {p('Leaderboard')}
              </h3>

              <div className="gc-leaderboard">
                {(!leaderboardData.leaderboard || leaderboardData.leaderboard.length === 0) ? (
                  <div className="pro-empty-inline">{p('No leaderboard participants yet.')}</div>
                ) : (
                  leaderboardData.leaderboard.map(item => (
                    <div key={item.participantKey || item.athleteId} className="gc-leaderboard-row">
                      <div className={`gc-rank-col ${item.rank <= 3 ? `gc-rank-${item.rank}` : ''}`}>
                        {item.rank === 1 ? '🥇' : item.rank === 2 ? '🥈' : item.rank === 3 ? '🥉' : `#${item.rank}`}
                      </div>
                      <div className="gc-participant-info">
                        <div className="gc-participant-name">
                          {item.displayName || p('Athlete')}
                        </div>
                        <div className="gc-participant-stats">
                          {item.workoutsCount !== undefined && `${item.workoutsCount} ${p('workouts')} · `}
                          {item.volumeLoad !== undefined && `${item.volumeLoad} kg · `}
                          {item.habitCheckinsCount !== undefined && `${item.habitCheckinsCount} ${p('habits')}`}
                        </div>
                      </div>
                      <div className="gc-score-col">
                        <span className="gc-score-value">{item.score}</span>
                        <div className="gc-score-unit">{p('pts')}</div>
                      </div>
                    </div>
                  ))
                )}
              </div>

              {/* Activity Feed */}
              <h3 style={{ margin: '20px 0 6px', fontSize: 'var(--fs-title3)' }}>
                {p('Activity feed')}
              </h3>

              <div className="gc-feed-list">
                {(!leaderboardData.activityFeed || leaderboardData.activityFeed.length === 0) ? (
                  <div className="pro-empty-inline">{p('No activity events logged yet.')}</div>
                ) : (
                  leaderboardData.activityFeed.map(feed => (
                    <div key={feed.id} className="gc-feed-item">
                      <Icon name="bolt" className="gc-feed-icon" />
                      <div className="gc-feed-content">
                        <div className="gc-feed-desc">
                          <strong>{feed.displayName || p('Athlete')}</strong> — {feed.description || p('Activity')}
                        </div>
                        <div className="gc-feed-meta">
                          {formatChallengeTime(feed.timestamp, leaderboardData.challenge?.timeZone)}
                        </div>
                      </div>
                      {feed.pointsAwarded !== undefined && (
                        <span className="gc-feed-points">
                          {feed.pointsAwarded >= 0 ? `+${feed.pointsAwarded}` : feed.pointsAwarded} pts
                        </span>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </AccessibleModal>
      )}

      {/* Create Challenge Modal */}
      {showCreateModal && (
        <AccessibleModal
          id="create-challenge"
          title={p('New challenge')}
          onClose={() => setShowCreateModal(false)}
        >
          <form onSubmit={handleCreateSubmit} className="pro-modal-form">
            {createError && (
              <div className="gc-alert error" role="alert">
                <span>{createError}</span>
              </div>
            )}

            <label className="pro-field">
              <span>{p('Challenge title')} *</span>
              <TextField
                name="title"
                value={createForm.title}
                maxLength={120}
                placeholder={p('Example: November Volume Clash')}
                onChange={e => setCreateForm(prev => ({ ...prev, title: e.target.value }))}
              />
            </label>

            <label className="pro-field">
              <span>{p('Description')}</span>
              <TextArea
                name="description"
                rows={2}
                value={createForm.description}
                maxLength={500}
                placeholder={p('Describe challenge rules, milestones, or prizes…')}
                onChange={e => setCreateForm(prev => ({ ...prev, description: e.target.value }))}
              />
            </label>

            <label className="pro-field">
              <span>{p('Scope')}</span>
              <select
                name="scope"
                value={createForm.scope}
                onChange={e => setCreateForm(prev => ({ ...prev, scope: e.target.value }))}
                style={{ width: '100%', minHeight: 44, padding: '0 10px', borderRadius: 'var(--r-xs)', border: '1px solid var(--separator)' }}
              >
                <option value="group">{p('Specific Group') || 'Specific Group'}</option>
                <option value="coach_students">{p('All Students with Training Scope') || 'All Students with Training Scope'}</option>
              </select>
            </label>

            {createForm.scope === 'group' && (
              <label className="pro-field">
                <span>{p('Select group')} *</span>
                <select
                  name="groupId"
                  value={createForm.groupId}
                  onChange={e => setCreateForm(prev => ({ ...prev, groupId: e.target.value }))}
                  style={{ width: '100%', minHeight: 44, padding: '0 10px', borderRadius: 'var(--r-xs)', border: '1px solid var(--separator)' }}
                >
                  <option value="">{p('Choose a group…') || 'Choose a group…'}</option>
                  {groups.map(g => (
                    <option key={g.id} value={g.id}>{g.name}</option>
                  ))}
                </select>
              </label>
            )}

            <label className="pro-field">
              <span>{p('Metric Type')}</span>
              <select
                name="type"
                value={createForm.type}
                onChange={e => setCreateForm(prev => ({ ...prev, type: e.target.value }))}
                style={{ width: '100%', minHeight: 44, padding: '0 10px', borderRadius: 'var(--r-xs)', border: '1px solid var(--separator)' }}
              >
                <option value="workouts_count">{p('Workouts count')}</option>
                <option value="volume_load">{p('Volume load')}</option>
                <option value="habits_consistency">{p('Habits consistency')}</option>
                <option value="custom_points">{p('Custom points')}</option>
              </select>
            </label>

            {/* Metric Rules Configuration */}
            {createForm.type === 'workouts_count' && (
              <label className="pro-field">
                <span>{p('Points per workout')}</span>
                <NumberField
                  decimal={false}
                  value={createForm.pointsPerWorkout}
                  onChange={val => setCreateForm(prev => ({ ...prev, pointsPerWorkout: val }))}
                />
              </label>
            )}

            {createForm.type === 'volume_load' && (
              <label className="pro-field">
                <span>{p('Points per 1,000 kg volume')}</span>
                <NumberField
                  decimal={false}
                  value={createForm.pointsPer1000}
                  onChange={val => setCreateForm(prev => ({ ...prev, pointsPer1000: val }))}
                />
              </label>
            )}

            {createForm.type === 'habits_consistency' && (
              <label className="pro-field">
                <span>{p('Points per habit check-in')}</span>
                <NumberField
                  decimal={false}
                  value={createForm.pointsPerCheckin}
                  onChange={val => setCreateForm(prev => ({ ...prev, pointsPerCheckin: val }))}
                />
              </label>
            )}

            {createForm.type === 'custom_points' && (
              <>
                <label className="pro-field">
                  <span>{p('Max points per adjustment')}</span>
                  <NumberField
                    decimal={false}
                    value={createForm.maxPointsPerAdjustment}
                    onChange={val => setCreateForm(prev => ({ ...prev, maxPointsPerAdjustment: val }))}
                  />
                </label>
                <label className="pro-field">
                  <span>{p('Max absolute score')}</span>
                  <NumberField
                    decimal={false}
                    value={createForm.maxAbsoluteScore}
                    onChange={val => setCreateForm(prev => ({ ...prev, maxAbsoluteScore: val }))}
                  />
                </label>
              </>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <label className="pro-field">
                <span>{p('Start date')} *</span>
                <input
                  type="datetime-local"
                  name="startAt"
                  value={createForm.startAt}
                  onChange={e => setCreateForm(prev => ({ ...prev, startAt: e.target.value }))}
                  style={{ width: '100%', minHeight: 44, padding: '0 10px', borderRadius: 'var(--r-xs)', border: '1px solid var(--separator)' }}
                />
              </label>
              <label className="pro-field">
                <span>{p('End date')} *</span>
                <input
                  type="datetime-local"
                  name="endAt"
                  value={createForm.endAt}
                  onChange={e => setCreateForm(prev => ({ ...prev, endAt: e.target.value }))}
                  style={{ width: '100%', minHeight: 44, padding: '0 10px', borderRadius: 'var(--r-xs)', border: '1px solid var(--separator)' }}
                />
              </label>
            </div>

            <label className="pro-field">
              <span>{p('Timezone')}</span>
              <TextField
                name="timeZone"
                value={createForm.timeZone}
                onChange={e => setCreateForm(prev => ({ ...prev, timeZone: e.target.value }))}
              />
            </label>

            <div className="pro-actions" style={{ marginTop: 16 }}>
              <Button type="button" onClick={() => setShowCreateModal(false)}>
                {p('Cancel')}
              </Button>
              <Button type="submit" variant="accent" disabled={creating || !createForm.title.trim()}>
                {creating ? p('Creating…') : p('Create challenge')}
              </Button>
            </div>
          </form>
        </AccessibleModal>
      )}

      {/* Award Custom Points Modal */}
      {showAwardModal && (
        <AccessibleModal
          id="award-points"
          title={p('Award points')}
          onClose={() => setShowAwardModal(false)}
        >
          <form onSubmit={handleAwardSubmit} className="pro-modal-form">
            {awardError && (
              <div className="gc-alert error" role="alert">
                <span>{awardError}</span>
              </div>
            )}

            <label className="pro-field">
              <span>{p('Select athlete')} *</span>
              <select
                name="athleteId"
                value={awardForm.athleteId}
                onChange={e => setAwardForm(prev => ({ ...prev, athleteId: e.target.value }))}
                style={{ width: '100%', minHeight: 44, padding: '0 10px', borderRadius: 'var(--r-xs)', border: '1px solid var(--separator)' }}
              >
                <option value="">{p('Choose an athlete…') || 'Choose an athlete…'}</option>
                {coachAthletes.map(ath => (
                  <option key={ath.id} value={ath.id}>{ath.name}</option>
                ))}
              </select>
            </label>

            <label className="pro-field">
              <span>{p('Points delta')} (+ or -) *</span>
              <NumberField
                decimal={false}
                value={awardForm.points}
                onChange={val => setAwardForm(prev => ({ ...prev, points: val }))}
              />
            </label>

            <label className="pro-field">
              <span>{p('Justification')} *</span>
              <TextArea
                name="reason"
                rows={2}
                maxLength={500}
                value={awardForm.reason}
                placeholder={p('Reason for manual points adjustment…')}
                onChange={e => setAwardForm(prev => ({ ...prev, reason: e.target.value }))}
              />
            </label>

            <label className="pro-field">
              <span>{p('Correction of (Optional adjustment ID)') || 'Correction of'}</span>
              <TextField
                name="correctionOf"
                value={awardForm.correctionOf}
                placeholder="caft_..."
                onChange={e => setAwardForm(prev => ({ ...prev, correctionOf: e.target.value }))}
              />
            </label>

            <div className="pro-actions" style={{ marginTop: 16 }}>
              <Button type="button" onClick={() => setShowAwardModal(false)}>
                {p('Cancel')}
              </Button>
              <Button type="submit" variant="accent" disabled={awarding || !awardForm.athleteId || !awardForm.reason.trim()}>
                {awarding ? p('Submitting…') : p('Award points')}
              </Button>
            </div>
          </form>
        </AccessibleModal>
      )}
    </div>
  )
}
