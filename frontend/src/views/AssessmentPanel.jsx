import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, apiUpload } from '../lib/api.js'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { professionalError, professionalText as p } from '../lib/professional-copy.js'
import { confirmSheet } from '../sheets.jsx'
import { TextArea, TextField } from '../components/ui.jsx'
import {
  Alert, Badge, Button, Card, EmptyState, ErrorState, Field, Input,
  Select, Skeleton, Surface,
} from '../components/design-system.jsx'

const SITES = {
  pollock3: { male: ['chest', 'abdomen', 'thigh'], female: ['triceps', 'suprailiac', 'thigh'] },
  pollock7: { male: ['chest', 'midaxillary', 'triceps', 'subscapular', 'abdomen', 'suprailiac', 'thigh'], female: ['chest', 'midaxillary', 'triceps', 'subscapular', 'abdomen', 'suprailiac', 'thigh'] },
  faulkner4: { male: ['triceps', 'subscapular', 'suprailiac', 'abdomen'], female: ['triceps', 'subscapular', 'suprailiac', 'abdomen'] },
}
const SITE_LABEL = { chest: 'Chest', abdomen: 'Abdomen', thigh: 'Thigh', triceps: 'Triceps', suprailiac: 'Suprailiac', midaxillary: 'Midaxillary', subscapular: 'Subscapular' }
const ANAMNESIS_LABEL = { healthHistory: 'Relevant health history', injuries: 'Injuries', medications: 'Medications', goals: 'Goals', contraindications: 'Contraindications' }
const CIRCUMFERENCES = ['chest', 'waist', 'hip', 'arm', 'thigh', 'calf', 'neck']
const CIRCUMFERENCE_LABEL = { chest: 'Chest', waist: 'Waist', hip: 'Hip', arm: 'Arm', thigh: 'Thigh', calf: 'Calf', neck: 'Neck' }
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
const deltaSign = delta => delta > 0 ? '+' : ''
const deltaColor = delta => delta > 0 ? 'var(--red)' : delta < 0 ? 'var(--green)' : 'var(--label-2)'

function MetricTile({ label, value, unit = '', delta, deltaUnit }) {
  return (
    <div className="assessment-metric">
      <span>{label}</span>
      <strong aria-label={value == null ? p('Not measured') : `${formatNumber(value)}${unit}`}>
        {formatNumber(value)}{value == null ? '' : unit}
      </strong>
      {delta != null && delta !== 0 && (
        <span className="assessment-delta" style={{ color: deltaColor(delta) }} aria-label={`${deltaSign(delta)}${formatNumber(Math.abs(delta))}${deltaUnit || unit}`}>
          {deltaSign(delta)}{formatNumber(Math.abs(delta))}{deltaUnit || unit}
        </span>
      )}
    </div>
  )
}

