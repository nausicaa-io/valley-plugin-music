import { React, api } from './runtime'
import type { FC, ReactNode } from 'react'
import type { MainWorkspaceViewProps } from '@valley/plugin-sdk'
import { assetUrlForRelPath } from '@valley/plugin-sdk/fileTypes'
import { useMusic, useMusicCover } from './hooks'
import { useSongMenu } from './SongMenu'
import { formatTime } from './data'
import { resumePosition, type EpisodeProgress, type PodcastShow } from './podcasts'
import type { MusicSnapshot } from './store'
import type { Track } from './types'
import { uiText } from './localization'
import { Section } from './Panel'
import { PageHeader, type PageCrumb } from './PageHeader'
import { navigateOrOpenTab, onMiddleClick, usePageNavState, usePageNavigator } from './pageNavigator'
import { AlertTriangle, Clock, FolderOpen, ListMusic, Pause, Play, Podcast, Search, Settings, X } from './icons'

export function episodeCount(count: number): string {
  return uiText(`music.count.episode.${count === 1 ? 'one' : 'other'}`, { count })
}

function useShowIndex(shows: readonly PodcastShow[]): Map<string, PodcastShow> {
  return React.useMemo(() => {
    const index = new Map<string, PodcastShow>()
    for (const show of shows) for (const episode of show.episodes) index.set(episode.id, show)
    return index
  }, [shows])
}

/** Episodes with a saved position worth resuming, most recently listened first. */
function continueListening(snap: MusicSnapshot): Track[] {
  return snap.episodes
    .filter(episode => resumePosition(snap.episodeProgress[episode.id]) > 0)
    .sort((a, b) => snap.episodeProgress[b.id].updatedAt.localeCompare(snap.episodeProgress[a.id].updatedAt))
}

function progressFraction(progress: EpisodeProgress | undefined, track: Track): number {
  const duration = progress?.duration || track.duration || 0
  const position = resumePosition(progress)
  return duration > 0 && position > 0 ? Math.min(1, position / duration) : 0
}

function episodeDetail(progress: EpisodeProgress | undefined, track: Track): string {
  const duration = progress?.duration || track.duration || 0
  const position = resumePosition(progress)
  if (position > 0 && duration > position) return uiText('music.podcast.timeLeft', { time: formatTime(duration - position) })
  return duration > 0 ? formatTime(duration) : ''
}

/** Play a show: resume its most recently listened episode, else start with the newest. */
function playShow(store: NonNullable<ReturnType<typeof useMusic>['store']>, snap: MusicSnapshot, show: PodcastShow): void {
  const resume = show.episodes
    .map((episode, index) => ({ index, progress: snap.episodeProgress[episode.id] }))
    .filter(entry => resumePosition(entry.progress) > 0)
    .sort((a, b) => b.progress!.updatedAt.localeCompare(a.progress!.updatedAt))[0]
  store.playEpisodes(show.episodes, resume?.index ?? 0)
}

const ShowArt: FC<{ show: PodcastShow; className: string; emptyClassName: string }> = ({ show, className, emptyClassName }) => {
  const { store } = useMusic(false)
  const { url, ref } = useMusicCover(store, show.coverPath ? undefined : show.episodes[0]?.id)
  const src = show.coverPath ? assetUrlForRelPath(show.coverPath) : url
  return src
    ? <img ref={ref} className={className} src={src} alt="" loading="lazy" />
    : <span ref={ref} className={emptyClassName}><Podcast /></span>
}

const EpisodeCover: FC<{ track: Track; show?: PodcastShow; size?: number }> = ({ track, show, size = 32 }) => {
  const { store } = useMusic(false)
  const { url, ref } = useMusicCover(store, track.id)
  const src = url ?? (show?.coverPath ? assetUrlForRelPath(show.coverPath) : null)
  return (
    <span ref={ref} className={`music-cover ${src ? '' : 'music-cover-empty'}`} style={{ display: 'grid', width: size, height: size }}>
      {src ? <img className="music-cover" style={{ width: size, height: size }} src={src} alt="" loading="lazy" /> : <Podcast />}
    </span>
  )
}

const EqBars: FC<{ playing: boolean; className: string }> = ({ playing, className }) => (
  <span className={`${className} ${playing ? '' : 'paused'}`} aria-hidden>
    <span className="music-row-wave-bar" />
    <span className="music-row-wave-bar" />
    <span className="music-row-wave-bar" />
  </span>
)

