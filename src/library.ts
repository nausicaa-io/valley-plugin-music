import type { DatasetPage, DatasetReadResult, DatasetRecord, DatasetRevisionGuard, DatasetTransactionOperation, PluginBackendApi, PluginIndexEntry } from '@valley/plugin-sdk'
import { normalizeRelPath } from '@valley/plugin-sdk/paths'
import { computeLibrarySync, mediaFilesInFolder, newTrackId, rawTitleFromFileName, trackDetailsFromFileName } from './data'
import { mergeArtistMetadata, patchArtistMetadata, sameArtist, upsertArtists } from './artists'
import type { Artist, Playlist, Track } from './types'

export type LibraryOwner = Pick<PluginBackendApi, 'data' | 'index' | 'settings'>
export type LibraryRevisions = { revision: number; membersRevision: number }
export type LibraryMetadata = { title: string | null; artist: string | null; album: string | null } | null
export type ArtistRevisions = { revision: number; aliasesRevision: number }
const tracks = 'music.tracks', playlists = 'music.playlists', members = 'music.playlist_tracks', artists = 'music.artists', aliases = 'music.artist_aliases'
const record = (value: unknown): DatasetRecord => value as DatasetRecord
export const conflict = (revision: number): never => { throw Object.assign(new Error('Music data changed; read it again before editing'), { code: 'REVISION_CONFLICT', status: 409, currentRevision: revision, outcome: 'not-applied' }) }
const revision = (value: number): void => { if (!Number.isSafeInteger(value) || value < 0) throw new Error('A nonnegative expected revision is required') }
const check = (expected: number, actual: number): void => { revision(expected); if (expected !== actual) conflict(actual) }
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right)

export class MusicLibrary {
  constructor(private api: LibraryOwner, private metadata: (path: string) => Promise<LibraryMetadata>) {}

  async rows(dataset: string, where?: Record<string, string>, initial?: DatasetPage): Promise<DatasetPage> {
    const page = initial ?? await this.api.data.dataset(dataset).query({ where, limit: 1000 })
    const rows = [...page.rows]
    let cursor = page.cursor
    while (cursor) {
      const next = await this.api.data.dataset(dataset).query({ where, cursor, limit: 1000 })
      check(page.revision, next.revision)
      rows.push(...next.rows); cursor = next.cursor
      if (rows.length > 50000) throw new Error('Music library exceeds the operation limit')
    }
    return { rows, revision: page.revision }
  }