function AssessmentDetail({ item, onDelete, onEdit, athlete, previous }) {
  const fat = item.results?.bodyFatPercent ?? item.bioimpedance?.bodyFatPercent
  const prevFat = previous?.results?.bodyFatPercent ?? previous?.bioimpedance?.bodyFatPercent
  const dWeight = previous ? Math.round((item.weightKg - previous.weightKg) * 10) / 10 : null
  const dFat = previous && fat != null && prevFat != null ? Math.round((fat - prevFat) * 10) / 10 : null

  return (
    <Card as="article" className="assessment-detail">
      <div className="pro-link-head">
        <div>
          <h3>{formatDate(item.assessedAt)}</h3>
          <div className="pro-meta">{p('By {0}', item.coach?.name || p('Unavailable account'))}</div>
        </div>
        {item.requiresMedicalClearance && <Badge tone="warning">{p('Medical clearance required')}</Badge>}
      </div>
      {item.requiresMedicalClearance && (
        <Alert tone="warning" className="assessment-medical-alert">
          {item.medicalClearanceNotice || p('A positive PAR-Q answer requires evaluation and clearance by a qualified health professional before physical activity. This is not a diagnosis.')}
        </Alert>
      )}
      <div className="assessment-metrics">
        <MetricTile label={p('Weight')} value={item.weightKg} unit=" kg" delta={dWeight} />
        <MetricTile label={p('Height')} value={item.heightCm} unit=" cm" />
        <MetricTile label={p('Body fat')} value={fat} unit="%" delta={dFat} />
        <MetricTile label={p('Lean mass')} value={item.results?.leanMassKg} unit=" kg" />
      </div>
      {item.circumferences && Object.keys(item.circumferences).length > 0 && (
        <dl className="assessment-values" aria-label={p('Circumferences')}>
          {Object.entries(item.circumferences).map(([key, value]) => (
            <div key={key}><dt>{p(CIRCUMFERENCE_LABEL[key] || SITE_LABEL[key] || key)}</dt><dd>{formatNumber(value)} cm</dd></div>
          ))}
        </dl>
      )}
      {item.parq && (
        <div className="assessment-notes">
          <strong>PAR-Q {item.parq.version}</strong>
          <ul className="assessment-parq-list">
            {item.parq.answers.map(answer => (
              <li key={answer.questionId}><span>{answer.text}</span><strong>{p(answer.answer ? 'Yes' : 'No')}</strong></li>
            ))}
          </ul>
          {item.parq.notes && <p><strong>{p('PAR-Q notes')}</strong><br />{item.parq.notes}</p>}
        </div>
      )}
      {item.anamnesis && (
        <div className="assessment-notes">
          {Object.entries(item.anamnesis).filter(([, value]) => value).map(([key, value]) => (
            <p key={key}><strong>{p(ANAMNESIS_LABEL[key] || key)}</strong><br />{value}</p>
          ))}
        </div>
      )}
      {item.notes && <p className="assessment-notes"><strong>{p('Notes')}</strong><br />{item.notes}</p>}
      {item.photos?.length > 0 && (
        <div className="assessment-photos" role="group" aria-label={p('Assessment progress photos')}>
          {item.photos.map(photo => (
            <img key={photo.hash} src={photo.url} alt={p('Assessment progress photo')} loading="lazy" />
          ))}
        </div>
      )}
      <div className="pro-actions">
        {!athlete && <Button size="sm" onClick={() => onEdit(item)}>{p('Correct assessment')}</Button>}
        <Button size="sm" variant="danger" onClick={() => onDelete(item)}>{p('Delete assessment')}</Button>
      </div>
    </Card>
  )
}

