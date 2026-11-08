import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useUI } from '../../store/useUI.js'
import { api } from '../../lib/api.js'
import { copyText } from '../../lib/clipboard.js'
import { professionalError, professionalText as p } from '../../lib/professional-copy.js'
import {
  listCoachGroups,
  createCoachGroup,
  getCoachGroup,
  addCoachGroupMember,
  removeCoachGroupMember,
  rotateGroupInvite,
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
  Skeleton,
  SkeletonCard,
  Surface,
  Switch,
  Textarea,
} from '../../components/design-system.jsx'
import '../GroupChallenges.css'
import './CoachGroupsView.css'

export default function CoachGroupsView({ embedded = false }) {
  const toast = useUI(state => state.toast)
  const navigate = useNavigate()
  const [groups, setGroups] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [selectedGroupId, setSelectedGroupId] = useState(null)
  const [groupDetails, setGroupDetails] = useState(null)
  const [loadingDetails, setLoadingDetails] = useState(false)
  const [copiedCode, setCopiedCode] = useState(false)
  const [rotatingInvite, setRotatingInvite] = useState(false)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [createForm, setCreateForm] = useState({ name: '', description: '', category: '', maxMembers: 50, isPrivate: true })
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState(null)
  const [showAddMemberModal, setShowAddMemberModal] = useState(false)
  const [athleteQuery, setAthleteQuery] = useState('')
  const [selectedAthlete, setSelectedAthlete] = useState(null)
  const [coachAthletes, setCoachAthletes] = useState([])
  const [loadingAthletes, setLoadingAthletes] = useState(false)
  const [addingMember, setAddingMember] = useState(false)
  const [addMemberError, setAddMemberError] = useState(null)
  const [memberToRemove, setMemberToRemove] = useState(null)
  const [removingMember, setRemovingMember] = useState(false)
  const [loadingMoreMembers, setLoadingMoreMembers] = useState(false)

  const loadGroups = useCallback(async (cursor = null) => {
    if (!cursor) setLoading(true)
    else setLoadingMore(true)
    setError(null)
    try {
      const response = await listCoachGroups({ cursor, limit: 30 })
      if (cursor) setGroups(previous => [...previous, ...(response.groups || [])])
      else setGroups(response.groups || [])
      setPage(response.page || null)
    } catch (requestError) {
      setError(professionalError(requestError))
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  }, [])

  useEffect(() => { loadGroups() }, [loadGroups])

  const loadCoachAthletes = useCallback(async () => {
    setLoadingAthletes(true)
    try {
      const response = await api('/api/coach/athletes')
      setCoachAthletes((response?.links || [])
        .filter(link => link.status === 'active' && (!link.scopes || link.scopes.includes('training')))
        .map(link => ({ id: link.athleteId || link.athlete?.id, name: link.athlete?.name || link.athleteName || p('Athlete') })))
    } catch {
      setCoachAthletes([])
    } finally {
      setLoadingAthletes(false)
    }
  }, [])

  const openGroupDetails = async groupId => {
    setSelectedGroupId(groupId)
    setLoadingDetails(true)
    setGroupDetails(null)
    setCopiedCode(false)
    try {
      setGroupDetails(await getCoachGroup(groupId, { limit: 100 }))
    } catch (requestError) {
      toast(professionalError(requestError))
      setSelectedGroupId(null)
    } finally {
      setLoadingDetails(false)
    }
  }

  const handleCreateSubmit = async event => {
    event?.preventDefault?.()
    if (!createForm.name.trim()) {
      setCreateError(p('Enter a group name.'))
      return
    }
    const maxMembers = Number(createForm.maxMembers)
    if (isNaN(maxMembers) || maxMembers < 1 || maxMembers > 500) {
      setCreateError(p('Choose a limit between 1 and 500 athletes.'))
      return
    }
    setCreating(true)
    setCreateError(null)
    try {
      const response = await createCoachGroup({
        name: createForm.name.trim(),
        description: createForm.description.trim(),
        category: createForm.category.trim(),
        maxMembers,
        isPrivate: Boolean(createForm.isPrivate),
      })
      toast(p('Group created successfully.'))
      setShowCreateModal(false)
      setCreateForm({ name: '', description: '', category: '', maxMembers: 50, isPrivate: true })
      loadGroups()
      if (response?.group?.id) openGroupDetails(response.group.id)
    } catch (requestError) {
      setCreateError(professionalError(requestError))
    } finally {
      setCreating(false)
    }
  }

  const handleRotateInvite = async () => {
    if (!selectedGroupId || rotatingInvite) return
    setRotatingInvite(true)
    try {
      const response = await rotateGroupInvite(selectedGroupId)
      if (response?.invite) {
        setGroupDetails(previous => previous ? {
          ...previous,
          group: { ...previous.group, invite: response.invite, inviteCode: response.invite.code },
        } : previous)
      }
      toast(p('Invite code rotated.'))
    } catch (requestError) {
      toast(professionalError(requestError))
    } finally {
      setRotatingInvite(false)
    }
  }

  const handleCopyInvite = async code => {
    if (code && await copyText(code)) {
      setCopiedCode(true)
      toast(p('Code copied to clipboard.'))
      setTimeout(() => setCopiedCode(false), 2500)
    }
  }

  const handleOpenAddMember = () => {
    setAthleteQuery('')
    setSelectedAthlete(null)
    setAddMemberError(null)
    setShowAddMemberModal(true)
    loadCoachAthletes()
  }

  const handleAddMemberSubmit = async () => {
    if (!selectedAthlete?.id || !selectedGroupId || addingMember) return
    setAddingMember(true)
    setAddMemberError(null)
    try {
      await addCoachGroupMember(selectedGroupId, { athleteId: selectedAthlete.id, role: 'member' })
      toast(p('Athlete added to group.'))
      setShowAddMemberModal(false)
      setGroupDetails(await getCoachGroup(selectedGroupId, { limit: 100 }))
      loadGroups()
    } catch (requestError) {
      setAddMemberError(professionalError(requestError))
    } finally {
      setAddingMember(false)
    }
  }

  const handleConfirmRemoveMember = async () => {
    if (!memberToRemove || !selectedGroupId || removingMember) return
    setRemovingMember(true)
    try {
      await removeCoachGroupMember(selectedGroupId, memberToRemove.athleteId || memberToRemove.id)
      toast(p('Member removed from group.'))
      setMemberToRemove(null)
      setGroupDetails(await getCoachGroup(selectedGroupId, { limit: 100 }))
      loadGroups()
    } catch (requestError) {
      toast(professionalError(requestError))
    } finally {
      setRemovingMember(false)
    }
  }

  const handleLoadMoreMembers = async () => {
    if (!selectedGroupId || !groupDetails?.page?.hasMore || loadingMoreMembers) return
    setLoadingMoreMembers(true)
    try {
      const response = await getCoachGroup(selectedGroupId, {
        cursor: groupDetails.page.nextCursor,
        limit: 100,
      })
      setGroupDetails(previous => previous ? {
        ...previous,
        members: [...(previous.members || []), ...(response.members || [])],
        page: response.page || null,
      } : previous)
    } catch (requestError) {
      toast(professionalError(requestError))
    } finally {
      setLoadingMoreMembers(false)
    }
  }

  const filteredAthletes = useMemo(() => {
    if (!athleteQuery.trim()) return coachAthletes
    const query = athleteQuery.toLowerCase()
    return coachAthletes.filter(athlete => athlete.name.toLowerCase().includes(query))
  }, [coachAthletes, athleteQuery])

  const filteredGroups = useMemo(() => {
    if (!search.trim()) return groups
    const query = search.toLowerCase()
    return groups.filter(group => group.name.toLowerCase().includes(query) || group.category?.toLowerCase().includes(query))
  }, [groups, search])

  const Container = embedded ? 'div' : 'main'
  const maxMembersNum = Number(createForm.maxMembers)
  const isMaxMembersValid = createForm.maxMembers !== '' && !isNaN(maxMembersNum) && maxMembersNum >= 1 && maxMembersNum <= 500

  return (
    <Container className={`gc-page ds-scope ${embedded ? 'embedded' : 'narrow'}`}>
      {!embedded && <div className="pro-nav"><button type="button" onClick={() => navigate('/professionals')}><Icon name="chevronLeft" /><span>{p('My athletes')}</span></button></div>}
      <PageHeader className="gc-header" eyebrow={p('Community')} title={p('Groups')} description={p('Create and manage community groups for your athletes, share challenges, and build team spirit.')} />

      <div className="gc-toolbar">
        <div className="gc-search-box"><Field label={p('Search groups')}><Input name="groupSearch" type="search" value={search} placeholder={p('Search groups…')} onChange={event => setSearch(event.target.value)} /></Field></div>
        <Button variant="primary" icon="plus" onClick={() => { setShowCreateModal(true); setCreateError(null) }}>{p('New group')}</Button>
      </div>

      {error ? (
        <ErrorState title={p('Unable to load groups')} text={error} action={<Button variant="primary" onClick={() => loadGroups()}>{p('Try again')}</Button>} />
      ) : loading ? (
        <div className="gc-card-list" aria-label={p('Loading groups…')}><SkeletonCard /><SkeletonCard /></div>
      ) : filteredGroups.length === 0 ? (
        <EmptyState icon="person" title={search ? p('No matching groups') : p('No groups created yet')} text={search ? p('Try a different search term.') : p('Create your first group to start building a community with your athletes.')} action={!search && <Button variant="primary" onClick={() => setShowCreateModal(true)}>{p('Create group')}</Button>} />
      ) : (
        <div className="gc-card-list">
          {filteredGroups.map(group => {
            const memberCount = group.memberCount || 0
            const maxMembers = group.maxMembers || 50
            const percentage = Math.min(100, Math.round((memberCount / maxMembers) * 100))
            const isFull = memberCount >= maxMembers
            return (
              <Card key={group.id} className="gc-card">
                <div className="gc-card-title-group"><h3>{group.name}</h3><div className="gc-badge-row">{group.category && <Badge>{group.category}</Badge>}<Badge tone={group.archivedAt ? 'neutral' : 'success'}>{group.archivedAt ? p('Archived') : p('Active')}</Badge>{group.isPrivate && <Badge>{p('Private')}</Badge>}</div></div>
                {group.description && <p className="pro-routine-note">{group.description}</p>}
                <div className="gc-capacity-meter"><span>{memberCount} / {maxMembers} {p('Members')}</span><div className="gc-progress-bar" role="progressbar" aria-label={p('Group capacity')} aria-valuemin="0" aria-valuemax={maxMembers} aria-valuenow={memberCount}><div className={`gc-progress-fill ${isFull ? 'full' : ''}`} style={{ width: `${percentage}%` }} /></div>{isFull && <Badge tone="warning">{p('Full')}</Badge>}</div>
                <div className="gc-card-actions"><Button size="sm" icon="person" onClick={() => openGroupDetails(group.id)}>{p('Group details')}</Button></div>
              </Card>
            )
          })}
          {page?.hasMore && <div className="pro-actions"><Button size="sm" loading={loadingMore} loadingLabel={p('Loading…')} onClick={() => loadGroups(page.nextCursor)}>{p('Load more')}</Button></div>}
        </div>
      )}

      {selectedGroupId && (
        <Modal id="group-details" title={groupDetails?.group?.name || p('Group details')} closeLabel={p('Close')} onClose={() => { setSelectedGroupId(null); setGroupDetails(null) }}>
          {loadingDetails || !groupDetails ? <div className="gc-details-skeleton" role="status" aria-label={p('Loading group details…')}><Skeleton width="54%" height="1rem" /><Skeleton width="100%" height="5rem" /><Skeleton width="100%" height="8rem" /></div> : (
            <div className="pro-modal-form">
              {groupDetails.group?.description && <p className="pro-routine-note">{groupDetails.group.description}</p>}
              <Surface className="gc-invite-box"><div><span className="pro-kicker">{p('Invite code')}</span><div className="gc-invite-code">{groupDetails.group?.invite?.code || groupDetails.group?.inviteCode || p('No active code')}</div></div><div className="gc-inline-actions"><Button size="sm" icon="copy" onClick={() => handleCopyInvite(groupDetails.group?.invite?.code || groupDetails.group?.inviteCode)}>{copiedCode ? p('Copied!') : p('Copy code')}</Button><Button size="sm" icon="arrowPath" loading={rotatingInvite} loadingLabel={p('Rotating code…')} onClick={handleRotateInvite}>{p('Rotate code')}</Button></div></Surface>
              <div className="gc-members-head"><strong>{p('Members')} ({groupDetails.members?.length || 0} / {groupDetails.group?.maxMembers || 50})</strong><Button size="sm" variant="primary" icon="plus" onClick={handleOpenAddMember}>{p('Add athlete')}</Button></div>
              <div className="gc-member-list">{(!groupDetails.members || groupDetails.members.length === 0) ? <div className="pro-empty-inline">{p('No members in this group yet.')}</div> : groupDetails.members.map(member => <Surface key={member.id} className="gc-member-row"><div className="gc-member-info"><span className="gc-member-name">{member.displayName || member.athleteName || member.name || p('Athlete')}</span><span className="gc-member-meta">{member.role === 'moderator' ? p('Moderator') : p('Member')} · {member.status === 'pending' ? p('Pending') : p('Active')}</span></div><Button size="sm" variant="destructive" onClick={() => setMemberToRemove(member)}>{p('Remove member')}</Button></Surface>)}</div>
              {groupDetails.page?.hasMore && (
                <div className="pro-actions">
                  <Button size="sm" loading={loadingMoreMembers} loadingLabel={p('Loading…')} onClick={handleLoadMoreMembers}>
                    {p('Load more members')}
                  </Button>
                </div>
              )}
            </div>
          )}
        </Modal>
      )}

      {showCreateModal && (
        <Modal id="create-group" title={p('New group')} closeLabel={p('Close')} onClose={() => setShowCreateModal(false)}>
          <form className="pro-modal-form" onSubmit={handleCreateSubmit}>
            {createError && <Alert tone="error">{createError}</Alert>}
            <Field label={p('Group name')} required><Input name="name" value={createForm.name} onChange={event => setCreateForm(previous => ({ ...previous, name: event.target.value }))} placeholder={p('Example: Barbell Elite Club')} autoFocus /></Field>
            <Field label={p('Description')} help={p('Describe the focus and expectations for this group.')}><Textarea name="description" value={createForm.description} onChange={event => setCreateForm(previous => ({ ...previous, description: event.target.value }))} placeholder={p('Explain the focus, goals, or community guidelines…')} rows={3} /></Field>
            <Field label={p('Category')}><Input name="category" value={createForm.category} onChange={event => setCreateForm(previous => ({ ...previous, category: event.target.value }))} placeholder={p('Example: Powerlifting, Hypertrophy')} /></Field>
            <Field label={p('Max members')} help={p('Choose a limit between 1 and 500 athletes.')} error={!isMaxMembersValid ? p('Choose a limit between 1 and 500 athletes.') : undefined}><NumberInput name="maxMembers" value={createForm.maxMembers} onChange={value => setCreateForm(previous => ({ ...previous, maxMembers: value }))} min={1} max={500} /></Field>
            <div className="pro-routine-row"><div><strong>{p('Private group')}</strong><p className="pro-routine-note">{p('Require invite code or direct invitation to join.')}</p></div><Switch aria-label={p('Private group')} checked={createForm.isPrivate} onChange={value => setCreateForm(previous => ({ ...previous, isPrivate: value }))} /></div>
            <div className="pro-actions"><Button type="button" onClick={() => setShowCreateModal(false)}>{p('Cancel')}</Button><Button type="submit" variant="primary" loading={creating} loadingLabel={p('Creating…')} disabled={!createForm.name.trim() || !isMaxMembersValid}>{p('Create group')}</Button></div>
          </form>
        </Modal>
      )}

      {showAddMemberModal && (
        <Modal id="add-member" title={p('Add athlete')} closeLabel={p('Close')} onClose={() => setShowAddMemberModal(false)}>
          <div className="pro-modal-form">
            {addMemberError && <Alert tone="error">{addMemberError}</Alert>}
            <p className="pro-routine-note">{p('Search among your active athletes with training scope to invite them into this group.')}</p>
            <Field label={p('Search athlete')}><Input name="athleteSearch" type="search" value={athleteQuery} placeholder={p('Type athlete name…')} onChange={event => { setAthleteQuery(event.target.value); setSelectedAthlete(null) }} /></Field>
            {loadingAthletes ? <div className="gc-athlete-skeleton" role="status" aria-label={p('Loading athletes…')}><Skeleton height="2.75rem" /><Skeleton height="2.75rem" /></div> : <div className="gc-autocomplete-dropdown gc-autocomplete-static">{filteredAthletes.length === 0 ? <div className="pro-empty-inline">{p('No active training athletes found.')}</div> : filteredAthletes.map(athlete => { const isSelected = selectedAthlete?.id === athlete.id; return <button key={athlete.id} type="button" className={`gc-autocomplete-option ${isSelected ? 'selected' : ''}`} aria-pressed={isSelected} onClick={() => setSelectedAthlete(athlete)}><strong>{athlete.name}</strong>{isSelected && <Icon name="checkmark" />}</button> })}</div>}
            {selectedAthlete && <Alert tone="info" className="gc-selected-athlete">{p('Selected')}: <strong>{selectedAthlete.name}</strong></Alert>}
            <div className="pro-actions"><Button type="button" onClick={() => setShowAddMemberModal(false)}>{p('Cancel')}</Button><Button type="button" variant="primary" loading={addingMember} loadingLabel={p('Adding…')} disabled={!selectedAthlete} onClick={handleAddMemberSubmit}>{p('Add athlete')}</Button></div>
          </div>
        </Modal>
      )}

      {memberToRemove && <Modal id="remove-member-confirm" title={p('Remove member')} closeLabel={p('Close')} onClose={() => setMemberToRemove(null)}><div className="pro-modal-form"><p>{p('Are you sure you want to remove this member?')}<br /><strong>{memberToRemove.displayName || memberToRemove.athleteName || memberToRemove.name}</strong></p><div className="pro-actions"><Button type="button" onClick={() => setMemberToRemove(null)}>{p('Cancel')}</Button><Button type="button" variant="destructive" loading={removingMember} loadingLabel={p('Removing…')} onClick={handleConfirmRemoveMember}>{p('Remove member')}</Button></div></div></Modal>}
    </Container>
  )
}
