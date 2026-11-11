import { METADATA_PANEL_SEGMENT_V1, provideBookmarkSurface, WORKSPACE_DETAILS_V1, type MetadataPanelSegmentContext, type PluginInspectionSubject, type PluginProperty, type ValleyPluginApi, type PluginCommand, type UiVisual } from '@valley/plugin-sdk'
import { formatTime, resolveCoverPath } from './data'
import { isEpisode, resumePosition } from './podcasts'
import { normalizeArtistName, trackArtists, tracksForArtist } from './artists'
import type { Track } from './types'
import { musicCount } from './localization'
import { Music } from './icons'
import { React, api as runtimeApi } from './runtime'
import { narrowPageView, type MusicSnapshot, type MusicStore, type PageView } from './store'
import { useMusic, useMusicCover } from './hooks'
import { RefreshCw, Settings } from './icons'
import { uiText } from './localization'
import type { InteropValueSchema } from '@valley/plugin-sdk'
import { navStateTitle, pinnedNavigator, subscribePinnedTabs } from './pageNavigator'

const bookmarkStateSchemas: Record<'main_workspace' | 'left_sidebar' | 'right_sidebar' | 'footer', InteropValueSchema> = {
  "main_workspace": {
    "type": "object",
    "properties": {
      "v": {
        "type": "literal",
        "value": 1
      },
      "view": {
        "type": "union",
        "anyOf": [
          {
            "type": "object",
            "properties": {
              "mode": {
                "type": "union",
                "anyOf": [
                  {
                    "type": "literal",
                    "value": "home"
                  }
                ]
              }
            },
            "required": [
              "mode"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "mode": {
                "type": "union",
                "anyOf": [
                  {
                    "type": "literal",
                    "value": "song"
                  },
                  {
                    "type": "literal",
                    "value": "playlist"
                  },
                  {
                    "type": "literal",
                    "value": "artist"
                  }
                ]
              },
              "id": {
                "type": "string"
              }
            },
            "required": [
              "mode",
              "id"
            ],
            "additionalProperties": false
          }
        ]
      },
      "searchQuery": {
        "type": "string"
      }
    },
    "required": [
      "v",
      "view",
      "searchQuery"
    ],
    "additionalProperties": false
  },
  "left_sidebar": {
    "type": "object",
    "properties": {
      "search": {
        "type": "string"
      },
      "sections": {
        "type": "object",
        "properties": {
          "songs": {
            "type": "boolean"
          },
          "favorites": {
            "type": "boolean"
          },
          "playlists": {
            "type": "boolean"
          }
        },
        "required": [
          "songs",
          "favorites",
          "playlists"
        ],
        "additionalProperties": false
      },
      "link": {
        "type": "object",
        "properties": {
          "v": {
            "type": "literal",
            "value": 1
          },
          "view": {
            "type": "union",
            "anyOf": [
              {
                "type": "object",
                "properties": {
                  "mode": {
                    "type": "union",
                    "anyOf": [
                      {
                        "type": "literal",
                        "value": "home"
                      }
                    ]
                  }
                },
                "required": [
                  "mode"
                ],
                "additionalProperties": false
              },
              {
                "type": "object",
                "properties": {
                  "mode": {
                    "type": "union",
                    "anyOf": [
                      {
                        "type": "literal",
                        "value": "song"
                      },
                      {
                        "type": "literal",
                        "value": "playlist"
                      },
                      {
                        "type": "literal",
                        "value": "artist"
                      }
                    ]
                  },
                  "id": {
                    "type": "string"
                  }
                },
                "required": [
                  "mode",
                  "id"
                ],
                "additionalProperties": false
              }
            ]
          },
          "searchQuery": {
            "type": "string"
          }
        },
        "required": [
          "v",
          "view",
          "searchQuery"
        ],
        "additionalProperties": false
      }
    },
    "required": [
      "search",
      "sections",
      "link"
    ],
    "additionalProperties": false
  },
  "right_sidebar": {
    "type": "object",
    "properties": {
      "queueOpen": {
        "type": "boolean"
      },
      "historyOpen": {
        "type": "boolean"
      },
      "scrollTop": {
        "type": "number"
      }
    },
    "required": [
      "queueOpen",
      "historyOpen",
      "scrollTop"
    ],
    "additionalProperties": false
  },
  "footer": {
    "type": "object",
    "properties": {},
    "required": [],
    "additionalProperties": false
  }
}



