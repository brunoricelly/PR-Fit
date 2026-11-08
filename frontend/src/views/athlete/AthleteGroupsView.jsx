import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useStore } from '../../store/useStore.js'
import { useUI } from '../../store/useUI.js'
import { professionalError, professionalText as p } from '../../lib/professional-copy.js'
import {
  listAthleteGroups,
  joinGroupByInvite,
  acceptGroupInvitation,
  leaveGroup,
  getAthleteGroup,
} from '../../lib/group-challenges-api.js'
import Icon from '../../components/Icon.jsx'
import EmptyState from '../../components/EmptyState.jsx'
import { Button, TextField } from '../../components/ui.jsx'
import AccessibleModal from '../AccessibleModal.jsx'
import '../GroupChallenges.css'

export default function AthleteGroupsView({ embedded = false }) {
  const user = useStore(state => state.user)
  const toast = useUI(state => state.toast)
  const navigate = useNavigate()
  const location = useLocation()

  const [groups, setGroups] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [page, setPage] = useState(null)
  const [loadingMore, setLoadingMore] = useState(false)

  // Join by Invite Code state
  const initialCode = useMemo(() => {
    const params = new URLSearchParams(location.search)
    return params.get('code') || params.get('invite') || ''
  }, [location.search])

  const [inviteCodeInput, setInviteCodeInput] = useState(initialCode)
  const [joining, setJoining] = useState(false)
  const [joinError, setJoinError] = useState(null)

  // Details Modal (privacy-safe roster)
  const [selectedGroup, setSelectedGroup] = useState(null)
  const [groupDetails, setGroupDetails] = useState(null)
  const [loadingDetails, setLoadingDetails] = useState(false)

  // Leave Group Confirm Modal
  const [groupToLeave, setGroupToLeave] = useState(null)
  const [leaving, setLeaving] = useState(false)

  // Action loading flags
  const [acceptingId, setAcceptingId] = useState(null)

  // Load athlete groups
  const loadGroups = useCallback(async (cursor = null) => {
    if (!cursor) setLoading(true)
    else setLoadingMore(true)
    setError(null)

    try {
      const res = await listAthleteGroups({ cursor, limit: 30 })
      if (cursor) {
        setGroups(prev => [...prev, ...(res.groups || [])])
      } else {
        setGroups(res.groups || [])
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
    loadGroups()
  }, [loadGroups])

  // Join by Code handler
  const handleJoinSubmit = async (e) => {
    e?.preventDefault?.()
    const code = inviteCodeInput.trim()
    if (!code) {
      setJoinError(p('Enter an invite code.'))
      return
    }

    setJoining(true)
    setJoinError(null)

    try {
      const res = await joinGroupByInvite(code)
      toast(p('Joined group successfully!'))
      setInviteCodeInput('')
      loadGroups()
      if (res?.group?.id) {
        openGroupRoster(res.group)
      }
    } catch (err) {
      setJoinError(professionalError(err))
    } finally {
      setJoining(false)
    }
  }

  // Accept pending invitation
  const handleAcceptInvite = async (groupId) => {
    if (acceptingId) return
    setAcceptingId(groupId)
    try {
      await acceptGroupInvitation(groupId)
      toast(p('Group invitation accepted!'))
      loadGroups()
    } catch (err) {
      toast(professionalError(err))
    } finally {
      setAcceptingId(null)
    }
  }

  // Confirm and Leave group
  const handleLeaveConfirm = async () => {
    if (!groupToLeave || leaving) return
    setLeaving(true)
    try {
      await leaveGroup(groupToLeave.id)
      toast(p('Left group successfully.'))
      setGroupToLeave(null)
      loadGroups()
    } catch (err) {
      toast(professionalError(err))
    } finally {
      setLeaving(false)
    }
  }

  // Open privacy-safe group roster
  const openGroupRoster = async (group) => {
    setSelectedGroup(group)
    setLoadingDetails(true)
    setGroupDetails(null)
    try {
      const res = await getAthleteGroup(group.id, { limit: 50 })
      setGroupDetails(res)
    } catch (err) {
      toast(professionalError(err))
      setSelectedGroup(null)
    } finally {
      setLoadingDetails(false)
    }
  }

  // Partition groups into pending invitations and active groups
  const pendingGroups = useMemo(() => {
    return groups.filter(g => g.status === 'pending' || g.membershipStatus === 'pending')
  }, [groups])

  const activeGroups = useMemo(() => {
    return groups.filter(g => g.status !== 'pending' && g.membershipStatus !== 'pending')
  }, [groups])

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
          <h1>{p('My groups')}</h1>
          <p>{p('Participate in coach community groups, connect with peers, and join team challenges.')}</p>
        </div>
        <Icon name="person" />
      </header>

      {/* Join with Invite Code Card */}
      <section className="gc-card" style={{ marginBottom: 20 }}>
        <div className="gc-card-header">
          <div className="gc-card-title-group">
            <h3>{p('Join with code')}</h3>
            <span className="gc-card-subtitle">
              {p('Have an invite code from your coach? Enter it below to join the group.')}
            </span>
          </div>
        </div>

        <form onSubmit={handleJoinSubmit} style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 8 }}>
          <div style={{ flex: '1 1 200px' }}>
            <TextField
              name="inviteCode"
              value={inviteCodeInput}
              placeholder="GRP-XXXX..."
              onChange={e => {
                setInviteCodeInput(e.target.value.toUpperCase())
                setJoinError(null)
              }}
            />
          </div>
          <Button
            type="submit"
            variant="accent"
            disabled={joining || !inviteCodeInput.trim()}
          >
            {joining ? p('Joining…') : p('Join group')}
          </Button>
        </form>

        {joinError && (
          <div className="gc-alert error" role="alert" style={{ marginTop: 8 }}>
            <span>{joinError}</span>
          </div>
        )}
      </section>

      {/* Pending Invitations Section */}
      {pendingGroups.length > 0 && (
        <section style={{ marginBottom: 24 }}>
          <h3 style={{ margin: '0 0 10px', fontSize: 'var(--fs-title3)' }}>
            {p('Pending invites')} ({pendingGroups.length})
          </h3>
          <div className="gc-card-list">
            {pendingGroups.map(group => (
              <article key={group.id} className="gc-card" style={{ borderColor: 'var(--acc)' }}>
                <div className="gc-card-header">
                  <div className="gc-card-title-group">
                    <h3>{group.name}</h3>
                    <div className="gc-badge-row">
                      <span className="gc-badge status-pending">{p('Invitation pending')}</span>
                      {group.category && <span className="gc-badge">{group.category}</span>}
                    </div>
                  </div>
                </div>

                {group.description && (
                  <p className="pro-routine-note">{group.description}</p>
                )}

                <div className="gc-card-actions">
                  <Button
                    size="sm"
                    variant="accent"
                    disabled={acceptingId === group.id}
                    onClick={() => handleAcceptInvite(group.id)}
                  >
                    {acceptingId === group.id ? p('Accepting…') : p('Accept invitation')}
                  </Button>
                  <Button
                    size="sm"
                    variant="plain"
                    onClick={() => setGroupToLeave(group)}
                  >
                    {p('Decline invitation')}
                  </Button>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      {/* Active Groups Section */}
      <h3 style={{ margin: '0 0 10px', fontSize: 'var(--fs-title3)' }}>
        {p('Active members')}
      </h3>

      {error && (
        <div className="card gc-alert error" role="alert">
          <span>{error}</span>
          <Button size="sm" onClick={() => loadGroups()}>{p('Try again')}</Button>
        </div>
      )}

      {loading ? (
        <div className="gc-card-list">
          <div className="gc-skeleton-card" />
          <div className="gc-skeleton-card" />
        </div>
      ) : activeGroups.length === 0 ? (
        <EmptyState
          icon="person"
          title={p('You are not in any groups yet')}
          description={p('Join with an invite code from your coach or wait for an invitation.')}
        />
      ) : (
        <div className="gc-card-list">
          {activeGroups.map(group => (
            <article key={group.id} className="gc-card">
              <div className="gc-card-header">
                <div className="gc-card-title-group">
                  <h3>{group.name}</h3>
                  <div className="gc-badge-row">
                    <span className="gc-badge status-active">{p('Active')}</span>
                    {group.category && <span className="gc-badge">{group.category}</span>}
                    {group.coach?.name && <span className="gc-badge">{p('Coach')}: {group.coach.name}</span>}
                  </div>
                </div>
              </div>

              {group.description && (
                <p className="pro-routine-note">{group.description}</p>
              )}

              <div className="gc-capacity-meter">
                <span>{group.memberCount || 0} {p('Members')}</span>
              </div>

              <div className="gc-card-actions">
                <Button size="sm" variant="tinted" onClick={() => openGroupRoster(group)}>
                  {p('View members') || 'View members'}
                </Button>
                <Button size="sm" variant="plain" onClick={() => setGroupToLeave(group)}>
                  {p('Leave group')}
                </Button>
              </div>
            </article>
          ))}

          {page?.hasMore && (
            <div className="pro-actions">
              <Button size="sm" disabled={loadingMore} onClick={() => loadGroups(page.nextCursor)}>
                {loadingMore ? p('Loading…') : p('Load more')}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Privacy-Safe Group Roster Modal */}
      {selectedGroup && (
        <AccessibleModal
          id="athlete-group-roster"
          title={selectedGroup.name}
          onClose={() => { setSelectedGroup(null); setGroupDetails(null); }}
        >
          {loadingDetails || !groupDetails ? (
            <div className="pro-loading">{p('Loading group members…')}</div>
          ) : (
            <div className="pro-modal-form">
              {groupDetails.group?.description && (
                <p className="pro-routine-note">{groupDetails.group.description}</p>
              )}

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10 }}>
                <strong>{p('Members')} ({groupDetails.members?.length || 0})</strong>
              </div>

              <div className="gc-member-list">
                {(!groupDetails.members || groupDetails.members.length === 0) ? (
                  <div className="pro-empty-inline">{p('No other members in this group yet.')}</div>
                ) : (
                  groupDetails.members.map(member => (
                    <div key={member.id} className="gc-member-row">
                      <div className="gc-member-info">
                        <span className="gc-member-name">{member.displayName || p('Athlete')}</span>
                        <span className="gc-member-meta">
                          {member.role === 'moderator' ? p('Moderator') : p('Member')}
                        </span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </AccessibleModal>
      )}

      {/* Leave Group Confirmation Modal */}
      {groupToLeave && (
        <AccessibleModal
          id="leave-group-confirm"
          title={p('Leave group')}
          onClose={() => setGroupToLeave(null)}
        >
          <div className="pro-modal-form">
            <p>
              {p('Are you sure you want to leave this group?')}
              <br />
              <strong>{groupToLeave.name}</strong>
            </p>
            <div className="pro-actions" style={{ marginTop: 16 }}>
              <Button type="button" onClick={() => setGroupToLeave(null)}>
                {p('Cancel')}
              </Button>
              <Button
                type="button"
                variant="danger"
                disabled={leaving}
                onClick={handleLeaveConfirm}
              >
                {leaving ? p('Leaving…') : p('Leave group')}
              </Button>
            </div>
          </div>
        </AccessibleModal>
      )}
    </div>
  )
}
