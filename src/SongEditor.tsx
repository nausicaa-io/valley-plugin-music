import { React, api } from './runtime'
import type { FC, ReactNode } from 'react'
import { IMAGE_EXTENSIONS, assetUrlForRelPath, fileExtension } from '@valley/plugin-sdk/fileTypes'
import { useMusicCover, useMusicIndex } from './hooks'
import { baseName, formatTime, resolveCoverPath } from './data'
import { isEpisode, showFolder, MOMENT_LABEL_LIMIT, type EpisodeMoment } from './podcasts'
import type { MusicStore } from './store'
import type { Track } from './types'
import { uiText } from './localization'
import { Music, Plus, Podcast, X } from './icons'

type Details = NonNullable<Track['details']>
type Draft = { title: string; artist: string; album: string; details: Details }

function useEditorDraft(track: Track, store: MusicStore, onClose: () => void, afterSave?: () => void) {
  const [draft, setDraft] = React.useState<Draft>({ title: track.title, artist: track.artist, album: track.album ?? '', details: { ...track.details } })
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const saving = React.useRef(false)
  const setField = (key: 'title' | 'artist' | 'album', value: string) => setDraft(previous => ({ ...previous, [key]: value }))
  const setDetail = (key: keyof Details, value: string) => setDraft(previous => ({ ...previous, details: { ...previous.details, [key]: value } }))
  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    if (saving.current || busy) return
    saving.current = true
    setBusy(true)
    setError('')
    try { await store.updateTrack(track.id, draft, track); afterSave?.(); onClose() }
    catch (reason) { setError(reason instanceof Error ? reason.message : uiText('music.properties.saveError')) }
    finally { saving.current = false; setBusy(false) }
  }
  return { draft, busy, setBusy, error, setError, setField, setDetail, save }
}

/** First row of both editors: the artwork currently shown for this item, and how to replace it. */
const CoverField: FC<{
  track: Track
  store: MusicStore
  value: string
  fallbackPath: string | null
  episode: boolean
  busy: boolean
  setBusy: (busy: boolean) => void
  onError: (message: string) => void
  onChange: (value: string) => void
  children: ReactNode
}> = ({ track, store, value, fallbackPath, episode, busy, setBusy, onError, onChange, children }) => {
  const entries = useMusicIndex()
  const inputRef = React.useRef<HTMLInputElement>(null)
  const images = React.useMemo(() => entries.filter(entry => (IMAGE_EXTENSIONS as readonly string[]).includes(fileExtension(entry.relPath))), [entries])
  const chosen = resolveCoverPath(entries, value)
  const { url: embedded, ref } = useMusicCover(store, chosen ? undefined : track.id, { eager: true })
  const src = chosen ? assetUrlForRelPath(chosen) : embedded ?? (fallbackPath ? assetUrlForRelPath(fallbackPath) : null)
  const source = chosen ? baseName(chosen) : embedded ? uiText('music.edit.coverEmbedded') : fallbackPath ? uiText('music.edit.coverShow') : uiText('music.edit.coverNone')
  const importImage = async (files: File[]) => {
    const accepted = files.filter(file => (IMAGE_EXTENSIONS as readonly string[]).includes(fileExtension(file.name)))
    if (!accepted.length) { onError(uiText('music.edit.imageError')); return }
    setBusy(true)
    try {
      const imported = await api.files.importDropped(accepted.slice(0, 1))
      if (imported[0]) onChange(imported[0])
    } catch { onError(uiText('music.edit.imageError')) } finally { setBusy(false) }
  }
  return (
    <div className="music-edit-head" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); if (!busy) void importImage(Array.from(event.dataTransfer.files)) }}>
      <div className="music-edit-cover">
        <span ref={ref} className={`music-edit-cover-art ${episode ? 'episode' : ''}`}>
          {src ? <img src={src} alt={uiText('music.surface.cover')} /> : episode ? <Podcast /> : <Music />}
        </span>
        <span className="music-edit-cover-source" title={chosen ?? undefined}>{source}</span>
        <api.ui.ComboField ariaLabel={uiText('music.surface.cover')} value={value} onChange={onChange} options={images.map(entry => ({ value: entry.relPath, label: baseName(entry.relPath) }))} />
        <div className="music-edit-cover-actions">
          <button type="button" onClick={() => inputRef.current?.click()}>{uiText('music.edit.addImage')}</button>
          {value && <button type="button" onClick={() => onChange('')}>{uiText('music.edit.removeImage')}</button>}
        </div>
        <input ref={inputRef} type="file" accept="image/*" hidden onChange={event => { void importImage(Array.from(event.target.files ?? [])); event.target.value = '' }} />
      </div>
      <div className="music-edit-identity">{children}</div>
    </div>
  )
}

