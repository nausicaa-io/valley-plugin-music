import { React, api } from './runtime'
import type { FC, ReactNode } from 'react'
import { assetUrlForRelPath } from '@valley/plugin-sdk/fileTypes'
import { useMusic, useMusicCover } from './hooks'
import { ArtistLinks } from './ArtistLinks'
import { tracksForArtist } from './artists'
import { resolveCoverPath } from './data'
import { usePlaylistMenu, useSongMenu } from './SongMenu'
import type { Artist, Playlist, Track } from './types'
import { musicCount, uiText } from './localization'
import {
  ChevronDown,
  ChevronRight,
  Heart,
  ListMusic,
  Music,
  Pause,
  Play,
  Search,
  User,
  X,
  AlertTriangle
} from './icons'

export const Cover: FC<{ trackId?: string; size?: number }> = ({ trackId, size = 32 }) => {
  const { store } = useMusic(false)
  const { url, ref } = useMusicCover(store, trackId)
  return (
    <span ref={ref} className={`music-cover ${url ? '' : 'music-cover-empty'}`} style={{ display: 'grid', width: size, height: size }}>
      {url ? <img className="music-cover" style={{ width: size, height: size }} src={url} alt="" loading="lazy" /> : <Music />}
    </span>
  )
}

/**
 * A song row. The cover is always the play button — click it to play instantly.
 * When `onOpen` is set (the left panel) clicking the rest of the row navigates
 * the content page to this song; without it (the content page) the row only
 * plays. `data-track-id` lets the page scroll to / flash this row.
 */
export const SongRow: FC<{
  track: Track
  onPlay: () => void
  onOpen?: () => void
  onMenu?: (e: React.MouseEvent, track: Track) => void
}> = ({ track, onPlay, onOpen, onMenu }) => {
  const { store, snap } = useMusic(false)
  const active = snap.currentTrack?.id === track.id
  const missing = snap.missing.has(track.id)
  const actionLabel = active && snap.isPlaying ? uiText('auto.781961bc81c2') : uiText('auto.5d12bd53552c')
  const onAction = active ? () => store?.togglePlay() : onPlay
  return (
    <div
      className={`music-row ${active ? 'active' : ''} ${onOpen ? 'nav' : ''}`}
      data-track-id={track.id}
      onClick={onOpen}
      onDoubleClick={onOpen ? undefined : onPlay}
      onContextMenu={onMenu ? (e) => onMenu(e, track) : undefined}
      role="button"
      tabIndex={0}
    >
      <button
        className="music-row-play"
        title={actionLabel}
        aria-label={actionLabel}
        onClick={(e) => {
          e.stopPropagation()
          onAction()
          onOpen?.()
        }}
      >
        <Cover trackId={track.id} />
        {active && (
          <span className={`music-row-wave ${snap.isPlaying ? '' : 'paused'}`}>
            <span className="music-row-wave-bar" />
            <span className="music-row-wave-bar" />
            <span className="music-row-wave-bar" />
          </span>
        )}
        <span className="music-row-playicon">{active && snap.isPlaying ? <Pause /> : <Play />}</span>
      </button>
      <div className="music-row-meta">
        <span className="music-row-title">{track.title}</span>
        <span className="music-row-artist">
          <ArtistLinks track={track} fallback={track.file.split('/').pop()} />
        </span>
      </div>
      {missing && (
        <span className="music-row-missing" title={uiText('auto.2e9bf2bca95b')}>
          <AlertTriangle />
        </span>
      )}
      <button
        className={`music-row-fav ${snap.favorites.has(track.id) ? 'on' : ''}`}
        title={uiText('auto.9704b6631f6a')}
        aria-label={uiText('auto.9704b6631f6a')}
        onClick={(e) => {
          e.stopPropagation()
          void store?.toggleFavorite(track.id)
        }}
      >
        <Heart />
      </button>
    </div>
  )
}

/** A playlist row in the left panel: click the cover to play it instantly,
 *  click the rest of the row to open it in the content page. */
