import React, { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../../store/useStore.js'
import { useUI } from '../../store/useUI.js'
import { professionalError, professionalText as p } from '../../lib/professional-copy.js'
import {
  listAthleteGroupPrograms,
  adoptGroupProgram,
  generateIdempotencyKey,
} from '../../lib/group-challenges-api.js'
import Icon from '../../components/Icon.jsx'
import EmptyState from '../../components/EmptyState.jsx'
import { Button } from '../../components/ui.jsx'
import AccessibleModal from '../AccessibleModal.jsx'
import '../GroupChallenges.css'

export default function AthleteGroupProgramsView({ embedded = false }) {
  const user = useStore(state => state.user)
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

  return (
    <div className={`gc-page ${embedded ? 'embedded' : 'narrow'}`}>
      {!embedded && (
        <div className="pro-nav">
          <button type="button" onClick={() => navigate('/community')}>
            <Icon name="chevronLeft" />
            <span>{p('Community')}</span>
          </button>
        </div>
      )}

      <header className="pro-hero gc-header">
        <div>
          <span className="pro-kicker">{p('Community')}</span>
          <h1>{p('Collective programs')}</h1>
          <p>{p('Explore training programs published by your coach for your community groups, and adopt them into your training plan.')}</p>
        </div>
        <Icon name="calendar" />
      </header>

      {error && (
        <div className="card gc-alert error" role="alert">
          <span>{error}</span>
          <Button size="sm" onClick={() => loadPrograms()}>{p('Try again')}</Button>
        </div>
      )}

      {loading ? (
        <div className="gc-card-list">
          <div className="gc-skeleton-card" />
          <div className="gc-skeleton-card" />
        </div>
      ) : programs.length === 0 ? (
        <EmptyState
          icon="calendar"
          title={p('No collective programs available')}
          description={p('Programs published by your coach in your community groups will appear here.')}
        />
      ) : (
        <div className="gc-card-list">
          {programs.map(prg => {
            const divisions = prg.routine?.divisions || []
            return (
              <article key={prg.id} className="gc-card">
                <div className="gc-card-header">
                  <div className="gc-card-title-group">
                    <h3>{prg.title}</h3>
                    <div className="gc-badge-row">
                      <span className="gc-badge">v{prg.version || 1}</span>
                      {prg.group?.name && <span className="gc-badge">{prg.group.name}</span>}
                      {prg.coach?.name && <span className="gc-badge">{p('Coach')}: {prg.coach.name}</span>}
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
                  <Button size="sm" variant="accent" onClick={() => { setProgramToAdopt(prg); setAdoptError(null); }}>
                    {p('Adopt program')}
                  </Button>
                  <Button size="sm" variant="plain" onClick={() => setViewProgram(prg)}>
                    {p('View details') || 'View details'}
                  </Button>
                </div>
              </article>
            )
          })}

          {page?.hasMore && (
            <div className="pro-actions">
              <Button size="sm" disabled={loadingMore} onClick={() => loadPrograms(page.nextCursor)}>
                {loadingMore ? p('Loading…') : p('Load more')}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Program Details Modal */}
      {viewProgram && (
        <AccessibleModal
          id="athlete-view-program"
          title={viewProgram.title}
          onClose={() => setViewProgram(null)}
        >
          <div className="pro-modal-form">
            <div className="gc-badge-row">
              <span className="gc-badge">v{viewProgram.version || 1}</span>
              {viewProgram.group?.name && <span className="gc-badge">{viewProgram.group.name}</span>}
            </div>

            {viewProgram.routine?.notes && (
              <p className="pro-routine-note">{viewProgram.routine.notes}</p>
            )}

            <div className="pro-divisions">
              {(viewProgram.routine?.divisions || []).map((div, dIdx) => (
                <section key={div.id || dIdx} className="pro-division-summary">
                  <h4>{div.name}</h4>
                  <div className="pro-exercise-list">
                    {(div.exercises || []).map((ex, eIdx) => (
                      <div key={ex.id || eIdx} className="pro-exercise-summary">
                        <strong>{ex.name}</strong>
                        <span>{ex.sets} {p('sets')} · {ex.reps} {p('reps')} · {ex.restSeconds}s {p('rest')}</span>
                        {ex.load && <span>{p('Load')}: {ex.load}</span>}
                        {ex.notes && <small>{ex.notes}</small>}
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </div>

            <div className="pro-actions" style={{ marginTop: 16 }}>
              <Button
                variant="accent"
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
        </AccessibleModal>
      )}

      {/* Adopt Program Confirmation Modal */}
      {programToAdopt && (
        <AccessibleModal
          id="adopt-program-confirm"
          title={p('Adopt program')}
          onClose={() => setProgramToAdopt(null)}
        >
          <div className="pro-modal-form">
            {adoptError && (
              <div className="gc-alert error" role="alert">
                <span>{adoptError}</span>
              </div>
            )}

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
                variant="accent"
                disabled={adopting}
                onClick={handleAdoptConfirm}
              >
                {adopting ? p('Adopting…') : p('Confirm adoption') || 'Confirm adoption'}
              </Button>
            </div>
          </div>
        </AccessibleModal>
      )}
    </div>
  )
}
