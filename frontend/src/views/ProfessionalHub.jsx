import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { api } from '../lib/api.js'
import { copyText } from '../lib/clipboard.js'
import { dateLocale } from '../lib/i18n.js'
import { professionalText as p } from '../lib/professional-copy.js'
import { confirmSheet } from '../sheets.jsx'
import Icon from '../components/Icon.jsx'
import EmptyState from '../components/EmptyState.jsx'
import { Button, TextField } from '../components/ui.jsx'
import './ProfessionalHub.css'

const scopeLabel = scope => scope === 'nutrition' ? p('Nutrition') : p('Training')
const statusLabel = status => ({
  pending: p('Pending'), active: p('Active'), suspended: p('Suspended'), ended: p('Ended'),
}[status] || status)
const formatDate = value => value ? new Date(value).toLocaleDateString(dateLocale()) : ''

function Choice({ active, children, onClick }) {
  return <button type="button" className={'pro-choice' + (active ? ' on' : '')} aria-pressed={active} onClick={onClick}>{children}</button>
}

function ScopeChoices({ allowed, value, onChange }) {
  const toggle = scope => onChange(value.includes(scope) ? value.filter(item => item !== scope) : [...value, scope])
  return <div className="pro-choices" role="group" aria-label={p('Authorized scope')}>
    {allowed.map(scope => <Choice key={scope} active={value.includes(scope)} onClick={() => toggle(scope)}>{scopeLabel(scope)}</Choice>)}
  </div>
}

function ProfileSetup({ user }) {
  const setUser = useStore(state => state.setUser)
  const toast = useUI(state => state.toast)
  const current = user.profile?.kind || 'athlete'
  const [kind, setKind] = useState(current)
  const [specialties, setSpecialties] = useState(user.profile?.coachSpecialties || [])
  const [saving, setSaving] = useState(false)
  const dirty = kind !== current || JSON.stringify(specialties) !== JSON.stringify(user.profile?.coachSpecialties || [])

  const chooseKind = next => {
    setKind(next)
    if (next === 'athlete') setSpecialties([])
  }
  const save = async () => {
    if (kind === 'coach' && !specialties.length) return toast(p('Choose at least one specialty.'))
    setSaving(true)
    try {
      const result = await api('/api/profile', {
        method: 'POST',
        body: JSON.stringify({ kind, coachSpecialties: kind === 'coach' ? specialties : [] }),
      })
      setUser(result.user)
      toast(p('Profile saved.'))
    } catch (error) { toast(error.message) }
    finally { setSaving(false) }
  }

  return <section className="card pro-profile" aria-labelledby="pro-profile-title">
    <div className="card-head">
      <span className="card-head-g"><Icon name="personCircle" /></span>
      <div className="card-head-copy"><div className="card-head-title" id="pro-profile-title">{p('How do you use PR Fit?')}</div>
        <div className="card-head-sub">{p('This choice never grants platform administration.')}</div></div>
    </div>
    <div className="pro-choices" role="group" aria-label={p('Profile type')}>
      <Choice active={kind === 'athlete'} onClick={() => chooseKind('athlete')}>{p('Athlete')}</Choice>
      <Choice active={kind === 'coach'} onClick={() => chooseKind('coach')}>{p('Professional')}</Choice>
    </div>
    {kind === 'coach' && <>
      <div className="pro-label">{p('Specialties')}</div>
      <ScopeChoices allowed={['training', 'nutrition']} value={specialties} onChange={setSpecialties} />
    </>}
    {(!user.profile || dirty) && <Button variant="primary" disabled={saving} onClick={save}>{saving ? p('Saving…') : p('Save profile')}</Button>}
  </section>
}

