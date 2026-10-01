import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IndexEntry, ValleyPluginManifest } from '@valley/plugin-sdk/types'
import {
  applyDeleteSong,
  computeLibrarySync,
  dedupeHistory,
  mediaFilesInFolder,
  mostListened,
  resolveCoverPath,
  resolvePlaylistTracks,
  resolveQueue,
  serializeQueue,
  trackDetailsFromFileName
} from '../src/data'
import { createStore, disposeStore, getStore, MusicStore, nextIndex } from '../src/store'
import { connectPlayback } from './playbackFixture'
import { registerMusicCommands } from '../src/commands'
import { register } from '../src/index'
import { initRuntime } from '../src/runtime'
import { useMusic, useMusicCover } from '../src/hooks'
import { SongEditor } from '../src/SongEditor'
import { Page } from '../src/Page'
import { Player } from '../src/Player'
import { NowPlaying } from '../src/surfaces'
import { Cover } from '../src/Panel'
import {
  normalizeArtistName,
  resolveArtist,
  trackArtists,
  trackCredits,
  tracksForArtist,
  upsertArtists
} from '../src/artists'
import type { Artist, HistoryEntry, Playlist, QueueEntry, Track } from '../src/types'
import {
  createMockValleyApi as createBaseMockValleyApi,
  type MockApiOptions,
  type MockValleyApi
} from '@valley/plugin-testkit'
import { METADATA_PANEL_SEGMENT_V1, PLUGIN_SURFACE_V1, WORKSPACE_VIEW_STATE_V1, WORKSPACE_DETAILS_V1, type DatasetRecord, type PluginIndexPage, type SongMetadataResult } from '@valley/plugin-sdk'
import MUSIC_PLUGIN_CONFIG from '../config.json'

const audioRead = vi.fn(async () => new ArrayBuffer(8))
const media = new WeakMap<MockValleyApi, ReturnType<typeof connectPlayback>>()

interface MusicMockOptions extends Omit<MockApiOptions, 'manifest' | 'datasets'> {
  tracks?: Track[]
  playlists?: Playlist[]
  history?: HistoryEntry[]
  artists?: Artist[]
  queue?: QueueEntry[]
  navigationState?: Record<string, unknown>
}

function createMockValleyApi(options: MusicMockOptions = {}): MockValleyApi {
  const {
    tracks = [],
    playlists = [],
    history = [],
    artists = [],
    queue = [],
    navigationState,
    settings,
    ...rest
  } = options
  const datasets: Record<string, DatasetRecord[]> = {
    'music.tracks': tracks as unknown as DatasetRecord[],
    'music.playlists': playlists.map(({ songIds: _songIds, ...playlist }) => playlist as DatasetRecord),
    'music.playlist_tracks': playlists.flatMap((playlist) =>
      playlist.songIds.map((trackId, position) => ({ playlistId: playlist.id, trackId, position }))
    ),
    'music.play_events': history.map((entry, index) => ({ id: `test-play-${index}`, ...entry })),
    'music.artists': artists.map(({ aliases: _aliases, ...artist }) => artist as DatasetRecord),
    'music.artist_aliases': artists.flatMap((artist) =>
      (artist.aliases ?? []).map((alias) => ({ artistId: artist.id, alias }))
    ),
    'music.queue': queue.map((entry, position) => ({ position, ...entry }))
  }
  const mock = createBaseMockValleyApi({
    ...rest,
    manifest: {
      id: 'music',
      indexState: MUSIC_PLUGIN_CONFIG.indexState as 'scoped',
      datasets: MUSIC_PLUGIN_CONFIG.datasets as unknown as ValleyPluginManifest['datasets']
    },
    settings: { musicPath: 'Music', ...settings, ...(navigationState ? { navigationState } : {}) },
    datasets
  })
  mock.api.backend.call = vi.fn(async (method: string) => {
    if (method === 'audio.open') return { handle: 'audio', size: 8 }
    if (method === 'audio.read') return { base64: Buffer.from(await audioRead()).toString('base64'), done: true }
    if (method === 'audio.close') return null
    throw new Error(`Unexpected backend call: ${method}`)
  }) as typeof mock.api.backend.call
  media.set(mock, connectPlayback(mock.api))
  mock.api.ui.MediaSurface = props => React.createElement('div', { 'data-media-session': props.sessionId })
  return mock
}

const tracksOf = (mock: MockValleyApi): Track[] =>
  (mock.datasets.get('music.tracks') ?? []) as unknown as Track[]

function playlistsOf(mock: MockValleyApi): Playlist[] {
  const members = mock.datasets.get('music.playlist_tracks') ?? []
  return (mock.datasets.get('music.playlists') ?? []).map((playlist) => {
    const result: Playlist = {
      id: String(playlist.id),
      name: String(playlist.name),
      songIds: members
      .filter((member) => member.playlistId === playlist.id)
      .sort((left, right) => Number(left.position) - Number(right.position))
      .map((member) => String(member.trackId))
    }
    if (typeof playlist.cover === 'string') result.cover = playlist.cover
    return result
  })
}

const historyOf = (mock: MockValleyApi): HistoryEntry[] =>
  (mock.datasets.get('music.play_events') ?? []).map(({ id: _id, ...entry }) => entry as unknown as HistoryEntry)

function artistsOf(mock: MockValleyApi): Artist[] {
  const aliases = mock.datasets.get('music.artist_aliases') ?? []
  return (mock.datasets.get('music.artists') ?? []).map((artist) => ({
    ...(artist as unknown as Omit<Artist, 'aliases'>),
    aliases: aliases.filter((entry) => entry.artistId === artist.id).map((entry) => String(entry.alias))
  }))
}

const track = (id: string, file = `${id}.mp4`): Track => ({ id, title: id, artist: 'a', file })
const byId = (ids: string[]): Map<string, Track> => new Map(ids.map((id) => [id, track(id)]))
const asset = (relPath: string): IndexEntry => ({ relPath, title: relPath, kind: 'asset', mtimeMs: 0 })

describe('Music Properties and explicit automation', () => {
  let restoreAudio: () => void
  beforeEach(() => { restoreAudio = installFakeAudio() })
  afterEach(() => { restoreAudio(); cleanup() })

  it('rejects ambiguous playlist names and edits the explicit selection with undo', async () => {
    const mock = createMockValleyApi({ playlists: [{ id: 'forest', name: 'Nature', songIds: [] }, { id: 'wetlands', name: 'Nature', songIds: [] }] })
    const off = register(mock.api)
    try {
      await vi.waitFor(() => expect(getStore()?.getSnapshot().loading).toBe(false))
      expect(await mock.api.commands.execute('music:rename-playlist', { name: 'Nature', newName: 'Archive' })).toMatchObject({ ok: false, error: { message: expect.stringContaining('Ambiguous') } })
      const subject = { pluginId: 'music', surface: 'main_workspace', view: { view: { mode: 'playlist', id: 'wetlands' } } }
      const result = await mock.api.commands.execute('music:properties-update', { subject, values: { name: 'Wetland songs', cover: 'Pictures/reeds.png' } })
      expect(result.ok).toBe(true)
      expect(getStore()?.getSnapshot().playlists.find((item) => item.id === 'wetlands')).toMatchObject({ name: 'Wetland songs', cover: 'Pictures/reeds.png' })
      expect(getStore()?.getSnapshot().playlists.find((item) => item.id === 'forest')?.name).toBe('Nature')
      await mock.busUndo.at(-1)!.undo()
      expect(getStore()?.getSnapshot().playlists.find((item) => item.id === 'wetlands')).toMatchObject({ name: 'Nature' })
    } finally { off() }
  })

  it('shows plain playlist info with resolved cover paths and deduplicated artist totals', async () => {
    const songs = [
      { ...track('fern', 'Music/fern.mp4'), artist: 'Fern', artists: ['Fern', 'Canopy'], duration: 120 },
      { ...track('moss', 'Music/moss.mp4'), artist: 'Fern alias', artists: ['Fern alias', 'Fern'], duration: 180 },
      { ...track('leaves', 'Music/leaves.mp4'), artist: 'Canopy' }
    ]
    const mock = createMockValleyApi({
      tracks: songs,
      artists: [{ id: 'fern-artist', name: 'Fern', aliases: ['Fern alias'] }, { id: 'canopy-artist', name: 'Canopy' }],
      playlists: [{ id: 'forest', name: 'Forest', cover: 'fern.png', songIds: songs.map(song => song.id) }],
      indexEntries: [...songs.map(song => asset(song.file)), asset('Images/fern.png')]
    })
    const off = register(mock.api)
    try {
      await vi.waitFor(() => expect(getStore()?.getSnapshot().loading).toBe(false))
      const subject = { pluginId: 'music', surface: 'main_workspace' as const, view: { view: { mode: 'playlist', id: 'forest' } } }
      const segment = mock.api.interop.extensions.providers(METADATA_PANEL_SEGMENT_V1)[0].extension
      const { container } = render(React.createElement(React.Fragment, null, segment.render({ relPath: '', kind: 'unsupported', subject })))
      const values = Object.fromEntries([...container.querySelectorAll('.props-info-row')].map(row => [row.querySelector('dt')?.textContent, row.querySelector('dd')?.textContent]))
      expect(values).toMatchObject({ Name: 'Forest', Cover: 'Images/fern.png', Tracks: '3', 'Total time': '5:00', 'Tracks without duration': '1', Artists: '2', Fern: '2 songs · 5 min', Canopy: '2 songs · 2 min' })
      expect(container.querySelector('input, textarea, img, button')).toBeNull()
    } finally { off() }
  })

  it('restores a selected track without starting playback and keeps imported fields read-only', async () => {
    const songs = [track('oak', 'Music/oak.mp4')]
    const mock = createMockValleyApi({ tracks: songs, indexEntries: songs.map((song) => asset(song.file)) })
    const off = register(mock.api)
    try {
      await vi.waitFor(() => expect(getStore()?.getSnapshot().tracks).toHaveLength(1))
      const surface = mock.api.interop.extensions.providers(PLUGIN_SURFACE_V1).find(({ extension }) => extension.surface === 'main_workspace')!.extension
      const state = { v: 1, view: { mode: 'song', id: 'oak' }, searchQuery: 'canopy' }
      await surface.restore(state, undefined, { background: true })
      expect(getStore()?.getSnapshot()).toMatchObject({ pageView: { mode: 'song', id: 'oak' }, currentTrack: null })
      expect(mock.api.workspace.openMainTab).not.toHaveBeenCalled()
      const subject = { pluginId: 'music', surface: 'main_workspace' as const, view: state }
      const segment = mock.api.interop.extensions.providers(METADATA_PANEL_SEGMENT_V1)[0].extension
      expect(await segment.inspect!({ relPath: '', kind: 'unsupported', subject })).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'title', readOnly: true }), expect.objectContaining({ id: 'favorite', type: 'boolean' })]))
      const { container } = render(React.createElement(React.Fragment, null, segment.render({ relPath: '', kind: 'unsupported', subject })))
      expect(container.querySelectorAll('.props-info-row')).toHaveLength(13)
      expect(screen.getByText('Music/oak.mp4', { selector: 'dd' })).toHaveClass('props-info-value')
      expect(container.querySelector('input:not([type="checkbox"]), .settings-row')).not.toBeInTheDocument()
      expect(screen.queryByRole('switch')).toBeNull()
      await act(async () => { await mock.api.commands.execute('music:properties-update', { subject, values: { favorite: true } }) })
      expect(getStore()?.getSnapshot().favorites.has('oak')).toBe(true)
      expect(await mock.api.commands.execute('music:properties-update', { subject, values: { title: 'Changed tag' } })).toMatchObject({ ok: false, error: { message: expect.stringContaining('read-only') } })
      await expect(surface.restore({ view: { mode: 'song', id: 'missing' } })).rejects.toThrow('no longer exists')
    } finally { off() }
  })
})

function createRuntimeStore(mock: ReturnType<typeof createMockValleyApi>): MusicStore {
  initRuntime(mock.api)
  return createStore(mock.api)
}

class FakeAudio {
  static instances: FakeAudio[] = []
  static play = vi.fn(async () => {})
  currentTime = 0
  duration = 100
  readyState = 4
  preload = ''
  volume = 1
  src = ''
  paused = true
  onloadedmetadata: (() => void) | null = null
  onplaying: (() => void) | null = null
  onwaiting: (() => void) | null = null
  onseeking: (() => void) | null = null
  onseeked: (() => void) | null = null
  onerror: (() => void) | null = null
  onended: (() => void) | null = null
  constructor() { FakeAudio.instances.push(this) }
  load(): void { if (this.src) this.onloadedmetadata?.() }
  async play(): Promise<void> {
    this.paused = false
    await FakeAudio.play()
    if (!this.paused) this.onplaying?.()
  }
  pause(): void { this.paused = true }
  removeAttribute(name: string): void { if (name === 'src') this.src = '' }
}

function installFakeAudio(): () => void {
  FakeAudio.instances = []
  FakeAudio.play.mockReset().mockResolvedValue(undefined)
  const savedAudio = globalThis.Audio
  const savedFetch = globalThis.fetch
  globalThis.Audio = FakeAudio as unknown as typeof Audio
  audioRead.mockReset().mockResolvedValue(new ArrayBuffer(8))
  globalThis.fetch = vi.fn(async () => { throw new Error('Direct fetch is forbidden in the plugin sandbox') })
  return () => {
    globalThis.Audio = savedAudio
    globalThis.fetch = savedFetch
  }
}

describe('resolvePlaylistTracks', () => {
  it('resolves ordered ids and drops unknown ones', () => {
    const map = byId(['a', 'b', 'c'])
    expect(resolvePlaylistTracks(['c', 'a', 'missing', 'b'], map).map((t) => t.id)).toEqual(['c', 'a', 'b'])
  })
})

describe('applyDeleteSong', () => {
  it('strips the id from every playlist that contains it', () => {
    const playlists: Playlist[] = [
      { id: 'p1', name: 'P1', songIds: ['a', 'b', 'c'] },
      { id: 'p2', name: 'P2', songIds: ['x', 'y'] },
      { id: 'p3', name: 'P3', songIds: ['b'] }
    ]
    const changed = applyDeleteSong(playlists, 'b')
    expect(changed.map((p) => p.id)).toEqual(['p1', 'p3'])
    expect(changed[0].songIds).toEqual(['a', 'c'])
    expect(changed[1].songIds).toEqual([])
    // original untouched (pure)
    expect(playlists[0].songIds).toEqual(['a', 'b', 'c'])
  })
})

describe('dedupeHistory', () => {
  it('returns most-recent-first, de-duplicated tracks', () => {
    const entries: HistoryEntry[] = [
      { songId: 'a', playedAt: '1' },
      { songId: 'b', playedAt: '2' },
      { songId: 'a', playedAt: '3' },
      { songId: 'gone', playedAt: '4' }
    ]
    expect(dedupeHistory(entries, byId(['a', 'b'])).map((t) => t.id)).toEqual(['a', 'b'])
  })
})

describe('mostListened', () => {
  it('ranks tracks by play count, dropping deleted songs and capping at the limit', () => {
    const entries: HistoryEntry[] = [
      { songId: 'a', playedAt: '1' },
      { songId: 'b', playedAt: '2' },
      { songId: 'b', playedAt: '3' },
      { songId: 'b', playedAt: '4' },
      { songId: 'a', playedAt: '5' },
      { songId: 'gone', playedAt: '6' },
      { songId: 'c', playedAt: '7' }
    ]
    const ranked = mostListened(entries, byId(['a', 'b', 'c']))
    expect(ranked.map((r) => [r.track.id, r.plays])).toEqual([
      ['b', 3],
      ['a', 2],
      ['c', 1]
    ])
    expect(mostListened(entries, byId(['a', 'b', 'c']), 2)).toHaveLength(2)
  })
})

describe('serializeQueue / resolveQueue', () => {
  it('round-trips through queue entries, dropping missing tracks', () => {
    const tracks = [track('a'), track('b')]
    const entries: QueueEntry[] = serializeQueue(tracks)
    expect(entries).toEqual([{ songId: 'a' }, { songId: 'b' }])
    expect(resolveQueue(entries, byId(['a'])).map((t) => t.id)).toEqual(['a'])
  })
})

describe('mediaFilesInFolder', () => {
  it('keeps only media files under the music folder', () => {
    const entries = [
      asset('Music/song.mp4'),
      asset('Music/cover.jpg'),
      asset('Music/nested/tune.mp3'),
      asset('Else/other.mp4'),
      asset('Music/notes.md')
    ]
    expect(mediaFilesInFolder(entries, 'Music')).toEqual(['Music/song.mp4', 'Music/nested/tune.mp3'])
  })
})

