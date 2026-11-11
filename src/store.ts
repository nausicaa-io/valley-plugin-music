import { MusicLibrary, conflict } from './library'
import { uiText } from './localization'
import type { DataRecord } from '@valley/plugin-sdk/types'
import type { DatasetBatchOperation, DatasetKey, DatasetRecord, DatasetTransactionOperation, DatasetWhere } from '@valley/plugin-sdk'
import type {
  ValleyPluginApi,
  WorkspaceViewStateProvider
} from '@valley/plugin-sdk'
import { createIndexObserver } from '@valley/plugin-sdk'
import { assetUrlForRelPath } from '@valley/plugin-sdk/fileTypes'
import { normalizeRelPath } from '@valley/plugin-sdk/paths'
import {
  dedupeHistory,
  mediaFilesInFolder,
  mostListened,
  resolveCoverPath,
  resolvePlaylistTracks
} from './data'
import {
  libraryCredits,
  newArtistId,
  mergeArtistMetadata,
  normalizeArtistName,
  patchArtistMetadata,
  resolveArtist,
  sameArtist,
  trackArtists,
  trackCredits,
  tracksForArtist,
  upsertArtists
} from './artists'
import type { Artist, HistoryEntry, Playlist, RepeatMode, Track } from './types'
import type { MusicPlaybackAction, MusicPlaybackSnapshot } from './playback'
export { nextIndex } from './playback'
import { api as runtimeApi } from './runtime'
import { MediaMetadata, MetadataCancelled } from './mediaMetadata'
import { MOMENT_LABEL_LIMIT, MOMENT_LIMIT, isEpisode, podcastShows, readMoments, readPodcastRate, readProgress, resumePosition, type EpisodeMoment, type EpisodeProgress, type LibraryMode, type PodcastShow } from './podcasts'

const TRACKS_DATASET = 'music.tracks'
const PLAYLISTS_DATASET = 'music.playlists'
const PLAYLIST_TRACKS_DATASET = 'music.playlist_tracks'
const ARTISTS_DATASET = 'music.artists'
const ARTIST_ALIASES_DATASET = 'music.artist_aliases'
const PLAY_EVENTS_DATASET = 'music.play_events'

function groupRows(rows: DatasetRecord[], field: string, ordered = false): Map<unknown, DatasetRecord[]> {
  const index = new Map<unknown, DatasetRecord[]>()
  for (const row of rows) {
    const entries = index.get(row[field])
    if (entries) entries.push(row)
    else index.set(row[field], [row])
  }
  if (ordered) for (const entries of index.values()) entries.sort((a, b) => Number(a.position) - Number(b.position))
  return index
}

interface DatasetStore {
  read(): Promise<DataRecord[]>
  append(record: DataRecord): Promise<boolean>
  update(idValue: string, record: DataRecord): Promise<boolean>
  delete(idValue: string): Promise<boolean>
  replace(records: DataRecord[]): Promise<boolean>
  subscribe(listener: () => void): () => void
}

const PLAYER_SETTINGS_KEY = 'player'
const PROGRESS_SETTINGS_KEY = 'podcastProgress'
const PROGRESS_LIMIT = 300
const MOMENTS_SETTINGS_KEY = 'podcastMoments'
const RATE_SETTINGS_KEY = 'podcastRate'

/** Which podcast view the content page shows while the library is in podcast mode. */
export type PodcastView = { mode: 'home' } | { mode: 'show'; id: string }

function narrowPodcastView(value: unknown): PodcastView {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return record.mode === 'show' && typeof record.id === 'string' && record.id ? { mode: 'show', id: record.id } : { mode: 'home' }
}

export function normalizeMusicPath(value: unknown): string {
  return normalizeRelPath(value)
}

/**
 * Which view the content page (`music.page`) shows. Store-owned so the left
 * panel (and commands) can navigate the page: clicking a playlist/song there
 * drives this, not Page-local state. Playback state (`focusedPlaylistId`,
 * queue) stays independent so pressing ▶ never force-navigates the page.
 */
export type PageView =
  | { mode: 'home' }
  | { mode: 'playlist'; id: string; reveal?: string }
  | { mode: 'song'; id: string }
  | { mode: 'artist'; id: string; reveal?: string }

export function narrowPageView(rec: unknown): PageView | null {
  if (rec && typeof rec === 'object') {
    const o = rec as Record<string, unknown>
    if ((o.mode === 'playlist' || o.mode === 'song' || o.mode === 'artist') && typeof o.id === 'string') {
      return {
        mode: o.mode,
        id: o.id,
        ...((o.mode === 'playlist' || o.mode === 'artist') && typeof o.reveal === 'string'
          ? { reveal: o.reveal }
          : {})
      }
    }
    if (o.mode === 'home') return { mode: 'home' }
  }
  return null
}

/** Parse a persisted nav-state record back into a `PageView` (defaults to home). */
function parsePageView(rec: unknown): PageView {
  return narrowPageView(rec) ?? { mode: 'home' }
}

/** A destination a Music tab can be pinned to: its instance id encodes it (see `pageNavigator.ts`). */
export type PageTarget =
  | { kind: 'home' }
  | { kind: 'podcasts' }
  | { kind: 'playlist' | 'artist' | 'song' | 'show'; id: string }

export interface MusicLinkState extends Record<string, unknown> {
  v: 1
  view: PageView
  searchQuery: string
}

export type MusicPanelSection = 'songs' | 'favorites' | 'playlists' | 'artists'

const DEFAULT_LEFT_SECTIONS: Record<MusicPanelSection, boolean> = {
  songs: false,
  favorites: false,
  playlists: true,
  artists: true
}

/** Library projections retain their identity during playback, queue, and view changes. */
export interface MusicSnapshot {
  loading: boolean
  libraryError: string | null
  musicPath: string
  podcastPath: string
  /** Music tracks only; podcast episodes live in `episodes`. */
  tracks: Track[]
  episodes: Track[]
  shows: PodcastShow[]
  playlists: Playlist[]
  /** Artist registry (upserted from song artist names); identity for artist pages. */
  artists: Artist[]
  playlistTracks: Record<string, Track[]>
  favorites: Set<string>
  /** Most-recent-first, de-duplicated recently played tracks. */
  history: Track[]
  recentlyPlayed: Track[]
  /** Tracks ranked by play count. */
  topPlayed: { track: Track; plays: number }[]
  /** Track ids whose file is gone from the realm. */
  missing: Set<string>
  /** Playlist id → resolved realm path of its cover image (or null). */
  playlistCovers: Record<string, string | null>
  sessionId: string | null
  playbackRevision: number
  playbackRate: number
  playbackSampledAt: number
  playbackSampleAge: number
  currentTrack: Track | null
  currentPlaylistId: string | null
  isPlaying: boolean
  currentTime: number
  duration: number
  volume: number
  /** Decoding the current track before it can start (large files take a moment). */
  buffering: boolean
  playError: string | null
  shuffle: boolean
  repeatMode: RepeatMode
  /** Upcoming tracks after the current one. */
  upNext: Track[]
  /** Track the idle player offers to resume (current, else last played). */
  resumeTrack: Track | null
  /** Bumped whenever an embedded-cover blob URL resolves. */
  coverVersion: number
  /** Which view the content page shows (driven by the left panel/commands). */
  pageView: PageView
  /** Bumped on every navigation — even to the same target — so the page can
   *  re-run the imperative "scroll to + flash this song" reveal. */
  pageViewNonce: number
  canGoBack: boolean
  canGoForward: boolean
  pageSearch: string
  leftPanelSearch: string
  leftPanelSections: Record<MusicPanelSection, boolean>
  rightQueueOpen: boolean
  rightHistoryOpen: boolean
  rightPanelScrollTop: number
  rightViewNonce: number
  libraryMode: LibraryMode
  podcastView: PodcastView
  podcastCanGoBack: boolean
  podcastCanGoForward: boolean
  /** Saved listening position per episode id. */
  episodeProgress: Record<string, EpisodeProgress>
  /** Listener-marked key moments per episode id, ordered by time. */
  episodeMoments: Record<string, EpisodeMoment[]>
  /** Playback speed applied to podcast episodes; songs always play at 1×. */
  podcastRate: number
}

interface PlayerPreferences {
  volume: number
  shuffle: boolean
  repeat: RepeatMode
}

function readPlayerPreferences(value: unknown): PlayerPreferences {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const volume = typeof record.volume === 'number' && Number.isFinite(record.volume) && record.volume >= 0 && record.volume <= 1
    ? record.volume
    : 0.8
  const repeat = record.repeat === 'all' || record.repeat === 'one' ? record.repeat : 'off'
  return { volume, shuffle: record.shuffle === true, repeat }
}

export class MusicStore {
  private api: ValleyPluginApi
  private listeners = new Set<() => void>()
  private viewStateListeners = new Set<() => void>()
  private disposed = false

  // Library state
  private tracks: Track[] = []
  private trackById = new Map<string, Track>()
  private playlists: Playlist[] = []
  private artists: Artist[] = []
  private focusedPlaylistId: string | null = null
  private pageView: PageView = { mode: 'home' }
  private pageViewNonce = 0
  private pageHistory: PageView[] = [{ mode: 'home' }]
  private pageHistoryIndex = 0
  private pageSearch = ''
  private leftPanelSearch = ''
  private leftPanelSections = { ...DEFAULT_LEFT_SECTIONS }
  private rightQueueOpen = true
  private rightHistoryOpen = false
  private rightPanelScrollTop = 0
  private rightViewNonce = 0
  private pendingWorkspaceMainState: unknown | null = null
  private historyEntries: HistoryEntry[] = []
  private recentlyPlayedIds: string[] | null = null
  private missing = new Set<string>()
  private loading = true
  private libraryError: string | null = null
  private navLoaded = false
  private pendingLinkState: Record<string, unknown> | null = null
  private synced = false
  private musicPathOverride: string | null = null
  private observedMusicPath: string
  private observedPodcastPath: string
  private libraryModeOverride: LibraryMode | null = null
  private observedLibraryMode: LibraryMode
  private podcastView: PodcastView = { mode: 'home' }
  private podcastHistory: PodcastView[] = [{ mode: 'home' }]
  private podcastHistoryIndex = 0
  private split: { tracks: Track[]; podcastPath: string; music: Track[]; episodes: Track[] } | null = null
  private showCache: { episodes: Track[]; entries: unknown; shows: PodcastShow[] } | null = null
  private episodeProgress: Record<string, EpisodeProgress>
  private progressTimer: number | null = null
  private progressWrite: Promise<boolean> = Promise.resolve(true)
  private progressSavedAt = 0
  private resumedEpisodeId: string | null = null
  private episodeMoments: Record<string, EpisodeMoment[]> = {}
  private podcastRate = 1
  private rateSyncedFor: string | null = null
  private offSettings: () => void

