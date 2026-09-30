import { Blob as NodeBlob } from 'node:buffer'
import type { SongMetadataResult, ValleyPluginApi } from '@valley/plugin-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MediaMetadata, MetadataCancelled, METADATA_LIMITS } from '../src/mediaMetadata'

const result = (size = 3): SongMetadataResult => ({ ok: true, data: { title: 'Fixture', artist: 'Artist', album: null, cover: { data: new Uint8Array(size), mime: 'image/png' } } })

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

describe('shared Music metadata admission', () => {
  let blobs: Map<string, Blob>
  let create: ReturnType<typeof vi.fn>
  let revoke: ReturnType<typeof vi.fn>
  const owners: MediaMetadata[] = []

  beforeEach(() => {
    blobs = new Map()
    let next = 0
    create = vi.fn((blob: Blob) => { const url = `blob:music-${++next}`; blobs.set(url, blob); return url })
    revoke = vi.fn((url: string) => { blobs.delete(url) })
    vi.stubGlobal('Blob', NodeBlob)
    vi.stubGlobal('URL', { createObjectURL: create, revokeObjectURL: revoke })
  })
  afterEach(() => {
    for (const owner of owners.splice(0)) owner.dispose()
    vi.unstubAllGlobals()
  })

  function fixture() {
    const read = vi.fn(async (_file: string): Promise<SongMetadataResult> => result())
    const owner = new MediaMetadata({ drivers: { media: { readMetadata: read } } } as unknown as ValleyPluginApi)
    owners.push(owner)
    return { read, owner }
  }

  it('shares pending and settled detail/cover reads and preserves typed-array slice bytes', async () => {
    const { owner, read } = fixture()
    const held = deferred<SongMetadataResult>()
    read.mockReturnValueOnce(held.promise)
    const first = owner.read('Song.mp3')
    const listener = vi.fn()
    const release = owner.acquire('Song.mp3', listener)
    expect(owner.read('Song.mp3')).toBe(first)
    const data = result().data!
    data.cover!.data = Uint8Array.from([9, 1, 2, 3, 8]).subarray(1, 4)
    held.resolve({ ok: true, data })
    const metadata = await first
    expect(new Uint8Array(await blobs.get(metadata.coverUrl!)!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
    expect(owner.cover('Song.mp3')).toBe(metadata.coverUrl)
    expect(await owner.read('Song.mp3')).toBe(metadata)
    expect(read).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledTimes(1)
    release()
    owner.dispose()
    owner.dispose()
    expect(revoke).toHaveBeenCalledTimes(1)
  })

  it('bounds active native work and queued demand while reserving playback admission', async () => {
    const { owner, read } = fixture()
    const pending: ReturnType<typeof deferred<SongMetadataResult>>[] = []
    read.mockImplementation(() => { const call = deferred<SongMetadataResult>(); pending.push(call); return call.promise })
    const reads = Array.from({ length: METADATA_LIMITS.active + METADATA_LIMITS.queued - 1 }, (_, index) => owner.read(`Song-${index}.mp3`).catch((error: unknown) => error))
    expect(read).toHaveBeenCalledTimes(METADATA_LIMITS.active)
    await expect(owner.read('Overflow.mp3')).rejects.toThrow('queue is full')
    const playback = owner.read('Playing.mp3', true).catch((error: unknown) => error)
    await expect(owner.read('Overflow-priority.mp3', true)).rejects.toThrow('queue is full')
    pending[0].resolve(result())
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(METADATA_LIMITS.active + 1))
    expect(read.mock.calls.at(-1)?.[0]).toBe('Playing.mp3')
    owner.dispose()
    pending.slice(1).forEach((call) => call.resolve(result()))
    await Promise.all([...reads, playback])
    expect(read).toHaveBeenCalledTimes(METADATA_LIMITS.active + 1)
    expect(create).toHaveBeenCalledTimes(1)
    expect(blobs.size).toBe(0)
  })

  it('eventually hydrates admitted visible demand after saturation without retrying completed covers', async () => {
    const { owner, read } = fixture()
    const held = deferred<void>()
    let active = 0
    let peak = 0
    read.mockImplementation(async () => { active++; peak = Math.max(peak, active); await held.promise; active--; return result() })
    const listeners = Array.from({ length: METADATA_LIMITS.retained + 8 }, () => vi.fn())
    const releases = listeners.map((listener, index) => owner.acquire(`Song-${index}.mp3`, listener))
    const playing = vi.fn()
    owner.acquire('Playing.mp3', playing, true)
    expect(read).toHaveBeenCalledTimes(METADATA_LIMITS.active)
    releases[5]()
    releases[70]()
    held.resolve()
    await vi.waitFor(() => expect(playing).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(listeners[METADATA_LIMITS.retained - 2]).toHaveBeenCalledTimes(1))
    expect(read).toHaveBeenCalledTimes(METADATA_LIMITS.retained - 2)
    expect(peak).toBe(METADATA_LIMITS.active)
    expect(read.mock.calls.some(([file]) => ['Song-5.mp3', 'Song-70.mp3', 'Song-95.mp3'].includes(file))).toBe(false)
    expect(listeners.every((listener) => listener.mock.calls.length <= 1)).toBe(true)
    for (let index = 0; index < METADATA_LIMITS.retained; index++) owner.cover(`Song-${index}.mp3`)
    await Promise.resolve()
    expect(read).toHaveBeenCalledTimes(METADATA_LIMITS.retained - 2)
    expect(blobs.size).toBeLessThanOrEqual(METADATA_LIMITS.retained)
  })

  it('replaces waiting demand on invalidation without publishing an old generation', async () => {
    const { owner, read } = fixture()
    const held = deferred<SongMetadataResult>()
    read.mockReturnValue(held.promise)
    const old = Array.from({ length: METADATA_LIMITS.active + METADATA_LIMITS.queued - 1 }, (_, index) => owner.read(`Old-${index}.mp3`).catch((error: unknown) => error))
    const listener = vi.fn()
    owner.acquire('Visible.mp3', listener)
    owner.invalidate()
    held.resolve(result())
    expect((await Promise.all(old)).every((error) => error instanceof MetadataCancelled)).toBe(true)
    await vi.waitFor(() => expect(owner.cover('Visible.mp3')).not.toBeNull())
    expect(read).toHaveBeenCalledTimes(METADATA_LIMITS.active + 1)
    expect(listener).toHaveBeenCalledTimes(2)
    expect(create).toHaveBeenCalledTimes(1)
    owner.dispose()
    expect(blobs.size).toBe(0)
  })

  it('rejects late publication after invalidation and refreshes only current pinned demand', async () => {
    const { owner, read } = fixture()
    const old = deferred<SongMetadataResult>()
    const fresh = deferred<SongMetadataResult>()
    read.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
    const stale = owner.read('Song.mp3').catch((error: unknown) => error)
    const listener = vi.fn()
    owner.acquire('Song.mp3', listener)
    owner.invalidate()
    expect(read).toHaveBeenCalledTimes(2)
    old.resolve(result())
    expect(await stale).toBeInstanceOf(MetadataCancelled)
    expect(create).not.toHaveBeenCalled()
    fresh.resolve(result())
    await vi.waitFor(() => expect(owner.cover('Song.mp3')).toBe('blob:music-1'))
    expect(listener).toHaveBeenCalledTimes(2)
    owner.dispose()
    expect(revoke).toHaveBeenCalledTimes(1)
  })

  it('drops offscreen queued covers while preserving and promoting a joined detail read', async () => {
    const { owner, read } = fixture()
    const held = deferred<SongMetadataResult>()
    read.mockReturnValue(held.promise)
    const active = Array.from({ length: METADATA_LIMITS.active }, (_, index) => owner.read(`Active-${index}.mp3`))
    const offscreen = owner.acquire('Offscreen.mp3', vi.fn())
    const sharedListener = vi.fn()
    const first = owner.acquire('Joined.mp3', sharedListener)
    const second = owner.acquire('Joined.mp3', sharedListener)
    const joined = owner.read('Joined.mp3', true)
    offscreen()
    first()
    first()
    held.resolve(result())
    await Promise.all([...active, joined])
    expect(read.mock.calls.map(([file]) => file)).toEqual(['Active-0.mp3', 'Active-1.mp3', 'Active-2.mp3', 'Active-3.mp3', 'Joined.mp3'])
    expect(sharedListener).toHaveBeenCalledTimes(1)
    second()
  })

  it('does not start queued reads or publish active results after revocation', async () => {
    const { owner, read } = fixture()
    const held = deferred<SongMetadataResult>()
    read.mockReturnValue(held.promise)
    const listener = vi.fn()
    owner.acquire('Pinned.mp3', listener)
    const work = Array.from({ length: 9 }, (_, index) => owner.read(`Song-${index}.mp3`).catch((error: unknown) => error))
    for (let index = 0; index < METADATA_LIMITS.retained + 8; index++) owner.acquire(`Visible-${index}.mp3`, listener)
    owner.dispose()
    held.resolve(result())
    expect((await Promise.all(work)).every((error) => error instanceof MetadataCancelled)).toBe(true)
    expect(read).toHaveBeenCalledTimes(METADATA_LIMITS.active)
    expect(listener).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
    await expect(owner.read('Later.mp3')).rejects.toBeInstanceOf(MetadataCancelled)
  })

  it('stops reentrant delivery after owner revocation without corrupting other successful publications', async () => {
    const { owner } = fixture()
    const failure = new Error('Subscriber failed')
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const accepted = vi.fn()
      const release = owner.acquire('Accepted.mp3', () => { throw failure })
      owner.acquire('Accepted.mp3', accepted)
      await owner.read('Accepted.mp3')
      expect(accepted).toHaveBeenCalledTimes(1)
      expect(owner.cover('Accepted.mp3')).not.toBeNull()
      expect(diagnostic).toHaveBeenCalledWith('[music] cover subscriber failed', failure)
      release()
      owner.acquire('Revoked.mp3', () => owner.dispose())
      const stale = vi.fn()
      owner.acquire('Revoked.mp3', stale)
      await owner.read('Revoked.mp3')
      expect(stale).not.toHaveBeenCalled()
      expect(blobs.size).toBe(0)
    } finally { diagnostic.mockRestore() }
  })

  it('caps pinned covers by bytes and count without eviction/reacquire loops', async () => {
    const { owner, read } = fixture()
    read.mockImplementation(async () => result(METADATA_LIMITS.coverBytes))
    const listeners: ReturnType<typeof vi.fn>[] = []
    for (let index = 0; index < METADATA_LIMITS.retained + 8; index++) {
      const listener = vi.fn()
      listeners.push(listener)
      owner.acquire(`Song-${index}.mp3`, listener)
      await Promise.resolve()
      await Promise.resolve()
    }
    expect(read).toHaveBeenCalledTimes(METADATA_LIMITS.retained - 1)
    expect([...blobs.values()].reduce((sum, blob) => sum + blob.size, 0)).toBeLessThanOrEqual(METADATA_LIMITS.bytes)
    expect(blobs.size).toBeLessThan(METADATA_LIMITS.retained)
    expect(revoke).not.toHaveBeenCalled()
    expect(owner.cover(`Song-${METADATA_LIMITS.retained}.mp3`)).toBeNull()
    const before = read.mock.calls.length
    owner.acquire('Playing.mp3', vi.fn(), true)
    await Promise.resolve()
    expect(read).toHaveBeenCalledTimes(before + 1)
    expect(listeners.every((listener) => listener.mock.calls.length <= 1)).toBe(true)
  })

  it('evicts released least-recently-used entries and revokes every URL exactly once', async () => {
    const { owner, read } = fixture()
    await owner.read('First.mp3')
    await owner.read('Second.mp3')
    const release = owner.acquire('First.mp3', vi.fn())
    for (let index = 2; index <= METADATA_LIMITS.retained; index++) await owner.read(`Song-${index}.mp3`)
    expect(owner.cover('First.mp3')).toBe('blob:music-1')
    expect(owner.cover('Second.mp3')).toBeNull()
    expect(blobs.size).toBe(METADATA_LIMITS.retained)
    expect(read).toHaveBeenCalledTimes(METADATA_LIMITS.retained + 1)
    release()
    owner.retain(new Set())
    expect(blobs.size).toBe(0)
    owner.dispose()
    expect(new Set(revoke.mock.calls.map(([url]) => url)).size).toBe(METADATA_LIMITS.retained + 1)
    expect(revoke).toHaveBeenCalledTimes(METADATA_LIMITS.retained + 1)
  })

  it('retains absent and oversized cover results but retries actual native failures', async () => {
    const { owner, read } = fixture()
    read.mockResolvedValueOnce({ ok: false, error: 'Decoder failed' })
    await expect(owner.read('Retry.mp3')).rejects.toThrow('Decoder failed')
    read.mockResolvedValueOnce(result(METADATA_LIMITS.coverBytes + 1))
    expect(await owner.read('Retry.mp3')).toMatchObject({ title: 'Fixture', coverUrl: null })
    await owner.read('Retry.mp3')
    read.mockResolvedValueOnce({ ok: true, data: { title: null, artist: null, album: null, cover: null } })
    expect(await owner.read('Empty.mp3')).toMatchObject({ coverUrl: null })
    await owner.read('Empty.mp3')
    expect(read).toHaveBeenCalledTimes(3)
    expect(create).not.toHaveBeenCalled()
    owner.invalidate()
    await owner.read('Retry.mp3')
    expect(read).toHaveBeenCalledTimes(4)
  })
})
