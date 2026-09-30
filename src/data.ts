import type { PluginIndexEntry } from '@valley/plugin-sdk'
import { AUDIO_EXTENSIONS, VIDEO_EXTENSIONS, fileExtension } from '@valley/plugin-sdk/fileTypes'
import type { HistoryEntry, Playlist, QueueEntry, Track } from './types'

/**
 * Format a duration in seconds as `M:SS`, or `H:MM:SS` once it reaches an hour.
 * Mirrors the core `lib/formatDuration` (plugins don't import from @renderer).
 */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return '0:00'
  const whole = Math.max(0, Math.floor(seconds))
  const h = Math.floor(whole / 3600)
  const m = Math.floor((whole % 3600) / 60)
  const s = whole % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

/** Resolve a playlist's ordered tracks from its inline `songIds`. */
export function resolvePlaylistTracks(songIds: string[], byId: Map<string, Track>): Track[] {
  return songIds.map((id) => byId.get(id)).filter((t): t is Track => Boolean(t))
}

/** Remove a song id from every playlist's `songIds`. Returns the changed playlists. */
export function applyDeleteSong(playlists: Playlist[], songId: string): Playlist[] {
  const changed: Playlist[] = []
  for (const pl of playlists) {
    if (pl.songIds.includes(songId)) {
      changed.push({ ...pl, songIds: pl.songIds.filter((id) => id !== songId) })
    }
  }
  return changed
}

/** Most-recent-first, de-duplicated play history resolved to tracks. */
export function dedupeHistory(entries: HistoryEntry[], byId: Map<string, Track>): Track[] {
  const out: Track[] = []
  const seen = new Set<string>()
  for (let i = entries.length - 1; i >= 0; i--) {
    const id = entries[i]?.songId
    if (!id || seen.has(id)) continue
    const track = byId.get(id)
    if (!track) continue
    seen.add(id)
    out.push(track)
  }
  return out
}

/** Tracks ranked by total play count (descending), capped at `limit`. */
export function mostListened(
  entries: HistoryEntry[],
  byId: Map<string, Track>,
  limit = 12
): { track: Track; plays: number }[] {
  const counts = new Map<string, number>()
  for (const entry of entries) {
    if (!entry?.songId) continue
    counts.set(entry.songId, (counts.get(entry.songId) ?? 0) + 1)
  }
  const ranked: { track: Track; plays: number }[] = []
  for (const [songId, plays] of counts) {
    const track = byId.get(songId)
    if (track) ranked.push({ track, plays })
  }
  ranked.sort((a, b) => b.plays - a.plays || a.track.title.localeCompare(b.track.title))
  return ranked.slice(0, limit)
}

/** Queue tracks → queue.jsonl records. */
export function serializeQueue(tracks: Track[]): QueueEntry[] {
  return tracks.map((t) => ({ songId: t.id }))
}

/** queue.jsonl records → ordered tracks (dropping ids no longer in the library). */
export function resolveQueue(entries: QueueEntry[], byId: Map<string, Track>): Track[] {
  return entries.map((e) => byId.get(e.songId)).filter((t): t is Track => Boolean(t))
}

// ---- Library ↔ folder sync -------------------------------------------------

const MEDIA_EXTENSIONS = new Set<string>([...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS])

/** Last path segment, e.g. `a/b/song.mp4` → `song.mp4`. */
export function baseName(path: string): string {
  return path.split('/').pop() ?? path
}

/** File name without its extension, used to recognize legacy scan-generated titles. */
export function rawTitleFromFileName(path: string): string {
  const name = baseName(path)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

const LOWERCASE_TITLE_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'nor', 'of', 'on', 'or', 'the', 'to', 'vs', 'with'])

function humanizeFilePart(value: string, title: boolean): string {
  return value
    .split(/[_-]+/)
    .filter(Boolean)
    .map((word, index) => {
      const lower = word.toLowerCase()
      if (title && index > 0 && LOWERCASE_TITLE_WORDS.has(lower)) return lower
      if (/^[a-z]+\d+$/i.test(word)) return word.toUpperCase()
      return lower.charAt(0).toUpperCase() + lower.slice(1)
    })
    .join(' ')
}

