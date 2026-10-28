/**
 * The music plugin's command-bus surface: typed `music:*` commands that return
 * **structured** data (Track[]/Playlist[]/objects) and carry a `formatCli` that
 * produces `valley music <sub>` stdout. The agent consumes the
 * structured value directly (no text parsing); the terminal CLI stringifies via
 * `formatCli`. Handlers read the live store via `getStore()` (hot-reload-safe)
 * and call its public methods. Playback/history and queue mutations are writes;
 * playlist mutations return command-bus reverts.
 */
import type { PluginCommand, ValleyPluginApi } from '@valley/plugin-sdk'
import { normalizeRelPath } from '@valley/plugin-sdk/paths'
import { getStore, type MusicStore, type MusicSnapshot } from './store'
import { playbackPosition } from './playback'
import { resolveArtist, trackArtists, tracksForArtist } from './artists'
import type { Artist, Playlist, Track } from './types'

const resultText = { type: 'string', maxLength: 16384 }
const resultFlag = { type: 'boolean' }
const resultNumber = { type: 'number', minimum: 0 }
const resultCount = { type: 'integer', minimum: 0 }
const resultStrings = { type: 'array', maxItems: 10000, items: resultText }
const resultObject = (properties: Record<string, unknown>, required = Object.keys(properties)): Record<string, unknown> => ({ type: 'object', properties, required, additionalProperties: false })
const resultList = (items: Record<string, unknown>, maxItems = 10000): Record<string, unknown> => ({ type: 'array', maxItems, items })
const nullableResult = (value: Record<string, unknown>): Record<string, unknown> => ({ anyOf: [value, { type: 'null' }] })
const trackResult = resultObject({ id: resultText, title: resultText, artist: resultText, artists: nullableResult(resultStrings), album: nullableResult(resultText), file: resultText,
  duration: nullableResult(resultNumber), favorite: nullableResult(resultFlag), addedAt: nullableResult(resultText),
  details: nullableResult(resultObject({ feat: resultText, songwriter: resultText, author: resultText, composer: resultText, genre: resultText, year: resultText, lyrics: resultText, cover: resultText, edited: resultFlag }, []))
}, ['id', 'title', 'artist', 'file'])
const artistResult = resultObject({ id: resultText, name: resultText, image: nullableResult(resultText), bio: nullableResult(resultText), aliases: resultStrings }, ['id', 'name'])
const playlistResult = resultObject({ id: resultText, name: resultText, songIds: resultStrings, cover: resultText }, ['id', 'name', 'songIds'])
const playlistActionResult = resultObject({ action: { type: 'string', enum: ['play', 'shuffle', 'next', 'last'] }, playlist: playlistResult, count: resultCount, started: trackResult }, ['action', 'playlist', 'count'])
const artistSummaryResult = resultObject({ artist: resultText, count: resultCount })
const trackHolderResult = resultObject({ track: trackResult })
const playlistHolderResult = resultObject({ playlist: playlistResult })
const historyResult = resultObject({ songId: resultText, playedAt: resultText, playlistId: resultText }, ['songId', 'playedAt'])
const nullResult = { type: 'null' }

function live(): MusicStore {
  const store = getStore()
  if (!store) throw new Error('Music store is not ready.')
  return store
}

const asStr = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v))
const asBool = (v: unknown): boolean =>
  v === true || v === 'true' || v === 'on' || v === 'yes' || v === '1'
const asInt = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number.parseInt(v, 10) : NaN
  return Number.isFinite(n) ? n : undefined
}

const SONG_LIMIT = 80
const ARTIST_LIMIT = 120
const PLAYLIST_LIMIT = 80

