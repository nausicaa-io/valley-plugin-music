import { React, api } from './runtime'
import type { FC } from 'react'
import { AUDIO_EXTENSIONS, VIDEO_EXTENSIONS, fileExtension } from '@valley/plugin-sdk/fileTypes'
import type { PluginIndexEntry } from '@valley/plugin-sdk'
import { mediaFilesInFolder } from './data'
import { DEFAULT_MUSIC_PATH, normalizeMusicPath } from './store'
import { useMusic, useMusicIndex } from './hooks'
import { uiText } from './localization'

const MEDIA_EXTENSIONS = new Set<string>([...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS])

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

export const Settings: FC = () => {
  const { store, snap } = useMusic()
  const entries = useMusicIndex()
  const [draft, setDraft] = React.useState(snap.musicPath)
  const [saving, setSaving] = React.useState(false)
  const [message, setMessage] = React.useState('')
  const [rescanMessage, setRescanMessage] = React.useState('')

  React.useEffect(() => {
    setDraft(snap.musicPath)
  }, [snap.musicPath])

  const normalized = normalizeMusicPath(draft)
  const invalid = draft.trim().length > 0 && !normalized
  const info = React.useMemo(() => folderInfo(entries, draft), [entries, draft])
  const mediaCount = normalized ? mediaFilesInFolder(entries, normalized).length : 0
  const folderKnown = normalized ? info.allFolders.has(normalized) : false

  const status = invalid
    ? uiText('auto.bd7f88ffa0fb')
    : mediaCount > 0
      ? uiText('auto.1705de749234', { p0: mediaCount, p1: mediaCount === 1 ? 'file' : 'files' })
      : folderKnown
        ? uiText('auto.6cf8f9207305')
        : entries.length === 0
          ? uiText('auto.c881bef02fda')
          : uiText('auto.ac95c11ac1f2')

  const save = async (path: string): Promise<void> => {
    const normalizedPath = normalizeMusicPath(path)
    if (!store || !normalizedPath || normalizedPath === normalizeMusicPath(snap.musicPath)) return
    setSaving(true)
    setMessage('')
    const ok = await store.setMusicPath(normalizedPath)
    setSaving(false)
    setMessage(ok ? uiText('auto.6336d3512f60') : uiText('auto.824057036236'))
  }

  const rescan = async (): Promise<void> => {
    if (!store) return
    setSaving(true)
    setRescanMessage('')
    await store.refresh()
    setSaving(false)
    setRescanMessage(uiText('auto.f54e1782f9c2'))
  }

  const { Section, Row, VaultFolderField, Button } = api.ui.settings

  return (
    <Section className="music-settings">
      <Row
        title={uiText('auto.a71420a4b1e3')}
        description={uiText('auto.a09fad4110cb')}
        extra={invalid || mediaCount === 0 ?
          <span
            className={`settings-toggle-desc ${
              invalid || (!folderKnown && entries.length > 0)
                ? 'music-settings-warning'
                : ''
            }`}
          >
            {status}
          </span>
        : undefined}
      >
        <VaultFolderField
          value={draft}
          onChange={(v) => {
            setDraft(v)
            setMessage('')
          }}
          onCommit={(v) => {
            setDraft(v)
            void save(v)
          }}
          placeholder={DEFAULT_MUSIC_PATH}
          required
          requireValidCommit
          ariaLabel={uiText('auto.a71420a4b1e3')}
          className={`settings-path-input music-settings-input${invalid ? ' invalid' : ''}`}
          help={message || undefined}
        />
      </Row>

      <Row
        title={uiText('auto.42f9f14387b1')}
        description={
          [
            uiText('auto.43f950ef42aa'),
            !invalid && mediaCount > 0 ? status : '',
            rescanMessage
          ].filter(Boolean).join(' ')
        }
      >
        <Button disabled={!store || saving || !snap.musicPath} onClick={() => void rescan()}>
          {uiText('auto.84661f6a90cc')}
        </Button>
      </Row>
    </Section>
  )
}
