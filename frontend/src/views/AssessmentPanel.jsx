import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, apiUpload } from '../lib/api.js'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { professionalError, professionalText as p } from '../lib/professional-copy.js'
import { confirmSheet } from '../sheets.jsx'
import { Button, TextArea, TextField } from '../components/ui.jsx'

const SITES = {
  pollock3: { male: ['chest', 'abdomen', 'thigh'], female: ['triceps', 'suprailiac', 'thigh'] },
  pollock7: { male: ['chest', 'midaxillary', 'triceps', 'subscapular', 'abdomen', 'suprailiac', 'thigh'], female: ['chest', 'midaxillary', 'triceps', 'subscapular', 'abdomen', 'suprailiac', 'thigh'] },
  faulkner4: { male: ['triceps', 'subscapular', 'suprailiac', 'abdomen'], female: ['triceps', 'subscapular', 'suprailiac', 'abdomen'] },
}
const SITE_LABEL = { chest: 'Chest', abdomen: 'Abdomen', thigh: 'Thigh', triceps: 'Triceps', suprailiac: 'Suprailiac', midaxillary: 'Midaxillary', subscapular: 'Subscapular' }
const ANAMNESIS_LABEL = { healthHistory: 'Relevant health history', injuries: 'Injuries', medications: 'Medications', goals: 'Goals', contraindications: 'Contraindications' }
const CIRCUMFERENCES = ['chest', 'waist', 'hip', 'arm', 'thigh', 'calf', 'neck']
const isoMinute = () => {
  const now = new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
  return now.toISOString().slice(0, 16)
}
const empty = () => ({
  assessedAt: isoMinute(), weightKg: '', heightCm: '', protocol: 'pollock3', sex: 'male', age: '',
  skinfolds: {}, circumferences: {}, bodyFatPercent: '', muscleMassKg: '', waterPercent: '', visceralFat: '',
  parq: [], parqNotes: '', acknowledged: false, healthHistory: '', injuries: '', medications: '', goals: '', contraindications: '', notes: '', photos: [],
})
const formatNumber = value => value == null ? '–' : new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value)
const formatDate = value => value ? new Date(value).toLocaleString() : '–'

function Metric({ label, value, unit = '' }) {
  return <div className="assessment-metric"><span>{label}</span><strong>{formatNumber(value)}{value == null ? '' : unit}</strong></div>
}

function AssessmentDetail({ item, onDelete, onEdit, athlete }) {
  return <article className="assessment-detail card">
    <div className="pro-link-head"><div><h3>{formatDate(item.assessedAt)}</h3><div className="pro-meta">{p('By {0}', item.coach?.name || p('Unavailable account'))}</div></div>
      {item.requiresMedicalClearance && <span className="pro-status assessment-alert">{p('Medical clearance required')}</span>}</div>
    {item.requiresMedicalClearance && <p className="assessment-warning" role="alert">{item.medicalClearanceNotice || p('A positive PAR-Q answer requires evaluation and clearance by a qualified health professional before physical activity. This is not a diagnosis.')}</p>}
    <div className="assessment-metrics">
      <Metric label={p('Weight')} value={item.weightKg} unit=" kg" /><Metric label={p('Height')} value={item.heightCm} unit=" cm" />
      <Metric label={p('Body fat')} value={item.results?.bodyFatPercent ?? item.bioimpedance?.bodyFatPercent} unit="%" />
      <Metric label={p('Lean mass')} value={item.results?.leanMassKg} unit=" kg" />
    </div>
    {item.circumferences && <dl className="assessment-values">{Object.entries(item.circumferences).map(([key, value]) => <div key={key}><dt>{p(SITE_LABEL[key] || key)}</dt><dd>{formatNumber(value)} cm</dd></div>)}</dl>}
    {item.parq && <div className="assessment-notes"><strong>PAR-Q {item.parq.version}</strong><ul className="assessment-parq-list">{item.parq.answers.map(answer => <li key={answer.questionId}><span>{answer.text}</span><strong>{p(answer.answer ? 'Yes' : 'No')}</strong></li>)}</ul>{item.parq.notes && <p><strong>{p('PAR-Q notes')}</strong><br />{item.parq.notes}</p>}</div>}
    {item.anamnesis && <div className="assessment-notes">{Object.entries(item.anamnesis).filter(([, value]) => value).map(([key, value]) => <p key={key}><strong>{p(ANAMNESIS_LABEL[key] || key)}</strong><br />{value}</p>)}</div>}
    {item.notes && <p className="assessment-notes"><strong>{p('Notes')}</strong><br />{item.notes}</p>}
    {item.photos?.length > 0 && <div className="assessment-photos">{item.photos.map(photo => <img key={photo.hash} src={photo.url} alt={p('Assessment progress photo')} loading="lazy" />)}</div>}
    <div className="pro-actions">{!athlete && <Button size="sm" onClick={() => onEdit(item)}>{p('Correct assessment')}</Button>}
      <Button size="sm" variant="danger" onClick={() => onDelete(item)}>{p('Delete assessment')}</Button></div>
  </article>
}

