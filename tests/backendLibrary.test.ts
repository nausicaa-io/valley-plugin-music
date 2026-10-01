import Ajv from 'ajv'
import { describe, expect, it, vi } from 'vitest'
import { createMockValleyApi, type MockApiOptions } from '@valley/plugin-testkit'
import type { PluginBackendApi, PluginBackendOperationContext } from '@valley/plugin-sdk'
import type { ValleyPluginManifest } from '@valley/plugin-sdk/types'
import { register } from '../src/backend'
import { connectPlayback } from './playbackFixture'
import config from '../config.json'

const track = (id: string) => ({ id, file: `Music/${id}.mp3`, title: id, artist: 'Forest' })
const asset = (relPath: string) => ({ relPath, title: relPath, kind: 'asset' as const, mtimeMs: 0 })
const ajv = new Ajv({ strict: false, strictSchema: true, allErrors: true, validateFormats: false, allowUnionTypes: true, ownProperties: true })
const schemas = new Map(config.runtime.services.flatMap(service => service.metadata.commands.map(command => [command.id, { input: ajv.compile(command.inputSchema), output: ajv.compile(command.outputSchema) }] as const)))

function fixture(options: Partial<MockApiOptions> = {}) {
  const mock = createMockValleyApi({
    manifest: { id: 'music', indexState: 'scoped', datasets: config.datasets as unknown as ValleyPluginManifest['datasets'] },
    settings: { musicPath: 'Music' },
    datasets: { 'music.tracks': ['fern', 'moss', 'canopy'].map(track) },
    indexEntries: ['fern', 'moss', 'canopy'].map(id => asset(`Music/${id}.mp3`)),
    ...options
  })
  const playback = connectPlayback(mock.api)
  const operations = new Map<string, (input: unknown, context: PluginBackendOperationContext) => Promise<unknown>>()
  const metadata = vi.fn(async (_path: string) => ({ title: 'Embedded title', artist: 'Embedded artist', album: 'Embedded album' }))
  const api = { ...mock.api, pluginId: 'music', media: { readMetadata: metadata }, playback: { createLocalPlayer: async () => playback.player }, files: { release: async () => {} }, rpc: {
    emit() {}, handle: () => () => {}, handleOperation: (name: string, handler: (input: unknown, context: PluginBackendOperationContext) => Promise<unknown>) => { operations.set(name, handler); return () => operations.delete(name) }
  } } as unknown as PluginBackendApi
  const dispose = register(api)
  const invoke = async (id: string, input: unknown, owner = api, signal = new AbortController().signal) => {
    const schema = schemas.get(id)!
    expect(schema.input(input), JSON.stringify(schema.input.errors)).toBe(true)
    const result = await operations.get(`command.${id}`)!(input, { id: `test-${id}`, api: owner, cancellation: signal } as PluginBackendOperationContext)
    expect(schema.output(result), `${id}: ${JSON.stringify(schema.output.errors)}`).toBe(true)
    expect(schema.output({}), id).toBe(false)
    return result as Record<string, any>
  }
  return { ...mock, api, metadata, operations, invoke, dispose }
}