function RelationshipCard({ link, side, onStatus, canSuspend, canEnd }) {
  const person = side === 'coach' ? link.athlete : link.coach
  const title = person?.name || (link.status === 'pending' ? p('Invitation pending') : p('Unavailable account'))
  return <article className="card pro-link" data-status={link.status}>
    <div className="pro-link-head">
      <div><h2>{title}</h2><div className="pro-meta">{link.scopes.map(scopeLabel).join(' · ')}</div></div>
      <span className={'pro-status ' + link.status}>{statusLabel(link.status)}</span>
    </div>
    <div className="pro-dates">
      {link.acceptedAt && <span>{p('Accepted {0}', formatDate(link.acceptedAt))}</span>}
      {link.expiresAt && link.status === 'pending' && <span>{p('Expires {0}', formatDate(link.expiresAt))}</span>}
      {link.endedAt && <span>{p('Ended {0}', formatDate(link.endedAt))}</span>}
    </div>
    {(canSuspend || canEnd) && <div className="pro-actions">
      {canSuspend && <Button size="sm" onClick={() => onStatus(link, 'suspended')}>{p('Suspend')}</Button>}
      {canEnd && <Button size="sm" variant="danger" onClick={() => onStatus(link, 'ended')}>{p('End relationship')}</Button>}
    </div>}
  </article>
}

function CoachPortfolio({ user }) {
  const toast = useUI(state => state.toast)
  const [links, setLinks] = useState(null)
  const [scopes, setScopes] = useState(() => user.profile.coachSpecialties.slice(0, 1))
  const [creating, setCreating] = useState(false)
  const [freshInvite, setFreshInvite] = useState(null)
  const capabilities = new Set(user.capabilities || [])
  const canInvite = capabilities.has('relationships:invite')

  const load = () => api('/api/coach/athletes').then(result => setLinks(result.links || [])).catch(error => toast(error.message))
  useEffect(() => { load() }, [user.id])

  const createInvite = async () => {
    if (!scopes.length) return toast(p('Choose at least one scope.'))
    setCreating(true)
    try {
      const result = await api('/api/coach/invites', { method: 'POST', body: JSON.stringify({ scopes, expiresInDays: 7 }) })
      setFreshInvite(result.invite)
      await load()
    } catch (error) { toast(error.message) }
    finally { setCreating(false) }
  }
  const copyInvite = async () => {
    if (await copyText(freshInvite.token)) toast(p('Invitation copied.'))
  }
  const status = (link, next) => confirmSheet({
    title: next === 'ended' ? p('End this relationship?') : p('Suspend this relationship?'),
    message: next === 'ended'
      ? p('Future professional access is blocked. The athlete keeps their training data.')
      : p('Professional access is blocked until a future reactivation flow.'),
    confirmText: next === 'ended' ? p('End relationship') : p('Suspend'),
    danger: true,
    onConfirm: async () => {
      try {
        const result = await api('/api/coach/links/status', { method: 'POST', body: JSON.stringify({ linkId: link.id, status: next }) })
        setLinks(current => current.map(item => item.id === link.id ? { ...item, ...result.link } : item))
      } catch (error) { toast(error.message) }
    },
  })

  return <>
    {canInvite && <section className="card pro-invite" aria-labelledby="pro-invite-title">
      <h2 id="pro-invite-title">{p('Invite an athlete')}</h2>
      <p>{p('Choose what this relationship authorizes. The athlete must accept explicitly.')}</p>
      <ScopeChoices allowed={user.profile.coachSpecialties} value={scopes} onChange={setScopes} />
      <Button variant="primary" disabled={creating || !scopes.length} onClick={createInvite}>{creating ? p('Creating…') : p('Create invitation')}</Button>
      {freshInvite && <div className="pro-token" role="status">
        <div><strong>{p('Share this code once')}</strong><span>{p('It expires {0}.', formatDate(freshInvite.expiresAt))}</span></div>
        <code>{freshInvite.token}</code>
        <Button size="sm" icon="copy" onClick={copyInvite}>{p('Copy invitation')}</Button>
      </div>}
    </section>}
    <section aria-labelledby="pro-list-title">
      <h2 className="pro-section-title" id="pro-list-title">{p('Portfolio')}</h2>
      {links === null ? <div className="pro-loading">{p('Loading…')}</div>
        : links.length === 0 ? <EmptyState icon="person" title={p('No athletes yet')} text={p('Create an invitation to start your portfolio.')} />
          : <div className="pro-list">{links.map(link => <RelationshipCard key={link.id} link={link} side="coach" onStatus={status}
            canSuspend={link.status === 'active' && capabilities.has('relationships:suspend')}
            canEnd={link.status !== 'ended' && capabilities.has('relationships:end')} />)}</div>}
    </section>
  </>
}