describe('computeLibrarySync', () => {
  it('adds new folder files not yet represented by track rows', () => {
    const tracks = [track('a', 'Music/a.mp4')]
    const entries = [asset('Music/a.mp4'), asset('Music/b.mp4')]
    const sync = computeLibrarySync(tracks, ['Music/a.mp4', 'Music/b.mp4'], entries)
    expect(sync.toAdd).toEqual(['Music/b.mp4'])
    expect(sync.toHeal).toEqual([])
    expect(sync.missing.size).toBe(0)
  })

  it('heals a moved file by searching the vault for its filename', () => {
    const moved = track('a', 'Music/a.mp4')
    const entries = [asset('Archive/old/a.mp4')]
    const sync = computeLibrarySync([moved], [], entries)
    expect(sync.toAdd).toEqual([])
    expect(sync.toHeal).toEqual([{ track: moved, newPath: 'Archive/old/a.mp4' }])
    expect(sync.missing.size).toBe(0)
  })

  it('treats a file renamed within the music folder as a heal, not a new song', () => {
    const moved = track('a', 'Music/old-name (1).mp4')
    // Same basename reappears at a new path inside the folder.
    const entries = [asset('Music/sub/old-name (1).mp4')]
    const sync = computeLibrarySync([moved], ['Music/sub/old-name (1).mp4'], entries)
    expect(sync.toHeal).toEqual([{ track: moved, newPath: 'Music/sub/old-name (1).mp4' }])
    expect(sync.toAdd).toEqual([])
  })

  it('flags tracks whose file is gone from the vault entirely', () => {
    const lost = track('a', 'Music/a.mp4')
    const sync = computeLibrarySync([lost], [], [])
    expect(sync.missing.has('a')).toBe(true)
    expect(sync.toHeal).toEqual([])
  })

  it('keeps a track moved out of the music folder valid without healing', () => {
    const moved = track('a', 'Else/a.mp4')
    const entries = [asset('Else/a.mp4')]
    const sync = computeLibrarySync([moved], [], entries)
    expect(sync.missing.size).toBe(0)
    expect(sync.toHeal).toEqual([])
  })

  it('re-links a whole library moved to a new music folder without adding duplicate songs', () => {
    const songs = [track('a', 'Lounge/Music/Pre-2000/a.mp3'), track('b', 'Lounge/Music/Field Recordings/b.wav')]
    const folder = ['plugins/music/Music/Pre-2000/a.mp3', 'plugins/music/Music/Field Recordings/b.wav']
    const sync = computeLibrarySync(songs, folder, folder.map(asset))
    expect(sync.toAdd).toEqual([])
    expect(sync.toHeal).toEqual([{ track: songs[0], newPath: folder[0] }, { track: songs[1], newPath: folder[1] }])
    expect(sync.missing.size).toBe(0)
  })
})

describe('trackDetailsFromFileName', () => {
  it('humanizes the title and artist filename convention', () => {
    expect(trackDetailsFromFileName('Music/riders_on_the_storm--the_doors.mp4')).toEqual({
      title: 'Riders on the Storm',
      artist: 'The Doors'
    })
    expect(trackDetailsFromFileName('Music/one--u2.mp4')).toEqual({ title: 'One', artist: 'U2' })
  })

  it('humanizes a filename without an artist', () => {
    expect(trackDetailsFromFileName('Music/fresh-song.mp4')).toEqual({ title: 'Fresh Song', artist: '' })
  })
})

describe('nextIndex', () => {
  it('steps forward, wraps on repeat all, and stops at the end otherwise', () => {
    expect(nextIndex(3, 0, 'off')).toBe(1)
    expect(nextIndex(3, 1, 'off')).toBe(2)
    expect(nextIndex(3, 2, 'off')).toBeNull()
    expect(nextIndex(3, 2, 'all')).toBe(0)
    expect(nextIndex(0, -1, 'all')).toBeNull()
    // repeat-one never advances through nextIndex — it rewinds the active element.
    expect(nextIndex(3, 2, 'one')).toBeNull()
  })
})

describe('resolveCoverPath', () => {
  const entries = [asset('Pictures/Summer.JPG'), asset('Music/cover.png'), asset('a/b/c.md')]

  it('prefers an exact path match', () => {
    expect(resolveCoverPath(entries, 'Music/cover.png')).toBe('Music/cover.png')
  })
  it('matches by basename, case-insensitively', () => {
    expect(resolveCoverPath(entries, 'summer.jpg')).toBe('Pictures/Summer.JPG')
  })
  it('returns null for unknown or empty covers', () => {
    expect(resolveCoverPath(entries, 'nope.png')).toBeNull()
    expect(resolveCoverPath(entries, undefined)).toBeNull()
  })
})