const Field: FC<{ label: string; value: string; onChange: (value: string) => void; autoFocus?: boolean; required?: boolean; type?: string; placeholder?: string; inputMode?: 'numeric' }> = ({ label, value, onChange, ...input }) => (
  <label>{label}<input value={value} onChange={event => onChange(event.target.value)} {...input} /></label>
)

const Actions: FC<{ busy: boolean; error: string; canSave: boolean; help: string; onCancel: () => void }> = ({ busy, error, canSave, help, onCancel }) => <>
  {error && <p role="alert">{error}</p>}
  <div className="music-edit-actions"><p className="music-edit-help">{help}</p><button type="button" disabled={busy} onClick={onCancel}>{uiText('music.edit.cancel')}</button><button type="submit" className="primary" disabled={busy || !canSave}>{uiText(busy ? 'music.edit.saving' : 'music.edit.save')}</button></div>
</>

const MusicEditor: FC<{ track: Track; store: MusicStore; onClose(): void }> = ({ track, store, onClose }) => {
  const { draft, busy, setBusy, error, setError, setField, setDetail, save } = useEditorDraft(track, store, onClose)
  return <api.ui.Modal title={uiText('music.edit.title')} onClose={() => { if (!busy) onClose() }} size="medium" bodyClassName="music-song-editor">
    <form className="music-song-editor" onSubmit={event => void save(event)}>
      <fieldset disabled={busy}>
        <CoverField track={track} store={store} value={draft.details.cover ?? ''} fallbackPath={null} episode={false} busy={busy} setBusy={setBusy} onError={setError} onChange={value => setDetail('cover', value)}>
          <Field label={uiText('music.surface.title')} value={draft.title} onChange={value => setField('title', value)} autoFocus required />
          <Field label={uiText('music.surface.artist')} value={draft.artist} onChange={value => setField('artist', value)} />
          <Field label={uiText('music.surface.album')} value={draft.album} onChange={value => setField('album', value)} />
        </CoverField>
        <section className="music-edit-section">
          <h3>{uiText('music.edit.credits')}</h3>
          <div className="music-edit-grid">
            {(['feat', 'songwriter', 'composer', 'author'] as const).map(key => <Field key={key} label={uiText(`music.edit.${key}`)} value={draft.details[key] ?? ''} onChange={value => setDetail(key, value)} />)}
          </div>
        </section>
        <section className="music-edit-section">
          <h3>{uiText('music.edit.details')}</h3>
          <div className="music-edit-grid">
            <Field label={uiText('music.edit.genre')} value={draft.details.genre ?? ''} onChange={value => setDetail('genre', value)} />
            <Field label={uiText('music.edit.year')} value={draft.details.year ?? ''} onChange={value => setDetail('year', value)} inputMode="numeric" />
          </div>
        </section>
        <section className="music-edit-section">
          <h3>{uiText('music.edit.lyrics')}</h3>
          <textarea aria-label={uiText('music.edit.lyrics')} rows={4} value={draft.details.lyrics ?? ''} onChange={event => setDetail('lyrics', event.target.value)} />
        </section>
      </fieldset>
      <Actions busy={busy} error={error} canSave={!!draft.title.trim()} help={uiText('music.edit.help')} onCancel={onClose} />
    </form>
  </api.ui.Modal>
}

/** `h:mm:ss`, `m:ss` or plain seconds → seconds; null when it is not a time. */
export function parseMomentTime(value: string): number | null {
  const parts = value.trim().split(':')
  if (!parts.length || parts.length > 3 || parts.some(part => !/^\d+(\.\d+)?$/.test(part))) return null
  return parts.reduce((total, part) => total * 60 + Number(part), 0)
}

type MomentDraft = { key: number; time: string; label: string }

