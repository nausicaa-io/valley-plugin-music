import Ajv from 'ajv'
import { register } from '../src/backend'
import { describe, expect, it, vi } from 'vitest'
import { createMockValleyApi } from '@valley/plugin-testkit'
import type { DatasetRecord, PluginBackendApi, PluginBackendOperationContext } from '@valley/plugin-sdk'
import type { ValleyPluginManifest } from '@valley/plugin-sdk/types'
import { connectPlayback } from './playbackFixture'
import { parsePlaybackAction, playbackPosition } from '../src/playback'
import config from '../config.json'

function fixture(queue: Array<{ position: number; songId: string }> = [], rescanned: DatasetRecord[] = []) {
  const mock = createMockValleyApi({
    manifest: { id: 'music', datasets: config.datasets as unknown as ValleyPluginManifest['datasets'] },
    datasets: {
      'music.tracks': [...['fern', 'moss', 'canopy'].map(id => ({ id, file: `Music/${id}.mp4`, title: id, artist: 'Forest' })), ...rescanned],
      'music.queue': queue, 'music.play_events': []
    }
  })
  return { ...mock, ...connectPlayback(mock.api) }
}

describe('persistent Music queue', () => {

  it.each(['paused', 'ended'] as const)('restores a %s source without advancing or playing the saved queue', async status => {
    const f = fixture([{ position: 0, songId: 'moss' }])
    const initial = f.getSnapshot()!
    vi.mocked(f.player.getSnapshot).mockResolvedValue({
      ...initial,
      target: { ...initial.target, sourceGeneration: 1 },
      descriptor: { ...initial.descriptor, path: 'Music/fern.mp4' },
      state: { ...initial.state, status, positionSeconds: 180, durationSeconds: 180 }
    })
    await f.backend.read()
    await f.backend.dispatch({ type: 'flush' })
    expect(f.player.load).not.toHaveBeenCalled()
    expect(f.player.play).not.toHaveBeenCalled()
    expect(f.backend.snapshot()).toMatchObject({ current: { id: 'fern' }, playing: false })
    expect(f.datasets.get('music.queue')).toEqual([{ position: 0, songId: 'moss' }])
    await f.backend.dispose()
  })

  it('validates every admitted playback result against its declared output schema', async () => {
    const f = fixture([], [{ id: 'untagged', file: 'Music/untagged.mp4', title: 'untagged', artist: 'Unknown', artists: null, album: null, duration: null, favorite: null, addedAt: null, details: null }])
    const operations = new Map<string, (value: unknown, context: PluginBackendOperationContext) => unknown>()
    const api = { ...f.api, pluginId: 'music', playback: { createLocalPlayer: async () => f.player }, files: { release: async () => {} }, rpc: {
      emit() {}, handle: () => () => {}, handleOperation: (name: string, handler: (value: unknown, context: PluginBackendOperationContext) => unknown) => { operations.set(name, handler); return () => {} }
    } } as unknown as PluginBackendApi
    const dispose = register(api)
    const context = { id: 'playback-output', api, cancellation: new AbortController().signal } as PluginBackendOperationContext
    try {
      const schemas = new Map(config.runtime.services.flatMap(service => (service.metadata?.commands ?? []).map(command => [command.id, new Ajv({ strict: false, strictSchema: true, allErrors: true, validateFormats: false, allowUnionTypes: true, ownProperties: true }).compile(command.outputSchema)] as const)))
      const nodes = new Map((config.runtime.services.find(service => service.id === 'workflow.provider')!.metadata as unknown as { workflow: { nodes: Array<{ id: string; outputSchema: object }> } }).workflow.nodes.map(node => [node.id, new Ajv({ strict: false, allErrors: true, validateFormats: false, allowUnionTypes: true }).compile(node.outputSchema)] as const))
      const actions = [
        { type: 'start', ids: ['untagged', 'fern', 'moss', 'canopy'], index: 0 }, { type: 'pause' }, { type: 'resume' }, { type: 'toggle' },
        { type: 'next' }, { type: 'previous' }, { type: 'seek', value: 25 }, { type: 'volume', value: 0.5 },
        { type: 'repeat' }, { type: 'shuffle' }, { type: 'flush' }, { type: 'add', ids: ['untagged', 'moss'], where: 'end' },
        { type: 'reorder', from: 1, to: 2 }, { type: 'playQueued', index: 1 }, { type: 'remove', index: 1 }, { type: 'stop' }, { type: 'clear' }, { type: 'eject' }
      ]
      for (const action of actions) {
        const result = await operations.get('command.playback.action')!(action, context)
        const validate = schemas.get(`playback.${action.type}`)!
        expect(validate(result), action.type + ': ' + JSON.stringify(validate.errors)).toBe(true)
        expect(validate({}), action.type).toBe(false)
        expect(nodes.get(`playback.${action.type}`)!(result), action.type).toBe(true)
      }
      const snapshot = await operations.get('command.playback.snapshot')!({}, context)
      expect(schemas.get('playback.snapshot')!(snapshot)).toBe(true)
      expect(nodes.get('playback.snapshot')!(snapshot)).toBe(true)
    } finally { await dispose() }
  })

  it('interpolates using only local elapsed time, freezes stale or paused samples and clamps duration', () => {
    const sample = { position: 40, duration: 90, rate: 2, playing: true, buffering: false, sampleAgeMs: 250 }
    expect(playbackPosition(sample, 9_000_000, 9_000_500)).toBe(41.5)
    expect(playbackPosition(sample, 20, 40_000)).toBe(46)
    expect(playbackPosition({ ...sample, playing: false }, 20, 40_000)).toBe(40)
    expect(playbackPosition({ ...sample, buffering: true }, 20, 40_000)).toBe(40)
    expect(playbackPosition({ ...sample, position: 89 }, 20, 3000)).toBe(90)
  })

  it('advances three tracks and records history with every UI subscriber detached', async () => {
    const f = fixture()
    await f.backend.dispatch({ type: 'start', ids: ['fern', 'moss', 'canopy'], index: 0 })
    f.detachViews()
    f.observe({ status: 'ended', positionSeconds: 180 })
    await vi.waitFor(() => expect(f.backend.snapshot().current?.id).toBe('moss'))
    await f.backend.dispatch({ type: 'flush' })
    f.observe({ status: 'ended', positionSeconds: 180 })
    await vi.waitFor(() => expect(f.backend.snapshot().current?.id).toBe('canopy'))
    await f.backend.dispatch({ type: 'flush' })
    expect(f.datasets.get('music.play_events')?.map(row => row.songId)).toEqual(['fern', 'moss', 'canopy'])
    expect(f.player.load).toHaveBeenCalledTimes(3)
    expect(f.datasets.get('music.queue')).toEqual([])
    await f.backend.dispose()
  })

  it('uses the admitted API for player actions, datasets and persisted settings', async () => {
    const f = fixture()
    await f.backend.read()
    const scopedLoad = vi.fn(f.player.load)
    const scopedDataset = vi.fn(f.api.data.dataset.bind(f.api.data))
    const scopedSet = vi.fn(f.api.settings.set.bind(f.api.settings))
    const createLocalPlayer = vi.fn(async () => ({ ...f.player, load: scopedLoad }))
    const owner = { data: { ...f.api.data, dataset: scopedDataset }, settings: { ...f.api.settings, set: scopedSet }, playback: { createLocalPlayer } } as unknown as Pick<PluginBackendApi, 'data' | 'settings' | 'playback'>
    await f.backend.dispatch({ type: 'start', ids: ['fern'], index: 0 }, undefined, owner)
    expect(createLocalPlayer).toHaveBeenCalledOnce()
    expect(scopedLoad).toHaveBeenCalledOnce()
    expect(scopedDataset).toHaveBeenCalledWith('music.tracks')
    expect(scopedSet).toHaveBeenCalled()
    await f.backend.dispose()
  })
  it('deduplicates ended events and continues repeat-one with a fresh generation', async () => {
    const f = fixture()
    await f.backend.dispatch({ type: 'start', ids: ['fern', 'moss'], index: 0 })
    await f.backend.dispatch({ type: 'repeat' })
    await f.backend.dispatch({ type: 'repeat' })
    f.observe({ status: 'ended' })
    f.observe({ status: 'ended' })
    await vi.waitFor(() => expect(f.player.load).toHaveBeenCalledTimes(2))
    await f.backend.dispatch({ type: 'flush' })
    expect(f.backend.snapshot().current?.id).toBe('fern')
    expect(f.datasets.get('music.play_events')).toHaveLength(2)
    await f.backend.dispose()
  })

  it('does not advance after a paused seek reaches the end of a previously played source', async () => {
    const f = fixture()
    await f.backend.dispatch({ type: 'start', ids: ['fern', 'moss'], index: 0 })
    await f.backend.dispatch({ type: 'pause' })
    f.observe({ status: 'ended', positionSeconds: 180 })
    await f.backend.dispatch({ type: 'flush' })
    expect(f.player.load).toHaveBeenCalledOnce()
    expect(f.backend.snapshot()).toMatchObject({ current: { id: 'fern' }, playing: false })
    await f.backend.dispose()
  })

  it('keeps Up Next and the position on Music Stop and serializes rapid queue actions', async () => {
    const f = fixture()
    await f.backend.dispatch({ type: 'start', ids: ['fern', 'moss', 'canopy'], index: 0 })
    await Promise.all([f.backend.dispatch({ type: 'next' }), f.backend.dispatch({ type: 'next' })])
    expect(f.backend.snapshot().current?.id).toBe('canopy')
    await f.backend.dispatch({ type: 'add', ids: ['fern', 'moss'], where: 'end' })
    await f.player.pause()
    expect(f.backend.snapshot().queue.slice(f.backend.snapshot().index + 1)).toHaveLength(2)
    await f.backend.dispatch({ type: 'seek', value: 45 })
    await f.backend.dispatch({ type: 'stop' })
    expect(f.backend.snapshot()).toMatchObject({ current: { id: 'canopy' }, position: 45, playing: false })
    expect(f.player.stop).not.toHaveBeenCalled()
    expect(f.backend.snapshot().queue.slice(f.backend.snapshot().index + 1).map(track => track.id)).toEqual(['fern', 'moss'])
    expect(f.datasets.get('music.queue')).toHaveLength(2)
    await f.backend.dispose()
  })

  it('does not repeat a command when the host reports an unknown outcome', async () => {
    const f = fixture()
    await f.backend.dispatch({ type: 'start', ids: ['fern'], index: 0 })
    vi.mocked(f.player.seek).mockResolvedValueOnce({ commandId: 'uncertain', target: f.getSnapshot()!.target, status: 'unknown' })
    await expect(f.backend.dispatch({ type: 'seek', value: 80 })).rejects.toThrow('unknown')
    expect(f.player.seek).toHaveBeenCalledTimes(1)
    expect(f.backend.snapshot().error).toContain('unknown')
    await f.backend.dispose()
  })

  it.each(['queued', 'accepted'] as const)('does not report %s playback as completed or retry it', async status => {
    const f = fixture()
    await f.backend.dispatch({ type: 'start', ids: ['fern'], index: 0 })
    await f.backend.dispatch({ type: 'pause' })
    vi.mocked(f.player.play).mockResolvedValueOnce({ commandId: 'pending', target: f.getSnapshot()!.target, status })
    await expect(f.backend.dispatch({ type: 'resume' })).rejects.toMatchObject({ outcome: 'unknown', retryable: false })
    expect(f.player.play).toHaveBeenCalledOnce()
    expect(f.backend.snapshot()).toMatchObject({ playing: false, errorOutcome: 'unknown' })
    await f.backend.dispose()
  })

  it('rejects observed resume with no playing confirmation and retains a useful engine failure', async () => {
    const f = fixture()
    await f.backend.dispatch({ type: 'start', ids: ['fern'], index: 0 })
    await f.backend.dispatch({ type: 'pause' })
    vi.mocked(f.player.play).mockImplementationOnce(async () => {
      f.observe({ status: 'error', error: 'Unsupported audio format' })
      return { commandId: 'invalid-observation', target: f.getSnapshot()!.target, status: 'observed' }
    })
    await expect(f.backend.dispatch({ type: 'resume' })).rejects.toThrow('Unsupported audio format')
    expect(f.player.play).toHaveBeenCalledOnce()
    expect(f.backend.snapshot()).toMatchObject({ playing: false, error: 'Unsupported audio format' })
    await f.backend.dispose()
  })

  it('refreshes an observed receipt before returning when the subscription is delayed', async () => {
    const f = fixture()
    await f.backend.dispatch({ type: 'start', ids: ['fern'], index: 0 })
    await f.backend.dispatch({ type: 'pause' })
    const snapshot = f.getSnapshot()!
    vi.mocked(f.player.play).mockResolvedValueOnce({ commandId: 'observed', target: snapshot.target, status: 'observed' })
    vi.mocked(f.player.getSnapshot).mockResolvedValueOnce({ ...snapshot, state: { ...snapshot.state, status: 'playing' } })
    expect(await f.backend.dispatch({ type: 'resume' })).toMatchObject({ playing: true })
    expect(f.player.play).toHaveBeenCalledOnce()
    await f.backend.dispose()
  })

  it('reports a short recording that ended after confirmed play as completed, without repeating it', async () => {
    const f = fixture()
    await f.backend.dispatch({ type: 'start', ids: ['fern'], index: 0 })
    await f.backend.dispatch({ type: 'pause' })
    const snapshot = f.getSnapshot()!
    vi.mocked(f.player.play).mockResolvedValueOnce({ commandId: 'short-observed', target: snapshot.target, status: 'observed' })
    vi.mocked(f.player.getSnapshot).mockResolvedValueOnce({ ...snapshot, state: { ...snapshot.state, status: 'ended', positionSeconds: 0.1, durationSeconds: 0.1 } })
    expect(await f.backend.dispatch({ type: 'resume' })).toMatchObject({ playing: false, position: 0.1, duration: 0.1, error: null })
    expect(f.player.play).toHaveBeenCalledOnce()
    expect(f.player.load).toHaveBeenCalledOnce()
    await f.backend.dispose()
  })

  it.each(['paused', 'ended'] as const)('does not replay the finished last recording when its saved status is %s and repeat is off', async status => {
    const f = fixture()
    await f.backend.dispatch({ type: 'start', ids: ['fern'], index: 0 })
    f.observe({ status, positionSeconds: 0.1, durationSeconds: 0.1 })
    expect(await f.backend.dispatch({ type: 'resume' })).toMatchObject({ playing: false, current: { id: 'fern' } })
    expect(f.player.load).toHaveBeenCalledOnce()
    expect(f.player.play).not.toHaveBeenCalled()
    await f.backend.dispose()
  })

  it('advances to the next queued recording when resuming one paused at its end', async () => {
    const f = fixture()
    await f.backend.dispatch({ type: 'start', ids: ['fern', 'moss'], index: 0 })
    f.observe({ status: 'paused', positionSeconds: 180, durationSeconds: 180 })
    expect(await f.backend.dispatch({ type: 'resume' })).toMatchObject({ playing: true, current: { id: 'moss' }, position: 0 })
    expect(f.player.load).toHaveBeenLastCalledWith(expect.objectContaining({ path: 'Music/moss.mp4' }), { position: 0, autoplay: true })
    expect(f.player.play).not.toHaveBeenCalled()
    await f.backend.dispose()
  })

  it('restarts the finished recording from zero when repeat is one', async () => {
    const f = fixture()
    await f.backend.dispatch({ type: 'start', ids: ['fern'], index: 0 })
    await f.backend.dispatch({ type: 'repeat' })
    await f.backend.dispatch({ type: 'repeat' })
    expect(f.backend.snapshot().repeat).toBe('one')
    f.observe({ status: 'paused', positionSeconds: 0.1, durationSeconds: 0.1 })
    expect(await f.backend.dispatch({ type: 'resume' })).toMatchObject({ playing: true, current: { id: 'fern' }, position: 0 })
    expect(f.player.load).toHaveBeenCalledTimes(2)
    expect(f.player.play).not.toHaveBeenCalled()
    await f.backend.dispose()
  })

  it('reports an unknown outcome when an observed pause still reports playing', async () => {
    const f = fixture()
    await f.backend.dispatch({ type: 'start', ids: ['fern'], index: 0 })
    vi.mocked(f.player.pause).mockResolvedValueOnce({ commandId: 'still-playing', target: f.getSnapshot()!.target, status: 'observed' })
    await expect(f.backend.dispatch({ type: 'pause' })).rejects.toMatchObject({ outcome: 'unknown' })
    expect(f.player.pause).toHaveBeenCalledOnce()
    await f.backend.dispose()
  })

  it.each(['paused', 'error'] as const)('refuses an autoplay load that only reports %s without replaying it', async status => {
    const f = fixture()
    await f.backend.read()
    const snapshot = f.getSnapshot()!
    vi.mocked(f.player.load).mockResolvedValueOnce({ ...snapshot, descriptor: { ...snapshot.descriptor, path: 'Music/fern.mp4' }, state: { ...snapshot.state, status, ...(status === 'error' ? { error: 'Media file is missing' } : {}) } })
    await expect(f.backend.dispatch({ type: 'start', ids: ['fern'], index: 0 })).rejects.toThrow(status === 'error' ? 'Media file is missing' : 'unknown')
    expect(f.player.load).toHaveBeenCalledOnce()
    expect(f.backend.snapshot().playing).toBe(false)
    expect(f.datasets.get('music.play_events')).toEqual([])
    await f.backend.dispose()
  })

  it('ejects to the unloaded idle baseline, keeping recorded history and the player preferences', async () => {
    const f = fixture([{ position: 0, songId: 'canopy' }])
    const idle = await f.backend.read()
    await f.backend.dispatch({ type: 'repeat' })
    await f.backend.dispatch({ type: 'start', ids: ['fern', 'moss', 'canopy'], index: 1, playlistId: 'mix' })
    await f.backend.dispatch({ type: 'seek', value: 30 })
    expect(f.backend.snapshot()).toMatchObject({ current: { id: 'moss' }, playing: true, playEvent: { songId: 'moss', playlistId: 'mix' } })
    vi.mocked(f.player.prepareNext).mockClear()
    const ejected = await f.backend.dispatch({ type: 'eject' })
    expect(f.player.unload).toHaveBeenCalledOnce()
    const { revision: _revision, sampleAgeMs: _age, ...rest } = ejected
    const { revision: _r, sampleAgeMs: _a, ...baseline } = idle
    expect(rest).toEqual({ ...baseline, queue: [], repeat: 'all' })
    expect(f.getSnapshot()).toMatchObject({ primary: false, descriptor: { path: '' }, state: { status: 'stopped', positionSeconds: 0 } })
    expect(f.datasets.get('music.queue')).toEqual([])
    expect(f.datasets.get('music.play_events')?.map(row => row.songId)).toEqual(['moss'])
    expect(f.player.prepareNext).toHaveBeenLastCalledWith(null)
    await f.backend.dispatch({ type: 'eject' })
    expect(f.backend.snapshot()).toMatchObject({ queue: [], index: -1, current: null, playing: false })
    expect(parsePlaybackAction({ type: 'eject' })).toEqual({ type: 'eject' })
    await f.backend.dispose()
  })

  it('refuses eject as not applied on a host player without unload and keeps the loaded queue', async () => {
    const f = fixture()
    const { unload: _unload, ...older } = f.player
    const owner = { data: f.api.data, settings: f.api.settings, playback: { createLocalPlayer: async () => older } } as unknown as Pick<PluginBackendApi, 'data' | 'settings' | 'playback'>
    await f.backend.dispatch({ type: 'start', ids: ['fern', 'moss'], index: 0 })
    await expect(f.backend.dispatch({ type: 'eject' }, undefined, owner)).rejects.toMatchObject({ code: 'PLAYER_UNLOAD_UNSUPPORTED', outcome: 'not-applied' })
    expect(f.player.unload).not.toHaveBeenCalled()
    expect(f.backend.snapshot()).toMatchObject({ current: { id: 'fern' }, playing: true })
    expect(f.datasets.get('music.queue')).toEqual([{ position: 0, songId: 'moss' }])
    await f.backend.dispose()
  })

  it('rejects malformed action payloads', () => {
    for (const action of [{ type: 'seek', value: Infinity }, { type: 'volume', value: 2 }, { type: 'start', ids: ['fern'], index: -1 }, { type: 'reorder', from: 0.5, to: 1 }, { type: 'add', ids: [5], where: 'next' }]) expect(() => parsePlaybackAction(action)).toThrow('Invalid')
  })

  it('updates active metadata without reloading or moving the current track', async () => {
    const f = fixture()
    await f.backend.dispatch({ type: 'start', ids: ['fern', 'moss'], index: 0 })
    f.observe({ positionSeconds: 45 })
    await f.api.data.dataset('music.tracks').update({ id: 'fern' }, { title: 'Fern canopy', artist: 'Forest & Rain' })
    await vi.waitFor(() => expect(f.player.updateMetadata).toHaveBeenCalledWith(expect.objectContaining({ title: 'Fern canopy', artists: ['Forest', 'Rain'] })))
    expect(f.player.load).toHaveBeenCalledTimes(1)
    expect(f.backend.snapshot()).toMatchObject({ current: { title: 'Fern canopy' }, position: 45, playing: true })
    await f.backend.dispose()
  })
})