function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object')
  return value as Record<string, unknown>
}

function selectedView(snapshot: MusicSnapshot, subject?: PluginInspectionSubject): PageView {
  if (subject?.surface === 'right_sidebar') return { mode: 'home' }
  const target = subject?.item?.state ?? subject?.view
  const state = target?.link && typeof target.link === 'object' ? target.link as Record<string, unknown> : target
  const view = state?.view as PageView | undefined
  return view ?? snapshot.pageView
}

function requireEntity(snapshot: MusicSnapshot, view: PageView) {
  if (view.mode === 'home') return null
  const entity = view.mode === 'song' ? snapshot.tracks.find((item) => item.id === view.id)
    : view.mode === 'playlist' ? snapshot.playlists.find((item) => item.id === view.id)
      : snapshot.artists.find((item) => item.id === view.id)
  if (!entity) throw new Error(`The selected ${view.mode} no longer exists`)
  if (view.mode === 'song' && snapshot.missing.has(view.id)) throw new Error('The selected music file no longer exists')
  return entity
}

function trackSummary(snapshot: MusicSnapshot, tracks: Track[], breakdown = true): PluginProperty[] {
  const knownDuration = (track: Track): number => Number.isFinite(track.duration) && (track.duration ?? 0) > 0 ? track.duration! : 0
  const duration = tracks.reduce((sum, track) => sum + knownDuration(track), 0)
  const unknown = tracks.filter(track => !knownDuration(track)).length
  const artistByName = new Map(snapshot.artists.flatMap(artist => [artist.name, ...(artist.aliases ?? [])].map(name => [normalizeArtistName(name), artist] as const)))
  const totals = new Map<string, { name: string; count: number; duration: number }>()
  for (const track of tracks) {
    const credited = new Set<string>()
    for (const name of trackArtists(track)) {
      const artist = artistByName.get(normalizeArtistName(name))
      const id = artist?.id ?? normalizeArtistName(name)
      if (credited.has(id)) continue
      credited.add(id)
      const total = totals.get(id) ?? { name: artist?.name ?? name, count: 0, duration: 0 }
      total.count++
      total.duration += knownDuration(track)
      totals.set(id, total)
    }
  }
  return [
    { id: 'duration', label: 'Total time', labelKey: 'music.info.totalTime', value: formatTime(duration), readOnly: true },
    ...(unknown ? [{ id: 'unknownDuration', label: 'Tracks without duration', labelKey: 'music.info.unknownDuration', value: unknown, readOnly: true }] : []),
    { id: 'artists', label: 'Artists', labelKey: 'music.footer.artists', value: totals.size, readOnly: true },
    ...(breakdown ? [...totals.entries()].sort((a, b) => b[1].duration - a[1].duration || a[1].name.localeCompare(b[1].name)).map(([id, total]) => ({
      id: `artist:${id}`, label: total.name,
      value: `${musicCount(total.count, 'song')} · ${uiText('music.info.minutes', { minutes: Math.round(total.duration / 6) / 10 })}`,
      readOnly: true
    })) : [])
  ]
}

const readOnly = (id: string, labelKey: string, label: string, value: string | number): PluginProperty => ({ id, label, labelKey, value, readOnly: true })

/** Whether the inspected page is the podcast library rather than music. */
function isPodcastSubject(snapshot: MusicSnapshot, subject?: PluginInspectionSubject): boolean {
  return subject?.surface !== 'right_sidebar' && !subject?.item && snapshot.libraryMode === 'podcast'
}

