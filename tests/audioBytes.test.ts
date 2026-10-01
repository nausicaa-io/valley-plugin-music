import type { PluginBackendApi, ValleyPluginApi } from '@valley/plugin-sdk'
import { describe, expect, it, vi } from 'vitest'
import { readAudioBytes } from '../src/audioBytes'
import { register } from '../src/backend'

function fixture(content: Uint8Array) {
  const handlers = new Map<string, (payload: unknown) => unknown>()
  const files = {
    openVault: vi.fn(async () => ({ handle: 'audio-handle', size: content.length, name: 'Fixture.wav' })),
    read: vi.fn(async (_handle: string, { offset, maxBytes }: { offset: number; maxBytes: number }) => ({
      base64: Buffer.from(content.slice(offset, offset + maxBytes)).toString('base64'),
      done: offset + maxBytes >= content.length
    })),
    release: vi.fn(async () => {})
  }
  const dispose = register({
    files,
    settings: { get: () => ({}) },
    data: { dataset: () => ({ query: async () => ({ rows: [] }), subscribe: () => () => {} }) },
    playback: { createLocalPlayer: async () => ({ sessionId: 'test', getSnapshot: async () => null, onChange: () => () => {}, onAction: () => () => {}, dispose: async () => {} }) },
    rpc: { emit: () => {}, handleOperation: () => () => {}, handle: (method: string, handler: (payload: unknown) => unknown) => { handlers.set(method, handler); return () => { handlers.delete(method) } } }
  } as unknown as PluginBackendApi)
  const api = { backend: { call: vi.fn(async (method: string, payload: unknown) => handlers.get(method)!(payload)) } } as unknown as Pick<ValleyPluginApi, 'backend'>
  return { api, files, dispose }
}

describe('sandbox audio file bridge', () => {
  it('preserves bytes across bounded chunks and releases the backend file handle', async () => {
    const bytes = Uint8Array.from({ length: 700_001 }, (_, index) => index % 256)
    const mock = fixture(bytes)
    expect(new Uint8Array(await readAudioBytes(mock.api, 'Music/Fixture.wav'))).toEqual(bytes)
    expect(mock.files.openVault).toHaveBeenCalledWith('Music/Fixture.wav')
    expect(mock.files.read.mock.calls.map(([, options]) => options)).toEqual([
      { offset: 0, maxBytes: 262144 }, { offset: 262144, maxBytes: 262144 }, { offset: 524288, maxBytes: 262144 }
    ])
    expect(mock.files.release).toHaveBeenCalledWith(['audio-handle'])
    await expect(mock.api.backend.call('audio.read', { handle: 'audio-handle', offset: 0 })).rejects.toThrow('Unknown audio handle')
    mock.dispose()
  })

  it('releases failed reads and rejects incomplete or non-progressing data', async () => {
    for (const result of [{ base64: '', done: false }, { base64: 'AA==', done: true }]) {
      const mock = fixture(new Uint8Array(4))
      mock.files.read.mockResolvedValueOnce(result)
      await expect(readAudioBytes(mock.api, 'Music/Fixture.wav')).rejects.toThrow(/audio (chunk|file)/)
      expect(mock.files.release).toHaveBeenCalledWith(['audio-handle'])
      mock.dispose()
    }
    const mock = fixture(new Uint8Array(4))
    mock.files.read.mockRejectedValueOnce(new Error('File read failed'))
    await expect(readAudioBytes(mock.api, 'Music/Fixture.wav')).rejects.toThrow('File read failed')
    expect(mock.files.release).toHaveBeenCalledWith(['audio-handle'])
    mock.dispose()
  })

  it('rejects foreign handles and invalid offsets before file access', async () => {
    const mock = fixture(new Uint8Array(4))
    await mock.api.backend.call('audio.open', { file: 'Music/Fixture.wav' })
    for (const payload of [{ handle: 'foreign', offset: 0 }, { handle: 'audio-handle', offset: -1 }, { handle: 'audio-handle', offset: 5 }, { handle: 'audio-handle', offset: 0.5 }]) {
      await expect(mock.api.backend.call('audio.read', payload)).rejects.toThrow()
    }
    expect(mock.files.read).not.toHaveBeenCalled()
    mock.dispose()
    expect(mock.files.release).toHaveBeenCalledWith(['audio-handle'])
  })

  it('releases an opening handle if the package is disposed before it resolves', async () => {
    const mock = fixture(new Uint8Array(4))
    let opened!: (value: { handle: string; size: number; name: string }) => void
    mock.files.openVault.mockImplementationOnce(() => new Promise((resolve) => { opened = resolve }))
    const request = mock.api.backend.call('audio.open', { file: 'Music/Fixture.wav' })
    mock.dispose()
    opened({ handle: 'late', size: 4, name: 'Fixture.wav' })
    await expect(request).rejects.toThrow('disposed')
    expect(mock.files.release).toHaveBeenCalledWith(['late'])
  })
})