describe('backend Music library owner', () => {
  it('shares artist metadata, rename and merge contracts without losing names, artwork or song membership', async () => {
    const f = fixture({ datasets: {
      'music.tracks': [{ ...track('fern'), artist: 'Source' }],
      'music.artists': [{ id: 'source', name: 'Source', image: 'source.png', bio: 'Original biography' }, { id: 'target', name: 'Target', image: 'target.png' }],
      'music.artist_aliases': [{ artistId: 'source', alias: 'Original name' }, { artistId: 'target', alias: 'Existing alias' }]
    }, indexEntries: [asset('Music/fern.mp3')] })
    try {
      const source = await f.invoke('artist.read', { id: 'source' })
      const edited = await f.invoke('artist.update', { id: 'source', expectedRevision: source.revision, expectedAliasesRevision: source.aliasesRevision, patch: { bio: ' Updated biography ' } })
      const renamed = await f.invoke('artist.rename', { id: 'source', expectedRevision: edited.revision, expectedAliasesRevision: edited.aliasesRevision, name: 'Renamed source' })
      expect(renamed.value).toMatchObject({ name: 'Renamed source', image: 'source.png', bio: 'Updated biography', aliases: ['Original name', 'Source'] })
      await expect(f.invoke('artist.update', { id: 'source', expectedRevision: source.revision, expectedAliasesRevision: source.aliasesRevision, patch: { image: null } })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
      const target = await f.invoke('artist.read', { id: 'target' })
      const merged = await f.invoke('artist.merge', { sourceId: 'source', targetId: 'target', expectedSourceRevision: renamed.revision, expectedTargetRevision: target.revision, expectedAliasesRevision: target.aliasesRevision })
      expect(merged.value).toEqual({ id: 'target', name: 'Target', image: 'target.png', bio: 'Updated biography', aliases: ['Existing alias', 'Renamed source', 'Original name', 'Source'] })
      expect((await f.invoke('artist.read', { id: 'source' })).value).toBeNull()
      expect((await f.invoke('track.read', { id: 'fern' })).value.artist).toBe('Source')
      const noOp = await f.invoke('artist.update', { id: 'target', expectedRevision: merged.revision, expectedAliasesRevision: merged.aliasesRevision, patch: { bio: 'Updated biography' } })
      expect(noOp).toEqual({ value: merged.value, revision: merged.revision, aliasesRevision: merged.aliasesRevision })
      const initial = await f.invoke('library.list', { kind: 'tracks' })
      await f.invoke('library.rescan', { expectedRevision: initial.revision })
      expect(f.datasets.get('music.artists')).toHaveLength(1)
    } finally { await f.dispose() }
  })

  it('makes concurrent artist merges atomic and rejects stale alias revisions', async () => {
    const f = fixture({ datasets: {
      'music.artists': [{ id: 'source', name: 'Source' }, { id: 'target', name: 'Target' }],
      'music.artist_aliases': [{ artistId: 'source', alias: 'Original' }]
    } })
    try {
      const source = await f.invoke('artist.read', { id: 'source' }), target = await f.invoke('artist.read', { id: 'target' })
      const input = { sourceId: 'source', targetId: 'target', expectedSourceRevision: source.revision, expectedTargetRevision: target.revision, expectedAliasesRevision: target.aliasesRevision }
      const results = await Promise.allSettled(Array.from({ length: 10 }, () => f.invoke('artist.merge', input)))
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      expect(results.filter(result => result.status === 'rejected')).toHaveLength(9)
      const next = await f.invoke('artist.read', { id: 'target' })
      await expect(f.invoke('artist.rename', { id: 'target', name: 'Stale name', expectedRevision: next.revision, expectedAliasesRevision: target.aliasesRevision })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
      expect(next.value.aliases).toEqual(['Source', 'Original'])
      expect(f.datasets.get('music.artists')).toHaveLength(1)
    } finally { await f.dispose() }
  })

  it('keeps artist mutations bound to the admitted cancellation fence', async () => {
    const f = fixture({ datasets: { 'music.artists': [{ id: 'source', name: 'Source' }, { id: 'target', name: 'Target' }] } })
    const controller = new AbortController()
    let release!: () => void, entered!: () => void
    const waiting = new Promise<void>(resolve => { entered = resolve })
    const transaction = vi.fn(async (...args: Parameters<PluginBackendApi['data']['transaction']>) => {
      entered(); await new Promise<void>(resolve => { release = resolve })
      controller.signal.throwIfAborted()
      return f.api.data.transaction(...args)
    })
    const owner = { ...f.api, data: { ...f.api.data, transaction } }
    try {
      const source = await f.invoke('artist.read', { id: 'source' }), target = await f.invoke('artist.read', { id: 'target' })
      const result = f.invoke('artist.merge', { sourceId: 'source', targetId: 'target', expectedSourceRevision: source.revision, expectedTargetRevision: target.revision, expectedAliasesRevision: target.aliasesRevision }, owner, controller.signal)
      const rejected = expect(result).rejects.toThrow('cancelled')
      await waiting
      controller.abort(new Error('cancelled')); release()
      await rejected
      expect(transaction).toHaveBeenCalledOnce()
      expect(f.datasets.get('music.artists')).toEqual([{ id: 'source', name: 'Source' }, { id: 'target', name: 'Target' }])
    } finally { release?.(); await f.dispose() }
  })

  it('validates every registered library result and preserves unrelated song metadata', async () => {
    const f = fixture({ datasets: { 'music.tracks': [{ ...track('fern'), details: { lyrics: 'Keep this verse', genre: 'Folk' } }, track('moss')] } })
    try {
      const page = await f.invoke('library.list', { kind: 'tracks', limit: 1 })
      expect(page.rows).toHaveLength(1)
      const song = await f.invoke('track.read', { id: 'fern' })
      const edited = await f.invoke('track.update', { id: 'fern', expectedRevision: song.revision, patch: { title: 'Fern canopy', details: { genre: 'Ambient' } } })
      expect(edited.value).toMatchObject({ title: 'Fern canopy', details: { lyrics: 'Keep this verse', genre: 'Ambient', edited: true } })
      await expect(f.invoke('track.update', { id: 'fern', expectedRevision: song.revision, patch: { title: 'Stale editor' } })).rejects.toMatchObject({ code: 'REVISION_CONFLICT', status: 409 })
      const missing = await f.invoke('playlist.read', { id: 'walk' })
      const created = await f.invoke('playlist.create', { id: 'walk', name: 'Walk', songIds: ['fern', 'moss'], expectedRevision: missing.revision, expectedMembersRevision: missing.membersRevision })
      const changed = await f.invoke('playlist.update', { id: 'walk', expectedRevision: created.revision, expectedMembersRevision: created.membersRevision, patch: { name: 'Forest walk', songIds: ['moss', 'fern'] } })
      expect(changed.value.songIds).toEqual(['moss', 'fern'])
      await f.invoke('playlist.delete', { id: 'walk', expectedRevision: changed.revision, expectedMembersRevision: changed.membersRevision })
      const beforeDelete = await f.invoke('track.read', { id: 'fern' })
      await f.invoke('track.delete', { id: 'fern', expectedRevision: beforeDelete.revision })
      const beforeScan = await f.invoke('library.list', { kind: 'tracks' })
      const scanned = await f.invoke('library.rescan', { expectedRevision: beforeScan.revision })
      expect(scanned.added).toBe(2)
      expect(f.metadata).toHaveBeenCalledWith('Music/fern.mp3')
      expect(f.metadata).toHaveBeenCalledWith('Music/canopy.mp3')
    } finally { await f.dispose() }
  })

  it('allows one of ten concurrent edits from the same observed revision', async () => {
    const f = fixture()
    try {
      const observed = await f.invoke('track.read', { id: 'fern' })
      const results = await Promise.allSettled(Array.from({ length: 10 }, (_, index) => f.invoke('track.update', { id: 'fern', expectedRevision: observed.revision, patch: { title: `Editor ${index}` } })))
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      expect(results.filter(result => result.status === 'rejected')).toHaveLength(9)
      expect((await f.invoke('track.read', { id: 'fern' })).value.title).toBe('Editor 0')
    } finally { await f.dispose() }
  })

  it('keeps membership atomic on invalid references and handles positions left by track deletion', async () => {
    const f = fixture({ datasets: {
      'music.tracks': ['fern', 'moss', 'canopy'].map(track),
      'music.playlists': [{ id: 'walk', name: 'Walk' }],
      'music.playlist_tracks': ['fern', 'moss', 'canopy'].map((trackId, position) => ({ playlistId: 'walk', trackId, position }))
    } })
    try {
      const initial = await f.invoke('playlist.read', { id: 'walk' })
      await expect(f.invoke('playlist.update', { id: 'walk', expectedRevision: initial.revision, expectedMembersRevision: initial.membersRevision, patch: { name: 'Must not commit', songIds: ['not-in-library'] } })).rejects.toThrow()
      expect(await f.invoke('playlist.read', { id: 'walk' })).toEqual(initial)
      const song = await f.invoke('track.read', { id: 'moss' })
      await f.invoke('track.delete', { id: 'moss', expectedRevision: song.revision })
      const afterDelete = await f.invoke('playlist.read', { id: 'walk' })
      expect(afterDelete.value.songIds).toEqual(['fern', 'canopy'])
      const reordered = await f.invoke('playlist.update', { id: 'walk', expectedRevision: afterDelete.revision, expectedMembersRevision: afterDelete.membersRevision, patch: { songIds: ['canopy', 'fern'] } })
      expect((await f.invoke('playlist.read', { id: 'walk' })).value.songIds).toEqual(['canopy', 'fern'])
      const noOp = await f.invoke('playlist.update', { id: 'walk', expectedRevision: reordered.revision, expectedMembersRevision: reordered.membersRevision, patch: { songIds: ['canopy', 'fern'] } })
      expect(noOp.revision).toBe(reordered.revision)
      expect(noOp.membersRevision).toBe(reordered.membersRevision)
    } finally { await f.dispose() }
  })

  it('reads embedded metadata while preserving edits, moved media, playlists and history on rescan', async () => {
    const manual = { ...track('fern'), title: 'My title', details: { lyrics: 'My lyrics', edited: true } }
    const f = fixture({ datasets: {
      'music.tracks': [manual, { ...track('moss'), file: 'Music/moved.mp3' }, track('lost')],
      'music.playlists': [{ id: 'walk', name: 'Walk' }],
      'music.playlist_tracks': [{ playlistId: 'walk', trackId: 'fern', position: 0 }],
      'music.play_events': [{ id: 'played', songId: 'fern', playedAt: '2026-09-29T10:00:00.000Z' }]
    }, indexEntries: ['Music/fern.mp3', 'Archive/moved.mp3', 'Music/new.mp3'].map(asset) })
    try {
      const initial = await f.invoke('library.list', { kind: 'tracks' })
      const result = await f.invoke('library.rescan', { expectedRevision: initial.revision })
      expect(result).toMatchObject({ added: 1, healed: 1, updated: 1, missing: ['lost'] })
      expect((await f.invoke('track.read', { id: 'fern' })).value).toEqual(manual)
      expect((await f.invoke('track.read', { id: 'moss' })).value.file).toBe('Archive/moved.mp3')
      expect(f.metadata.mock.calls).toEqual([['Music/new.mp3']])
      expect(f.datasets.get('music.tracks')).toEqual(expect.arrayContaining([expect.objectContaining({ file: 'Music/new.mp3', title: 'Embedded title', artist: 'Embedded artist', album: 'Embedded album' })]))
      expect((await f.invoke('playlist.read', { id: 'walk' })).value.songIds).toEqual(['fern'])
      expect(f.datasets.get('music.play_events')).toEqual([{ id: 'played', songId: 'fern', playedAt: '2026-09-29T10:00:00.000Z' }])
    } finally { await f.dispose() }
  })

  it('uses the admitted owner and cancels before committing metadata gathered asynchronously', async () => {
    const f = fixture(), other = fixture({ datasets: { 'music.tracks': [track('other')] }, indexEntries: [asset('Music/other.mp3'), asset('Music/new.mp3')] })
    const controller = new AbortController()
    let release!: () => void
    const entered = new Promise<void>(resolve => {
      other.metadata.mockImplementationOnce(async () => { resolve(); await new Promise<void>(done => { release = done }); return { title: 'Late', artist: 'Late', album: 'Late' } })
    })
    try {
      const observed = await f.invoke('library.list', { kind: 'tracks' }, other.api)
      expect(observed.rows.map((value: { id: string }) => value.id)).toEqual(['other'])
      const result = f.invoke('library.rescan', { expectedRevision: observed.revision }, other.api, controller.signal)
      const rejected = expect(result).rejects.toThrow('cancelled')
      await entered
      controller.abort(new Error('cancelled'))
      release()
      await rejected
      expect(other.datasets.get('music.tracks')).toEqual([track('other')])
      expect(f.datasets.get('music.tracks')).toEqual(['fern', 'moss', 'canopy'].map(track))
      expect(f.metadata).not.toHaveBeenCalled()
    } finally { release?.(); await f.dispose(); await other.dispose() }
  })
})