/** The loaded episode, grouped under "Now playing" (`episode:` ids). */
function episodeProperties(snapshot: MusicSnapshot, episode: MusicSnapshot['tracks'][number]): PluginProperty[] {
  const details = episode.details ?? {}
  const progress = snapshot.episodeProgress[episode.id]
  const duration = progress?.duration || episode.duration || 0
  const position = snapshot.currentTrack?.id === episode.id ? snapshot.currentTime : progress?.position ?? 0
  const field = (id: string, labelKey: string, label: string, value: string | number) => readOnly(`episode:${id}`, labelKey, label, value)
  return [
    field('title', 'music.edit.episodeName', 'Episode title', episode.title),
    field('host', 'music.edit.host', 'Host', episode.artist),
    ...(details.guests ? [field('guests', 'music.edit.guests', 'Guests', details.guests)] : []),
    ...(details.season ? [field('season', 'music.edit.season', 'Season', details.season)] : []),
    ...(details.episode ? [field('number', 'music.edit.episodeNumber', 'Episode number', details.episode)] : []),
    ...(details.published ? [field('published', 'music.edit.published', 'Published', details.published)] : []),
    field('duration', 'music.info.totalTime', 'Total time', duration ? formatTime(duration) : ''),
    ...(duration > 0 && position > 0 ? [field('left', 'music.properties.timeLeft', 'Time left', formatTime(Math.max(0, duration - position)))] : []),
    field('speed', 'music.podcast.speed', 'Playback speed', `${snapshot.podcastRate}×`),
    field('moments', 'music.podcast.moments', 'Key moments', (snapshot.episodeMoments[episode.id] ?? []).length),
    field('file', 'music.surface.file', 'File', episode.file)
  ]
}

function podcastProperties(snapshot: MusicSnapshot): PluginProperty[] {
  const view = snapshot.podcastView
  const show = view.mode === 'show' ? snapshot.shows.find(item => item.id === view.id) : undefined
  const episodes = show ? show.episodes : snapshot.episodes
  const durations = episodes.map(episode => snapshot.episodeProgress[episode.id]?.duration || episode.duration || (snapshot.currentTrack?.id === episode.id ? snapshot.duration : 0))
  const total = durations.reduce((sum, value) => sum + value, 0)
  const unknown = durations.filter(value => !value).length
  const started = episodes.filter(episode => (snapshot.episodeProgress[episode.id]?.position ?? 0) >= 5).length
  const current = snapshot.currentTrack && episodes.some(episode => episode.id === snapshot.currentTrack!.id) ? snapshot.currentTrack : null
  const summary = show
    ? [
        readOnly('name', 'music.edit.show', 'Show', show.name),
        readOnly('hosts', 'music.edit.host', 'Host', [...new Set(show.episodes.map(episode => episode.artist).filter(Boolean))].join(', ')),
        readOnly('episodes', 'music.podcast.episodes', 'Episodes', show.episodes.length),
        readOnly('cover', 'music.surface.cover', 'Cover', show.coverPath ?? ''),
        readOnly('folder', 'music.properties.folder', 'Folder', show.id)
      ]
    : [
        readOnly('folder', 'music.settings.podcastFolder', 'Podcast folder', snapshot.podcastPath),
        readOnly('shows', 'music.podcast.shows', 'Shows', snapshot.shows.length),
        readOnly('episodes', 'music.podcast.episodes', 'Episodes', snapshot.episodes.length)
      ]
  return [
    ...summary,
    ...(total > 0 ? [readOnly('duration', 'music.info.totalTime', 'Total time', formatTime(total))] : []),
    ...(unknown && total > 0 ? [readOnly('unknownDuration', 'music.info.unknownDuration', 'Tracks without duration', unknown)] : []),
    readOnly('started', 'music.properties.started', 'Started', started),
    ...(current ? episodeProperties(snapshot, current) : [])
  ]
}

