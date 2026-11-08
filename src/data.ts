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
  // The first `limit` of a stable sort: an entry goes after every kept entry that does not rank below it.
  const top: { track: Track; plays: number }[] = []
  const order = (a: { track: Track; plays: number }, b: { track: Track; plays: number }): number => b.plays - a.plays || a.track.title.localeCompare(b.track.title)
  for (const [songId, plays] of counts) {
    const track = byId.get(songId)
    if (!track || limit <= 0) continue
    const entry = { track, plays }
    if (top.length === limit && order(top[limit - 1], entry) <= 0) continue
    let at = top.length
    while (at > 0 && order(top[at - 1], entry) > 0) at--
    top.splice(at, 0, entry)
    if (top.length > limit) top.pop()
  }
  return top
}

/** Queue tracks → queue.jsonl records. */
export function serializeQueue(tracks: Track[]): QueueEntry[] {
  return tracks.map((t) => ({ songId: t.id }))
}

/** queue.jsonl records → ordered tracks (dropping ids no longer in the library). */
export function resolveQueue(entries: QueueEntry[], byId: Map<string, Track>): Track[] {
  return entries.map((e) => byId.get(e.songId)).filter((t): t is Track => Boolean(t))
}

const searchTexts = new WeakMap<readonly Track[], { title: string[]; artist: string[]; file: string[] }>()

/** Tracks whose lowercased title, artist or (with `withFile`) file name contains `q`, in library order. */
export function searchTracks(tracks: readonly Track[], q: string, withFile: boolean): Track[] {
  let text = searchTexts.get(tracks)
  if (!text) {
    text = { title: tracks.map((t) => t.title.toLowerCase()), artist: tracks.map((t) => t.artist.toLowerCase()), file: tracks.map((t) => baseName(t.file).toLowerCase()) }
    searchTexts.set(tracks, text)
  }
  const { title, artist, file } = text
  return tracks.filter((_, i) => title[i].includes(q) || artist[i].includes(q) || (withFile && file[i].includes(q)))
}

// ---- Library ↔ folder sync -------------------------------------------------

const MEDIA_EXTENSIONS = new Set<string>([...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS])

/** Last path segment, e.g. `a/b/song.mp4` → `song.mp4`. */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
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

/** Media files inside the music folder, from the realm index. */
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
  /** Track ids whose file is gone and not found anywhere in the realm. */
  missing: Set<string>
}

/**
 * Diff the on-disk music folder against the tracks dataset: new files get rows,
 * tracks whose file moved are re-matched by file name anywhere in the realm
 * (the "search for filename" recovery), tracks whose file is gone are flagged.
 */
export function computeLibrarySync(
  tracks: Track[],
  folderFiles: string[],
  allEntries: readonly PluginIndexEntry[]
): LibrarySync {
  const known = new Set(tracks.map((t) => t.file))
  const present = new Set(folderFiles)
  const toAdd = folderFiles.filter((f) => !known.has(f))
  const toHeal: { track: Track; newPath: string }[] = []
  const missing = new Set<string>()
  const lost = tracks.filter((track) => !present.has(track.file))
  if (!lost.length) return { toAdd, toHeal, missing }

  const realmPaths = new Set(allEntries.map(entry => entry.relPath))
  // Realm-wide media basename → paths, for healing moved files.
  const byBase = new Map<string, string[]>()
  for (const entry of allEntries) {
    if (!MEDIA_EXTENSIONS.has(fileExtension(entry.relPath))) continue
    const base = baseName(entry.relPath).toLowerCase()
    const list = byBase.get(base)
    if (list) list.push(entry.relPath)
    else byBase.set(base, [entry.relPath])
  }

  // `pending` counts each path's remaining occurrences in `toAdd`; a heal takes the first one out, as `splice` did.
  const pending = new Map<string, number>()
  for (const file of toAdd) pending.set(file, (pending.get(file) ?? 0) + 1)
  const healedAdds = new Map<string, number>()
  const claimed = new Set([...known, ...toAdd])
  for (const track of lost) {
    const inRealm = realmPaths.has(track.file)
    if (inRealm) continue // moved out of the music folder but still valid
    const candidates = (byBase.get(baseName(track.file).toLowerCase()) ?? []).filter(
      (p) => !claimed.has(p) || (pending.get(p) ?? 0) > 0
    )
    if (candidates.length === 1) {
      toHeal.push({ track, newPath: candidates[0] })
      claimed.add(candidates[0])
      const left = pending.get(candidates[0]) ?? 0
      if (left > 0) { // healed, not a new song
        pending.set(candidates[0], left - 1)
        healedAdds.set(candidates[0], (healedAdds.get(candidates[0]) ?? 0) + 1)
      }
    } else {
      missing.add(track.id)
    }
  }
  if (!healedAdds.size) return { toAdd, toHeal, missing }
  const kept = toAdd.filter((file) => {
    const skip = healedAdds.get(file) ?? 0
    if (!skip) return true
    healedAdds.set(file, skip - 1)
    return false
  })
  return { toAdd: kept, toHeal, missing }
}

/** Stable-but-unique id for a newly scanned track. */
export function newTrackId(): string {
  return `song_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Resolve a cover file name to its current realm-relative path by searching the
 * index (case-insensitive basename match). Accepts a stored path too — its
 * basename is what gets matched, with an exact-path hit preferred.
 */
export function resolveCoverPath(entries: readonly PluginIndexEntry[], cover: string | undefined): string | null {
  if (!cover) return null
  const index = coverIndex(entries)
  if (index.paths.has(cover)) return cover
  // An explicit realm path (e.g. an image imported into `.valley/`, which the
  // index doesn't list) is trusted as-is; bare file names match by basename.
  if (cover.includes('/')) return cover
  return index.byBase.get(baseName(cover).toLowerCase()) ?? null
}

const coverIndexes = new WeakMap<readonly PluginIndexEntry[], { paths: Set<string>; byBase: Map<string, string> }>()

/** Every path, and the first path per lowercase basename, built once per index snapshot. */
function coverIndex(entries: readonly PluginIndexEntry[]): { paths: Set<string>; byBase: Map<string, string> } {
  let index = coverIndexes.get(entries)
  if (!index) {
    index = { paths: new Set(), byBase: new Map() }
    for (const entry of entries) {
      index.paths.add(entry.relPath)
      const base = baseName(entry.relPath).toLowerCase()
      if (!index.byBase.has(base)) index.byBase.set(base, entry.relPath)
    }
    coverIndexes.set(entries, index)
  }
  return index
}