/** One episode: the cover plays it, the rest of the row opens its show (sidebar) or plays it (page). */
const EpisodeRow: FC<{
  track: Track
  show?: PodcastShow
  subtitle?: string
  onPlay: () => void
  onOpen?: (event: React.MouseEvent) => void
  onMenu: (e: React.MouseEvent, track: Track) => void
}> = ({ track, show, subtitle, onPlay, onOpen, onMenu }) => {
  const { store, snap } = useMusic(false)
  const active = snap.currentTrack?.id === track.id
  const progress = snap.episodeProgress[track.id]
  const fraction = progressFraction(progress, track)
  const detail = episodeDetail(progress, track)
  const actionLabel = active && snap.isPlaying ? uiText('auto.781961bc81c2') : uiText('auto.5d12bd53552c')
  return (
    <div
      className={`music-row podcast-episode-row ${active ? 'active' : ''} ${onOpen ? 'nav' : ''}`}
      data-track-id={track.id}
      onClick={onOpen}
      onAuxClick={onOpen ? onMiddleClick(onOpen) : undefined}
      onDoubleClick={onOpen ? undefined : onPlay}
      onContextMenu={(e) => onMenu(e, track)}
      role="button"
      tabIndex={0}
    >
      <button
        className="music-row-play"
        title={actionLabel}
        aria-label={actionLabel}
        onClick={(e) => {
          e.stopPropagation()
          if (active) store?.togglePlay()
          else onPlay()
        }}
      >
        <EpisodeCover track={track} show={show} />
        {active && <EqBars playing={snap.isPlaying} className="music-row-wave" />}
        <span className="music-row-playicon">{active && snap.isPlaying ? <Pause /> : <Play />}</span>
      </button>
      <div className="music-row-meta">
        <span className="music-row-title">{track.title}</span>
        <span className="music-row-artist">{[subtitle ?? show?.name, detail].filter(Boolean).join(' · ')}</span>
        {fraction > 0 && <span className="podcast-progress" aria-hidden><span style={{ width: `${fraction * 100}%` }} /></span>}
      </div>
      {snap.missing.has(track.id) && (
        <span className="music-row-missing" title={uiText('auto.2e9bf2bca95b')}>
          <AlertTriangle />
        </span>
      )}
    </div>
  )
}

const ShowRow: FC<{ show: PodcastShow; onOpen: (event: React.MouseEvent) => void }> = ({ show, onOpen }) => {
  const { store, snap } = useMusic(false)
  const active = !!snap.currentTrack && show.episodes.some(episode => episode.id === snap.currentTrack!.id)
  const actionLabel = active && snap.isPlaying ? uiText('auto.781961bc81c2') : uiText('music.podcast.playShow')
  return (
    <div className={`music-row nav ${active ? 'active' : ''}`} onClick={onOpen} onAuxClick={onMiddleClick(onOpen)} role="button" tabIndex={0}>
      <button
        className="music-row-play"
        title={actionLabel}
        aria-label={actionLabel}
        onClick={(e) => {
          e.stopPropagation()
          if (!store) return
          if (active) store.togglePlay()
          else playShow(store, snap, show)
        }}
      >
        <span className="music-cover" style={{ display: 'grid', width: 32, height: 32, overflow: 'hidden' }}>
          <ShowArt show={show} className="music-cover" emptyClassName="music-cover music-cover-empty" />
        </span>
        {active && <EqBars playing={snap.isPlaying} className="music-row-wave" />}
        <span className="music-row-playicon">{active && snap.isPlaying ? <Pause /> : <Play />}</span>
      </button>
      <div className="music-row-meta">
        <span className="music-row-title">{show.name}</span>
        <span className="music-row-artist">{episodeCount(show.episodes.length)}</span>
      </div>
    </div>
  )
}

const LibraryState: FC<{ className: string }> = ({ className }) => {
  const { snap } = useMusic(false)
  if (snap.libraryError) return <div className={className} role="alert">{snap.libraryError}</div>
  if (snap.loading && snap.episodes.length === 0) return <div className={className}>{uiText('auto.78df555a3a52')}</div>
  return (
    <div className={className}>
      {snap.podcastPath
        ? uiText('music.podcast.emptyFolder', { path: snap.podcastPath })
        : uiText('music.podcast.chooseFolder')}
      {!snap.podcastPath && (
        <button className="podcast-settings-link" onClick={() => api.workspace.openOwnSettings()}>
          <Settings /> {uiText('auto.c7f73bb54d92')}
        </button>
      )}
    </div>
  )
}

