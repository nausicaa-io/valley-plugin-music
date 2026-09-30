import { describe, expect, it, vi } from 'vitest'
import { createMockValleyApi } from '@valley/plugin-testkit'
import type { ValleyPluginManifest } from '@valley/plugin-sdk/types'
import { connectPlayback } from './playbackFixture'
import { parsePlaybackAction, playbackPosition } from '../src/playback'
import config from '../config.json'

function fixture() {
  const mock = createMockValleyApi({
    manifest: { id: 'music', datasets: config.datasets as unknown as ValleyPluginManifest['datasets'] },
    datasets: {
      'music.tracks': ['fern', 'moss', 'canopy'].map(id => ({ id, file: `Music/${id}.mp4`, title: id, artist: 'Forest' })),
      'music.queue': [], 'music.play_events': []
    }
  })
  return { ...mock, ...connectPlayback(mock.api) }
}

describe('persistent Music queue', () => {
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

  it('keeps Music Stop queue clearing separate from host pause and serializes rapid queue actions', async () => {
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
    expect(f.datasets.get('music.queue')).toEqual([])
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