const PlaylistRow: FC<{
  name: string
  count: number
  active: boolean
  coverPath: string | null
  onOpen: () => void
  onPlay: () => void
  onMenu: (e: React.MouseEvent) => void
}> = ({ name, count, active, coverPath, onOpen, onPlay, onMenu }) => {
  const { store, snap } = useMusic(false)
  const actionLabel = active && snap.isPlaying ? uiText('auto.781961bc81c2') : uiText('auto.a158f4f6ab64')
  const onAction = active ? () => store?.togglePlay() : onPlay
  return (
    <div
      className={`music-row nav ${active ? 'active' : ''}`}
      onClick={onOpen}
      onContextMenu={onMenu}
      role="button"
      tabIndex={0}
    >
      <button
        className="music-row-play"
        title={actionLabel}
        aria-label={actionLabel}
        onClick={(e) => {
          e.stopPropagation()
          onAction()
          onOpen()
        }}
      >
        {coverPath ? (
          <img
            className="music-cover"
            style={{ width: 32, height: 32 }}
            src={assetUrlForRelPath(coverPath)}
            alt=""
            loading="lazy"
          />
        ) : (
          <span className="music-cover music-cover-empty" style={{ width: 32, height: 32 }}>
            <ListMusic />
          </span>
        )}
        {active && (
          <span className={`music-row-wave ${snap.isPlaying ? '' : 'paused'}`}>
            <span className="music-row-wave-bar" />
            <span className="music-row-wave-bar" />
            <span className="music-row-wave-bar" />
          </span>
        )}
        <span className="music-row-playicon">{active && snap.isPlaying ? <Pause /> : <Play />}</span>
      </button>
      <div className="music-row-meta">
        <span className="music-row-title">{name}</span>
        <span className="music-row-artist">
          {musicCount(count, 'song')}
        </span>
      </div>
    </div>
  )
}

/** An artist search result: round avatar plays everything credited to them,
 *  the rest of the row opens the artist page. */
const ArtistRow: FC<{
  artist: Artist
  count: number
  imageUrl: string | null
  trackId?: string
  onOpen: () => void
  onPlay: () => void
}> = ({ artist, count, imageUrl: customImage, trackId, onOpen, onPlay }) => {
  const { store } = useMusic(false)
  const { url, ref } = useMusicCover(store, customImage ? undefined : trackId)
  const imageUrl = customImage ?? url
  return (
    <div ref={ref} className="music-row nav" onClick={onOpen} role="button" tabIndex={0}>
      <button
        className="music-row-play artist"
        title={uiText('auto.124eed498a01')}
        aria-label={uiText('auto.124eed498a01')}
        onClick={(e) => {
          e.stopPropagation()
          onPlay()
          onOpen()
        }}
      >
        {imageUrl ? (
          <img
            className="music-cover artist"
            style={{ width: 32, height: 32 }}
            src={imageUrl}
            alt=""
            loading="lazy"
          />
        ) : (
          <span className="music-cover artist music-cover-empty" style={{ width: 32, height: 32 }}>
            <User />
          </span>
        )}
        <span className="music-row-playicon">
          <Play />
        </span>
      </button>
      <div className="music-row-meta">
        <span className="music-row-title">{artist.name}</span>
        <span className="music-row-artist">
          {musicCount(count, 'song')}
        </span>
      </div>
    </div>
  )
}

const Section: FC<{
  id: 'songs' | 'favorites' | 'playlists'
  title: string
  icon: ReactNode
  count: number
  children: ReactNode
  open: boolean
  onOpenChange: (open: boolean) => void
  action?: ReactNode
}> = ({ id, title, icon, count, children, open, onOpenChange, action }) => {
  return (
    <div className="music-section" data-music-section={id}>
      <button className="music-section-head" onClick={() => onOpenChange(!open)}>
        {open ? <ChevronDown /> : <ChevronRight />}
        {icon}
        <span className="music-section-title">{title}</span>
        {action}
        <span className="music-section-count">{count}</span>
      </button>
      {open && <div className="music-section-body">{children}</div>}
    </div>
  )
}