/** Left sidebar body while the library is in podcast mode. */
export const PodcastPanelBody: FC = () => {
  const { store, snap } = useMusic(false)
  const { openSongMenu, songEditor } = useSongMenu()
  const showIndex = useShowIndex(snap.shows)
  const [showsOpen, setShowsOpen] = React.useState(true)
  const [continueOpen, setContinueOpen] = React.useState(true)
  if (!store) return null
  const openShow = (id: string) => (event: React.MouseEvent): void => navigateOrOpenTab(event, store, { kind: 'show', id }, () => store.showPodcastShow(id))
  const query = snap.leftPanelSearch
  const q = query.trim().toLowerCase()
  const resume = continueListening(snap)

  if (snap.episodes.length === 0) return <div className="panel-body hidescrollbar"><LibraryState className="music-empty podcast-empty" /></div>

  const showResults = q ? snap.shows.filter(show => show.name.toLowerCase().includes(q)) : []
  const episodeResults = q ? snap.episodes.filter(episode => episode.title.toLowerCase().includes(q) || (showIndex.get(episode.id)?.name ?? '').toLowerCase().includes(q)) : []

  return (
    <div className="panel-body hidescrollbar">
      {songEditor}
      <div className="search-field-row">
        <div className="music-search search-field">
          <Search className="search-field-icon" />
          <input
            className="search-field-input"
            value={query}
            placeholder={uiText('music.podcast.searchPanel')}
            onChange={(e) => store.setLeftPanelSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && store.setLeftPanelSearch('')}
          />
          {query && (
            <button className="search-field-action" onClick={() => store.setLeftPanelSearch('')} aria-label={uiText('auto.67300d0fed7c')} title={uiText('auto.67300d0fed7c')}>
              <X />
            </button>
          )}
        </div>
      </div>
      {q ? (
        showResults.length === 0 && episodeResults.length === 0 ? (
          <div className="music-empty small">{uiText('auto.8ba67db2da41')}{' '}{query.trim()}”.</div>
        ) : (
          <>
            {showResults.length > 0 && (
              <div className="music-results">
                <div className="music-results-label">{uiText('music.podcast.shows')}</div>
                {showResults.map(show => <ShowRow key={show.id} show={show} onOpen={openShow(show.id)} />)}
              </div>
            )}
            {episodeResults.length > 0 && (
              <div className="music-results">
                <div className="music-results-label">{uiText('music.podcast.episodes')}</div>
                {episodeResults.slice(0, 100).map((episode, i) => {
                  const show = showIndex.get(episode.id)
                  return <EpisodeRow key={episode.id} track={episode} show={show} onMenu={openSongMenu}
                    onOpen={show ? openShow(show.id) : undefined}
                    onPlay={() => store.playEpisodes(episodeResults, i)} />
                })}
              </div>
            )}
          </>
        )
      ) : (
        <>
          {resume.length > 0 && (
            <Section id="continue" title={uiText('music.podcast.continue')} icon={<Clock />} count={resume.length} open={continueOpen} onOpenChange={setContinueOpen}>
              {resume.map((episode, i) => {
                const show = showIndex.get(episode.id)
                return <EpisodeRow key={episode.id} track={episode} show={show} onMenu={openSongMenu}
                  onOpen={show ? openShow(show.id) : undefined}
                  onPlay={() => store.playEpisodes(resume, i)} />
              })}
            </Section>
          )}
          <Section id="shows" title={uiText('music.podcast.shows')} icon={<Podcast />} count={snap.shows.length} open={showsOpen} onOpenChange={setShowsOpen}>
            {snap.shows.map(show => <ShowRow key={show.id} show={show} onOpen={openShow(show.id)} />)}
          </Section>
        </>
      )}
    </div>
  )
}

const ShowCard: FC<{ show: PodcastShow; onOpen: (event: React.MouseEvent) => void }> = ({ show, onOpen }) => {
  const { store, snap } = useMusic(false)
  const active = !!snap.currentTrack && show.episodes.some(episode => episode.id === snap.currentTrack!.id)
  const label = active && snap.isPlaying ? uiText('auto.781961bc81c2') : uiText('music.podcast.playShow')
  return (
    <div className={`music-pl-card ${active ? 'active' : ''}`} role="button" tabIndex={0} onClick={onOpen} onAuxClick={onMiddleClick(onOpen)}>
      <div className="music-pl-card-art">
        <ShowArt show={show} className="" emptyClassName="music-pl-card-art-empty" />
        {active && <EqBars playing={snap.isPlaying} className="music-card-eq" />}
        <button
          className="music-pl-card-play"
          title={label}
          aria-label={label}
          onClick={(e) => {
            e.stopPropagation()
            if (!store) return
            if (active) store.togglePlay()
            else playShow(store, snap, show)
          }}
        >
          {active && snap.isPlaying ? <Pause /> : <Play />}
        </button>
      </div>
      <span className="music-pl-card-name">{show.name}</span>
      <span className="music-pl-card-count">{episodeCount(show.episodes.length)}</span>
    </div>
  )
}