function AthleteProfessionals({ initialToken }) {
  const toast = useUI(state => state.toast)
  const [links, setLinks] = useState(null)
  const [token, setToken] = useState(initialToken || '')
  const [accepting, setAccepting] = useState(false)
  const load = () => api('/api/athlete/coaches').then(result => setLinks(result.links || [])).catch(error => toast(error.message))
  useEffect(() => { load() }, [])

  const accept = async () => {
    if (!token.trim()) return
    setAccepting(true)
    try {
      await api('/api/coach/invites/accept', { method: 'POST', body: JSON.stringify({ token: token.trim() }) })
      setToken('')
      toast(p('Invitation accepted.'))
      await load()
    } catch (error) { toast(error.message) }
    finally { setAccepting(false) }
  }
  const end = link => confirmSheet({
    title: p('End this relationship?'),
    message: p('The professional loses future access. Your training data stays with you.'),
    confirmText: p('End relationship'), danger: true,
    onConfirm: async () => {
      try {
        const result = await api('/api/coach/links/status', { method: 'POST', body: JSON.stringify({ linkId: link.id, status: 'ended' }) })
        setLinks(current => current.map(item => item.id === link.id ? { ...item, ...result.link } : item))
      } catch (error) { toast(error.message) }
    },
  })

  return <>
    <section className="card pro-accept" aria-labelledby="pro-accept-title">
      <h2 id="pro-accept-title">{p('Accept an invitation')}</h2>
      <p>{p('Opening an invitation never grants access by itself. Review it and accept here.')}</p>
      <label className="pro-field"><span>{p('Invitation code')}</span>
        <TextField name="inviteToken" value={token} onChange={event => setToken(event.target.value)} autoComplete="off" spellCheck="false" /></label>
      <Button variant="primary" disabled={accepting || !token.trim()} onClick={accept}>{accepting ? p('Accepting…') : p('Accept invitation')}</Button>
    </section>
    <section aria-labelledby="pro-list-title">
      <h2 className="pro-section-title" id="pro-list-title">{p('Linked professionals')}</h2>
      {links === null ? <div className="pro-loading">{p('Loading…')}</div>
        : links.length === 0 ? <EmptyState icon="personCircle" title={p('No linked professionals')} text={p('When you accept an invitation, the professional and authorized scope appear here.')} />
          : <div className="pro-list">{links.map(link => <RelationshipCard key={link.id} link={link} side="athlete" onStatus={end}
            canSuspend={false} canEnd={link.status !== 'ended'} />)}</div>}
    </section>
  </>
}

export default function ProfessionalHub() {
  const user = useStore(state => state.user)
  const location = useLocation()
  const navigate = useNavigate()
  const initialToken = useMemo(() => new URLSearchParams(location.search).get('invite') || '', [])
  useEffect(() => {
    if (initialToken && location.search) navigate('/professionals', { replace: true })
  }, [initialToken, location.search, navigate])
  if (!user) return null
  const coach = user.profile?.kind === 'coach'
  return <main className="narrow pro-page">
    <div className="pro-nav"><button data-back="/settings" onClick={() => navigate('/settings')}><Icon name="chevronLeft" />{p('Settings')}</button></div>
    <header className="pro-hero"><div><span className="pro-kicker">{p('Professional relationships')}</span>
      <h1>{coach ? p('My athletes') : p('My professionals')}</h1>
      <p>{coach ? p('Access depends on an accepted relationship and its authorized scope.') : p('You control which professionals are linked to your account.')}</p></div>
      <Icon name={coach ? 'person' : 'shield'} />
    </header>
    <ProfileSetup user={user} />
    {coach ? <CoachPortfolio user={user} /> : <AthleteProfessionals initialToken={initialToken} />}
  </main>
}