describe('MusicStore', () => {
  let restoreAudio: () => void

  beforeEach(() => {
    restoreAudio = installFakeAudio()
  })

  afterEach(() => {
    cleanup()
    restoreAudio()
  })

  it('keeps a stale hot-reload disposer from tearing down the replacement store', () => {
    const mock = createMockValleyApi()
    initRuntime(mock.api)
    const first = createStore(mock.api)
    const second = createStore(mock.api)
    disposeStore(mock.api, first)
    expect(getStore()).toBe(second)
    disposeStore(mock.api, second)
    expect(getStore()).toBeNull()
  })

  function makeStore(options: MusicMockOptions = {}): {
    store: MusicStore
    mock: ReturnType<typeof createMockValleyApi>
  } {
    const mock = createMockValleyApi({
      settings: { musicPath: 'Music' },
      ...options
    })
    return { store: new MusicStore(mock.api), mock }
  }

  it('waits for complete path hydration before marking tracks missing or resolving covers', async () => {
    const song = track('a', 'Music/a.mp3')
    const entries = [...Array.from({ length: 128 }, (_, i) => asset(`Notes/${i}.md`)), asset(song.file), asset('Images/cover.png')]
    const mock = createMockValleyApi({ tracks: [song], playlists: [{ id: 'mix', name: 'Mix', songIds: ['a'], cover: 'cover.png' }], indexEntries: entries })
    const observe = mock.api.index.observe
    let release!: (page: PluginIndexPage) => void
    const gate = new Promise<PluginIndexPage>(resolve => { release = resolve })
    let captured: PluginIndexPage | undefined
    vi.spyOn(mock.api.index, 'observe').mockImplementation(async (scope, listener) => {
      const observation = await observe(scope, listener)
      return { ...observation, read: async request => {
        const page = await observation.read(request)
        if (request?.offset === 128) { captured = page; return gate }
        return page
      } }
    })
    const store = new MusicStore(mock.api)
    try {
      await vi.waitFor(() => expect(captured).toBeDefined())
      const syncing = store.syncLibrary()
      let settled = false
      void syncing.then(() => { settled = true })
      expect(mock.api.getState().indexEntries).toEqual([])
      expect(store.getIndexEntries()).toEqual([])
      expect(store.getSnapshot().missing.size).toBe(0)
      expect(settled).toBe(false)
      release(captured!)
      await syncing
      expect(store.getIndexEntries()).toHaveLength(130)
      expect(Object.keys(store.getIndexEntries()[0])).toEqual(['relPath'])
      expect(store.getSnapshot().missing.size).toBe(0)
      expect(store.getSnapshot().playlistCovers.mix).toBe('Images/cover.png')
      expect(mock.api.index.observe).toHaveBeenCalledOnce()
      expect(mock.api.index.observe).toHaveBeenCalledWith({ fields: [] }, expect.any(Function))
    } finally { release(captured!); await store.dispose() }
  })

  it('resynchronizes a skipped path revision and refreshes shared cover projections', async () => {
    const song = track('a', 'Music/a.mp3')
    const mock = createMockValleyApi({ tracks: [song], playlists: [{ id: 'mix', name: 'Mix', songIds: ['a'], cover: 'cover.png' }], indexEntries: [asset(song.file)] })
    const observe = mock.api.index.observe
    let skip = true
    vi.spyOn(mock.api.index, 'observe').mockImplementation((scope, listener) => observe(scope, change => {
      if (skip) { skip = false; return }
      listener(change)
    }))
    const store = new MusicStore(mock.api)
    try {
      await vi.waitFor(() => expect(store.getSnapshot().loading).toBe(false))
      await store.syncLibrary()
      mock.emitState({ indexEntries: [asset('Archive/a.mp3')] })
      mock.emitState({ indexEntries: [asset('Archive/a.mp3'), asset('Images/cover.png')] })
      await vi.waitFor(() => expect(store.getSnapshot().playlistCovers.mix).toBe('Images/cover.png'))
      await store.syncLibrary()
      expect(store.getSnapshot().tracks[0].file).toBe('Archive/a.mp3')
      expect(store.getSnapshot().missing.size).toBe(0)
      expect(mock.api.getState().indexEntries).toEqual([])
    } finally { await store.dispose() }
  })

  it('joins a held path read on disposal and never publishes its late snapshot', async () => {
    const mock = createMockValleyApi({ indexEntries: [asset('Music/a.mp3')] })
    const observe = mock.api.index.observe
    let release!: (page: PluginIndexPage) => void
    const gate = new Promise<PluginIndexPage>(resolve => { release = resolve })
    let captured: PluginIndexPage | undefined
    const closed = vi.fn()
    vi.spyOn(mock.api.index, 'observe').mockImplementation(async (scope, listener) => {
      const observation = await observe(scope, listener)
      return { read: async request => { captured = await observation.read(request); return gate }, dispose: async () => { closed(); await observation.dispose() } }
    })
    const store = new MusicStore(mock.api)
    await vi.waitFor(() => expect(captured).toBeDefined())
    const listener = vi.fn()
    store.subscribe(listener)
    const before = store.getSnapshot()
    let settled = false
    const closing = store.dispose()
    void closing.then(() => { settled = true })
    expect(store.dispose()).toBe(closing)
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(closed).toHaveBeenCalledOnce()
    release(captured!)
    await closing
    expect(store.getIndexEntries()).toEqual([])
    expect(store.getSnapshot()).toBe(before)
    expect(listener).not.toHaveBeenCalled()
    expect(tracksOf(mock)).toEqual([])
  })

  it('coalesces pending scans and reuses accepted metadata for visible covers', async () => {
    const mock = createMockValleyApi({ settings: { musicPath: 'Music' }, indexEntries: [asset('Music/fresh.mp3')] })
    let settle!: (result: SongMetadataResult) => void
    const read = vi.spyOn(mock.api.drivers.media, 'readMetadata').mockReturnValue(new Promise((resolve) => { settle = resolve }))
    const store = new MusicStore(mock.api)
    try {
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
      const first = store.syncLibrary()
      expect(store.syncLibrary()).toBe(first)
      expect(store.syncLibrary()).toBe(first)
      settle({ ok: true, data: { title: 'Fresh', artist: 'Canopy', album: null, cover: null } })
      await first
      expect(tracksOf(mock)).toHaveLength(1)
      expect(tracksOf(mock)[0]).toMatchObject({ title: 'Fresh', artist: 'Canopy' })
      const off = store.subscribeCover(tracksOf(mock)[0].id, vi.fn())
      await Promise.resolve()
      expect(read).toHaveBeenCalledTimes(1)
      off()
    } finally { store.dispose() }
  })

  it.each(['dispose', 'vault round trip'] as const)('does not write a held scan after %s', async (change) => {
    const vault = { path: '/fixture-a', name: 'fixture-a', displayName: 'Fixture A' }
    const mock = createMockValleyApi({ vault, settings: { musicPath: 'Music' }, indexEntries: [asset('Music/fresh.mp3')] })
    let settle!: (result: SongMetadataResult) => void
    const read = vi.spyOn(mock.api.drivers.media, 'readMetadata').mockReturnValue(new Promise((resolve) => { settle = resolve }))
    const store = new MusicStore(mock.api)
    try {
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
      const pending = store.syncLibrary()
      if (change === 'dispose') store.dispose()
      else {
        mock.emitState({ vault: { ...vault, path: '/fixture-b' } })
        mock.emitState({ vault })
      }
      settle({ ok: true, data: { title: 'Late', artist: 'Canopy', album: null, cover: null } })
      await pending
      await store.syncLibrary()
      expect(tracksOf(mock)).toEqual([])
      expect(read).toHaveBeenCalledTimes(1)
    } finally { store.dispose() }
  })

  it('invalidates retained native metadata on vault changes and detaches on unload', async () => {
    const songs = [track('a', 'Music/a.mp3')]
    const mock = createMockValleyApi({ tracks: songs, indexEntries: songs.map((song) => asset(song.file)) })
    let changed!: () => void
    const detached = vi.fn()
    vi.spyOn(mock.api.vault, 'onChanged').mockImplementation((listener) => { changed = () => listener({ full: true }); return detached })
    const read = vi.spyOn(mock.api.drivers.media, 'readMetadata')
    const store = new MusicStore(mock.api)
    try {
      await vi.waitFor(() => expect(store.getSnapshot().loading).toBe(false))
      const listener = vi.fn()
      const off = store.subscribeCover('a', listener)
      await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1))
      store.getCoverUrl('a')
      mock.emitState({ activePath: 'Elsewhere.md' })
      expect(read).toHaveBeenCalledTimes(1)
      changed()
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2))
      off()
      store.dispose()
      expect(detached).toHaveBeenCalledTimes(1)
      changed()
      expect(read).toHaveBeenCalledTimes(2)
    } finally { store.dispose() }
  })

  it('retargets playback cover demand when the accepted track path changes', async () => {
    const song = track('canopy', 'Music/canopy.mp3')
    const { store, mock } = makeStore({ tracks: [song], indexEntries: [asset(song.file)] })
    const read = vi.spyOn(mock.api.drivers.media, 'readMetadata')
    try {
      await vi.waitFor(() => expect(store.getSnapshot().loading).toBe(false))
      store.playTrack(song)
      await store.flushPersistence()
      await vi.waitFor(() => expect(read).toHaveBeenCalledWith(song.file))
      mock.datasets.set('music.tracks', [{ ...song, file: 'Music/renamed.mp3' }])
      mock.emitState({ indexEntries: [asset('Music/renamed.mp3')] })
      await store.load()
      await vi.waitFor(() => expect(read).toHaveBeenCalledWith('Music/renamed.mp3'))
      expect(read).toHaveBeenCalledTimes(2)
    } finally { store.dispose() }
  })

  it('observes visible cover demand, reuses it on reentry, and ignores late observer delivery', async () => {
    const songs = [track('a', 'Music/a.mp3')]
    const { store, mock } = makeStore({ tracks: songs, indexEntries: songs.map((song) => asset(song.file)) })
    initRuntime(mock.api)
    let visibility!: (entries: IntersectionObserverEntry[]) => void
    const disconnect = vi.fn()
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: typeof visibility) { visibility = callback }
      observe = vi.fn()
      disconnect = disconnect
    })
    const read = vi.spyOn(mock.api.drivers.media, 'readMetadata')
    const subscribe = vi.spyOn(store, 'subscribeCover')
    function CoverProbe() {
      const { url, ref } = useMusicCover(store, 'a')
      return React.createElement('span', { ref }, url ?? 'Placeholder')
    }
    try {
      await vi.waitFor(() => expect(store.getSnapshot().loading).toBe(false))
      const view = render(React.createElement(CoverProbe))
      expect(read).not.toHaveBeenCalled()
      const setVisible = (isIntersecting: boolean) => act(() => visibility([{ isIntersecting } as IntersectionObserverEntry]))
      setVisible(true)
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
      setVisible(false)
      setVisible(true)
      await Promise.resolve()
      expect(read).toHaveBeenCalledTimes(1)
      expect(subscribe).toHaveBeenCalledTimes(2)
      view.unmount()
      expect(disconnect).toHaveBeenCalledTimes(1)
      setVisible(true)
      expect(subscribe).toHaveBeenCalledTimes(2)
    } finally { cleanup(); store.dispose(); vi.unstubAllGlobals() }
  })

  it('keeps the observed cover element stable when the placeholder becomes an image', async () => {
    const song = track('canopy', 'Music/canopy.mp3')
    const mock = createMockValleyApi({ tracks: [song], indexEntries: [asset(song.file)], songMetadata: {
      [song.file]: { title: null, artist: null, album: null, cover: { data: new Uint8Array([1, 2, 3]), mime: 'image/png' } }
    } })
    initRuntime(mock.api)
    let visibility!: (entries: IntersectionObserverEntry[]) => void
    const observed = vi.fn()
    const disconnected = vi.fn()
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: typeof visibility) { visibility = callback }
      observe = observed
      disconnect = disconnected
    })
    const revoked = vi.fn()
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL = vi.fn(() => 'blob:canopy-cover')
      static revokeObjectURL = revoked
    })
    const store = createStore(mock.api)
    try {
      await vi.waitFor(() => expect(store.getSnapshot().loading).toBe(false))
      const view = render(React.createElement(Cover, { trackId: song.id }))
      const element = observed.mock.calls[0][0]
      act(() => visibility([{ isIntersecting: true } as IntersectionObserverEntry]))
      await waitFor(() => expect(view.container.querySelector('img')?.getAttribute('src')).toBe('blob:canopy-cover'))
      expect(observed).toHaveBeenCalledTimes(1)
      expect(element).toBe(view.container.firstElementChild)
      expect(disconnected).not.toHaveBeenCalled()
      view.unmount()
      expect(disconnected).toHaveBeenCalledTimes(1)
      disposeStore(mock.api, store)
      expect(revoked).toHaveBeenCalledTimes(1)
      expect(revoked).toHaveBeenCalledWith('blob:canopy-cover')
    } finally { cleanup(); disposeStore(mock.api, store); vi.unstubAllGlobals() }
  })

  it('updates real playback ticks without rebuilding library, queue, or view projections', async () => {
    const songs = [track('a', 'Music/a.mp4'), track('b', 'Music/b.mp4')]
    const { store, mock } = makeStore({ tracks: songs, playlists: [{ id: 'mix', name: 'Mix', songIds: ['a', 'b'], cover: 'cover.png' }], indexEntries: [...songs.map((song) => asset(song.file)), asset('Music/cover.png')] })
    try {
      await vi.waitFor(() => expect(store.getSnapshot().loading).toBe(false))
      vi.useFakeTimers()
      store.playQueue(songs, 0, 'mix')
      await store.flushPersistence()
      await vi.advanceTimersByTimeAsync(0)
      await store.flushPersistence()
      const before = store.getSnapshot()
      const readIndex = vi.spyOn(mock.api, 'getState')
      const readSettings = vi.spyOn(mock.api.settings, 'get')
      const readData = vi.spyOn(mock.api.data, 'dataset')
      media.get(mock)!.observe({ positionSeconds: 3 })
      await vi.advanceTimersByTimeAsync(1000)
      expect(store.getSnapshot().currentTime).toBe(3)
      expect(media.get(mock)!.getSnapshot()?.state.positionSeconds).toBe(3)
      expect(readIndex).not.toHaveBeenCalled()
      expect(readSettings).not.toHaveBeenCalled()
      expect(readData).not.toHaveBeenCalled()
      store.setVolume(0.4)
      await store.flushPersistence()
      store.pause()
      await store.flushPersistence()
      const after = store.getSnapshot()
      expect(after).toMatchObject({ volume: 0.4, isPlaying: false })
      for (const key of ['tracks', 'playlists', 'artists', 'playlistTracks', 'playlistCovers', 'favorites', 'history', 'recentlyPlayed', 'topPlayed', 'missing', 'upNext', 'leftPanelSections'] as const) {
        expect(after[key], key).toBe(before[key])
      }
    } finally { store.dispose(); vi.useRealTimers() }
  })

  it('keeps queue edits and navigation separate from library history and playback publication', async () => {
    const songs = [track('a', 'Music/a.mp4'), track('b', 'Music/b.mp4')]
    const { store, mock } = makeStore({ tracks: songs, playlists: [{ id: 'mix', name: 'Mix', songIds: ['a', 'b'] }], indexEntries: songs.map((song) => asset(song.file)) })
    try {
      await vi.waitFor(() => expect(store.getSnapshot().loading).toBe(false))
      const before = store.getSnapshot()
      const changed = vi.fn()
      const offPlayback = mock.api.backend.on('playback.changed', changed)
      store.showPlaylist('mix')
      store.setPageSearch('song')
      store.setLeftPanelSearch('mix')
      store.setRightQueueOpen(false)
      expect(changed).not.toHaveBeenCalled()
      expect(store.getSnapshot().upNext).toBe(before.upNext)
      store.addTracksToQueue(songs)
      await store.flushPersistence()
      store.reorderQueue(0, 1)
      await store.flushPersistence()
      expect(store.getSnapshot().upNext.map((song) => song.id)).toEqual(['b', 'a'])
      store.removeFromQueue(0)
      await store.flushPersistence()
      expect(store.getSnapshot().upNext.map((song) => song.id)).toEqual(['a'])
      store.clearQueue()
      await store.flushPersistence()
      expect(store.getSnapshot().upNext).toEqual([])
      for (const key of ['tracks', 'playlists', 'playlistTracks', 'playlistCovers', 'favorites', 'history', 'topPlayed'] as const) {
        expect(store.getSnapshot()[key], key).toBe(before[key])
      }
      expect(historyOf(mock)).toEqual([])
      expect(changed.mock.calls.length).toBeGreaterThanOrEqual(4)
      offPlayback()
    } finally { store.dispose() }
  })

  it('refreshes library projections when favorites, history, or playlist contents change', async () => {
    const songs = [track('a', 'Music/a.mp4'), track('b', 'Music/b.mp4')]
    const { store } = makeStore({ tracks: songs, playlists: [{ id: 'mix', name: 'Mix', songIds: ['a', 'b'] }], indexEntries: songs.map((song) => asset(song.file)) })
    try {
      await vi.waitFor(() => expect(store.getSnapshot().loading).toBe(false))
      const before = store.getSnapshot()
      await store.toggleFavorite('a')
      expect(store.getSnapshot().favorites).not.toBe(before.favorites)
      expect(store.getSnapshot().favorites.has('a')).toBe(true)
      expect(store.getSnapshot().playlistTracks.mix[0].favorite).toBe(true)
      store.playTrack(store.getSnapshot().tracks.find(track => track.id === 'b')!, { playlistId: 'mix' })
      await store.flushPersistence()
      await store.flushPersistence()
      expect(store.getSnapshot().history.map((song) => song.id)).toEqual(['b'])
      expect(store.getSnapshot().topPlayed[0]).toMatchObject({ track: { id: 'b' }, plays: 1 })
      await store.reorderPlaylist('mix', ['b'])
      expect(store.getSnapshot().playlistTracks.mix.map((song) => song.id)).toEqual(['b'])
    } finally { store.dispose() }
  })

  it.each([999, 1000, 1001])('preserves every relationship when editing %i-track playlists and artist aliases', async (count) => {
    const songs = Array.from({ length: count }, (_, index) => track(`song-${index}`, `Music/song-${index}.mp4`))
    const aliases = Array.from({ length: count }, (_, index) => `alias-${index}`)
    const { store, mock } = makeStore({
      tracks: songs, playlists: [{ id: 'large', name: 'Large', songIds: songs.map((song) => song.id) }],
      artists: [{ id: 'artist', name: 'a', aliases }], indexEntries: songs.map((song) => asset(song.file))
    })
    try {
      await vi.waitFor(() => expect(store.getSnapshot().loading).toBe(false))
      const transaction = vi.spyOn(mock.api.data, 'transaction')
      await store.renamePlaylist('large', 'Renamed')
      await store.updateArtistProperties('artist', { name: 'Renamed artist' })
      expect(playlistsOf(mock)[0].songIds).toEqual(songs.map((song) => song.id))
      expect(artistsOf(mock).find((artist) => artist.id === 'artist')?.aliases).toEqual(expect.arrayContaining([...aliases, 'a']))
      expect(artistsOf(mock).find((artist) => artist.id === 'artist')?.aliases).toHaveLength(count + 1)
      const changed = songs.map((song) => song.id).reverse().slice(1)
      await store.reorderPlaylist('large', changed)
      expect(playlistsOf(mock)[0].songIds).toEqual(changed)
      expect(transaction.mock.calls.every(([operations]) => operations.length <= 1000)).toBe(true)
    } finally { store.dispose() }
  })

  it('clears a large playlist atomically and leaves every row intact when a late grouped key is rejected', async () => {
    const songs = Array.from({ length: 1001 }, (_, index) => track(`song-${index}`, `Music/song-${index}.mp4`))
    const original = songs.map((song) => song.id)
    const { store, mock } = makeStore({ tracks: songs, playlists: [{ id: 'large', name: 'Large', songIds: original }], indexEntries: songs.map((song) => asset(song.file)) })
    try {
      await vi.waitFor(() => expect(store.getSnapshot().loading).toBe(false))
      const transact = mock.api.data.transaction
      const transaction = vi.spyOn(mock.api.data, 'transaction')
      transaction.mockImplementationOnce((operations, options) => transact([...operations, { dataset: 'music.playlist_tracks', operation: 'delete-many', keys: [{ playlistId: 'large' }] }], options))
      await expect(store.reorderPlaylist('large', [])).rejects.toThrow()
      expect(transaction).toHaveBeenCalledOnce()
      expect(playlistsOf(mock)[0].songIds).toEqual(original)
      expect(store.getSnapshot().playlists[0].songIds).toEqual(original)
      await store.reorderPlaylist('large', [])
      expect(transaction).toHaveBeenCalledTimes(2)
      expect(transaction.mock.calls[1][0]).toHaveLength(2)
      expect(transaction.mock.calls[1][0][1]).toEqual({ dataset: 'music.playlist_tracks', operation: 'delete-many', keys: original.map((_id, position) => ({ playlistId: 'large', position })) })
      expect(playlistsOf(mock)[0].songIds).toEqual([])
      expect(store.getSnapshot().playlists[0].songIds).toEqual([])
    } finally { store.dispose() }
  })

  it('persists a large queue with one batch and removes it with one exact-key group', async () => {
    const songs = Array.from({ length: 1001 }, (_, index) => track(`song-${index}`, `Music/song-${index}.mp4`))
    const { store, mock } = makeStore({ tracks: songs, indexEntries: songs.map(song => asset(song.file)) })
    try {
      await vi.waitFor(() => expect(store.getSnapshot().loading).toBe(false))
      const dataset = mock.api.data.dataset, queue = dataset('music.queue')
      vi.spyOn(mock.api.data, 'dataset').mockImplementation(((id) => id === 'music.queue' ? queue : dataset(id)) as typeof dataset)
      const applyBatch = queue.batch, batch = vi.spyOn(queue, 'batch')
      store.addTracksToQueue(songs, 'end')
      await store.flushPersistence()
      await mock.runBeforeUnload()
      expect(batch).toHaveBeenCalledOnce()
      expect(batch.mock.calls[0][0]).toHaveLength(1)
      expect(mock.datasets.get('music.queue')).toHaveLength(1001)
      batch.mockImplementationOnce((operations, options) => applyBatch([...operations, { operation: 'delete-many', keys: [{}] }], options))
      store.clearQueue()
      await expect(mock.runBeforeUnload()).rejects.toThrow()
      expect(mock.datasets.get('music.queue')).toHaveLength(1001)
      await mock.runBeforeUnload()
      expect(batch).toHaveBeenCalledTimes(3)
      expect(batch.mock.calls[2][0]).toEqual([{ operation: 'delete-many', keys: songs.map((_song, position) => ({ position })) }])
      expect(mock.datasets.get('music.queue')).toEqual([])
    } finally { store.dispose() }
  })

  it('merges and restores more than one thousand artist aliases in one transaction per action', async () => {
    const aliases = Array.from({ length: 1001 }, (_, index) => `alias-${index}`)
    const { store, mock } = makeStore({ artists: [{ id: 'source', name: 'Source', aliases }, { id: 'target', name: 'Target', aliases: ['existing'] }] })
    try {
      await vi.waitFor(() => expect(store.getSnapshot().loading).toBe(false))
      const transaction = vi.spyOn(mock.api.data, 'transaction')
      await store.mergeArtists('source', 'target')
      expect(transaction).toHaveBeenCalledOnce()
      expect(transaction.mock.calls[0][0].length).toBeLessThan(1000)
      expect(transaction.mock.calls[0][1]?.expected).toEqual(expect.arrayContaining([
        expect.objectContaining({ dataset: 'music.artists', key: { id: 'source' }, revision: expect.any(Number) }),
        expect.objectContaining({ dataset: 'music.artists', key: { id: 'target' }, revision: expect.any(Number) }),
        expect.objectContaining({ dataset: 'music.artist_aliases', revision: expect.any(Number) })
      ]))
      expect(artistsOf(mock).find(artist => artist.id === 'target')?.aliases).toHaveLength(1003)
      const action = mock.undoActions.at(-1)!
      await action.undo()
      expect(transaction).toHaveBeenCalledTimes(2)
      expect(artistsOf(mock).find(artist => artist.id === 'source')?.aliases).toEqual(aliases)
      expect(artistsOf(mock).find(artist => artist.id === 'target')?.aliases).toEqual(['existing'])
      await action.redo!()
      expect(transaction).toHaveBeenCalledTimes(3)
      expect(artistsOf(mock).some(artist => artist.id === 'source')).toBe(false)
    } finally { store.dispose() }
  })

  it('flushes pending navigation and queue state before unload and leaves no disposal writes', async () => {
    const songs = ['oak', 'fern'].map((id) => track(id, `Music/${id}.mp4`))
    const { store, mock } = makeStore({ tracks: songs, indexEntries: songs.map((song) => asset(song.file)) })
    try {
      await vi.waitFor(() => expect(store.getSnapshot().loading).toBe(false))
      store.setPageSearch('forest')
      let finish!: () => void
      const pending = new Promise<void>((resolve) => { finish = resolve })
      const dataset = mock.api.data.dataset
      const queue = dataset('music.queue')
      const batch = queue.batch
      vi.spyOn(mock.api.data, 'dataset').mockImplementation(((id) => id === 'music.queue' ? queue : dataset(id)) as typeof dataset)
      const writes = vi.spyOn(queue, 'batch').mockImplementation(async (...args) => {
        await pending
        return batch(...args)
      })
      const setSetting = mock.api.settings.set
      const navigationWrites = vi.spyOn(mock.api.settings, 'set').mockImplementation(async (...args) => {
        if (args[0] === 'navigationState') await pending
        return setSetting(...args)
      })
      store.addTracksToQueue(store.getSnapshot().tracks, 'end')
      let prepared = false
      const saving = mock.runBeforeUnload().then(() => { prepared = true })
      await vi.waitFor(() => expect(writes).toHaveBeenCalledTimes(1))
      expect(prepared).toBe(false)
      store.setPageSearch('new forest')
      store.addTracksToQueue([songs[0]], 'end')
      finish()
      await saving
      expect(mock.api.settings.get().navigationState).toMatchObject({ searchQuery: 'new forest' })
      expect(mock.datasets.get('music.queue')?.map((row) => row.songId)).toEqual(['oak', 'fern', 'oak'])
      expect(writes).toHaveBeenCalledTimes(2)
      const savedNavigationWrites = navigationWrites.mock.calls.length
      const savedWrites = writes.mock.calls.length
      store.dispose()
      await mock.runBeforeUnload()
      expect(writes).toHaveBeenCalledTimes(savedWrites)
      expect(navigationWrites).toHaveBeenCalledTimes(savedNavigationWrites)
    } finally { store.dispose() }
  })

  it('hydrates the saved queue before publishing the interactive library', async () => {
    const songs = ['oak', 'fern'].map((id) => track(id, `Music/${id}.mp4`))
    const mock = createMockValleyApi({ tracks: songs, queue: serializeQueue([songs[0]]), indexEntries: songs.map((song) => asset(song.file)) })
    const dataset = mock.api.data.dataset
    const queue = dataset('music.queue')
    const query = queue.query
    let finish!: () => void
    const blocked = new Promise<void>((resolve) => { finish = resolve })
    const read = vi.spyOn(queue, 'query').mockImplementationOnce(async (...args) => { await blocked; return query(...args) })
    vi.spyOn(mock.api.data, 'dataset').mockImplementation(((id) => id === 'music.queue' ? queue : dataset(id)) as typeof dataset)
    const store = new MusicStore(mock.api)
    try {
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
      expect(store.getSnapshot()).toMatchObject({ loading: true, tracks: [] })
      finish()
      await vi.waitFor(() => expect(store.getSnapshot().loading).toBe(false))
      expect(store.getSnapshot().upNext.map((song) => song.id)).toEqual(['oak'])
      store.addTracksToQueue([songs[1]], 'end')
      await store.flushPersistence()
      await mock.runBeforeUnload()
      expect(mock.datasets.get('music.queue')?.map((row) => row.songId)).toEqual(['oak', 'fern'])
    } finally { finish(); store.dispose() }
  })

  it('refuses unload on a failed queue save, retains the queue, and retries the pending state', async () => {
    const songs = [track('oak', 'Music/oak.mp4')]
    const { store, mock } = makeStore({ tracks: songs, indexEntries: songs.map((song) => asset(song.file)) })
    try {
      await vi.waitFor(() => expect(store.getSnapshot().loading).toBe(false))
      const dataset = mock.api.data.dataset
      const queue = dataset('music.queue')
      vi.spyOn(mock.api.data, 'dataset').mockImplementation(((id) => id === 'music.queue' ? queue : dataset(id)) as typeof dataset)
      const writes = vi.spyOn(queue, 'batch').mockRejectedValue(new Error('disk full'))
      store.addTracksToQueue(store.getSnapshot().tracks, 'end')
      await expect(mock.runBeforeUnload()).rejects.toThrow('Could not save Music state')
      expect(writes).toHaveBeenCalledTimes(1)
      expect(store.getSnapshot().upNext.map((song) => song.id)).toEqual(['oak'])
      expect(mock.datasets.get('music.queue')).toEqual([])
      writes.mockRestore()
      await mock.runBeforeUnload()
      expect(mock.datasets.get('music.queue')?.map((row) => row.songId)).toEqual(['oak'])
    } finally { store.dispose() }
  })

  it('loads the library, registers a playback source and scans the folder', async () => {
    const existing = track('a', 'Music/a.mp4')
    const { store, mock } = makeStore({
      tracks: [existing],
      indexEntries: [asset('Music/a.mp4'), asset('Music/fresh-song.mp4')]
    })

    await vi.waitFor(() => {
      expect(tracksOf(mock)).toHaveLength(2)
    })
    const added = tracksOf(mock)[1]
    expect(added.file).toBe('Music/fresh-song.mp4')
    expect(added.title).toBe('Fresh Song')

    expect(store.getSnapshot().sessionId).toBe('music-session')
    expect(mock.playbackSources.size).toBe(0)
    store.dispose()
    expect(media.get(mock)!.player.dispose).not.toHaveBeenCalled()
  })

  it('repairs legacy filename titles from embedded media metadata', async () => {
    const file = 'Music/riders_on_the_storm--the_doors.mp4'
    const legacy = {
      ...track('riders', file),
      title: 'riders_on_the_storm--the_doors',
      artist: '',
      addedAt: '2026-08-29T21:12:32.499Z'
    }
    const { store, mock } = makeStore({
      tracks: [legacy],
      indexEntries: [asset(file)],
      songMetadata: {
        [file]: { title: 'Riders on the Storm', artist: 'The Doors', album: 'L.A. Woman', cover: null }
      }
    })

    await vi.waitFor(() => {
      expect(tracksOf(mock)[0]).toMatchObject({
        id: 'riders',
        title: 'Riders on the Storm',
        artist: 'The Doors',
        album: 'L.A. Woman'
      })
    })
    expect(store.getSnapshot().tracks[0]).toMatchObject({ title: 'Riders on the Storm', artist: 'The Doors' })
    store.dispose()
  })

  it('renders a functional settings pane that saves the folder and rescans', async () => {
    const mock = createMockValleyApi({
      settings: { musicPath: 'Music' },
      indexEntries: [
        asset('Music/old.mp3'),
        asset('Audio/new.mp3'),
        asset('Audio/live.mov')
      ]
    })
    const dispose = register(mock.api)
    const calls = (mock.api.registerView as unknown as { mock: { calls: [string, React.ComponentType][] } }).mock.calls
    const SettingsView = calls.find(([key]) => key === 'music.settings')?.[1]
    expect(SettingsView).toBeDefined()

    render(React.createElement(SettingsView!))
    await screen.findByText('Manually rescan the music folder for new or removed files. 1 media file found in this folder.')

    const folderField = screen.getByLabelText('Music folder')
    fireEvent.change(folderField, { target: { value: 'Audio' } })
    await screen.findByText('Manually rescan the music folder for new or removed files. 2 media files found in this folder.')
    // VaultFolderField has no Save button — it commits on Enter/blur.
    fireEvent.blur(folderField)

    await waitFor(() => {
      expect(mock.driverCalls).toContainEqual({
        driver: 'settings',
        method: 'updatePluginSettings',
        payload: { pluginId: 'music', key: 'musicPath', value: 'Audio' }
      })
      expect(tracksOf(mock).map((track) => track.file)).toEqual(
        expect.arrayContaining(['Audio/new.mp3', 'Audio/live.mov'])
      )
    })
    await screen.findByText('Saved and rescanned.')
    dispose()
  })

  it('keeps the initial path empty and persists only an explicit valid choice once', async () => {
    const mock = createMockValleyApi({
      settings: { musicPath: '' },
      indexEntries: [asset('Audio/song.mp3')]
    })
    const dispose = register(mock.api)
    const calls = (mock.api.registerView as unknown as { mock: { calls: [string, React.ComponentType][] } }).mock.calls
    const SettingsView = calls.find(([key]) => key === 'music.settings')?.[1]
    render(React.createElement(SettingsView!))
    const folderField = screen.getByLabelText('Music folder')
    expect(folderField).toHaveValue('')
    expect(folderField).toHaveAttribute('placeholder', 'Lifestyle/music')

    const settingsWrites = (): typeof mock.driverCalls =>
      mock.driverCalls.filter((call) => call.driver === 'settings' && call.method === 'updatePluginSettings')
    fireEvent.focus(folderField)
    fireEvent.blur(folderField)
    fireEvent.change(folderField, { target: { value: '../outside' } })
    fireEvent.blur(folderField)
    expect(settingsWrites()).toHaveLength(0)

    fireEvent.change(folderField, { target: { value: 'Audio' } })
    fireEvent.blur(folderField)
    await waitFor(() => expect(settingsWrites()).toHaveLength(1))
    expect(settingsWrites()[0]?.payload).toEqual({ pluginId: 'music', key: 'musicPath', value: 'Audio' })
    dispose()
  })

  it('rescans when the folder setting changes outside Music', async () => {
    const file = 'plugins/music/Music/Pre-2000/so_what--miles_davis.mp3'
    const { store, mock } = makeStore({ indexEntries: [asset(file)] })
    try {
      await vi.waitFor(() => expect(store.getSnapshot().loading).toBe(false))
      expect(tracksOf(mock)).toEqual([])
      await mock.api.settings.set('musicPath', 'plugins/music')
      await vi.waitFor(() => expect(tracksOf(mock).map((song) => song.file)).toEqual([file]))
      expect(store.getSnapshot().musicPath).toBe('plugins/music')
    } finally { store.dispose() }
  })

  it('keeps saved playlists and history when the library folder moves', async () => {
    const songs = [
      track('so-what', 'Lounge/Music/Pre-2000/so_what--miles_davis.mp3'),
      track('field-01', 'Lounge/Music/Field Recordings/field-recording-01.wav')
    ]
    const moved = songs.map((song) => song.file.replace('Lounge/Music/', 'plugins/music/Music/'))
    const history: HistoryEntry[] = [{ songId: 'so-what', playedAt: '2026-09-09T10:00:00.000Z' }]
    const { store, mock } = makeStore({
      settings: { musicPath: 'plugins/music' },
      tracks: songs,
      playlists: [{ id: 'mix', name: 'Mix', songIds: ['field-01', 'so-what'] }],
      history,
      indexEntries: moved.map(asset)
    })
    try {
      await vi.waitFor(() => expect(tracksOf(mock).map((song) => song.file)).toEqual(moved))
      expect(tracksOf(mock).map((song) => song.id)).toEqual(['so-what', 'field-01'])
      expect(playlistsOf(mock)).toEqual([{ id: 'mix', name: 'Mix', songIds: ['field-01', 'so-what'] }])
      expect(historyOf(mock)).toEqual(history)
      await vi.waitFor(() => expect(store.getSnapshot().missing.size).toBe(0))
    } finally { store.dispose() }
  })

  it('clears a page search when a playlist or song is opened from outside the page', async () => {
    const songs = [track('a', 'Music/a.mp3')]
    const { store } = makeStore({ tracks: songs, playlists: [{ id: 'mix', name: 'Mix', songIds: ['a'] }], indexEntries: songs.map((song) => asset(song.file)) })
    try {
      await vi.waitFor(() => expect(store.getSnapshot().loading).toBe(false))
      store.setPageSearch('forest')
      store.showPlaylist('mix')
      expect(store.getSnapshot()).toMatchObject({ pageSearch: '', pageView: { mode: 'playlist', id: 'mix' } })
      store.setPageSearch('forest')
      store.revealSong('a')
      expect(store.getSnapshot()).toMatchObject({ pageSearch: '', pageView: { mode: 'playlist', id: 'mix', reveal: 'a' } })
    } finally { store.dispose() }
  })

  it('keeps volume in the host while preserving plugin shuffle and repeat settings', async () => {
    const { store, mock } = makeStore({ settings: { musicPath: 'Music', player: { volume: 0.25, shuffle: true, repeat: 'one' } } })
    const storage = vi.spyOn(Storage.prototype, 'setItem')
    const playerWrites = (): typeof mock.driverCalls =>
      mock.driverCalls.filter((call) => call.driver === 'settings' && (call.payload as { key?: string }).key === 'player')
    try {
      await vi.waitFor(() => expect(store.getSnapshot().loading).toBe(false))
      expect(store.getSnapshot()).toMatchObject({ volume: 0.8, shuffle: true, repeatMode: 'one' })
      vi.useFakeTimers()
      store.setVolume(0.6)
      await store.flushPersistence()
      store.setVolume(0.5)
      await store.flushPersistence()
      store.toggleShuffle()
      await store.flushPersistence()
      store.cycleRepeat()
      await store.flushPersistence()
      await vi.advanceTimersByTimeAsync(300)
      expect(playerWrites()).toHaveLength(2)
      expect(mock.api.settings.get().player).toEqual({ volume: 0.25, shuffle: false, repeat: 'off' })
      expect(media.get(mock)!.getSnapshot()?.state.volume).toBe(0.5)
      store.setVolume(0)
      await store.flushPersistence()
      await mock.runBeforeUnload()
      expect(playerWrites()).toHaveLength(2)
      expect(mock.api.settings.get().player).toEqual({ volume: 0.25, shuffle: false, repeat: 'off' })
      expect(media.get(mock)!.getSnapshot()?.state.volume).toBe(0)
      expect(storage).not.toHaveBeenCalled()
    } finally { store.dispose(); vi.useRealTimers(); storage.mockRestore() }
    const restored = new MusicStore(mock.api)
    await vi.waitFor(() => expect(restored.getSnapshot().loading).toBe(false))
    expect(restored.getSnapshot()).toMatchObject({ volume: 0, shuffle: false, repeatMode: 'off' })
    restored.dispose()
  })

  it('publishes separate artist and featured credits with neighboring file paths', async () => {
    const songs = [track('a', 'Music/a.mp4'), { ...track('b', 'Music/b.mp4'), artist: 'Lead & Second feat. Guest', title: 'Song (feat. Guest)' }, track('c', 'Music/c.mp4')]
    const { store, mock } = makeStore({ tracks: songs, indexEntries: songs.map((song) => asset(song.file)) })
    await vi.waitFor(() => expect(store.getSnapshot().tracks).toHaveLength(3))
    store.playQueue(songs, 1, 'playlist-runtime')
    await store.flushPersistence()
    expect(media.get(mock)!.getSnapshot()?.descriptor).toMatchObject({
      artists: ['Lead', 'Second'], feat: ['Guest'], path: 'Music/b.mp4'
    })
    expect(mock.playbackSources.size).toBe(0)
    store.next()
    await store.flushPersistence()
    expect(media.get(mock)!.getSnapshot()?.descriptor).toMatchObject({ path: 'Music/c.mp4' })
    expect(store.getSnapshot().currentPlaylistId).toBe('playlist-runtime')
    store.dispose()
  })

  it('restores a host session paused and resumes before its saved up-next queue', async () => {
    const songs = [track('a', 'Music/a.mp4'), track('b', 'Music/b.mp4'), track('c', 'Music/c.mp4')]
    const mock = createMockValleyApi({ tracks: songs, queue: [{ songId: 'c' }], indexEntries: songs.map(song => asset(song.file)) })
    await media.get(mock)!.player.load({ key: 'b', providerId: 'music', sourceId: 'music', kind: 'video', path: songs[1].file, title: 'b', artists: [], feat: [] }, { position: 47, autoplay: false })
    const store = new MusicStore(mock.api)
    try {
      await vi.waitFor(() => expect(store.getSnapshot().loading).toBe(false))
      expect(store.getSnapshot()).toMatchObject({ currentTrack: { id: 'b' }, currentTime: 47, isPlaying: false })
      store.resumeLast()
      await store.flushPersistence()
      expect(store.getSnapshot()).toMatchObject({ currentTrack: { id: 'b' }, currentTime: 47, isPlaying: true })
      expect(store.getSnapshot().upNext.map(song => song.id)).toEqual(['c'])
    } finally { await store.dispose() }
  })

  it('records play events and claims playback when a track starts', async () => {
    const song = track('a', 'Music/a.mp4')
    const { store, mock } = makeStore({
      tracks: [song],
      indexEntries: [asset('Music/a.mp4')]
    })
    await vi.waitFor(() => expect(store.getSnapshot().tracks).toHaveLength(1))

    store.playTrack(store.getSnapshot().tracks[0])

    await store.flushPersistence()
    await vi.waitFor(() => {
      expect(historyOf(mock)).toHaveLength(1)
    })
    const entry = historyOf(mock)[0]
    expect(entry.songId).toBe('a')
    expect(store.getSnapshot().currentTrack?.id).toBe('a')

    store.dispose()
  })

  it('surfaces a failed media start as a play error', async () => {
    const song = track('a', 'Music/a.mp4')
    const { store, mock } = makeStore({
      tracks: [song],
      indexEntries: [asset('Music/a.mp4')]
    })
    await vi.waitFor(() => expect(store.getSnapshot().tracks).toHaveLength(1))
    vi.mocked(media.get(mock)!.player.load).mockRejectedValueOnce(new Error('Media failed'))
    store.playTrack(store.getSnapshot().tracks[0])

    await store.flushPersistence()
    await vi.waitFor(() => {
      expect(store.getSnapshot().playError).toBe(
        'Media failed'
      )
    })
    store.dispose()
  })

  it('starts immediately and preloads the next queued file without reading full audio bytes', async () => {
    const songs = [track('a', 'Music/a.mp4'), track('b', 'Music/b.mp4')]
    const { store, mock } = makeStore({ tracks: songs, indexEntries: songs.map(song => asset(song.file)) })
    await vi.waitFor(() => expect(store.getSnapshot().tracks).toHaveLength(2))
    store.playQueue(store.getSnapshot().tracks, 0)
    await store.flushPersistence()
    await vi.waitFor(() => expect(store.getSnapshot().buffering).toBe(false))
    expect(FakeAudio.instances).toHaveLength(0)
    expect(media.get(mock)!.player.load).toHaveBeenCalledWith(expect.objectContaining({ path: 'Music/a.mp4' }), { position: 0, autoplay: true })
    expect(media.get(mock)!.player.prepareNext).toHaveBeenCalledWith(expect.objectContaining({ path: 'Music/b.mp4' }))
    expect(audioRead).not.toHaveBeenCalled()
    expect(globalThis.fetch).not.toHaveBeenCalled()
    store.dispose()
  })

  it('advances the queue by promoting the preloaded next stream', async () => {
    const a = track('a', 'Music/a.mp4')
    const b = track('b', 'Music/b.mp4')
    const { store, mock } = makeStore({
      tracks: [a, b],
      indexEntries: [asset('Music/a.mp4'), asset('Music/b.mp4')]
    })
    await vi.waitFor(() => expect(store.getSnapshot().tracks).toHaveLength(2))

    store.playQueue(store.getSnapshot().tracks, 0)

    await store.flushPersistence()
    media.get(mock)!.observe({ status: 'ended' })
    await store.flushPersistence()
    await vi.waitFor(() => expect(store.getSnapshot().currentTrack?.id).toBe('b'))
    expect(store.getSnapshot().isPlaying).toBe(true)
    await vi.waitFor(() => {
      expect(historyOf(mock)).toHaveLength(2)
    })
    store.dispose()
  })

  it('persists playlist covers by filename and resolves them against the index', async () => {
    const { store } = makeStore({
      playlists: [{ id: 'p1', name: 'Sommer', songIds: [] }],
      indexEntries: [asset('Pictures/strand.jpg')]
    })
    await vi.waitFor(() => expect(store.getSnapshot().playlists).toHaveLength(1))

    await store.setPlaylistCover('p1', 'strand.jpg')
    await vi.waitFor(() => {
      expect(store.getSnapshot().playlists[0].cover).toBe('strand.jpg')
      expect(store.getSnapshot().playlistCovers['p1']).toBe('Pictures/strand.jpg')
    })

    // A full vault path (as the picker now stores) round-trips verbatim.
    await store.setPlaylistCover('p1', 'Pictures/strand.jpg')
    await vi.waitFor(() => {
      expect(store.getSnapshot().playlists[0].cover).toBe('Pictures/strand.jpg')
      expect(store.getSnapshot().playlistCovers['p1']).toBe('Pictures/strand.jpg')
    })

    await store.setPlaylistCover('p1', null)
    await vi.waitFor(() => {
      expect(store.getSnapshot().playlists[0].cover).toBeUndefined()
    })
    store.dispose()
  })

  it('creates, renames and deletes playlists through relational datasets', async () => {
    const { store, mock } = makeStore({ indexEntries: [asset('Music/a.mp4')] })
    await vi.waitFor(() => expect(store.getSnapshot().loading).toBe(false))

    const id = await store.createPlaylist('Canopy Trail')
    expect(id).toBe('canopy-trail')
    await vi.waitFor(() => expect(store.getSnapshot().playlists).toHaveLength(1))

    await store.renamePlaylist('canopy-trail', 'Canopy Trail 2026')
    expect(playlistsOf(mock)[0].name).toBe('Canopy Trail 2026')

    await store.deletePlaylist('canopy-trail')
    await vi.waitFor(() => expect(store.getSnapshot().playlists).toHaveLength(0))

    // Deleting a playlist is undoable: ⌘Z restores it with name and members.
    const action = mock.undoActions.at(-1)!
    expect(action.label).toContain('Canopy Trail 2026')
    await action.undo()
    await vi.waitFor(() => expect(store.getSnapshot().playlists).toHaveLength(1))
    expect(store.getSnapshot().playlists[0].name).toBe('Canopy Trail 2026')

    await action.redo!()
    await vi.waitFor(() => expect(store.getSnapshot().playlists).toHaveLength(0))
    store.dispose()
  })

  it('creates a persistent playlist with its initial song in one write', async () => {
    const existing = track('a', 'Music/a.mp4')
    const { store, mock } = makeStore({
      tracks: [existing],
      indexEntries: [asset(existing.file)]
    })
    await vi.waitFor(() => expect(store.getSnapshot().loading).toBe(false))

    const id = await store.createPlaylist('Canopy Song', ['a', 'a', 'missing'])

    expect(id).toBe('canopy-song')
    expect(playlistsOf(mock)).toEqual([
      { id: 'canopy-song', name: 'Canopy Song', songIds: ['a'] }
    ])
    await store.load()
    expect(store.getSnapshot().playlistTracks['canopy-song']?.map((song) => song.id)).toEqual(['a'])
    store.dispose()
  })

  it('never adds the same song to a playlist twice', async () => {
    const existing = track('a', 'Music/a.mp4')
    const { store } = makeStore({
      tracks: [existing],
      indexEntries: [asset('Music/a.mp4')]
    })
    await vi.waitFor(() => expect(store.getSnapshot().loading).toBe(false))

    await store.createPlaylist('Mix')
    await vi.waitFor(() => expect(store.getSnapshot().playlists).toHaveLength(1))

    await store.addToPlaylist('mix', 'a')
    await vi.waitFor(() => expect(store.getSnapshot().playlists[0].songIds).toEqual(['a']))
    await store.addToPlaylist('mix', 'a')
    expect(store.getSnapshot().playlists[0].songIds).toEqual(['a'])
    store.dispose()
  })

  it('queues multiple tracks next without reversing their order', async () => {
    const songs = ['a', 'b', 'c', 'd'].map((id) => track(id, `Music/${id}.mp4`))
    const { store } = makeStore({
      tracks: songs,
      indexEntries: songs.map((song) => asset(song.file))
    })
    await vi.waitFor(() => expect(store.getSnapshot().tracks).toHaveLength(4))

    const tracks = store.getSnapshot().tracks
    store.playQueue(tracks.slice(0, 2), 0)
    await store.flushPersistence()
    store.addTracksToQueue(tracks.slice(2), 'next')
    await store.flushPersistence()
    expect(store.getSnapshot().upNext.map((t) => t.id)).toEqual(['c', 'd', 'b'])
    store.dispose()
  })

  it('exposes selected playlist actions to the command palette', async () => {
    const songs = ['a', 'b', 'c'].map((id) => track(id, `Music/${id}.mp4`))
    const mock = createMockValleyApi({
      settings: { musicPath: 'Music' },
      tracks: songs,
      playlists: [{ id: 'mix', name: 'Mix', songIds: ['b', 'c'] }],
      indexEntries: songs.map((song) => asset(song.file))
    })
    const store = createRuntimeStore(mock)
    const off = registerMusicCommands(mock.api)
    try {
      await vi.waitFor(() => expect(store.getSnapshot().playlists).toHaveLength(1))
      const paletteIds = [
        'selected-playlist-play',
        'selected-playlist-shuffle',
        'selected-playlist-next',
        'selected-playlist-last'
      ]
      for (const id of paletteIds) {
        expect(mock.commands.find((command) => command.id === id)?.paletteSafe).not.toBe(false)
      }

      store.setFocusedPlaylist('mix')
      const next = await mock.api.commands.execute('music:selected-playlist-next')
      expect(next.ok).toBe(true)
      expect(store.getSnapshot().upNext.map((t) => t.id)).toEqual(['b', 'c'])

      const play = await mock.api.commands.execute('music:selected-playlist-play')
      expect(play.ok).toBe(true)
      expect(store.getSnapshot().currentTrack?.id).toBe('b')
      expect(store.getSnapshot().currentPlaylistId).toBe('mix')

      const last = await mock.api.commands.execute('music:selected-playlist-last')
      expect(last.ok).toBe(true)
      expect(store.getSnapshot().upNext.map((t) => t.id)).toEqual(['c', 'b', 'c'])

      const shuffle = await mock.api.commands.execute('music:selected-playlist-shuffle')
      expect(shuffle.ok).toBe(true)
      expect(store.getSnapshot().shuffle).toBe(true)
      expect(store.getSnapshot().currentPlaylistId).toBe('mix')
    } finally {
      off()
      disposeStore(mock.api, store)
    }
  })

  it('waits for each repeat change before requesting the next mode', async () => {
    const mock = createMockValleyApi()
    const store = createRuntimeStore(mock)
    const off = registerMusicCommands(mock.api)
    const release: (() => void)[] = []
    const call = mock.api.backend.call.bind(mock.api.backend)
    const cycle = store.cycleRepeat.bind(store)
    let cycles = 0
    vi.spyOn(store, 'cycleRepeat').mockImplementation(() => {
      if (++cycles > 3) throw new Error('Repeat command did not wait for the backend')
      cycle()
    })
    mock.api.backend.call = vi.fn(async (method, payload) => {
      if (method === 'playback.action' && (payload as { type?: string })?.type === 'repeat') await new Promise<void>(resolve => release.push(resolve))
      return call(method, payload)
    }) as typeof mock.api.backend.call
    try {
      await vi.waitFor(() => expect(store.getSnapshot().loading).toBe(false))
      expect(mock.commands.find(command => command.id === 'repeat')?.sideEffect).toBe('execute')
      let settled = false
      const result = mock.api.commands.execute('music:repeat', { mode: 'one' }).then(value => { settled = true; return value })
      await vi.waitFor(() => expect(release).toHaveLength(1))
      expect(cycles).toBe(1)
      expect(settled).toBe(false)
      release[0]()
      await vi.waitFor(() => expect(release).toHaveLength(2))
      expect(cycles).toBe(2)
      expect(store.getSnapshot().repeatMode).toBe('all')
      expect(settled).toBe(false)
      release[1]()
      expect(await result).toMatchObject({ ok: true, value: { mode: 'one' } })
      expect(store.getSnapshot().repeatMode).toBe('one')
      expect(mock.api.settings.get().player).toMatchObject({ repeat: 'one' })
      expect(await mock.api.commands.execute('music:repeat', { mode: 'one' })).toMatchObject({ ok: true, value: { mode: 'one' } })
      expect(cycles).toBe(2)
    } finally {
      release.forEach(resolve => resolve())
      off()
      disposeStore(mock.api, store)
    }
  })

  it('does not repeat a mode change after losing its backend acknowledgement', async () => {
    const mock = createMockValleyApi()
    const store = createRuntimeStore(mock)
    const off = registerMusicCommands(mock.api)
    const call = mock.api.backend.call.bind(mock.api.backend)
    let cycles = 0
    mock.api.backend.call = vi.fn(async (method, payload) => {
      if (method === 'playback.action' && (payload as { type?: string })?.type === 'repeat') {
        cycles++
        await call(method, payload)
        throw new Error('Backend acknowledgement lost')
      }
      return call(method, payload)
    }) as typeof mock.api.backend.call
    try {
      await vi.waitFor(() => expect(store.getSnapshot().loading).toBe(false))
      const result = await mock.api.commands.execute('music:repeat', { mode: 'one' })
      expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining('unknown') } })
      expect(cycles).toBe(1)
      expect(store.getSnapshot().repeatMode).toBe('all')
    } finally {
      off()
      disposeStore(mock.api, store)
    }
  })

  it('opens a media file by path, and refuses one the library does not know', async () => {
    const songs = ['a', 'b'].map((id) => track(id, `Music/${id}.mp4`))
    const mock = createMockValleyApi({
      settings: { musicPath: 'Music' },
      tracks: songs,
      indexEntries: songs.map((song) => asset(song.file))
    })
    const store = createRuntimeStore(mock)
    const off = registerMusicCommands(mock.api)
    try {
      await vi.waitFor(() => expect(store.getSnapshot().tracks).toHaveLength(2))

      const opened = await mock.api.commands.execute('music:open-media', { path: 'Music/b.mp4' })
      expect(opened.ok).toBe(true)
      expect(store.getSnapshot().currentTrack?.id).toBe('b')
      expect(store.getSnapshot().pageView).toMatchObject({ reveal: 'b' })

      // A file outside the library is refused — that is what lets the host fall
      // back to the built-in media player instead of opening an empty Music tab.
      const missing = await mock.api.commands.execute('music:open-media', { path: 'Elsewhere/x.mp3' })
      expect(missing.ok).toBe(false)
      expect(store.getSnapshot().currentTrack?.id).toBe('b')
    } finally {
      off()
      disposeStore(mock.api, store)
    }
  })

  it('queues playlist actions by name through the command bus', async () => {
    const songs = ['a', 'b', 'c'].map((id) => track(id, `Music/${id}.mp4`))
    const mock = createMockValleyApi({
      settings: { musicPath: 'Music' },
      tracks: songs,
      playlists: [{ id: 'mix', name: 'Canopy Mix', songIds: ['b', 'c'] }],
      indexEntries: songs.map((song) => asset(song.file))
    })
    const store = createRuntimeStore(mock)
    const off = registerMusicCommands(mock.api)
    try {
      await vi.waitFor(() => expect(store.getSnapshot().playlists).toHaveLength(1))
      const first = store.getSnapshot().tracks[0]
      expect(first).toBeDefined()
      store.playQueue([first!], 0, null)
      await store.flushPersistence()
      const next = await mock.api.commands.execute('music:playlist-next', { name: 'canopy' })
      expect(next.ok).toBe(true)
      expect(store.getSnapshot().upNext.map((t) => t.id)).toEqual(['b', 'c'])

      const last = await mock.api.commands.execute('music:playlist-last', { name: 'canopy' })
      expect(last.ok).toBe(true)
      expect(store.getSnapshot().upNext.map((t) => t.id)).toEqual(['b', 'c', 'b', 'c'])

      const shuffle = await mock.api.commands.execute('music:playlist-shuffle', { name: 'canopy' })
      expect(shuffle.ok).toBe(true)
      expect(store.getSnapshot().shuffle).toBe(true)
      expect(store.getSnapshot().currentPlaylistId).toBe('mix')
    } finally {
      off()
      disposeStore(mock.api, store)
    }
  })

  it('requires an explicit track or queue position when names or queued IDs are ambiguous', async () => {
    const songs = [
      { ...track('a', 'Music/a.mp4'), title: 'Shared title' },
      { ...track('b', 'Music/b.mp4'), title: 'Shared title' },
      track('c', 'Music/c.mp4')
    ]
    const mock = createMockValleyApi({ tracks: songs, indexEntries: songs.map((song) => asset(song.file)) })
    const store = createRuntimeStore(mock), off = registerMusicCommands(mock.api)
    try {
      await vi.waitFor(() => expect(store.getSnapshot().tracks).toHaveLength(3))
      expect(await mock.api.commands.execute('music:play', { title: 'Shared title' })).toMatchObject({ ok: false, error: { message: expect.stringContaining('a, b') } })
      expect(store.getSnapshot().currentTrack).toBeNull()
      expect(await mock.api.commands.execute('music:play', { title: 'Music/b.mp4', exact: true })).toMatchObject({ ok: true, value: { played: true, track: { id: 'b' }, alternatives: [] } })
      expect(await mock.api.commands.execute('music:play', { title: 'a' })).toMatchObject({ ok: true, value: { played: true, track: { id: 'a' } } })

      store.playQueue([songs[2], songs[0], songs[1], songs[0]], 0)

      await store.flushPersistence()
      expect(await mock.api.commands.execute('music:remove-from-queue', { title: 'Shared title' })).toMatchObject({ ok: false, error: { message: expect.stringContaining('1 [a], 2 [b], 3 [a]') } })
      expect(await mock.api.commands.execute('music:remove-from-queue', { title: 'a' })).toMatchObject({ ok: false, error: { message: expect.stringContaining('1 [a], 3 [a]') } })
      expect(store.getSnapshot().upNext.map((song) => song.id)).toEqual(['a', 'b', 'a'])
      expect(await mock.api.commands.execute('music:remove-from-queue', { title: 'b' })).toMatchObject({ ok: true, value: { track: { id: 'b' }, position: 2 } })
      const remove = mock.commands.find((command) => command.id === 'remove-from-queue')!
      const cliInput = remove.input!.fromCli!([], { index: '2' })
      expect(await mock.api.commands.execute('music:remove-from-queue', cliInput)).toMatchObject({ ok: true, value: { track: { id: 'a' }, position: 2 } })
      expect(await mock.api.commands.execute('music:remove-from-queue', { index: 0 })).toMatchObject({ ok: false })
      expect(store.getSnapshot().upNext.map((song) => song.id)).toEqual(['a'])
    } finally { off(); disposeStore(mock.api, store) }
  })

  it('revises only the affected music records and ignores playback time and unrelated edits', async () => {
    const songs = ['a', 'b', 'c'].map((id) => track(id, `Music/${id}.mp4`))
    const mock = createMockValleyApi({
      tracks: songs,
      playlists: [{ id: 'first', name: 'First', songIds: ['a', 'b'] }, { id: 'other', name: 'Other', songIds: ['c'] }],
      indexEntries: songs.map((song) => asset(song.file))
    })
    const store = createRuntimeStore(mock), off = registerMusicCommands(mock.api)
    const revision = async (id: string, input: unknown = undefined): Promise<string> => JSON.stringify(await mock.commands.find((command) => command.id === id)!.revision!(input))
    try {
      await vi.waitFor(() => expect(store.getSnapshot().tracks).toHaveLength(3))
      store.playQueue(songs, 0)
      await store.flushPersistence()
      const favorite = await revision('favorite', { title: 'a', exact: false })
      const rename = await revision('rename-playlist', { name: 'first' })
      const clear = await revision('clear-playlist', { name: 'first' })
      const cover = await revision('set-cover', { name: 'first' })
      const remove = await revision('track-delete', { id: 'a' })
      const append = await revision('play-last', { title: 'b', exact: false })
      const playback = await revision('skip')
      store.seek(42)
      await store.flushPersistence()
      await store.renamePlaylist('other', 'Other renamed')
      await store.toggleFavorite('c')
      expect(await revision('favorite', { title: 'a', exact: false })).toBe(favorite)
      expect(await revision('rename-playlist', { name: 'first' })).toBe(rename)
      expect(await revision('clear-playlist', { name: 'first' })).toBe(clear)
      expect(await revision('track-delete', { id: 'a' })).toBe(remove)
      expect(await revision('skip')).toBe(playback)
      store.addToQueue(songs[2])
      await store.flushPersistence()
      expect(await revision('play-last', { title: 'b', exact: false })).toBe(append)
      await store.addToPlaylist('first', 'c')
      expect(await revision('clear-playlist', { name: 'first' })).not.toBe(clear)
      expect(await revision('rename-playlist', { name: 'first' })).toBe(rename)
      expect(await revision('set-cover', { name: 'first' })).toBe(cover)
      expect(await revision('track-delete', { id: 'a' })).not.toBe(remove)
      await store.toggleFavorite('a')
      expect(await revision('favorite', { title: 'a', exact: false })).not.toBe(favorite)
      await store.renamePlaylist('first', 'First renamed')
      expect(await revision('rename-playlist', { name: 'first' })).not.toBe(rename)
    } finally { off(); disposeStore(mock.api, store) }
  })

  it('previews persistent mutations without writing and classifies volume as an execution', async () => {
    const songs = ['a', 'b'].map((id) => track(id, `Music/${id}.mp4`))
    const mock = createMockValleyApi({ tracks: songs, playlists: [{ id: 'mix', name: 'Mix', songIds: ['a'] }], indexEntries: songs.map((song) => asset(song.file)) })
    const store = createRuntimeStore(mock), off = registerMusicCommands(mock.api)
    try {
      await vi.waitFor(() => expect(store.getSnapshot().tracks).toHaveLength(2))
      const snapshot = store.getSnapshot(), datasets = structuredClone([...mock.datasets])
      const preview = (id: string, input: unknown): unknown => mock.commands.find((command) => command.id === id)!.preview!(input)
      expect(preview('play', { title: 'a', exact: false })).toMatchObject({ action: 'play', track: { id: 'a' } })
      expect(preview('favorite', { title: 'a', exact: false, on: true })).toMatchObject({ previous: false, favorite: true })
      expect(preview('track-delete', { id: 'a' })).toMatchObject({ track: { id: 'a' }, playlists: [{ id: 'mix' }] })
      expect(preview('clear-playlist', { name: 'mix' })).toMatchObject({ songIds: ['a'] })
      expect(preview('volume', { level: 37 })).toMatchObject({ volume: 37 })
      expect(store.getSnapshot()).toBe(snapshot)
      expect([...mock.datasets]).toEqual(datasets)
      expect(mock.commands.find((command) => command.id === 'volume')!.sideEffect).toBe('execute')
      expect(await mock.api.commands.execute('music:volume', { level: 37 })).toMatchObject({ ok: true, value: { volume: 37 } })
      expect(store.getSnapshot().volume).toBe(0.37)
    } finally { off(); disposeStore(mock.api, store) }
  })

  it('queues, reorders and clears single tracks through the new queue commands', async () => {
    const songs = ['a', 'b', 'c', 'd'].map((id) => track(id, `Music/${id}.mp4`))
    const mock = createMockValleyApi({
      settings: { musicPath: 'Music' },
      tracks: songs,
      indexEntries: songs.map((song) => asset(song.file))
    })
    const store = createRuntimeStore(mock)
    const off = registerMusicCommands(mock.api)
    try {
      await vi.waitFor(() => expect(store.getSnapshot().tracks).toHaveLength(4))
      store.playQueue([store.getSnapshot().tracks[0]!], 0, null)
      await store.flushPersistence()
      // play-last appends; play-next jumps to the front of up-next.
      expect((await mock.api.commands.execute('music:play-last', { title: 'b' })).ok).toBe(true)
      expect((await mock.api.commands.execute('music:play-last', { title: 'c' })).ok).toBe(true)
      expect((await mock.api.commands.execute('music:play-next', { title: 'd' })).ok).toBe(true)
      expect(store.getSnapshot().upNext.map((t) => t.id)).toEqual(['d', 'b', 'c'])

      // remove by title, then by 1-based index.
      expect((await mock.api.commands.execute('music:remove-from-queue', { title: 'b' })).ok).toBe(true)
      expect(store.getSnapshot().upNext.map((t) => t.id)).toEqual(['d', 'c'])
      expect((await mock.api.commands.execute('music:remove-from-queue', { index: 1 })).ok).toBe(true)
      expect(store.getSnapshot().upNext.map((t) => t.id)).toEqual(['c'])

      const cleared = await mock.api.commands.execute('music:clear-queue')
      expect(cleared.ok).toBe(true)
      if (cleared.ok) expect((cleared.value as { removed: number }).removed).toBe(1)
      expect(store.getSnapshot().upNext).toHaveLength(0)
    } finally {
      off()
      disposeStore(mock.api, store)
    }
  })

  it('sets a playlist cover and toggles a track favorite with reverts', async () => {
    const songs = ['a', 'b'].map((id) => track(id, `Music/${id}.mp4`))
    const mock = createMockValleyApi({
      settings: { musicPath: 'Music' },
      tracks: songs,
      playlists: [{ id: 'mix', name: 'Mix', songIds: ['a'] }],
      indexEntries: songs.map((song) => asset(song.file))
    })
    const store = createRuntimeStore(mock)
    const off = registerMusicCommands(mock.api)
    try {
      await vi.waitFor(() => expect(store.getSnapshot().tracks).toHaveLength(2))

      const cover = await mock.api.commands.execute('music:set-cover', { name: 'mix', cover: 'art.png' })
      expect(cover.ok).toBe(true)
      await vi.waitFor(() => expect(store.getSnapshot().playlists.find((p) => p.id === 'mix')?.cover).toBe('art.png'))

      // favorite explicitly on, then idempotent (no double-toggle), then off.
      expect((await mock.api.commands.execute('music:favorite', { title: 'a', on: true })).ok).toBe(true)
      await vi.waitFor(() => expect(store.getSnapshot().favorites.has('a')).toBe(true))
      expect((await mock.api.commands.execute('music:favorite', { title: 'a', on: true })).ok).toBe(true)
      expect(store.getSnapshot().favorites.has('a')).toBe(true)
      expect((await mock.api.commands.execute('music:favorite', { title: 'a' })).ok).toBe(true)
      await vi.waitFor(() => expect(store.getSnapshot().favorites.has('a')).toBe(false))
    } finally {
      off()
      disposeStore(mock.api, store)
    }
  })

  it('searches songs artists and playlists through music commands', async () => {
    const songs = [
      { ...track('a', 'Music/a.mp4'), title: 'Forest Echo', artist: 'Chanterelle Ensemble' },
      { ...track('b', 'Music/b.mp4'), title: 'Fungi Song', artist: 'Chanterelle Ensemble' },
      { ...track('c', 'Music/c.mp4'), title: 'Seasons', artist: 'Fern Chorus' }
    ]
    const mock = createMockValleyApi({
      settings: { musicPath: 'Music' },
      tracks: songs,
      playlists: [
        { id: 'focus', name: 'Canopy', songIds: ['a'] },
        { id: 'fungi', name: 'Fungi', songIds: ['b'] }
      ],
      indexEntries: songs.map((song) => asset(song.file))
    })
    const store = createRuntimeStore(mock)
    const off = registerMusicCommands(mock.api)
    try {
      await vi.waitFor(() => expect(store.getSnapshot().tracks).toHaveLength(3))

      const search = await mock.api.commands.execute('music:search', { query: 'Chanterelle' })
      expect(search.ok).toBe(true)
      if (search.ok) {
        const value = search.value as { tracks: Track[]; artists: { artist: string; count: number }[]; playlists: Playlist[] }
        expect(value.tracks.map((t) => t.title)).toEqual(['Forest Echo', 'Fungi Song'])
        expect(value.artists).toEqual([{ artist: 'Chanterelle Ensemble', count: 2 }])
      }

      const artists = await mock.api.commands.execute('music:artists')
      expect(artists.ok).toBe(true)
      if (artists.ok) expect((artists.value as { artist: string }[]).map((a) => a.artist)).toEqual(['Chanterelle Ensemble', 'Fern Chorus'])

      const songsResult = await mock.api.commands.execute('music:songs', { search: 'season' })
      expect(songsResult.ok).toBe(true)
      if (songsResult.ok) expect((songsResult.value as Track[]).map((t) => t.title)).toEqual(['Seasons'])

      const playlists = await mock.api.commands.execute('music:playlists', { search: 'fungi' })
      expect(playlists.ok).toBe(true)
      if (playlists.ok) expect((playlists.value as Playlist[]).map((pl) => pl.name)).toEqual(['Fungi'])
    } finally {
      off()
      disposeStore(mock.api, store)
    }
  })

  it('mutates playlists through write commands with undo reverts', async () => {
    const songs = ['a', 'b', 'c'].map((id) => track(id, `Music/${id}.mp4`))
    const mock = createMockValleyApi({
      settings: { musicPath: 'Music' },
      tracks: songs,
      playlists: [{ id: 'mix', name: 'Mix', songIds: ['a', 'b'] }],
      indexEntries: songs.map((song) => asset(song.file))
    })
    const store = createRuntimeStore(mock)
    const off = registerMusicCommands(mock.api)
    try {
      await vi.waitFor(() => expect(store.getSnapshot().playlists).toHaveLength(1))

      const create = await mock.api.commands.execute('music:create-playlist', { name: 'Canopy' })
      expect(create.ok).toBe(true)
      await vi.waitFor(() => expect(store.getSnapshot().playlists.some((pl) => pl.name === 'Canopy')).toBe(true))
      await mock.busUndo.at(-1)!.undo()
      await vi.waitFor(() => expect(store.getSnapshot().playlists.some((pl) => pl.name === 'Canopy')).toBe(false))

      const rename = await mock.api.commands.execute('music:rename-playlist', { name: 'Mix', newName: 'Canopy Mix' })
      expect(rename.ok).toBe(true)
      await vi.waitFor(() => expect(store.getSnapshot().playlists[0].name).toBe('Canopy Mix'))
      await mock.busUndo.at(-1)!.undo()
      await vi.waitFor(() => expect(store.getSnapshot().playlists[0].name).toBe('Mix'))

      const add = await mock.api.commands.execute('music:add-to-playlist', { playlist: 'Mix', query: 'c' })
      expect(add.ok).toBe(true)
      await vi.waitFor(() => expect(store.getSnapshot().playlists[0].songIds).toEqual(['a', 'b', 'c']))
      await mock.busUndo.at(-1)!.undo()
      await vi.waitFor(() => expect(store.getSnapshot().playlists[0].songIds).toEqual(['a', 'b']))

      const remove = await mock.api.commands.execute('music:remove-from-playlist', { playlist: 'Mix', query: 'a' })
      expect(remove.ok).toBe(true)
      await vi.waitFor(() => expect(store.getSnapshot().playlists[0].songIds).toEqual(['b']))
      await mock.busUndo.at(-1)!.undo()
      await vi.waitFor(() => expect(store.getSnapshot().playlists[0].songIds).toEqual(['a', 'b']))

      const clear = await mock.api.commands.execute('music:clear-playlist', { name: 'Mix' })
      expect(clear.ok).toBe(true)
      await vi.waitFor(() => expect(store.getSnapshot().playlists[0].songIds).toEqual([]))
      await mock.busUndo.at(-1)!.undo()
      await vi.waitFor(() => expect(store.getSnapshot().playlists[0].songIds).toEqual(['a', 'b']))

      const del = await mock.api.commands.execute('music:delete-playlist', { name: 'Mix' })
      expect(del.ok).toBe(true)
      await vi.waitFor(() => expect(store.getSnapshot().playlists).toHaveLength(0))
      await mock.busUndo.at(-1)!.undo()
      await vi.waitFor(() => expect(store.getSnapshot().playlists[0].name).toBe('Mix'))
    } finally {
      off()
      disposeStore(mock.api, store)
    }
  })
})

