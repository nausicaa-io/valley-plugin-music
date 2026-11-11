import { React, api } from './runtime'
import { uiText } from './localization'
import type { MusicSnapshot, MusicStore, PageTarget, PageView, PodcastView } from './store'

/** The page state one Music page renders: the global page, or one pinned tab's own. */
export interface PageNavState {
  pageView: PageView
  pageViewNonce: number
  canGoBack: boolean
  canGoForward: boolean
  pageSearch: string
  podcastView: PodcastView
  podcastCanGoBack: boolean
  podcastCanGoForward: boolean
}

/**
 * Where the page's own navigation goes. The main Music tab drives the store (and
 * its persisted `navigationState`); a tab pinned with ⌘-click keeps the same
 * operations on tab-local state, so it never moves the main page.
 */
export interface PageNavigator {
  /** The pinned tab's instance id; null for the store-backed main page. */
  readonly instanceId: string | null
  /** The library a pinned tab shows; null follows the global library mode. */
  readonly library: 'music' | 'podcast' | null
  subscribe(listener: () => void): () => void
  getState(): PageNavState
  showPlaylist(id: string): void
  revealSong(id: string): void
  showArtist(nameOrId: string): void
  showHome(): void
  setPageSearch(query: string): void
  goPageHistory(delta: -1 | 1): void
  showPodcastShow(id: string): void
  showPodcastHome(): void
  goPodcastHistory(delta: -1 | 1): void
}

const ID_KINDS = ['playlist', 'artist', 'song', 'show'] as const
let tokenCounter = 0

/** `<kind>:<encoded id>:<token>`; the token keeps two tabs pinned to one destination apart. */
export function formatPageTarget(target: PageTarget, token = `${Date.now().toString(36)}${(tokenCounter++).toString(36)}`): string {
  return `${target.kind}:${'id' in target ? encodeURIComponent(target.id) : ''}:${token}`
}

export function parsePageTarget(instanceId: string | undefined): PageTarget | null {
  if (!instanceId) return null
  const [kind, encoded = '', ...rest] = instanceId.split(':')
  if (rest.length > 1) return null
  if (kind === 'home' || kind === 'podcasts') return encoded ? null : { kind }
  if (!(ID_KINDS as readonly string[]).includes(kind)) return null
  let id: string
  try { id = decodeURIComponent(encoded) } catch { return null }
  return id ? { kind: kind as (typeof ID_KINDS)[number], id } : null
}

/** ⌘/Ctrl-click, ⌘-Enter or a middle click opens a destination in a new tab. */
export function isNewTabClick(event: { metaKey: boolean; ctrlKey: boolean; button?: number }): boolean {
  return event.button === 1 || api.ui.hasModKey(event)
}

/** Forward a middle click to the row's open handler (browsers only send `auxclick` for it). */
export function onMiddleClick(open: (event: React.MouseEvent) => void): (event: React.MouseEvent) => void {
  return (event) => {
    if (event.button !== 1) return
    // A nested control (the cover's play button, the favourite heart) never opens the row's destination.
    const nested = (event.target as Element | null)?.closest?.('button')
    if (nested && nested !== event.currentTarget) return
    event.preventDefault()
    open(event)
  }
}

export function targetTitle(snap: MusicSnapshot, target: PageTarget): string {
  if (target.kind === 'home') return uiText('plugin.music.name')
  if (target.kind === 'podcasts') return uiText('music.podcasts')
  const name = target.kind === 'playlist' ? snap.playlists.find((item) => item.id === target.id)?.name
    : target.kind === 'artist' ? snap.artists.find((item) => item.id === target.id)?.name
      : target.kind === 'song' ? snap.tracks.find((item) => item.id === target.id)?.title
        : snap.shows.find((item) => item.id === target.id)?.name
  return name ?? uiText(target.kind === 'show' ? 'music.podcasts' : 'plugin.music.name')
}

/** The tab title for what a pinned tab currently shows. */
export function navStateTitle(snap: MusicSnapshot, library: 'music' | 'podcast', state: PageNavState): string {
  if (library === 'podcast') {
    const view = state.podcastView
    return targetTitle(snap, view.mode === 'show' ? { kind: 'show', id: view.id } : { kind: 'podcasts' })
  }
  const view = state.pageView
  const reveal = view.mode === 'song' ? view.id : 'reveal' in view ? view.reveal : undefined
  const song = reveal ? snap.tracks.find((item) => item.id === reveal)?.title : undefined
  if (song) return song
  return targetTitle(snap, view.mode === 'home' || view.mode === 'song' ? { kind: 'home' } : { kind: view.mode, id: view.id })
}

/** Open a destination in a new Music tab pinned to it; the main page stays where it is. */
export function openPageTargetInNewTab(store: MusicStore, target: PageTarget): void {
  api.workspace.openMainTab({ instanceId: formatPageTarget(target), title: targetTitle(store.getSnapshot(), target), newTab: true })
}

