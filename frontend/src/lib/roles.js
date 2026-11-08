import { useEffect, useState } from 'react'

const ROLE_STORAGE_KEY_PREFIX = 'prfit_active_role_'
const GLOBAL_ROLE_STORAGE_KEY = 'prfit_active_role'
const ROLE_CHANGE_EVENT = 'prfit_role_change'

/**
 * Returns the base role for a user: 'coach' | 'athlete'.
 */
export function getUserBaseRole(user) {
  if (!user) return 'athlete'
  if (user.profile?.kind === 'coach') return 'coach'
  return 'athlete'
}

/**
 * Checks whether the user has dual-role capabilities (can toggle between Coach and Athlete).
 * In PR Fit, professional coaches have dual role (they can manage athletes as Coach
 * and also train/view the app as an Athlete).
 */
export function isDualRoleUser(user) {
  if (!user) return false
  if (user.profile?.kind === 'coach') return true
  if (user.profile?.dualRole || user.isDualRole) return true
  return false
}

/**
 * Gets the active persistent role for the user ('coach' | 'athlete').
 */
export function getActiveRole(user) {
  if (!user) return 'athlete'
  if (!isDualRoleUser(user)) {
    return getUserBaseRole(user)
  }
  const storageKey = user.id ? `${ROLE_STORAGE_KEY_PREFIX}${user.id}` : GLOBAL_ROLE_STORAGE_KEY
  try {
    const saved = localStorage.getItem(storageKey)
    if (saved === 'coach' || saved === 'athlete') {
      return saved
    }
  } catch {
    // localStorage might not be accessible
  }
  return getUserBaseRole(user)
}

/**
 * Sets and persists the active role for a user.
 */
export function setActiveRole(user, role) {
  if (role !== 'coach' && role !== 'athlete') return
  const storageKey = user?.id ? `${ROLE_STORAGE_KEY_PREFIX}${user.id}` : GLOBAL_ROLE_STORAGE_KEY
  try {
    localStorage.setItem(storageKey, role)
    localStorage.setItem(GLOBAL_ROLE_STORAGE_KEY, role)
  } catch {
    // ignore storage errors
  }
  window.dispatchEvent(new CustomEvent(ROLE_CHANGE_EVENT, { detail: { userId: user?.id, role } }))
}

/**
 * Clears active role storage keys (both global and per-user) from localStorage.
 */
export function clearRoleStorage() {
  try {
    const keysToRemove = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key && (key === GLOBAL_ROLE_STORAGE_KEY || key.startsWith(ROLE_STORAGE_KEY_PREFIX))) {
        keysToRemove.push(key)
      }
    }
    for (const key of keysToRemove) {
      localStorage.removeItem(key)
    }
  } catch {
    // localStorage might not be accessible
  }
}

export const clearActiveRoleStorage = clearRoleStorage


/**
 * React hook that returns [activeRole, setActiveRole, isDualRole].
 * Automatically updates when the role changes from anywhere in the app.
 */
export function useActiveRole(user) {
  const [role, setRoleState] = useState(() => getActiveRole(user))

  useEffect(() => {
    setRoleState(getActiveRole(user))
  }, [user?.id, user?.profile?.kind])

  useEffect(() => {
    const handleRoleChange = event => {
      if (!event.detail || !user || event.detail.userId === user.id || !event.detail.userId) {
        setRoleState(getActiveRole(user))
      }
    }
    window.addEventListener(ROLE_CHANGE_EVENT, handleRoleChange)
    window.addEventListener('storage', handleRoleChange)
    return () => {
      window.removeEventListener(ROLE_CHANGE_EVENT, handleRoleChange)
      window.removeEventListener('storage', handleRoleChange)
    }
  }, [user])

  const setRole = nextRole => {
    setActiveRole(user, nextRole)
    setRoleState(nextRole)
  }

  const dual = isDualRoleUser(user)
  return [role, setRole, dual]
}