function Evolution({ assessments }) {
  const rows = useMemo(() => assessments.slice().sort((a, b) => Date.parse(a.assessedAt) - Date.parse(b.assessedAt)).map((item, index, all) => {
    const previous = all[index - 1]
    const fat = item.results?.bodyFatPercent ?? item.bioimpedance?.bodyFatPercent
    const previousFat = previous?.results?.bodyFatPercent ?? previous?.bioimpedance?.bodyFatPercent
    const delta = (value, before) => value == null || before == null ? null : Math.round((value - before) * 100) / 100
    return {
      item, fat,
      weightDelta: delta(item.weightKg, previous?.weightKg),
      fatDelta: delta(fat, previousFat),
      leanDelta: delta(item.results?.leanMassKg, previous?.results?.leanMassKg),
      waistDelta: delta(item.circumferences?.waist, previous?.circumferences?.waist),
      hipDelta: delta(item.circumferences?.hip, previous?.circumferences?.hip),
      armDelta: delta(item.circumferences?.arm, previous?.circumferences?.arm),
    }
  }), [assessments])
  const valueWithDelta = (value, delta, unit = '') => <>{formatNumber(value)}{value == null ? '' : unit}<span className="assessment-delta">{delta == null ? '–' : `${delta > 0 ? '+' : ''}${formatNumber(delta)}${unit}`}</span></>
  if (!rows.length) return null
  return <section className="assessment-evolution" aria-labelledby="assessment-evolution-title"><h3 id="assessment-evolution-title">{p('Evolution')}</h3>
    <p className="assessment-evolution-help">{p('Each metric shows its value and change from the previous assessment.')}</p>
    <div className="assessment-table-wrap"><table><thead><tr><th>{p('Date')}</th><th>{p('Weight')}</th><th>{p('Body fat')}</th><th>{p('Lean mass')}</th><th>{p('Waist')}</th><th>{p('Hip')}</th><th>{p('Arm')}</th></tr></thead>
      <tbody>{rows.map(({ item, weightDelta, fatDelta, leanDelta, waistDelta, hipDelta, armDelta, fat }) => <tr key={item.id}><td>{new Date(item.assessedAt).toLocaleDateString()}</td><td>{valueWithDelta(item.weightKg, weightDelta, ' kg')}</td><td>{valueWithDelta(fat, fatDelta, '%')}</td><td>{valueWithDelta(item.results?.leanMassKg, leanDelta, ' kg')}</td><td>{valueWithDelta(item.circumferences?.waist, waistDelta, ' cm')}</td><td>{valueWithDelta(item.circumferences?.hip, hipDelta, ' cm')}</td><td>{valueWithDelta(item.circumferences?.arm, armDelta, ' cm')}</td></tr>)}</tbody></table></div>
  </section>
}

