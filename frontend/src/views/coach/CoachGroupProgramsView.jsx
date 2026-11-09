import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useUI } from '../../store/useUI.js'
import { professionalError, professionalText as p } from '../../lib/professional-copy.js'
import {
  listCoachGroupPrograms,
  createCoachGroupProgram,
  publishCoachGroupProgram,
  archiveCoachGroupProgram,
  listCoachGroups,
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

const blankExercise = () => ({
  name: '',
  sets: 3,
  reps: '8-12',
  load: '',
  restSeconds: 60,
  notes: '',
})

const blankRoutine = () => ({
  name: '',
  notes: '',
  divisions: [
    { name: 'A', exercises: [blankExercise()] },
    { name: 'B', exercises: [blankExercise()] },
  ],
})

export default function CoachGroupProgramsView({ embedded = false }) {
  const toast = useUI(state => state.toast)
  const navigate = useNavigate()
  const location = useLocation()

  const queryGroupId = useMemo(() => {
    return new URLSearchParams(location.search).get('groupId') || 'all'
  }, [location.search])

  const [programs, setPrograms] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [page, setPage] = useState(null)
  const [loadingMore, setLoadingMore] = useState(false)

  // Groups for filter and creation
  const [groups, setGroups] = useState([])
  const [selectedGroupId, setSelectedGroupId] = useState(queryGroupId)

  // Create Program Modal state
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState(null)
  const [createForm, setCreateForm] = useState({
    groupId: queryGroupId !== 'all' ? queryGroupId : '',
    title: '',
  })
  const [routine, setRoutine] = useState(blankRoutine)

  // Publish / Archive Confirmation Modal
  const [programToPublish, setProgramToPublish] = useState(null)
  const [publishing, setPublishing] = useState(false)
  const [programToArchive, setProgramToArchive] = useState(null)
  const [archiving, setArchiving] = useState(false)

  // View Details Modal
  const [viewProgram, setViewProgram] = useState(null)

  // Load Programs
  const loadPrograms = useCallback(async (cursor = null) => {
    if (!cursor) setLoading(true)
    else setLoadingMore(true)
    setError(null)

    try {
      const res = await listCoachGroupPrograms({ cursor, limit: 30 })
      if (cursor) {
        setPrograms(prev => [...prev, ...(res.programs || [])])
      } else {
        setPrograms(res.programs || [])
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
    loadPrograms()
  }, [loadPrograms])

  // Load Groups
  useEffect(() => {
    listCoachGroups().then(res => {
      const loaded = res?.groups || []
      setGroups(loaded)
      if (queryGroupId && queryGroupId !== 'all') {
        setSelectedGroupId(queryGroupId)
      }
    }).catch(() => {})
  }, [queryGroupId])

  // Routine editor helpers
  const updateDivision = (dIndex, next) => {
    setRoutine(prev => ({
      ...prev,
      divisions: prev.divisions.map((d, i) => (i === dIndex ? next : d)),
    }))
  }

  const addDivision = () => {
    if (routine.divisions.length >= 12) return
    const letter = String.fromCharCode(65 + routine.divisions.length)
    setRoutine(prev => ({
      ...prev,
      divisions: [...prev.divisions, { name: letter, exercises: [blankExercise()] }],
    }))
  }

  const removeDivision = dIndex => {
    if (routine.divisions.length <= 1) return
    setRoutine(prev => ({
      ...prev,
      divisions: prev.divisions.filter((_, i) => i !== dIndex),
    }))
  }

  const updateExercise = (dIndex, eIndex, next) => {
    const division = routine.divisions[dIndex]
    updateDivision(dIndex, {
      ...division,
      exercises: division.exercises.map((ex, i) => (i === eIndex ? next : ex)),
    })
  }

  const addExercise = dIndex => {
    const division = routine.divisions[dIndex]
    if (division.exercises.length >= 40) return
    updateDivision(dIndex, {
      ...division,
      exercises: [...division.exercises, blankExercise()],
    })
  }

  const removeExercise = (dIndex, eIndex) => {
    const division = routine.divisions[dIndex]
    if (division.exercises.length <= 1) return
    updateDivision(dIndex, {
      ...division,
      exercises: division.exercises.filter((_, i) => i !== eIndex),
    })
  }

  // Handle Create Program Submit
  const handleCreateSubmit = async e => {
    e?.preventDefault?.()
    if (!createForm.title.trim()) {
      setCreateError(p('Enter a program title.'))
      return
    }
    if (!createForm.groupId) {
      setCreateError(p('Select a group for this collective program.'))
      return
    }

    const routineName = routine.name.trim() || createForm.title.trim()
    const formattedDivisions = routine.divisions.map((div, dIdx) => ({
      id: `division_${dIdx + 1}`,
      name: div.name.trim() || `Divisão ${dIdx + 1}`,
      exercises: div.exercises.map((ex, eIdx) => ({
        id: `exercise_${dIdx + 1}_${eIdx + 1}`,
        catalogueId: ex.catalogueId || '',
        name: ex.name.trim(),
        sets: Number(ex.sets) || 3,
        reps: ex.reps.trim() || '8-12',
        load: ex.load?.trim() || '',
        restSeconds: Number(ex.restSeconds) || 60,
        notes: ex.notes?.trim() || '',
      })),
    }))

    const invalid = formattedDivisions.some(div =>
      div.exercises.some(ex => !ex.name.trim())
    )
    if (invalid) {
      setCreateError(p('Every exercise must have a name.'))
      return
    }

    const payload = {
      groupId: createForm.groupId,
      title: createForm.title.trim(),
      routine: {
        name: routineName,
        notes: routine.notes?.trim() || '',
        divisions: formattedDivisions,
      },
    }

    setCreating(true)
    setCreateError(null)

    try {
      await createCoachGroupProgram(payload)
      toast(p('Collective program created successfully.'))
      setShowCreateModal(false)
      setCreateForm({ groupId: groups[0]?.id || '', title: '' })
      setRoutine(blankRoutine())
      loadPrograms()
    } catch (err) {
      setCreateError(professionalError(err))
    } finally {
      setCreating(false)
    }
  }

  // Handle Publish Program
  const handlePublishConfirm = async () => {
    if (!programToPublish || publishing) return
    setPublishing(true)
    try {
      await publishCoachGroupProgram(programToPublish.id)
      toast(p('Collective program published! Version is now immutable.'))
      setProgramToPublish(null)
      loadPrograms()
    } catch (err) {
      toast(professionalError(err))
    } finally {
      setPublishing(false)
    }
  }

  // Handle Archive Program
  const handleArchiveConfirm = async () => {
    if (!programToArchive || archiving) return
    setArchiving(true)
    try {
      await archiveCoachGroupProgram(programToArchive.id)
      toast(p('Collective program archived.'))
      setProgramToArchive(null)
      loadPrograms()
    } catch (err) {
      toast(professionalError(err))
    } finally {
      setArchiving(false)
    }
  }

  // Filtered Programs
  const filteredPrograms = useMemo(() => {
    if (selectedGroupId === 'all') return programs
    return programs.filter(prg => prg.groupId === selectedGroupId)
  }, [programs, selectedGroupId])

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
        title={p('Collective programs')}
        description={p('Design and publish routine series for entire groups. Once published, versions are immutable.')}
      />

      {/* Toolbar */}
      <div className="gc-toolbar">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span>{p('Group')}:</span>
          <Select
            name="groupFilter"
            value={selectedGroupId}
            onChange={e => setSelectedGroupId(e.target.value)}
            style={{ minHeight: 44, padding: '0 12px' }}
          >
            <option value="all">{p('All groups')}</option>
            {groups.map(g => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))}
          </Select>
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
                groupId: selectedGroupId !== 'all' ? selectedGroupId : groups[0].id,
              }))
            }
          }}
        >
          {p('New collective program')}
        </Button>
      </div>

      {error ? (
        <ErrorState
          title={p('Unable to load groups')}
          text={error}
          action={<Button variant="primary" onClick={() => loadPrograms()}>{p('Try again')}</Button>}
        />
      ) : loading ? (
        <div className="gc-card-list" aria-label={p('Loading groups…')}>
          <SkeletonCard />
          <SkeletonCard />
        </div>
      ) : filteredPrograms.length === 0 ? (
        <EmptyState
          icon="calendar"
          title={p('No collective programs yet')}
          text={p('Create workout templates and publish them for your community groups.')}
          action={
            <Button
              variant="primary"
              onClick={() => {
                setShowCreateModal(true)
                if (groups.length > 0 && !createForm.groupId) {
                  setCreateForm(prev => ({
                    ...prev,
                    groupId: selectedGroupId !== 'all' ? selectedGroupId : groups[0].id,
                  }))
                }
              }}
            >
              {p('New collective program')}
            </Button>
          }
        />
      ) : (
        <div className="gc-card-list">
          {filteredPrograms.map(prg => {
            const groupMatch = groups.find(g => g.id === prg.groupId)
            const divisions = prg.routine?.divisions || []
            return (
              <Card key={prg.id} className="gc-card">
                <div className="gc-card-header">
                  <div className="gc-card-title-group">
                    <h3>{prg.title}</h3>
                    <div className="gc-badge-row">
                      <Badge
                        tone={
                          prg.status === 'published'
                            ? 'success'
                            : prg.status === 'draft'
                              ? 'warning'
                              : 'neutral'
                        }
                      >
                        {prg.status === 'draft'
                          ? p('Draft')
                          : prg.status === 'published'
                            ? p('Published')
                            : p('Archived')}
                      </Badge>
                      <Badge>v{prg.version || 1}</Badge>
                      {groupMatch && <Badge>{groupMatch.name}</Badge>}
                    </div>
                  </div>
                </div>

                {/* Routine divisions preview */}
                <div className="gc-program-preview">
                  {divisions.map((div, idx) => (
                    <div key={div.id || idx} className="gc-division-preview">
                      <strong>{div.name}:</strong>
                      <span>{div.exercises?.length || 0} {p('exercises')}</span>
                    </div>
                  ))}
                </div>

                <div className="gc-card-actions">
                  <Button size="sm" onClick={() => setViewProgram(prg)}>
                    {p('View details')}
                  </Button>
                  {prg.status === 'draft' && (
                    <Button size="sm" variant="primary" onClick={() => setProgramToPublish(prg)}>
                      {p('Publish version')}
                    </Button>
                  )}
                  {prg.status !== 'archived' && (
                    <Button size="sm" variant="destructive" onClick={() => setProgramToArchive(prg)}>
                      {p('Archive program')}
                    </Button>
                  )}
                </div>
              </Card>
            )
          })}

          {page?.hasMore && (
            <div className="pro-actions">
              <Button size="sm" loading={loadingMore} loadingLabel={p('Loading…')} onClick={() => loadPrograms(page.nextCursor)}>
                {p('Load more')}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Program Details Modal */}
      {viewProgram && (
        <Modal
          id="view-program"
          title={viewProgram.title}
          closeLabel={p('Close')}
          onClose={() => setViewProgram(null)}
        >
          <div className="pro-modal-form">
            <div className="gc-badge-row">
              <Badge tone={viewProgram.status === 'published' ? 'success' : 'neutral'}>
                {viewProgram.status}
              </Badge>
              <Badge>v{viewProgram.version || 1}</Badge>
            </div>

            {viewProgram.routine?.notes && (
              <p className="pro-routine-note">{viewProgram.routine.notes}</p>
            )}

            <div className="pro-divisions">
              {(viewProgram.routine?.divisions || []).map((div, dIdx) => (
                <Surface key={div.id || dIdx} className="pro-division-summary" style={{ padding: 12, marginBottom: 10 }}>
                  <h4>{div.name}</h4>
                  <div className="pro-exercise-list">
                    {(div.exercises || []).map((ex, eIdx) => (
                      <div key={ex.id || eIdx} className="pro-exercise-summary" style={{ padding: '6px 0', borderBottom: '1px solid var(--separator)' }}>
                        <strong>{ex.name}</strong>
                        <div>
                          <span>{ex.sets} {p('sets')} · {ex.reps} {p('reps')} · {ex.restSeconds}s {p('rest')}</span>
                          {ex.load && <span> · {p('Load') || 'Carga'}: {ex.load}</span>}
                        </div>
                        {ex.notes && <small style={{ color: 'var(--label-2)' }}>{ex.notes}</small>}
                      </div>
                    ))}
                  </div>
                </Surface>
              ))}
            </div>
          </div>
        </Modal>
      )}

      {/* Create Program Modal */}
      {showCreateModal && (
        <Modal
          id="create-program"
          title={p('New collective program')}
          closeLabel={p('Close')}
          onClose={() => setShowCreateModal(false)}
        >
          <form onSubmit={handleCreateSubmit} className="pro-modal-form">
            {createError && <Alert tone="error">{createError}</Alert>}

            <Field label={p('Program title')} required>
              <Input
                name="title"
                value={createForm.title}
                maxLength={120}
                placeholder={p('Example: 12-Week Group Strength')}
                onChange={e => setCreateForm(prev => ({ ...prev, title: e.target.value }))}
                autoFocus
              />
            </Field>

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

            <Field label={p('Notes for group athletes…')}>
              <Textarea
                name="notes"
                rows={2}
                maxLength={1000}
                value={routine.notes}
                placeholder={p('Notes for group athletes…')}
                onChange={e => setRoutine(prev => ({ ...prev, notes: e.target.value }))}
              />
            </Field>

            {/* Divisions & Exercises Builder */}
            <div style={{ marginTop: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h4>{p('Divisions')} (A/B/C)</h4>
                <Button size="sm" type="button" onClick={addDivision}>
                  + {p('Division')}
                </Button>
              </div>

              <div className="pro-division-editors">
                {routine.divisions.map((div, dIdx) => (
                  <Surface key={dIdx} className="pro-division-editor" style={{ padding: 12, margin: '10px 0', borderRadius: 'var(--r-sm)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                      <Field label={p('Division name')} style={{ flex: 1, margin: 0 }}>
                        <Input
                          name={`division-name-${dIdx}`}
                          value={div.name}
                          maxLength={80}
                          onChange={e => updateDivision(dIdx, { ...div, name: e.target.value })}
                        />
                      </Field>
                      {routine.divisions.length > 1 && (
                        <Button
                          size="sm"
                          variant="destructive"
                          type="button"
                          style={{ marginTop: 18 }}
                          onClick={() => removeDivision(dIdx)}
                        >
                          {p('Remove')}
                        </Button>
                      )}
                    </div>

                    {div.exercises.map((ex, eIdx) => (
                      <div key={eIdx} className="pro-exercise-editor" style={{ marginTop: 10, padding: 8, background: 'var(--surface-2)', borderRadius: 'var(--r-xs)' }}>
                        <div className="pro-editor-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                          <strong>{p('Exercise')} {eIdx + 1}</strong>
                          {div.exercises.length > 1 && (
                            <Button
                              size="sm"
                              variant="destructive"
                              type="button"
                              onClick={() => removeExercise(dIdx, eIdx)}
                            >
                              {p('Remove')}
                            </Button>
                          )}
                        </div>

                        <Field label={p('Exercise name')} required>
                          <Input
                            name={`ex-name-${dIdx}-${eIdx}`}
                            value={ex.name}
                            placeholder={p('Example: Barbell Squat')}
                            onChange={e => updateExercise(dIdx, eIdx, { ...ex, name: e.target.value })}
                          />
                        </Field>

                        <div className="pro-grid-fields" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 6 }}>
                          <Field label={p('sets')}>
                            <NumberInput
                              decimal={false}
                              value={ex.sets}
                              onChange={val => updateExercise(dIdx, eIdx, { ...ex, sets: val })}
                            />
                          </Field>
                          <Field label={p('Repetitions')}>
                            <Input
                              name={`ex-reps-${dIdx}-${eIdx}`}
                              value={ex.reps}
                              placeholder="8-12"
                              onChange={e => updateExercise(dIdx, eIdx, { ...ex, reps: e.target.value })}
                            />
                          </Field>
                        </div>
                      </div>
                    ))}

                    <Button
                      size="sm"
                      type="button"
                      style={{ marginTop: 8 }}
                      onClick={() => addExercise(dIdx)}
                    >
                      + {p('Add exercise')}
                    </Button>
                  </Surface>
                ))}
              </div>
            </div>

            <div className="pro-actions" style={{ marginTop: 16 }}>
              <Button type="button" onClick={() => setShowCreateModal(false)}>
                {p('Cancel')}
              </Button>
              <Button type="submit" variant="primary" loading={creating} loadingLabel={p('Creating…')} disabled={creating || !createForm.title.trim()}>
                {p('Save draft')}
              </Button>
            </div>
          </form>
        </Modal>
      )}

      {/* Publish Confirm Modal */}
      {programToPublish && (
        <Modal
          id="publish-confirm"
          title={p('Publish version')}
          closeLabel={p('Close')}
          onClose={() => setProgramToPublish(null)}
        >
          <div className="pro-modal-form">
            <p>
              {p('Publishing this collective program will freeze it into an immutable version accessible to group athletes.')}
              <br />
              <strong>{programToPublish.title} (v{programToPublish.version || 1})</strong>
            </p>
            <div className="pro-actions" style={{ marginTop: 16 }}>
              <Button type="button" onClick={() => setProgramToPublish(null)}>
                {p('Cancel')}
              </Button>
              <Button
                type="button"
                variant="primary"
                loading={publishing}
                loadingLabel={p('Publishing…')}
                onClick={handlePublishConfirm}
              >
                {p('Publish version')}
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {/* Archive Confirm Modal */}
      {programToArchive && (
        <Modal
          id="archive-confirm"
          title={p('Archive program')}
          closeLabel={p('Close')}
          onClose={() => setProgramToArchive(null)}
        >
          <div className="pro-modal-form">
            <p>
              {p('Are you sure you want to archive this collective program? Existing adoptions will be preserved.')}
              <br />
              <strong>{programToArchive.title}</strong>
            </p>
            <div className="pro-actions" style={{ marginTop: 16 }}>
              <Button type="button" onClick={() => setProgramToArchive(null)}>
                {p('Cancel')}
              </Button>
              <Button
                type="button"
                variant="destructive"
                loading={archiving}
                loadingLabel={p('Archiving…')}
                onClick={handleArchiveConfirm}
              >
                {p('Archive program')}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </Container>
  )
}
