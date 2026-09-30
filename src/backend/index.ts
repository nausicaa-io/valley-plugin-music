import type { PluginBackendApi } from '@valley/plugin-sdk'
import { MusicPlayback } from './playback'
import { parsePlaybackAction } from '../playback'

export function register(api: PluginBackendApi): () => Promise<void> {
  const playback = new MusicPlayback(api)
  const handles = new Map<string, number>()
  let disposed = false
  const payload = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid audio request')
    return value as Record<string, unknown>
  }
  const owned = (value: unknown): string => {
    if (typeof value !== 'string' || !handles.has(value)) throw new Error('Unknown audio handle')
    return value
  }
  const off = [
    api.rpc.handle('playback.snapshot', () => playback.read()),
    api.rpc.handle('playback.action', value => playback.dispatch(parsePlaybackAction(value))),
    api.rpc.handle('audio.open', async (value) => {
      const { file } = payload(value)
      if (disposed || typeof file !== 'string' || !file) throw new Error('Invalid audio file')
      const opened = await api.files.openVault(file)
      if (disposed) {
        await api.files.release([opened.handle])
        throw new Error('Audio reader disposed')
      }
      handles.set(opened.handle, opened.size)
      return { handle: opened.handle, size: opened.size }
    }),
    api.rpc.handle('audio.read', async (value) => {
      const { handle: raw, offset } = payload(value)
      const handle = owned(raw)
      if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || offset > handles.get(handle)!) throw new Error('Invalid audio offset')
      return api.files.read(handle, { offset, maxBytes: 256 * 1024 })
    }),
    api.rpc.handle('audio.close', async (value) => {
      const handle = owned(payload(value).handle)
      await api.files.release([handle])
      handles.delete(handle)
      return null
    })
  ]
  return async () => {
    disposed = true
    off.forEach((dispose) => dispose())
    await Promise.all([playback.dispose(), api.files.release([...handles.keys()])])
    handles.clear()
  }
}
