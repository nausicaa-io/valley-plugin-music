import type { PluginIndexEntry } from '@valley/plugin-sdk'
import { IMAGE_EXTENSIONS, fileExtension } from '@valley/plugin-sdk/fileTypes'
import { baseName, rawTitleFromFileName, trackDetailsFromFileName } from './data'
import type { Track } from './types'

export type LibraryMode = 'music' | 'podcast'

/** One show: every episode whose Show (album) says so, wherever it sits in the podcast folder. */
export interface PodcastShow {
  /** The show name folded to lower case; stable identity for navigation and saved choices. */
  id: string
  name: string
  /** The folder that holds every episode of the show (the podcast folder when they are spread out). */
  folder: string
  /** Numbered files newest first; otherwise alphabetical by title. */
  episodes: Track[]
  /** Image beside the episodes: one named after the show, else a cover/folder/artwork image in a folder only this show uses. */
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

const parentFolder = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')))
const folderTitle = (folder: string): string => trackDetailsFromFileName(`${baseName(folder)}.folder`).title || baseName(folder)

/** An episode's show: its Show tag or edited Show, else the name of the folder it sits in. */
function episodeShowName(track: Pick<Track, 'file' | 'album'>): string {
  return track.album?.trim() || folderTitle(parentFolder(track.file))
}

export function episodeShowId(track: Pick<Track, 'file' | 'album'>): string {
  return episodeShowName(track).toLocaleLowerCase()
}

/** Images directly inside each folder, by folder path. */
function folderImages(entries: readonly PluginIndexEntry[]): Map<string, string[]> {
  const byFolder = new Map<string, string[]>()
  for (const { relPath: path } of entries) {
    if (!(IMAGE_EXTENSIONS as readonly string[]).includes(fileExtension(path))) continue
    const folder = parentFolder(path)
    const list = byFolder.get(folder)
    if (list) list.push(path)
    else byFolder.set(folder, [path])
  }
  return byFolder
}

function commonFolder(files: readonly string[], fallback: string): string {
  let common = parentFolder(files[0] ?? '')
  for (const file of files) while (common && !file.startsWith(`${common}/`)) common = parentFolder(common)
  return common.startsWith(`${fallback}/`) ? common : fallback
}

function showCover(id: string, folders: ReadonlySet<string>, shared: ReadonlySet<string>, images: ReadonlyMap<string, string[]>): string | null {
  const candidates = [...folders].flatMap(folder => images.get(folder) ?? []).sort(collator.compare)
  const named = candidates.find(path => rawTitleFromFileName(path).toLocaleLowerCase() === id)
  if (named) return named
  const own = candidates.filter(path => !shared.has(parentFolder(path)))
  return own.find(path => COVER_NAMES.includes(rawTitleFromFileName(path).toLowerCase())) ?? own[0] ?? null
}

function sortEpisodes(episodes: Track[]): Track[] {
  const numbered = episodes.every(episode => /^\d/.test(baseName(episode.file)))
  return numbered
    ? episodes.sort((a, b) => collator.compare(baseName(b.file), baseName(a.file)))
    : episodes.sort((a, b) => collator.compare(a.title, b.title))
}

export function podcastShows(episodes: readonly Track[], podcastPath: string, entries: readonly PluginIndexEntry[]): PodcastShow[] {
  if (!podcastPath) return []
  const byShow = new Map<string, { name: string; episodes: Track[]; folders: Set<string> }>()
  const showsInFolder = new Map<string, Set<string>>()
  for (const episode of episodes) {
    const id = episodeShowId(episode), folder = parentFolder(episode.file)
    const show = byShow.get(id) ?? { name: episodeShowName(episode), episodes: [], folders: new Set<string>() }
    show.episodes.push(episode)
    show.folders.add(folder)
    byShow.set(id, show)
    showsInFolder.set(folder, (showsInFolder.get(folder) ?? new Set()).add(id))
  }
  const shared = new Set([...showsInFolder].filter(([, ids]) => ids.size > 1).map(([folder]) => folder))
  const images = folderImages(entries)
  return [...byShow.entries()]
    .map(([id, show]) => ({
      id,
      name: show.name,
      folder: commonFolder(show.episodes.map(episode => episode.file), podcastPath),
      episodes: sortEpisodes(show.episodes),
      coverPath: showCover(id, show.folders, shared, images)
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
const PODCAST_RATES = [0.75, 1, 1.25, 1.5, 1.75, 2] as const

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