/** Readable fallback identity for `song_title--artist_name.ext` filenames. */
export function trackDetailsFromFileName(path: string): { title: string; artist: string } {
  const stem = rawTitleFromFileName(path)
  const separator = stem.indexOf('--')
  const titlePart = separator === -1 ? stem : stem.slice(0, separator)
  const artistPart = separator === -1 ? '' : stem.slice(separator + 2)
  return {
    title: humanizeFilePart(titlePart, true),
    artist: humanizeFilePart(artistPart, false)
  }
}

/** Media files inside the music folder, from the vault index. */
export function mediaFilesInFolder(entries: readonly PluginIndexEntry[], musicPath: string): string[] {
  const prefix = musicPath.replace(/\/+$/, '') + '/'
  return entries
    .map((e) => e.relPath)
    .filter((p) => p.startsWith(prefix) && MEDIA_EXTENSIONS.has(fileExtension(p)))
}

export interface LibrarySync {
  /** Files in the folder with no track row yet. */
  toAdd: string[]
  /** Tracks whose file vanished but whose file name exists elsewhere — heal to that path. */
  toHeal: { track: Track; newPath: string }[]
  /** Track ids whose file is gone and not found anywhere in the vault. */
  missing: Set<string>
}

/**
 * Diff the on-disk music folder against the tracks dataset: new files get rows,
 * tracks whose file moved are re-matched by file name anywhere in the vault
 * (the "search for filename" recovery), tracks whose file is gone are flagged.
 */
export function computeLibrarySync(
  tracks: Track[],
  folderFiles: string[],
  allEntries: readonly PluginIndexEntry[]
): LibrarySync {
  const known = new Set(tracks.map((t) => t.file))
  const present = new Set(folderFiles)
  const vaultPaths = new Set(allEntries.map(entry => entry.relPath))
  const toAdd = folderFiles.filter((f) => !known.has(f))

  // Vault-wide media basename → paths, for healing moved files.
  const byBase = new Map<string, string[]>()
  for (const entry of allEntries) {
    if (!MEDIA_EXTENSIONS.has(fileExtension(entry.relPath))) continue
    const base = baseName(entry.relPath).toLowerCase()
    const list = byBase.get(base)
    if (list) list.push(entry.relPath)
    else byBase.set(base, [entry.relPath])
  }

  const toHeal: { track: Track; newPath: string }[] = []
  const missing = new Set<string>()
  const claimed = new Set([...known, ...toAdd])
  for (const track of tracks) {
    if (present.has(track.file)) continue
    const inVault = vaultPaths.has(track.file)
    if (inVault) continue // moved out of the music folder but still valid
    const candidates = (byBase.get(baseName(track.file).toLowerCase()) ?? []).filter(
      (p) => !claimed.has(p) || toAdd.includes(p)
    )
    if (candidates.length === 1) {
      toHeal.push({ track, newPath: candidates[0] })
      claimed.add(candidates[0])
      const addIdx = toAdd.indexOf(candidates[0])
      if (addIdx !== -1) toAdd.splice(addIdx, 1) // healed, not a new song
    } else {
      missing.add(track.id)
    }
  }

  return { toAdd, toHeal, missing }
}

/** Stable-but-unique id for a newly scanned track. */
export function newTrackId(): string {
  return `song_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Resolve a cover file name to its current vault-relative path by searching the
 * index (case-insensitive basename match). Accepts a stored path too — its
 * basename is what gets matched, with an exact-path hit preferred.
 */
export function resolveCoverPath(entries: readonly PluginIndexEntry[], cover: string | undefined): string | null {
  if (!cover) return null
  const exact = entries.find((e) => e.relPath === cover)
  if (exact) return exact.relPath
  // An explicit vault path (e.g. an image imported into `.valley/`, which the
  // index doesn't list) is trusted as-is; bare file names match by basename.
  if (cover.includes('/')) return cover
  const base = baseName(cover).toLowerCase()
  const match = entries.find((e) => baseName(e.relPath).toLowerCase() === base)
  return match ? match.relPath : null
}