describe('MusicStore page navigation', () => {
  let restoreAudio: () => void
  beforeEach(() => {
    restoreAudio = installFakeAudio()
  })
  afterEach(() => {
    restoreAudio()
  })

  function makeNavStore(): { store: MusicStore; mock: ReturnType<typeof createMockValleyApi> } {
    const songs = ['a', 'b'].map((id) => track(id, `Music/${id}.mp4`))
    const mock = createMockValleyApi({
      settings: { musicPath: 'Music' },
      tracks: songs,
      playlists: [{ id: 'mix', name: 'Mix', songIds: ['a'] }],
      indexEntries: songs.map((song) => asset(song.file))
    })
    return { store: new MusicStore(mock.api), mock }
  }

  it('showPlaylist opens the Music tab and shows the playlist detail', async () => {
    const { store, mock } = makeNavStore()
    await vi.waitFor(() => expect(store.getSnapshot().playlists).toHaveLength(1))
    const before = store.getSnapshot().pageViewNonce

    store.showPlaylist('mix')
    expect(store.getSnapshot().pageView).toEqual({ mode: 'playlist', id: 'mix' })
    expect(store.getSnapshot().pageViewNonce).toBe(before + 1)
    expect(mock.api.workspace.openMainTab).toHaveBeenCalled()
    store.dispose()
  })

  it('revealSong routes into the playlist that contains the song; re-revealing bumps the nonce', async () => {
    const { store, mock } = makeNavStore()
    await vi.waitFor(() => expect(store.getSnapshot().tracks).toHaveLength(2))

    // 'a' is in playlist 'mix' → reveal it there, carrying the song id to flash.
    store.revealSong('a')
    expect(store.getSnapshot().pageView).toEqual({ mode: 'playlist', id: 'mix', reveal: 'a' })
    const once = store.getSnapshot().pageViewNonce
    expect(mock.api.workspace.openMainTab).toHaveBeenCalledTimes(1)

    // Same target again still notifies (nonce++) so the page re-runs the scroll.
    store.revealSong('a')
    expect(store.getSnapshot().pageViewNonce).toBe(once + 1)
    expect(mock.api.workspace.openMainTab).toHaveBeenCalledTimes(2)
    store.dispose()
  })

  it('revealSong routes to the artist page when the song is in no playlist', async () => {
    const { store } = makeNavStore()
    await vi.waitFor(() => expect(store.getSnapshot().artists.length).toBeGreaterThan(0))
    const artist = store.getSnapshot().artists[0]

    // 'b' is in no playlist but is credited to artist 'a' → reveal on the artist page.
    store.revealSong('b')
    expect(store.getSnapshot().pageView).toEqual({ mode: 'artist', id: artist.id, reveal: 'b' })
    store.dispose()
  })

  it('revealSong falls back to the all-songs list when there is no playlist or artist', async () => {
    const songs = [{ id: 'x', title: 'X', artist: '', file: 'Music/x.mp4' }] as Track[]
    const mock = createMockValleyApi({
      settings: { musicPath: 'Music' },
      tracks: songs,
      indexEntries: songs.map((s) => asset(s.file))
    })
    const store = new MusicStore(mock.api)
    try {
      await vi.waitFor(() => expect(store.getSnapshot().tracks).toHaveLength(1))
      store.revealSong('x')
      expect(store.getSnapshot().pageView).toEqual({ mode: 'song', id: 'x' })
    } finally {
      store.dispose()
    }
  })

  it('showHome returns to the home view without opening a tab', async () => {
    const { store, mock } = makeNavStore()
    await vi.waitFor(() => expect(store.getSnapshot().playlists).toHaveLength(1))
    store.showPlaylist('mix')
    ;(mock.api.workspace.openMainTab as ReturnType<typeof vi.fn>).mockClear()

    store.showHome()
    expect(store.getSnapshot().pageView).toEqual({ mode: 'home' })
    expect(mock.api.workspace.openMainTab).not.toHaveBeenCalled()
    store.dispose()
  })

  it('walks page destinations through the shared main-page navigation controller', async () => {
    const { store } = makeNavStore()
    await vi.waitFor(() => expect(store.getSnapshot().playlists).toHaveLength(1))

    store.showPlaylist('mix')
    expect(store.getSnapshot().canGoBack).toBe(true)
    store.goPageBack()
    expect(store.getSnapshot().pageView).toEqual({ mode: 'home' })
    expect(store.getSnapshot().canGoForward).toBe(true)
    store.goPageForward()
    expect(store.getSnapshot().pageView).toEqual({ mode: 'playlist', id: 'mix' })
    store.dispose()
  })

  it('round-trips linked page, reveal target, and search without playback state', async () => {
    const { store } = makeNavStore()
    await vi.waitFor(() => expect(store.getSnapshot().playlists).toHaveLength(1))
    store.revealSong('a')
    store.setPageSearch('canopy')

    const state = store.buildLinkState()
    expect(state).toEqual({
      v: 1,
      view: { mode: 'playlist', id: 'mix', reveal: 'a' },
      searchQuery: 'canopy'
    })
    expect(state).not.toHaveProperty('currentTime')

    store.showHome()
    store.setPageSearch('')
    expect(store.applyLinkState(state)).toBe(true)
    expect(store.getSnapshot().pageView).toEqual({ mode: 'playlist', id: 'mix', reveal: 'a' })
    expect(store.getSnapshot().pageSearch).toBe('canopy')
    expect(store.applyLinkState({ ...state, v: 2 })).toBe(false)
    store.dispose()
  })

  it('restores all three workspace view surfaces while playlist, queue and playback stay live', async () => {
    const { store } = makeNavStore()
    await vi.waitFor(() => expect(store.getSnapshot().playlists).toHaveLength(1))

    store.showPlaylist('mix')
    store.setPageSearch('canopy')
    store.setLeftPanelSearch('forest')
    store.setLeftPanelSection('songs', true)
    store.setLeftPanelSection('playlists', false)
    store.setRightQueueOpen(false)
    store.setRightHistoryOpen(true)
    store.setRightPanelScrollTop(184)
    const saved = {
      main: store.captureMainWorkspaceView(),
      left: store.captureLeftWorkspaceView(),
      right: store.captureRightWorkspaceView()
    }
    const encoded = JSON.stringify(saved)
    for (const liveField of ['songIds', 'currentTrack', 'currentTime', 'upNext']) {
      expect(encoded).not.toContain(liveField)
    }

    const tracks = store.getSnapshot().tracks
    store.playQueue(tracks, 0, 'mix')
    await store.flushPersistence()
    store.seek(37)
    await store.flushPersistence()
    await store.addToPlaylist('mix', 'b')
    await store.toggleFavorite('b')

    store.showHome()
    store.setPageSearch('')
    store.setLeftPanelSearch('')
    store.setLeftPanelSection('songs', false)
    store.setLeftPanelSection('playlists', true)
    store.setRightQueueOpen(true)
    store.setRightHistoryOpen(false)
    store.setRightPanelScrollTop(0)

    store.restoreMainWorkspaceView(saved.main)
    store.restoreLeftWorkspaceView(saved.left)
    store.restoreRightWorkspaceView(saved.right)
    const restored = store.getSnapshot()
    expect(restored.pageView).toEqual({ mode: 'playlist', id: 'mix' })
    expect(restored.pageSearch).toBe('canopy')
    expect(restored.canGoBack).toBe(true)
    expect(restored.leftPanelSearch).toBe('forest')
    expect(restored.leftPanelSections).toEqual({ songs: true, favorites: false, playlists: false })
    expect(restored.rightQueueOpen).toBe(false)
    expect(restored.rightHistoryOpen).toBe(true)
    expect(restored.rightPanelScrollTop).toBe(184)

    expect(restored.playlists.find((playlist) => playlist.id === 'mix')?.songIds).toEqual(['a', 'b'])
    expect(restored.currentTrack?.id).toBe('a')
    expect(restored.upNext.map((item) => item.id)).toEqual(['b'])
    expect(restored.currentTime).toBe(37)
    expect(restored.favorites.has('b')).toBe(true)
    store.dispose()
  })

  it('registers three versioned workspace view-state providers', async () => {
    const songs = ['a'].map((id) => track(id, `Music/${id}.mp4`))
    const mock = createMockValleyApi({
      settings: { musicPath: 'Music' },
      tracks: songs,
      indexEntries: songs.map((song) => asset(song.file))
    })
    const dispose = register(mock.api)
    try {
      await vi.waitFor(() => expect(getStore()?.getSnapshot().tracks).toHaveLength(1))
      expect(mock.api.interop.extensions.providers(WORKSPACE_VIEW_STATE_V1).map(({ extension }) => [
        extension.id,
        extension.surface
      ])).toEqual([
        ['music.main', 'main_workspace'],
        ['music.left', 'left_sidebar'],
        ['music.right', 'right_sidebar']
      ])
    } finally {
      dispose()
    }
  })

  it('ignores navigation to unknown playlists and songs', async () => {
    const { store, mock } = makeNavStore()
    await vi.waitFor(() => expect(store.getSnapshot().playlists).toHaveLength(1))

    store.showPlaylist('does-not-exist')
    store.revealSong('nope')
    expect(store.getSnapshot().pageView).toEqual({ mode: 'home' })
    expect(mock.api.workspace.openMainTab).not.toHaveBeenCalled()
    store.dispose()
  })

  it('resets the shown playlist to home when it disappears from the library', async () => {
    const { store } = makeNavStore()
    await vi.waitFor(() => expect(store.getSnapshot().playlists).toHaveLength(1))
    store.showPlaylist('mix')
    expect(store.getSnapshot().pageView).toEqual({ mode: 'playlist', id: 'mix' })

    await store.deletePlaylist('mix')
    await vi.waitFor(() => expect(store.getSnapshot().playlists).toHaveLength(0))
    expect(store.getSnapshot().pageView).toEqual({ mode: 'home' })
    store.dispose()
  })
})