/** A click on a navigating control: a new pinned tab on ⌘/middle click, else the usual navigation. */
export function navigateOrOpenTab(event: { metaKey: boolean; ctrlKey: boolean; button?: number }, store: MusicStore, target: PageTarget, navigate: () => void): void {
  if (isNewTabClick(event)) openPageTargetInNewTab(store, target)
  else navigate()
}

const globals = new WeakMap<MusicStore, PageNavigator>()

function globalNavigator(store: MusicStore): PageNavigator {
  const existing = globals.get(store)
  if (existing) return existing
  let cached: PageNavState | null = null
  const nav: PageNavigator = {
    instanceId: null,
    library: null,
    subscribe: store.subscribe,
    getState: () => {
      const snap = store.getSnapshot()
      const next: PageNavState = {
        pageView: snap.pageView,
        pageViewNonce: snap.pageViewNonce,
        canGoBack: snap.canGoBack,
        canGoForward: snap.canGoForward,
        pageSearch: snap.pageSearch,
        podcastView: snap.podcastView,
        podcastCanGoBack: snap.podcastCanGoBack,
        podcastCanGoForward: snap.podcastCanGoForward
      }
      if (cached && (Object.keys(next) as (keyof PageNavState)[]).every((key) => Object.is(next[key], cached![key]))) return cached
      cached = next
      return next
    },
    showPlaylist: (id) => store.showPlaylist(id),
    revealSong: (id) => store.revealSong(id),
    showArtist: (nameOrId) => store.showArtist(nameOrId),
    showHome: () => store.showHome(),
    setPageSearch: (query) => store.setPageSearch(query),
    goPageHistory: (delta) => (delta < 0 ? store.goPageBack() : store.goPageForward()),
    showPodcastShow: (id) => store.showPodcastShow(id),
    showPodcastHome: () => store.showPodcastHome(),
    goPodcastHistory: (delta) => store.goPodcastHistory(delta)
  }
  globals.set(store, nav)
  return nav
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/** One pinned tab's page: local history and search, resolved through the store but never stored in it. */
class PinnedPageNavigator implements PageNavigator {
  readonly library: 'music' | 'podcast'
  private listeners = new Set<() => void>()
  private history: PageView[]
  private index = 0
  private nonce = 0
  private search = ''
  private podcastHistory: PodcastView[]
  private podcastIndex = 0
  private touched = false
  private pendingSong: string | null = null
  private state: PageNavState

  constructor(private store: MusicStore, readonly instanceId: string, target: PageTarget, private notify: () => void) {
    this.library = target.kind === 'show' || target.kind === 'podcasts' ? 'podcast' : 'music'
    this.podcastHistory = [target.kind === 'show' ? { mode: 'show', id: target.id } : { mode: 'home' }]
    let view: PageView = { mode: 'home' }
    if (target.kind === 'playlist' || target.kind === 'artist') view = { mode: target.kind, id: target.id }
    if (target.kind === 'song') {
      const loading = store.getSnapshot().loading
      view = (loading ? null : store.resolveSongView(target.id)) ?? { mode: 'song', id: target.id }
      if (loading) this.pendingSong = target.id
    }
    this.history = [view]
    this.state = this.build()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    const offStore = this.store.subscribe(listener)
    return () => { this.listeners.delete(listener); offStore() }
  }

  getState = (): PageNavState => {
    // A song target opened before the library loaded resolves (playlist, artist or library) once it has.
    if (this.pendingSong && !this.store.getSnapshot().loading) {
      const view = this.store.resolveSongView(this.pendingSong)
      this.pendingSong = null
      if (view && !this.touched) {
        this.history = [view]
        this.index = 0
        this.nonce += 1
        this.state = this.build()
      }
    }
    return this.state
  }

  showPlaylist(id: string): void {
    const view = this.store.resolvePageView({ kind: 'playlist', id })
    if (view) this.push(view, true)
  }

  revealSong(id: string): void {
    const view = this.store.resolvePageView({ kind: 'song', id })
    if (view) this.push(view, true)
  }

  showArtist(nameOrId: string): void {
    const view = this.store.resolvePageView({ kind: 'artist', id: nameOrId })
    if (view) this.push(view, true)
  }

  showHome(): void {
    this.push({ mode: 'home' }, false)
  }

  setPageSearch(query: string): void {
    this.search = query.slice(0, 500)
    this.changed()
  }

  goPageHistory(delta: -1 | 1): void {
    const next = this.index + delta
    if (next < 0 || next >= this.history.length) return
    this.index = next
    this.nonce += 1
    this.changed()
  }

  showPodcastShow(id: string): void {
    if (!this.store.getSnapshot().shows.some((show) => show.id === id)) return
    this.search = ''
    this.pushPodcast({ mode: 'show', id })
  }

  showPodcastHome(): void {
    this.pushPodcast({ mode: 'home' })
  }

  goPodcastHistory(delta: -1 | 1): void {
    const next = this.podcastIndex + delta
    if (next < 0 || next >= this.podcastHistory.length) return
    this.podcastIndex = next
    this.changed()
  }

  /** Apply a captured view (reload resume or a bookmark) to this tab only. */
  restore(view: PageView, search: string): void {
    const valid = this.store.validatePageView(view)
    if (this.touched) {
      this.push(valid, false)
    } else {
      this.history = [valid]
      this.index = 0
      this.nonce += 1
    }
    this.search = search.slice(0, 500)
    this.changed()
  }

  private push(view: PageView, clearSearch: boolean): void {
    if (!same(this.history[this.index], view)) {
      this.history = [...this.history.slice(0, this.index + 1), view].slice(-20)
      this.index = this.history.length - 1
    }
    if (clearSearch) this.search = ''
    this.nonce += 1
    this.changed()
  }

  private pushPodcast(view: PodcastView): void {
    if (!same(this.podcastHistory[this.podcastIndex], view)) {
      this.podcastHistory = [...this.podcastHistory.slice(0, this.podcastIndex + 1), view].slice(-20)
      this.podcastIndex = this.podcastHistory.length - 1
    }
    this.changed()
  }

  private changed(): void {
    this.touched = true
    this.pendingSong = null
    this.state = this.build()
    this.listeners.forEach((listener) => listener())
    this.notify()
  }

  private build(): PageNavState {
    return {
      pageView: this.history[this.index],
      pageViewNonce: this.nonce,
      canGoBack: this.index > 0,
      canGoForward: this.index < this.history.length - 1,
      pageSearch: this.search,
      podcastView: this.podcastHistory[this.podcastIndex],
      podcastCanGoBack: this.podcastIndex > 0,
      podcastCanGoForward: this.podcastIndex < this.podcastHistory.length - 1
    }
  }
}

interface PinnedRegistry {
  tabs: Map<string, PinnedPageNavigator>
  listeners: Set<() => void>
}

const registries = new WeakMap<MusicStore, PinnedRegistry>()
const MAX_PINNED = 200

function registry(store: MusicStore): PinnedRegistry {
  let entry = registries.get(store)
  if (!entry) {
    entry = { tabs: new Map(), listeners: new Set() }
    registries.set(store, entry)
  }
  return entry
}

/** The navigator of the tab pinned by `instanceId`, or null when the id names no destination. */
export function pinnedNavigator(store: MusicStore, instanceId: string | undefined): PinnedPageNavigator | null {
  const target = parsePageTarget(instanceId)
  if (!target || !instanceId) return null
  const entry = registry(store)
  let nav = entry.tabs.get(instanceId)
  if (!nav) {
    nav = new PinnedPageNavigator(store, instanceId, target, () => entry.listeners.forEach((listener) => listener()))
    entry.tabs.set(instanceId, nav)
    if (entry.tabs.size > MAX_PINNED) entry.tabs.delete(entry.tabs.keys().next().value!)
  }
  return nav
}

/** Notified whenever any pinned tab of this store navigates (for the surface provider). */
export function subscribePinnedTabs(store: MusicStore, listener: () => void): () => void {
  const { listeners } = registry(store)
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// Created on first use: the host React instance only exists once `register` ran.
let navigatorContext: React.Context<PageNavigator | null> | null = null
const pageNavigatorContext = (): React.Context<PageNavigator | null> => (navigatorContext ??= React.createContext<PageNavigator | null>(null))

export const PageNavigatorProvider: React.FC<{ navigator: PageNavigator; children: React.ReactNode }> = ({ navigator, children }) =>
  React.createElement(pageNavigatorContext().Provider, { value: navigator }, children)

/** The page's navigator: the enclosing pinned tab's, else the store-backed main page. */
export function usePageNavigator(store: MusicStore | null): PageNavigator | null {
  const pinned = React.useContext(pageNavigatorContext())
  return pinned ?? (store ? globalNavigator(store) : null)
}

const EMPTY_STATE: PageNavState = {
  pageView: { mode: 'home' },
  pageViewNonce: 0,
  canGoBack: false,
  canGoForward: false,
  pageSearch: '',
  podcastView: { mode: 'home' },
  podcastCanGoBack: false,
  podcastCanGoForward: false
}
const noopSubscribe = (): (() => void) => () => {}

export function usePageNavState(nav: PageNavigator | null): PageNavState {
  const read = React.useCallback(() => nav?.getState() ?? EMPTY_STATE, [nav])
  return React.useSyncExternalStore(nav ? nav.subscribe : noopSubscribe, read)
}