const EpisodeCard: FC<{ track: Track; show?: PodcastShow; onPlay: () => void; onMenu: (e: React.MouseEvent, track: Track) => void }> = ({ track, show, onPlay, onMenu }) => {
  const { store, snap } = useMusic(false)
  const { url, ref } = useMusicCover(store, track.id)
  const active = snap.currentTrack?.id === track.id
  const src = url ?? (show?.coverPath ? assetUrlForRelPath(show.coverPath) : null)
  const fraction = progressFraction(snap.episodeProgress[track.id], track)
  return (
    <div ref={ref} className={`music-track-card ${active ? 'active' : ''}`} role="button" tabIndex={0}
      onClick={() => (active ? store?.togglePlay() : onPlay())} onContextMenu={(e) => onMenu(e, track)}>
      <span className="music-track-card-art">
        <Podcast />
        {src && <img src={src} alt="" loading="lazy" />}
        {active && <EqBars playing={snap.isPlaying} className="music-card-eq" />}
        {fraction > 0 && <span className="podcast-card-progress" aria-hidden><span style={{ width: `${fraction * 100}%` }} /></span>}
      </span>
      <span className="music-track-card-title">{track.title}</span>
      <span className="music-track-card-sub">{[show?.name, episodeDetail(snap.episodeProgress[track.id], track)].filter(Boolean).join(' · ')}</span>
    </div>
  )
}

const ShowDetail: FC<{ show: PodcastShow; onMenu: (e: React.MouseEvent, track: Track) => void }> = ({ show, onMenu }) => {
  const { store, snap } = useMusic(false)
  if (!store) return null
  const total = show.episodes.reduce((sum, episode) => sum + (episode.duration ?? 0), 0)
  const playingHere = !!snap.currentTrack && show.episodes.some(episode => episode.id === snap.currentTrack!.id)
  return (
    <div className="music-page-body">
      <div className="music-pl-detail-head">
        <div className="music-pl-detail-art">
          <ShowArt show={show} className="" emptyClassName="music-pl-detail-art-empty" />
        </div>
        <div className="music-pl-detail-info">
          <span className="music-pl-detail-kicker">{uiText('music.podcast.kicker')}</span>
          <h1 className="music-pl-detail-name">{show.name}</h1>
          <span className="music-pl-detail-meta">
            {episodeCount(show.episodes.length)}
            {total > 0 ? ` · ${formatTime(total)}` : ''}
          </span>
          <div className="music-pl-detail-actions">
            <button
              className="primary"
              title={playingHere && snap.isPlaying ? uiText('auto.781961bc81c2') : uiText('music.podcast.playShow')}
              aria-label={playingHere && snap.isPlaying ? uiText('auto.781961bc81c2') : uiText('music.podcast.playShow')}
              onClick={() => (playingHere ? store.togglePlay() : playShow(store, snap, show))}
            >
              {playingHere && snap.isPlaying ? <Pause /> : <Play />}
            </button>
            <button className="ghost" onClick={() => api.workspace.revealInFiles(show.id)}>
              <FolderOpen /> {uiText('music.menu.showInFiles')}
            </button>
          </div>
        </div>
      </div>
      <div className="music-page-section">
        <div className="music-page-section-head">
          <ListMusic />
          <h2>{uiText('music.podcast.episodes')}</h2>
          <span className="count">{show.episodes.length}</span>
        </div>
        <div className="music-song-list">
          {show.episodes.map((episode, i) => (
            <EpisodeRow key={episode.id} track={episode} show={show} subtitle={episode.album && episode.album !== show.name ? episode.album : episode.artist} onMenu={onMenu} onPlay={() => store.playEpisodes(show.episodes, i)} />
          ))}
        </div>
      </div>
    </div>
  )
}