  // Playback state
  private queue: Track[] = []
  private queueIndex = -1
  private currentTrack: Track | null = null
  private currentPlaylistId: string | null = null
  private isPlaying = false
  private currentTime = 0
  private duration = 0
  private volume: number
  private buffering = false
  private playError: string | null = null
  private shuffle: boolean
  private repeatMode: RepeatMode
  private sessionId: string | null = null
  private playbackRevision = -1
  private playbackRate = 1
  private playbackSampledAt = 0
  private playbackSampleAge = 0
  private playbackReady: Promise<void>
  private offBackendPlayback: () => void
  private pendingPlayback = new Set<Promise<boolean>>()
  private playbackFailure = false
  private playbackOutcome: 'unknown' | undefined
  private lastPlayEventId: string | undefined

  private metadata: MediaMetadata
  private offMetadata: () => void
  private metadataRevoked = false
  private playbackCoverFile: string | null = null
  private offPlaybackCover: (() => void) | null = null
  private syncWork: Promise<void> | null = null
  private syncDirty = false
  private coverVersion = 0

  private snapshot!: MusicSnapshot
  private index: ReturnType<typeof createIndexObserver>
  private offIndex: () => void
  private indexReady: { promise: Promise<void>; resolve(): void; reject(error: Error): void } | undefined
  private disposal: Promise<void> | undefined
  private offBeforeUnload: () => void
  private offDatasets: () => void
  private reloadWork: Promise<void> | null = null
  private reloadDirty = false

  constructor(api: ValleyPluginApi, private retired?: Promise<void>) {
    this.api = api
    const player = readPlayerPreferences(api.settings.get()[PLAYER_SETTINGS_KEY])
    this.volume = player.volume
    this.shuffle = player.shuffle
    this.repeatMode = player.repeat
    this.observedMusicPath = this.musicPath()
    this.observedPodcastPath = this.podcastPath()
    this.observedLibraryMode = this.libraryMode()
    this.episodeProgress = readProgress(api.settings.get()[PROGRESS_SETTINGS_KEY])
    this.episodeMoments = readMoments(api.settings.get()[MOMENTS_SETTINGS_KEY])
    this.podcastRate = readPodcastRate(api.settings.get()[RATE_SETTINGS_KEY])
    this.offSettings = api.settings.subscribe(() => this.onSettingsChanged())
    this.index = createIndexObserver(api, { fields: [] })
    this.metadata = new MediaMetadata(api)
    const realm = api.getState().realm?.path
    const offRealm = api.realm.onChanged(() => this.metadata.invalidate())
    const offRoot = api.subscribeState(['realm'], state => {
      const next = state.state.realm?.path
      if (next !== realm) { this.metadataRevoked = true; this.metadata.dispose() }
    })
    this.offMetadata = () => { offRealm(); offRoot() }
    this.rebuildSnapshot()
    // The views stay usable on the library while the backend is unavailable: playback shows why it cannot start.
    const unavailable = (error: unknown): void => {
      this.playError = uiText('music.playbackUnavailable', { reason: (error instanceof Error ? error.message : String(error)).replace(/^(Error:\s*)+/, '') })
      this.emitPlayback()
    }
    let offBackendPlayback = (): void => {}
    try { offBackendPlayback = api.backend.on('playback.changed', value => this.applyPlayback(value as MusicPlaybackSnapshot)) } catch (error) { this.playError = uiText('music.playbackUnavailable', { reason: error instanceof Error ? error.message : String(error) }) }
    this.offBackendPlayback = offBackendPlayback
    this.playbackReady = Promise.resolve().then(() => api.backend.call<MusicPlaybackSnapshot>('playback.snapshot')).then(snapshot => this.applyPlayback(snapshot)).catch(unavailable)
    this.offBeforeUnload = this.api.runtime.onBeforeUnload(async () => {
      do {
        if (this.navDirty) this.flushNav()
        if (this.progressTimer !== null) this.flushProgress()
        const navigation = await this.navWrite
        const playback = await this.flushPersistence()
        const progress = await this.progressWrite
        if (!navigation || !playback || !progress) throw new Error('Could not save Music state')
      } while (this.navDirty || this.pendingPlayback.size > 0)
    })

    this.offIndex = this.index.subscribe(() => {
      if (this.disposed) return
      const snapshot = this.index.getSnapshot()
      if (snapshot.status === 'error') {
        this.indexReady?.reject(new Error(snapshot.error ?? 'Music index is unavailable'))
        this.indexReady = undefined
        return
      }
      if (snapshot.status !== 'ready') return
      this.indexReady?.resolve()
      this.indexReady = undefined
      this.emit()
      if (!this.loading && !this.synced) this.syncWhenIndexed()
    })
    const offDatasets = [this.trackStore(), this.playlistStore(), this.artistStore(), this.playHistoryStore()].map(store => store.subscribe(() => this.reloadOnDatasetChange()))
    this.offDatasets = () => offDatasets.forEach(off => off())
    void this.load().then(() => this.syncWhenIndexed()).catch(() => {})
  }

  /** Backend writes (rescan, playlist.update, track.delete...) land in the datasets; follow them. */
  private reloadOnDatasetChange(): void {
    if (!this.disposed) void this.load().catch(() => {})
  }