export const Panel: FC = () => {
  const { store, snap } = useMusic(false)
  const {
    tracks,
    favorites,
    playlists,
    playlistTracks,
    playlistCovers,
    currentPlaylistId,
    artists,
    loading,
    musicPath
  } = snap

  const { openSongMenu, songEditor } = useSongMenu()
  const { openPlaylistMenu } = usePlaylistMenu()
  const [addingPlaylist, setAddingPlaylist] = React.useState(false)
  const [newPlName, setNewPlName] = React.useState('')
  const newPlRef = React.useRef<HTMLInputElement>(null)
  const query = snap.leftPanelSearch

  React.useEffect(() => {
    if (addingPlaylist) newPlRef.current?.focus()
  }, [addingPlaylist])

  if (!store) return null

  const favoriteTracks = tracks.filter((t) => favorites.has(t.id))

  const q = query.trim().toLowerCase()
  const searching = q.length > 0
  const songResults = searching
    ? tracks.filter(
        (t) => t.title.toLowerCase().includes(q) || t.artist.toLowerCase().includes(q)
      )
    : []
  const playlistResults = searching ? playlists.filter((pl) => pl.name.toLowerCase().includes(q)) : []
  const artistResults = searching
    ? artists.filter(
        (a) =>
          a.name.toLowerCase().includes(q) ||
          (a.aliases ?? []).some((al) => al.toLowerCase().includes(q))
      )
    : []
  const noMatches =
    searching && songResults.length === 0 && playlistResults.length === 0 && artistResults.length === 0

  const renderArtist = (a: Artist): ReactNode => {
    const list = tracksForArtist(tracks, a)
    const imagePath = resolveCoverPath(store.getIndexEntries(), a.image)
    const imageUrl = imagePath
      ? assetUrlForRelPath(imagePath)
      : null
    return (
      <ArtistRow
        key={a.id}
        artist={a}
        count={list.length}
        imageUrl={imageUrl}
        trackId={list[0]?.id}
        onOpen={() => store.showArtist(a.id)}
        onPlay={() => list.length && store.playQueue(list, 0, null)}
      />
    )
  }

  const renderPlaylist = (pl: Playlist): ReactNode => {
    const list = playlistTracks[pl.id] ?? []
    return (
      <PlaylistRow
        key={pl.id}
        name={pl.name}
        count={list.length}
        active={currentPlaylistId === pl.id}
        coverPath={playlistCovers[pl.id] ?? null}
        onOpen={() => store.showPlaylist(pl.id)}
        onPlay={() => list.length && store.playQueue(list, 0, pl.id)}
        onMenu={(e) => openPlaylistMenu(e, pl.id)}
      />
    )
  }

  const submitNewPlaylist = async (): Promise<void> => {
    const name = newPlName.trim()
    setAddingPlaylist(false)
    setNewPlName('')
    if (name) await store.createPlaylist(name)
  }

  return (
    <div className="panel music-panel">
      {songEditor}
      <div className="panel-header">
        <span className="panel-title">{uiText('auto.131260cbfbb0')}</span>
        <button
          className="plugin-open-page"
          onClick={() => api.workspace.openMainTab()}
          aria-label={uiText('auto.9ee309dcedc9')}
          title={uiText('auto.9ee309dcedc9')}
        />
      </div>
      <div className="panel-body hidescrollbar">
        {snap.libraryError ? (
          <div className="music-empty" role="alert">{snap.libraryError}</div>
        ) : loading && tracks.length === 0 ? (
          <div className="music-empty">{uiText('auto.78df555a3a52')}</div>
        ) : tracks.length === 0 ? (
          <div className="music-empty">
            {musicPath ? <>{uiText('auto.831bef6ea1ed')}{' '}<code>{musicPath}</code> {uiText('auto.ee711996ebe4')}</> : uiText('music.library.chooseFolder')}</div>
        ) : (
          <>
            <div className="search-field-row">
              <div className="music-search search-field">
                <Search className="search-field-icon" />
                <input
                  className="search-field-input"
                  value={query}
                  placeholder={uiText('auto.7b3ba9f01de0')}
                  onChange={(e) => store.setLeftPanelSearch(e.target.value)}
                  onKeyDown={(e) => e.key === 'Escape' && store.setLeftPanelSearch('')}
                />
                {query && (
                  <button
                    className="search-field-action"
                    onClick={() => store.setLeftPanelSearch('')}
                    aria-label={uiText('auto.67300d0fed7c')}
                    title={uiText('auto.67300d0fed7c')}
                  >
                    <X />
                  </button>
                )}
              </div>
            </div>
            {searching ? (
              noMatches ? (
                <div className="music-empty small">{uiText('auto.8ba67db2da41')}{' '}{query.trim()}”.</div>
              ) : (
                <>
                  {artistResults.length > 0 && (
                    <div className="music-results">
                      <div className="music-results-label">{uiText('auto.1528d87e634e')}</div>
                      {artistResults.map(renderArtist)}
                    </div>
                  )}
                  {playlistResults.length > 0 && (
                    <div className="music-results">
                      <div className="music-results-label">{uiText('auto.77b69f32c878')}</div>
                      {playlistResults.map(renderPlaylist)}
                    </div>
                  )}
                  {songResults.length > 0 && (
                    <div className="music-results">
                      <div className="music-results-label">{uiText('auto.e1404b4267e4')}</div>
                      {songResults.map((track, i) => (
                        <SongRow
                          key={track.id}
                          track={track}
                          onOpen={() => store.revealSong(track.id)}
                          onPlay={() => store.playQueue(songResults, i, null)}
                          onMenu={openSongMenu}
                        />
                      ))}
                    </div>
                  )}
                </>
              )
            ) : (
              <>
                <Section
                  id="songs"
                  title={uiText('auto.b8100f5ba8bd')}
                  icon={<Music />}
                  count={tracks.length}
                  open={snap.leftPanelSections.songs}
                  onOpenChange={(open) => store.setLeftPanelSection('songs', open)}
                >
                  {tracks.map((track, i) => (
                    <SongRow
                      key={track.id}
                      track={track}
                      onOpen={() => store.revealSong(track.id)}
                      onPlay={() => store.playQueue(tracks, i, null)}
                      onMenu={openSongMenu}
                    />
                  ))}
                </Section>

                <Section
                  id="favorites"
                  title={uiText('auto.e6ccc0fdea85')}
                  icon={<Heart />}
                  count={favoriteTracks.length}
                  open={snap.leftPanelSections.favorites}
                  onOpenChange={(open) => store.setLeftPanelSection('favorites', open)}
                >
                  {favoriteTracks.length === 0 ? (
                    <div className="music-empty small">{uiText('auto.6dfaf139840f')}</div>
                  ) : (
                    favoriteTracks.map((track, i) => (
                      <SongRow
                        key={track.id}
                        track={track}
                        onOpen={() => store.revealSong(track.id)}
                        onPlay={() => store.playQueue(favoriteTracks, i, null)}
                        onMenu={openSongMenu}
                      />
                    ))
                  )}
                </Section>

                <Section
                  id="playlists"
                  title={uiText('auto.77b69f32c878')}
                  icon={<ListMusic />}
                  count={playlists.length}
                  open={snap.leftPanelSections.playlists}
                  onOpenChange={(open) => store.setLeftPanelSection('playlists', open)}
                >
                  {addingPlaylist && (
                    <div className="music-newpl">
                      <input
                        ref={newPlRef}
                        value={newPlName}
                        placeholder={uiText('auto.544f7553c85a')}
                        onChange={(e) => setNewPlName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void submitNewPlaylist()
                          if (e.key === 'Escape') {
                            setAddingPlaylist(false)
                            setNewPlName('')
                          }
                        }}
                        onBlur={() => void submitNewPlaylist()}
                      />
                    </div>
                  )}
                  {playlists.length === 0 && !addingPlaylist ? (
                    <div className="music-empty small">{uiText('auto.7fde85a9da87')}</div>
                  ) : (
                    playlists.map(renderPlaylist)
                  )}
                </Section>
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
