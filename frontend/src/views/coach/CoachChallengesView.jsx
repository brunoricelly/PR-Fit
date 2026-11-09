import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useUI } from '../../store/useUI.js'
import { api } from '../../lib/api.js'
import { professionalError, professionalText as p } from '../../lib/professional-copy.js'
import {
  listCoachChallenges,
  createCoachChallenge,
  updateCoachChallenge,
  deleteCoachChallenge,
  getCoachChallengeLeaderboard,
  awardCustomPoints,
  listCoachGroups,
  generateIdempotencyKey,
} from '../../lib/group-challenges-api.js'
import Icon from '../../components/Icon.jsx'
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Modal,
  NumberInput,
  PageHeader,
  Select,
  SkeletonCard,
  Surface,
  Textarea,
} from '../../components/design-system.jsx'
import '../GroupChallenges.css'
import './CoachGroupsView.css'

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

function formatParticipantStats(item, challengeType) {
  if (challengeType === 'workouts_count') {
    return `${item.workoutsCount ?? 0} ${p('workouts')}`
  }
  if (challengeType === 'volume_load') {
    return `${item.volumeLoad ?? 0} kg`
  }
  if (challengeType === 'habits_consistency') {
    return `${item.habitCheckinsCount ?? 0} ${p('habits')}`
  }
  if (challengeType === 'custom_points') {
    return item.lastActivityAt ? formatChallengeTime(item.lastActivityAt) : p('No recent activity')
  }
  const parts = []
  if (item.workoutsCount) parts.push(`${item.workoutsCount} ${p('workouts')}`)
  if (item.volumeLoad) parts.push(`${item.volumeLoad} kg`)
  if (item.habitCheckinsCount) parts.push(`${item.habitCheckinsCount} ${p('habits')}`)
  return parts.length > 0 ? parts.join(' · ') : p('No recent activity')
}

