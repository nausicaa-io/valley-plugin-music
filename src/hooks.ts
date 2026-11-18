import type { PluginIndexEntry, PluginIndexSnapshot } from '@valley/plugin-sdk'
import { React, api } from './runtime'
import { createFolderIndex } from './folderIndex'
import { getStore, type MusicSnapshot, type MusicStore } from './store'

const EMPTY: MusicSnapshot = {
  loading: true,
  libraryError: null,
  musicPath: '',
  podcastPath: '',
  tracks: [],
  episodes: [],
  shows: [],
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
  mediaSource: null,
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
  canPlayPrevious: false,
  canPlayNext: false,
  resumeTrack: null,
  coverVersion: 0,
  pageView: { mode: 'home' },
  pageViewNonce: 0,
  canGoBack: false,
  canGoForward: false,
  pageSearch: '',
  leftPanelSearch: '',
  leftPanelSections: { songs: false, favorites: false, playlists: true, artists: true },
  rightQueueOpen: true,
  rightHistoryOpen: false,
  rightPanelScrollTop: 0,
  rightViewNonce: 0,
  libraryMode: 'music',
  panelLibraryMode: 'music',
  podcastView: { mode: 'home' },
  podcastCanGoBack: false,
  podcastCanGoForward: false,
  episodeProgress: {}, episodeMoments: {}, podcastRate: 1, playerCompact: false, coverCrops: {}
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

/** Lazy by default, for long lists. `eager` is for the now-playing artwork, which is always wanted and never waits on the observer. */
export function useMusicCover(store: MusicStore | null, trackId?: string, { eager = false }: { eager?: boolean } = {}): { url: string | null; ref: (element: HTMLElement | null) => void } {
  const [element, ref] = React.useState<HTMLElement | null>(null)
  const [visible, setVisible] = React.useState(eager || typeof IntersectionObserver === 'undefined')
  const file = trackId ? store?.coverFile(trackId) : null
  React.useEffect(() => {
    if (!element || eager) return
    const Observer = element.ownerDocument.defaultView?.IntersectionObserver
    if (!Observer) { setVisible(true); return }
    let active = true
    setVisible(false)
    // One delivery can carry several changes, oldest first; only the newest says where the element is now.
    const observer = new Observer(entries => { const entry = entries.at(-1); if (active && entry) setVisible(entry.isIntersecting) }, { rootMargin: '96px' })
    observer.observe(element)
    return () => { active = false; observer.disconnect() }
  }, [element, eager])
  const subscribe = React.useCallback((listener: () => void) => visible && store && trackId
    ? store.subscribeCover(trackId, listener, eager) : () => {}, [eager, file, store, trackId, visible])
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

const FOLDER_SETTLE_MS = 250
const FOLDER_LOADING: PluginIndexSnapshot = Object.freeze({ status: 'loading', version: null, entries: EMPTY_INDEX })

/** The index under one folder while it is being typed (Settings), observed once the typing pauses. */
export function useFolderIndex(folder: string): PluginIndexSnapshot {
  const [settled, setSettled] = React.useState(folder)
  React.useEffect(() => {
    const timer = setTimeout(() => setSettled(folder), FOLDER_SETTLE_MS)
    return () => clearTimeout(timer)
  }, [folder])
  const [snapshot, setSnapshot] = React.useState<PluginIndexSnapshot>(FOLDER_LOADING)
  React.useEffect(() => {
    const index = createFolderIndex(api, [settled])
    const publish = (): void => setSnapshot(index.getSnapshot())
    const off = index.subscribe(publish)
    publish()
    return () => { off(); void index.dispose() }
  }, [settled])
  return snapshot
}