function properties(snapshot: MusicSnapshot, subject?: PluginInspectionSubject): PluginProperty[] {
  if (isPodcastSubject(snapshot, subject)) return podcastProperties(snapshot)
  if (subject?.surface === 'right_sidebar') return [
    { id: 'track', label: 'Current track', labelKey: 'music.properties.track', value: snapshot.currentTrack?.title ?? '', readOnly: true },
    { id: 'artist', label: 'Artist', labelKey: 'music.properties.artist', value: snapshot.currentTrack?.artist ?? '', readOnly: true },
    { id: 'playing', label: 'Playing', labelKey: 'music.properties.playing', value: snapshot.isPlaying, readOnly: true }
  ]
  const view = selectedView(snapshot, subject)
  const entity = requireEntity(snapshot, view)
  if (!entity) return [
    { id: 'library', label: 'Library folder', labelKey: 'plugin.music.meta.library', value: snapshot.musicPath, readOnly: true },
    { id: 'tracks', label: 'Tracks', labelKey: 'music.surface.tracks', value: snapshot.tracks.length, readOnly: true },
    { id: 'playlists', label: 'Playlists', labelKey: 'music.surface.playlists', value: snapshot.playlists.length, readOnly: true },
    ...trackSummary(snapshot, snapshot.tracks)
  ]
  if (view.mode === 'song' && 'file' in entity) return [
    { id: 'title', label: 'Title', labelKey: 'music.surface.title', value: entity.title, readOnly: true },
    { id: 'artist', label: 'Artist', labelKey: 'music.surface.artist', value: entity.artist, readOnly: true },
    { id: 'album', label: 'Album', labelKey: 'music.surface.album', value: entity.album ?? '', readOnly: true },
    ...(['feat', 'songwriter', 'author', 'composer', 'genre', 'year'] as const).map(id => ({ id, label: uiText(`music.edit.${id}`), labelKey: `music.edit.${id}`, value: entity.details?.[id] ?? '', readOnly: true })),
    { id: 'duration', label: 'Total time', labelKey: 'music.info.totalTime', value: entity.duration ? formatTime(entity.duration) : '', readOnly: true },
    { id: 'cover', label: 'Cover', labelKey: 'music.surface.cover', value: entity.details?.cover ?? '', readOnly: true },
    { id: 'file', label: 'File', labelKey: 'music.surface.file', value: entity.file, readOnly: true },
    { id: 'favorite', label: 'Favorite', labelKey: 'music.surface.favorite', value: snapshot.favorites.has(entity.id), type: 'boolean' }
  ]
  if (view.mode === 'playlist' && 'songIds' in entity) return [
    { id: 'name', label: 'Name', labelKey: 'music.surface.name', value: entity.name, type: 'text' },
    { id: 'count', label: 'Tracks', labelKey: 'music.surface.count', value: entity.songIds.length, readOnly: true },
    { id: 'cover', label: 'Cover', labelKey: 'music.surface.cover', value: entity.cover ?? '', type: 'text' },
    ...trackSummary(snapshot, snapshot.playlistTracks[entity.id] ?? [])
  ]
  if (view.mode === 'artist') {
    const artist = snapshot.artists.find((item) => item.id === view.id)!
    return [
      { id: 'name', label: 'Name', labelKey: 'music.surface.name', value: artist.name, type: 'text' },
      { id: 'image', label: 'Image', labelKey: 'music.surface.image', value: artist.image ?? '', type: 'text' },
      { id: 'bio', label: 'Biography', labelKey: 'music.surface.bio', value: artist.bio ?? '', type: 'text' },
      { id: 'count', label: 'Tracks', labelKey: 'music.surface.count', value: tracksForArtist(snapshot.tracks, artist).length, readOnly: true },
      ...trackSummary(snapshot, tracksForArtist(snapshot.tracks, artist), false)
    ]
  }
  return []
}

