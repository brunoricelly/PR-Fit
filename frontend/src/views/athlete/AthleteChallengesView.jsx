import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../../store/useStore.js'
import { professionalError, professionalText as p } from '../../lib/professional-copy.js'
import {
  listAthleteChallenges,
  getAthleteChallengeLeaderboard,
} from '../../lib/group-challenges-api.js'
import Icon from '../../components/Icon.jsx'
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Modal,
  PageHeader,
  SkeletonCard,
  Surface,
} from '../../components/design-system.jsx'
import '../GroupChallenges.css'
import '../coach/CoachGroupsView.css'

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

export default function AthleteChallengesView({ embedded = false }) {
  const user = useStore(state => state.user)
  const navigate = useNavigate()

  const [challenges, setChallenges] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [statusFilter, setStatusFilter] = useState('active') // active | completed
  const [page, setPage] = useState(null)
  const [loadingMore, setLoadingMore] = useState(false)

  // Details & Leaderboard Modal
  const [selectedChallengeId, setSelectedChallengeId] = useState(null)
  const [leaderboardData, setLeaderboardData] = useState(null)
  const [loadingLeaderboard, setLoadingLeaderboard] = useState(false)
  const [leaderboardError, setLeaderboardError] = useState(null)

  // Load challenges
  const loadChallenges = useCallback(async (cursor = null) => {
    if (!cursor) setLoading(true)
    else setLoadingMore(true)
    setError(null)

    try {
      const res = await listAthleteChallenges({ cursor, limit: 30 })
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

  // Open Leaderboard & Feed modal
  const openLeaderboard = async challengeId => {
    setSelectedChallengeId(challengeId)
    setLoadingLeaderboard(true)
    setLeaderboardData(null)
    setLeaderboardError(null)

    try {
      const res = await getAthleteChallengeLeaderboard(challengeId, { limit: 50, feedlimit: 30 })
      setLeaderboardData(res)
    } catch (err) {
      setLeaderboardError(professionalError(err))
    } finally {
      setLoadingLeaderboard(false)
    }
  }

  // Filtered challenges by status
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
        description={p('Push your limits alongside your teammates, climb the leaderboard, and celebrate achievements.')}
      />

      {/* Toolbar / Filters */}
      <div className="gc-toolbar">
        <div className="gc-filter-group" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={statusFilter === 'active'}
            className={`gc-filter-btn ${statusFilter === 'active' ? 'active' : ''}`}
            onClick={() => setStatusFilter('active')}
          >
            {p('Active')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={statusFilter === 'completed'}
            className={`gc-filter-btn ${statusFilter === 'completed' ? 'active' : ''}`}
            onClick={() => setStatusFilter('completed')}
          >
            {p('Completed')}
          </button>
        </div>
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
          title={statusFilter === 'active' ? p('No active challenges') : p('No completed challenges')}
          text={p('Challenges created by your coaches will appear here when active.')}
        />
      ) : (
        <div className="gc-card-list">
          {filteredChallenges.map(challenge => (
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
                            : 'neutral'
                      }
                    >
                      {challenge.status === 'active' ? p('Active') : p('Completed')}
                    </Badge>
                    <Badge>{typeName(challenge.type)}</Badge>
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
                <Button size="sm" icon="chart" onClick={() => openLeaderboard(challenge.id)}>
                  {p('Leaderboard')} & {p('Activity feed')}
                </Button>
              </div>
            </Card>
          ))}

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
          id="athlete-challenge-details"
          title={leaderboardData?.challenge?.title || p('Challenge details')}
          closeLabel={p('Close')}
          onClose={() => {
            setSelectedChallengeId(null)
            setLeaderboardData(null)
          }}
        >
          {loadingLeaderboard || !leaderboardData ? (
            <div className="pro-loading" role="status" aria-label={p('Loading leaderboard…')}>
              {p('Loading leaderboard…')}
            </div>
          ) : leaderboardError ? (
            <Alert tone="error">
              <span>{leaderboardError}</span>
              <Button size="sm" onClick={() => openLeaderboard(selectedChallengeId)}>
                {p('Try again')}
              </Button>
            </Alert>
          ) : (
            <div className="pro-modal-form">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div className="gc-badge-row">
                  <Badge tone={leaderboardData.challenge?.status === 'active' ? 'success' : 'brand'}>
                    {leaderboardData.challenge?.status}
                  </Badge>
                  <Badge>{typeName(leaderboardData.challenge?.type)}</Badge>
                </div>
                <Button size="sm" icon="arrowPath" onClick={() => openLeaderboard(selectedChallengeId)}>
                  {p('Refresh')}
                </Button>
              </div>

              {/* Leaderboard Table with Current Athlete Highlight */}
              <h3 style={{ margin: '14px 0 6px', fontSize: 'var(--fs-title3)' }}>
                {p('Leaderboard')}
              </h3>

              {(!leaderboardData.leaderboard || leaderboardData.leaderboard.length === 0) ? (
                <div className="pro-empty-inline">{p('No ranking data available yet.')}</div>
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
                      {leaderboardData.leaderboard.map(item => {
                        const isMe = Boolean(item.isMe)
                        return (
                          <tr
                            key={item.participantKey || item.rank}
                            className={`gc-leaderboard-row ${isMe ? 'athlete-me-row' : ''}`}
                            aria-current={isMe ? 'true' : undefined}
                          >
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
                                {isMe && <Badge tone="brand" style={{ marginLeft: 6 }}>{p('You')}</Badge>}
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
                        )
                      })}
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
    </Container>
  )
}