describe('Music panel navigation and file actions', () => {
  let restoreAudio: () => void

  beforeEach(() => {
    restoreAudio = installFakeAudio()
  })

  afterEach(() => {
    cleanup()
    restoreAudio()
  })

  async function renderPanel(): Promise<{
    mock: ReturnType<typeof createMockValleyApi>
    dispose: () => void
  }> {
    const song = { ...track('canopy', 'Music/canopy.mp3'), title: 'Canopy Song', artist: 'Forest Duo' }
    const mock = createMockValleyApi({
      vault: { path: '/vault', name: 'vault', displayName: 'Vault' },
      settings: { musicPath: 'Music' },
      tracks: [song],
      playlists: [{ id: 'forest', name: 'Forest Mix', songIds: [song.id] }],
      indexEntries: [asset(song.file)]
    })
    const dispose = register(mock.api)
    const calls = (mock.api.registerView as unknown as { mock: { calls: [string, React.ComponentType][] } }).mock.calls
    const PanelView = calls.find(([key]) => key === 'music.panel')?.[1]
    expect(PanelView).toBeDefined()
    render(React.createElement(PanelView!))
    await screen.findByText('Forest Mix')
    return { mock, dispose }
  }

  it('uses the shared search frame while filtering, clearing, and pressing Escape', async () => {
    const { dispose } = await renderPanel()
    try {
      const input = screen.getByPlaceholderText('Search songs & playlists')
      const frame = input.parentElement!
      expect(frame).toHaveClass('search-field')
      expect(input).toHaveClass('search-field-input')
      expect(frame.querySelector('.search-field-icon')).not.toBeNull()
      expect(within(frame).queryByRole('button')).toBeNull()
      fireEvent.focus(input)
      fireEvent.change(input, { target: { value: 'Canopy Song' } })
      expect(await screen.findByText('Canopy Song')).toBeTruthy()
      const clear = within(frame).getByRole('button', { name: 'Clear search' })
      expect(clear).toHaveClass('search-field-action')
      expect(input.parentElement).toBe(frame)
      fireEvent.click(clear)
      expect(input).toHaveValue('')
      expect(screen.getByText('Forest Mix')).toBeTruthy()
      fireEvent.change(input, { target: { value: 'Canopy Song' } })
      fireEvent.keyDown(input, { key: 'Escape' })
      expect(input).toHaveValue('')
      expect(within(frame).queryByRole('button')).toBeNull()
    } finally {
      dispose()
    }
  })

  it('opens or focuses the singleton Music page from the header and every playable row target', async () => {
    const { mock, dispose } = await renderPanel()
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Open page' }))
      expect(mock.api.workspace.openMainTab).toHaveBeenCalledTimes(1)

      fireEvent.change(screen.getByPlaceholderText('Search songs & playlists'), { target: { value: 'Canopy Song' } })
      const songRow = (await screen.findByText('Canopy Song')).closest('.music-row')
      expect(songRow).not.toBeNull()
      fireEvent.click(songRow!)
      fireEvent.click(within(songRow as HTMLElement).getByRole('button', { name: 'Play' }))
      expect(mock.api.workspace.openMainTab).toHaveBeenCalledTimes(3)

      fireEvent.change(screen.getByPlaceholderText('Search songs & playlists'), { target: { value: '' } })
      const playlistRow = screen.getByText('Forest Mix').closest('.music-row')
      expect(playlistRow).not.toBeNull()
      fireEvent.click(within(playlistRow as HTMLElement).getByRole('button', { name: 'Play playlist' }))
      expect(mock.api.workspace.openMainTab).toHaveBeenCalledTimes(4)
    } finally {
      dispose()
    }
  })

  it('opens the core file viewer and offers both OS and Valley location reveals', async () => {
    const { mock, dispose } = await renderPanel()
    try {
      fireEvent.change(screen.getByPlaceholderText('Search songs & playlists'), { target: { value: 'Canopy Song' } })
      const songRow = (await screen.findByText('Canopy Song')).closest('.music-row')
      fireEvent.contextMenu(songRow!)
      await waitFor(() => expect(mock.menus).toHaveLength(1))

      const select = (label: string): void => {
        const item = mock.menus[0].find((candidate) => 'label' in candidate && candidate.label === label)
        expect(item).toBeDefined()
        if (item && 'onSelect' in item) item.onSelect?.()
      }

      select('Open file in Valley')
      select('Reveal in Finder')
      select('Show in Files')

      expect(mock.api.workspace.openFile).toHaveBeenCalledWith(
        'Music/canopy.mp3'
      )
      expect(mock.osFileActions).toContainEqual({ action: 'reveal', relPath: 'Music/canopy.mp3' })
      expect(mock.api.workspace.revealInFiles).toHaveBeenCalledWith('Music/canopy.mp3')
    } finally {
      dispose()
    }
  })

  it('creates a persistent playlist from the right-clicked song', async () => {
    const { mock, dispose } = await renderPanel()
    try {
      fireEvent.change(screen.getByPlaceholderText('Search songs & playlists'), { target: { value: 'Canopy Song' } })
      const songRow = (await screen.findByText('Canopy Song')).closest('.music-row')
      fireEvent.contextMenu(songRow!)
      await waitFor(() => expect(mock.menus).toHaveLength(1))

      const addMenu = mock.menus[0].find((item) => item.label === 'Add to playlist')
      const create = addMenu?.submenu?.find((item) => item.label === 'New playlist from this song')
      expect(create).toBeDefined()
      await act(async () => {
        await create?.onSelect?.()
      })

      await waitFor(() => {
        expect(playlistsOf(mock)).toContainEqual({
          id: 'canopy-song',
          name: 'Canopy Song',
          songIds: ['canopy']
        })
      })
    } finally {
      dispose()
    }
  })
})

