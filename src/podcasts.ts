import type { PluginIndexEntry } from '@valley/plugin-sdk'
import { IMAGE_EXTENSIONS, fileExtension } from '@valley/plugin-sdk/fileTypes'
import { baseName, rawTitleFromFileName, trackDetailsFromFileName } from './data'
import type { Track } from './types'

export type LibraryMode = 'music' | 'podcast'

/** One show: a direct subfolder of the podcast folder (loose files form a show named after the folder itself). */
export interface PodcastShow {
  /** Realm-relative folder path; stable identity for navigation. */
  id: string
  name: string
  /** Numbered files newest first; otherwise alphabetical by title. */
  episodes: Track[]
  /** Image inside the show folder, preferring cover/folder/artwork names. */
  coverPath: string | null
}

export interface EpisodeProgress {
  position: number
  duration: number
  updatedAt: string
}

const COVER_NAMES = ['cover', 'folder', 'artwork', 'poster', 'show', 'podcast']
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

export function isEpisode(track: Pick<Track, 'file'>, podcastPath: string): boolean {
  return Boolean(podcastPath) && track.file.startsWith(`${podcastPath}/`)
}

export function showFolder(file: string, podcastPath: string): string {
  const rest = file.slice(podcastPath.length + 1).split('/')
  return rest.length > 1 ? `${podcastPath}/${rest[0]}` : podcastPath
}

/** Images directly inside each folder, by folder path. */
function folderImages(entries: readonly PluginIndexEntry[]): Map<string, string[]> {
  const byFolder = new Map<string, string[]>()
  for (const { relPath: path } of entries) {
    const slash = path.lastIndexOf('/')
    if (slash < 0 || !(IMAGE_EXTENSIONS as readonly string[]).includes(fileExtension(path))) continue
    const folder = path.slice(0, slash)
    const list = byFolder.get(folder)
    if (list) list.push(path)
    else byFolder.set(folder, [path])
  }
  return byFolder
}

function showCover(images: readonly string[] | undefined): string | null {
  if (!images) return null
  const sorted = [...images].sort(collator.compare)
  return sorted.find(path => COVER_NAMES.includes(rawTitleFromFileName(path).toLowerCase())) ?? sorted[0] ?? null
}

/** The shared album tag when every episode carries the same one, else the humanized folder name. */
function showName(folder: string, episodes: readonly Track[]): string {
  const albums = new Set(episodes.map(episode => episode.album?.trim() ?? ''))
  const [album] = albums
  return albums.size === 1 && album ? album : trackDetailsFromFileName(`${baseName(folder)}.folder`).title || baseName(folder)
}

function sortEpisodes(episodes: Track[]): Track[] {
  const numbered = episodes.every(episode => /^\d/.test(baseName(episode.file)))
  return numbered
    ? episodes.sort((a, b) => collator.compare(baseName(b.file), baseName(a.file)))
    : episodes.sort((a, b) => collator.compare(a.title, b.title))
}

export function podcastShows(episodes: readonly Track[], podcastPath: string, entries: readonly PluginIndexEntry[]): PodcastShow[] {
  if (!podcastPath) return []
  const byFolder = new Map<string, Track[]>()
  for (const episode of episodes) {
    const folder = showFolder(episode.file, podcastPath)
    const list = byFolder.get(folder)
    if (list) list.push(episode)
    else byFolder.set(folder, [episode])
  }
  const images = folderImages(entries)
  return [...byFolder.entries()]
    .map(([id, list]) => ({
      id,
      name: showName(id, list),
      episodes: sortEpisodes(list),
      coverPath: showCover(images.get(id))
    }))
    .sort((a, b) => collator.compare(a.name, b.name))
}

/** Saved position worth resuming: past the first seconds and not at the end. */
export function resumePosition(progress: EpisodeProgress | undefined): number {
  if (!progress || progress.position < 5) return 0
  if (progress.duration > 0 && progress.position > progress.duration - 15) return 0
  return progress.position
}

export function readProgress(value: unknown): Record<string, EpisodeProgress> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result: Record<string, EpisodeProgress> = {}
  for (const [id, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object') continue
    const { position, duration, updatedAt } = entry as Record<string, unknown>
    if (typeof position !== 'number' || !Number.isFinite(position) || position < 0) continue
    result[id] = {
      position,
      duration: typeof duration === 'number' && Number.isFinite(duration) && duration > 0 ? duration : 0,
      updatedAt: typeof updatedAt === 'string' ? updatedAt : ''
    }
  }
  return result
}

/** A listener-marked point in an episode: where it is and an optional short label. */
export interface EpisodeMoment {
  at: number
  label: string
}

export const MOMENT_LIMIT = 100
export const MOMENT_LABEL_LIMIT = 120
export const PODCAST_RATES = [0.75, 1, 1.25, 1.5, 1.75, 2] as const

export function readMoments(value: unknown): Record<string, EpisodeMoment[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result: Record<string, EpisodeMoment[]> = {}
  for (const [id, list] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue
    const moments = list
      .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
      .filter(entry => typeof entry.at === 'number' && Number.isFinite(entry.at) && entry.at >= 0)
      .map(entry => ({ at: entry.at as number, label: typeof entry.label === 'string' ? entry.label.slice(0, MOMENT_LABEL_LIMIT) : '' }))
      .sort((a, b) => a.at - b.at)
      .slice(0, MOMENT_LIMIT)
    if (moments.length) result[id] = moments
  }
  return result
}

export function readPodcastRate(value: unknown): number {
  return typeof value === 'number' && (PODCAST_RATES as readonly number[]).includes(value) ? value : 1
}

/** The next speed in the cycle, wrapping back to the slowest. */
export function nextPodcastRate(rate: number): number {
  const index = (PODCAST_RATES as readonly number[]).indexOf(rate)
  return PODCAST_RATES[(index + 1) % PODCAST_RATES.length]
}