  async list(kind: 'tracks' | 'playlists' | 'artists', cursor?: string, limit = 100) {
    if (!['tracks', 'playlists', 'artists'].includes(kind) || !Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('Invalid library page')
    return this.api.data.dataset(`music.${kind}`).query({ cursor, limit, includeRevisions: true })
  }

  async readTrack(id: string): Promise<DatasetReadResult<Track | null>> {
    return this.api.data.dataset(tracks).read({ id }) as unknown as Promise<DatasetReadResult<Track | null>>
  }

  async updateTrack(id: string, patch: Partial<Pick<Track, 'title' | 'artist' | 'album' | 'details' | 'favorite'>>, expectedRevision: number) {
    const observed = await this.readTrack(id)
    check(expectedRevision, observed.revision)
    if (!observed.value) throw new Error('Track no longer exists')
    const current = observed.value
    const next = { ...current, ...patch }
    if (patch.title !== undefined) { if (!patch.title.trim()) throw new Error('Track title is required'); next.title = patch.title.trim() }
    if (patch.artist !== undefined) { next.artist = patch.artist.trim(); if (next.artist !== current.artist) next.artists = [] }
    if (patch.album !== undefined) next.album = patch.album.trim()
    if (Object.keys(patch).some(key => key !== 'favorite')) next.details = { ...current.details, ...patch.details, edited: true }
    if (same(next, current)) return { value: current, revision: observed.revision }
    const result = await this.api.data.transaction([{ dataset: tracks, operation: 'upsert', values: record(next) }], { expected: [{ dataset: tracks, key: { id }, revision: expectedRevision }] })
    return { value: next, revision: result.revision }
  }

  async deleteTrack(id: string, expectedRevision: number) {
    const current = await this.readTrack(id)
    check(expectedRevision, current.revision)
    if (!current.value) throw new Error('Track no longer exists')
    const result = await this.api.data.dataset(tracks).delete({ id }, { expected: [{ dataset: tracks, key: { id }, revision: expectedRevision }] })
    return { id, revision: result.revision }
  }

  private async playlistState(id: string): Promise<{ value: Playlist | null; links: DatasetRecord[] } & LibraryRevisions> {
    const snapshot = await this.api.data.snapshot([{ operation: 'read', dataset: playlists, key: { id } }, { operation: 'query', dataset: members, query: { where: { playlistId: id }, limit: 1000 } }])
    const saved = snapshot.values[0] as DatasetReadResult<DatasetRecord | null>
    const links = await this.rows(members, { playlistId: id }, snapshot.values[1] as DatasetPage)
    return { value: saved.value ? { id, name: String(saved.value.name), ...(typeof saved.value.cover === 'string' ? { cover: saved.value.cover } : {}), songIds: links.rows.sort((a, b) => Number(a.position) - Number(b.position)).map(row => String(row.trackId)) } : null, links: links.rows, revision: saved.revision, membersRevision: links.revision }
  }

  async readPlaylist(id: string): Promise<{ value: Playlist | null } & LibraryRevisions> {
    const { links: _links, ...value } = await this.playlistState(id)
    return value
  }

  async writePlaylist(value: Playlist, expected: LibraryRevisions) {
    const current = await this.playlistState(value.id)
    check(expected.revision, current.revision); check(expected.membersRevision, current.membersRevision)
    if (!value.name.trim() || value.songIds.length > 10000 || new Set(value.songIds).size !== value.songIds.length) throw new Error('Invalid playlist name or duplicate members')
    const next = { ...value, name: value.name.trim() }
    if (same(current.value, next)) return { value: current.value, revision: current.revision, membersRevision: current.membersRevision }
    const operations: DatasetTransactionOperation[] = [{ dataset: playlists, operation: 'upsert', values: { id: value.id, name: next.name, cover: value.cover || null } }]
    const old = new Map(current.links.map(row => [Number(row.position), String(row.trackId)]))
    const removed = current.links.filter(row => Number(row.position) >= value.songIds.length)
    if (removed.length) operations.push({ dataset: members, operation: 'delete-many', keys: removed.map(row => ({ playlistId: value.id, position: Number(row.position) })) })
    const changed = value.songIds.map((trackId, position) => ({ playlistId: value.id, trackId, position })).filter(row => old.get(row.position) !== row.trackId)
    if (changed.length) operations.push({ dataset: members, operation: 'upsert', values: changed })
    const guards: DatasetRevisionGuard[] = [{ dataset: playlists, key: { id: value.id }, revision: expected.revision }, { dataset: members, revision: expected.membersRevision }]
    if (changed.length) {
      const songs = await this.rows(tracks), known = new Set(songs.rows.map(row => row.id))
      if (changed.some(row => !known.has(row.trackId))) throw new Error('Playlist member no longer exists in the library')
      guards.push({ dataset: tracks, revision: songs.revision })
    }
    const result = await this.api.data.transaction(operations, { expected: guards })
    return { value: next, revision: result.revision, membersRevision: changed.length || removed.length ? result.revision : expected.membersRevision }
  }

  async deletePlaylist(id: string, expected: LibraryRevisions) {
    const current = await this.readPlaylist(id)
    check(expected.revision, current.revision); check(expected.membersRevision, current.membersRevision)
    if (!current.value) throw new Error('Playlist no longer exists')
    const result = await this.api.data.transaction([{ dataset: playlists, operation: 'delete', key: { id } }], { expected: [{ dataset: playlists, key: { id }, revision: expected.revision }, { dataset: members, revision: expected.membersRevision }] })
    return { id, revision: result.revision }
  }

  async readArtists(ids: string[]): Promise<Array<{ value: Artist | null } & ArtistRevisions>> {
    const snapshot = await this.api.data.snapshot([...ids.map(id => ({ operation: 'read' as const, dataset: artists, key: { id } })), { operation: 'query', dataset: aliases, query: { limit: 1000 } }])
    const names = await this.rows(aliases, undefined, snapshot.values[ids.length] as DatasetPage)
    return ids.map((id, index) => {
      const saved = snapshot.values[index] as DatasetReadResult<DatasetRecord | null>, row = saved.value
      return { value: row ? { id, name: String(row.name), ...(typeof row.image === 'string' ? { image: row.image } : {}), ...(typeof row.bio === 'string' ? { bio: row.bio } : {}), aliases: names.rows.filter(alias => alias.artistId === id).map(alias => String(alias.alias)) } : null, revision: saved.revision, aliasesRevision: names.revision }
    })
  }

  async readArtist(id: string) { return (await this.readArtists([id]))[0] }

  async writeArtists(entries: Array<{ id: string; value: Artist | null; revision: number }>, expectedAliasesRevision: number) {
    const current = await this.readArtists(entries.map(entry => entry.id))
    const operations: DatasetTransactionOperation[] = [], guards: DatasetRevisionGuard[] = [{ dataset: aliases, revision: expectedAliasesRevision }]
    let changedAliases = false
    const changed = entries.map((entry, index) => {
      const before = current[index]
      check(entry.revision, before.revision); check(expectedAliasesRevision, before.aliasesRevision)
      guards.push({ dataset: artists, key: { id: entry.id }, revision: entry.revision })
      if (entry.value && (entry.value.id !== entry.id || !entry.value.name.trim() || (entry.value.aliases?.length ?? 0) > 10000)) throw new Error('Invalid artist metadata')
      if (sameArtist(before.value, entry.value)) return false
      if (!entry.value) {
        operations.push({ dataset: artists, operation: 'delete', key: { id: entry.id } })
        changedAliases ||= Boolean(before.value?.aliases?.length)
        return true
      }
      const old = new Set(before.value?.aliases ?? []), next = new Set(entry.value.aliases ?? [])
      const removed = [...old].filter(alias => !next.has(alias)).map(alias => ({ artistId: entry.id, alias }))
      const added = [...next].filter(alias => !old.has(alias)).map(alias => ({ artistId: entry.id, alias }))
      operations.push({ dataset: artists, operation: 'upsert', values: { id: entry.id, name: entry.value.name, image: entry.value.image ?? null, bio: entry.value.bio ?? null } })
      if (removed.length) operations.push({ dataset: aliases, operation: 'delete-many', keys: removed })
      if (added.length) operations.push({ dataset: aliases, operation: 'upsert', values: added })
      changedAliases ||= Boolean(removed.length || added.length)
      return true
    })
    if (!operations.length) return { revisions: current.map(value => value.revision), aliasesRevision: expectedAliasesRevision }
    const result = await this.api.data.transaction(operations, { expected: guards })
    return { revisions: current.map((value, index) => changed[index] ? result.revision : value.revision), aliasesRevision: changedAliases ? result.revision : expectedAliasesRevision }
  }

  async updateArtist(id: string, patch: { name?: string; image?: string | null; bio?: string | null }, expected: ArtistRevisions) {
    const observed = await this.readArtist(id)
    check(expected.revision, observed.revision); check(expected.aliasesRevision, observed.aliasesRevision)
    if (!observed.value) throw new Error('Artist no longer exists')
    const value = patchArtistMetadata(observed.value, patch)
    const result = await this.writeArtists([{ id, value, revision: expected.revision }], expected.aliasesRevision)
    return { value, revision: result.revisions[0], aliasesRevision: result.aliasesRevision }
  }

  async mergeArtists(sourceId: string, targetId: string, expected: { sourceRevision: number; targetRevision: number; aliasesRevision: number }) {
    if (sourceId === targetId) throw new Error('Select two different artists')
    const [source, target] = await this.readArtists([sourceId, targetId])
    check(expected.sourceRevision, source.revision); check(expected.targetRevision, target.revision); check(expected.aliasesRevision, target.aliasesRevision)
    if (!source.value || !target.value) throw new Error('Artist no longer exists')
    const value = mergeArtistMetadata(source.value, target.value)
    const result = await this.writeArtists([{ id: sourceId, value: null, revision: expected.sourceRevision }, { id: targetId, value, revision: expected.targetRevision }], expected.aliasesRevision)
    return { value, sourceId, sourceRevision: result.revisions[0], revision: result.revisions[1], aliasesRevision: result.aliasesRevision }
  }

  async index(signal?: AbortSignal): Promise<PluginIndexEntry[]> {
    let wake: (() => void) | undefined
    const observation = await this.api.index.observe({ fields: [] }, () => wake?.())
    const abort = () => wake?.()
    signal?.addEventListener('abort', abort)
    try {
      let page = await observation.read({ limit: 128 })
      while (page.status === 'loading') {
        signal?.throwIfAborted()
        await new Promise<void>(resolve => { wake = resolve; const timer = setTimeout(resolve, 100); wake = () => { clearTimeout(timer); resolve() } })
        page = await observation.read({ limit: 128 })
      }
      if (page.status !== 'ready' || !page.version) throw new Error(page.error ?? 'Vault index is unavailable')
      const entries = [...page.entries], version = page.version
      while (page.next !== null) {
        signal?.throwIfAborted()
        page = await observation.read({ version, offset: page.next, limit: 128 })
        if (page.status !== 'ready' || page.version?.revision !== version.revision || page.version.scopeGeneration !== version.scopeGeneration || page.version.vaultGeneration !== version.vaultGeneration) throw new Error('Vault index changed during scan; retry the rescan')
        entries.push(...page.entries)
        if (entries.length > 100000) throw new Error('Vault index exceeds the scan limit')
      }
      return entries
    } finally { signal?.removeEventListener('abort', abort); await observation.dispose() }
  }

  async rescan(expectedRevision: number, signal?: AbortSignal, indexed?: readonly PluginIndexEntry[], assertCurrent: () => void = () => {}) {
    const musicPath = normalizeRelPath(this.api.settings.get().musicPath)
    const observed = await this.rows(tracks)
    check(expectedRevision, observed.revision)
    if (!musicPath) return { revision: observed.revision, added: 0, healed: 0, updated: 0, missing: [] as string[] }
    const entries = indexed ?? await this.index(signal), current = observed.rows as unknown as Track[]
    const sync = computeLibrarySync(current, mediaFilesInFolder(entries, musicPath), entries)
    const next = new Map(current.map(track => [track.id, track])), changed: Track[] = []
    const healed = new Map(sync.toHeal.map(value => [value.track.id, value.newPath]))
    const details = async (file: string) => { signal?.throwIfAborted(); const value = await this.metadata(file); signal?.throwIfAborted(); const fallback = trackDetailsFromFileName(file); return { title: value?.title?.trim() || fallback.title, artist: value?.artist?.trim() || fallback.artist, ...(value?.album?.trim() ? { album: value.album.trim() } : {}) } }
    for (const track of current) {
      signal?.throwIfAborted()
      const file = healed.get(track.id) ?? track.file
      const autoNamed = !track.details?.edited && Boolean(track.addedAt) && track.title === rawTitleFromFileName(track.file)
      if (!autoNamed && file === track.file) continue
      const value = { ...track, ...(autoNamed ? await details(file) : {}), file }
      changed.push(value); next.set(value.id, value)
    }
    for (const file of sync.toAdd) { const value = { id: newTrackId(), ...await details(file), file, addedAt: new Date().toISOString() }; changed.push(value); next.set(value.id, value) }
    const snapshot = await this.api.data.snapshot([{ operation: 'query', dataset: artists, query: { limit: 1000 } }, { operation: 'query', dataset: aliases, query: { limit: 1000 } }])
    const artistRows = await this.rows(artists, undefined, snapshot.values[0] as DatasetPage), aliasRows = await this.rows(aliases, undefined, snapshot.values[1] as DatasetPage)
    const registry = artistRows.rows.map(row => ({ ...row, aliases: aliasRows.rows.filter(alias => alias.artistId === row.id).map(alias => String(alias.alias)) })) as unknown as Artist[]
    const addedArtists = upsertArtists(registry, [...next.values()]).added
    const operations: DatasetTransactionOperation[] = []
    if (changed.length) operations.push({ dataset: tracks, operation: 'upsert', values: changed.map(record) })
    if (addedArtists.length) operations.push({ dataset: artists, operation: 'insert', values: addedArtists.map(record) })
    const expected: DatasetRevisionGuard[] = [{ dataset: tracks, revision: expectedRevision }, { dataset: artists, revision: artistRows.revision }, { dataset: aliases, revision: aliasRows.revision }]
    signal?.throwIfAborted(); assertCurrent()
    if (normalizeRelPath(this.api.settings.get().musicPath) !== musicPath) throw new Error('Music folder changed during scan; retry the rescan')
    const result = operations.length ? await this.api.data.transaction(operations, { expected }) : null
    return { revision: changed.length ? result!.revision : observed.revision, added: sync.toAdd.length, healed: sync.toHeal.length, updated: changed.length - sync.toAdd.length, missing: [...sync.missing] }
  }
}