function Evolution({ assessments }) {
  const rows = useMemo(() => assessments.slice().sort((a, b) => Date.parse(a.assessedAt) - Date.parse(b.assessedAt)).map((item, index, all) => {
    const previous = all[index - 1]
    const fat = item.results?.bodyFatPercent ?? item.bioimpedance?.bodyFatPercent
    const prevFat = previous ? (previous.results?.bodyFatPercent ?? previous.bioimpedance?.bodyFatPercent) : null
    return {
      id: item.id,
      date: formatDate(item.assessedAt),
      weight: item.weightKg,
      fat,
      lean: item.results?.leanMassKg,
      dWeight: previous ? Math.round((item.weightKg - previous.weightKg) * 10) / 10 : null,
      dFat: fat != null && prevFat != null ? Math.round((fat - prevFat) * 10) / 10 : null,
      circumferences: item.circumferences,
      prevCircumferences: previous?.circumferences,
    }
  }), [assessments])

  if (rows.length < 2) return null

  const circumKeys = [...new Set(rows.flatMap(row => Object.keys(row.circumferences || {})))]

  return (
    <Surface className="assessment-evolution" aria-label={p('Evolution comparison')}>
      <h3>{p('Longitudinal evolution')}</h3>
      <p className="assessment-evolution-help">{p('Compare your progression across assessments. Negative weight or fat deltas may indicate progress depending on your goals.')}</p>
      <div className="assessment-table-wrap" tabIndex={0} role="region" aria-label={p('Evolution table')}>
        <table>
          <thead>
            <tr>
              <th scope="col">{p('Date')}</th>
              <th scope="col">{p('Weight')}</th>
              <th scope="col">{p('Body fat')}</th>
              <th scope="col">{p('Lean mass')}</th>
              {circumKeys.map(key => <th key={key} scope="col">{p(CIRCUMFERENCE_LABEL[key] || SITE_LABEL[key] || key)}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={row.id}>
                <td>{row.date}</td>
                <td>
                  {formatNumber(row.weight)} kg
                  {row.dWeight != null && row.dWeight !== 0 && <span className="assessment-delta" style={{ color: deltaColor(row.dWeight) }}>{deltaSign(row.dWeight)}{row.dWeight} kg</span>}
                </td>
                <td>
                  {row.fat != null ? formatNumber(row.fat) + '%' : '–'}
                  {row.dFat != null && row.dFat !== 0 && <span className="assessment-delta" style={{ color: deltaColor(row.dFat) }}>{deltaSign(row.dFat)}{row.dFat}%</span>}
                </td>
                <td>{row.lean != null ? formatNumber(row.lean) + ' kg' : '–'}</td>
                {circumKeys.map(key => {
                  const value = row.circumferences?.[key]
                  const prev = row.prevCircumferences?.[key]
                  const delta = value != null && prev != null ? Math.round((value - prev) * 10) / 10 : null
                  return (
                    <td key={key}>
                      {value != null ? formatNumber(value) + ' cm' : '–'}
                      {delta != null && delta !== 0 && <span className="assessment-delta" style={{ color: deltaColor(delta) }}>{deltaSign(delta)}{delta} cm</span>}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Surface>
  )
}

function AssessmentForm({ athleteId, config, initial, onCancel, onSaved }) {
  const toast = useUI(state => state.toast)
  const mediaConfig = useStore(state => state.config?.media)
  const [form, setForm] = useState(() => initial ? fromAssessment(initial) : empty())
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const set = (key, value) => setForm(current => ({ ...current, [key]: value }))
  const setSkinfold = (site, value) => setForm(current => ({ ...current, skinfolds: { ...current.skinfolds, [site]: value } }))
  const setCircumference = (site, value) => setForm(current => ({ ...current, circumferences: { ...current.circumferences, [site]: value } }))
  const sites = SITES[form.protocol]?.[form.sex] || []
  const questions = config?.parq?.questions || []
  const parqVersion = config?.parq?.version || '2024.1'
  const hasYes = form.parq.some(Boolean)

  const pickPhotos = async event => {
    const files = [...event.target.files]
    event.target.value = ''
    if (!files.length || !mediaConfig) return
    setUploading(true)
    try {
      const { ingestMediaFile } = await import('../lib/media-ingest.js')
      for (const file of files.slice(0, 6 - form.photos.length)) {
        const result = await ingestMediaFile(file, mediaConfig)
        if (result.media) {
          for (const blob of result.blobs) await apiUpload(`/api/media/${blob.hash}`, blob.blob, blob.mime)
          setForm(current => ({ ...current, photos: [...current.photos, result.media] }))
        }
      }
    } finally { setUploading(false) }
  }

  const save = async () => {
    if (!form.weightKg && !form.heightCm) { toast(p('Enter at least weight or height.')); return }
    setSaving(true)
    try {
      const body = {
        assessedAt: new Date(form.assessedAt).toISOString(),
        weightKg: form.weightKg ? +form.weightKg : null,
        heightCm: form.heightCm ? +form.heightCm : null,
        skinfolds: { protocol: form.protocol, sex: form.sex, age: form.age ? +form.age : null },
        circumferences: {},
        bioimpedance: {},
        anamnesis: {},
        notes: form.notes || '',
        photos: form.photos,
      }
      for (const site of sites) if (form.skinfolds[site]) body.skinfolds[site] = +form.skinfolds[site]
      for (const site of CIRCUMFERENCES) if (form.circumferences[site]) body.circumferences[site] = +form.circumferences[site]
      if (form.bodyFatPercent) body.bioimpedance.bodyFatPercent = +form.bodyFatPercent
      if (form.muscleMassKg) body.bioimpedance.muscleMassKg = +form.muscleMassKg
      if (form.waterPercent) body.bioimpedance.waterPercent = +form.waterPercent
      if (form.visceralFat) body.bioimpedance.visceralFat = +form.visceralFat
      if (questions.length) {
        body.parq = {
          version: parqVersion,
          answers: questions.map((question, index) => ({ questionId: question.id, text: question.text, answer: !!form.parq[index] })),
          notes: form.parqNotes || '',
          acknowledged: form.acknowledged,
        }
      }
      for (const [key] of Object.entries(ANAMNESIS_LABEL)) if (form[key]) body.anamnesis[key] = form[key]
      const route = `/api/coach/athletes/${athleteId}/assessments` + (initial ? `/${initial.id}` : '')
      const result = await api(route, { method: initial ? 'PATCH' : 'POST', body: JSON.stringify(body) })
      onSaved(result.assessment, initial)
      toast(p('Assessment saved.'))
    } catch (error) { toast(professionalError(error)) } finally { setSaving(false) }
  }

  return (
    <section className="assessment-form card" aria-label={p(initial ? 'Correct assessment' : 'New assessment')}>
      <fieldset>
        <legend>{p('Basic measurements')}</legend>
        <div className="assessment-form-grid">
          <Field label={p('Date & time')}>
            <Input type="datetime-local" name="assessedAt" value={form.assessedAt} onChange={event => set('assessedAt', event.target.value)} />
          </Field>
          <Field label={p('Weight (kg)')}>
            <Input type="number" name="weightKg" inputMode="decimal" step="0.1" min="0" value={form.weightKg} onChange={event => set('weightKg', event.target.value)} />
          </Field>
          <Field label={p('Height (cm)')}>
            <Input type="number" name="heightCm" inputMode="decimal" step="0.1" min="0" value={form.heightCm} onChange={event => set('heightCm', event.target.value)} />
          </Field>
          <Field label={p('Age')}>
            <Input type="number" name="age" inputMode="numeric" min="1" max="120" value={form.age} onChange={event => set('age', event.target.value)} />
          </Field>
        </div>
      </fieldset>

      <fieldset>
        <legend>{p('Skinfold measurement')}</legend>
        <div className="assessment-form-grid">
          <Field label={p('Protocol')}>
            <Select name="protocol" value={form.protocol} onChange={event => set('protocol', event.target.value)}>
              <option value="pollock3">Pollock 3</option>
              <option value="pollock7">Pollock 7</option>
              <option value="faulkner4">Faulkner 4</option>
            </Select>
          </Field>
          <Field label={p('Sex')}>
            <Select name="sex" value={form.sex} onChange={event => set('sex', event.target.value)}>
              <option value="male">{p('Male')}</option>
              <option value="female">{p('Female')}</option>
            </Select>
          </Field>
        </div>
        <div className="assessment-form-grid">
          {sites.map(site => (
            <Field key={site} label={p(SITE_LABEL[site] || site) + ' (mm)'}>
              <Input type="number" name={`skinfold-${site}`} inputMode="decimal" step="0.1" min="0" value={form.skinfolds[site] || ''} onChange={event => setSkinfold(site, event.target.value)} />
            </Field>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend>{p('Circumferences')}</legend>
        <div className="assessment-form-grid">
          {CIRCUMFERENCES.map(site => (
            <Field key={site} label={p(CIRCUMFERENCE_LABEL[site]) + ' (cm)'}>
              <Input type="number" name={`circumference-${site}`} inputMode="decimal" step="0.1" min="0" value={form.circumferences[site] || ''} onChange={event => setCircumference(site, event.target.value)} />
            </Field>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend>{p('Bioimpedance')}</legend>
        <div className="assessment-form-grid">
          <Field label={p('Body fat (%)')}>
            <Input type="number" name="bodyFatPercent" inputMode="decimal" step="0.1" min="0" max="100" value={form.bodyFatPercent} onChange={event => set('bodyFatPercent', event.target.value)} />
          </Field>
          <Field label={p('Muscle mass (kg)')}>
            <Input type="number" name="muscleMassKg" inputMode="decimal" step="0.1" min="0" value={form.muscleMassKg} onChange={event => set('muscleMassKg', event.target.value)} />
          </Field>
          <Field label={p('Water (%)')}>
            <Input type="number" name="waterPercent" inputMode="decimal" step="0.1" min="0" max="100" value={form.waterPercent} onChange={event => set('waterPercent', event.target.value)} />
          </Field>
          <Field label={p('Visceral fat')}>
            <Input type="number" name="visceralFat" inputMode="numeric" min="0" value={form.visceralFat} onChange={event => set('visceralFat', event.target.value)} />
          </Field>
        </div>
      </fieldset>

      {questions.length > 0 && (
        <fieldset>
          <legend>PAR-Q ({parqVersion})</legend>
          {questions.map((question, index) => (
            <div className="assessment-question" key={question.id}>
              <input type="checkbox" id={`parq-${question.id}`} checked={!!form.parq[index]} onChange={event => {
                const next = [...form.parq]; next[index] = event.target.checked; set('parq', next)
              }} />
              <label htmlFor={`parq-${question.id}`}>{question.text}</label>
            </div>
          ))}
          <Field label={p('PAR-Q notes')}>
            <TextArea name="parqNotes" rows={2} maxLength={500} value={form.parqNotes} onChange={event => set('parqNotes', event.target.value)} />
          </Field>
          {hasYes && (
            <div className="assessment-warning" role="alert">
              <Alert tone="warning">
                {p('A positive PAR-Q answer requires evaluation and clearance by a qualified health professional before physical activity. This is not a diagnosis.')}
              </Alert>
              <div className="assessment-question" style={{ marginTop: 8 }}>
                <input type="checkbox" id="parq-acknowledge" checked={form.acknowledged} onChange={event => set('acknowledged', event.target.checked)} />
                <label htmlFor="parq-acknowledge">{p('I have read and understood the guidance above.')}</label>
              </div>
            </div>
          )}
        </fieldset>
      )}

      <fieldset>
        <legend>{p('Clinical history')}</legend>
        {[['healthHistory', 'Relevant health history', 1000], ['injuries', 'Injuries', 500], ['medications', 'Medications', 500], ['goals', 'Goals', 500], ['contraindications', 'Contraindications', 1000]].map(([key, label, max]) => (
          <Field key={key} label={p(label)}>
            <TextArea name={key} rows={2} maxLength={max} value={form[key]} onChange={event => set(key, event.target.value)} />
          </Field>
        ))}
      </fieldset>

      <Field label={p('Notes')}>
        <TextArea name="assessmentNotes" rows={3} maxLength={2000} value={form.notes} onChange={event => set('notes', event.target.value)} />
      </Field>

      {!!mediaConfig && (
        <div className="assessment-upload">
          <label className="btn" style={{ minHeight: '44px' }}>
            {uploading ? p('Processing photos…') : p('Add progress photos')}
            <input type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/avif" multiple disabled={uploading || form.photos.length >= 6} onChange={pickPhotos} />
          </label>
          <span>{p('{0} of 6 photos', form.photos.length)}</span>
        </div>
      )}
      {form.photos.length > 0 && (
        <div className="assessment-photo-refs">
          {form.photos.map(photo => (
            <button type="button" key={photo.hash} onClick={() => set('photos', form.photos.filter(item => item.hash !== photo.hash))}>
              {p('Remove photo')} · {photo.hash.slice(0, 8)}
            </button>
          ))}
        </div>
      )}

      <div className="pro-actions" style={{ marginTop: 12 }}>
        <Button variant="primary" disabled={saving || uploading || (hasYes && !form.acknowledged)} onClick={save} style={{ minHeight: '44px' }}>
          {saving ? p('Saving…') : p(initial ? 'Save correction' : 'Save assessment')}
        </Button>
        <Button variant="ghost" onClick={onCancel} style={{ minHeight: '44px' }}>{p('Cancel')}</Button>
      </div>
    </section>
  )
}

function fromAssessment(item) {
  const form = empty()
  const skinfolds = item.skinfolds || {}
  return { ...form, assessedAt: new Date(Date.parse(item.assessedAt) - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16), weightKg: item.weightKg ?? '', heightCm: item.heightCm ?? '', protocol: skinfolds.protocol || 'pollock3', sex: skinfolds.sex || 'male', age: skinfolds.age || '', skinfolds, circumferences: item.circumferences || {}, bodyFatPercent: item.bioimpedance?.bodyFatPercent ?? '', muscleMassKg: item.bioimpedance?.muscleMassKg ?? '', waterPercent: item.bioimpedance?.waterPercent ?? '', visceralFat: item.bioimpedance?.visceralFat ?? '', parq: item.parq?.answers?.map(answer => !!answer.answer) || [], parqNotes: item.parq?.notes || '', acknowledged: !!item.parq?.acknowledged, ...item.anamnesis, notes: item.notes || '', photos: item.photos || [] }
}

function AssessmentLoading() {
  return (
    <div className="assessment-panel" aria-busy="true">
      <Skeleton width="60%" height="1.25rem" />
      <Skeleton width="100%" height="8rem" style={{ marginTop: 12 }} />
    </div>
  )
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
      setAssessments(history.assessments || [])
      setConfig(settings)
    } catch (loadError) { setError(loadError) }
  }, [route])

  useEffect(() => { load() }, [load])

  const remove = item => confirmSheet({
    title: p('Delete this assessment?'),
    message: p('This permanently removes the assessment and its photo references. This action is audited.'),
    confirmText: p('Delete assessment'),
    danger: true,
    onConfirm: async () => {
      try {
        const target = athlete ? `/api/athlete/assessments/${item.id}` : `${route}/${item.id}`
        await api(target, { method: 'DELETE', ...(athlete ? { body: JSON.stringify({ confirmation: item.id }) } : {}) })
        setAssessments(current => current.filter(assessment => assessment.id !== item.id))
        if (editing?.id === item.id) setEditing(null)
      } catch (error) { toast(professionalError(error)) }
    },
  })

  if (error) {
    const message = error.status ? professionalError(error) : p('Could not load physical assessments.')
    return (
      <div role="alert">
        <ErrorState
        title={p('Physical assessments')}
        text={message}
        action={<Button size="sm" onClick={load} style={{ minHeight: '44px' }}>{p('Try again')}</Button>}
        />
      </div>
    )
  }

  if (!assessments || !config) return <AssessmentLoading />

  const sorted = [...assessments].sort((a, b) => Date.parse(b.assessedAt) - Date.parse(a.assessedAt))

  return (
    <section className="assessment-panel" aria-labelledby={`assessment-title-${athleteId || 'own'}`}>
      <div className="pro-panel-head">
        <strong id={`assessment-title-${athleteId || 'own'}`}>{p('Physical assessments')}</strong>
        {!athlete && !editing && (
          <Button size="sm" icon="plus" onClick={() => setEditing(true)} style={{ minHeight: '44px' }}>
            {p('New assessment')}
          </Button>
        )}
      </div>
      {!athlete && editing && (
        <AssessmentForm
          athleteId={athleteId}
          config={config}
          initial={editing === true ? null : editing}
          onCancel={() => setEditing(null)}
          onSaved={(saved, previous) => {
            setAssessments(current => previous ? current.map(item => item.id === saved.id ? saved : item) : [saved, ...current])
            setEditing(null)
          }}
        />
      )}
      {assessments.length === 0 ? (
        <EmptyState
          icon="clipboard"
          title={p('No physical assessments yet.')}
          text={athlete ? p('Your professional will register your first assessment here.') : p('Register the first physical assessment for this athlete.')}
        />
      ) : (
        <>
          <Evolution assessments={assessments} />
          <div className="assessment-history">
            {sorted.map((item, index) => (
              <AssessmentDetail
                key={item.id}
                item={item}
                athlete={athlete}
                onEdit={setEditing}
                onDelete={remove}
                previous={sorted[index + 1]}
              />
            ))}
          </div>
        </>
      )}
    </section>
  )
}
