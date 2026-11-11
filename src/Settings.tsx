import { React, api } from './runtime'
import type { FC, ReactNode } from 'react'
import { fileExtension } from '@valley/plugin-sdk/fileTypes'
import type { PluginIndexEntry } from '@valley/plugin-sdk'
import { MEDIA_EXTENSIONS, mediaFilesInFolder } from './data'
import { normalizeMusicPath } from './store'
import { useMusic, useMusicIndex } from './hooks'
import { uiText } from './localization'

function parentFolders(path: string): string[] {
  const parts = path.split('/')
  const out: string[] = []
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join('/'))
  return out
}

function folderInfo(entries: readonly PluginIndexEntry[], query: string): {
  allFolders: Set<string>
  suggestions: { path: string; count: number }[]
} {
  const allFolders = new Set<string>()
  const mediaCounts = new Map<string, number>()
  for (const entry of entries) {
    for (const folder of parentFolders(entry.relPath)) allFolders.add(folder)
    if (!MEDIA_EXTENSIONS.has(fileExtension(entry.relPath))) continue
    for (const folder of parentFolders(entry.relPath)) {
      mediaCounts.set(folder, (mediaCounts.get(folder) ?? 0) + 1)
    }
  }
  const mediaFolders = [...mediaCounts.entries()]
    .map(([path, count]) => ({ path, count }))
    .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path))
  const q = query.trim().toLowerCase()
  const suggestions = (q ? mediaFolders.filter((f) => f.path.toLowerCase().includes(q)) : mediaFolders).slice(0, 6)
  return { allFolders, suggestions }
}

function folderStatus(entries: readonly PluginIndexEntry[], draft: string): { invalid: boolean; empty: boolean; warning: boolean; count: number; status: string } {
  const normalized = normalizeMusicPath(draft)
  const invalid = draft.trim().length > 0 && !normalized
  const count = normalized ? mediaFilesInFolder(entries, normalized).length : 0
  const folderKnown = normalized ? folderInfo(entries, draft).allFolders.has(normalized) : false
  const status = invalid
    ? uiText('auto.bd7f88ffa0fb')
    : count > 0
      ? uiText('auto.1705de749234', { p0: count, p1: count === 1 ? 'file' : 'files' })
      : folderKnown
        ? uiText('auto.6cf8f9207305')
        : entries.length === 0
          ? uiText('auto.c881bef02fda')
          : uiText('auto.ac95c11ac1f2')
  return { invalid, empty: Boolean(normalized) && count === 0, warning: invalid || (!folderKnown && entries.length > 0), count, status }
}

function folderDescription(text: string, folder: { count: number; status: string }, rescanMessage: string): ReactNode {
  return <>
    {text}
    {folder.count > 0 && <> <span className="music-settings-positive">{folder.status}</span></>}
    {rescanMessage && ` ${rescanMessage}`}
  </>
}

/** A realm folder and its Rescan on one line; problems show beside it, the media count in the description. */
const FolderRow: FC<{
  value: string
  draft: string
  setDraft: (value: string) => void
  title: string
  description: ReactNode
  saveError: string
  save: (path: string) => Promise<boolean>
  entries: readonly PluginIndexEntry[]
  disabled: boolean
  rescanDisabled: boolean
  onRescan: () => void
}> = ({ value, draft, setDraft, title, description, saveError, save, entries, disabled, rescanDisabled, onRescan }) => {
  const [message, setMessage] = React.useState('')
  const { invalid, empty, warning, status } = folderStatus(entries, draft)

  const commit = async (path: string): Promise<void> => {
    const normalizedPath = normalizeMusicPath(path)
    if (disabled || (path.trim() && !normalizedPath) || normalizedPath === normalizeMusicPath(value)) return
    setMessage('')
    try {
      setMessage((await save(normalizedPath)) ? uiText('auto.6336d3512f60') : saveError)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }

  const { Row, RealmFolderField, Button } = api.ui.settings
  return (
    <Row
      title={title}
      description={description}
      extra={invalid || empty ?
        <span className={`settings-toggle-desc ${warning ? 'music-settings-warning' : ''}`}>{status}</span>
      : undefined}
    >
      <div className="settings-row-control music-folder-control">
        <RealmFolderField
          value={draft}
          onChange={(v) => {
            setDraft(v)
            setMessage('')
          }}
          onCommit={(v) => {
            setDraft(v)
            void commit(v)
          }}
          requireValidCommit
          ariaLabel={title}
          className={`settings-path-input music-settings-input${invalid ? ' invalid' : ''}`}
          help={message || undefined}
        />
        <Button disabled={rescanDisabled} onClick={onRescan} aria-label={uiText('auto.42f9f14387b1')} title={uiText('music.settings.rescanDesc')}>
          {uiText('auto.84661f6a90cc')}
        </Button>
      </div>
    </Row>
  )
}

function useDraft(value: string): [string, (value: string) => void] {
  const [draft, setDraft] = React.useState(value)
  React.useEffect(() => {
    setDraft(value)
  }, [value])
  return [draft, setDraft]
}

export const Settings: FC = () => {
  const { store, snap } = useMusic()
  const entries = useMusicIndex()
  const [musicDraft, setMusicDraft] = useDraft(snap.musicPath)
  const [podcastDraft, setPodcastDraft] = useDraft(snap.podcastPath)
  const [saving, setSaving] = React.useState(false)
  const [rescanMessage, setRescanMessage] = React.useState('')
  const music = React.useMemo(() => folderStatus(entries, musicDraft), [entries, musicDraft])
  const podcasts = React.useMemo(() => folderStatus(entries, podcastDraft), [entries, podcastDraft])

  const rescan = async (): Promise<void> => {
    if (!store) return
    setSaving(true)
    setRescanMessage('')
    try {
      await store.refresh()
      setRescanMessage(uiText('auto.f54e1782f9c2'))
    } catch (error) {
      setRescanMessage(error instanceof Error ? error.message : String(error))
    } finally { setSaving(false) }
  }

  const { Section } = api.ui.settings
  const rescanDisabled = !store || saving || (!snap.musicPath && !snap.podcastPath)

  return (
    <>
      <Section className="music-settings">
        <FolderRow
          value={snap.musicPath}
          draft={musicDraft}
          setDraft={setMusicDraft}
          title={uiText('auto.a71420a4b1e3')}
          description={folderDescription(uiText('auto.a09fad4110cb'), music, rescanMessage)}
          saveError={uiText('auto.824057036236')}
          save={async (path) => Boolean(store && await store.setMusicPath(path))}
          entries={entries}
          disabled={!store}
          rescanDisabled={rescanDisabled}
          onRescan={() => void rescan()}
        />
      </Section>
      <Section className="music-settings" title={uiText('music.podcasts')}>
        <FolderRow
          value={snap.podcastPath}
          draft={podcastDraft}
          setDraft={setPodcastDraft}
          title={uiText('music.settings.podcastFolder')}
          description={folderDescription(uiText('music.settings.podcastFolderDesc'), podcasts, rescanMessage)}
          saveError={uiText('music.settings.podcastSaveError')}
          save={async (path) => Boolean(store && await store.setPodcastPath(path))}
          entries={entries}
          disabled={!store}
          rescanDisabled={rescanDisabled}
          onRescan={() => void rescan()}
        />
      </Section>
    </>
  )
}
