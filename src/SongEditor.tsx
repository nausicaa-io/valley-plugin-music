import { React, api } from './runtime'
import { IMAGE_EXTENSIONS, assetUrlForRelPath, fileExtension } from '@valley/plugin-sdk/fileTypes'
import { useMusicIndex } from './hooks'
import { baseName, resolveCoverPath } from './data'
import type { MusicStore } from './store'
import type { Track } from './types'
import { uiText } from './localization'

export function SongEditor({ track, store, onClose }: { track: Track; store: MusicStore; onClose(): void }) {
  const [draft, setDraft] = React.useState({ title: track.title, artist: track.artist, album: track.album ?? '', details: { ...track.details } })
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const entries = useMusicIndex()
  const inputRef = React.useRef<HTMLInputElement>(null)
  const saving = React.useRef(false)
  const images = React.useMemo(() => entries.filter(entry => (IMAGE_EXTENSIONS as readonly string[]).includes(fileExtension(entry.relPath))), [entries])
  const cover = resolveCoverPath(entries, draft.details.cover)
  const setDetail = (key: keyof NonNullable<Track['details']>, value: string) => setDraft(previous => ({ ...previous, details: { ...previous.details, [key]: value } }))
  const importImage = async (files: File[]) => {
    const accepted = files.filter(file => (IMAGE_EXTENSIONS as readonly string[]).includes(fileExtension(file.name)))
    if (!accepted.length) { setError(uiText('music.edit.imageError')); return }
    setBusy(true)
    try {
      const imported = await api.files.importDropped(accepted.slice(0, 1))
      if (imported[0]) setDetail('cover', imported[0])
    } catch { setError(uiText('music.edit.imageError')) } finally { setBusy(false) }
  }
  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    if (saving.current || busy) return
    saving.current = true
    setBusy(true)
    setError('')
    try { await store.updateTrack(track.id, draft, track); onClose() }
    catch (reason) { setError(reason instanceof Error ? reason.message : uiText('music.properties.saveError')) }
    finally { saving.current = false; setBusy(false) }
  }
  return <api.ui.Modal title={uiText('music.edit.title')} onClose={() => { if (!busy) onClose() }} size="medium" bodyClassName="music-song-editor">
    <form className="music-song-editor" onSubmit={event => void save(event)}>
      <p className="music-edit-help">{uiText('music.edit.help')}</p>
      <fieldset disabled={busy}>
        <div className="music-edit-grid">
          {(['title', 'artist', 'album'] as const).map(key => <label key={key}>{uiText(`music.surface.${key}`)}
            <input autoFocus={key === 'title'} required={key === 'title'} value={draft[key]} onChange={event => setDraft(previous => ({ ...previous, [key]: event.target.value }))} />
          </label>)}
          {(['feat', 'songwriter', 'author', 'composer', 'genre', 'year'] as const).map(key => <label key={key}>{uiText(`music.edit.${key}`)}
            <input value={draft.details[key] ?? ''} onChange={event => setDetail(key, event.target.value)} />
          </label>)}
        </div>
        <label>{uiText('music.edit.lyrics')}<textarea rows={3} value={draft.details.lyrics ?? ''} onChange={event => setDetail('lyrics', event.target.value)} /></label>
        <div className="music-edit-cover" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); if (!busy) void importImage(Array.from(event.dataTransfer.files)) }}>
          {cover && <img src={assetUrlForRelPath(cover)} alt={uiText('music.surface.cover')} />}
          <label>{uiText('music.surface.cover')}<api.ui.ComboField ariaLabel={uiText('music.surface.cover')} value={draft.details.cover ?? ''} onChange={value => setDetail('cover', value)} options={images.map(entry => ({ value: entry.relPath, label: baseName(entry.relPath) }))} /></label>
          <button type="button" onClick={() => inputRef.current?.click()}>{uiText('music.edit.addImage')}</button>
          {draft.details.cover && <button type="button" onClick={() => setDetail('cover', '')}>{uiText('music.edit.removeImage')}</button>}
          <input ref={inputRef} type="file" accept="image/*" hidden onChange={event => { void importImage(Array.from(event.target.files ?? [])); event.target.value = '' }} />
        </div>
      </fieldset>
      {error && <p role="alert">{error}</p>}
      <div className="music-edit-actions"><button type="button" disabled={busy} onClick={onClose}>{uiText('music.edit.cancel')}</button><button type="submit" className="primary" disabled={busy || !draft.title.trim()}>{uiText(busy ? 'music.edit.saving' : 'music.edit.save')}</button></div>
    </form>
  </api.ui.Modal>
}
