import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
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
  PageHeader,
  SkeletonCard,
  Surface,
} from '../../components/design-system.jsx'
import '../GroupChallenges.css'
import '../coach/CoachGroupsView.css'

export default function AthleteGroupsView({ embedded = false }) {
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
  const handleJoinSubmit = async e => {
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
  const handleAcceptInvite = async groupId => {
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
  const openGroupRoster = async group => {
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
        title={p('My groups')}
        description={p('Participate in coach community groups, connect with peers, and join team challenges.')}
      />

      {/* Join with Invite Code Card */}
      <Card className="gc-card" style={{ marginBottom: 20 }}>
        <div className="gc-card-header">
          <div className="gc-card-title-group">
            <h3>{p('Join with code')}</h3>
            <span className="gc-card-subtitle">
              {p('Have an invite code from your coach? Enter it below to join the group.')}
            </span>
          </div>
        </div>

        <Alert tone="info" style={{ margin: '8px 0' }}>
          <strong>{p('Privacy guarantee')}:</strong>{' '}
          {p('Your health data, private workouts, and body measurements will never be shared with group members. Only your public display name is visible.')}
        </Alert>

        <form onSubmit={handleJoinSubmit} style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 8 }}>
          <div style={{ flex: '1 1 220px' }}>
            <Field label={p('Invite code')}>
              <Input
                name="inviteCode"
                value={inviteCodeInput}
                placeholder={p('Example: GRP-XXXX')}
                onChange={e => {
                  setInviteCodeInput(e.target.value.toUpperCase())
                  setJoinError(null)
                }}
              />
            </Field>
          </div>
          <Button
            type="submit"
            variant="primary"
            loading={joining}
            loadingLabel={p('Joining…')}
            disabled={joining || !inviteCodeInput.trim()}
            style={{ minHeight: 44 }}
          >
            {p('Join group')}
          </Button>
        </form>

        {joinError && (
          <Alert tone="error" style={{ marginTop: 8 }}>
            <span>{joinError}</span>
          </Alert>
        )}
      </Card>

      {/* Pending Invitations Section */}
      {pendingGroups.length > 0 && (
        <section style={{ marginBottom: 24 }}>
          <h2 style={{ fontSize: 'var(--fs-title3)', marginBottom: 12 }}>
            {p('Pending invites')} ({pendingGroups.length})
          </h2>
          <div className="gc-card-list">
            {pendingGroups.map(group => (
              <Card key={group.id} className="gc-card">
                <div className="gc-card-header">
                  <div className="gc-card-title-group">
                    <h3>{group.name}</h3>
                    <div className="gc-badge-row">
                      <Badge tone="warning">{p('Pending') || 'Pendente'}</Badge>
                      {group.category && <Badge>{group.category}</Badge>}
                      {group.coach?.name && <Badge>{p('Coach')}: {group.coach.name}</Badge>}
                    </div>
                  </div>
                </div>

                {group.description && (
                  <p className="pro-routine-note">{group.description}</p>
                )}

                <div className="gc-card-actions">
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={acceptingId === group.id}
                    onClick={() => handleAcceptInvite(group.id)}
                  >
                    {acceptingId === group.id ? p('Joining…') : p('Accept invitation')}
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => setGroupToLeave(group)}
                  >
                    {p('Decline invitation')}
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        </section>
      )}

      {error ? (
        <ErrorState
          title={p('Unable to load groups')}
          text={error}
          action={<Button variant="primary" onClick={() => loadGroups()}>{p('Try again')}</Button>}
        />
      ) : loading ? (
        <div className="gc-card-list" aria-label={p('Loading groups…')}>
          <SkeletonCard />
          <SkeletonCard />
        </div>
      ) : activeGroups.length === 0 ? (
        <EmptyState
          icon="person"
          title={p('You are not in any groups yet')}
          text={p('Join with an invite code from your coach or wait for an invitation.')}
        />
      ) : (
        <div className="gc-card-list">
          {activeGroups.map(group => (
            <Card key={group.id} className="gc-card">
              <div className="gc-card-header">
                <div className="gc-card-title-group">
                  <h3>{group.name}</h3>
                  <div className="gc-badge-row">
                    <Badge tone="success">{p('Active')}</Badge>
                    {group.category && <Badge>{group.category}</Badge>}
                    {group.coach?.name && <Badge>{p('Coach')}: {group.coach.name}</Badge>}
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
                <Button size="sm" onClick={() => openGroupRoster(group)}>
                  {p('View members')}
                </Button>
                <Button size="sm" variant="destructive" onClick={() => setGroupToLeave(group)}>
                  {p('Leave group')}
                </Button>
              </div>
            </Card>
          ))}

          {page?.hasMore && (
            <div className="pro-actions">
              <Button size="sm" loading={loadingMore} loadingLabel={p('Loading…')} onClick={() => loadGroups(page.nextCursor)}>
                {p('Load more')}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Privacy-Safe Group Roster Modal */}
      {selectedGroup && (
        <Modal
          id="athlete-group-roster"
          title={selectedGroup.name}
          closeLabel={p('Close')}
          onClose={() => {
            setSelectedGroup(null)
            setGroupDetails(null)
          }}
        >
          {loadingDetails || !groupDetails ? (
            <div className="pro-loading" role="status" aria-label={p('Loading group members…')}>
              {p('Loading group members…')}
            </div>
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
                    <Surface key={member.id} className="gc-member-row">
                      <div className="gc-member-info">
                        <span className="gc-member-name">{member.displayName || p('Athlete')}</span>
                        <span className="gc-member-meta">
                          {member.role === 'moderator' ? p('Moderator') : p('Member')}
                        </span>
                      </div>
                    </Surface>
                  ))
                )}
              </div>
            </div>
          )}
        </Modal>
      )}

      {/* Leave Group Confirmation Modal */}
      {groupToLeave && (
        <Modal
          id="leave-group-confirm"
          title={p('Leave group')}
          closeLabel={p('Close')}
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
                variant="destructive"
                loading={leaving}
                loadingLabel={p('Leaving…')}
                onClick={handleLeaveConfirm}
              >
                {p('Leave group')}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </Container>
  )
}
