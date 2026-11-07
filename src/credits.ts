import type { ValleyPluginApi } from '@valley/plugin-sdk'
import type { Track } from './types'

/** Each track's artist names (`trackArtists`) and their normalized keys (`normalizeArtistName`), in library order. */
export interface LibraryCredits {
  names: string[][]
  keys: string[][]
}

/** Computes credits for a whole library; null when the input cannot go through the kernel and TypeScript must. */
export type CreditsKernel = (tracks: readonly Pick<Track, 'artist' | 'artists' | 'details'>[]) => LibraryCredits | null

interface CreditsExports {
  credits_input(bytes: number): number
  credits_counts(tracks: number): number
  credits_run(bytes: number, tracks: number): number
  credits_output(): number
  credits_output_len(): number
  credits_strings(): number
  credits_strings_len(): number
  credits_reset(): void
}

const MODULE_ID = 'credits'
/** Input and results must fit the module's 32 MiB memory (`memoryPagesMax` 512); larger libraries use TypeScript. */
const MAX_INPUT_BYTES = 12 * 1024 * 1024
const EXPORTS: (keyof CreditsExports)[] = ['credits_input', 'credits_counts', 'credits_run', 'credits_output', 'credits_output_len', 'credits_strings', 'credits_strings_len', 'credits_reset']

function wellFormed(text: string): boolean {
  const check = (text as string & { isWellFormed?: () => boolean }).isWellFormed
  return check ? check.call(text) : !/\p{Cs}/u.test(text)
}

/** Instantiates the declared `credits` module through `api.wasm` (src/wasm, the Rust `trackArtists`). */
export async function loadCreditsKernel(api: Pick<ValleyPluginApi, 'wasm'>): Promise<CreditsKernel> {
  const env: { memory?: WebAssembly.Memory } = {}
  const instance = await api.wasm.instantiate(MODULE_ID, { env }) as unknown as { exports: Record<string, unknown> }
  const memory = env.memory
  if (!memory) throw new Error('credits module memory was not handed over')
  for (const name of EXPORTS) if (typeof instance.exports[name] !== 'function') throw new Error(`credits module lacks ${name}`)
  const k = instance.exports as unknown as CreditsExports
  const encoder = new TextEncoder(), decoder = new TextDecoder()
  return (tracks) => {
    // Records `artist \x01 feat \x01 artists… \x00`; the kernel rejects a record whose separators disagree with its count.
    let text = ''
    for (const track of tracks) {
      if (track.artists && track.artists.length && !Array.isArray(track.artists)) return null
      const explicit = track.artists && track.artists.length ? track.artists : null
      const artist = explicit ? '' : track.artist ?? ''
      const feat = track.details?.feat ?? ''
      if (typeof artist !== 'string' || typeof feat !== 'string' || explicit?.some(name => typeof name !== 'string')) return null
      text += `${artist}\x01${feat}\x01${explicit ? explicit.join('\x02') : ''}\x00`
    }
    if (!wellFormed(text)) return null
    try {
      // Each call may grow the memory and detach earlier views, so a view is taken only after the call that sizes it.
      const capacity = text.length * 3
      if (capacity > MAX_INPUT_BYTES) return null
      const input = k.credits_input(capacity)
      const { written } = encoder.encodeInto(text, new Uint8Array(memory.buffer, input, capacity))
      const countsAt = k.credits_counts(tracks.length)
      const counts = new Uint32Array(memory.buffer, countsAt, tracks.length)
      tracks.forEach((track, index) => { counts[index] = track.artists?.length ?? 0 })
      if (!k.credits_run(written, tracks.length)) return null
      const outAt = k.credits_output(), outLen = k.credits_output_len(), stringsAt = k.credits_strings(), stringsLen = k.credits_strings_len()
      const out = new Uint32Array(memory.buffer, outAt, outLen)
      const strings = stringsLen ? decoder.decode(new Uint8Array(memory.buffer, stringsAt, stringsLen)).split('\0') : []
      const displays = out[0], displayKey = out.subarray(2, 2 + displays)
      const names: string[][] = new Array(tracks.length), keys: string[][] = new Array(tracks.length)
      let cursor = 2 + displays
      for (let index = 0; index < tracks.length; index++) {
        const count = out[cursor++], trackNames: string[] = new Array(count), trackKeys: string[] = new Array(count)
        for (let j = 0; j < count; j++) {
          const id = out[cursor++]
          trackNames[j] = strings[id]
          trackKeys[j] = strings[displays + displayKey[id]]
        }
        names[index] = trackNames
        keys[index] = trackKeys
      }
      return { names, keys }
    } finally {
      k.credits_reset()
    }
  }
}
