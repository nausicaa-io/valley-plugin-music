import type { ValleyPluginApi } from '@valley/plugin-sdk'

export async function readAudioBytes(api: Pick<ValleyPluginApi, 'backend'>, file: string): Promise<ArrayBuffer> {
  const opened = await api.backend.call<{ handle: string; size: number }>('audio.open', { file })
  try {
    if (!Number.isSafeInteger(opened.size) || opened.size < 0) throw new Error('Invalid audio size')
    const bytes = new Uint8Array(opened.size)
    let offset = 0
    for (;;) {
      const chunk = await api.backend.call<{ base64: string; done: boolean }>('audio.read', { handle: opened.handle, offset })
      const decoded = Uint8Array.from(atob(chunk.base64), (character) => character.charCodeAt(0))
      if (offset + decoded.length > bytes.length || (!decoded.length && !chunk.done)) throw new Error('Invalid audio chunk')
      bytes.set(decoded, offset)
      offset += decoded.length
      if (chunk.done) {
        if (offset !== bytes.length) throw new Error('Incomplete audio file')
        return bytes.buffer
      }
    }
  } finally {
    await api.backend.call('audio.close', { handle: opened.handle })
  }
}