const EpisodeEditor: FC<{ track: Track; store: MusicStore; onClose(): void }> = ({ track, store, onClose }) => {
  const snapshot = store.getSnapshot()
  const show = snapshot.shows.find(item => item.id === showFolder(track.file, snapshot.podcastPath))
  const nextKey = React.useRef(0)
  const toDraft = (moment: EpisodeMoment): MomentDraft => ({ key: nextKey.current++, time: formatTime(moment.at), label: moment.label })
  const [moments, setMoments] = React.useState<MomentDraft[]>(() => (snapshot.episodeMoments[track.id] ?? []).map(toDraft))
  const parsed = moments.map(moment => parseMomentTime(moment.time))
  const momentsValid = parsed.every(value => value !== null)
  const { draft, busy, setBusy, error, setError, setField, setDetail, save } = useEditorDraft(track, store, onClose, () => {
    store.setMoments(track.id, moments.map((moment, index) => ({ at: parsed[index] ?? 0, label: moment.label.trim() })))
  })
  const addMoment = () => {
    const live = store.getSnapshot()
    const at = live.currentTrack?.id === track.id ? live.currentTime : 0
    setMoments(previous => [...previous, toDraft({ at, label: '' })])
  }
  return <api.ui.Modal title={uiText('music.edit.episodeTitle')} onClose={() => { if (!busy) onClose() }} size="medium" bodyClassName="music-song-editor">
    <form className="music-song-editor music-episode-editor" onSubmit={event => void save(event)}>
      <fieldset disabled={busy}>
        <CoverField track={track} store={store} value={draft.details.cover ?? ''} fallbackPath={show?.coverPath ?? null} episode busy={busy} setBusy={setBusy} onError={setError} onChange={value => setDetail('cover', value)}>
          <Field label={uiText('music.edit.episodeName')} value={draft.title} onChange={value => setField('title', value)} autoFocus required />
          <Field label={uiText('music.edit.show')} value={draft.album} onChange={value => setField('album', value)} placeholder={show?.name} />
          <Field label={uiText('music.edit.host')} value={draft.artist} onChange={value => setField('artist', value)} />
        </CoverField>
        <section className="music-edit-section">
          <h3>{uiText('music.edit.episodeInfo')}</h3>
          <div className="music-edit-grid three">
            <Field label={uiText('music.edit.season')} value={draft.details.season ?? ''} onChange={value => setDetail('season', value)} inputMode="numeric" />
            <Field label={uiText('music.edit.episodeNumber')} value={draft.details.episode ?? ''} onChange={value => setDetail('episode', value)} inputMode="numeric" />
            <Field label={uiText('music.edit.published')} value={draft.details.published ?? ''} onChange={value => setDetail('published', value)} type="date" />
          </div>
          <Field label={uiText('music.edit.guests')} value={draft.details.guests ?? ''} onChange={value => setDetail('guests', value)} />
        </section>
        <section className="music-edit-section">
          <h3>{uiText('music.edit.description')}</h3>
          <textarea aria-label={uiText('music.edit.description')} rows={4} value={draft.details.description ?? ''} onChange={event => setDetail('description', event.target.value)} />
        </section>
        <section className="music-edit-section">
          <h3>{uiText('music.podcast.moments')}</h3>
          {moments.length > 0 && <div className="music-edit-moments">
            {moments.map((moment, index) => (
              <div key={moment.key} className="music-edit-moment">
                <input className={parsed[index] === null ? 'invalid' : ''} aria-label={uiText('music.edit.momentTime')} aria-invalid={parsed[index] === null} value={moment.time} onChange={event => setMoments(previous => previous.map(item => item.key === moment.key ? { ...item, time: event.target.value } : item))} />
                <input aria-label={uiText('music.edit.momentLabel')} placeholder={uiText('music.podcast.momentPlaceholder')} maxLength={MOMENT_LABEL_LIMIT} value={moment.label} onChange={event => setMoments(previous => previous.map(item => item.key === moment.key ? { ...item, label: event.target.value } : item))} />
                <button type="button" className="music-edit-moment-remove" title={uiText('music.podcast.removeMoment')} aria-label={uiText('music.podcast.removeMoment')} onClick={() => setMoments(previous => previous.filter(item => item.key !== moment.key))}><X /></button>
              </div>
            ))}
          </div>}
          <button type="button" className="music-edit-moment-add" onClick={addMoment}><Plus /> {uiText('music.podcast.addMoment')}</button>
        </section>
      </fieldset>
      <Actions busy={busy} error={error || (momentsValid ? '' : uiText('music.edit.momentInvalid'))} canSave={!!draft.title.trim() && momentsValid} help={uiText('music.edit.episodeHelp')} onCancel={onClose} />
    </form>
  </api.ui.Modal>
}

export function SongEditor({ track, store, onClose }: { track: Track; store: MusicStore; onClose(): void }) {
  return isEpisode(track, store.getSnapshot().podcastPath)
    ? <EpisodeEditor track={track} store={store} onClose={onClose} />
    : <MusicEditor track={track} store={store} onClose={onClose} />
}
