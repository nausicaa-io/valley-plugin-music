import type { PluginBackendApi, ValleyPluginApi } from '@valley/plugin-sdk'
import { vi } from 'vitest'
import { MusicPlayback } from '../src/backend/playback'
import { parsePlaybackAction } from '../src/playback'

type Player = Awaited<ReturnType<PluginBackendApi['playback']['createLocalPlayer']>>
type Snapshot = NonNullable<Awaited<ReturnType<Player['getSnapshot']>>>

export function connectPlayback(api: ValleyPluginApi) {
  const listeners = new Set<(snapshot: Snapshot) => void>()
  const events = new Set<(payload: unknown) => void>()
  let snapshot: Snapshot | null = {
    target: { vaultGeneration: 1, sessionId: 'music-session', sessionGeneration: 1, sourceGeneration: 0 },
    descriptor: { key: 'music', providerId: 'music', sourceId: 'music', kind: 'audio', path: '', title: '', artists: [], feat: [] },
    revision: 0, primary: false, effectiveGain: 1, sampleAgeMs: 0,
    capabilities: { seek: true, rate: true, next: true, previous: true },
    state: { status: 'stopped', positionSeconds: 0, durationSeconds: null, volume: 0.8, muted: false, rate: 1 }
  }
  let sourceGeneration = 0
  let action: ((action: 'next' | 'previous') => void | Promise<void>) | undefined
  const observe = (patch: Partial<Snapshot['state']>) => {
    if (!snapshot) throw new Error('No source')
    snapshot = { ...snapshot, revision: snapshot.revision + 1, state: { ...snapshot.state, ...patch } }
    listeners.forEach(listener => listener(snapshot!))
    return snapshot
  }
  const receipt = async (patch: Partial<Snapshot['state']>) => {
    const next = observe(patch)
    return { commandId: 'test', target: next.target, status: 'observed' as const }
  }
  const player: Player = {
    sourceId: 'music', sessionId: 'music-session',
    load: vi.fn(async (descriptor, options) => {
      snapshot = {
        target: { vaultGeneration: 1, sessionId: 'music-session', sessionGeneration: 1, sourceGeneration: ++sourceGeneration }, descriptor,
        revision: sourceGeneration, primary: true, effectiveGain: 1, sampleAgeMs: 0,
        capabilities: { seek: true, rate: true, next: true, previous: true },
        state: { status: options?.autoplay ? 'playing' : 'paused', positionSeconds: options?.position ?? 0, durationSeconds: 180, volume: snapshot?.state.volume ?? 0.8, muted: false, rate: 1 }
      }
      listeners.forEach(listener => listener(snapshot!))
      return snapshot
    }),
    prepareNext: vi.fn(async () => {}),
    updateMetadata: vi.fn(async patch => {
      if (!snapshot) return null
      snapshot = { ...snapshot, revision: snapshot.revision + 1, descriptor: { ...snapshot.descriptor, ...patch } }
      listeners.forEach(listener => listener(snapshot!))
      return snapshot
    }),
    play: vi.fn(() => receipt({ status: 'playing' })),
    pause: vi.fn(() => receipt({ status: 'paused' })),
    stop: vi.fn(() => receipt({ status: 'stopped', positionSeconds: 0 })),
    toggle: vi.fn(() => receipt({ status: snapshot?.state.status === 'playing' ? 'paused' : 'playing' })),
    seek: vi.fn(seconds => receipt({ positionSeconds: Math.min(seconds, 180) })),
    setVolume: vi.fn(volume => receipt({ volume })),
    setMuted: vi.fn(muted => receipt({ muted })),
    setRate: vi.fn(rate => receipt({ rate })),
    getSnapshot: vi.fn(async () => snapshot),
    onChange: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    onAction: listener => { action = listener; return () => { action = undefined } },
    dispose: vi.fn(async () => { listeners.clear() })
  }
  let backend: MusicPlayback | undefined
  const getBackend = () => backend ??= new MusicPlayback({
    data: api.data, settings: api.settings,
    playback: { createLocalPlayer: async () => player },
    rpc: { emit: (_name: string, state: unknown) => events.forEach(listener => listener(state)) }
  } as unknown as PluginBackendApi)
  const fallback = api.backend.call.bind(api.backend)
  api.backend.call = vi.fn(async (method, payload) => {
    if (method === 'playback.snapshot') return getBackend().read()
    if (method === 'playback.action') return getBackend().dispatch(parsePlaybackAction(payload))
    return fallback(method, payload)
  }) as ValleyPluginApi['backend']['call']
  const previousOn = api.backend.on.bind(api.backend)
  api.backend.on = (name, listener) => {
    if (name !== 'playback.changed') return previousOn(name, listener)
    events.add(listener)
    return () => { events.delete(listener) }
  }
  return { get backend() { return getBackend() }, player, observe, next: () => action?.('next'), previous: () => action?.('previous'), detachViews: () => events.clear(), getSnapshot: () => snapshot }
}