describe('artist helpers', () => {
  it('splits an artist string on delimiters, dedupes, and honors an explicit array', () => {
    expect(trackArtists({ artist: 'A, B & C' })).toEqual(['A', 'B', 'C'])
    expect(trackArtists({ artist: 'Solo feat. Guest' })).toEqual(['Solo', 'Guest'])
    expect(trackArtists({ artist: 'A x B' })).toEqual(['A', 'B'])
    expect(trackArtists({ artist: 'A, a, A' })).toEqual(['A']) // case-insensitive dedupe
    // collab letters inside a name must not be treated as separators
    expect(trackArtists({ artist: 'Charli XCX' })).toEqual(['Charli XCX'])
    expect(trackArtists({ artist: 'Maxwell' })).toEqual(['Maxwell'])
    // explicit list wins over splitting the string
    expect(trackArtists({ artist: 'ignored', artists: ['One', 'Two'] })).toEqual(['One', 'Two'])
    expect(trackArtists({ artist: '' })).toEqual([])
  })

  it('normalizes names to a stable match key', () => {
    expect(normalizeArtistName('  Chanterelle   Ensemble ')).toBe('chanterelle ensemble')
  })

  it('upserts one entity per unique name, idempotently', () => {
    const tracks = [
      { id: '1', title: 'x', artist: 'A & B', file: 'a' },
      { id: '2', title: 'y', artist: 'a', file: 'b' } // 'a' == 'A' after normalize
    ] as Track[]
    let n = 0
    const first = upsertArtists([], tracks, () => `id${n++}`)
    expect(first.added.map((a) => a.name)).toEqual(['A', 'B'])
    expect(first.next).toHaveLength(2)
    const again = upsertArtists(first.next, tracks, () => 'dupe')
    expect(again.added).toHaveLength(0)
    expect(again.next).toBe(first.next) // unchanged reference when nothing added
  })

  it('resolves by id, normalized name and alias', () => {
    const reg: Artist[] = [{ id: 'x', name: 'Chanterelle', aliases: ['MB'] }]
    expect(resolveArtist(reg, 'x')?.id).toBe('x')
    expect(resolveArtist(reg, 'chanterelle')?.id).toBe('x')
    expect(resolveArtist(reg, 'mb')?.id).toBe('x')
    expect(resolveArtist(reg, 'unknown')).toBeNull()
  })

  it('finds an artist’s songs by name or alias', () => {
    const tracks = [
      { id: '1', title: 'x', artist: 'Chanterelle & Moss', file: 'a' },
      { id: '2', title: 'y', artist: 'Other', file: 'b' }
    ] as Track[]
    expect(tracksForArtist(tracks, { name: 'Chanterelle' }).map((t) => t.id)).toEqual(['1'])
    expect(tracksForArtist(tracks, { name: 'Moss' }).map((t) => t.id)).toEqual(['1'])
    expect(tracksForArtist(tracks, { name: 'X', aliases: ['Other'] }).map((t) => t.id)).toEqual(['2'])
  })
})

