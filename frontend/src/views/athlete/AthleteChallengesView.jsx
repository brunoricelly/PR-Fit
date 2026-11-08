import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../../store/useStore.js'
import { useUI } from '../../store/useUI.js'
import { professionalError, professionalText as p } from '../../lib/professional-copy.js'
import {
  listAthleteChallenges,
  getAthleteChallengeLeaderboard,
} from '../../lib/group-challenges-api.js'
import Icon from '../../components/Icon.jsx'
import EmptyState from '../../components/EmptyState.jsx'
import { Button } from '../../components/ui.jsx'
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

export default function AthleteChallengesView({ embedded = false }) {
  const user = useStore(state => state.user)
  const toast = useUI(state => state.toast)
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
  const openLeaderboard = async (challengeId) => {
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
          <button type="button" onClick={() => navigate('/settings')}>
            <Icon name="chevronLeft" />
            <span>{p('Settings')}</span>
          </button>
        </div>
      )}

      <header className="pro-hero gc-header">
        <div>
          <span className="pro-kicker">{p('Community')}</span>
          <h1>{p('Group challenges')}</h1>
          <p>{p('Push your limits alongside your teammates, climb the leaderboard, and celebrate achievements.')}</p>
        </div>
        <Icon name="trophy" />
      </header>

      {/* Toolbar / Filters */}
      <div className="gc-toolbar">
        <div className="gc-filter-group" role="tablist">
          <button
            role="tab"
            aria-selected={statusFilter === 'active'}
            className={`gc-filter-btn ${statusFilter === 'active' ? 'active' : ''}`}
            onClick={() => setStatusFilter('active')}
          >
            {p('Active')}
          </button>
          <button
            role="tab"
            aria-selected={statusFilter === 'completed'}
            className={`gc-filter-btn ${statusFilter === 'completed' ? 'active' : ''}`}
            onClick={() => setStatusFilter('completed')}
          >
            {p('Completed')}
          </button>
        </div>
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
          title={statusFilter === 'active' ? p('No active challenges') : p('No completed challenges')}
          description={p('Challenges created by your coaches will appear here when active.')}
        />
      ) : (
        <div className="gc-card-list">
          {filteredChallenges.map(challenge => (
            <article key={challenge.id} className="gc-card">
              <div className="gc-card-header">
                <div className="gc-card-title-group">
                  <h3>{challenge.title}</h3>
                  <div className="gc-badge-row">
                    <span className={`gc-badge status-${challenge.status}`}>
                      {challenge.status === 'active' ? p('Active') : p('Completed')}
                    </span>
                    <span className="gc-badge">{typeName(challenge.type)}</span>
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
                <Button size="sm" variant="accent" icon="chart" onClick={() => openLeaderboard(challenge.id)}>
                  {p('Leaderboard')} & {p('Activity feed')}
                </Button>
              </div>
            </article>
          ))}

          {page?.hasMore && (
            <div className="pro-actions">
              <Button size="sm" disabled={loadingMore} onClick={() => loadChallenges(page.nextCursor)}>
                {loadingMore ? p('Loading…') : p('Load more')}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Leaderboard and Feed Modal */}
      {selectedChallengeId && (
        <AccessibleModal
          id="athlete-challenge-details"
          title={leaderboardData?.challenge?.title || p('Challenge details')}
          onClose={() => { setSelectedChallengeId(null); setLeaderboardData(null); }}
        >
          {loadingLeaderboard || !leaderboardData ? (
            <div className="pro-loading">{p('Loading leaderboard…')}</div>
          ) : leaderboardError ? (
            <div className="card gc-alert error" role="alert">
              <span>{leaderboardError}</span>
              <Button size="sm" onClick={() => openLeaderboard(selectedChallengeId)}>{p('Try again')}</Button>
            </div>
          ) : (
            <div className="pro-modal-form">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div className="gc-badge-row">
                  <span className={`gc-badge status-${leaderboardData.challenge?.status}`}>
                    {leaderboardData.challenge?.status}
                  </span>
                  <span className="gc-badge">{typeName(leaderboardData.challenge?.type)}</span>
                </div>
                <Button size="sm" icon="arrowPath" onClick={() => openLeaderboard(selectedChallengeId)}>
                  {p('Refresh') || 'Refresh'}
                </Button>
              </div>

              {/* Leaderboard Table with Current Athlete Highlight */}
              <h3 style={{ margin: '14px 0 6px', fontSize: 'var(--fs-title3)' }}>
                {p('Leaderboard')}
              </h3>

              <div className="gc-leaderboard">
                {(!leaderboardData.leaderboard || leaderboardData.leaderboard.length === 0) ? (
                  <div className="pro-empty-inline">{p('No ranking data available yet.')}</div>
                ) : (
                  leaderboardData.leaderboard.map(item => {
                    const isMe = Boolean(item.isMe)
                    return (
                      <div
                        key={item.participantKey || item.rank}
                        className={`gc-leaderboard-row ${isMe ? 'athlete-me-row' : ''}`}
                      >
                        <div className={`gc-rank-col ${item.rank <= 3 ? `gc-rank-${item.rank}` : ''}`}>
                          {item.rank === 1 ? '🥇' : item.rank === 2 ? '🥈' : item.rank === 3 ? '🥉' : `#${item.rank}`}
                        </div>

                        <div className="gc-participant-info">
                          <div className="gc-participant-name">
                            {item.displayName || p('Athlete')}
                            {isMe && <span className="gc-badge" style={{ marginLeft: 6 }}>{p('You')}</span>}
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
                    )
                  })
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
    </div>
  )
}