async function updateProperties(store: MusicStore, subject: PluginInspectionSubject, values: Record<string, unknown>): Promise<void> {
  const snapshot = store.getSnapshot(), view = selectedView(snapshot, subject)
  if (isPodcastSubject(snapshot, subject)) throw new Error('Podcast properties are read-only; edit an episode instead')
  requireEntity(snapshot, view)
  if (view.mode === 'home') throw new Error('Select a track, playlist, or artist first')
  const allowed = view.mode === 'song' ? ['favorite'] : view.mode === 'playlist' ? ['name', 'cover'] : ['name', 'image', 'bio']
  for (const [field, value] of Object.entries(values)) {
    if (!allowed.includes(field)) throw new Error(`Property is read-only or unknown: ${field}`)
    if (field === 'favorite' ? typeof value !== 'boolean' : typeof value !== 'string') throw new Error(`Invalid ${field}`)
    if (field === 'name' && !String(value).trim()) throw new Error('Name cannot be empty')
  }
  if (view.mode === 'song' && 'favorite' in values && snapshot.favorites.has(view.id) !== values.favorite) await store.toggleFavorite(view.id)
  if (view.mode === 'playlist') await store.updatePlaylistProperties(view.id, values)
  if (view.mode === 'artist') await store.updateArtistProperties(view.id, values)
}

