import React, { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useUI } from '../../store/useUI.js'
import { professionalError, professionalText as p } from '../../lib/professional-copy.js'
import {
  listAthleteGroupPrograms,
  adoptGroupProgram,
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
  Modal,
  PageHeader,
  SkeletonCard,
  Surface,
} from '../../components/design-system.jsx'
import '../GroupChallenges.css'
import '../coach/CoachGroupsView.css'

export default function AthleteGroupProgramsView({ embedded = false, headingLevel }) {
  const toast = useUI(state => state.toast)
  const navigate = useNavigate()

  const [programs, setPrograms] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [page, setPage] = useState(null)
  const [loadingMore, setLoadingMore] = useState(false)

  // Adoption Confirmation Modal state
  const [programToAdopt, setProgramToAdopt] = useState(null)
  const [adopting, setAdopting] = useState(false)
  const [adoptError, setAdoptError] = useState(null)

  // View Details Modal
  const [viewProgram, setViewProgram] = useState(null)

  // Load available group programs
  const loadPrograms = useCallback(async (cursor = null) => {
    if (!cursor) setLoading(true)
    else setLoadingMore(true)
    setError(null)

    try {
      const res = await listAthleteGroupPrograms({ cursor, limit: 30 })
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

  // Handle program adoption with confirmation
  const handleAdoptConfirm = async () => {
    if (!programToAdopt || adopting) return
    setAdopting(true)
    setAdoptError(null)

    try {
      const key = generateIdempotencyKey('adopt')
      await adoptGroupProgram(programToAdopt.id, {
        confirmExistingPlan: true,
        idempotencyKey: key,
      })
      toast(p('Collective program adopted successfully! Your routines have been updated.'))
      setProgramToAdopt(null)
    } catch (err) {
      setAdoptError(professionalError(err))
    } finally {
      setAdopting(false)
    }
  }

  const Container = 'div'

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
        description={p('Explore training programs published by your coach for your community groups, and adopt them into your training plan.')}
        headingLevel={headingLevel ?? (embedded ? 2 : 1)}
      />

      {error ? (
        <ErrorState
          title={p('Unable to load groups')}
          text={error}
          action={<Button variant="primary" onClick={() => loadPrograms()}>{p('Try again')}</Button>}
        />
      ) : loading ? (
        <div className="gc-card-list" aria-busy="true">
          <span className="sr-only" role="status">{p('Loading programs…')}</span>
          <SkeletonCard />
          <SkeletonCard />
        </div>
      ) : programs.length === 0 ? (
        <EmptyState
          icon="calendar"
          title={p('No collective programs available')}
          text={p('Programs published by your coach in your community groups will appear here.')}
        />
      ) : (
        <div className="gc-card-list">
          {programs.map(prg => {
            const divisions = prg.routine?.divisions || []
            return (
              <Card key={prg.id} className="gc-card">
                <div className="gc-card-header">
                  <div className="gc-card-title-group">
                    <h3>{prg.title}</h3>
                    <div className="gc-badge-row">
                      <Badge>v{prg.version || 1}</Badge>
                      {prg.group?.name && <Badge>{prg.group.name}</Badge>}
                      {prg.coach?.name && <Badge>{p('Coach')}: {prg.coach.name}</Badge>}
                    </div>
                  </div>
                </div>

                {prg.routine?.notes && (
                  <p className="pro-routine-note">{prg.routine.notes}</p>
                )}

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
                  <Button size="sm" variant="primary" onClick={() => { setProgramToAdopt(prg); setAdoptError(null) }}>
                    {p('Adopt program')}
                  </Button>
                  <Button size="sm" onClick={() => setViewProgram(prg)}>
                    {p('View details')}
                  </Button>
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
          id="athlete-view-program"
          title={viewProgram.title}
          closeLabel={p('Close')}
          onClose={() => setViewProgram(null)}
        >
          <div className="pro-modal-form">
            <div className="gc-badge-row">
              <Badge>v{viewProgram.version || 1}</Badge>
              {viewProgram.group?.name && <Badge>{viewProgram.group.name}</Badge>}
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

            <div className="pro-actions" style={{ marginTop: 16 }}>
              <Button
                variant="primary"
                onClick={() => {
                  setProgramToAdopt(viewProgram)
                  setViewProgram(null)
                  setAdoptError(null)
                }}
              >
                {p('Adopt program')}
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {/* Adopt Program Confirmation Modal */}
      {programToAdopt && (
        <Modal
          id="adopt-program-confirm"
          title={p('Adopt program')}
          closeLabel={p('Close')}
          onClose={() => setProgramToAdopt(null)}
        >
          <div className="pro-modal-form">
            {adoptError && <Alert tone="error">{adoptError}</Alert>}

            <p>
              {p('Adopting this collective program will add its routines to your workout plan and may overwrite conflicting routines.')}
              <br />
              <strong>{programToAdopt.title} (v{programToAdopt.version || 1})</strong>
            </p>

            <div className="pro-actions" style={{ marginTop: 16 }}>
              <Button type="button" onClick={() => setProgramToAdopt(null)}>
                {p('Cancel')}
              </Button>
              <Button
                type="button"
                variant="primary"
                loading={adopting}
                loadingLabel={p('Adopting…')}
                onClick={handleAdoptConfirm}
              >
                {p('Confirm adoption')}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </Container>
  )
}
