import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../../store/useStore.js'
import { useUI } from '../../store/useUI.js'
import { api } from '../../lib/api.js'
import { copyText } from '../../lib/clipboard.js'
import { professionalError, professionalText as p } from '../../lib/professional-copy.js'
import {
  listCoachGroups,
  createCoachGroup,
  getCoachGroup,
  updateCoachGroup,
  deleteCoachGroup,
  addCoachGroupMember,
  removeCoachGroupMember,
  rotateGroupInvite,
} from '../../lib/group-challenges-api.js'
import Icon from '../../components/Icon.jsx'
import EmptyState from '../../components/EmptyState.jsx'
import { Button, TextField, TextArea, NumberField, Switch } from '../../components/ui.jsx'
import AccessibleModal from '../AccessibleModal.jsx'
import '../GroupChallenges.css'

export default function CoachGroupsView({ embedded = false }) {
  const user = useStore(state => state.user)
  const toast = useUI(state => state.toast)
  const navigate = useNavigate()

  const [groups, setGroups] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(null)
  const [loadingMore, setLoadingMore] = useState(false)

  // Details Modal / Sheet state
  const [selectedGroupId, setSelectedGroupId] = useState(null)
  const [groupDetails, setGroupDetails] = useState(null)
  const [loadingDetails, setLoadingDetails] = useState(false)
  const [copiedCode, setCopiedCode] = useState(false)
  const [rotatingInvite, setRotatingInvite] = useState(false)

  // Create Group Modal state
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [createForm, setCreateForm] = useState({
    name: '',
    description: '',
    category: '',
    maxMembers: 50,
    isPrivate: true,
  })
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState(null)

  // Add Athlete Modal state
  const [showAddMemberModal, setShowAddMemberModal] = useState(false)
  const [athleteQuery, setAthleteQuery] = useState('')
  const [selectedAthlete, setSelectedAthlete] = useState(null)
  const [coachAthletes, setCoachAthletes] = useState([])
  const [loadingAthletes, setLoadingAthletes] = useState(false)
  const [addingMember, setAddingMember] = useState(false)
  const [addMemberError, setAddMemberError] = useState(null)

  // Remove Member Confirm Modal state
  const [memberToRemove, setMemberToRemove] = useState(null)
  const [removingMember, setRemovingMember] = useState(false)

  // Load Coach Groups
  const loadGroups = useCallback(async (cursor = null) => {
    if (!cursor) setLoading(true)
    else setLoadingMore(true)
    setError(null)

    try {
      const res = await listCoachGroups({ cursor, limit: 30 })
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

  // Load eligible athletes for autocomplete (with training scope)
  const loadCoachAthletes = useCallback(async () => {
    setLoadingAthletes(true)
    try {
      const res = await api('/api/coach/athletes')
      const links = res?.links || []
      const eligible = links
        .filter(link => link.status === 'active' && (!link.scopes || link.scopes.includes('training')))
        .map(link => ({
          id: link.athleteId || link.athlete?.id,
          name: link.athlete?.name || link.athleteName || p('Athlete'),
        }))
      setCoachAthletes(eligible)
    } catch {
      setCoachAthletes([])
    } finally {
      setLoadingAthletes(false)
    }
  }, [])

  // Load group details
  const openGroupDetails = async (groupId) => {
    setSelectedGroupId(groupId)
    setLoadingDetails(true)
    setGroupDetails(null)
    setCopiedCode(false)
    try {
      const res = await getCoachGroup(groupId, { limit: 100 })
      setGroupDetails(res)
    } catch (err) {
      toast(professionalError(err))
      setSelectedGroupId(null)
    } finally {
      setLoadingDetails(false)
    }
  }

  // Handle Create Group
  const handleCreateSubmit = async (e) => {
    e?.preventDefault?.()
    if (!createForm.name.trim()) {
      setCreateError(p('Enter a group name.'))
      return
    }
    setCreating(true)
    setCreateError(null)
    try {
      const res = await createCoachGroup({
        name: createForm.name.trim(),
        description: createForm.description.trim(),
        category: createForm.category.trim(),
        maxMembers: Number(createForm.maxMembers) || 50,
        isPrivate: Boolean(createForm.isPrivate),
      })
      toast(p('Group created successfully.'))
      setShowCreateModal(false)
      setCreateForm({ name: '', description: '', category: '', maxMembers: 50, isPrivate: true })
      loadGroups()
      if (res?.group?.id) {
        openGroupDetails(res.group.id)
      }
    } catch (err) {
      setCreateError(professionalError(err))
    } finally {
      setCreating(false)
    }
  }

  // Rotate Invite Code
  const handleRotateInvite = async () => {
    if (!selectedGroupId || rotatingInvite) return
    setRotatingInvite(true)
    try {
      const res = await rotateGroupInvite(selectedGroupId)
      if (res?.invite) {
        setGroupDetails(prev => prev ? {
          ...prev,
          group: { ...prev.group, invite: res.invite, inviteCode: res.invite.code },
        } : prev)
      }
      toast(p('Invite code rotated.'))
    } catch (err) {
      toast(professionalError(err))
    } finally {
      setRotatingInvite(false)
    }
  }

  // Copy Invite Code or Link
  const handleCopyInvite = async (code) => {
    if (!code) return
    const ok = await copyText(code)
    if (ok) {
      setCopiedCode(true)
      toast(p('Code copied to clipboard.'))
      setTimeout(() => setCopiedCode(false), 2500)
    }
  }

  // Open Add Member Modal
  const handleOpenAddMember = () => {
    setAthleteQuery('')
    setSelectedAthlete(null)
    setAddMemberError(null)
    setShowAddMemberModal(true)
    loadCoachAthletes()
  }

  // Submit Add Member
  const handleAddMemberSubmit = async () => {
    if (!selectedAthlete?.id || !selectedGroupId || addingMember) return
    setAddingMember(true)
    setAddMemberError(null)
    try {
      await addCoachGroupMember(selectedGroupId, {
        athleteId: selectedAthlete.id,
        role: 'member',
      })
      toast(p('Athlete added to group.'))
      setShowAddMemberModal(false)
      // Refresh details & group list
      const updated = await getCoachGroup(selectedGroupId, { limit: 100 })
      setGroupDetails(updated)
      loadGroups()
    } catch (err) {
      setAddMemberError(professionalError(err))
    } finally {
      setAddingMember(false)
    }
  }

  // Remove Member Confirm & Action
  const handleConfirmRemoveMember = async () => {
    if (!memberToRemove || !selectedGroupId || removingMember) return
    setRemovingMember(true)
    try {
      await removeCoachGroupMember(selectedGroupId, memberToRemove.athleteId || memberToRemove.id)
      toast(p('Member removed from group.'))
      setMemberToRemove(null)
      const updated = await getCoachGroup(selectedGroupId, { limit: 100 })
      setGroupDetails(updated)
      loadGroups()
    } catch (err) {
      toast(professionalError(err))
    } finally {
      setRemovingMember(false)
    }
  }

  // Filter athletes for autocomplete
  const filteredAthletes = useMemo(() => {
    if (!athleteQuery.trim()) return coachAthletes
    const q = athleteQuery.toLowerCase()
    return coachAthletes.filter(ath => ath.name.toLowerCase().includes(q))
  }, [coachAthletes, athleteQuery])

  // Filter groups
  const filteredGroups = useMemo(() => {
    if (!search.trim()) return groups
    const q = search.toLowerCase()
    return groups.filter(g => g.name.toLowerCase().includes(q) || (g.category && g.category.toLowerCase().includes(q)))
  }, [groups, search])

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
          <h1>{p('Groups')}</h1>
          <p>{p('Create and manage community groups for your athletes, share challenges, and build team spirit.')}</p>
        </div>
        <Icon name="person" />
      </header>

      {/* Toolbar */}
      <div className="gc-toolbar">
        <div className="gc-search-box">
          <TextField
            name="groupSearch"
            value={search}
            placeholder={p('Search groups…')}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <Button variant="accent" icon="plus" onClick={() => { setShowCreateModal(true); setCreateError(null); }}>
          {p('New group')}
        </Button>
      </div>

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
      ) : filteredGroups.length === 0 ? (
        <EmptyState
          icon="person"
          title={search ? p('No matching groups') : p('No groups created yet')}
          description={search ? p('Try a different search term.') : p('Create your first group to start building a community with your athletes.')}
          action={
            !search && (
              <Button variant="accent" onClick={() => setShowCreateModal(true)}>
                {p('Create group')}
              </Button>
            )
          }
        />
      ) : (
        <div className="gc-card-list">
          {filteredGroups.map(group => {
            const memberCount = group.memberCount || 0
            const maxMembers = group.maxMembers || 50
            const pct = Math.min(100, Math.round((memberCount / maxMembers) * 100))
            const isFull = memberCount >= maxMembers
            return (
              <article key={group.id} className="gc-card">
                <div className="gc-card-header">
                  <div className="gc-card-title-group">
                    <h3>{group.name}</h3>
                    <div className="gc-badge-row">
                      {group.category && <span className="gc-badge">{group.category}</span>}
                      <span className={`gc-badge ${group.archivedAt ? 'status-archived' : 'status-active'}`}>
                        {group.archivedAt ? p('Archived') : p('Active')}
                      </span>
                      {group.isPrivate && <span className="gc-badge">{p('Private')}</span>}
                    </div>
                  </div>
                </div>

                {group.description && (
                  <p className="pro-routine-note">{group.description}</p>
                )}

                <div className="gc-capacity-meter">
                  <span>{memberCount} / {maxMembers} {p('Members')}</span>
                  <div className="gc-progress-bar">
                    <div className={`gc-progress-fill ${isFull ? 'full' : ''}`} style={{ width: `${pct}%` }} />
                  </div>
                  {isFull && <span className="gc-badge status-draft">{p('Full')}</span>}
                </div>

                <div className="gc-card-actions">
                  <Button size="sm" variant="tinted" icon="person" onClick={() => openGroupDetails(group.id)}>
                    {p('Group details')}
                  </Button>
                </div>
              </article>
            )
          })}

          {page?.hasMore && (
            <div className="pro-actions">
              <Button size="sm" disabled={loadingMore} onClick={() => loadGroups(page.nextCursor)}>
                {loadingMore ? p('Loading…') : p('Load more')}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Group Details Modal */}
      {selectedGroupId && (
        <AccessibleModal
          id="group-details"
          title={groupDetails?.group?.name || p('Group details')}
          onClose={() => { setSelectedGroupId(null); setGroupDetails(null); }}
        >
          {loadingDetails || !groupDetails ? (
            <div className="pro-loading">{p('Loading group details…')}</div>
          ) : (
            <div className="pro-modal-form">
              {groupDetails.group?.description && (
                <p className="pro-routine-note">{groupDetails.group.description}</p>
              )}

              {/* Invite Code Box */}
              <section className="gc-invite-box">
                <div>
                  <span className="pro-kicker">{p('Invite code')}</span>
                  <div className="gc-invite-code">
                    {groupDetails.group?.invite?.code || groupDetails.group?.inviteCode || p('No active code')}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <Button
                    size="sm"
                    icon="copy"
                    onClick={() => handleCopyInvite(groupDetails.group?.invite?.code || groupDetails.group?.inviteCode)}
                  >
                    {copiedCode ? p('Copied!') : p('Copy code')}
                  </Button>
                  <Button
                    size="sm"
                    icon="arrowPath"
                    disabled={rotatingInvite}
                    onClick={handleRotateInvite}
                  >
                    {rotatingInvite ? '…' : p('Rotate code')}
                  </Button>
                </div>
              </section>

              {/* Members Header */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }}>
                <div>
                  <strong>{p('Members')} ({groupDetails.members?.length || 0} / {groupDetails.group?.maxMembers || 50})</strong>
                </div>
                <Button size="sm" variant="accent" icon="plus" onClick={handleOpenAddMember}>
                  {p('Add athlete')}
                </Button>
              </div>

              {/* Member list */}
              <div className="gc-member-list">
                {(!groupDetails.members || groupDetails.members.length === 0) ? (
                  <div className="pro-empty-inline">{p('No members in this group yet.')}</div>
                ) : (
                  groupDetails.members.map(member => (
                    <div key={member.id} className="gc-member-row">
                      <div className="gc-member-info">
                        <span className="gc-member-name">{member.displayName || member.athleteName || member.name || p('Athlete')}</span>
                        <span className="gc-member-meta">
                          {member.role === 'moderator' ? p('Moderator') : p('Member')} · {member.status === 'pending' ? p('Pending') : p('Active')}
                        </span>
                      </div>
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => setMemberToRemove(member)}
                      >
                        {p('Remove member')}
                      </Button>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </AccessibleModal>
      )}

      {/* Create Group Modal */}
      {showCreateModal && (
        <AccessibleModal
          id="create-group"
          title={p('New group')}
          onClose={() => setShowCreateModal(false)}
        >
          <form onSubmit={handleCreateSubmit} className="pro-modal-form">
            {createError && (
              <div className="gc-alert error" role="alert">
                <span>{createError}</span>
              </div>
            )}

            <label className="pro-field">
              <span>{p('Group name')} *</span>
              <TextField
                name="name"
                value={createForm.name}
                maxLength={100}
                placeholder={p('Example: Barbell Elite Club')}
                onChange={e => setCreateForm(prev => ({ ...prev, name: e.target.value }))}
              />
            </label>

            <label className="pro-field">
              <span>{p('Description')}</span>
              <TextArea
                name="description"
                rows={3}
                value={createForm.description}
                maxLength={1000}
                placeholder={p('Explain the focus, goals, or community guidelines…')}
                onChange={e => setCreateForm(prev => ({ ...prev, description: e.target.value }))}
              />
            </label>

            <label className="pro-field">
              <span>{p('Category')}</span>
              <TextField
                name="category"
                value={createForm.category}
                maxLength={50}
                placeholder={p('Example: Powerlifting, Hypertrophy')}
                onChange={e => setCreateForm(prev => ({ ...prev, category: e.target.value }))}
              />
            </label>

            <label className="pro-field">
              <span>{p('Max members')} (1 - 500)</span>
              <NumberField
                decimal={false}
                value={createForm.maxMembers}
                onChange={val => setCreateForm(prev => ({ ...prev, maxMembers: val }))}
              />
            </label>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0' }}>
              <div>
                <strong>{p('Private group')}</strong>
                <p className="pro-routine-note">{p('Require invite code or direct invitation to join.')}</p>
              </div>
              <Switch
                checked={createForm.isPrivate}
                onChange={val => setCreateForm(prev => ({ ...prev, isPrivate: val }))}
              />
            </div>

            <div className="pro-actions" style={{ marginTop: 16 }}>
              <Button type="button" onClick={() => setShowCreateModal(false)}>
                {p('Cancel')}
              </Button>
              <Button type="submit" variant="accent" disabled={creating || !createForm.name.trim()}>
                {creating ? p('Creating…') : p('Create group')}
              </Button>
            </div>
          </form>
        </AccessibleModal>
      )}

      {/* Add Athlete Autocomplete Modal */}
      {showAddMemberModal && (
        <AccessibleModal
          id="add-member"
          title={p('Add athlete')}
          onClose={() => setShowAddMemberModal(false)}
        >
          <div className="pro-modal-form">
            {addMemberError && (
              <div className="gc-alert error" role="alert">
                <span>{addMemberError}</span>
              </div>
            )}

            <p className="pro-routine-note">
              {p('Search among your active athletes with training scope to invite them into this group.')}
            </p>

            <label className="pro-field">
              <span>{p('Search athlete')}</span>
              <TextField
                name="athleteSearch"
                value={athleteQuery}
                placeholder={p('Type athlete name…')}
                onChange={e => {
                  setAthleteQuery(e.target.value)
                  setSelectedAthlete(null)
                }}
              />
            </label>

            {loadingAthletes ? (
              <div className="pro-loading">{p('Loading athletes…')}</div>
            ) : (
              <div className="gc-autocomplete-dropdown" style={{ position: 'static', maxHeight: 220 }}>
                {filteredAthletes.length === 0 ? (
                  <div className="pro-empty-inline" style={{ padding: 12 }}>
                    {p('No active training athletes found.')}
                  </div>
                ) : (
                  filteredAthletes.map(ath => {
                    const isSelected = selectedAthlete?.id === ath.id
                    return (
                      <div
                        key={ath.id}
                        role="button"
                        tabIndex={0}
                        className={`gc-autocomplete-option ${isSelected ? 'selected' : ''}`}
                        onClick={() => setSelectedAthlete(ath)}
                        onKeyDown={e => { if (e.key === 'Enter') setSelectedAthlete(ath) }}
                      >
                        <strong>{ath.name}</strong>
                        {isSelected && <Icon name="checkmark" />}
                      </div>
                    )
                  })
                )}
              </div>
            )}

            {selectedAthlete && (
              <div className="gc-alert info" style={{ marginTop: 8 }}>
                <span>{p('Selected')}: <strong>{selectedAthlete.name}</strong></span>
              </div>
            )}

            <div className="pro-actions" style={{ marginTop: 16 }}>
              <Button type="button" onClick={() => setShowAddMemberModal(false)}>
                {p('Cancel')}
              </Button>
              <Button
                type="button"
                variant="accent"
                disabled={addingMember || !selectedAthlete}
                onClick={handleAddMemberSubmit}
              >
                {addingMember ? p('Adding…') : p('Add athlete')}
              </Button>
            </div>
          </div>
        </AccessibleModal>
      )}

      {/* Remove Member Confirmation Modal */}
      {memberToRemove && (
        <AccessibleModal
          id="remove-member-confirm"
          title={p('Remove member')}
          onClose={() => setMemberToRemove(null)}
        >
          <div className="pro-modal-form">
            <p>
              {p('Are you sure you want to remove this member?')}
              <br />
              <strong>{memberToRemove.displayName || memberToRemove.athleteName || memberToRemove.name}</strong>
            </p>

            <div className="pro-actions" style={{ marginTop: 16 }}>
              <Button type="button" onClick={() => setMemberToRemove(null)}>
                {p('Cancel')}
              </Button>
              <Button
                type="button"
                variant="danger"
                disabled={removingMember}
                onClick={handleConfirmRemoveMember}
              >
                {removingMember ? p('Removing…') : p('Remove member')}
              </Button>
            </div>
          </div>
        </AccessibleModal>
      )}
    </div>
  )
}
