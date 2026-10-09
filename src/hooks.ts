import type { PluginIndexEntry } from '@valley/plugin-sdk'
import { React } from './runtime'
import { getStore, type MusicSnapshot, type MusicStore } from './store'

const EMPTY: MusicSnapshot = {
  loading: true,
  libraryError: null,
  musicPath: '',
  tracks: [],
  playlists: [],
  artists: [],
  playlistTracks: {},
  favorites: new Set(),
  history: [],
  recentlyPlayed: [],
  topPlayed: [],
  missing: new Set(),
  playlistCovers: {},
  sessionId: null,
  playbackRevision: -1,
  playbackRate: 1,
  playbackSampledAt: 0,
  playbackSampleAge: 0,
  currentTrack: null,
  currentPlaylistId: null,
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  volume: 0.8,
  buffering: false,
  playError: null,
  shuffle: false,
  repeatMode: 'off',
  upNext: [],
  resumeTrack: null,
  coverVersion: 0,
  pageView: { mode: 'home' },
  pageViewNonce: 0,
  canGoBack: false,
  canGoForward: false,
  pageSearch: '',
  leftPanelSearch: '',
  leftPanelSections: { songs: false, favorites: false, playlists: true },
  rightQueueOpen: true,
  rightHistoryOpen: false,
  rightPanelScrollTop: 0,
  rightViewNonce: 0
}

const noopSubscribe = (): (() => void) => () => {}

/** Subscribe a view to the session runtime store (live across hot reloads). */
export function useMusic(observeClock = true): { store: MusicStore | null; snap: MusicSnapshot } {
  const store = getStore()
  const previous = React.useRef<MusicSnapshot>(EMPTY)
  const read = React.useCallback(() => {
    const next = store?.getSnapshot() ?? EMPTY
    if (!observeClock && (Object.keys(next) as (keyof MusicSnapshot)[]).every(key =>
      key === 'currentTime' || key === 'duration' || key === 'volume' || key === 'buffering' || key === 'playbackRevision' || key === 'playbackRate' || key === 'playbackSampledAt' || key === 'playbackSampleAge' || Object.is(next[key], previous.current[key]))) return previous.current
    previous.current = next
    return next
  }, [store, observeClock])
  const snap = React.useSyncExternalStore(store ? store.subscribe : noopSubscribe, read)
  return { store, snap }
}

export function useMusicCover(store: MusicStore | null, trackId?: string): { url: string | null; ref: (element: HTMLElement | null) => void } {
  const [element, ref] = React.useState<HTMLElement | null>(null)
  const [visible, setVisible] = React.useState(typeof IntersectionObserver === 'undefined')
  const file = trackId ? store?.coverFile(trackId) : null
  React.useEffect(() => {
    if (!element) return
    const Observer = element.ownerDocument.defaultView?.IntersectionObserver
    if (!Observer) { setVisible(true); return }
    let active = true
    setVisible(false)
    const observer = new Observer(([entry]) => { if (active && entry) setVisible(entry.isIntersecting) }, { rootMargin: '96px' })
    observer.observe(element)
    return () => { active = false; observer.disconnect() }
  }, [element])
  const subscribe = React.useCallback((listener: () => void) => visible && store && trackId
    ? store.subscribeCover(trackId, listener) : () => {}, [file, store, trackId, visible])
  const snapshot = React.useCallback(() => visible && store && trackId ? store.getCoverUrl(trackId) : null, [file, store, trackId, visible])
  const url = React.useSyncExternalStore(subscribe, snapshot, snapshot)
  return { url, ref }
}

const EMPTY_INDEX: readonly PluginIndexEntry[] = Object.freeze([])
const emptyIndex = () => EMPTY_INDEX

export function useMusicIndex(): readonly PluginIndexEntry[] {
  const store = getStore()
  return React.useSyncExternalStore(store ? store.subscribeIndex : noopSubscribe, store ? store.getIndexEntries : emptyIndex)
}
