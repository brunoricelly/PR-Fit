// CustomMediaField com Upload e Compressão Integrada R2 para o PR Fit
import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { t } from '../lib/i18n.js'
import { mediaOf, fmtClip } from '../lib/media-refs.js'
import { mediaStore } from '../lib/media-store.js'
import { MOBILE } from '../lib/mobile.js'
import { limitsFrom, fmtMB, MB } from '../lib/media-limits.js'
import { CustomThumb } from './CustomMedia.jsx'
import { Row, Button } from './ui.jsx'
import Icon from './Icon.jsx'

const toast = m => useUI.getState().toast(m)

const noRoom = e => e?.name === 'QuotaExceededError' || e?.name === 'NS_ERROR_DOM_QUOTA_REACHED' || /ENOSPC|no space left/i.test(String(e?.message || ''))

export function mediaErrorText(e) {
  if (noRoom(e)) return t('There is no room left on this device for that file.')
  switch (e?.code) {
    case 'type': return t('That file type isn’t supported. Use a photo, a GIF, or an MP4, MOV or WebM video.')
    case 'too-large': return t('That file is too big. Max {0} MB.', fmtMB(e.mb))
    case 'too-long': return t('That video is too long. Max {0} seconds.', e.sec)
    case 'photo-too-big': return t('That photo is too large to process on this device.')
    case 'offline': return t('You’re offline. Try again once you’re back online.')
    default: return t('This browser cannot read that file.')
  }
}

const loadIngest = () => import('../lib/media-ingest.js').catch(() => {
  throw Object.assign(new Error('media ingest did not load'), { code: 'offline' })
})

const KIND_ICON = { image: 'image', gif: 'play', video: 'play' }

export function useMediaPicker() {
  const user = useStore(s => s.user)
  const config = useStore(s => s.config)
  const [busy, setBusy] = useState(false)
  const [warning, setWarning] = useState(null)
  const [storable, setStorable] = useState(true)
  useEffect(() => {
    let alive = true
    mediaStore.ready().then(() => { if (alive) setStorable(mediaStore.persistent) }).catch(() => { if (alive) setStorable(false) })
    return () => { alive = false }
  }, [])
  const serverLacks = (!!user || !MOBILE) && !!config && !config.media

  const pick = async file => {
    if (!file) return null
    setBusy(true)
    setWarning(null)
    try {
      const { ingestMediaFile } = await loadIngest()
      const out = await ingestMediaFile(file, limitsFrom(config))
      for (const b of out.blobs) await mediaStore.put(b.hash, b.blob, { mime: b.mime, pending: true })
      if (!user) { try { globalThis.navigator?.storage?.persist?.()?.catch?.(() => {}) } catch { /* not offered */ } }
      if (out.warnings.includes('codec')) setWarning(t('This video may not play on every device. MP4 (H.264) plays everywhere.'))
      return out.media
    } catch (e) {
      toast(mediaErrorText(e))
      return null
    } finally {
      setBusy(false)
    }
  }
  const note = !storable ? t('This browser cannot store photos or videos here.')
    : serverLacks ? t('Your server does not store photos and videos yet.')
      : !user ? t('Kept on this device only. Export with photos & videos keeps a copy.')
        : null
  return { pick, busy, warning, setWarning, note, storable, showAdd: true, canAdd: !busy }
}