export default function CoachChallengesView({ embedded = false }) {
  const toast = useUI(state => state.toast)
  const navigate = useNavigate()
  const location = useLocation()

  const queryGroupId = useMemo(() => {
    return new URLSearchParams(location.search).get('groupId') || ''
  }, [location.search])

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
    scope: queryGroupId ? 'group' : 'group',
    groupId: queryGroupId || '',
    type: 'workouts_count',
    pointsPerWorkout: 10,
    pointsPer1000: 5,
    pointsPerCheckin: 5,
    maxPointsPerAdjustment: 50,
    maxAbsoluteScore: 1000,
    startAt: new Date().toISOString().slice(0, 16),
    endAt: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 16),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    status: 'active',
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
    listCoachGroups().then(res => {
      const loaded = res?.groups || []
      setGroups(loaded)
      if (queryGroupId && loaded.some(g => g.id === queryGroupId)) {
        setCreateForm(prev => ({ ...prev, groupId: queryGroupId, scope: 'group' }))
      }
    }).catch(() => {})

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
  }, [queryGroupId])

  // Load Leaderboard for Selected Challenge
  const openChallengeLeaderboard = async challengeId => {
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
        toast(p(`Challenge status updated to ${targetStatus}.`) || `Status atualizado para ${targetStatus}.`)
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
  const handleCreateSubmit = async e => {
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
  const handleAwardSubmit = async e => {
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

  const typeName = type => {
    switch (type) {
      case 'workouts_count': return p('Workouts count')
      case 'volume_load': return p('Volume load')
      case 'habits_consistency': return p('Habits consistency')
      case 'custom_points': return p('Custom points')
      default: return type
    }
  }

  const Container = embedded ? 'div' : 'main'

  return (
    <Container className={`gc-page ds-scope ${embedded ? 'embedded' : 'narrow'}`}>
      {!embedded && (
        <div className="pro-nav">
          <button type="button" onClick={() => navigate('/community')}>
            <Icon name="chevronLeft" />
            <span>{p('Community')}</span>
          </button>
        </div>
      )}

      <PageHeader
        className="gc-header"
        eyebrow={p('Community')}
        title={p('Group challenges')}
        description={p('Set goals, motivate your community with friendly competition, and track real-time leaderboards.')}
      />

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
              {filter === 'all'
                ? p('All')
                : filter === 'draft'
                  ? p('Draft')
                  : filter === 'active'
                    ? p('Active')
                    : filter === 'completed'
                      ? p('Completed')
                      : p('Archived')}
            </button>
          ))}
        </div>
        <Button
          variant="primary"
          icon="plus"
          onClick={() => {
            setShowCreateModal(true)
            setCreateError(null)
            if (groups.length > 0 && !createForm.groupId) {
              setCreateForm(prev => ({
                ...prev,
                groupId: queryGroupId || groups[0].id,
              }))
            }
          }}
        >
          {p('New challenge')}
        </Button>
      </div>

      {error ? (
        <ErrorState
          title={p('Unable to load groups')}
          text={error}
          action={<Button variant="primary" onClick={() => loadChallenges()}>{p('Try again')}</Button>}
        />
      ) : loading ? (
        <div className="gc-card-list" aria-label={p('Loading groups…')}>
          <SkeletonCard />
          <SkeletonCard />
        </div>
      ) : filteredChallenges.length === 0 ? (
        <EmptyState
          icon="trophy"
          title={statusFilter === 'all' ? p('No challenges created yet') : p('No challenges with this status')}
          text={p('Create a challenge to boost training volume, consistency, or custom goals.')}
          action={
            <Button
              variant="primary"
              onClick={() => {
                setShowCreateModal(true)
                if (groups.length > 0 && !createForm.groupId) {
                  setCreateForm(prev => ({
                    ...prev,
                    groupId: queryGroupId || groups[0].id,
                  }))
                }
              }}
            >
              {p('Create challenge')}
            </Button>
          }
        />
      ) : (
        <div className="gc-card-list">
          {filteredChallenges.map(challenge => {
            const groupMatch = groups.find(g => g.id === challenge.groupId)
            return (
              <Card key={challenge.id} className="gc-card">
                <div className="gc-card-header">
                  <div className="gc-card-title-group">
                    <h3>{challenge.title}</h3>
                    <div className="gc-badge-row">
                      <Badge
                        tone={
                          challenge.status === 'active'
                            ? 'success'
                            : challenge.status === 'completed'
                              ? 'brand'
                              : challenge.status === 'draft'
                                ? 'warning'
                                : 'neutral'
                        }
                      >
                        {challenge.status === 'draft'
                          ? p('Draft')
                          : challenge.status === 'active'
                            ? p('Active')
                            : challenge.status === 'completed'
                              ? p('Completed')
                              : p('Archived')}
                      </Badge>
                      <Badge>{typeName(challenge.type)}</Badge>
                      <Badge>
                        {challenge.scope === 'group'
                          ? groupMatch?.name
                            ? `${p('Group')}: ${groupMatch.name}`
                            : p('Group scope')
                          : p('All students')}
                      </Badge>
                    </div>
                  </div>
                </div>

                {challenge.description && (
                  <p className="pro-routine-note">{challenge.description}</p>
                )}

                <div className="gc-card-subtitle">
                  {formatChallengeTime(challenge.startAt, challenge.timeZone)} —{' '}
                  {formatChallengeTime(challenge.endAt, challenge.timeZone)} ({challenge.timeZone || 'UTC'})
                </div>

                <div className="gc-card-actions">
                  <Button size="sm" icon="chart" onClick={() => openChallengeLeaderboard(challenge.id)}>
                    {p('Leaderboard')}
                  </Button>
                  {challenge.status === 'draft' && (
                    <Button
                      size="sm"
                      variant="primary"
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
                      variant="destructive"
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
                      onClick={() => {
                        setSelectedChallengeId(challenge.id)
                        handleTransition('archived', challenge.id)
                      }}
                    >
                      {p('Archive challenge')}
                    </Button>
                  )}
                </div>
              </Card>
            )
          })}

          {page?.hasMore && (
            <div className="pro-actions">
              <Button size="sm" loading={loadingMore} loadingLabel={p('Loading…')} onClick={() => loadChallenges(page.nextCursor)}>
                {p('Load more')}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Leaderboard and Activity Feed Modal */}
      {selectedChallengeId && (
        <Modal
          id="challenge-details"
          title={leaderboardData?.challenge?.title || p('Challenge details')}
          closeLabel={p('Close')}
          onClose={() => {
            setSelectedChallengeId(null)
            setLeaderboardData(null)
          }}
        >
          {loadingLeaderboard || !leaderboardData ? (
            <div className="pro-loading" role="status" aria-label={p('Loading leaderboard & feed…')}>
              {p('Loading leaderboard & feed…')}
            </div>
          ) : leaderboardError ? (
            <Alert tone="error">
              <span>{leaderboardError}</span>
              <Button size="sm" onClick={() => openChallengeLeaderboard(selectedChallengeId)}>
                {p('Try again')}
              </Button>
            </Alert>
          ) : (
            <div className="pro-modal-form">
              {/* Header Info */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                <div className="gc-badge-row">
                  <Badge
                    tone={
                      leaderboardData.challenge?.status === 'active'
                        ? 'success'
                        : leaderboardData.challenge?.status === 'completed'
                          ? 'brand'
                          : 'neutral'
                    }
                  >
                    {leaderboardData.challenge?.status}
                  </Badge>
                  <Badge>{typeName(leaderboardData.challenge?.type)}</Badge>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  {leaderboardData.challenge?.status === 'active' && (
                    <Button size="sm" variant="primary" icon="star" onClick={() => setShowAwardModal(true)}>
                      {p('Award points')}
                    </Button>
                  )}
                  <Button size="sm" icon="arrowPath" onClick={() => openChallengeLeaderboard(selectedChallengeId)}>
                    {p('Refresh')}
                  </Button>
                </div>
              </div>

              {/* Status Actions */}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                {leaderboardData.challenge?.status === 'draft' && (
                  <Button size="sm" variant="primary" loading={transitioning} onClick={() => handleTransition('active')}>
                    {p('Activate challenge')}
                  </Button>
                )}
                {leaderboardData.challenge?.status === 'active' && (
                  <Button size="sm" variant="destructive" loading={transitioning} onClick={() => handleTransition('completed')}>
                    {p('End challenge')}
                  </Button>
                )}
                {leaderboardData.challenge?.status === 'completed' && (
                  <Button size="sm" loading={transitioning} onClick={() => handleTransition('archived')}>
                    {p('Archive challenge')}
                  </Button>
                )}
                {leaderboardData.challenge?.status === 'draft' && (
                  <Button size="sm" variant="destructive" loading={transitioning} onClick={() => handleTransition('deleted')}>
                    {p('Delete challenge')}
                  </Button>
                )}
              </div>

              {/* Leaderboard Table (Semantic HTML with ARIA) */}
              <h3 style={{ margin: '16px 0 6px', fontSize: 'var(--fs-title3)' }}>
                {p('Leaderboard')}
              </h3>

              {(!leaderboardData.leaderboard || leaderboardData.leaderboard.length === 0) ? (
                <div className="pro-empty-inline">{p('No leaderboard participants yet.')}</div>
              ) : (
                <div className="gc-leaderboard-table-wrapper">
                  <table className="gc-leaderboard-table" aria-label={p('Leaderboard')}>
                    <thead>
                      <tr>
                        <th scope="col" style={{ width: 60 }}>{p('Rank')}</th>
                        <th scope="col">{p('Participant')}</th>
                        <th scope="col">{p('Activity')}</th>
                        <th scope="col" style={{ textAlign: 'right' }}>{p('Score')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {leaderboardData.leaderboard.map(item => (
                        <tr key={item.participantKey || item.athleteId} className="gc-leaderboard-row">
                          <td>
                            <span
                              className={`gc-rank-col ${item.rank <= 3 ? `gc-rank-${item.rank}` : ''}`}
                              aria-label={`${item.rank}º`}
                            >
                              {item.rank === 1 ? '🥇' : item.rank === 2 ? '🥈' : item.rank === 3 ? '🥉' : `#${item.rank}`}
                            </span>
                          </td>
                          <td>
                            <div className="gc-participant-name">
                              {item.displayName || p('Athlete')}
                            </div>
                          </td>
                          <td>
                            <div className="gc-participant-stats">
                              {formatParticipantStats(item, leaderboardData.challenge?.type)}
                            </div>
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            <span className="gc-score-value">{item.score}</span>{' '}
                            <span className="gc-score-unit">{p('pts')}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Activity Feed */}
              <h3 style={{ margin: '20px 0 6px', fontSize: 'var(--fs-title3)' }}>
                {p('Activity feed')}
              </h3>

              <div className="gc-feed-list">
                {(!leaderboardData.activityFeed || leaderboardData.activityFeed.length === 0) ? (
                  <div className="pro-empty-inline">{p('No activity events logged yet.')}</div>
                ) : (
                  leaderboardData.activityFeed.map(feed => (
                    <Surface key={feed.id} className="gc-feed-item">
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
                    </Surface>
                  ))
                )}
              </div>
            </div>
          )}
        </Modal>
      )}

      {/* Create Challenge Modal */}
      {showCreateModal && (
        <Modal
          id="create-challenge"
          title={p('New challenge')}
          closeLabel={p('Close')}
          onClose={() => setShowCreateModal(false)}
        >
          <form onSubmit={handleCreateSubmit} className="pro-modal-form">
            {createError && <Alert tone="error">{createError}</Alert>}

            <Field label={p('Challenge title')} required>
              <Input
                name="title"
                value={createForm.title}
                maxLength={120}
                placeholder={p('Example: November Volume Clash')}
                onChange={e => setCreateForm(prev => ({ ...prev, title: e.target.value }))}
                autoFocus
              />
            </Field>

            <Field label={p('Description')} help={p('Describe challenge rules, milestones, or prizes…')}>
              <Textarea
                name="description"
                rows={2}
                maxLength={1000}
                value={createForm.description}
                placeholder={p('Describe challenge rules, milestones, or prizes…')}
                onChange={e => setCreateForm(prev => ({ ...prev, description: e.target.value }))}
              />
            </Field>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <Field label={p('Scope')} required>
                <Select
                  name="scope"
                  value={createForm.scope}
                  onChange={e => setCreateForm(prev => ({ ...prev, scope: e.target.value }))}
                  style={{ width: '100%', minHeight: 44 }}
                >
                  <option value="group">{p('Specific Group')}</option>
                  <option value="coach_students">{p('All Students with Training Scope')}</option>
                </Select>
              </Field>

              {createForm.scope === 'group' && (
                <Field label={p('Select group')} required>
                  <Select
                    name="groupId"
                    value={createForm.groupId}
                    onChange={e => setCreateForm(prev => ({ ...prev, groupId: e.target.value }))}
                    style={{ width: '100%', minHeight: 44 }}
                  >
                    <option value="">{p('Choose a group…')}</option>
                    {groups.map(g => (
                      <option key={g.id} value={g.id}>{g.name}</option>
                    ))}
                  </Select>
                </Field>
              )}
            </div>

            <Field label={p('Metric Type')} required>
              <Select
                name="type"
                value={createForm.type}
                onChange={e => setCreateForm(prev => ({ ...prev, type: e.target.value }))}
                style={{ width: '100%', minHeight: 44 }}
              >
                <option value="workouts_count">{p('Workouts count')}</option>
                <option value="volume_load">{p('Volume load')}</option>
                <option value="habits_consistency">{p('Habits consistency')}</option>
                <option value="custom_points">{p('Custom points')}</option>
              </Select>
            </Field>

            {/* Dynamic Rule Fields */}
            {createForm.type === 'workouts_count' && (
              <Field label={p('Points per workout')} required>
                <NumberInput
                  name="pointsPerWorkout"
                  value={createForm.pointsPerWorkout}
                  onChange={val => setCreateForm(prev => ({ ...prev, pointsPerWorkout: val }))}
                />
              </Field>
            )}

            {createForm.type === 'volume_load' && (
              <Field label={p('Points per 1,000 kg volume')} required>
                <NumberInput
                  name="pointsPer1000"
                  value={createForm.pointsPer1000}
                  onChange={val => setCreateForm(prev => ({ ...prev, pointsPer1000: val }))}
                />
              </Field>
            )}

            {createForm.type === 'habits_consistency' && (
              <Field label={p('Points per habit check-in')} required>
                <NumberInput
                  name="pointsPerCheckin"
                  value={createForm.pointsPerCheckin}
                  onChange={val => setCreateForm(prev => ({ ...prev, pointsPerCheckin: val }))}
                />
              </Field>
            )}

            {createForm.type === 'custom_points' && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <Field label={p('Max points per adjustment')}>
                  <NumberInput
                    name="maxPointsPerAdjustment"
                    value={createForm.maxPointsPerAdjustment}
                    onChange={val => setCreateForm(prev => ({ ...prev, maxPointsPerAdjustment: val }))}
                  />
                </Field>
                <Field label={p('Max absolute score')}>
                  <NumberInput
                    name="maxAbsoluteScore"
                    value={createForm.maxAbsoluteScore}
                    onChange={val => setCreateForm(prev => ({ ...prev, maxAbsoluteScore: val }))}
                  />
                </Field>
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <Field label={p('Start date')} required>
                <Input
                  type="datetime-local"
                  name="startAt"
                  value={createForm.startAt}
                  onChange={e => setCreateForm(prev => ({ ...prev, startAt: e.target.value }))}
                />
              </Field>
              <Field label={p('End date')} required>
                <Input
                  type="datetime-local"
                  name="endAt"
                  value={createForm.endAt}
                  onChange={e => setCreateForm(prev => ({ ...prev, endAt: e.target.value }))}
                />
              </Field>
            </div>

            <Field label={p('Timezone')}>
              <Input
                name="timeZone"
                value={createForm.timeZone}
                onChange={e => setCreateForm(prev => ({ ...prev, timeZone: e.target.value }))}
              />
            </Field>

            <div className="pro-actions" style={{ marginTop: 16 }}>
              <Button type="button" onClick={() => setShowCreateModal(false)}>
                {p('Cancel')}
              </Button>
              <Button type="submit" variant="primary" loading={creating} loadingLabel={p('Creating…')} disabled={creating || !createForm.title.trim()}>
                {p('Create challenge')}
              </Button>
            </div>
          </form>
        </Modal>
      )}

      {/* Award Custom Points Modal */}
      {showAwardModal && (
        <Modal
          id="award-points"
          title={p('Award points')}
          closeLabel={p('Close')}
          onClose={() => setShowAwardModal(false)}
        >
          <form onSubmit={handleAwardSubmit} className="pro-modal-form">
            {awardError && <Alert tone="error">{awardError}</Alert>}

            <Field label={p('Select athlete')} required>
              <Select
                name="athleteId"
                value={awardForm.athleteId}
                onChange={e => setAwardForm(prev => ({ ...prev, athleteId: e.target.value }))}
                style={{ width: '100%', minHeight: 44 }}
              >
                <option value="">{p('Choose an athlete…')}</option>
                {coachAthletes.map(ath => (
                  <option key={ath.id} value={ath.id}>{ath.name}</option>
                ))}
              </Select>
            </Field>

            <Field label={p('Points delta')} required>
              <NumberInput
                name="points"
                decimal={false}
                value={awardForm.points}
                onChange={val => setAwardForm(prev => ({ ...prev, points: val }))}
              />
            </Field>

            <Field label={p('Justification')} required>
              <Textarea
                name="reason"
                rows={2}
                maxLength={500}
                value={awardForm.reason}
                placeholder={p('Reason for manual points adjustment…')}
                onChange={e => setAwardForm(prev => ({ ...prev, reason: e.target.value }))}
              />
            </Field>

            <Field label={p('Correction of (Optional adjustment ID)')}>
              <Input
                name="correctionOf"
                value={awardForm.correctionOf}
                placeholder="caft_..."
                onChange={e => setAwardForm(prev => ({ ...prev, correctionOf: e.target.value }))}
              />
            </Field>

            <div className="pro-actions" style={{ marginTop: 16 }}>
              <Button type="button" onClick={() => setShowAwardModal(false)}>
                {p('Cancel')}
              </Button>
              <Button
                type="submit"
                variant="primary"
                loading={awarding}
                loadingLabel={p('Submitting…')}
                disabled={awarding || !awardForm.athleteId || !awardForm.reason.trim()}
              >
                {p('Award points')}
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </Container>
  )
}