function fmtTime(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function describe(track: Track): string {
  return track.artist ? `${track.title} — ${track.artist}` : track.title
}

interface ArtistSummary {
  artist: string
  count: number
}

interface MusicSearchResult {
  query: string
  tracks: Track[]
  artists: ArtistSummary[]
  playlists: Playlist[]
}

function optionalSearchInput(): {
  schema: Record<string, unknown>
  parse: (raw: unknown) => { search: string }
  fromCli: (args: string[], flags: Record<string, string | boolean>) => { search: string }
} {
  return {
    schema: { type: 'object', properties: { search: { type: 'string' } }, additionalProperties: false },
    parse: (raw) => ({ search: asStr((raw as Record<string, unknown> | undefined)?.search).trim() }),
    fromCli: (args, flags) => ({ search: (args.join(' ') || asStr(flags.search)).trim() })
  }
}

/** Substring match on title/artist, ranked title-prefix → title-substring → artist. */
function rankTracks(tracks: Track[], query: string): Track[] {
  if (!query) return [...tracks].sort((a, b) => describe(a).localeCompare(describe(b)))
  const q = query.toLowerCase()
  return tracks
    .map((t) => {
      const titleIdx = t.title.toLowerCase().indexOf(q)
      const artistIdx = (t.artist ?? '').toLowerCase().indexOf(q)
      if (titleIdx === -1 && artistIdx === -1) return null
      const score = titleIdx === 0 ? 0 : titleIdx > 0 ? 1 : 2
      return { t, score, pos: titleIdx === -1 ? 9999 : titleIdx }
    })
    .filter((x): x is { t: Track; score: number; pos: number } => x !== null)
    .sort((a, b) => a.score - b.score || a.pos - b.pos || a.t.title.localeCompare(b.t.title))
    .map((x) => x.t)
}

function rankPlaylists(playlists: Playlist[], query: string): Playlist[] {
  if (!query) return [...playlists].sort((a, b) => a.name.localeCompare(b.name))
  const q = query.toLowerCase()
  return playlists
    .map((p) => {
      const pos = p.name.toLowerCase().indexOf(q)
      return pos === -1 ? null : { p, pos }
    })
    .filter((x): x is { p: Playlist; pos: number } => x !== null)
    .sort((a, b) => a.pos - b.pos || a.p.name.localeCompare(b.p.name))
    .map((x) => x.p)
}

function artistsFor(tracks: Track[], query = ''): ArtistSummary[] {
  const q = query.toLowerCase()
  const counts = new Map<string, number>()
  for (const track of tracks) {
    for (const artist of trackArtists(track)) {
      if (q && !artist.toLowerCase().includes(q)) continue
      counts.set(artist, (counts.get(artist) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .map(([artist, count]) => ({ artist, count }))
    .sort((a, b) => a.artist.localeCompare(b.artist))
}

function searchLibrary(snap: MusicSnapshot, query: string): MusicSearchResult {
  return {
    query,
    tracks: rankTracks(snap.tracks, query).slice(0, SONG_LIMIT),
    artists: artistsFor(snap.tracks, query).slice(0, ARTIST_LIMIT),
    playlists: rankPlaylists(snap.playlists, query).slice(0, PLAYLIST_LIMIT)
  }
}

function formatTracks(tracks: Track[]): string {
  if (tracks.length === 0) return 'No songs found.'
  return [`${tracks.length} song${tracks.length === 1 ? '' : 's'}:`, ...tracks.map((t) => `  ${describe(t)}  [${t.id}]`)].join('\n')
}

function formatArtists(artists: ArtistSummary[]): string {
  if (artists.length === 0) return 'No artists found.'
  return artists.map((a) => `  ${a.artist} (${a.count} song${a.count === 1 ? '' : 's'})`).join('\n')
}

function formatPlaylists(playlists: Playlist[]): string {
  if (playlists.length === 0) return 'No playlists.'
  const snap = live().getSnapshot()
  return playlists
    .map((p) => {
      const count = snap.playlistTracks[p.id]?.length ?? p.songIds.length
      return `  ${p.name} (${count} track${count === 1 ? '' : 's'})  [${p.id}]`
    })
    .join('\n')
}

function formatSearch(result: MusicSearchResult): string {
  const lines = [`Search${result.query ? ` "${result.query}"` : ''}:`]
  lines.push(`Songs: ${result.tracks.length}`)
  for (const track of result.tracks.slice(0, 10)) lines.push(`  ${describe(track)}  [${track.id}]`)
  lines.push(`Artists: ${result.artists.length}`)
  for (const artist of result.artists.slice(0, 10)) {
    lines.push(`  ${artist.artist} (${artist.count} song${artist.count === 1 ? '' : 's'})`)
  }
  lines.push(`Playlists: ${result.playlists.length}`)
  for (const playlist of result.playlists.slice(0, 10)) lines.push(`  ${playlist.name}  [${playlist.id}]`)
  return lines.join('\n')
}

function playlistName(snap: MusicSnapshot, id: string | null): string | null {
  if (!id) return null
  return snap.playlists.find((p) => p.id === id)?.name ?? null
}

type PlaylistAction = 'play' | 'shuffle' | 'next' | 'last'

interface PlaylistActionResult {
  action: PlaylistAction
  playlist: Playlist
  count: number
  started?: Track
}

function playlistInput(usage: string): {
  schema: Record<string, unknown>
  parse: (raw: unknown) => { name: string }
  fromCli: (args: string[]) => { name: string }
} {
  return {
    schema: { type: 'object', properties: { name: { type: 'string', minLength: 1 } }, required: ['name'], additionalProperties: false },
    parse: (raw) => {
      const name = asStr((raw as Record<string, unknown> | undefined)?.name).trim()
      if (!name) throw new Error(usage)
      return { name }
    },
    fromCli: (args) => ({ name: args.join(' ').trim() })
  }
}

function trackInput(usage: string): {
  schema: Record<string, unknown>
  parse: (raw: unknown) => { title: string; exact: boolean }
  fromCli: (args: string[], flags: Record<string, string | boolean>) => { title: string; exact: boolean }
} {
  return {
    schema: { type: 'object', properties: { title: { type: 'string' }, query: { type: 'string' }, exact: { type: 'boolean' } }, anyOf: [{ required: ['title'] }, { required: ['query'] }], additionalProperties: false },
    parse: (raw) => {
      const o = (raw ?? {}) as Record<string, unknown>
      const title = asStr(o.title ?? o.query).trim()
      if (!title) throw new Error(usage)
      return { title, exact: asBool(o.exact) }
    },
    fromCli: (args, flags) => ({ title: args.join(' ').trim(), exact: asBool(flags.exact) })
  }
}

function findPlaylist(snap: MusicSnapshot, name: string): Playlist {
  const byId = snap.playlists.find((item) => item.id === name)
  if (byId) return byId
  const q = name.toLowerCase()
  const matches = snap.playlists
    .filter((p) => p.name.toLowerCase().includes(q))
    .sort((a, b) => a.name.toLowerCase().indexOf(q) - b.name.toLowerCase().indexOf(q))
  if (matches.length === 0) throw new Error(`No playlist matching "${name}".`)
  const exact = matches.filter((item) => item.name.toLowerCase() === q)
  if (exact.length === 1) return exact[0]
  if (matches.length > 1) throw new Error(`Ambiguous playlist; use one of these IDs: ${matches.map((item) => item.id).join(', ')}`)
  return matches[0]
}

function findTrack(snap: MusicSnapshot, query: string, exact = false): Track {
  const byId = snap.tracks.find((item) => item.id === query)
  if (byId) return byId
  const byPath = snap.tracks.filter((item) => item.file === query)
  if (byPath.length === 1) return byPath[0]
  if (byPath.length > 1) throw new Error(`Ambiguous track path; use one of these IDs: ${byPath.map((item) => item.id).join(', ')}`)
  const matches = exact
    ? snap.tracks.filter((t) => t.title.toLowerCase() === query.toLowerCase())
    : rankTracks(snap.tracks, query)
  if (matches.length === 0) throw new Error(`No track matching "${query}".`)
  const exactMatches = matches.filter((item) => item.title.toLowerCase() === query.toLowerCase())
  if (exactMatches.length === 1) return exactMatches[0]
  if (matches.length > 1) throw new Error(`Ambiguous track; use one of these IDs: ${matches.map((item) => item.id).join(', ')}`)
  return matches[0]
}

function trackIdentity(track: Track | null): { id: string; file: string } | null {
  return track ? { id: track.id, file: track.file } : null
}

function queueSelection(snap: MusicSnapshot, title: string, index?: number): { track: Track; position: number } {
  const entries = snap.upNext.map((track, position) => ({ track, position: position + 1 }))
  if (!entries.length) throw new Error('Queue is empty.')
  if (index !== undefined) {
    const selected = entries[index - 1]
    if (!Number.isInteger(index) || !selected) throw new Error(`No queued track at position ${index}. Use music queue to see available positions.`)
    return selected
  }
  const byId = entries.filter(({ track }) => track.id === title)
  const direct = byId.length ? byId : entries.filter(({ track }) => track.file === title)
  const exact = entries.filter(({ track }) => track.title.toLowerCase() === title.toLowerCase())
  const matches = direct.length ? direct : exact.length ? exact : entries.filter(({ track }) => rankTracks([track], title).length > 0)
  if (!matches.length) throw new Error(`"${title}" is not in the queue. Use music queue to see track IDs and positions.`)
  if (matches.length > 1) throw new Error(`Ambiguous queued track; use --index with one of these positions: ${matches.map(({ track, position }) => `${position} [${track.id}]`).join(', ')}`)
  return matches[0]
}

function playbackIdentity(): { track: { id: string; file: string } | null; playing: boolean } {
  const snap = live().getSnapshot()
  return { track: trackIdentity(snap.currentTrack), playing: snap.isPlaying }
}

const queueIdentity = (): string[] => live().getSnapshot().upNext.map((track) => track.id)

function playlistIdentity(name: string): { id: string; songIds: string[]; tracks: ({ id: string; file: string } | null)[] } {
  const snap = live().getSnapshot(), playlist = findPlaylist(snap, name)
  return { id: playlist.id, songIds: playlist.songIds, tracks: (snap.playlistTracks[playlist.id] ?? []).map(trackIdentity) }
}

function playlistSongs(name: string): { id: string; songIds: string[] } {
  const playlist = findPlaylist(live().getSnapshot(), name)
  return { id: playlist.id, songIds: [...playlist.songIds] }
}

function playlistActionPreview(name: string, action: PlaylistAction): { action: PlaylistAction; playlist: Playlist; count: number } {
  const snap = live().getSnapshot(), target = playablePlaylist(snap, findPlaylist(snap, name))
  return { action, playlist: target.playlist, count: target.tracks.length }
}

function deletedTrackTarget(id: string): { track: Track; playlists: Playlist[] } {
  const snap = live().getSnapshot(), track = snap.tracks.find((item) => item.id === id)
  if (!track) throw new Error('Track no longer exists. Use music songs to select an available track ID.')
  return { track, playlists: snap.playlists.filter((playlist) => playlist.songIds.includes(id)) }
}

function artistTarget(id: string): Artist {
  const artist = live().getSnapshot().artists.find((item) => item.id === id)
  if (!artist) throw new Error('Artist no longer exists. Use music library-query with kind artists to select an available artist ID.')
  return artist
}

function mediaTrack(path: string): Track {
  const matches = live().getSnapshot().tracks.filter((track) => normalizeRelPath(track.file) === path)
  if (!matches.length) throw new Error(`No song in the library for "${path}".`)
  if (matches.length > 1) throw new Error(`Ambiguous media path; use music play with one of these track IDs: ${matches.map((track) => track.id).join(', ')}`)
  return matches[0]
}

function favoriteTarget(title: string, exact: boolean): { track: Track; favorite: boolean } {
  const snap = live().getSnapshot(), track = title ? findTrack(snap, title, exact) : snap.currentTrack
  if (!track) throw new Error('No track to favorite (nothing playing and no title given).')
  return { track, favorite: snap.favorites.has(track.id) }
}

function playablePlaylist(snap: MusicSnapshot, playlist: Playlist): { playlist: Playlist; tracks: Track[] } {
  const tracks = snap.playlistTracks[playlist.id] ?? []
  if (tracks.length === 0) throw new Error(`Playlist "${playlist.name}" has no playable tracks.`)
  return { playlist, tracks }
}

function selectedPlaylist(store: MusicStore): { playlist: Playlist; tracks: Track[] } {
  const target = store.getFocusedPlaylist()
  if (!target) throw new Error('No selected playlist. Open or right-click a playlist first.')
  if (target.tracks.length === 0) {
    throw new Error(`Playlist "${target.playlist.name}" has no playable tracks.`)
  }
  return target
}

async function runPlaylistAction(
  store: MusicStore,
  target: { playlist: Playlist; tracks: Track[] },
  action: PlaylistAction,
  index = 0
): Promise<PlaylistActionResult> {
  const { playlist, tracks } = target
  if (action === 'play') {
    const at = Math.min(Math.max(index, 0), tracks.length - 1)
    store.playQueue(tracks, at, playlist.id)
    await executed(store, undefined)
    return { action, playlist, count: tracks.length, started: store.getSnapshot().currentTrack ?? tracks[at] }
  }
  if (action === 'shuffle') {
    store.playShuffledQueue(tracks, playlist.id, index)
    await executed(store, undefined)
    return { action, playlist, count: tracks.length, started: store.getSnapshot().currentTrack ?? tracks[0] }
  }
  store.setFocusedPlaylist(playlist.id)
  store.addTracksToQueue(tracks, action === 'next' ? 'next' : 'end')
  await executed(store, undefined)
  return { action, playlist, count: tracks.length }
}

function formatPlaylistAction(v: PlaylistActionResult): string {
  if (v.action === 'play') {
    return `Playing playlist "${v.playlist.name}" (${v.count} tracks) from ${describe(v.started!)}`
  }
  if (v.action === 'shuffle') {
    return `Shuffling playlist "${v.playlist.name}" (${v.count} tracks) from ${describe(v.started!)}`
  }
  return `Queued playlist "${v.playlist.name}" ${v.action === 'next' ? 'next' : 'last'} (${v.count} tracks).`
}

async function executed<T>(store: MusicStore, value: T | (() => T)): Promise<T> {
  if (!(await store.flushPersistence())) throw store.playbackFailureError()
  return typeof value === 'function' ? (value as () => T)() : value
}

/** Register every `music:*` command; returns a combined disposer. */
export function registerMusicCommands(api: ValleyPluginApi): () => void {
  const register = <I, O, E extends 'read' | 'write' | 'execute'>(command: PluginCommand<I, O, E> & { outputSchema: Record<string, unknown> }): (() => void) => api.commands.register(command)
  const offs = [
    register({
      id: 'play',
      outputSchema: resultObject({ played: resultFlag, track: trackResult, alternatives: resultList(trackResult) }),
      label: 'Music: Play a track by title', labelKey: 'auto.00e9d74dcb5b',
      paletteSafe: false,
      sideEffect: 'execute',
      input: {
        schema: {"type": "object", "properties": {"title": {"type": "string"}, "exact": {"type": "boolean"}}, "additionalProperties": false, "required": ["title"]},
        parse: (raw) => {
          const o = (raw ?? {}) as Record<string, unknown>
          const title = asStr(o.title).trim()
          if (!title) throw new Error('Usage: music play "<title>" [--exact]')
          return { title, exact: asBool(o.exact) }
        },
        fromCli: (args, flags) => ({ title: args.join(' ').trim(), exact: asBool(flags.exact) })
      },
      revision: ({ title, exact }) => trackIdentity(findTrack(live().getSnapshot(), title, exact)),
      preview: ({ title, exact }) => ({ action: 'play', track: findTrack(live().getSnapshot(), title, exact) }),
      run: async ({ title, exact }) => {
        const store = live()
        const snap = store.getSnapshot()
        const selected = findTrack(snap, title, exact)
        const tracks = snap.tracks
        const matches = exact
          ? tracks.filter((t) => t.title.toLowerCase() === title.toLowerCase())
          : rankTracks(tracks, title)
        store.playTrack(selected)
        return executed(store, { played: true, track: selected, alternatives: matches.filter((track) => track.id !== selected.id) })
      },
      formatCli: (v) => {
        const n = v.alternatives.length
        return `Now playing: ${describe(v.track)}${n ? ` (+${n} other match${n === 1 ? '' : 'es'})` : ''}`
      }
    }),

    register({
      id: 'playlist',
      outputSchema: playlistActionResult,
      label: 'Music: Play a playlist', labelKey: 'auto.e9b16c283438',
      paletteSafe: false,
      sideEffect: 'execute',
      input: {
        schema: {"type": "object", "properties": {"name": {"type": "string"}, "shuffle": {"type": "boolean"}, "index": {"type": "integer"}}, "additionalProperties": false, "required": ["name"]},
        parse: (raw) => {
          const o = (raw ?? {}) as Record<string, unknown>
          const name = asStr(o.name).trim()
          if (!name) throw new Error('Usage: music playlist "<name>" [--shuffle] [--index N]')
          return { name, shuffle: asBool(o.shuffle), index: asInt(o.index) ?? 0 }
        },
        fromCli: (args, flags) => ({
          name: args.join(' ').trim(),
          shuffle: asBool(flags.shuffle),
          index: asInt(flags.index) ?? 0
        })
      },
      revision: ({ name }) => playlistIdentity(name),
      preview: ({ name, shuffle, index }) => ({ ...playlistActionPreview(name, shuffle ? 'shuffle' : 'play'), index }),
      run: async ({ name, shuffle, index }) => {
        const store = live()
        const snap = store.getSnapshot()
        const target = playablePlaylist(snap, findPlaylist(snap, name))
        return runPlaylistAction(store, target, shuffle ? 'shuffle' : 'play', index)
      },
      formatCli: formatPlaylistAction
    }),

    register({
      id: 'playlist-shuffle',
      outputSchema: playlistActionResult,
      label: 'Music: Shuffle a playlist', labelKey: 'auto.25fc9c991710',
      paletteSafe: false,
      sideEffect: 'execute',
      input: playlistInput('Usage: music playlist-shuffle "<name>"'),
      revision: ({ name }) => playlistIdentity(name),
      preview: ({ name }) => playlistActionPreview(name, 'shuffle'),
      run: async ({ name }) => {
        const store = live()
        const snap = store.getSnapshot()
        return runPlaylistAction(store, playablePlaylist(snap, findPlaylist(snap, name)), 'shuffle')
      },
      formatCli: formatPlaylistAction
    }),

    register({
      id: 'playlist-next',
      outputSchema: playlistActionResult,
      label: 'Music: Play playlist next', labelKey: 'auto.2ec8347ba0e8',
      paletteSafe: false,
      sideEffect: 'execute',
      input: playlistInput('Usage: music playlist-next "<name>"'),
      revision: ({ name }) => playlistIdentity(name),
      preview: ({ name }) => playlistActionPreview(name, 'next'),
      run: async ({ name }) => {
        const store = live()
        const snap = store.getSnapshot()
        return runPlaylistAction(store, playablePlaylist(snap, findPlaylist(snap, name)), 'next')
      },
      formatCli: formatPlaylistAction
    }),

    register({
      id: 'playlist-last',
      outputSchema: playlistActionResult,
      label: 'Music: Play playlist last', labelKey: 'auto.cec18ecfe628',
      paletteSafe: false,
      sideEffect: 'execute',
      input: playlistInput('Usage: music playlist-last "<name>"'),
      revision: ({ name }) => playlistIdentity(name),
      preview: ({ name }) => playlistActionPreview(name, 'last'),
      run: async ({ name }) => {
        const store = live()
        const snap = store.getSnapshot()
        return runPlaylistAction(store, playablePlaylist(snap, findPlaylist(snap, name)), 'last')
      },
      formatCli: formatPlaylistAction
    }),

    register({
      id: 'selected-playlist-play',
      outputSchema: playlistActionResult,
      label: 'Music: Play selected playlist', labelKey: 'auto.7bc86b4f19b0',
      sideEffect: 'execute',
      revision: () => playlistIdentity(selectedPlaylist(live()).playlist.id),
      preview: () => playlistActionPreview(selectedPlaylist(live()).playlist.id, 'play'),
      run: async () => {
        const store = live()
        return runPlaylistAction(store, selectedPlaylist(store), 'play')
      },
      formatCli: formatPlaylistAction
    }),

    register({
      id: 'selected-playlist-shuffle',
      outputSchema: playlistActionResult,
      label: 'Music: Shuffle selected playlist', labelKey: 'auto.ac48461321a4',
      sideEffect: 'execute',
      revision: () => playlistIdentity(selectedPlaylist(live()).playlist.id),
      preview: () => playlistActionPreview(selectedPlaylist(live()).playlist.id, 'shuffle'),
      run: async () => {
        const store = live()
        return runPlaylistAction(store, selectedPlaylist(store), 'shuffle')
      },
      formatCli: formatPlaylistAction
    }),

    register({
      id: 'selected-playlist-next',
      outputSchema: playlistActionResult,
      label: 'Music: Play selected playlist next', labelKey: 'auto.c6984153ca04',
      sideEffect: 'execute',
      revision: () => playlistIdentity(selectedPlaylist(live()).playlist.id),
      preview: () => playlistActionPreview(selectedPlaylist(live()).playlist.id, 'next'),
      run: async () => {
        const store = live()
        return runPlaylistAction(store, selectedPlaylist(store), 'next')
      },
      formatCli: formatPlaylistAction
    }),

    register({
      id: 'selected-playlist-last',
      outputSchema: playlistActionResult,
      label: 'Music: Play selected playlist last', labelKey: 'auto.8ceadb633b0c',
      sideEffect: 'execute',
      revision: () => playlistIdentity(selectedPlaylist(live()).playlist.id),
      preview: () => playlistActionPreview(selectedPlaylist(live()).playlist.id, 'last'),
      run: async () => {
        const store = live()
        return runPlaylistAction(store, selectedPlaylist(store), 'last')
      },
      formatCli: formatPlaylistAction
    }),

    register({
      id: 'create-playlist',
      outputSchema: playlistHolderResult,
      label: 'Music: Create playlist', labelKey: 'auto.87950a47031c',
      paletteSafe: false,
      sideEffect: 'write',
      input: playlistInput('Usage: music create-playlist "<name>"'),
      revision: ({ name }) => live().getSnapshot().playlists.filter((playlist) => playlist.name.toLowerCase() === name.toLowerCase()).map((playlist) => playlist.id).sort(),
      preview: ({ name }) => ({ action: 'create-playlist', name }),
      run: async ({ name }) => {
        const store = live()
        const id = await store.createPlaylist(name)
        if (!id) throw new Error('Playlist name is required.')
        const playlist = store.getSnapshot().playlists.find((p) => p.id === id)
        if (!playlist) throw new Error('Playlist was not created.')
        return {
          value: { playlist },
          revert: {
            label: `Delete playlist "${playlist.name}"`,
            run: async () => {
              await store.deletePlaylistDirect(id)
            }
          }
        }
      },
      formatCli: (v) => `Created playlist "${v.playlist.name}" [${v.playlist.id}]`
    }),

    register({
      id: 'rename-playlist',
      outputSchema: resultObject({ playlist: playlistResult, previousName: resultText }),
      label: 'Music: Rename playlist', labelKey: 'auto.87580398b719',
      paletteSafe: false,
      sideEffect: 'write',
      input: {
        schema: {"type": "object", "properties": {"name": {"type": "string"}, "newName": {"type": "string"}}, "additionalProperties": false, "required": ["name"]},
        parse: (raw) => {
          const o = (raw ?? {}) as Record<string, unknown>
          const name = asStr(o.name).trim()
          const nextName = asStr(o.newName ?? o.to).trim()
          if (!name || !nextName) throw new Error('Usage: music rename-playlist "<name>" --to "<new name>"')
          return { name, newName: nextName }
        },
        fromCli: (args, flags) => ({ name: args.join(' ').trim(), newName: asStr(flags.to).trim() })
      },
      run: async ({ name, newName }) => {
        const store = live()
        const playlist = findPlaylist(store.getSnapshot(), name)
        const previousName = playlist.name
        await store.renamePlaylist(playlist.id, newName)
        const renamed = store.getSnapshot().playlists.find((p) => p.id === playlist.id) ?? playlist
        return {
          value: { playlist: renamed, previousName },
          revert: {
            label: `Rename playlist "${renamed.name}" back to "${previousName}"`,
            run: async () => {
              await store.renamePlaylist(playlist.id, previousName)
            }
          }
        }
      },
      revision: ({ name }) => { const playlist = findPlaylist(live().getSnapshot(), name); return { id: playlist.id, name: playlist.name } },
      preview: ({ name, newName }) => ({ playlist: findPlaylist(live().getSnapshot(), name), newName }),
      formatCli: (v) => `Renamed playlist "${v.previousName}" to "${v.playlist.name}".`
    }),

    register({
      id: 'delete-playlist',
      outputSchema: playlistHolderResult,
      label: 'Music: Delete playlist', labelKey: 'auto.da813e206e1e',
      paletteSafe: false,
      sideEffect: 'write',
      input: playlistInput('Usage: music delete-playlist "<name>"'),
      revision: ({ name }) => findPlaylist(live().getSnapshot(), name),
      preview: ({ name }) => ({ action: 'delete-playlist', playlist: findPlaylist(live().getSnapshot(), name) }),
      run: async ({ name }) => {
        const store = live()
        const playlist = findPlaylist(store.getSnapshot(), name)
        const ok = await store.deletePlaylistDirect(playlist.id)
        if (!ok) throw new Error(`Could not delete playlist "${playlist.name}".`)
        return {
          value: { playlist },
          revert: {
            label: `Restore playlist "${playlist.name}"`,
            run: async () => {
              await store.restorePlaylist(playlist)
            }
          }
        }
      },
      formatCli: (v) => `Deleted playlist "${v.playlist.name}".`
    }),

    register({
      id: 'clear-playlist',
      outputSchema: resultObject({ playlist: playlistResult, removed: resultCount }),
      label: 'Music: Clear playlist', labelKey: 'auto.d9a0b7fbd7c2',
      paletteSafe: false,
      sideEffect: 'write',
      input: playlistInput('Usage: music clear-playlist "<name>"'),
      revision: ({ name }) => playlistSongs(name),
      preview: ({ name }) => ({ action: 'clear-playlist', ...playlistSongs(name) }),
      run: async ({ name }) => {
        const store = live()
        const playlist = findPlaylist(store.getSnapshot(), name)
        const previousIds = [...playlist.songIds]
        await store.reorderPlaylist(playlist.id, [])
        return {
          value: { playlist: { ...playlist, songIds: [] }, removed: previousIds.length },
          revert: {
            label: `Restore playlist "${playlist.name}" songs`,
            run: async () => {
              await store.reorderPlaylist(playlist.id, previousIds)
            }
          }
        }
      },
      formatCli: (v) => `Cleared ${v.removed} song${v.removed === 1 ? '' : 's'} from "${v.playlist.name}".`
    }),

    register({
      id: 'add-to-playlist',
      outputSchema: resultObject({ playlist: playlistResult, track: trackResult }),
      label: 'Music: Add song to playlist', labelKey: 'auto.75734f5defb3',
      paletteSafe: false,
      sideEffect: 'write',
      input: {
        schema: {"type": "object", "properties": {"playlist": {"type": "string"}, "query": {"type": "string"}, "exact": {"type": "boolean"}}, "additionalProperties": false, "required": ["playlist"]},
        parse: (raw) => {
          const o = (raw ?? {}) as Record<string, unknown>
          const playlist = asStr(o.playlist ?? o.name).trim()
          const query = asStr(o.query ?? o.title).trim()
          if (!playlist || !query) throw new Error('Usage: music add-to-playlist "<playlist>" --song "<title>"')
          return { playlist, query, exact: asBool(o.exact) }
        },
        fromCli: (args, flags) => ({ playlist: args.join(' ').trim(), query: asStr(flags.song || flags.title).trim(), exact: asBool(flags.exact) })
      },
      run: async ({ playlist: playlistQuery, query, exact }) => {
        const store = live()
        const snap = store.getSnapshot()
        const playlist = findPlaylist(snap, playlistQuery)
        const track = findTrack(snap, query, exact)
        if (playlist.songIds.includes(track.id)) throw new Error(`"${describe(track)}" is already in "${playlist.name}".`)
        const previousIds = [...playlist.songIds]
        await store.addToPlaylist(playlist.id, track.id)
        return {
          value: { playlist, track },
          revert: {
            label: `Restore playlist "${playlist.name}" songs`,
            run: async () => {
              await store.reorderPlaylist(playlist.id, previousIds)
            }
          }
        }
      },
      revision: ({ playlist, query, exact }) => ({ playlist: playlistSongs(playlist), track: trackIdentity(findTrack(live().getSnapshot(), query, exact)) }),
      preview: ({ playlist, query, exact }) => ({ action: 'add-to-playlist', playlist: playlistSongs(playlist), track: findTrack(live().getSnapshot(), query, exact) }),
      formatCli: (v) => `Added ${describe(v.track)} to "${v.playlist.name}".`
    }),

    register({
      id: 'remove-from-playlist',
      outputSchema: resultObject({ playlist: playlistResult, track: trackResult }),
      label: 'Music: Remove song from playlist', labelKey: 'auto.f780dfb68950',
      paletteSafe: false,
      sideEffect: 'write',
      input: {
        schema: {"type": "object", "properties": {"playlist": {"type": "string"}, "query": {"type": "string"}, "exact": {"type": "boolean"}}, "additionalProperties": false, "required": ["playlist"]},
        parse: (raw) => {
          const o = (raw ?? {}) as Record<string, unknown>
          const playlist = asStr(o.playlist ?? o.name).trim()
          const query = asStr(o.query ?? o.title).trim()
          if (!playlist || !query) throw new Error('Usage: music remove-from-playlist "<playlist>" --song "<title>"')
          return { playlist, query, exact: asBool(o.exact) }
        },
        fromCli: (args, flags) => ({ playlist: args.join(' ').trim(), query: asStr(flags.song || flags.title).trim(), exact: asBool(flags.exact) })
      },
      run: async ({ playlist: playlistQuery, query, exact }) => {
        const store = live()
        const snap = store.getSnapshot()
        const playlist = findPlaylist(snap, playlistQuery)
        const track = findTrack(snap, query, exact)
        if (!playlist.songIds.includes(track.id)) throw new Error(`"${describe(track)}" is not in "${playlist.name}".`)
        const previousIds = [...playlist.songIds]
        await store.removeFromPlaylist(playlist.id, track.id)
        return {
          value: { playlist, track },
          revert: {
            label: `Restore playlist "${playlist.name}" songs`,
            run: async () => {
              await store.reorderPlaylist(playlist.id, previousIds)
            }
          }
        }
      },
      revision: ({ playlist, query, exact }) => ({ playlist: playlistSongs(playlist), track: trackIdentity(findTrack(live().getSnapshot(), query, exact)) }),
      preview: ({ playlist, query, exact }) => ({ action: 'remove-from-playlist', playlist: playlistSongs(playlist), track: findTrack(live().getSnapshot(), query, exact) }),
      formatCli: (v) => `Removed ${describe(v.track)} from "${v.playlist.name}".`
    }),

    // ── Single-track queue ops (play next / add to queue / remove) ───────────
    register({
      id: 'play-next',
      outputSchema: trackHolderResult,
      label: 'Music: Play track next', labelKey: 'auto.b8b8d3f93183',
      paletteSafe: false,
      sideEffect: 'execute',
      input: trackInput('Usage: music play-next "<title>"'),
      revision: ({ title, exact }) => trackIdentity(findTrack(live().getSnapshot(), title, exact)),
      preview: ({ title, exact }) => ({ action: 'queue-next', track: findTrack(live().getSnapshot(), title, exact) }),
      run: async ({ title, exact }) => {
        const store = live()
        const track = findTrack(store.getSnapshot(), title, exact)
        store.addToQueue(track, 'next')
        return executed(store, { track })
      },
      formatCli: (v) => `Up next: ${describe(v.track)}`
    }),

    register({
      id: 'play-last',
      outputSchema: trackHolderResult,
      label: 'Music: Add track to the end of the queue', labelKey: 'auto.a7218d13dbec',
      paletteSafe: false,
      sideEffect: 'execute',
      input: trackInput('Usage: music play-last "<title>"'),
      revision: ({ title, exact }) => trackIdentity(findTrack(live().getSnapshot(), title, exact)),
      preview: ({ title, exact }) => ({ action: 'queue-last', track: findTrack(live().getSnapshot(), title, exact) }),
      run: async ({ title, exact }) => {
        const store = live()
        const track = findTrack(store.getSnapshot(), title, exact)
        store.addToQueue(track, 'end')
        return executed(store, { track })
      },
      formatCli: (v) => `Added to queue: ${describe(v.track)}`
    }),

    register({
      id: 'remove-from-queue',
      outputSchema: resultObject({ track: trackResult, position: { type: 'integer', minimum: 1 } }),
      label: 'Music: Remove a track from the queue', labelKey: 'auto.95c300486760',
      paletteSafe: false,
      sideEffect: 'execute',
      input: {
        schema: { type: 'object', properties: { title: { type: 'string' }, query: { type: 'string' }, index: { type: 'integer', minimum: 1 }, position: { type: 'integer', minimum: 1 } }, anyOf: [{ required: ['title'] }, { required: ['query'] }, { required: ['index'] }, { required: ['position'] }], additionalProperties: false },
        parse: (raw) => {
          const o = (raw ?? {}) as Record<string, unknown>
          const title = asStr(o.title ?? o.query).trim()
          const rawIndex = o.index ?? o.position
          const index = rawIndex === undefined ? undefined : Number(rawIndex)
          if (index !== undefined && (!Number.isInteger(index) || index < 1)) throw new Error('Queue positions start at 1. Use music queue to see available positions.')
          if (!title && index == null) throw new Error('Usage: music remove-from-queue "<title>" | --index N')
          return { title, index }
        },
        fromCli: (args, flags) => ({ title: args.join(' ').trim(), index: flags.index ?? flags.position })
      },
      revision: ({ title, index }) => { const selected = queueSelection(live().getSnapshot(), title, index); return { track: trackIdentity(selected.track), ...(index === undefined ? {} : { position: selected.position }) } },
      preview: ({ title, index }) => ({ action: 'remove-from-queue', ...queueSelection(live().getSnapshot(), title, index) }),
      run: async ({ title, index }) => {
        const store = live()
        const selected = queueSelection(store.getSnapshot(), title, index)
        store.removeFromQueue(selected.position - 1)
        return executed(store, selected)
      },
      formatCli: (v) => `Removed from queue: ${describe(v.track)}`
    }),

    register({
      id: 'clear-queue',
      outputSchema: resultObject({ removed: resultCount }),
      label: 'Music: Clear the up-next queue', labelKey: 'auto.bd9364b123f3',
      paletteSafe: false,
      sideEffect: 'execute',
      revision: queueIdentity,
      preview: () => ({ action: 'clear-queue', songIds: queueIdentity() }),
      run: async () => {
        const store = live()
        const removed = store.getSnapshot().upNext.length
        store.clearQueue()
        return executed(store, { removed })
      },
      formatCli: (v) => `Cleared ${v.removed} track${v.removed === 1 ? '' : 's'} from the queue.`
    }),

    // ── Playlist cover + track favorites ────────────────────────────────────
    register({
      id: 'set-cover',
      outputSchema: resultObject({ playlist: playlistResult, cover: nullableResult(resultText) }),
      label: 'Music: Set or clear a playlist cover', labelKey: 'auto.239e092def6b',
      paletteSafe: false,
      sideEffect: 'write',
      input: {
        schema: {"type": "object", "properties": {"name": {"type": "string"}, "cover": {"type": "string"}}, "additionalProperties": false, "required": ["name"]},
        parse: (raw) => {
          const o = (raw ?? {}) as Record<string, unknown>
          const name = asStr(o.name ?? o.playlist).trim()
          const cover = asStr(o.cover ?? o.path ?? o.image).trim()
          if (!name) throw new Error('Usage: music set-cover "<playlist>" --image "<file>"')
          return { name, cover }
        },
        fromCli: (args, flags) => ({ name: args.join(' ').trim(), cover: asStr(flags.image ?? flags.cover ?? flags.path).trim() })
      },
      revision: ({ name }) => { const playlist = findPlaylist(live().getSnapshot(), name); return { id: playlist.id, cover: playlist.cover ?? null } },
      preview: ({ name, cover }) => ({ playlist: findPlaylist(live().getSnapshot(), name), cover: cover || null }),
      run: async ({ name, cover }) => {
        const store = live()
        const playlist = findPlaylist(store.getSnapshot(), name)
        const previous = playlist.cover ?? null
        await store.setPlaylistCover(playlist.id, cover || null)
        return {
          value: { playlist, cover: cover || null },
          revert: {
            label: `Restore "${playlist.name}" cover`,
            run: async () => {
              await store.setPlaylistCover(playlist.id, previous)
            }
          }
        }
      },
      formatCli: (v) => (v.cover ? `Set cover for "${v.playlist.name}" to ${v.cover}.` : `Cleared cover for "${v.playlist.name}".`)
    }),

    register({
      id: 'favorite',
      outputSchema: resultObject({ track: trackResult, favorite: resultFlag }),
      label: 'Music: Favorite or unfavorite a track', labelKey: 'auto.4afec04c5724',
      paletteSafe: false,
      sideEffect: 'write',
      input: {
        schema: {"type": "object", "properties": {"title": {"type": "string"}, "on": {"type": "boolean"}, "exact": {"type": "boolean"}}, "additionalProperties": false},
        parse: (raw) => {
          const o = (raw ?? {}) as Record<string, unknown>
          const title = asStr(o.title ?? o.query).trim()
          const on = o.on == null && o.favorite == null ? null : asBool(o.on ?? o.favorite)
          return { title, on, exact: asBool(o.exact) }
        },
        fromCli: (args, flags) => ({
          title: args.join(' ').trim(),
          on: flags.off ? false : flags.on ? true : null,
          exact: asBool(flags.exact)
        })
      },
      revision: ({ title, exact }) => { const target = favoriteTarget(title, exact); return { track: trackIdentity(target.track), favorite: target.favorite } },
      preview: ({ title, on, exact }) => { const target = favoriteTarget(title, exact); return { track: target.track, previous: target.favorite, favorite: on ?? !target.favorite } },
      run: async ({ title, on, exact }) => {
        const store = live()
        const { track, favorite: current } = favoriteTarget(title, exact)
        const want = on == null ? !current : on
        if (want !== current) await store.toggleFavorite(track.id)
        return {
          value: { track, favorite: want },
          revert:
            want === current
              ? null
              : {
                  label: `${want ? 'Unfavorite' : 'Favorite'} ${describe(track)}`,
                  run: async () => {
                    await store.toggleFavorite(track.id)
                  }
                }
        }
      },
      formatCli: (v) => `${v.favorite ? '♥ Favorited' : '♡ Unfavorited'} ${describe(v.track)}`
    }),

    register({
      id: 'resume',
      outputSchema: resultObject({ playing: resultFlag, track: nullableResult(trackResult), resumed: resultFlag }),
      label: 'Music: Resume', labelKey: 'auto.9bfab6b5a9c7',
      sideEffect: 'execute',
      revision: playbackIdentity,
      preview: () => ({ action: 'resume', ...playbackIdentity() }),
      run: async () => {
        const store = live()
        const snap = store.getSnapshot()
        if (!snap.currentTrack) {
          return executed<{ playing: boolean; track: Track | null; resumed: boolean }>(
            store,
            { playing: false, track: null, resumed: false }
          )
        }
        if (snap.isPlaying) {
          return executed<{ playing: boolean; track: Track | null; resumed: boolean }>(
            store,
            { playing: true, track: snap.currentTrack, resumed: false }
          )
        }
        const exhausted = snap.duration > 0 && snap.currentTime >= snap.duration && !snap.upNext.length && snap.repeatMode === 'off'
        store.resumeLast()
        return executed<{ playing: boolean; track: Track | null; resumed: boolean }>(
          store,
          () => {
            const current = store.getSnapshot()
            if (!current.isPlaying && exhausted && current.currentTrack?.id === snap.currentTrack?.id) return { playing: false, track: current.currentTrack, resumed: false }
            const finished = current.duration > 0 && current.currentTime >= current.duration
            if (!current.isPlaying && !finished) throw Object.assign(new Error('Playback outcome is unknown: the player did not confirm playing. Check the player before trying again.'), { outcome: 'unknown', outcomeUnknown: true, retryable: false })
            return { playing: current.isPlaying, track: current.currentTrack, resumed: true }
          }
        )
      },
      formatCli: (v) =>
        !v.track ? 'Nothing to resume.' : v.resumed ? `${v.playing ? 'Resumed' : 'Played to end'}: ${describe(v.track)}` : v.playing ? 'Already playing.' : `Nothing left to play after ${describe(v.track)}.`
    }),

    register({
      id: 'pause',
      outputSchema: resultObject({ playing: resultFlag, already: resultFlag }),
      label: 'Music: Pause', labelKey: 'auto.19b6e93580d6',
      sideEffect: 'execute',
      revision: playbackIdentity,
      preview: () => ({ action: 'pause', ...playbackIdentity() }),
      run: async () => {
        const store = live()
        const already = !store.getSnapshot().isPlaying
        store.pause()
        return executed(store, () => ({ playing: store.getSnapshot().isPlaying, already }))
      },
      formatCli: (v) => (v.already ? 'Already paused.' : 'Paused.')
    }),

    register({
      id: 'toggle',
      outputSchema: resultObject({ playing: resultFlag }),
      label: 'Music: Toggle play/pause', labelKey: 'auto.65b6a2ac6520',
      sideEffect: 'execute',
      revision: playbackIdentity,
      preview: () => ({ action: 'toggle-playback', ...playbackIdentity() }),
      run: async () => {
        const store = live()
        store.togglePlay()
        await executed(store, undefined)
        return { playing: store.getSnapshot().isPlaying }
      },
      formatCli: (v) => (v.playing ? 'Playing.' : 'Paused.')
    }),

    register({
      id: 'stop',
      outputSchema: nullResult,
      label: 'Music: Stop (keeps queue)', labelKey: 'auto.fadd24d8b9d6',
      sideEffect: 'execute',
      revision: () => ({ playback: playbackIdentity(), queue: queueIdentity() }),
      preview: () => ({ action: 'stop-keep-queue', track: playbackIdentity().track, songIds: queueIdentity() }),
      run: async () => {
        const store = live()
        store.stop()
        return executed(store, null)
      },
      formatCli: () => 'Stopped.'
    }),

    register({
      id: 'skip',
      outputSchema: resultObject({ track: nullableResult(trackResult) }),
      label: 'Music: Next track', labelKey: 'auto.44b369ff5538',
      sideEffect: 'execute',
      revision: () => ({ track: playbackIdentity().track, queue: queueIdentity(), repeat: live().getSnapshot().repeatMode }),
      preview: () => ({ action: 'next-track', track: playbackIdentity().track, songIds: queueIdentity(), repeat: live().getSnapshot().repeatMode }),
      run: async () => {
        const store = live()
        const snap = store.getSnapshot()
        const last = !snap.upNext.length && snap.repeatMode === 'off'
        store.next()
        return executed(store, () => ({ track: last ? null : store.getSnapshot().currentTrack }))
      },
      formatCli: (v) => (v.track ? `→ ${describe(v.track)}` : 'End of queue.')
    }),

    register({
      id: 'back',
      outputSchema: resultObject({ track: nullableResult(trackResult) }),
      label: 'Music: Previous track', labelKey: 'auto.571421e4405b',
      sideEffect: 'execute',
      revision: () => ({ track: playbackIdentity().track, queue: queueIdentity(), repeat: live().getSnapshot().repeatMode }),
      preview: () => ({ action: 'previous-track-or-restart', track: playbackIdentity().track, repeat: live().getSnapshot().repeatMode }),
      run: async () => {
        const store = live()
        store.prev()
        return executed(store, () => ({ track: store.getSnapshot().currentTrack }))
      },
      formatCli: (v) => (v.track ? `← ${describe(v.track)}` : 'Start of queue.')
    }),

    register({
      id: 'shuffle',
      outputSchema: resultObject({ shuffle: resultFlag }),
      label: 'Music: Toggle shuffle', labelKey: 'auto.dbb071bdf7c8',
      sideEffect: 'execute',
      input: {
        schema: {"type": "object", "properties": {"mode": {"type": "string"}}, "additionalProperties": false},
        parse: (raw) => {
          const mode = asStr((raw as Record<string, unknown> | undefined)?.mode || 'toggle').toLowerCase()
          if (mode !== 'on' && mode !== 'off' && mode !== 'toggle') {
            throw new Error('Usage: music shuffle on|off|toggle')
          }
          return { mode: mode as 'on' | 'off' | 'toggle' }
        },
        fromCli: (args) => ({ mode: (args[0] ?? 'toggle').toLowerCase() })
      },
      revision: () => ({ shuffle: live().getSnapshot().shuffle, queue: queueIdentity() }),
      preview: ({ mode }) => ({ previous: live().getSnapshot().shuffle, shuffle: mode === 'toggle' ? !live().getSnapshot().shuffle : mode === 'on' }),
      run: async ({ mode }) => {
        const store = live()
        const on = store.getSnapshot().shuffle
        if ((mode === 'on' && !on) || (mode === 'off' && on) || mode === 'toggle') store.toggleShuffle()
        return executed(store, () => ({ shuffle: store.getSnapshot().shuffle }))
      },
      formatCli: (v) => `Shuffle ${v.shuffle ? 'on' : 'off'}`
    }),

    register({
      id: 'volume',
      outputSchema: resultObject({ volume: { type: 'number', minimum: 0, maximum: 100 } }),
      label: 'Music: Set volume', labelKey: 'auto.d6585be54114',
      paletteSafe: false,
      sideEffect: 'execute',
      input: {
        schema: {"type": "object", "properties": {"level": {"type": "number"}}, "additionalProperties": false, "required": ["level"]},
        parse: (raw) => {
          const level = asInt((raw as Record<string, unknown> | undefined)?.level)
          if (level === undefined || level < 0 || level > 100) throw new Error('Usage: music volume <0-100>')
          return { level }
        },
        fromCli: (args) => ({ level: asInt(args[0]) })
      },
      revision: () => live().getSnapshot().volume,
      preview: ({ level }) => ({ previous: live().getSnapshot().volume * 100, volume: level }),
      run: async ({ level }) => {
        const store = live()
        store.setVolume(level / 100)
        return executed(store, { volume: level })
      },
      formatCli: (v) => `Volume ${v.volume}%`
    }),

    register({
      id: 'seek',
      outputSchema: resultObject({ position: resultNumber }),
      label: 'Music: Seek', labelKey: 'auto.e845ef00118e',
      paletteSafe: false,
      sideEffect: 'execute',
      input: {
        schema: {"type": "object", "properties": {"seconds": {"type": "number"}}, "additionalProperties": false, "required": ["seconds"]},
        parse: (raw) => {
          const seconds = asInt((raw as Record<string, unknown> | undefined)?.seconds)
          if (seconds === undefined || seconds < 0) throw new Error('Usage: music seek <seconds>')
          return { seconds }
        },
        fromCli: (args) => ({ seconds: asInt(args[0]) })
      },
      revision: playbackIdentity,
      preview: ({ seconds }) => ({ action: 'seek', seconds, ...playbackIdentity() }),
      run: async ({ seconds }) => {
        const store = live()
        store.seek(seconds)
        await executed(store, undefined)
        return { position: store.getSnapshot().currentTime }
      },
      formatCli: (v) => `Seeked to ${fmtTime(v.position)}`
    }),

    register({
      id: 'now',
      outputSchema: resultObject({ track: nullableResult(trackResult), position: resultNumber, duration: resultNumber, playing: resultFlag, playlist: nullableResult(resultText), shuffle: resultFlag }),
      label: 'Music: Now playing', labelKey: 'auto.003b2f036c2d',
      sideEffect: 'read',
      run: () => {
        const snap = live().getSnapshot()
        return {
          track: snap.currentTrack,
          position: playbackPosition({ position: snap.currentTime, duration: snap.duration, rate: snap.playbackRate, playing: snap.isPlaying, buffering: snap.buffering, sampleAgeMs: snap.playbackSampleAge }, snap.playbackSampledAt),
          duration: snap.duration,
          playing: snap.isPlaying,
          playlist: playlistName(snap, snap.currentPlaylistId),
          shuffle: snap.shuffle
        }
      },
      formatCli: (v) => {
        if (!v.track) return 'Nothing playing.'
        return [
          `${v.playing ? '▶' : '⏸'} ${describe(v.track)}`,
          `   ${fmtTime(v.position)}/${fmtTime(v.duration)}${v.playlist ? ` · playlist: ${v.playlist}` : ''}${v.shuffle ? ' · shuffle' : ''}`
        ].join('\n')
      }
    }),

    register({
      id: 'queue',
      outputSchema: resultList(trackResult),
      label: 'Music: Show queue', labelKey: 'auto.ec8ca3c99941',
      paletteSafe: false,
      sideEffect: 'read',
      run: (): Track[] => live().getSnapshot().upNext,
      formatCli: (tracks) =>
        tracks.length === 0
	          ? 'Queue is empty.'
	          : ['Up next:', ...tracks.slice(0, 10).map((t, i) => `  ${i + 1}. ${describe(t)}`)].join('\n')
    }),

    register({
      id: 'search',
      outputSchema: resultObject({ query: resultText, tracks: resultList(trackResult, 80), artists: resultList(artistSummaryResult, 120), playlists: resultList(playlistResult, 80) }),
      label: 'Music: Search', labelKey: 'auto.8e95b189b541',
      paletteSafe: false,
      sideEffect: 'read',
      input: {
        schema: {"type": "object", "properties": {"query": {"type": "string"}}, "additionalProperties": false, "required": ["query"]},
        parse: (raw) => {
          const query = asStr((raw as Record<string, unknown> | undefined)?.query ?? (raw as Record<string, unknown> | undefined)?.search).trim()
          if (!query) throw new Error('Usage: music search "<query>"')
          return { query }
        },
        fromCli: (args) => ({ query: args.join(' ').trim() })
      },
      run: ({ query }): MusicSearchResult => searchLibrary(live().getSnapshot(), query),
      formatCli: formatSearch
    }),

    register({
      id: 'songs',
      outputSchema: resultList(trackResult, 80),
      label: 'Music: List songs', labelKey: 'auto.20b2c4085081',
      paletteSafe: false,
      sideEffect: 'read',
      input: optionalSearchInput(),
      run: ({ search }): Track[] => rankTracks(live().getSnapshot().tracks, search).slice(0, SONG_LIMIT),
      formatCli: formatTracks
    }),

    register({
      id: 'artists',
      outputSchema: resultList(artistSummaryResult, 120),
      label: 'Music: List artists', labelKey: 'auto.bb7b0429d265',
      paletteSafe: false,
      sideEffect: 'read',
      input: optionalSearchInput(),
      run: ({ search }): ArtistSummary[] => artistsFor(live().getSnapshot().tracks, search).slice(0, ARTIST_LIMIT),
      formatCli: formatArtists
    }),

    register({
      id: 'library',
      outputSchema: resultList(trackResult, 80),
      label: 'Music: Search library', labelKey: 'auto.a78b738a8195',
      paletteSafe: false,
      sideEffect: 'read',
      input: optionalSearchInput(),
      run: ({ search }): Track[] => rankTracks(live().getSnapshot().tracks, search).slice(0, SONG_LIMIT),
      formatCli: formatTracks
    }),

    register({
      id: 'playlists',
      outputSchema: resultList(playlistResult, 80),
      label: 'Music: List playlists', labelKey: 'auto.831a0dbf6563',
      paletteSafe: false,
      sideEffect: 'read',
      input: optionalSearchInput(),
      run: ({ search }): Playlist[] => rankPlaylists(live().getSnapshot().playlists, search).slice(0, PLAYLIST_LIMIT),
      formatCli: formatPlaylists
    }),

    register({
      id: 'refresh',
      outputSchema: resultObject({ added: resultCount, missing: resultCount }),
      label: 'Music: Refresh library', labelKey: 'auto.20f8f918db22',
      sideEffect: 'write',
      revision: () => live().getSnapshot().musicPath,
      preview: () => ({ action: 'refresh-library', path: live().getSnapshot().musicPath }),
      run: async () => {
        const before = live().getSnapshot().tracks.length
        await live().syncLibrary()
        const snap = live().getSnapshot()
        return {
          value: { added: Math.max(0, snap.tracks.length - before), missing: snap.missing.size },
          revert: null
        }
      },
      formatCli: (v) => `Library refreshed: ${v.added} added, ${v.missing} missing.`
    }),

    register({
      id: 'open-page',
      outputSchema: nullResult,
      label: 'Open Music page', labelKey: 'auto.d427ef454124',
      sideEffect: 'execute',
      input: {
        schema: { type: 'object', properties: { newTab: { type: 'boolean', description: 'Open Music in a new tab. Without it Music takes over the active tab, or reveals its open tab.' } }, additionalProperties: false },
        parse: (raw) => ({ newTab: (raw as { newTab?: unknown } | null | undefined)?.newTab === true }),
        fromCli: (args) => ({ newTab: args.includes('--new-tab') })
      },
      run: ({ newTab }) => {
        api.workspace.openMainTab(newTab ? { newTab: true } : undefined)
        return null
      },
      formatCli: () => 'Opened music page.'
    }),

    register({
      id: 'open-media',
      outputSchema: trackHolderResult,
      label: 'Music: Open a media file', labelKey: 'auto.69aa17f58afe',
      paletteSafe: false,
      sideEffect: 'execute',
      input: {
        schema: {"type": "object", "properties": {"path": {"type": "string"}}, "additionalProperties": false, "required": ["path"]},
        parse: (raw) => {
          const o = (raw ?? {}) as Record<string, unknown>
          const path = normalizeRelPath(asStr(o.path ?? o.relPath ?? o.file))
          if (!path) throw new Error('Usage: music open-media "<vault path>"')
          return { path }
        },
        fromCli: (args) => ({ path: args.join(' ').trim() })
      },
      revision: ({ path }) => trackIdentity(mediaTrack(path)),
      preview: ({ path }) => ({ action: 'play', track: mediaTrack(path) }),
      run: async ({ path }) => {
        const store = live()
        const track = mediaTrack(path)
        store.revealSong(track.id)
        store.playTrack(track)
        api.workspace.openMainTab()
        return executed(store, { track })
      },
      formatCli: (v) => `Now playing: ${describe(v.track)}`
    }),

    // ── Open pages (navigate the Music tab, no playback) ─────────────────────
    register({
      id: 'open-playlist',
      outputSchema: playlistHolderResult,
      label: 'Music: Open a playlist page', labelKey: 'auto.a95536dbb353',
      paletteSafe: false,
      sideEffect: 'execute',
      input: playlistInput('Usage: music open-playlist "<name>"'),
      run: ({ name }) => {
        const store = live()
        const playlist = findPlaylist(store.getSnapshot(), name)
        store.showPlaylist(playlist.id)
        return { playlist }
      },
      formatCli: (v) => `Opened playlist "${v.playlist.name}".`
    }),

    register({
      id: 'open-artist',
      outputSchema: artistSummaryResult,
      label: 'Music: Open an artist page', labelKey: 'auto.79ce2d1ac730',
      paletteSafe: false,
      sideEffect: 'execute',
      input: {
        schema: {"type": "object", "properties": {"name": {"type": "string"}}, "additionalProperties": false, "required": ["name"]},
        parse: (raw) => {
          const name = asStr((raw as Record<string, unknown> | undefined)?.name).trim()
          if (!name) throw new Error('Usage: music open-artist "<name>"')
          return { name }
        },
        fromCli: (args) => ({ name: args.join(' ').trim() })
      },
      run: ({ name }) => {
        const store = live()
        const snap = store.getSnapshot()
        const entity = resolveArtist(snap.artists, name)
        const matches = tracksForArtist(snap.tracks, entity ?? { name: name.trim() })
        if (matches.length === 0) throw new Error(`No songs by "${name}".`)
        store.showArtist(entity ? entity.id : name)
        return { artist: entity?.name ?? name.trim(), count: matches.length }
      },
      formatCli: (v) => `Opened artist "${v.artist}" (${v.count} song${v.count === 1 ? '' : 's'}).`
    }),

    register({
      id: 'open-song-artist',
      outputSchema: resultObject({ song: trackResult, artist: resultText, otherArtists: resultStrings }),
      label: 'Music: Open the artist of a song', labelKey: 'auto.711daf30f609',
      paletteSafe: false,
      sideEffect: 'execute',
      input: trackInput('Usage: music open-song-artist "<title>"'),
      run: ({ title, exact }) => {
        const store = live()
        const track = findTrack(store.getSnapshot(), title, exact)
        const names = trackArtists(track)
        if (names.length === 0) throw new Error(`"${describe(track)}" has no artist.`)
        store.showArtist(names[0])
        return { song: track, artist: names[0], otherArtists: names.slice(1) }
      },
      formatCli: (v) =>
        v.otherArtists.length
          ? `Opened ${v.artist} (+${v.otherArtists.length} more credited on "${v.song.title}").`
          : `Opened ${v.artist} — artist of "${v.song.title}".`
    })
  ]
  offs.push(
    register({
      id: 'history',
      outputSchema: resultObject({ rows: resultList(resultObject({ id: resultText, songId: resultText, playedAt: resultText, playlistId: nullableResult(resultText) }, ['id', 'songId', 'playedAt']), 500), revisions: resultList(resultCount, 500), cursor: resultText, revision: resultCount }, ['rows', 'revision']), label: 'Read music play history', labelKey: 'music.surface.history', paletteSafe: false, sideEffect: 'read',
      input: {
        schema: { type: 'object', properties: { songId: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 500 }, cursor: { type: 'string' } }, additionalProperties: false },
        parse: (raw) => {
          const input = (raw ?? {}) as { songId?: unknown; limit?: unknown; cursor?: unknown }
          const limit = Number(input.limit ?? 100)
          if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500 || (input.songId !== undefined && typeof input.songId !== 'string') || (input.cursor !== undefined && typeof input.cursor !== 'string')) throw new Error('Invalid play history query')
          return { songId: input.songId as string | undefined, limit, cursor: input.cursor as string | undefined }
        }
      },
      run: ({ songId, limit, cursor }) => api.data.dataset('music.play_events').query({ ...(songId ? { where: { songId } } : {}), orderBy: [{ field: 'playedAt', direction: 'desc' }], limit, cursor })
    }),
    register({
      id: 'library-query',
      outputSchema: resultObject({ total: resultCount, rows: resultList({ anyOf: [trackResult, artistResult, playlistResult, historyResult] }, 500), nextOffset: nullableResult(resultCount) }), label: 'Query music library', labelKey: 'music.surface.library-query', paletteSafe: false, sideEffect: 'read',
      input: {
        schema: { type: 'object', properties: { kind: { enum: ['tracks', 'artists', 'playlists', 'history'] }, id: { type: 'string' }, search: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 500 }, offset: { type: 'integer', minimum: 0 } }, additionalProperties: false },
        parse: (raw) => {
          const input = (raw ?? {}) as Record<string, unknown>
          const kind = String(input.kind ?? 'tracks'), limit = Number(input.limit ?? 100), offset = Number(input.offset ?? 0)
          if (!['tracks', 'artists', 'playlists', 'history'].includes(kind) || !Number.isInteger(limit) || limit < 1 || limit > 500 || !Number.isInteger(offset) || offset < 0) throw new Error('Invalid library query')
          return { kind, id: asStr(input.id), search: asStr(input.search).toLowerCase(), limit, offset }
        }
      },
      run: ({ kind, id, search, limit, offset }) => {
        const snapshot = live().getSnapshot()
        const source = kind === 'artists' ? snapshot.artists : kind === 'playlists' ? snapshot.playlists : kind === 'history' ? snapshot.history : snapshot.tracks
        const rows = source.filter((item) => (!id || item.id === id) && (!search || JSON.stringify(item).toLowerCase().includes(search)))
        if (id && !rows.length) throw new Error(`Music item not found: ${id}`)
        return { total: rows.length, rows: structuredClone(rows.slice(offset, offset + limit)), nextOffset: offset + limit < rows.length ? offset + limit : null }
      }
    }),
    register({
      id: 'repeat',
      outputSchema: resultObject({ mode: { type: 'string', enum: ['off', 'all', 'one'] } }), label: 'Set music repeat mode', labelKey: 'music.surface.repeat', paletteSafe: false, sideEffect: 'execute',
      input: { schema: { type: 'object', properties: { mode: { enum: ['off', 'all', 'one'] } }, required: ['mode'], additionalProperties: false }, parse: (raw) => { const mode = (raw as { mode?: unknown })?.mode; if (mode !== 'off' && mode !== 'all' && mode !== 'one') throw new Error('mode must be off, all, or one'); return { mode } } },
      preview: ({ mode }) => ({ previous: live().getSnapshot().repeatMode, mode }),
      revision: () => live().getSnapshot().repeatMode,
      run: async ({ mode }) => {
        const store = live()
        for (let attempt = 0; store.getSnapshot().repeatMode !== mode && attempt < 3; attempt++) {
          store.cycleRepeat()
          await executed(store, undefined)
        }
        if (store.getSnapshot().repeatMode !== mode) throw new Error('Repeat mode changed during this command. Check the player before trying again.')
        return { mode }
      }
    }),
    register({
      id: 'queue-reorder',
      outputSchema: resultList(trackResult), label: 'Reorder music queue', labelKey: 'music.surface.queue-reorder', paletteSafe: false, sideEffect: 'execute',
      input: { schema: { type: 'object', properties: { from: { type: 'integer', minimum: 0 }, to: { type: 'integer', minimum: 0 } }, required: ['from', 'to'], additionalProperties: false }, parse: (raw) => { const input = raw as { from?: unknown; to?: unknown }; const from = Number(input?.from), to = Number(input?.to); if (!Number.isInteger(from) || from < 0 || !Number.isInteger(to) || to < 0) throw new Error('Queue indices must be nonnegative integers'); return { from, to } } },
      preview: ({ from, to }) => { const queue = queueIdentity(); if (from >= queue.length || to >= queue.length) throw new Error('Queue item no longer exists'); return { from, to, songIds: queue } },
      revision: queueIdentity,
      run: async ({ from, to }) => { const store = live(); if (from >= store.getSnapshot().upNext.length || to >= store.getSnapshot().upNext.length) throw new Error('Queue item no longer exists'); store.reorderQueue(from, to); return executed(store, () => store.getSnapshot().upNext) }
    }),
    register({
      id: 'playlist-reorder',
      outputSchema: resultObject({ id: resultText, songIds: resultStrings }), label: 'Reorder playlist tracks', labelKey: 'music.surface.playlist-reorder', paletteSafe: false, sideEffect: 'write',
      input: { schema: { type: 'object', properties: { id: { type: 'string' }, songIds: { type: 'array', items: { type: 'string' }, uniqueItems: true } }, required: ['id', 'songIds'], additionalProperties: false }, parse: (raw) => { const input = raw as { id?: unknown; songIds?: unknown }; if (typeof input?.id !== 'string' || !Array.isArray(input.songIds) || !input.songIds.every((value) => typeof value === 'string')) throw new Error('A playlist ID and ordered song IDs are required'); return { id: input.id, songIds: input.songIds as string[] } } },
      preview: (input) => input, revision: ({ id }) => playlistSongs(id),
      run: async ({ id, songIds }) => {
        const store = live(), playlist = store.getSnapshot().playlists.find((item) => item.id === id)
        if (!playlist) throw new Error('Playlist no longer exists')
        if (songIds.length !== playlist.songIds.length || new Set(songIds).size !== songIds.length || songIds.some((songId) => !playlist.songIds.includes(songId))) throw new Error('Provide each existing playlist song exactly once')
        const before = [...playlist.songIds]
        await store.reorderPlaylist(id, songIds)
        return { value: { id, songIds }, revert: { label: 'Reorder playlist', run: async () => { const current = store.getSnapshot().playlists.find((item) => item.id === id); if (!current || JSON.stringify(current.songIds) !== JSON.stringify(songIds)) throw new Error('Playlist changed after reordering'); await store.reorderPlaylist(id, before) } } }
      }
    }),
    register({
      id: 'track-delete',
      outputSchema: resultObject({ id: resultText }), label: 'Remove track from music library', labelKey: 'music.surface.track-delete', paletteSafe: false, sideEffect: 'write',
      input: { schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false }, parse: (raw) => { const id = (raw as { id?: unknown })?.id; if (typeof id !== 'string' || !id) throw new Error('Track ID is required'); return { id } } },
      preview: ({ id }) => ({ ...deletedTrackTarget(id), action: 'remove-from-library' }),
      revision: ({ id }) => deletedTrackTarget(id),
      run: async ({ id }) => { const store = live(); if (!store.getSnapshot().tracks.some((item) => item.id === id)) throw new Error('Track no longer exists'); await store.deleteSong(id); return { value: { id }, revert: null } }
    }),
    register({
      id: 'artist-update',
      outputSchema: artistResult, label: 'Update artist details', labelKey: 'music.surface.artist-update', paletteSafe: false, sideEffect: 'write',
      input: { schema: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string', minLength: 1 }, image: { type: ['string', 'null'] }, bio: { type: 'string' } }, required: ['id'], additionalProperties: false }, parse: (raw) => { const input = raw as { id?: unknown; name?: unknown; image?: unknown; bio?: unknown }; if (typeof input?.id !== 'string' || !input.id || (input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim())) || (input.image !== undefined && input.image !== null && typeof input.image !== 'string') || (input.bio !== undefined && typeof input.bio !== 'string')) throw new Error('Invalid artist fields'); return input as { id: string; name?: string; image?: string | null; bio?: string } } },
      preview: (input) => ({ previous: artistTarget(input.id), ...input }), revision: ({ id }) => artistTarget(id),
      run: async ({ id, name, image, bio }) => { const store = live(); if (!store.getSnapshot().artists.some((item) => item.id === id)) throw new Error('Artist no longer exists'); await store.updateArtistProperties(id, { ...(name === undefined ? {} : { name }), ...(image === undefined ? {} : { image: image ?? '' }), ...(bio === undefined ? {} : { bio }) }); return { value: store.getSnapshot().artists.find((item) => item.id === id), revert: null } }
    }),
    register({
      id: 'artist-merge',
      outputSchema: artistResult, label: 'Merge music artists', labelKey: 'music.surface.artist-merge', paletteSafe: false, sideEffect: 'write',
      input: { schema: { type: 'object', properties: { sourceId: { type: 'string' }, targetId: { type: 'string' } }, required: ['sourceId', 'targetId'], additionalProperties: false }, parse: (raw) => { const input = raw as { sourceId?: unknown; targetId?: unknown }; if (typeof input?.sourceId !== 'string' || typeof input.targetId !== 'string' || input.sourceId === input.targetId) throw new Error('Two distinct artist IDs are required'); return { sourceId: input.sourceId, targetId: input.targetId } } },
      preview: ({ sourceId, targetId }) => ({ action: 'merge-artists', source: artistTarget(sourceId), target: artistTarget(targetId) }),
      revision: ({ sourceId, targetId }) => ({ source: artistTarget(sourceId), target: artistTarget(targetId) }),
      run: async ({ sourceId, targetId }) => { const store = live(); if (![sourceId, targetId].every((id) => store.getSnapshot().artists.some((item) => item.id === id))) throw new Error('Artist no longer exists'); await store.mergeArtists(sourceId, targetId); return { value: store.getSnapshot().artists.find((item) => item.id === targetId), revert: null } }
    })
  )
  return () => offs.forEach((off) => off())
}