export default function CustomMediaField({ media, url, onChange }) {
  const user = useStore(s => s.user)
  const { pick, busy, warning, setWarning, note } = useMediaPicker()
  const fileRef = useRef(null)
  const videoR2Ref = useRef(null)
  const [uploadingR2, setUploadingR2] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(null)
  const m = mediaOf({ media })

  const mainHash = m?.hash, posterHash = m?.poster?.hash
  useEffect(() => {
    if (!mainHash) return undefined
    return mediaStore.hold([mainHash, posterHash])
  }, [mainHash, posterHash])

  const onFile = async ev => {
    const file = ev.target.files && ev.target.files[0]
    ev.target.value = ''
    const got = await pick(file)
    if (got) onChange({ media: got })
  }

  // Upload Direto para o Motor de Compressão R2 do PR Fit
  const onUploadVideoR2 = async ev => {
    const file = ev.target.files && ev.target.files[0]
    ev.target.value = ''
    if (!file) return

    setUploadingR2(true)
    setUploadProgress('Otimizando vídeo com o motor R2...')
    try {
      const formData = new FormData()
      formData.append('video', file)
      const coachId = user?.id || user?.username || 'treinador'
      formData.append('coachId', coachId)

      const response = await fetch('/api/upload-video', {
        method: 'POST',
        body: formData
      })

      if (!response.ok) {
        throw new Error(`Falha no upload do vídeo (${response.status})`)
      }

      const data = await response.json()
      if (data.url) {
        onChange({ url: data.url })
        toast(`Vídeo otimizado com sucesso! Redução: ${data.reductionPercent || 'alta'}`)
      } else {
        throw new Error(data.error || 'Erro desconhecido ao processar vídeo.')
      }
    } catch (err) {
      console.error('Erro no upload de vídeo R2:', err)
      toast(`Erro ao subir vídeo: ${err.message}`)
    } finally {
      setUploadingR2(false)
      setUploadProgress(null)
    }
  }

  const sizeLine = m ? [m.dur != null && m.kind !== 'image' ? fmtClip(m.dur) : null, t('{0} MB', fmtMB(Math.max(0.1, m.size / MB), { fixed: true }))].filter(Boolean).join(' · ') : null
  const subtitle = m
    ? <span className="cmf-sub"><Icon name={KIND_ICON[m.kind]} />{sizeLine}</span>
    : t('Optional. A picture makes it easier to spot in a list.')

  return <div className="cmf">
    <Row icon="image" iconTint="var(--blue)" title={t('Photo, GIF or video')} subtitle={subtitle}>
      <div className="cmf-act">
        {m && <span className="cmf-thumb"><CustomThumb ex={{ custom: true, media: m }} /></span>}
        <Button variant="tinted" size="sm" icon={busy ? undefined : 'image'} disabled={busy || uploadingR2} onClick={() => fileRef.current?.click()}>
          {busy ? t('Loading…') : m ? t('Change') : t('Add')}
        </Button>
        {m && <Button variant="ghost" size="sm" icon="xmark" aria-label={t('Remove')} title={t('Remove')} disabled={busy || uploadingR2} onClick={() => { setWarning(null); onChange({ media: null }) }} />}
      </div>
    </Row>
    <input ref={fileRef} type="file" accept="image/*,video/*" hidden onChange={onFile} />

    {/* Botão de Envio de Vídeo Direto para o R2 com Compressão */}
    <div style={{ marginTop: 12, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <input ref={videoR2Ref} type="file" accept="video/*,.mov,.mp4,.webm,.avi,.mkv" hidden onChange={onUploadVideoR2} />
      <Button
        variant="secondary"
        size="sm"
        disabled={uploadingR2 || busy}
        onClick={() => videoR2Ref.current?.click()}
        style={{ borderColor: 'var(--lime)', color: 'var(--lime)', fontWeight: 600 }}
      >
        <Icon name="play" style={{ marginRight: 6 }} />
        {uploadingR2 ? 'Processando e Comprimindo...' : 'Enviar Vídeo de Execução (R2)'}
      </Button>
      {uploadProgress && <span style={{ fontSize: '0.82rem', color: 'var(--lime)' }}>{uploadProgress}</span>}
    </div>

    {warning && <div className="small dim cmf-note">{warning}</div>}
    {note && <div className="small dim cmf-note">{note}</div>}

    <input className="input cmf-link" type="url" inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false}
      dir={url ? 'ltr' : undefined} placeholder={t('Video or guide link (optional)')}
      value={url || ''} onChange={e => onChange({ url: e.target.value })} />
  </div>
}