/** Main workspace page while the library is in podcast mode. */
export const PodcastPage: FC<MainWorkspaceViewProps> = ({ navigation }) => {
  const { store, snap } = useMusic(false)
  const nav = usePageNavigator(store)
  const navState = usePageNavState(nav)
  const { openSongMenu, songEditor } = useSongMenu()
  const showIndex = useShowIndex(snap.shows)
  const scrollRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    if (!nav) return
    navigation.setController({
      canGoBack: navState.podcastCanGoBack,
      canGoForward: navState.podcastCanGoForward,
      goBack: () => nav.goPodcastHistory(-1),
      goForward: () => nav.goPodcastHistory(1)
    })
    return () => navigation.setController(null)
  }, [navigation, navState.podcastCanGoBack, navState.podcastCanGoForward, nav])

  React.useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
  }, [navState.podcastView])

  if (!store || !nav) return null
  const openShow = (id: string) => (event: React.MouseEvent): void => navigateOrOpenTab(event, store, { kind: 'show', id }, () => nav.showPodcastShow(id))
  const query = navState.pageSearch
  const q = query.trim().toLowerCase()
  const view = navState.podcastView
  const show = view.mode === 'show' ? snap.shows.find(item => item.id === view.id) ?? null : null
  const current = snap.currentTrack && showIndex.has(snap.currentTrack.id) ? snap.currentTrack : null
  const crumbs: PageCrumb[] = [
    ...(show ? [{ label: show.name, title: show.name, onClick: openShow(show.id) }] : []),
    ...(current && (!show || showIndex.get(current.id) === show) ? [{ label: current.title, title: current.title, onClick: (event: React.MouseEvent) => { const owner = showIndex.get(current.id); if (owner) openShow(owner.id)(event) } }] : [])
  ]
  const goHome = (event: React.MouseEvent): void => navigateOrOpenTab(event, store, { kind: 'podcasts' }, () => { nav.setPageSearch(''); nav.showPodcastHome() })
  const results = q ? snap.episodes.filter(episode => episode.title.toLowerCase().includes(q) || (showIndex.get(episode.id)?.name ?? '').toLowerCase().includes(q)) : null
  const resume = continueListening(snap)
  const latest = [...snap.episodes].sort((a, b) => (b.addedAt ?? '').localeCompare(a.addedAt ?? '')).slice(0, 30)

  let body: ReactNode
  if (results) {
    body = (
      <div className="music-page-body">
        <div className="music-page-section">
          <div className="music-page-section-head">
            <Search />
            <h2>{uiText('auto.418633bb7265')}{' '}{query.trim()}”</h2>
            <span className="count">{results.length}</span>
          </div>
          {results.length === 0
            ? <div className="music-page-empty">{uiText('music.podcast.noResults')}</div>
            : <div className="music-song-list">{results.map((episode, i) => <EpisodeRow key={episode.id} track={episode} show={showIndex.get(episode.id)} onMenu={openSongMenu} onPlay={() => store.playEpisodes(results, i)} />)}</div>}
        </div>
      </div>
    )
  } else if (show) {
    body = <ShowDetail show={show} onMenu={openSongMenu} />
  } else if (snap.episodes.length === 0) {
    body = <div className="music-page-body"><LibraryState className="music-page-empty podcast-empty" /></div>
  } else {
    body = (
      <div className="music-page-body">
        {resume.length > 0 && (
          <div className="music-page-section">
            <div className="music-page-section-head">
              <Clock />
              <h2>{uiText('music.podcast.continue')}</h2>
              <span className="count">{resume.length}</span>
            </div>
            <div className="music-shelf hidescrollbar">
              {resume.slice(0, 12).map((episode, i) => (
                <EpisodeCard key={episode.id} track={episode} show={showIndex.get(episode.id)} onMenu={openSongMenu} onPlay={() => store.playEpisodes(resume, i)} />
              ))}
            </div>
          </div>
        )}
        <div className="music-page-section">
          <div className="music-page-section-head">
            <Podcast />
            <h2>{uiText('music.podcast.shows')}</h2>
            <span className="count">{snap.shows.length}</span>
          </div>
          <div className="music-pl-grid">
            {snap.shows.map(item => <ShowCard key={item.id} show={item} onOpen={openShow(item.id)} />)}
          </div>
        </div>
        <div className="music-page-section">
          <div className="music-page-section-head">
            <ListMusic />
            <h2>{uiText('music.podcast.latest')}</h2>
            <span className="count">{snap.episodes.length}</span>
          </div>
          <div className="music-song-list">
            {latest.map((episode, i) => (
              <EpisodeRow key={episode.id} track={episode} show={showIndex.get(episode.id)} onMenu={openSongMenu} onPlay={() => store.playEpisodes(latest, i)} />
            ))}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div ref={scrollRef} className="music-page hidescrollbar">
      {songEditor}
      <div className="music-page-header">
        <PageHeader
          crumbs={crumbs}
          homeLabel={uiText('music.podcast.home')}
          onHome={goHome}
          query={query}
          onQuery={(value) => nav.setPageSearch(value)}
          placeholder={uiText('music.podcast.searchPage')}
        />
      </div>
      {body}
    </div>
  )
}