function AssessmentForm({ athleteId, config, initial, onSaved, onCancel }) {
  const toast = useUI(state => state.toast)
  const mediaConfig = useStore(state => state.config?.media)
  const [form, setForm] = useState(() => initial ? fromAssessment(initial) : empty())
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const sites = SITES[form.protocol][form.sex]
  const set = (key, value) => setForm(current => ({ ...current, [key]: value }))
  const setMap = (key, field, value) => setForm(current => ({ ...current, [key]: { ...current[key], [field]: value } }))
  const questions = config?.parq?.questions || []
  useEffect(() => setForm(current => ({ ...current, parq: questions.map((_, index) => current.parq[index] || false) })), [questions])

  const pickPhotos = async event => {
    const files = [...event.target.files].slice(0, Math.max(0, 6 - form.photos.length))
    if (!files.length) return
    setUploading(true)
    try {
      const { ingestMediaFile } = await import('../lib/media-ingest.js')
      const { limitsFrom } = await import('../lib/media-limits.js')
      const added = []
      for (const file of files) {
        const output = await ingestMediaFile(file, limitsFrom({ media: mediaConfig || {} }))
        if (output.media.kind !== 'image') throw Object.assign(new Error('image required'), { code: 'media-type' })
        for (const blob of output.blobs) await apiUpload(`/api/media/${blob.hash}`, blob.blob, blob.mime)
        added.push(output.media)
      }
      setForm(current => ({ ...current, photos: [...current.photos, ...added].slice(0, 6) }))
    } catch (error) { toast(professionalError(error)) }
    finally { setUploading(false); event.target.value = '' }
  }

  const save = async () => {
    if (!form.weightKg || !form.heightCm || !form.age || sites.some(site => !form.skinfolds[site])) return toast(p('Complete date, weight, height, age and required skinfolds.'))
    if (form.parq.some(Boolean) && !form.acknowledged) return toast(p('Record that the PAR-Q guidance was presented before saving.'))
    setSaving(true)
    try {
      const skinfolds = { protocol: form.protocol, ...Object.fromEntries(sites.map(site => [site, Number(form.skinfolds[site])])) }
      if (form.protocol !== 'faulkner4') Object.assign(skinfolds, { sex: form.sex, age: Number(form.age) })
      const compactNumbers = values => Object.fromEntries(Object.entries(values).filter(([, value]) => value !== '').map(([key, value]) => [key, Number(value)]))
      const bioimpedance = compactNumbers({ bodyFatPercent: form.bodyFatPercent, muscleMassKg: form.muscleMassKg, waterPercent: form.waterPercent, visceralFat: form.visceralFat })
      const body = {
        assessedAt: new Date(form.assessedAt).toISOString(), weightKg: Number(form.weightKg), heightCm: Number(form.heightCm), skinfolds,
        circumferences: compactNumbers(form.circumferences), ...(Object.keys(bioimpedance).length ? { bioimpedance } : {}),
        parq: { version: config.parq.version, answers: questions.map((question, index) => ({ questionId: question.id, answer: !!form.parq[index] })), notes: form.parqNotes.trim(), acknowledged: form.acknowledged },
        anamnesis: { healthHistory: form.healthHistory.trim(), injuries: form.injuries.trim(), medications: form.medications.trim(), goals: form.goals.trim(), contraindications: form.contraindications.trim() },
        notes: form.notes.trim(), photos: form.photos.map(({ kind, hash, mime, size, width, height }) => ({ kind, hash, mime, size, width, height })),
      }
      const route = `/api/coach/athletes/${athleteId}/assessments${initial ? `/${initial.id}` : ''}`
      const result = await api(route, { method: initial ? 'PATCH' : 'POST', body: JSON.stringify(body) })
      onSaved(result.assessment, initial)
      toast(initial ? p('Assessment corrected.') : p('Assessment saved.'))
    } catch (error) { toast(professionalError(error)) }
    finally { setSaving(false) }
  }

  return <section className="card assessment-form" aria-label={p(initial ? 'Correct assessment' : 'New physical assessment')}>
    <div className="pro-editor-title"><h3>{p(initial ? 'Correct assessment' : 'New physical assessment')}</h3>{onCancel && <Button size="sm" onClick={onCancel}>{p('Cancel')}</Button>}</div>
    <div className="assessment-form-grid">
      <label className="pro-field"><span>{p('Assessment date')}</span><TextField name="assessedAt" type="datetime-local" value={form.assessedAt} onChange={event => set('assessedAt', event.target.value)} /></label>
      <label className="pro-field"><span>{p('Weight (kg)')}</span><TextField name="weightKg" type="number" min="1" max="500" step="0.1" value={form.weightKg} onChange={event => set('weightKg', event.target.value)} /></label>
      <label className="pro-field"><span>{p('Height (cm)')}</span><TextField name="heightCm" type="number" min="30" max="300" step="0.1" value={form.heightCm} onChange={event => set('heightCm', event.target.value)} /></label>
      <label className="pro-field"><span>{p('Age')}</span><TextField name="age" type="number" min="1" max="120" value={form.age} onChange={event => set('age', event.target.value)} /></label>
      <label className="pro-field"><span>{p('Skinfold protocol')}</span><select name="protocol" value={form.protocol} onChange={event => set('protocol', event.target.value)}><option value="pollock3">Pollock 3</option><option value="pollock7">Pollock 7</option><option value="faulkner4">Faulkner 4</option></select></label>
      {form.protocol !== 'faulkner4' && <label className="pro-field"><span>{p('Sex used by formula')}</span><select name="sex" value={form.sex} onChange={event => set('sex', event.target.value)}><option value="male">{p('Male')}</option><option value="female">{p('Female')}</option></select></label>}
    </div>
    <fieldset><legend>{p('Required skinfolds (mm)')}</legend><div className="assessment-form-grid">{sites.map(site => <label className="pro-field" key={site}><span>{p(SITE_LABEL[site])}</span><TextField name={`skinfold-${site}`} type="number" min="0.1" max="100" step="0.1" value={form.skinfolds[site] || ''} onChange={event => setMap('skinfolds', site, event.target.value)} /></label>)}</div></fieldset>
    <fieldset><legend>{p('Circumferences (cm)')}</legend><div className="assessment-form-grid">{CIRCUMFERENCES.map(site => <label className="pro-field" key={site}><span>{p(SITE_LABEL[site] || site)}</span><TextField name={`circumference-${site}`} type="number" min="1" max="300" step="0.1" value={form.circumferences[site] || ''} onChange={event => setMap('circumferences', site, event.target.value)} /></label>)}</div></fieldset>
    <fieldset><legend>{p('Bioimpedance')}</legend><div className="assessment-form-grid">{[['bodyFatPercent', 'Body fat (%)'], ['muscleMassKg', 'Muscle mass (kg)'], ['waterPercent', 'Water (%)'], ['visceralFat', 'Visceral fat']].map(([key, label]) => <label className="pro-field" key={key}><span>{p(label)}</span><TextField name={key} type="number" min="0" step="0.1" value={form[key]} onChange={event => set(key, event.target.value)} /></label>)}</div></fieldset>
    <fieldset><legend>PAR-Q {config?.parq?.version}</legend>{questions.map((question, index) => <label className="assessment-question" key={question.id}><input type="checkbox" checked={!!form.parq[index]} onChange={event => set('parq', form.parq.map((answer, answerIndex) => answerIndex === index ? event.target.checked : answer))} /><span>{question.text}</span></label>)}
      {form.parq.some(Boolean) && <div className="assessment-warning" role="alert">{p('A positive PAR-Q answer requires evaluation and clearance by a qualified health professional before physical activity. This is not a diagnosis.')}<label className="assessment-question"><input type="checkbox" checked={form.acknowledged} onChange={event => set('acknowledged', event.target.checked)} /><span>{p('I recorded that this guidance was presented.')}</span></label></div>}
      <label className="pro-field"><span>{p('PAR-Q notes')}</span><TextArea value={form.parqNotes} maxLength={1000} onChange={event => set('parqNotes', event.target.value)} /></label></fieldset>
    <fieldset><legend>{p('Anamnesis')}</legend>{[['healthHistory', 'Relevant health history', 2000], ['injuries', 'Injuries', 2000], ['medications', 'Medications', 1000], ['goals', 'Goals', 1000], ['contraindications', 'Contraindications', 1000]].map(([key, label, max]) => <label className="pro-field" key={key}><span>{p(label)}</span><TextArea name={key} rows={2} maxLength={max} value={form[key]} onChange={event => set(key, event.target.value)} /></label>)}</fieldset>
    <label className="pro-field"><span>{p('Notes')}</span><TextArea name="assessmentNotes" rows={3} maxLength={2000} value={form.notes} onChange={event => set('notes', event.target.value)} /></label>
    {!!mediaConfig && <div className="assessment-upload"><label className="btn">{uploading ? p('Processing photos…') : p('Add progress photos')}<input type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/avif" multiple disabled={uploading || form.photos.length >= 6} onChange={pickPhotos} /></label><span>{p('{0} of 6 photos', form.photos.length)}</span></div>}
    {form.photos.length > 0 && <div className="assessment-photo-refs">{form.photos.map(photo => <button type="button" key={photo.hash} onClick={() => set('photos', form.photos.filter(item => item.hash !== photo.hash))}>{p('Remove photo')} · {photo.hash.slice(0, 8)}</button>)}</div>}
    <Button variant="primary" disabled={saving || uploading} onClick={save}>{saving ? p('Saving…') : p(initial ? 'Save correction' : 'Save assessment')}</Button>
  </section>
}

function fromAssessment(item) {
  const form = empty()
  const skinfolds = item.skinfolds || {}
  return { ...form, assessedAt: new Date(Date.parse(item.assessedAt) - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16), weightKg: item.weightKg ?? '', heightCm: item.heightCm ?? '', protocol: skinfolds.protocol || 'pollock3', sex: skinfolds.sex || 'male', age: skinfolds.age || '', skinfolds, circumferences: item.circumferences || {}, bodyFatPercent: item.bioimpedance?.bodyFatPercent ?? '', muscleMassKg: item.bioimpedance?.muscleMassKg ?? '', waterPercent: item.bioimpedance?.waterPercent ?? '', visceralFat: item.bioimpedance?.visceralFat ?? '', parq: item.parq?.answers?.map(answer => !!answer.answer) || [], parqNotes: item.parq?.notes || '', acknowledged: !!item.parq?.acknowledged, ...item.anamnesis, notes: item.notes || '', photos: item.photos || [] }
}

export default function AssessmentPanel({ athleteId, athlete = false }) {
  const toast = useUI(state => state.toast)
  const [assessments, setAssessments] = useState(null)
  const [config, setConfig] = useState(null)
  const [error, setError] = useState(null)
  const [editing, setEditing] = useState(null)
  const route = athlete ? '/api/athlete/assessments' : `/api/coach/athletes/${athleteId}/assessments`
  const load = useCallback(async () => {
    setError(null)
    try {
      const [history, settings] = await Promise.all([api(route), api('/api/assessments/config')])
      setAssessments(history.assessments || []); setConfig(settings)
    } catch (loadError) { setError(loadError) }
  }, [route])
  useEffect(() => { load() }, [load])
  const remove = item => confirmSheet({ title: p('Delete this assessment?'), message: p('This permanently removes the assessment and its photo references. This action is audited.'), confirmText: p('Delete assessment'), danger: true, onConfirm: async () => {
    try {
      const target = athlete ? `/api/athlete/assessments/${item.id}` : `${route}/${item.id}`
      await api(target, { method: 'DELETE', ...(athlete ? { body: JSON.stringify({ confirmation: item.id }) } : {}) })
      setAssessments(current => current.filter(assessment => assessment.id !== item.id)); if (editing?.id === item.id) setEditing(null)
    } catch (error) { toast(professionalError(error)) }
  } })
  if (error) {
    const message = error.status ? professionalError(error) : p('Could not load physical assessments.')
    return <div className="pro-load-inline" role="alert"><span>{message}</span><Button size="sm" onClick={load}>{p('Try again')}</Button></div>
  }
  if (!assessments || !config) return <div className="pro-loading">{p('Loading…')}</div>
  return <section className="assessment-panel" aria-labelledby={`assessment-title-${athleteId || 'own'}`}><div className="pro-panel-head"><strong id={`assessment-title-${athleteId || 'own'}`}>{p('Physical assessments')}</strong>{!athlete && !editing && <Button size="sm" icon="plus" onClick={() => setEditing(true)}>{p('New assessment')}</Button>}</div>
    {!athlete && editing && <AssessmentForm athleteId={athleteId} config={config} initial={editing === true ? null : editing} onCancel={() => setEditing(null)} onSaved={(saved, previous) => { setAssessments(current => previous ? current.map(item => item.id === saved.id ? saved : item) : [saved, ...current]); setEditing(null) }} />}
    {assessments.length === 0 ? <p className="pro-empty-inline">{p('No physical assessments yet.')}</p> : <><Evolution assessments={assessments} /><div className="assessment-history">{assessments.map(item => <AssessmentDetail key={item.id} item={item} athlete={athlete} onEdit={setEditing} onDelete={remove} />)}</div></>}
  </section>
}
