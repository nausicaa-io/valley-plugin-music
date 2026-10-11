import type { HistoryEntry, RepeatMode, Track } from './types'

export interface MusicPlaybackSnapshot {
  revision: number
  sessionId: string | null
  queue: Track[]
  index: number
  playlistId: string | null
  current: Track | null
  playing: boolean
  buffering: boolean
  position: number
  duration: number
  rate: number
  sampleAgeMs: number
  volume: number
  shuffle: boolean
  repeat: RepeatMode
  error: string | null
  errorOutcome?: 'unknown'
  playEvent?: HistoryEntry & { id: string }
}

export type MusicPlaybackAction =
  | { type: 'start'; ids: string[]; index: number; playlistId?: string | null; shuffle?: boolean; position?: number }
  | { type: 'resume' | 'toggle' | 'pause' | 'next' | 'previous' | 'clear' | 'stop' | 'eject' | 'repeat' | 'shuffle' | 'flush' }
  | { type: 'seek' | 'volume'; value: number }
  | { type: 'add'; ids: string[]; where: 'next' | 'end' }
  | { type: 'remove' | 'playQueued'; index: number }
  | { type: 'reorder'; from: number; to: number }

export function playbackPosition(sample: Pick<MusicPlaybackSnapshot, 'position' | 'duration' | 'rate' | 'playing' | 'buffering' | 'sampleAgeMs'>, receivedAt: number, now = performance.now()): number {
  const age = Math.min(3000, Math.max(0, now - receivedAt) + sample.sampleAgeMs)
  return Math.min(sample.duration || Infinity, sample.position + (sample.playing && !sample.buffering ? age / 1000 * sample.rate : 0))
}

export function nextIndex(length: number, index: number, repeat: RepeatMode): number | null {
  if (index < length - 1) return index + 1
  return repeat === 'all' && length > 0 ? 0 : null
}

export function parsePlaybackAction(value: unknown): MusicPlaybackAction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid playback action')
  const action = value as Record<string, unknown>
  const index = (key: string) => typeof action[key] === 'number' && Number.isSafeInteger(action[key]) && Number(action[key]) >= 0
  const ids = () => Array.isArray(action.ids) && action.ids.length <= 10000 && action.ids.every(id => typeof id === 'string' && id.length > 0 && id.length <= 512)
  const finite = () => typeof action.value === 'number' && Number.isFinite(action.value) && action.value >= 0
  if (['resume', 'toggle', 'pause', 'next', 'previous', 'clear', 'stop', 'eject', 'repeat', 'shuffle', 'flush'].includes(String(action.type))) return action as MusicPlaybackAction
  if (action.type === 'start' && ids() && index('index') && (action.playlistId === undefined || action.playlistId === null || typeof action.playlistId === 'string')
    && (action.shuffle === undefined || typeof action.shuffle === 'boolean')
    && (action.position === undefined || typeof action.position === 'number' && Number.isFinite(action.position) && action.position >= 0)) return action as MusicPlaybackAction
  if ((action.type === 'seek' || action.type === 'volume') && finite() && (action.type !== 'volume' || Number(action.value) <= 1)) return action as MusicPlaybackAction
  if (action.type === 'add' && ids() && (action.where === 'next' || action.where === 'end')) return action as MusicPlaybackAction
  if ((action.type === 'remove' || action.type === 'playQueued') && index('index')) return action as MusicPlaybackAction
  if (action.type === 'reorder' && index('from') && index('to')) return action as MusicPlaybackAction
  throw new Error('Invalid playback action')
}