describe('MusicStore artist pages', () => {
  let restoreAudio: () => void
  beforeEach(() => {
    restoreAudio = installFakeAudio()
  })
  afterEach(() => {
    restoreAudio()
  })

  it('registers an entity per artist name (splitting multi-artist songs) and lists their songs', async () => {
    const songs = [
      { id: 's1', title: 'Orbiter', artist: 'Chanterelle Ensemble & Moss Ensemble', file: 'Music/s1.mp4' },
      { id: 's2', title: 'Solo', artist: 'Chanterelle Ensemble', file: 'Music/s2.mp4' }
    ] as Track[]
    const mock = createMockValleyApi({
      settings: { musicPath: 'Music' },
      tracks: songs,
      indexEntries: songs.map((s) => asset(s.file))
    })
    const store = new MusicStore(mock.api)
    try {
      await vi.waitFor(() =>
        expect(store.getSnapshot().artists.map((a) => a.name).sort()).toEqual([
          'Chanterelle Ensemble',
          'Moss Ensemble'
        ])
      )
      expect(artistsOf(mock)).toHaveLength(2)
      const chanterelle = store.getSnapshot().artists.find((a) => a.name === 'Chanterelle Ensemble')!
      expect(store.artistSummary(chanterelle.id)?.tracks.map((t) => t.id).sort()).toEqual(['s1', 's2'])
    } finally {
      store.dispose()
    }
  })

  it('showArtist opens the tab, sets the artist view and persists nav state', async () => {
    const songs = [{ id: 's1', title: 'Orbiter', artist: 'Chanterelle', file: 'Music/s1.mp4' }] as Track[]
    const mock = createMockValleyApi({
      settings: { musicPath: 'Music' },
      tracks: songs,
      indexEntries: songs.map((s) => asset(s.file))
    })
    const store = new MusicStore(mock.api)
    try {
      await vi.waitFor(() => expect(store.getSnapshot().artists).toHaveLength(1))
      const artist = store.getSnapshot().artists[0]
      const before = store.getSnapshot().pageViewNonce

      store.showArtist(artist.name)
      expect(store.getSnapshot().pageView).toEqual({ mode: 'artist', id: artist.id })
      expect(store.getSnapshot().pageViewNonce).toBe(before + 1)
      expect(mock.api.workspace.openMainTab).toHaveBeenCalled()
      await vi.waitFor(() =>
        expect(mock.api.settings.get().navigationState).toMatchObject({ mode: 'artist', id: artist.id })
      )

      store.showArtist('Nobody Here') // no song credits this — ignored
      expect(store.getSnapshot().pageView).toEqual({ mode: 'artist', id: artist.id })
    } finally {
      store.dispose()
    }
  })

  it('restores the persisted page view on load without opening a tab', async () => {
    const songs = ['a', 'b'].map((id) => track(id, `Music/${id}.mp4`))
    const mock = createMockValleyApi({
      settings: { musicPath: 'Music' },
      tracks: songs,
      playlists: [{ id: 'mix', name: 'Mix', songIds: ['a'] }],
      navigationState: { mode: 'playlist', id: 'mix', reveal: 'a', searchQuery: 'needle' },
      indexEntries: songs.map((s) => asset(s.file))
    })
    const store = new MusicStore(mock.api)
    try {
      await vi.waitFor(() => expect(store.getSnapshot().pageView).toEqual({ mode: 'playlist', id: 'mix', reveal: 'a' }))
      expect(store.getSnapshot().pageSearch).toBe('needle')
      expect(mock.api.workspace.openMainTab).not.toHaveBeenCalled()
    } finally {
      store.dispose()
    }
  })

  it('a rename keeps songs resolving via alias and a merge folds one artist into another', async () => {
    const songs = [
      { id: 's1', title: 'One', artist: 'Chanterelle', file: 'Music/s1.mp4' },
      { id: 's2', title: 'Two', artist: 'MB', file: 'Music/s2.mp4' }
    ] as Track[]
    const mock = createMockValleyApi({
      settings: { musicPath: 'Music' },
      tracks: songs,
      indexEntries: songs.map((s) => asset(s.file))
    })
    const store = new MusicStore(mock.api)
    try {
      await vi.waitFor(() => expect(store.getSnapshot().artists).toHaveLength(2))
      const chanterelle = store.getSnapshot().artists.find((a) => a.name === 'Chanterelle')!
      const mb = store.getSnapshot().artists.find((a) => a.name === 'MB')!

      await store.renameArtist(chanterelle.id, 'Chanterelle Ensemble')
      // s1 still credits the string "Chanterelle" — the alias keeps it resolving.
      expect(store.artistSummary(chanterelle.id)?.tracks.map((t) => t.id)).toEqual(['s1'])

      await store.mergeArtists(mb.id, chanterelle.id)
      expect(store.getSnapshot().artists.some((a) => a.id === mb.id)).toBe(false)
      expect(store.artistSummary(chanterelle.id)?.tracks.map((t) => t.id).sort()).toEqual(['s1', 's2'])
    } finally {
      store.dispose()
    }
  })

  it('keeps artist merges atomic on save failure and refuses stale undo', async () => {
    const songs = [{ ...track('a', 'Music/a.mp4'), artist: 'Forest' }, { ...track('b', 'Music/b.mp4'), artist: 'Meadow' }]
    const mock = createMockValleyApi({ tracks: songs, indexEntries: songs.map((song) => asset(song.file)) })
    const store = new MusicStore(mock.api)
    try {
      await vi.waitFor(() => expect(store.getSnapshot().artists).toHaveLength(2))
      const [source, target] = store.getSnapshot().artists
      const transaction = vi.spyOn(mock.api.data, 'transaction')
      transaction.mockRejectedValueOnce(new Error('Disk full'))
      await expect(store.mergeArtists(source.id, target.id)).rejects.toThrow('Disk full')
      expect(store.getSnapshot().artists).toHaveLength(2)
      expect(mock.datasets.get('music.artists')).toHaveLength(2)
      await store.mergeArtists(source.id, target.id)
      const action = mock.undoActions.at(-1)!
      await action.undo()
      expect(store.getSnapshot().artists).toHaveLength(2)
      await action.redo!()
      expect(store.getSnapshot().artists).toHaveLength(1)
      await store.updateArtistProperties(target.id, { bio: 'A newer edit' })
      await expect(action.undo()).rejects.toThrow('Artist details changed')
    } finally { store.dispose() }
  })

  it('opens artist, playlist and song-artist pages through the command bus', async () => {
    const songs = [
      { id: 's1', title: 'Orbiter', artist: 'Chanterelle Ensemble & Moss Ensemble', file: 'Music/s1.mp4' }
    ] as Track[]
    const mock = createMockValleyApi({
      settings: { musicPath: 'Music' },
      tracks: songs,
      playlists: [{ id: 'mix', name: 'Mix', songIds: ['s1'] }],
      indexEntries: songs.map((s) => asset(s.file))
    })
    const store = createRuntimeStore(mock)
    const off = registerMusicCommands(mock.api)
    try {
      await vi.waitFor(() => expect(store.getSnapshot().artists).toHaveLength(2))

      const pl = await mock.api.commands.execute('music:open-playlist', { name: 'mix' })
      expect(pl.ok).toBe(true)
      expect(store.getSnapshot().pageView).toEqual({ mode: 'playlist', id: 'mix' })

      const ar = await mock.api.commands.execute('music:open-artist', { name: 'Moss Ensemble' })
      expect(ar.ok).toBe(true)
      if (ar.ok) expect(ar.value).toMatchObject({ artist: 'Moss Ensemble', count: 1 })
      expect(store.getSnapshot().pageView.mode).toBe('artist')

      const sa = await mock.api.commands.execute('music:open-song-artist', { title: 'Orbiter' })
      expect(sa.ok).toBe(true)
      if (sa.ok) expect(sa.value).toMatchObject({ artist: 'Chanterelle Ensemble' })
      expect(store.getSnapshot().pageView.mode).toBe('artist')

      const miss = await mock.api.commands.execute('music:open-artist', { name: 'Nobody' })
      expect(miss.ok).toBe(false)
    } finally {
      off()
      disposeStore(mock.api, store)
    }
  })
})

