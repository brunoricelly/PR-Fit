// A starter plan the athlete asked for themselves (no coach). The server already validated every exercise
// against the allow-list; this turns each division into a routine of the app, in the shape the workout
// screen reads. Nothing here trusts the plan's own flags beyond the exercise ids, checked again below.
import { LIB_BY_ID_SAFE } from './self-ai-ids.js'

const REPS_RANGE = /^(\d+)\s*-\s*(\d+)$/

export function repsConfig(reps) {
  const text = String(reps || '').trim()
  const range = REPS_RANGE.exec(text)
  if (range && Number(range[1]) > 0 && Number(range[2]) >= Number(range[1])) return { reps: Number(range[2]), repsMin: Number(range[1]) }
  if (/^\d+$/.test(text) && Number(text) > 0) return { reps: Number(text) }
  return { reps: 10 }
}

/** The routines to add for a server plan, or null when anything in it cannot be placed. */
export function routinesFromPlan(plan, makeId, existingIds = new Set(), knowsExercise = LIB_BY_ID_SAFE) {
  const divisions = plan?.divisions
  if (!Array.isArray(divisions) || !divisions.length) return null
  const used = new Set(existingIds)
  const out = []
  for (const division of divisions) {
    const list = Array.isArray(division?.exercises) ? division.exercises : []
    if (!list.length) return null
    const ex = []
    for (const e of list) {
      const id = String(e?.catalogueId ?? e?.id ?? '')
      if (!id || !knowsExercise(id)) return null
      const sets = Number(e.sets)
      if (!Number.isInteger(sets) || sets < 1 || sets > 8) return null
      const rest = Number(e.restSeconds)
      ex.push({ id, sets, ...repsConfig(e.reps), weight: 0, mode: 'reps', ...(rest > 0 ? { restSec: rest } : { restSec: 0, restOff: true }) })
    }
    let id = makeId()
    while (used.has(id)) id = makeId()
    used.add(id)
    out.push({ id, name: String(division.name || 'Treino').slice(0, 60), ex })
  }
  return out
}