  // ---- Subscription -------------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  subscribeWorkspaceViewState = (listener: () => void): (() => void) => {
    this.viewStateListeners.add(listener)
    return () => this.viewStateListeners.delete(listener)
  }

  getSnapshot = (): MusicSnapshot => this.snapshot

  private emit(): void {
    if (this.disposed) return
    this.rebuildSnapshot()
    this.publish()
  }

  private emitPlayback(): void {
    if (this.disposed) return
    this.snapshot = { ...this.snapshot, ...this.playbackSnapshot() }
    this.publish()
  }

  private emitQueue(): void {
    if (this.disposed) return
    this.snapshot = { ...this.snapshot, ...this.playbackSnapshot(), ...this.queueSnapshot() }
    this.publish()
  }

  private emitView(): void {
    if (this.disposed) return
    this.snapshot = { ...this.snapshot, ...this.viewSnapshot() }
    this.listeners.forEach((listener) => listener())
  }

  private publish(): void {
    this.listeners.forEach((listener) => listener())
    this.updatePlaybackCover()
  }

  private emitViewState(): void {
    this.viewStateListeners.forEach((listener) => listener())
  }

  private rebuildSnapshot(): void {
    const playlistTracks: Record<string, Track[]> = {}
    const playlistCovers: Record<string, string | null> = {}
    const entries = this.getIndexEntries()
    for (const pl of this.playlists) {
      playlistTracks[pl.id] = resolvePlaylistTracks(pl.songIds, this.trackById)
      playlistCovers[pl.id] = resolveCoverPath(entries, pl.cover)
    }
    const { music, episodes } = this.splitLibrary()
    const musicById = new Map(music.map(track => [track.id, track]))
    if (this.showCache?.episodes !== episodes || this.showCache.entries !== entries) {
      this.showCache = { episodes, entries, shows: podcastShows(episodes, this.podcastPath(), entries) }
    }
    this.snapshot = {
      loading: this.loading,
      libraryError: this.libraryError,
      musicPath: this.musicPath(),
      podcastPath: this.podcastPath(),
      tracks: music,
      episodes,
      shows: this.showCache.shows,
      playlists: this.playlists,
      artists: this.artists,
      playlistTracks,
      favorites: new Set(this.tracks.filter((t) => t.favorite).map((t) => t.id)),
      history: dedupeHistory(this.historyEntries, this.trackById),
      recentlyPlayed: resolvePlaylistTracks(this.recentlyPlayedIds ?? [], musicById),
      topPlayed: mostListened(this.historyEntries, musicById),
      missing: this.missing,
      playlistCovers,
      ...this.playbackSnapshot(),
      ...this.queueSnapshot(),
      ...this.viewSnapshot()
    }
  }

  private playbackSnapshot() {
    const lastHistory = this.historyEntries[this.historyEntries.length - 1]
    return {
      sessionId: this.sessionId,
      playbackRevision: this.playbackRevision,
      playbackRate: this.playbackRate,
      playbackSampledAt: this.playbackSampledAt,
      playbackSampleAge: this.playbackSampleAge,
      currentTrack: this.currentTrack,
      currentPlaylistId: this.currentPlaylistId,
      isPlaying: this.isPlaying,
      currentTime: this.currentTime,
      duration: this.duration,
      volume: this.volume,
      buffering: this.buffering,
      playError: this.playError,
      shuffle: this.shuffle,
      repeatMode: this.repeatMode,
      resumeTrack:
        this.currentTrack ?? (lastHistory ? this.trackById.get(lastHistory.songId) ?? null : null),
      coverVersion: this.coverVersion,
      episodeProgress: this.episodeProgress,
      episodeMoments: this.episodeMoments,
      podcastRate: this.podcastRate
    }
  }

  private queueSnapshot() {
    return { upNext: this.queueIndex >= 0 ? this.queue.slice(this.queueIndex + 1) : [...this.queue] }
  }

  private viewSnapshot() {
    return {
      pageView: this.pageView,
      pageViewNonce: this.pageViewNonce,
      canGoBack: this.pageHistoryIndex > 0,
      canGoForward: this.pageHistoryIndex < this.pageHistory.length - 1,
      pageSearch: this.pageSearch,
      leftPanelSearch: this.leftPanelSearch,
      leftPanelSections: { ...this.leftPanelSections },
      rightQueueOpen: this.rightQueueOpen,
      rightHistoryOpen: this.rightHistoryOpen,
      rightPanelScrollTop: this.rightPanelScrollTop,
      rightViewNonce: this.rightViewNonce,
      libraryMode: this.libraryMode(),
      podcastView: this.podcastView,
      podcastCanGoBack: this.podcastHistoryIndex > 0,
      podcastCanGoForward: this.podcastHistoryIndex < this.podcastHistory.length - 1
    }
  }

  /** Episodes are the tracks inside the podcast folder; the split keeps its identity until either input changes. */
  private splitLibrary(): { music: Track[]; episodes: Track[] } {
    const podcastPath = this.podcastPath()
    if (this.split?.tracks !== this.tracks || this.split.podcastPath !== podcastPath) {
      const music: Track[] = [], episodes: Track[] = []
      for (const track of this.tracks) (isEpisode(track, podcastPath) ? episodes : music).push(track)
      this.split = { tracks: this.tracks, podcastPath, music, episodes }
    }
    return this.split
  }

  // ---- Helpers -------------------------------------------------------------

  private library(): MusicLibrary { return new MusicLibrary(this.api, file => this.metadata.read(file, true)) }

  private async datasetRows(datasetId: string, where?: DatasetWhere): Promise<DatasetRecord[]> {
    const dataset = this.api.data.dataset(datasetId)
    const rows: DatasetRecord[] = []
    let cursor: string | undefined
    do {
      const page = await dataset.query({ limit: 1000, cursor, ...(where ? { where } : {}) })
      rows.push(...page.rows)
      cursor = page.cursor
    } while (cursor)
    return rows
  }

  private datasetStore(datasetId: string, primaryKey = 'id'): DatasetStore {
    const dataset = this.api.data.dataset(datasetId)
    return {
      read: async () => this.datasetRows(datasetId) as Promise<DataRecord[]>,
      append: async (record) => {
        try { await dataset.insert(record as DatasetRecord); return true } catch { return false }
      },
      update: async (idValue, record) => {
        try {
          if (!(await dataset.get({ [primaryKey]: idValue }))) return false
          await dataset.upsert(record as DatasetRecord)
          return true
        } catch { return false }
      },
      delete: async (idValue) => {
        try { return (await dataset.delete({ [primaryKey]: idValue })).affected > 0 } catch { return false }
      },
      replace: async (records) => {
        try {
          const existing = await this.datasetRows(datasetId)
          const retained = new Set(records.map(record => record[primaryKey]))
          const before = new Map(existing.map(record => [record[primaryKey], record]))
          const keys = existing.filter(record => !retained.has(record[primaryKey])).map(record => ({ [primaryKey]: record[primaryKey] as DatasetKey[string] }))
          const changed = records.filter(record => {
            const previous = before.get(record[primaryKey] as DatasetKey[string])
            return !previous || Object.entries(record).some(([key, value]) => !Object.is(previous[key], value))
          }) as DatasetRecord[]
          const operations: DatasetBatchOperation[] = []
          if (keys.length) operations.push({ operation: 'delete-many', keys })
          if (changed.length) operations.push({ operation: 'upsert', values: changed })
          if (operations.length) await dataset.batch(operations)
          return true
        } catch { return false }
      },
      subscribe: (listener) => dataset.subscribe(listener)
    }
  }

  private artistStore(): DatasetStore {
    const artists = this.api.data.dataset(ARTISTS_DATASET)
    const aliases = this.api.data.dataset(ARTIST_ALIASES_DATASET)
    const read = async (): Promise<DataRecord[]> => {
      const [artistRows, aliasRows] = await Promise.all([this.datasetRows(ARTISTS_DATASET), this.datasetRows(ARTIST_ALIASES_DATASET)])
      const aliasesByArtist = groupRows(aliasRows, 'artistId')
      return artistRows.map((artist) => ({
        ...artist,
        aliases: (aliasesByArtist.get(artist.id) ?? []).map((entry) => String(entry.alias))
      })) as DataRecord[]
    }
    const write = async (record: DataRecord): Promise<void> => {
      const id = String(record.id ?? '')
      const values = {
        id,
        name: String(record.name ?? ''),
        image: typeof record.image === 'string' ? record.image : null,
        bio: typeof record.bio === 'string' ? record.bio : null
      }
      const existing = await this.datasetRows(ARTIST_ALIASES_DATASET, { artistId: id })
      const nextAliases = Array.isArray(record.aliases) ? record.aliases.filter((alias): alias is string => typeof alias === 'string') : []
      const retained = new Set(nextAliases)
      const current = new Set(existing.map((entry) => String(entry.alias)))
      const added = [...retained].filter((alias) => !current.has(alias)).map((alias) => ({ artistId: id, alias }))
      const operations: DatasetTransactionOperation[] = [
        { dataset: ARTISTS_DATASET, operation: 'upsert', values }
      ]
      const keys = existing.filter((entry) => !retained.has(String(entry.alias))).map((entry) => ({ artistId: id, alias: String(entry.alias) }))
      if (keys.length) operations.push({ dataset: ARTIST_ALIASES_DATASET, operation: 'delete-many', keys })
      if (added.length) operations.push({ dataset: ARTIST_ALIASES_DATASET, operation: 'upsert', values: added })
      await this.api.data.transaction(operations)
    }
    return {
      read,
      append: async (record) => { try { await write(record); return true } catch { return false } },
      update: async (id, record) => { try { if (!(await artists.get({ id }))) return false; await write(record); return true } catch { return false } },
      delete: async (id) => (await artists.delete({ id })).affected > 0,
      replace: async (records) => {
        try {
          const existing = await read()
          const operations: DatasetTransactionOperation[] = []
          if (existing.length) operations.push({ dataset: ARTISTS_DATASET, operation: 'delete-many', keys: existing.map(record => ({ id: String(record.id ?? '') })) })
          if (records.length) operations.push({ dataset: ARTISTS_DATASET, operation: 'upsert', values: records.map(record => ({ id: String(record.id ?? ''), name: String(record.name ?? ''), image: typeof record.image === 'string' ? record.image : null, bio: typeof record.bio === 'string' ? record.bio : null })) })
          const nextAliases = records.flatMap(record => (Array.isArray(record.aliases) ? record.aliases : []).filter((alias): alias is string => typeof alias === 'string').map(alias => ({ artistId: String(record.id ?? ''), alias })))
          if (nextAliases.length) operations.push({ dataset: ARTIST_ALIASES_DATASET, operation: 'upsert', values: nextAliases })
          if (operations.length) await this.api.data.transaction(operations)
          return true
        } catch { return false }
      },
      subscribe: (listener) => {
        const offArtists = artists.subscribe(listener)
        const offAliases = aliases.subscribe(listener)
        return () => { offArtists(); offAliases() }
      }
    }
  }

  private playlistStore(): DatasetStore {
    const playlists = this.api.data.dataset(PLAYLISTS_DATASET)
    const members = this.api.data.dataset(PLAYLIST_TRACKS_DATASET)
    const read = async (): Promise<DataRecord[]> => {
      const [rows, links] = await Promise.all([this.datasetRows(PLAYLISTS_DATASET), this.datasetRows(PLAYLIST_TRACKS_DATASET)])
      const tracksByPlaylist = groupRows(links, 'playlistId', true)
      return rows.map((playlist) => ({
        id: String(playlist.id),
        name: String(playlist.name),
        ...(typeof playlist.cover === 'string' ? { cover: playlist.cover } : {}),
        songIds: (tracksByPlaylist.get(playlist.id) ?? [])
          .map((entry) => String(entry.trackId))
      })) as DataRecord[]
    }
    const write = async (record: DataRecord): Promise<void> => {
      const id = String(record.id ?? '')
      const links = await this.datasetRows(PLAYLIST_TRACKS_DATASET, { playlistId: id })
      const songIds = Array.isArray(record.songIds) ? record.songIds.filter((value): value is string => typeof value === 'string') : []
      const current = new Map(links.map((entry) => [Number(entry.position), String(entry.trackId)]))
      const changed = songIds.map((trackId, position) => ({ playlistId: id, trackId, position })).filter((entry) => current.get(entry.position) !== entry.trackId)
      const operations: DatasetTransactionOperation[] = [
        { dataset: PLAYLISTS_DATASET, operation: 'upsert', values: { id, name: String(record.name ?? ''), cover: typeof record.cover === 'string' ? record.cover : null } }
      ]
      const keys = links.filter((entry) => Number(entry.position) >= songIds.length).map((entry) => ({ playlistId: id, position: Number(entry.position) }))
      if (keys.length) operations.push({ dataset: PLAYLIST_TRACKS_DATASET, operation: 'delete-many', keys })
      if (changed.length) operations.push({ dataset: PLAYLIST_TRACKS_DATASET, operation: 'upsert', values: changed })
      await this.api.data.transaction(operations)
    }
    return {
      read,
      append: async (record) => { try { await write(record); return true } catch { return false } },
      update: async (id, record) => { try { if (!(await playlists.get({ id }))) return false; await write(record); return true } catch { return false } },
      delete: async (id) => (await playlists.delete({ id })).affected > 0,
      replace: async (records) => {
        try {
          const existing = await read()
          const operations: DatasetTransactionOperation[] = []
          if (existing.length) operations.push({ dataset: PLAYLISTS_DATASET, operation: 'delete-many', keys: existing.map(record => ({ id: String(record.id ?? '') })) })
          if (records.length) operations.push({ dataset: PLAYLISTS_DATASET, operation: 'upsert', values: records.map(record => ({ id: String(record.id ?? ''), name: String(record.name ?? ''), cover: typeof record.cover === 'string' ? record.cover : null })) })
          const nextLinks = records.flatMap(record => (Array.isArray(record.songIds) ? record.songIds : []).filter((value): value is string => typeof value === 'string').map((trackId, position) => ({ playlistId: String(record.id ?? ''), trackId, position })))
          if (nextLinks.length) operations.push({ dataset: PLAYLIST_TRACKS_DATASET, operation: 'upsert', values: nextLinks })
          if (operations.length) await this.api.data.transaction(operations)
          return true
        } catch { return false }
      },
      subscribe: (listener) => {
        const offPlaylists = playlists.subscribe(listener)
        const offMembers = members.subscribe(listener)
        return () => { offPlaylists(); offMembers() }
      }
    }
  }

  private trackStore(): DatasetStore {
    return this.datasetStore(TRACKS_DATASET)
  }

  private playHistoryStore(): DatasetStore {
    const store = this.datasetStore(PLAY_EVENTS_DATASET)
    return {
      ...store,
      read: async () => (await store.read()).map(({ id: _id, ...record }) => record),
      append: async (record) => store.append({ ...record, id: `play:${Date.now()}:${Math.random().toString(36).slice(2)}` })
    }
  }

  getIndexEntries = () => this.index.getSnapshot().entries

  subscribeIndex = (listener: () => void): (() => void) => this.index.subscribe(listener)

  private waitForIndex(): Promise<void> {
    if (this.disposed) return Promise.reject(new MetadataCancelled())
    const snapshot = this.index.getSnapshot()
    if (snapshot.status === 'error') return Promise.reject(new Error(snapshot.error ?? 'Music index is unavailable'))
    if (snapshot.status === 'ready') return Promise.resolve()
    if (!this.indexReady) {
      let resolve!: () => void
      let reject!: (error: Error) => void
      const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
      this.indexReady = { promise, resolve, reject }
    }
    return this.indexReady.promise
  }

  musicPath(): string {
    const raw = this.api.settings.get().musicPath
    const persisted = normalizeMusicPath(raw)
    if (this.musicPathOverride !== null) {
      if (persisted === this.musicPathOverride) this.musicPathOverride = null
      else return this.musicPathOverride
    }
    return persisted
  }

  podcastPath(): string {
    return normalizeMusicPath(this.api.settings.get().podcastPath)
  }

  libraryMode(): LibraryMode {
    const persisted: LibraryMode = this.api.settings.get().libraryMode === 'podcast' ? 'podcast' : 'music'
    if (this.libraryModeOverride !== null) {
      if (persisted === this.libraryModeOverride) this.libraryModeOverride = null
      else return this.libraryModeOverride
    }
    return persisted
  }

  setLibraryMode(mode: LibraryMode): void {
    if (mode === this.libraryMode()) return
    this.libraryModeOverride = mode
    this.observedLibraryMode = mode
    this.emitView()
    this.emitViewState()
    void this.api.settings.set('libraryMode', mode).then(result => {
      if (result.ok) return
      this.libraryModeOverride = null
      this.observedLibraryMode = this.libraryMode()
      this.emitView()
    }).catch(() => {})
  }

  trackUrl(track: Track): string {
    return assetUrlForRelPath(track.file)
  }

  // ---- Library loading ------------------------------------------------------

  /** Loads run one at a time; a request that arrives mid-load reruns it once afterwards. */
  load(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    this.reloadDirty = true
    this.reloadWork ??= (async () => {
      try {
        while (this.reloadDirty && !this.disposed) {
          this.reloadDirty = false
          await this.loadOnce()
        }
      } finally { this.reloadWork = null }
    })()
    return this.reloadWork
  }

  private async loadOnce(): Promise<void> {
    this.loading = true
    this.libraryError = null
    this.emit()
    try {
      await this.loadLibrary()
    } catch (error) {
      this.libraryError = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      this.loading = false
      if (!this.disposed) this.emit()
    }
  }

  private async loadLibrary(): Promise<void> {
    const [songs, lists, history, artists] = await Promise.all([
      this.trackStore().read() as Promise<unknown> as Promise<Track[]>,
      this.playlistStore().read() as Promise<unknown> as Promise<Playlist[]>,
      this.playHistoryStore().read() as Promise<unknown> as Promise<HistoryEntry[]>,
      this.artistStore().read() as Promise<unknown> as Promise<Artist[]>,
      this.playbackReady
    ])
    if (this.disposed) return
    this.tracks = songs.filter((t) => t && typeof t.id === 'string' && t.id)
    this.trackById = new Map(this.tracks.map((t) => [t.id, t]))
    this.queue = this.queue.map(track => this.trackById.get(track.id) ?? track)
    if (this.currentTrack) this.currentTrack = this.trackById.get(this.currentTrack.id) ?? this.currentTrack
    this.metadata.retain(new Set(this.tracks.map((track) => track.file)))
    this.playlists = lists
      .filter((pl) => pl && typeof pl.id === 'string' && pl.id)
      .map((pl) => ({ ...pl, songIds: Array.isArray(pl.songIds) ? pl.songIds : [] }))
    this.artists = artists.filter((a) => a && typeof a.id === 'string' && a.id && typeof a.name === 'string')
    if (this.focusedPlaylistId && !this.playlists.some((pl) => pl.id === this.focusedPlaylistId)) {
      this.focusedPlaylistId = null
    }
    // A reload after a mutation may have removed the page's target — keep it valid.
    this.pageView = this.validatePageView(this.pageView)
    this.historyEntries = history.filter((h) => h && typeof h.songId === 'string')
    this.recentlyPlayedIds ??= dedupeHistory(this.historyEntries, this.trackById).map(track => track.id)

    // Register an entity for every artist name now in the library (idempotent).
    await this.syncArtists()
    if (this.disposed) return

    // First load: reopen the page where the user left off (no tab is forced).
    if (!this.navLoaded) {
      this.navLoaded = true
      const savedNav = this.api.settings.get().navigationState
      const navRecs = savedNav && typeof savedNav === 'object' ? [savedNav] : []
      const restored = this.validatePageView(parsePageView(navRecs[0]))
      const navRecord = navRecs[0] && typeof navRecs[0] === 'object' ? navRecs[0] as Record<string, unknown> : null
      this.pageSearch = typeof navRecord?.searchQuery === 'string' ? navRecord.searchQuery.slice(0, 500) : ''
      this.podcastView = narrowPodcastView(navRecord?.podcast)
      this.podcastHistory = [this.podcastView]
      if (restored.mode !== 'home') {
        this.pageView = restored
        this.pageHistory = [restored]
        this.pageHistoryIndex = 0
        if (restored.mode === 'playlist') this.focusedPlaylistId = restored.id
        this.emit()
      }
    }

    this.loading = false
    if (this.pendingLinkState) {
      const state = this.pendingLinkState
      this.pendingLinkState = null
      this.applyReadyLinkState(state)
    }

    if (this.pendingWorkspaceMainState) {
      const state = this.pendingWorkspaceMainState
      this.pendingWorkspaceMainState = null
      this.restoreMainWorkspaceView(state)
    }

    this.emit()
  }

  /** Drop a page target that no longer exists, falling back to the home view. */
  validatePageView(pv: PageView): PageView {
    if (pv.mode === 'playlist') {
      const playlist = this.playlists.find((pl) => pl.id === pv.id)
      if (!playlist) return { mode: 'home' }
      return pv.reveal && playlist.songIds.includes(pv.reveal) ? pv : { mode: 'playlist', id: pv.id }
    }
    if (pv.mode === 'song') return this.trackById.has(pv.id) ? pv : { mode: 'home' }
    if (pv.mode === 'artist') {
      const summary = this.artistSummary(pv.id)
      if (!summary) return { mode: 'home' }
      return pv.reveal && summary.tracks.some((track) => track.id === pv.reveal) ? pv : { mode: 'artist', id: pv.id }
    }
    return pv
  }

  /**
   * Ensure the artist datasets have an entity for every library artist name.
   * Pure compute (`upsertArtists`) then append only the new entities — existing
   * entities keep their image/bio/aliases. Idempotent: a no-op once registered.
   */
  private async syncArtists(): Promise<void> {
    if (this.disposed) return
    const { next, added } = upsertArtists(this.artists, this.splitLibrary().music)
    if (added.length === 0) return
    this.artists = next
    for (const artist of added) {
      await this.artistStore().append(artist as unknown as DataRecord)
    }
    this.emit()
  }

  private syncWhenIndexed(): void {
    if (this.disposed || this.libraryError || this.synced || this.index.getSnapshot().status !== 'ready') return
    void this.syncLibrary().catch(error => {
      if (this.disposed) return
      // A library that loaded stays on screen; Rescan reports its own failure.
      if (this.tracks.length) { console.warn('[music] library scan failed', error); return }
      this.libraryError = error instanceof Error ? error.message : String(error)
      this.emit()
    })
  }

  /**
   * Scan the music folder: add track rows for new media files, heal
   * tracks whose file moved (matched by file name anywhere in the realm), and
   * flag tracks whose file is gone.
   */
  syncLibrary(): Promise<void> {
    if (this.disposed || this.metadataRevoked) return Promise.resolve()
    this.syncDirty = true
    if (!this.syncWork) {
      this.syncWork = (async () => {
        while (this.syncDirty && !this.disposed && !this.metadataRevoked) {
          this.syncDirty = false
          try { await this.scanLibrary(this.metadata.generation()) } catch (error) {
            if (!(error instanceof MetadataCancelled)) throw error
            if (!this.disposed && !this.metadataRevoked) this.syncDirty = true
          }
        }
      })().finally(() => { this.syncWork = null })
    }
    return this.syncWork
  }

  private async scanLibrary(generation: number): Promise<void> {
    if (!this.musicPath() && !this.podcastPath()) return
    await this.waitForIndex()
    this.metadata.assertCurrent(generation)
    this.synced = true
    const library = this.library()
    const observed = await library.list('tracks', undefined, 1)
    const result = await library.rescan(observed.revision, undefined, this.getIndexEntries(), () => this.metadata.assertCurrent(generation))
    this.metadata.assertCurrent(generation)
    this.missing = new Set(result.missing)
    if (result.added || result.updated) await this.load()
    else this.emit()
  }

  /** Reload from disk and re-scan the folder (the page's Refresh button). */
  async refresh(): Promise<void> {
    await this.load()
    await this.syncLibrary()
    this.recentlyPlayedIds = dedupeHistory(this.historyEntries, this.trackById).map(track => track.id)
    this.emit()
  }

  async setMusicPath(path: string): Promise<boolean> {
    const normalized = normalizeMusicPath(path)
    if (path.trim() && !normalized) return false
    this.musicPathOverride = normalized
    this.observedMusicPath = normalized
    const result = await this.api.settings.set('musicPath', normalized)
    if (!result.ok) {
      this.musicPathOverride = null
      this.observedMusicPath = this.musicPath()
      this.emit()
      return false
    }
    await this.refresh()
    return true
  }

  /** A folder chosen outside this store (Settings, automation, another window) rescans the library. */
  private onSettingsChanged(): void {
    if (this.disposed) return
    const mode = this.libraryMode()
    if (mode !== this.observedLibraryMode) {
      this.observedLibraryMode = mode
      this.emitView()
    }
    const path = this.musicPath(), podcastPath = this.podcastPath()
    if (path === this.observedMusicPath && podcastPath === this.observedPodcastPath) return
    this.observedMusicPath = path
    this.observedPodcastPath = podcastPath
    this.emit()
    void this.refresh().catch(() => {})
  }

  async setPodcastPath(path: string): Promise<boolean> {
    const normalized = normalizeMusicPath(path)
    if (path.trim() && !normalized) return false
    const result = await this.api.settings.set('podcastPath', normalized)
    if (!result.ok) return false
    this.observedPodcastPath = this.podcastPath()
    this.emit()
    await this.refresh()
    return true
  }

  // ---- Covers ---------------------------------------------------------------

  /** Blob URL for a track's embedded cover art, or null until loaded / none. */
  getCoverUrl(trackId: string): string | null {
    const track = this.trackById.get(trackId)
    const cover = resolveCoverPath(this.getIndexEntries(), track?.details?.cover)
    if (cover) return assetUrlForRelPath(cover)
    const file = this.coverFile(trackId)
    return file ? this.metadata.cover(file) : null
  }

  coverFile(trackId: string): string | null {
    return this.trackById.get(trackId)?.file ?? null
  }

  subscribeCover(trackId: string, listener: () => void, priority = false): () => void {
    const file = this.coverFile(trackId)
    return file ? this.metadata.acquire(file, listener, priority) : () => {}
  }

  private updatePlaybackCover(): void {
    const file = this.currentTrack ? this.coverFile(this.currentTrack.id) : null
    if (file !== this.playbackCoverFile) {
      this.offPlaybackCover?.()
      this.playbackCoverFile = file
      this.offPlaybackCover = file ? this.metadata.acquire(file, () => {
        this.coverVersion++
        this.emitPlayback()
      }, true) : null
    }
  }

  private applyPlayback(state: MusicPlaybackSnapshot): void {
    if (this.disposed || !state || state.revision < this.playbackRevision) return
    const previousTrack = this.currentTrack, wasPlaying = this.isPlaying
    const previousPosition = this.currentTime, previousDuration = this.duration
    this.playbackOutcome = state.errorOutcome
    const queue = state.queue.map(track => this.trackById.get(track.id) ?? track)
    const current = state.current ? this.trackById.get(state.current.id) ?? state.current : null
    const queueChanged = this.queueIndex !== state.index || JSON.stringify(this.queue) !== JSON.stringify(queue)
    const currentChanged = JSON.stringify(this.currentTrack) !== JSON.stringify(current)
    this.playbackRevision = state.revision
    this.sessionId = state.sessionId
    if (queueChanged) this.queue = queue
    this.queueIndex = state.index
    if (currentChanged) this.currentTrack = current
    this.currentPlaylistId = state.playlistId
    this.isPlaying = state.playing
    this.buffering = state.buffering
    this.currentTime = state.position
    this.duration = state.duration
    this.volume = state.volume
    this.shuffle = state.shuffle
    this.repeatMode = state.repeat
    this.playError = state.error
    this.playbackRate = state.rate
    this.playbackSampledAt = performance.now()
    this.playbackSampleAge = state.sampleAgeMs ?? 0
    this.trackEpisodeProgress(previousTrack, wasPlaying, previousPosition, previousDuration, state)
    this.syncRate(state)
    if (state.playEvent && state.playEvent.id !== this.lastPlayEventId) {
      this.lastPlayEventId = state.playEvent.id
      const { id: _id, ...entry } = state.playEvent
      if (!this.historyEntries.some(existing => existing.songId === entry.songId && existing.playedAt === entry.playedAt)) this.historyEntries = [...this.historyEntries, entry]
      this.emit()
    } else if (queueChanged || currentChanged) this.emitQueue()
    else this.emitPlayback()
  }

  private trackEpisodeProgress(previous: Track | null, wasPlaying: boolean, previousPosition: number, previousDuration: number, state: MusicPlaybackSnapshot): void {
    const podcastPath = this.observedPodcastPath
    const current = this.currentTrack
    if (previous && previous.id !== current?.id && isEpisode(previous, podcastPath)) {
      this.recordProgress(previous.id, previousPosition, previousDuration || previous.duration || 0)
    }
    if (!current || !isEpisode(current, podcastPath)) return
    if (current.id !== previous?.id && current.id !== this.resumedEpisodeId && state.position < 3) {
      this.resumedEpisodeId = current.id
      const resume = resumePosition(this.episodeProgress[current.id])
      if (resume > 0) this.seek(resume)
      return
    }
    if ((wasPlaying && !state.playing) || (state.playing && Date.now() - this.progressSavedAt > 30000)) {
      this.recordProgress(current.id, state.position, state.duration || current.duration || 0)
    }
  }

  /** Episodes play at the chosen podcast speed and songs at 1×, applied once per track change. */
  private syncRate(state: MusicPlaybackSnapshot): void {
    const current = this.currentTrack
    if (!current || !state.sessionId || this.rateSyncedFor === current.id) return
    this.rateSyncedFor = current.id
    const desired = isEpisode(current, this.observedPodcastPath) ? this.podcastRate : 1
    if (Math.abs(state.rate - desired) > 0.001) void this.playback({ type: 'rate', value: desired })
  }

  setPodcastRate(rate: number): void {
    const next = readPodcastRate(rate)
    this.podcastRate = next
    void this.api.settings.set(RATE_SETTINGS_KEY, next)
    if (this.currentTrack && isEpisode(this.currentTrack, this.observedPodcastPath)) void this.playback({ type: 'rate', value: next })
    this.emitPlayback()
  }

  private writeMoments(id: string, moments: EpisodeMoment[]): void {
    const next = { ...this.episodeMoments }
    if (moments.length) next[id] = [...moments].sort((a, b) => a.at - b.at).slice(0, MOMENT_LIMIT)
    else delete next[id]
    this.episodeMoments = next
    void this.api.settings.set(MOMENTS_SETTINGS_KEY, next)
    this.emitPlayback()
  }

  /** Replace an episode's key moments (the episode editor's save). */
  setMoments(id: string, moments: EpisodeMoment[]): void {
    const unique = new Map<number, EpisodeMoment>()
    for (const moment of moments) if (Number.isFinite(moment.at) && moment.at >= 0) unique.set(Math.round(moment.at * 10) / 10, { at: Math.round(moment.at * 10) / 10, label: moment.label.slice(0, MOMENT_LABEL_LIMIT) })
    this.writeMoments(id, [...unique.values()])
  }

  /** Mark a key moment; a second mark within two seconds of an existing one is ignored. */
  addMoment(id: string, at: number, label = ''): void {
    if (!Number.isFinite(at) || at < 0) return
    const moments = this.episodeMoments[id] ?? []
    if (moments.length >= MOMENT_LIMIT || moments.some(moment => Math.abs(moment.at - at) < 2)) return
    this.writeMoments(id, [...moments, { at: Math.round(at * 10) / 10, label: label.slice(0, MOMENT_LABEL_LIMIT) }])
  }

  renameMoment(id: string, at: number, label: string): void {
    const moments = this.episodeMoments[id] ?? []
    if (!moments.some(moment => moment.at === at)) return
    this.writeMoments(id, moments.map(moment => moment.at === at ? { ...moment, label: label.trim().slice(0, MOMENT_LABEL_LIMIT) } : moment))
  }

  removeMoment(id: string, at: number): void {
    this.writeMoments(id, (this.episodeMoments[id] ?? []).filter(moment => moment.at !== at))
  }

  private recordProgress(id: string, position: number, duration: number): void {
    if (!Number.isFinite(position) || position < 0) return
    this.progressSavedAt = Date.now()
    const entries = Object.entries({ ...this.episodeProgress, [id]: { position, duration, updatedAt: new Date().toISOString() } })
      .sort((a, b) => b[1].updatedAt.localeCompare(a[1].updatedAt))
      .slice(0, PROGRESS_LIMIT)
    this.episodeProgress = Object.fromEntries(entries)
    if (this.progressTimer !== null) window.clearTimeout(this.progressTimer)
    this.progressTimer = window.setTimeout(() => this.flushProgress(), 1500)
  }

  private flushProgress(): void {
    if (this.progressTimer !== null) window.clearTimeout(this.progressTimer)
    this.progressTimer = null
    this.progressWrite = this.api.settings.set(PROGRESS_SETTINGS_KEY, this.episodeProgress).then(result => result.ok, () => false)
  }

  /** Play episodes from a list, resuming the chosen one where it was left. */
  playEpisodes(episodes: Track[], index: number): void {
    const episode = episodes[index]
    if (!episode) return
    const position = resumePosition(this.episodeProgress[episode.id])
    this.resumedEpisodeId = episode.id
    this.startTrack(episodes, index, null, position)
  }

  private playback(action: MusicPlaybackAction): Promise<boolean> {
    const pending = Promise.resolve().then(() => this.api.backend.call<MusicPlaybackSnapshot>('playback.action', action)).then(snapshot => {
      this.applyPlayback(snapshot)
      return true
    }).catch(error => {
      this.playbackFailure = true
      this.playbackOutcome = 'unknown'
      this.playError = error instanceof Error ? error.message : 'Music playback failed'
      this.emitPlayback()
      return false
    })
    this.pendingPlayback.add(pending)
    void pending.then(() => this.pendingPlayback.delete(pending))
    return pending
  }

  private startTrack(queue: Track[], index: number, playlistId: string | null, position = 0): void {
    if (!queue[index]) return
    if (playlistId) this.focusedPlaylistId = playlistId
    this.playback({ type: 'start', ids: queue.map(track => track.id), index, playlistId, position })
  }

  playQueue(queue: Track[], index: number, playlistId: string | null = null): void {
    this.startTrack(queue, index, playlistId)
  }

  setFocusedPlaylist(id: string | null): void {
    if (id && !this.playlists.some((pl) => pl.id === id)) return
    this.focusedPlaylistId = id
  }

  // ---- Page navigation ------------------------------------------------------
  // The content page renders `pageView`; the left panel drives it. Each setter
  // bumps the nonce (so repeat clicks still notify + re-run the song reveal),
  // emits, and surfaces the singleton Music tab.

  private navigate(view: PageView, openTab: boolean): void {
    const current = this.pageHistory[this.pageHistoryIndex]
    if (JSON.stringify(current) !== JSON.stringify(view)) {
      const base = this.pageHistory.slice(0, this.pageHistoryIndex + 1)
      this.pageHistory = [...base, view].slice(-20)
      this.pageHistoryIndex = this.pageHistory.length - 1
    }
    this.pageView = view
    this.pageViewNonce += 1
    if (openTab) this.api.workspace.openMainTab()
    this.emitView()
    this.emitViewState()
    this.persistNav()
  }

  /** Show a view picked outside the page; a leftover page search would otherwise cover it. */
  private openView(view: PageView): void {
    this.pageSearch = ''
    this.navigate(view, true)
  }

  private navPersistTimer: number | null = null
  private navWrite: Promise<boolean> = Promise.resolve(true)
  private navDirty = false
  private navRevision = 0

  /** Persist the current page view so a reload reopens it (best-effort).
   *  Debounced — rapid navigation (artist → song → playlist) collapses into one
   *  settings write instead of a write per click. */
  private persistNav(): void {
    if (this.disposed) return
    this.navDirty = true
    this.navRevision += 1
    if (this.navPersistTimer != null) window.clearTimeout(this.navPersistTimer)
    this.navPersistTimer = window.setTimeout(() => {
      this.navPersistTimer = null
      this.flushNav()
    }, 300)
  }

  private flushNav(): void {
    if (this.navPersistTimer !== null) window.clearTimeout(this.navPersistTimer)
    this.navPersistTimer = null
    const state = { ...this.pageView, searchQuery: this.pageSearch, podcast: this.podcastView }
    const revision = this.navRevision
    this.navWrite = this.api.settings.set('navigationState', state).then((result) => {
      if (result.ok && this.navRevision === revision) this.navDirty = false
      return result.ok
    })
    void this.navWrite.catch(() => {})
  }

  setPageSearch(query: string): void {
    this.pageSearch = query.slice(0, 500)
    this.emitView()
    this.emitViewState()
    this.persistNav()
  }

  captureMainWorkspaceView = (): ReturnType<WorkspaceViewStateProvider['capture']> => ({
    view: { ...this.pageView },
    search: this.pageSearch,
    history: this.pageHistory.map((view) => ({ ...view })),
    historyIndex: this.pageHistoryIndex
  })

  restoreMainWorkspaceView = (raw: unknown): void => {
    if (!raw || typeof raw !== 'object') return
    const state = raw as Record<string, unknown>
    const view = narrowPageView(state.view)
    if (!view || typeof state.search !== 'string') return
    if (this.loading || !this.navLoaded) {
      this.pendingWorkspaceMainState = raw
      return
    }
    const history = Array.isArray(state.history)
      ? state.history.map(narrowPageView).filter((entry): entry is PageView => entry !== null).slice(-20)
      : []
    const validatedHistory = (history.length > 0 ? history : [view]).map((entry) => this.validatePageView(entry))
    const requestedIndex = typeof state.historyIndex === 'number' && Number.isFinite(state.historyIndex)
      ? Math.trunc(state.historyIndex)
      : validatedHistory.length - 1
    this.pageHistory = validatedHistory
    this.pageHistoryIndex = Math.min(Math.max(requestedIndex, 0), validatedHistory.length - 1)
    this.pageView = this.validatePageView(view)
    if (JSON.stringify(this.pageHistory[this.pageHistoryIndex]) !== JSON.stringify(this.pageView)) {
      this.pageHistory[this.pageHistoryIndex] = this.pageView
    }
    this.pageSearch = state.search.slice(0, 500)
    this.focusedPlaylistId = this.pageView.mode === 'playlist' ? this.pageView.id : this.focusedPlaylistId
    this.pageViewNonce += 1
    this.emitView()
    this.emitViewState()
    this.persistNav()
  }

  captureLeftWorkspaceView = (): ReturnType<WorkspaceViewStateProvider['capture']> => ({
    search: this.leftPanelSearch,
    sections: { ...this.leftPanelSections }
  })

  restoreLeftWorkspaceView = (raw: unknown): void => {
    if (!raw || typeof raw !== 'object') return
    const state = raw as Record<string, unknown>
    const sections = state.sections && typeof state.sections === 'object'
      ? state.sections as Record<string, unknown>
      : {}
    this.leftPanelSearch = typeof state.search === 'string' ? state.search.slice(0, 500) : ''
    this.leftPanelSections = {
      songs: typeof sections.songs === 'boolean' ? sections.songs : DEFAULT_LEFT_SECTIONS.songs,
      favorites: typeof sections.favorites === 'boolean' ? sections.favorites : DEFAULT_LEFT_SECTIONS.favorites,
      playlists: typeof sections.playlists === 'boolean' ? sections.playlists : DEFAULT_LEFT_SECTIONS.playlists,
      artists: typeof sections.artists === 'boolean' ? sections.artists : DEFAULT_LEFT_SECTIONS.artists
    }
    this.emitView()
    this.emitViewState()
  }

  setLeftPanelSearch(query: string): void {
    const next = query.slice(0, 500)
    if (next === this.leftPanelSearch) return
    this.leftPanelSearch = next
    this.emitView()
    this.emitViewState()
  }

  setLeftPanelSection(section: MusicPanelSection, open: boolean): void {
    if (this.leftPanelSections[section] === open) return
    this.leftPanelSections = { ...this.leftPanelSections, [section]: open }
    this.emitView()
    this.emitViewState()
  }

  captureRightWorkspaceView = (): ReturnType<WorkspaceViewStateProvider['capture']> => ({
    queueOpen: this.rightQueueOpen,
    historyOpen: this.rightHistoryOpen,
    scrollTop: this.rightPanelScrollTop
  })

  restoreRightWorkspaceView = (raw: unknown): void => {
    if (!raw || typeof raw !== 'object') return
    const state = raw as Record<string, unknown>
    this.rightQueueOpen = typeof state.queueOpen === 'boolean' ? state.queueOpen : true
    this.rightHistoryOpen = typeof state.historyOpen === 'boolean' ? state.historyOpen : false
    this.rightPanelScrollTop = typeof state.scrollTop === 'number' && Number.isFinite(state.scrollTop)
      ? Math.max(0, state.scrollTop)
      : 0
    this.rightViewNonce += 1
    this.emitView()
    this.emitViewState()
  }

  setRightQueueOpen(open: boolean): void {
    if (open === this.rightQueueOpen) return
    this.rightQueueOpen = open
    this.emitView()
    this.emitViewState()
  }

  setRightHistoryOpen(open: boolean): void {
    if (open === this.rightHistoryOpen) return
    this.rightHistoryOpen = open
    this.emitView()
    this.emitViewState()
  }

  setRightPanelScrollTop(scrollTop: number): void {
    const next = Number.isFinite(scrollTop) ? Math.max(0, scrollTop) : 0
    if (Math.abs(next - this.rightPanelScrollTop) < 1) return
    this.rightPanelScrollTop = next
    this.emitViewState()
  }

  buildLinkState(): MusicLinkState {
    return { v: 1, view: { ...this.pageView }, searchQuery: this.pageSearch }
  }

  applyLinkState(state: Record<string, unknown>): boolean {
    if (state.v !== 1 || !narrowPageView(state.view) || typeof state.searchQuery !== 'string' || state.searchQuery.length > 500) return false
    if (this.loading || !this.navLoaded) {
      this.pendingLinkState = state
      return true
    }
    return this.applyReadyLinkState(state)
  }

  private applyReadyLinkState(state: Record<string, unknown>): boolean {
    const view = narrowPageView(state.view)
    if (!view || typeof state.searchQuery !== 'string' || state.searchQuery.length > 500) return false
    this.pageSearch = state.searchQuery
    this.navigate(this.validatePageView(view), false)
    this.flushNav()
    return true
  }

  /** Open the Music tab and show a playlist's detail (does not start playback). */
  showPlaylist(id: string): void {
    if (!this.playlists.some((pl) => pl.id === id)) return
    this.focusedPlaylistId = id
    this.openView({ mode: 'playlist', id })
  }

  /**
   * Open the Music tab and reveal a song in the most relevant context: the first
   * playlist that contains it, else its first resolvable artist's page, else the
   * all-songs library list. The destination view carries the song id so the page
   * scrolls to and flashes that row.
   */
  revealSong(id: string): void {
    const view = this.resolveSongView(id)
    if (!view) return
    if (view.mode === 'playlist') this.focusedPlaylistId = view.id
    this.openView(view)
  }

  /** The view `revealSong` shows for a song, without navigating; null when the song is gone. */
  resolveSongView(id: string): PageView | null {
    const track = this.trackById.get(id)
    if (!track) return null
    const playlist = this.playlists.find((pl) => pl.songIds.includes(id))
    if (playlist) return { mode: 'playlist', id: playlist.id, reveal: id }
    for (const name of trackArtists(track)) {
      const artist = resolveArtist(this.artists, name)
      if (artist) return { mode: 'artist', id: artist.id, reveal: id }
    }
    return { mode: 'song', id }
  }

  /** The music view a pinned target opens on, without navigating; null when the target is gone. */
  resolvePageView(target: PageTarget): PageView | null {
    if (target.kind === 'home') return { mode: 'home' }
    if (target.kind === 'playlist') return this.playlists.some((pl) => pl.id === target.id) ? { mode: 'playlist', id: target.id } : null
    if (target.kind === 'song') return this.resolveSongView(target.id)
    if (target.kind === 'artist') {
      const artist = this.ensureArtist(target.id)
      return artist ? { mode: 'artist', id: artist.id } : null
    }
    return null
  }

  /**
   * Open the Music tab on an artist's page. Accepts an artist id or a name — a
   * name resolves to its entity (or, for a name that some song credits but no
   * entity covers yet, registers one on the fly so the link always has a target).
   */
  showArtist(nameOrId: string): void {
    const artist = this.ensureArtist(nameOrId)
    if (artist) this.openView({ mode: 'artist', id: artist.id })
  }

  /** The artist entity for an id or name, registering a credited name no entity covers yet. */
  ensureArtist(nameOrId: string): Artist | null {
    const key = nameOrId.trim()
    if (!key) return null
    let artist = resolveArtist(this.artists, key)
    if (!artist) {
      const norm = normalizeArtistName(key)
      const credited = libraryCredits(this.tracks).keys.some((keys) => keys.includes(norm))
      if (!credited) return null
      artist = { id: newArtistId(), name: key }
      this.artists = [...this.artists, artist]
      this.emit()
      void this.artistStore().append(artist as unknown as DataRecord)
    }
    return artist
  }

  private navigatePodcast(view: PodcastView, openTab: boolean): void {
    if (JSON.stringify(this.podcastHistory[this.podcastHistoryIndex]) !== JSON.stringify(view)) {
      this.podcastHistory = [...this.podcastHistory.slice(0, this.podcastHistoryIndex + 1), view].slice(-20)
      this.podcastHistoryIndex = this.podcastHistory.length - 1
    }
    this.podcastView = view
    if (openTab) this.api.workspace.openMainTab()
    this.emitView()
    this.persistNav()
  }

  showPodcastHome(): void {
    this.navigatePodcast({ mode: 'home' }, false)
  }

  /** Open a show (its folder path) in the main page. */
  showPodcastShow(id: string): void {
    if (!this.snapshot.shows.some(show => show.id === id)) return
    this.pageSearch = ''
    this.navigatePodcast({ mode: 'show', id }, true)
  }

  goPodcastHistory(delta: -1 | 1): void {
    const nextIndex = this.podcastHistoryIndex + delta
    if (nextIndex < 0 || nextIndex >= this.podcastHistory.length) return
    this.podcastHistoryIndex = nextIndex
    this.podcastView = this.podcastHistory[nextIndex]
    this.emitView()
    this.persistNav()
  }

  /** Return the page to its home view (used by the page's own Home/Back). */
  showHome(): void {
    this.navigate({ mode: 'home' }, false)
  }

  goPageBack(): void {
    this.goPageHistory(-1)
  }

  goPageForward(): void {
    this.goPageHistory(1)
  }

  private goPageHistory(delta: -1 | 1): void {
    const nextIndex = this.pageHistoryIndex + delta
    if (nextIndex < 0 || nextIndex >= this.pageHistory.length) return
    this.pageHistoryIndex = nextIndex
    this.pageView = this.pageHistory[nextIndex]
    this.pageViewNonce += 1
    this.emitView()
    this.emitViewState()
    this.persistNav()
  }

  /** The data an artist page renders: the entity, its songs and total play count. */
  artistSummary(artistId: string): { artist: Artist; tracks: Track[]; plays: number } | null {
    const artist = this.artists.find((a) => a.id === artistId)
    if (!artist) return null
    const tracks = tracksForArtist(this.splitLibrary().music, artist)
    const ids = new Set(tracks.map((t) => t.id))
    const plays = this.historyEntries.reduce((n, h) => (ids.has(h.songId) ? n + 1 : n), 0)
    return { artist, tracks, plays }
  }

  getFocusedPlaylist(): { playlist: Playlist; tracks: Track[] } | null {
    const id = this.focusedPlaylistId ?? this.currentPlaylistId
    if (!id) return null
    const playlist = this.playlists.find((pl) => pl.id === id)
    if (!playlist) return null
    return { playlist, tracks: resolvePlaylistTracks(playlist.songIds, this.trackById) }
  }

  playShuffledQueue(queue: Track[], playlistId: string | null = null, index = 0): void {
    if (!queue.length) return
    this.playback({ type: 'start', ids: queue.map(track => track.id), index: Math.min(Math.max(index, 0), queue.length - 1), playlistId, shuffle: true })
  }

  playTrack(track: Track, opts: { queue?: Track[]; index?: number; playlistId?: string | null } = {}): void {
    const queue = opts.queue ?? [track]
    const index = opts.index ?? queue.findIndex(item => item.id === track.id)
    this.startTrack(queue, index < 0 ? 0 : index, opts.playlistId ?? null)
  }

  togglePlay(): void { this.playback({ type: 'toggle' }) }
  pause(): void { this.playback({ type: 'pause' }) }
  stop(): void { this.playback({ type: 'stop' }) }
  next(): void { this.playback({ type: 'next' }) }
  prev(): void { this.playback({ type: 'previous' }) }
  seek(value: number): Promise<boolean> { return this.playback({ type: 'seek', value }) }
  setVolume(value: number): void { this.playback({ type: 'volume', value: Math.min(1, Math.max(0, value)) }) }
  resumeLast(): void { this.playback({ type: 'resume' }) }

  playDefault(): void {
    if (this.currentTrack || this.queue.length) { this.resumeLast(); return }
    const available = this.playlists.filter(playlist => resolvePlaylistTracks(playlist.songIds, this.trackById).length > 0)
    if (available.length) {
      const playlist = available[Math.floor(Math.random() * available.length)]
      this.playQueue(resolvePlaylistTracks(playlist.songIds, this.trackById), 0, playlist.id)
    } else this.resumeLast()
  }

  toggleShuffle(): void { this.playback({ type: 'shuffle' }) }
  cycleRepeat(): void { this.playback({ type: 'repeat' }) }
  playFromQueue(index: number): void { this.playback({ type: 'playQueued', index }) }
  addToQueue(track: Track, where: 'next' | 'end' = 'end'): void { this.addTracksToQueue([track], where) }
  addTracksToQueue(tracks: Track[], where: 'next' | 'end' = 'end'): void {
    if (tracks.length) this.playback({ type: 'add', ids: tracks.map(track => track.id), where })
  }
  removeFromQueue(index: number): void { this.playback({ type: 'remove', index }) }
  reorderQueue(from: number, to: number): void { this.playback({ type: 'reorder', from, to }) }
  clearQueue(): void { this.playback({ type: 'clear' }) }

  async flushPersistence(): Promise<boolean> {
    const pending = [...this.pendingPlayback]
    const completed = (await Promise.all(pending)).every(Boolean)
    const failed = this.playbackFailure
    this.playbackFailure = false
    if (!completed || failed) return false
    try {
      const state = await this.api.backend.call<MusicPlaybackSnapshot>('playback.action', { type: 'flush' })
      this.applyPlayback(state)
      return true
    } catch { this.playbackOutcome = 'unknown'; return false }
  }

  playbackFailureError(): Error {
    const message = this.playError ?? 'Could not persist Music history or queue state.'
    return this.playbackOutcome === 'unknown'
      ? Object.assign(new Error(message.includes('unknown') ? message : `${message} Playback outcome is unknown. Check the player before trying again.`), { outcome: 'unknown', outcomeUnknown: true, retryable: false })
      : new Error(message)
  }

  // ---- Library mutations --------------------------------------------------------

  async updateTrack(songId: string, values: Pick<Track, 'title' | 'artist' | 'album' | 'details'>, baseline?: Track): Promise<void> {
    const library = this.library(), observed = await library.readTrack(songId)
    const current = observed.value
    if (!current) throw new Error(uiText('music.edit.missing'))
    if (baseline && ['title', 'artist', 'album', 'details'].some(key =>
      JSON.stringify(current[key as keyof Track] ?? null) !== JSON.stringify(baseline[key as keyof Track] ?? null))) {
      throw new Error(uiText('music.edit.conflict'))
    }
    if (!values.title.trim()) throw new Error(uiText('music.edit.titleRequired'))
    const next = { ...current, title: values.title.trim(), artist: values.artist.trim(), album: values.album?.trim() ?? '',
      artists: values.artist.trim() === current.artist ? current.artists ?? [] : [], details: { ...values.details, edited: true } }
    await library.updateTrack(songId, { title: next.title, artist: next.artist, album: next.album, details: next.details }, observed.revision)
    await this.load()
  }

  async toggleFavorite(songId: string): Promise<void> {
    const track = this.trackById.get(songId)
    if (!track) return
    const library = this.library(), observed = await library.readTrack(songId)
    if (!observed.value || Boolean(observed.value.favorite) !== Boolean(track.favorite)) conflict(observed.revision)
    await library.updateTrack(songId, { favorite: !track.favorite }, observed.revision)
    await this.load()
  }

  async deleteSong(songId: string): Promise<void> {
    const library = this.library(), observed = await library.readTrack(songId)
    if (!observed.value) throw new Error('Track no longer exists')
    const cached = this.trackById.get(songId)
    if (cached && JSON.stringify(cached) !== JSON.stringify(observed.value)) conflict(observed.revision)
    await library.deleteTrack(songId, observed.revision)
    await this.load()
  }

  private async writePlaylist(pl: Playlist): Promise<void> {
    const library = this.library(), observed = await library.readPlaylist(pl.id)
    const cached = this.playlists.find(value => value.id === pl.id) ?? null
    if (JSON.stringify(observed.value) !== JSON.stringify(cached)) conflict(observed.revision)
    await library.writePlaylist(pl, observed)
    await this.load()
  }

  async createPlaylist(name: string, songIds: string[] = []): Promise<string | null> {
    const trimmed = name.trim()
    if (!trimmed) return null
    const slug =
      trimmed
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '') || `playlist-${Date.now()}`
    let id = slug
    const taken = new Set(this.playlists.map((p) => p.id))
    while (taken.has(id)) id = `${slug}-${Math.random().toString(36).slice(2, 5)}`
    const members = [...new Set(songIds)].filter((songId) => this.trackById.has(songId))
    await this.writePlaylist({ id, name: trimmed, songIds: members })
    return id
  }

  private async patchPlaylist(id: string, patch: (pl: Playlist) => Playlist): Promise<void> {
    const pl = this.playlists.find((p) => p.id === id)
    if (!pl) throw new Error('The playlist no longer exists')
    await this.writePlaylist(patch(pl))
  }

  updatePlaylistProperties(id: string, values: { name?: string; cover?: string }): Promise<void> {
    return this.patchPlaylist(id, (playlist) => {
      const next = { ...playlist }
      if (values.name !== undefined) {
        if (!values.name.trim()) throw new Error('Playlist name cannot be empty')
        next.name = values.name.trim()
      }
      if (values.cover !== undefined) {
        if (values.cover) next.cover = values.cover
        else delete next.cover
      }
      return next
    })
  }

  renamePlaylist(id: string, name: string): Promise<void> {
    return this.patchPlaylist(id, (pl) => ({ ...pl, name: name.trim() || pl.name }))
  }

  /** Set (or clear, with null) the playlist cover — stored as the image's file name. */
  setPlaylistCover(id: string, coverFileName: string | null): Promise<void> {
    return this.patchPlaylist(id, (pl) => {
      const next = { ...pl }
      if (coverFileName) next.cover = coverFileName
      else delete next.cover
      return next
    })
  }

  addToPlaylist(id: string, songId: string): Promise<void> {
    return this.patchPlaylist(id, (pl) =>
      pl.songIds.includes(songId) ? pl : { ...pl, songIds: [...pl.songIds, songId] }
    )
  }

  removeFromPlaylist(id: string, songId: string): Promise<void> {
    return this.patchPlaylist(id, (pl) => ({ ...pl, songIds: pl.songIds.filter((s) => s !== songId) }))
  }

  reorderPlaylist(id: string, songIds: string[]): Promise<void> {
    return this.patchPlaylist(id, (pl) => ({ ...pl, songIds }))
  }

  private async rawDeletePlaylist(id: string): Promise<boolean> {
    const library = this.library(), observed = await library.readPlaylist(id)
    if (!observed.value) return false
    const cached = this.playlists.find(value => value.id === id) ?? null
    if (JSON.stringify(observed.value) !== JSON.stringify(cached)) conflict(observed.revision)
    await library.deletePlaylist(id, observed)
    await this.load()
    return true
  }

  private async rawRestorePlaylist(pl: Playlist): Promise<boolean> {
    const library = this.library(), observed = await library.readPlaylist(pl.id)
    if (observed.value) conflict(observed.revision)
    await library.writePlaylist(pl, observed)
    await this.load()
    return true
  }

  deletePlaylistDirect(id: string): Promise<boolean> {
    return this.rawDeletePlaylist(id)
  }

  restorePlaylist(pl: Playlist): Promise<boolean> {
    return this.rawRestorePlaylist(pl)
  }

  async deletePlaylist(id: string): Promise<void> {
    const pl = this.playlists.find((p) => p.id === id)
    const ok = await this.rawDeletePlaylist(id)
    if (ok && pl) {
      this.api.undo.push({
        label: uiText('music.undo.deletePlaylist', { name: pl.name }),
        undo: async () => ({ ok: await this.rawRestorePlaylist(pl) }),
        redo: async () => ({ ok: await this.rawDeletePlaylist(id) })
      })
    }
  }

  // ---- Artist mutations ----------------------------------------------------
  // Membership is derived from song strings; these edit only the entity's own
  // metadata (image/bio/name/aliases). A rename keeps the old name as an alias
  // and a merge folds names in, so `syncArtists` never re-creates the old entity.

  private async writeArtist(next: Artist, expected: Artist): Promise<void> {
    const library = this.library(), observed = await library.readArtist(next.id)
    if (!sameArtist(observed.value, expected)) conflict(observed.revision)
    await library.writeArtists([{ id: next.id, value: next, revision: observed.revision }], observed.aliasesRevision)
    this.artists = this.artists.map((a) => (a.id === next.id ? next : a))
    this.emit()
  }

  private async patchArtist(id: string, patch: (a: Artist) => Artist, label: string): Promise<void> {
    const before = this.artists.find((a) => a.id === id)
    if (!before) throw new Error('The artist no longer exists')
    const after = patch(before)
    await this.writeArtist(after, before)
    this.api.undo.push({
      label,
      undo: async () => {
        if (JSON.stringify(this.artists.find((a) => a.id === id)) !== JSON.stringify(after)) throw new Error('Artist details changed after this edit')
        await this.writeArtist(before, after)
        return { ok: true }
      },
      redo: async () => {
        if (JSON.stringify(this.artists.find((a) => a.id === id)) !== JSON.stringify(before)) throw new Error('Artist details changed after undo')
        await this.writeArtist(after, before)
        return { ok: true }
      }
    })
  }

  updateArtistProperties(id: string, values: { name?: string; image?: string; bio?: string }): Promise<void> {
    return this.patchArtist(id, artist => patchArtistMetadata(artist, values), uiText('music.properties.updateArtist'))
  }

  /** Set (or clear, with null) an artist's cover image — stored as the file name. */
  setArtistImage(id: string, imageFileName: string | null): Promise<void> {
    return this.patchArtist(
      id,
      artist => patchArtistMetadata(artist, { image: imageFileName }),
      imageFileName ? 'Set artist image' : 'Remove artist image'
    )
  }

  setArtistBio(id: string, bio: string): Promise<void> {
    return this.patchArtist(
      id,
      artist => patchArtistMetadata(artist, { bio }),
      'Edit artist bio'
    )
  }

  renameArtist(id: string, newName: string): Promise<void> {
    const trimmed = newName.trim()
    if (!trimmed) return Promise.resolve()
    return this.patchArtist(
      id,
      artist => patchArtistMetadata(artist, { name: trimmed }),
      `Rename artist to “${trimmed}”`
    )
  }

  /** Fold `sourceId` into `targetId`: the source's names become target aliases,
   *  the source entity is deleted, and an open source page retargets to target. */
  async mergeArtists(sourceId: string, targetId: string): Promise<void> {
    if (sourceId === targetId) return
    const source = this.artists.find((a) => a.id === sourceId)
    const target = this.artists.find((a) => a.id === targetId)
    if (!source || !target) throw new Error('An artist no longer exists. Refresh the library and select both artists again.')

    const merged = mergeArtistMetadata(source, target)

    const wasViewing = this.pageView.mode === 'artist' && this.pageView.id === sourceId
    const writePair = async (nextSource: Artist | null, nextTarget: Artist, expectedSource: Artist | null, expectedTarget: Artist): Promise<void> => {
      const library = this.library(), [observedSource, observedTarget] = await library.readArtists([sourceId, targetId])
      if (!sameArtist(observedSource.value, expectedSource) || !sameArtist(observedTarget.value, expectedTarget)) throw new Error('Artist details changed. Refresh before merging or undoing this change.')
      await library.writeArtists([{ id: sourceId, value: nextSource, revision: observedSource.revision }, { id: targetId, value: nextTarget, revision: observedTarget.revision }], observedTarget.aliasesRevision)
      this.artists = [...this.artists.filter((item) => item.id !== sourceId && item.id !== targetId), ...(nextSource ? [nextSource] : []), nextTarget]
      if (wasViewing && this.pageView.mode === 'artist' && [sourceId, targetId].includes(this.pageView.id)) {
        this.pageView = { mode: 'artist', id: nextSource ? sourceId : targetId }
        this.persistNav()
      }
      this.emit()
    }
    await writePair(null, merged, source, target)

    this.api.undo.push({
      label: uiText('auto.511b1762da09', { p0: source.name, p1: target.name }),
      undo: async () => {
        await writePair(source, target, null, merged)
        return { ok: true }
      },
      redo: async () => {
        await writePair(null, merged, source, target)
        return { ok: true }
      }
    })
  }

  // ---- Teardown --------------------------------------------------------------------

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal
    // A pending debounced nav write must not be lost with the store.
    if (this.navPersistTimer != null) {
      window.clearTimeout(this.navPersistTimer)
      this.navPersistTimer = null
      this.flushNav()
    }
    if (this.progressTimer !== null) this.flushProgress()
    this.disposed = true
    this.offSettings()
    this.offBeforeUnload()
    this.offIndex()
    this.indexReady?.reject(new MetadataCancelled())
    this.indexReady = undefined
    this.offBackendPlayback()
    this.offDatasets()
    this.offMetadata()
    this.offPlaybackCover?.()
    this.metadata.dispose()
    this.listeners.clear()
    this.viewStateListeners.clear()
    this.disposal = (async () => {
      const results = await Promise.allSettled([this.index.dispose(), this.syncWork, this.retired])
      const failed = results.find(result => result.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
    })()
    return this.disposal
  }
}

const STORE_KEY = 'music.store'

export function createStore(api: ValleyPluginApi): MusicStore {
  const holder = api.runtime.getOrCreate<{ current: MusicStore | null }>(STORE_KEY, () => ({ current: null }))
  const retired = holder.current?.dispose()
  void retired?.catch(() => {})
  const store = new MusicStore(api, retired)
  holder.current = store
  return store
}

export function getStore(): MusicStore | null {
  return runtimeApi.runtime.getOrCreate<{ current: MusicStore | null }>(STORE_KEY, () => ({ current: null })).current
}

export function disposeStore(api: ValleyPluginApi, store: MusicStore): Promise<void> {
  const holder = api.runtime.getOrCreate<{ current: MusicStore | null }>(STORE_KEY, () => ({ current: null }))
  if (holder.current === store) holder.current = null
  return store.dispose()
}