export function registerMusicSurfaces(api: ValleyPluginApi, store: MusicStore): () => void {
  const Properties = ({ subject }: MetadataPanelSegmentContext) => {
    const { snap } = useMusic(false)
    const view = selectedView(snap, subject)
    let fields: PluginProperty[]
    try { fields = properties(snap, subject) } catch { return <p role="status">{api.ui.t('bookmarks.openFailed')}</p> }
    const displayValue = (field: PluginProperty): string => {
      if (typeof field.value === 'boolean') return api.ui.t(field.value ? 'common.yes' : 'common.no')
      if (field.id === 'cover' && isPodcastSubject(snap, subject)) return String(field.value || '—')
      if (field.id === 'cover' || field.id === 'image') {
        const path = field.id === 'cover' && view.mode === 'playlist' ? snap.playlistCovers[view.id] : resolveCoverPath(store.getIndexEntries(), String(field.value ?? ''))
        return path || String(field.value || '—')
      }
      return String(field.value ?? '') || '—'
    }
    const rows = (items: PluginProperty[]) => <dl className="props-info-table">{items.map(field => <div className="props-info-row" key={field.id}>
      <dt className="props-info-key">{field.labelKey ? uiText(field.labelKey) : field.label}</dt>
      <dd className="props-info-value">{displayValue(field)}</dd>
    </div>)}</dl>
    const artists = fields.filter(field => field.id.startsWith('artist:'))
    const episode = fields.filter(field => field.id.startsWith('episode:'))
    return <div className="right-panel-body props-info music-info">
      {rows(fields.filter(field => !field.id.startsWith('artist:') && !field.id.startsWith('episode:')))}
      {episode.length > 0 && <section aria-label={uiText('music.properties.nowPlaying')}>
        <h3 className="music-info-heading">{uiText('music.properties.nowPlaying')}</h3>
        {rows(episode)}
      </section>}
      {artists.length > 0 && <section aria-label={uiText('music.info.artistBreakdown')}>
        <h3 className="music-info-heading">{uiText('music.info.artistBreakdown')}</h3>
        {rows(artists)}
      </section>}
    </div>
  }
  const waitReady = async (): Promise<void> => {
    if (!store.getSnapshot().loading) return
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { off(); reject(new Error('Music is still loading; try again')) }, 15000)
      const off = store.subscribe(() => { if (!store.getSnapshot().loading) { clearTimeout(timeout); off(); resolve() } })
    })
  }
  const actions = () => [
    { id: 'refresh', label: uiText('music.refreshLibrary'), icon: <RefreshCw />, onSelect: () => store.refresh() },
    { id: 'settings', label: uiText('auto.c7f73bb54d92'), icon: <Settings />, onSelect: () => api.workspace.openOwnSettings() }
  ]
  // The tab shows its library's icon, animated (`<icon>-playing`) while anything plays.
  const tabVisual = (library: 'music' | 'podcast'): UiVisual => {
    const snapshot = store.getSnapshot()
    const icon = library === 'podcast' ? 'podcast' : 'headphones'
    return { kind: 'icon', name: snapshot.isPlaying && snapshot.currentTrack ? `${icon}-playing` : icon }
  }
  // A tab pinned with ⌘-click reports and restores its own view; it never reads or writes the main page.
  const pinnedSnapshot = (nav: NonNullable<ReturnType<typeof pinnedNavigator>>) => {
    const snapshot = store.getSnapshot(), state = nav.getState()
    const podcast = nav.library === 'podcast'
    const view: PageView = podcast ? { mode: 'home' } : state.pageView
    const link = { v: 1 as const, view: { ...view }, searchQuery: state.pageSearch }
    let entity: ReturnType<typeof requireEntity> = null
    if (!snapshot.loading) {
      try { entity = requireEntity(snapshot, view) } catch { /* Keep recovery navigation available for missing items. */ }
    }
    return {
      title: snapshot.loading ? 'Music' : navStateTitle(snapshot, podcast ? 'podcast' : 'music', state), view: link,
      visual: tabVisual(podcast ? 'podcast' : 'music'),
      ...(entity ? { item: { id: entity.id, title: 'title' in entity ? entity.title : entity.name, state: link } } : {}),
      navigation: podcast
        ? { canGoBack: state.podcastCanGoBack, canGoForward: state.podcastCanGoForward, goBack: () => nav.goPodcastHistory(-1), goForward: () => nav.goPodcastHistory(1) }
        : { canGoBack: state.canGoBack, canGoForward: state.canGoForward, goBack: () => nav.goPageHistory(-1), goForward: () => nav.goPageHistory(1) },
      actions: actions()
    }
  }
  const surfaces = (['main_workspace', 'left_sidebar', 'right_sidebar', 'footer'] as const).map((surface) => provideBookmarkSurface(api, {
    id: `music.${surface}`, surface,
    subscribe: surface === 'main_workspace'
      ? (listener: () => void) => { const offStore = store.subscribe(listener), offPinned = subscribePinnedTabs(store, listener); return () => { offStore(); offPinned() } }
      : store.subscribe,
    getSnapshot: (instanceId?: string) => {
      const pinned = surface === 'main_workspace' ? pinnedNavigator(store, instanceId) : null
      if (pinned) return pinnedSnapshot(pinned)
      const snapshot = store.getSnapshot(), link = store.buildLinkState()
      const panel = surface === 'left_sidebar' ? store.captureLeftWorkspaceView() : surface === 'right_sidebar' ? store.captureRightWorkspaceView() : undefined
      const view = surface === 'main_workspace' ? link : { ...(panel && typeof panel === 'object' ? panel : {}), ...(surface === 'left_sidebar' ? { link } : {}) }
      let entity: ReturnType<typeof requireEntity> = null
      const podcastShow = snapshot.libraryMode === 'podcast' && snapshot.podcastView.mode === 'show' ? snapshot.shows.find(show => show.id === (snapshot.podcastView as { id: string }).id) : undefined
      if (!snapshot.loading && surface !== 'right_sidebar' && surface !== 'footer' && snapshot.libraryMode !== 'podcast') {
        try { entity = requireEntity(snapshot, snapshot.pageView) } catch { /* Keep recovery navigation available for missing items. */ }
      }
      return {
        ...(surface === 'main_workspace' && podcastShow ? { item: { id: podcastShow.id, title: podcastShow.name, state: view } } : {}),
        title: snapshot.libraryMode === 'podcast' ? 'Podcasts' : 'Music', view,
        ...(surface === 'main_workspace' ? { visual: tabVisual(snapshot.libraryMode) } : {}),
        ...(entity ? { item: { id: entity.id, title: 'title' in entity ? entity.title : entity.name, state: view } } : {}),
        ...(surface === 'main_workspace' ? { navigation: { canGoBack: snapshot.canGoBack, canGoForward: snapshot.canGoForward, goBack: () => store.goPageBack(), goForward: () => store.goPageForward() } } : {}),
        actions: actions()
      }
    },
    restore: async (state, instanceId, options) => {
      await waitReady()
      const pinned = surface === 'main_workspace' ? pinnedNavigator(store, instanceId) : null
      if (pinned) {
        // A podcast tab's destination lives in its instance id; the bookmark schema carries music views only.
        if (pinned.library === 'podcast') return
        const value = record(state)
        const view = narrowPageView(value.view)
        if (value.v !== 1 || !view || typeof value.searchQuery !== 'string' || value.searchQuery.length > 500) throw new Error('This Music bookmark is invalid')
        requireEntity(store.getSnapshot(), view)
        pinned.restore(view, value.searchQuery)
        return
      }
      const link = surface === 'left_sidebar' ? state.link : surface === 'main_workspace' ? state : null
      if (link && (!options?.background || surface === 'main_workspace')) {
        const value = record(link)
        const view = record(value.view) as PageView
        requireEntity(store.getSnapshot(), view)
        if (!store.applyLinkState(value)) throw new Error('This Music bookmark is invalid')
      }
      if (surface === 'left_sidebar') store.restoreLeftWorkspaceView(state)
      if (surface === 'right_sidebar') store.restoreRightWorkspaceView(state)
    }
  }, { stateSchema: bookmarkStateSchemas[surface], description: (snapshot, item) => typeof snapshot.view.path === 'string' && snapshot.view.path ? snapshot.view.path : uiText(item ? 'bookmark.item' : 'bookmark.view') }))
  let durationTracks: MusicSnapshot['tracks'] | undefined
  let libraryDuration = ''
  const offDetails = api.interop.extensions.provide(WORKSPACE_DETAILS_V1, {
    id: 'music.details', label: 'Music', labelKey: 'plugin.music.name', pluginViews: true,
    items: ['songs', 'playlists', 'artists', 'favorites', 'queue', 'duration', 'nowPlaying', 'position', 'library', 'shows', 'episodes', 'inProgress', 'speed'].map(id => ({ id, label: uiText(`music.footer.${id}`), labelKey: `music.footer.${id}`, kind: 'text' as const })),
    defaultItems: ['songs', 'playlists'], subscribe: store.subscribe,
    getSnapshot: () => {
      const snapshot = store.getSnapshot()
      if (durationTracks !== snapshot.tracks) {
        durationTracks = snapshot.tracks
        libraryDuration = formatTime(snapshot.tracks.reduce((total, track) => total + (track.duration ?? 0), 0))
      }
      return { items: {
        songs: { text: musicCount(snapshot.tracks.length, 'song') },
        playlists: { text: musicCount(snapshot.playlists.length, 'playlist') },
        artists: { text: musicCount(snapshot.artists.length, 'artist') },
        favorites: { text: `${uiText('music.footer.favorites')}: ${snapshot.favorites.size}` },
        queue: { text: `${uiText('music.footer.queue')}: ${snapshot.upNext.length}` },
        duration: { text: libraryDuration },
        nowPlaying: { text: snapshot.currentTrack ? [snapshot.currentTrack.title, snapshot.currentTrack.artist].filter(Boolean).join(' · ') : '' },
        position: { text: snapshot.currentTrack ? `${formatTime(snapshot.currentTime)} / ${formatTime(snapshot.duration || snapshot.currentTrack.duration || 0)}` : '' },
        library: { text: uiText(snapshot.libraryMode === 'podcast' ? 'music.podcast.tabTitle' : 'plugin.music.name') },
        shows: { text: snapshot.podcastPath ? String(snapshot.shows.length) : '' },
        episodes: { text: snapshot.podcastPath ? uiText(`music.count.episode.${snapshot.episodes.length === 1 ? 'one' : 'other'}`, { count: snapshot.episodes.length }) : '' },
        inProgress: { text: snapshot.podcastPath ? String(snapshot.episodes.filter(episode => resumePosition(snapshot.episodeProgress[episode.id]) > 0).length) : '' },
        speed: { text: snapshot.currentTrack && isEpisode(snapshot.currentTrack, snapshot.podcastPath) ? `${snapshot.podcastRate}×` : '' }
      } }
    }
  })
  const offProperties = api.interop.extensions.provide(METADATA_PANEL_SEGMENT_V1, {
    id: 'music.properties', label: 'Music', labelKey: 'plugin.music.name', icon: 'headphones', pluginSurfaces: ['main_workspace'], editCommand: 'properties-update',
    inspect: ({ subject }) => properties(store.getSnapshot(), subject), render: (context) => <Properties {...context} />
  })
  const edit: PluginCommand<{ subject: PluginInspectionSubject; values: Record<string, unknown> }, PluginProperty[], 'write'> & { outputSchema: Record<string, unknown> } = {
    outputSchema: { type: 'array', maxItems: 10000, items: { type: 'object', properties: { id: { type: 'string', maxLength: 16384 }, label: { type: 'string', maxLength: 16384 }, labelKey: { type: 'string', maxLength: 16384 }, value: { anyOf: [{ type: 'string', maxLength: 16384 }, { type: 'number' }, { type: 'boolean' }] }, readOnly: { type: 'boolean' }, type: { enum: ['text', 'number', 'boolean', 'select', 'json'] } }, required: ['id', 'label', 'value'], additionalProperties: false } },
    id: 'properties-update', label: 'Update music properties', labelKey: 'music.surface.properties-update', paletteSafe: false, sideEffect: 'write',
    input: { schema: { type: 'object', properties: { subject: { type: 'object' }, values: { type: 'object' } }, required: ['subject', 'values'] }, parse: (raw) => { const input = record(raw); return { subject: record(input.subject) as unknown as PluginInspectionSubject, values: record(input.values) } } },
    preview: (input) => input, revision: ({ subject }) => properties(store.getSnapshot(), subject),
    run: async ({ subject, values }) => {
      const before = properties(store.getSnapshot(), subject)
      const previous = Object.fromEntries(before.filter((field) => field.id in values).map((field) => [field.id, field.value]))
      await updateProperties(store, subject, values)
      const after = properties(store.getSnapshot(), subject)
      const artist = selectedView(store.getSnapshot(), subject).mode === 'artist'
      return { value: after, revert: artist ? null : {
        label: uiText('music.properties.update'), run: async () => {
          const live = properties(store.getSnapshot(), subject)
          if (JSON.stringify(live) !== JSON.stringify(after)) throw new Error('Music properties changed after this operation')
          await updateProperties(store, subject, previous)
        }
      } }
    }
  }
  const offEdit = api.commands.register(edit)
  return () => { surfaces.forEach((off) => off()); offProperties(); offEdit(); offDetails() }
}

export function NowPlaying() {
  const { store, snap } = useMusic(false)
  const { url, ref } = useMusicCover(store, snap.currentTrack?.id, { eager: true })
  if (!snap.currentTrack) return null
  return <button ref={ref} className="music-now-playing" title={uiText('music.footer.openPlayer')} aria-label={uiText('music.footer.openPlayer')} onClick={() => runtimeApi.workspace.revealOwnPanel('right_sidebar')}>
    {url ? <img src={url} alt="" /> : <Music />}
    <span>{`${snap.currentTrack.title}${snap.currentTrack.artist ? ` · ${snap.currentTrack.artist}` : ''}`}</span>
  </button>
}