describe('playback credits', () => {
  it('keeps explicit artist names and separates title feature credits without splitting band names', () => {
    expect(trackCredits({ artist: 'Earth, Wind & Fire', artists: ['Earth, Wind & Fire'], title: 'Song (feat. Guest & Second Guest)' })).toEqual({
      artists: ['Earth, Wind & Fire'], feat: ['Guest', 'Second Guest']
    })
    expect(trackCredits({ artist: 'Lead feat. Guest', artists: ['Lead', 'Guest'], title: 'Song (ft. guest)' })).toEqual({ artists: ['Lead'], feat: ['Guest'] })
  })
})


describe('Music song editing and presentation', () => {
  let restoreAudio: () => void
  beforeEach(() => { restoreAudio = installFakeAudio() })
  afterEach(() => { cleanup(); restoreAudio(); vi.restoreAllMocks() })

  async function setup() {
    const song = { ...track('canopy', 'Music/canopy.mp4'), artist: 'Forest Duo', duration: 120, favorite: true }
    const mock = createMockValleyApi({ tracks: [song], playlists: [{ id: 'forest', name: 'Forest Mix', songIds: [song.id] }], indexEntries: [asset(song.file), asset('Images/fern.png')] })
    const dispose = register(mock.api)
    const store = getStore()!
    await vi.waitFor(() => expect(store.getSnapshot().loading).toBe(false))
    await store.syncLibrary()
    return { song, mock, store, dispose }
  }

  it('saves metadata without losing queue, favorites or playlist membership, and rejects stale drafts', async () => {
    const { song, mock, store, dispose } = await setup()
    try {
      store.playTrack(song)
      await store.flushPersistence()
      const values = { title: 'Canopy Revised', artist: 'Fern Ensemble', album: 'Forest', details: { feat: 'Moss Choir', songwriter: 'Canopy', author: 'Fern', composer: 'Moss', genre: 'Ambient', year: '2026', lyrics: 'Leaves', cover: 'Images/fern.png' } }
      await store.updateTrack(song.id, values, song)
      expect(tracksOf(mock)[0]).toMatchObject({ ...values, favorite: true, file: song.file, details: { ...values.details, edited: true } })
      expect(store.getSnapshot().currentTrack?.title).toBe(values.title)
      expect(store.getSnapshot().isPlaying).toBe(true)
      expect(playlistsOf(mock)[0].songIds).toEqual([song.id])
      expect(store.getSnapshot().artists.map(artist => artist.name)).toContain('Moss Choir')
      expect(store.getCoverUrl(song.id)).toContain('fern.png')
      await store.refresh()
      expect(store.getSnapshot().tracks[0].title).toBe(values.title)
      await expect(store.updateTrack(song.id, { ...values, title: 'Stale' }, song)).rejects.toThrow()
      await expect(store.updateTrack(song.id, { ...values, title: ' ' })).rejects.toThrow()
      expect(tracksOf(mock)[0].title).toBe(values.title)
    } finally { await dispose() }
  })

  it('mounts Edit song within the originating view and cancels without changing the library', async () => {
    const { song, mock, store, dispose } = await setup()
    try {
      const openMenu = vi.spyOn(mock.api.ui, 'openMenu').mockResolvedValue(null)
      store.showPlaylist('forest')
      render(React.createElement(Page, { navigation: { setController: vi.fn() } }))
      fireEvent.contextMenu(screen.getByText(song.title, { selector: '.music-row-title' }))
      const items = openMenu.mock.calls.at(-1)![0]
      const edit = items.find(item => item.label === 'Edit song')!
      await act(async () => { await edit.onSelect?.() })
      expect(screen.getByLabelText('Songwriter')).toBeInTheDocument()
      fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Cancelled edit' } })
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(screen.queryByLabelText('Songwriter')).toBeNull()
      expect(store.getSnapshot().tracks[0].title).toBe(song.title)
    } finally { await dispose() }
  })

  it('keeps the editor open on save failure and commits only on Save', async () => {
    const { song, store, dispose } = await setup()
    const close = vi.fn()
    try {
      render(React.createElement(SongEditor, { track: song, store, onClose: close }))
      fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Canopy Revised' } })
      fireEvent.change(screen.getByLabelText('Featured artists'), { target: { value: 'Moss Choir' } })
      expect(store.getSnapshot().tracks[0].title).toBe(song.title)
      const save = vi.spyOn(store, 'updateTrack').mockRejectedValueOnce(new Error('Write failed'))
      fireEvent.click(screen.getByText('Save', { selector: 'button' }))
      await screen.findByText('Write failed')
      expect(close).not.toHaveBeenCalled()
      save.mockRestore()
      fireEvent.click(screen.getByText('Save', { selector: 'button' }))
      await waitFor(() => expect(close).toHaveBeenCalledOnce())
      expect(store.getSnapshot().tracks[0]).toMatchObject({ title: 'Canopy Revised', details: { feat: 'Moss Choir' } })
    } finally { await dispose() }
  })

  it('exposes footer library details and opens the player from now playing', async () => {
    const { song, mock, store, dispose } = await setup()
    try {
      const view = render(React.createElement(NowPlaying))
      expect(view.container).toBeEmptyDOMElement()
      await act(async () => { store.playTrack(song); await store.flushPersistence() })
      const details = mock.api.interop.extensions.providers(WORKSPACE_DETAILS_V1)[0].extension
      expect(details.getSnapshot({ selectedItemIds: [] }).items).toMatchObject({ songs: { text: '1 song' }, playlists: { text: '1 playlist' }, duration: { text: '2:00' } })
      fireEvent.click(screen.getByLabelText('Open Music player'))
      expect(mock.api.workspace.revealOwnPanel).toHaveBeenCalledWith('right_sidebar')
    } finally { await dispose() }
  })

  it('renders playlist/song breadcrumbs above Home and Search', async () => {
    const { song, store, dispose } = await setup()
    try {
      store.showPlaylist('forest')
      store.revealSong(song.id)
      render(React.createElement(Page, { navigation: { setController: vi.fn() } }))
      const navigation = screen.getByRole('navigation', { name: 'Music location' })
      expect(navigation.textContent).toBe('/Forest Mix/canopy')
      expect(navigation.nextElementSibling).toHaveClass('search-field-row')
    } finally { await dispose() }
  })

  it('follows playlist playback and persists the alternate file path from the header menu', async () => {
    const { song, mock, store, dispose } = await setup()
    try {
      const openMenu = vi.spyOn(mock.api.ui, 'openMenu').mockResolvedValue(null)
      store.showPlaylist('forest')
      const view = render(React.createElement(Page, { navigation: { setController: vi.fn() } }))
      const header = () => screen.getByRole('navigation', { name: 'Music location' })
      expect(header().textContent).toBe('/Forest Mix')
      await act(async () => { store.playTrack(song, { playlistId: 'forest' }); await store.flushPersistence() })
      expect(header().textContent).toBe('/Forest Mix/canopy')
      fireEvent.click(header().querySelector('.music-breadcrumb-home')!)
      expect(header().textContent).toBe('/canopy')
      await act(async () => { store.pause(); await store.flushPersistence() })
      expect(header().textContent).toBe('/canopy')
      act(() => store.showPlaylist('forest'))
      expect(header().textContent).toBe('/Forest Mix/canopy')
      fireEvent.contextMenu(header())
      let items = openMenu.mock.calls.at(-1)![0]
      expect(items.find(item => item.label === 'Playlist / song')?.checked).toBe(true)
      await act(async () => { await items.find(item => item.label === 'Music file path')!.onSelect?.() })
      expect(header().textContent).toBe('/Music/canopy.mp4')
      fireEvent.click(header().querySelector('.music-breadcrumb-home')!)
      expect(header().textContent).toBe('/Music/canopy.mp4')
      act(() => store.showPlaylist('forest'))
      expect(header().textContent).toBe('/Music/canopy.mp4')
      fireEvent.click(screen.getByRole('button', { name: 'Music' }))
      expect(mock.api.workspace.revealInFiles).toHaveBeenCalledWith('Music')
      view.unmount()
      render(React.createElement(Page, { navigation: { setController: vi.fn() } }))
      expect(header().textContent).toBe('/Music/canopy.mp4')
      fireEvent.contextMenu(header())
      items = openMenu.mock.calls.at(-1)![0]
      expect(items.find(item => item.label === 'Music file path')?.checked).toBe(true)
      await act(async () => { await items.find(item => item.label === 'Playlist / song')!.onSelect?.() })
      expect(header().textContent).toBe('/Forest Mix/canopy')
    } finally { await dispose() }
  })

  it('keeps recently played cards fixed through playback and metadata changes until refresh', async () => {
    const songs = [track('fern', 'Music/fern.mp4'), track('moss', 'Music/moss.mp4')]
    const mock = createMockValleyApi({
      tracks: songs, indexEntries: songs.map(song => asset(song.file)),
      history: [{ songId: 'fern', playedAt: '2026-01-01T00:00:00Z' }, { songId: 'moss', playedAt: '2026-01-02T00:00:00Z' }]
    })
    const dispose = register(mock.api)
    const store = getStore()!
    try {
      await vi.waitFor(() => expect(store.getSnapshot().loading).toBe(false))
      render(React.createElement(Page, { navigation: { setController: vi.fn() } }))
      const cards = () => screen.getByRole('heading', { name: 'Recently played' }).closest('.music-page-section')!
      const titles = () => [...cards().querySelectorAll('.music-track-card-title')].map(item => item.textContent)
      expect(titles()).toEqual(['moss', 'fern'])
      fireEvent.click(within(cards() as HTMLElement).getByText('fern'))
      await act(async () => { await store.flushPersistence() })
      expect(store.getSnapshot().history.map(item => item.id)).toEqual(['fern', 'moss'])
      expect(titles()).toEqual(['moss', 'fern'])
      expect(screen.getByRole('navigation', { name: 'Music location' }).textContent).toBe('/fern')
      await act(async () => { store.pause(); await store.flushPersistence() })
      expect(screen.getByRole('navigation', { name: 'Music location' }).textContent).toBe('/fern')
      await act(async () => { await store.updateTrack('fern', { title: 'Fern revised', artist: 'Canopy', album: '', details: {} }) })
      expect(titles()).toEqual(['moss', 'Fern revised'])
      await act(async () => { await store.refresh() })
      expect(titles()).toEqual(['Fern revised', 'moss'])
    } finally { await dispose() }
  })

  it('switches MP4 presentation without replacing the host player or creating another media element', async () => {
    const { song, mock, store, dispose } = await setup()
    try {
      store.playTrack(song)
      await store.flushPersistence()
      store.seek(15)
      await store.flushPersistence()
      const view = render(React.createElement(Player))
      fireEvent.click(screen.getByRole('button', { name: 'Video' }))
      expect(view.container.querySelector('[data-media-session]')?.getAttribute('data-media-session')).toBe('music-session')
      expect(view.container.querySelector('video, audio')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Song' }))
      expect(view.container.querySelector('[data-media-session]')).toBeNull()
      expect(media.get(mock)!.player.load).toHaveBeenCalledTimes(1)
      expect(store.getSnapshot()).toMatchObject({ currentTrack: { id: song.id }, currentTime: 15, isPlaying: true })
    } finally { await dispose() }
  })

  it('hides Video for audio files and routes seek and pause to the same host session', async () => {
    const { song, mock, store, dispose } = await setup()
    try {
      store.playTrack(song)
      await store.flushPersistence()
      const view = render(React.createElement(Player))
      fireEvent.click(screen.getByRole('button', { name: 'Video' }))
      await act(async () => { store.seek(25); await store.flushPersistence() })
      expect(media.get(mock)!.player.seek).toHaveBeenCalledWith(25)
      await act(async () => { store.pause(); await store.flushPersistence() })
      expect(media.get(mock)!.player.pause).toHaveBeenCalledOnce()
      const audio = { ...song, id: 'audio', file: 'Music/forest.mp3' }
      await mock.api.data.dataset('music.tracks').insert(audio)
      await act(async () => { store.playTrack(audio); await store.flushPersistence() })
      expect(screen.queryByRole('button', { name: 'Video' })).toBeNull()
      expect(view.container.querySelector('video, audio')).toBeNull()
    } finally { await dispose() }
  })

  it('skips library component renders for playback clock updates', async () => {
    const { song, store, dispose } = await setup()
    let renders = 0
    const Library = () => { useMusic(false); renders++; return null }
    try {
      store.playTrack(song)
      await store.flushPersistence()
      render(React.createElement(Library))
      const before = renders
      await act(async () => { store.seek(10); await store.flushPersistence() })
      expect(renders).toBe(before)
      await act(async () => store.toggleFavorite(song.id))
      expect(renders).toBeGreaterThan(before)
    } finally { await dispose() }
  })
})
