import { React, api } from './runtime'
import type { FC } from 'react'
import type { MainWorkspaceViewProps } from '@valley/plugin-sdk'
import { IMAGE_EXTENSIONS, assetUrlForRelPath, fileExtension } from '@valley/plugin-sdk/fileTypes'
import { useMusic, useMusicCover, useMusicIndex } from './hooks'
import { ArtistLinks } from './ArtistLinks'
import { usePlaylistMenu, useSongMenu } from './SongMenu'
import { baseName, formatTime, resolveCoverPath } from './data'
import { Cover, SongRow } from './Panel'
import type { Playlist, Track } from './types'
import { musicCount, uiText } from './localization'
import {
  ChevronLeft,
  Clock,
  Heart,
  Home,
  ImageIcon,
  ListMusic,
  Music,
  Pause,
  Pencil,
  Play,
  Plus,
  Search,
  Shuffle,
  Trash,
  TrendingUp,
  User,
  X
} from './icons'

/** Pick a cover from the vault's images, searched by file name. */
const CoverPicker: FC<{
  current: string | null
  onPick: (fileName: string | null) => void
  onClose: () => void
}> = ({ current, onPick, onClose }) => {
  const entries = useMusicIndex()
  const [query, setQuery] = React.useState('')
  const [dragOver, setDragOver] = React.useState(false)
  const images = React.useMemo(() => {
    const all = entries.map((e) => e.relPath)
      .filter((p) => (IMAGE_EXTENSIONS as readonly string[]).includes(fileExtension(p)))
    const q = query.trim().toLowerCase()
    const filtered = q ? all.filter((p) => baseName(p).toLowerCase().includes(q)) : all
    return filtered.slice(0, 120)
  }, [entries, query])

  /**
   * Drop an image onto the picker. An external file (dragged from Finder) is
   * imported into the vault through the file sorter and the created file becomes
   * the cover. A file already in the vault — or an internal drag carrying its
   * path — is matched by name and stored as the cover with nothing copied.
   */
  const onDropImage = (e: React.DragEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    const files = Array.from(e.dataTransfer.files ?? [])
    if (files.length) {
      void (async () => {
        const created = await api.files.importDropped(files)
        const img = created.find((p) =>
          (IMAGE_EXTENSIONS as readonly string[]).includes(fileExtension(p))
        )
        if (img) onPick(img)
      })()
      return
    }
    const droppedName = e.dataTransfer.getData('text/plain')
    if (!droppedName) return
    const name = baseName(droppedName).toLowerCase()
    const match = entries.map((en) => en.relPath)
      .find(
        (p) =>
          (IMAGE_EXTENSIONS as readonly string[]).includes(fileExtension(p)) &&
          baseName(p).toLowerCase() === name
      )
    if (match) onPick(match)
  }

  const onDragOverPicker = (e: React.DragEvent): void => {
    if (!Array.from(e.dataTransfer.types).includes('Files')) return
    e.preventDefault()
    setDragOver(true)
  }

  return (
    <div className="music-cover-picker-backdrop" onMouseDown={onClose}>
      <div
        className={`music-cover-picker ${dragOver ? 'dragover' : ''}`}
        onMouseDown={(e) => e.stopPropagation()}
        onDragOver={onDragOverPicker}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node)) return
          setDragOver(false)
        }}
        onDrop={onDropImage}
      >
        <div className="music-cover-picker-head">
          <span>{uiText('auto.c902ae5c35bb')}</span>
          <button onClick={onClose} aria-label={uiText('auto.bbfa773e5a63')}>
            <X />
          </button>
        </div>
        <div className="music-cover-search search-field">
          <Search className="search-field-icon" />
          <input
            className="search-field-input"
            autoFocus
            value={query}
            placeholder={uiText('auto.be2bd34d6d1a')}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose()
            }}
          />
        </div>
        {images.length === 0 ? (
          <div className="music-cover-picker-empty">{uiText('auto.0e9c7d619c28')}</div>
        ) : (
          <div className="music-cover-grid">
            {current ? (
              <button
                className="music-cover-first music-cover-first--remove"
                title={uiText('auto.7a5eef5219ad')}
                onClick={() => onPick(null)}
              >
                <span className="music-cover-first-inner">
                  <Trash />
                  <span>{uiText('auto.5f94b03c2e6a')}</span>
                </span>
              </button>
            ) : (
              <button
                className={`music-cover-first music-cover-first--drop ${dragOver ? 'dragover' : ''}`}
                title={uiText('auto.16bdcf95d1ac')}
                onClick={onClose}
              >
                <span className="music-cover-first-inner">
                  <ImageIcon />
                  <span>{uiText('auto.cb6074ce4766')}</span>
                </span>
              </button>
            )}
            {images.map((relPath) => (
              <button
                key={relPath}
                className={current === relPath ? 'selected' : ''}
                title={baseName(relPath)}
                onClick={() => onPick(relPath)}
              >
                <img src={assetUrlForRelPath(relPath)} alt="" loading="lazy" />
                <figcaption>{baseName(relPath)}</figcaption>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/** Animated equalizer badge shown on the cover of the currently-playing album/song. */
const EqBadge: FC<{ playing: boolean }> = ({ playing }) => (
  <span className={`music-card-eq ${playing ? '' : 'paused'}`} aria-hidden>
    <span className="music-row-wave-bar" />
    <span className="music-row-wave-bar" />
    <span className="music-row-wave-bar" />
  </span>
)

const PlaylistArt: FC<{ coverPath: string | null; className: string; emptyClassName: string }> = ({
  coverPath,
  className,
  emptyClassName
}) => {
  if (coverPath) return <img className={className} src={assetUrlForRelPath(coverPath)} alt="" loading="lazy" />
  return (
    <span className={emptyClassName}>
      <ListMusic />
    </span>
  )
}

const PlaylistCard: FC<{
  pl: Playlist
  count: number
  coverPath: string | null
  active: boolean
  playing: boolean
  onOpen: () => void
  onPlay: () => void
  onToggle: () => void
  onMenu: (e: React.MouseEvent, playlistId: string) => void
}> = ({ pl, count, coverPath, active, playing, onOpen, onPlay, onToggle, onMenu }) => (
  <div
    className={`music-pl-card ${active ? 'active' : ''}`}
    role="button"
    tabIndex={0}
    onClick={onOpen}
    onContextMenu={(e) => onMenu(e, pl.id)}
  >
    <div className="music-pl-card-art">
      {coverPath ? (
        <img src={assetUrlForRelPath(coverPath)} alt="" loading="lazy" />
      ) : (
        <span className="music-pl-card-art-empty">
          <ListMusic />
        </span>
      )}
      {active && <EqBadge playing={playing} />}
      <button
        className="music-pl-card-play"
        title={active && playing ? uiText('auto.781961bc81c2') : uiText('auto.a158f4f6ab64')}
        aria-label={active && playing ? uiText('auto.781961bc81c2') : uiText('auto.a158f4f6ab64')}
        onClick={(e) => {
          e.stopPropagation()
          if (active) onToggle()
          else onPlay()
        }}
      >
        {active && playing ? <Pause /> : <Play />}
      </button>
    </div>
    <span className="music-pl-card-name">{pl.name}</span>
    <span className="music-pl-card-count">
      {musicCount(count, 'song')}
    </span>
  </div>
)

const TrackCard: FC<{
  track: Track
  sub?: string
  onPlay: () => void
  onMenu?: (e: React.MouseEvent, track: Track) => void
}> = ({ track, sub, onPlay, onMenu }) => {
  const { store, snap } = useMusic(false)
  const { url, ref } = useMusicCover(store, track.id)
  const active = snap.currentTrack?.id === track.id
  const fav = snap.favorites.has(track.id)
  return (
    <div
      ref={ref}
      className={`music-track-card ${active ? 'active' : ''}`}
      role="button"
      tabIndex={0}
      onClick={() => (active ? store?.togglePlay() : onPlay())}
      onContextMenu={onMenu ? (e) => onMenu(e, track) : undefined}
    >
      <span className="music-track-card-art">
        <Music />
        {url && <img src={url} alt="" loading="lazy" />}
        <button
          className={`music-track-card-fav ${fav ? 'on' : ''}`}
          title={uiText('auto.9704b6631f6a')}
          aria-label={uiText('auto.9704b6631f6a')}
          onClick={(e) => {
            e.stopPropagation()
            void store?.toggleFavorite(track.id)
          }}
        >
          <Heart />
        </button>
        {active && <EqBadge playing={snap.isPlaying} />}
      </span>
      <span className="music-track-card-title">{track.title}</span>
      <span className="music-track-card-sub">{sub ?? <ArtistLinks track={track} />}</span>
    </div>
  )
}

/** One playlist opened full-width: cover, rename, member management. */
const PlaylistDetail: FC<{ playlistId: string; onBack: () => void }> = ({ playlistId, onBack }) => {
  const { store, snap } = useMusic(false)
  const { openSongMenu, songEditor } = useSongMenu(
    (track) => { void store?.removeFromPlaylist(playlistId, track.id) }
  )
  const pl = snap.playlists.find((p) => p.id === playlistId)
  const tracks = snap.playlistTracks[playlistId] ?? []
  const coverPath = snap.playlistCovers[playlistId] ?? null

  const [renaming, setRenaming] = React.useState(false)
  const [nameDraft, setNameDraft] = React.useState(pl?.name ?? '')
  const [pickingCover, setPickingCover] = React.useState(false)
  const [coverDrop, setCoverDrop] = React.useState<'idle' | 'over' | 'miss'>('idle')
  const [adding, setAdding] = React.useState(false)
  const [addQuery, setAddQuery] = React.useState('')
  const [dragIndex, setDragIndex] = React.useState<number | null>(null)
  const [overIndex, setOverIndex] = React.useState<number | null>(null)

  React.useEffect(() => {
    store?.setFocusedPlaylist(playlistId)
  }, [store, playlistId])

  React.useEffect(() => {
    setNameDraft(pl?.name ?? '')
  }, [pl?.name])

  if (!store || !pl) {
    return (
      <div className="music-page-body">
      {songEditor}
        <button className="music-page-back" onClick={onBack}>
          <ChevronLeft /> {uiText('auto.b52b36b7269f')}</button>
        <div className="music-page-empty">{uiText('auto.9cea68b48cf3')}</div>
      </div>
    )
  }

  const commitRename = (): void => {
    setRenaming(false)
    const next = nameDraft.trim()
    if (next && next !== pl.name) void store.renamePlaylist(pl.id, next)
    else setNameDraft(pl.name)
  }

  const totalSeconds = tracks.reduce((sum, t) => sum + (t.duration ?? 0), 0)
  // "Playing" tracks the current SONG, not the playlist context: a member song
  // started from the artist page / library (playlistId null) still lights the
  // button, matching the row highlight, footer and panel.
  const playingHere = !!snap.currentTrack && tracks.some((t) => t.id === snap.currentTrack!.id)
  const plPlaying = playingHere && snap.isPlaying
  const memberIds = new Set(pl.songIds)
  const addCandidates = snap.tracks.filter((t) => {
    if (memberIds.has(t.id)) return false
    const q = addQuery.trim().toLowerCase()
    if (!q) return true
    return (
      t.title.toLowerCase().includes(q) ||
      t.artist.toLowerCase().includes(q) ||
      baseName(t.file).toLowerCase().includes(q)
    )
  })

  const reorder = (from: number, to: number): void => {
    const ids = [...pl.songIds]
    const [moved] = ids.splice(from, 1)
    if (moved !== undefined) ids.splice(to, 0, moved)
    void store.reorderPlaylist(pl.id, ids)
  }

  /** Drop an image onto the cover box: match the dropped file to a vault image by name. */
  const dropCover = (e: React.DragEvent): void => {
    e.preventDefault()
    const dropped = e.dataTransfer.files?.[0]?.name ?? e.dataTransfer.getData('text/plain')
    if (!dropped) return setCoverDrop('idle')
    const name = baseName(dropped).toLowerCase()
    const match = store.getIndexEntries().map((en) => en.relPath)
      .find(
        (p) =>
          (IMAGE_EXTENSIONS as readonly string[]).includes(fileExtension(p)) &&
          baseName(p).toLowerCase() === name
      )
    if (match) {
      void store.setPlaylistCover(pl.id, match)
      setCoverDrop('idle')
    } else {
      setCoverDrop('miss')
      window.setTimeout(() => setCoverDrop('idle'), 2200)
    }
  }

  return (
    <div className="music-page-body">
      {songEditor}
      <div className="music-pl-detail-head">
        <div
          className={`music-pl-detail-art ${coverDrop === 'over' ? 'dragover' : ''} ${coverDrop === 'miss' ? 'dropmiss' : ''}`}
          onDragOver={(e) => {
            e.preventDefault()
            setCoverDrop('over')
          }}
          onDragLeave={() => setCoverDrop((s) => (s === 'over' ? 'idle' : s))}
          onDrop={dropCover}
        >
          <PlaylistArt coverPath={coverPath} className="" emptyClassName="music-pl-detail-art-empty" />
          <button onClick={() => setPickingCover(true)}>
            <ImageIcon /> {coverPath ? uiText('auto.4ffbef63b4b5') : uiText('auto.c83a2da7b7b6')}
          </button>
          {coverDrop !== 'idle' && (
            <span className="music-pl-detail-drop">
              {coverDrop === 'miss' ? uiText('auto.35273bfe3feb') : uiText('auto.b24f5861aebb')}
            </span>
          )}
        </div>
        <div className="music-pl-detail-info">
          <span className="music-pl-detail-kicker">{uiText('auto.cd95b41f85dd')}</span>
          {renaming ? (
            <input
              className="music-pl-detail-name-input"
              autoFocus
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename()
                if (e.key === 'Escape') {
                  setNameDraft(pl.name)
                  setRenaming(false)
                }
              }}
            />
          ) : (
            <h1 className="music-pl-detail-name" title={uiText('auto.d3f4cb898fbe')} onClick={() => setRenaming(true)}>
              {pl.name}
            </h1>
          )}
          <span className="music-pl-detail-meta">
            {musicCount(tracks.length, 'song')}
            {totalSeconds > 0 ? ` · ${formatTime(totalSeconds)}` : ''}
          </span>
          <div className="music-pl-detail-actions">
            <button
              className="primary"
              title={plPlaying ? uiText('auto.781961bc81c2') : uiText('auto.5d12bd53552c')}
              aria-label={plPlaying ? uiText('auto.781961bc81c2') : uiText('auto.5d12bd53552c')}
              onClick={() => {
                if (playingHere) store.togglePlay()
                else if (tracks.length) store.playQueue(tracks, 0, pl.id)
              }}
              disabled={tracks.length === 0}
            >
              {plPlaying ? <Pause /> : <Play />}
            </button>
            <button
              className={`ghost ${snap.shuffle ? 'active' : ''}`}
              title={snap.shuffle ? uiText('auto.785728cf2548') : uiText('auto.e59f975e2ba1')}
              aria-pressed={snap.shuffle}
              onClick={() => {
                const turningOn = !snap.shuffle
                store.toggleShuffle()
                if (turningOn && tracks.length) {
                  store.playQueue(tracks, Math.floor(Math.random() * tracks.length), pl.id)
                }
              }}
            >
              <Shuffle /> {uiText('auto.5b772b7bfd0a')}</button>
            <div className="music-pl-edit">
              <button
                className="ghost"
                aria-haspopup="menu"
                onClick={(e) => {
                  const target = { anchor: e.currentTarget, align: 'end' as const }
                  void api.ui.openMenu([
                    { label: uiText('auto.d3f4cb898fbe'), icon: <Pencil />, onSelect: () => setRenaming(true) },
                    { type: 'separator' },
                    {
                      label: uiText('auto.f6fdbe48dc54'),
                      icon: <Trash />,
                      danger: true,
                      onSelect: () => api.ui.openMenu([
                        { label: uiText('auto.77dfd2135f4d') },
                        {
                          label: uiText('auto.b55b186d3a98'),
                          danger: true,
                          onSelect: async () => {
                            await store.deletePlaylist(pl.id)
                            onBack()
                          }
                        }
                      ], target)
                    }
                  ], target)
                }}
              >
                <Pencil /> {uiText('auto.5301648dcf6b')}</button>
            </div>
            <button
              className={`ghost ${adding ? 'active' : ''}`}
              onClick={() => {
                if (adding) setAddQuery('')
                setAdding((v) => !v)
              }}
            >
              {adding ? <X /> : <Plus />} {adding ? uiText('auto.e9b450d14bc2') : uiText('auto.294c1d9461b2')}
            </button>
          </div>
        </div>
      </div>

      {adding && (
        <div className="music-page-section">
          <div className="music-page-section-head">
            <Plus />
            <h2>{uiText('auto.294c1d9461b2')}</h2>
            <span className="count">{addCandidates.length}</span>
          </div>
          <div className="search-field">
            <Search className="search-field-icon" />
            <input
              className="search-field-input"
              autoFocus
              value={addQuery}
              placeholder={uiText('auto.1269575b4990')}
              onChange={(e) => setAddQuery(e.target.value)}
            />
          </div>
          {addCandidates.length === 0 ? (
            <div className="music-page-empty">{uiText('auto.fa51c3890bc4')}</div>
          ) : (
            addCandidates.slice(0, 30).map((track) => (
              <div key={track.id} className="music-row" role="button" tabIndex={0}>
                <Cover trackId={track.id} />
                <div className="music-row-meta">
                  <span className="music-row-title">{track.title}</span>
                  <span className="music-row-artist">
                    <ArtistLinks track={track} fallback={baseName(track.file)} />
                  </span>
                </div>
                <button
                  className="music-row-add"
                  title={uiText('auto.3e241e3cc63e')}
                  aria-label={uiText('auto.3e241e3cc63e')}
                  onClick={() => void store.addToPlaylist(pl.id, track.id)}
                >
                  <Plus />
                </button>
              </div>
            ))
          )}
        </div>
      )}

      <div className="music-page-section">
        <div className="music-page-section-head">
          <ListMusic />
          <h2>{uiText('auto.e1404b4267e4')}</h2>
          <span className="count">{tracks.length}</span>
        </div>
        {tracks.length === 0 ? (
          <div className="music-page-empty">{uiText('auto.fc779d1eda35')}</div>
        ) : (
          <div className="music-song-list">
          {tracks.map((track, i) => {
            const active = snap.currentTrack?.id === track.id
            return (
            <div
              key={`${track.id}-${i}`}
              data-track-id={track.id}
              className={`music-row music-pl-row ${active ? 'active' : ''} ${dragIndex === i ? 'dragging' : ''} ${dragIndex !== null && dragIndex !== i && overIndex === i ? 'drop-before' : ''}`}
              draggable
              onDragStart={() => setDragIndex(i)}
              onDragOver={(e) => {
                e.preventDefault()
                setOverIndex(i)
              }}
              onDrop={(e) => {
                e.preventDefault()
                if (dragIndex !== null && dragIndex !== i) reorder(dragIndex, i)
                setDragIndex(null)
                setOverIndex(null)
              }}
              onDragEnd={() => {
                setDragIndex(null)
                setOverIndex(null)
              }}
              onDoubleClick={() => store.playQueue(tracks, i, pl.id)}
              onContextMenu={(e) => openSongMenu(e, track)}
              role="button"
              tabIndex={0}
            >
              <button
                className="music-row-play"
                title={active && snap.isPlaying ? uiText('auto.781961bc81c2') : uiText('auto.5d12bd53552c')}
                aria-label={active && snap.isPlaying ? uiText('auto.781961bc81c2') : uiText('auto.5d12bd53552c')}
                onClick={() => (active ? store.togglePlay() : store.playQueue(tracks, i, pl.id))}
              >
                <Cover trackId={track.id} />
                {active && (
                  <span className={`music-row-wave ${snap.isPlaying ? '' : 'paused'}`}>
                    <span className="music-row-wave-bar" />
                    <span className="music-row-wave-bar" />
                    <span className="music-row-wave-bar" />
                  </span>
                )}
                <span className="music-row-playicon">
                  {active && snap.isPlaying ? <Pause /> : <Play />}
                </span>
              </button>
              <div className="music-row-meta">
                <span className="music-row-title">{track.title}</span>
                <span className="music-row-artist">
                  <ArtistLinks track={track} fallback={baseName(track.file)} />
                </span>
              </div>
              {track.duration != null && <span className="music-row-dur">{formatTime(track.duration)}</span>}
            </div>
            )
          })}
          </div>
        )}
      </div>

      {pickingCover && (
        <CoverPicker
          current={pl.cover ?? null}
          onPick={(fileName) => {
            setPickingCover(false)
            void store.setPlaylistCover(pl.id, fileName)
          }}
          onClose={() => setPickingCover(false)}
        />
      )}
    </div>
  )
}

/** One artist opened full-width (Spotify-style): image, bio, every credited song. */
const ArtistDetail: FC<{ artistId: string; onBack: () => void }> = ({ artistId, onBack }) => {
  const { store, snap } = useMusic(false)
  // The host's styled dropdown — never a raw `<select>`, whose popup Chromium
  // hands to the OS unthemed and which ignores the native/custom menu setting.
  const { SelectField } = api.ui.settings
  const { openSongMenu, songEditor } = useSongMenu()
  const summary = store?.artistSummary(artistId) ?? null
  const imagePath = resolveCoverPath(store?.getIndexEntries() ?? [], summary?.artist.image)
  const { url: fallbackCover, ref: coverRef } = useMusicCover(store, imagePath ? undefined : summary?.tracks[0]?.id)

  const [renaming, setRenaming] = React.useState(false)
  const [nameDraft, setNameDraft] = React.useState(summary?.artist.name ?? '')
  const [editOpen, setEditOpen] = React.useState(false)
  const [bioDraft, setBioDraft] = React.useState(summary?.artist.bio ?? '')
  const [pickingImage, setPickingImage] = React.useState(false)
  const [mergeId, setMergeId] = React.useState('')

  React.useEffect(() => {
    setNameDraft(summary?.artist.name ?? '')
  }, [summary?.artist.name])
  React.useEffect(() => {
    setBioDraft(summary?.artist.bio ?? '')
  }, [summary?.artist.bio])

  if (!store || !summary) {
    return (
      <div className="music-page-body">
      {songEditor}
        <button className="music-page-back" onClick={onBack}>
          <ChevronLeft /> {uiText('auto.832e6395b7c5')}</button>
        <div className="music-page-empty">{uiText('auto.a9ee26140432')}</div>
      </div>
    )
  }

  const { artist, tracks, plays } = summary
  const imageUrl = imagePath ? assetUrlForRelPath(imagePath) : fallbackCover
  const totalSeconds = tracks.reduce((sum, t) => sum + (t.duration ?? 0), 0)
  const playingHere = !!snap.currentTrack && tracks.some((t) => t.id === snap.currentTrack!.id)
  const others = snap.artists
    .filter((a) => a.id !== artist.id)
    .sort((a, b) => a.name.localeCompare(b.name))

  const commitRename = (): void => {
    setRenaming(false)
    const next = nameDraft.trim()
    if (next && next !== artist.name) void store.renameArtist(artist.id, next)
    else setNameDraft(artist.name)
  }

  return (
    <div className="music-page-body">
      {songEditor}
      <div className="music-pl-detail-head">
        <div ref={coverRef} className="music-pl-detail-art music-artist-art">
          {imageUrl ? (
            <img src={imageUrl} alt="" />
          ) : (
            <span className="music-pl-detail-art-empty">
              <User />
            </span>
          )}
          <button onClick={() => setPickingImage(true)}>
            <ImageIcon /> {artist.image ? uiText('auto.62a7b486b7ec') : uiText('auto.5375634e24c9')}
          </button>
        </div>
        <div className="music-pl-detail-info">
          <span className="music-pl-detail-kicker">{uiText('auto.6c3f3d320363')}</span>
          {renaming ? (
            <input
              className="music-pl-detail-name-input"
              autoFocus
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename()
                if (e.key === 'Escape') {
                  setNameDraft(artist.name)
                  setRenaming(false)
                }
              }}
            />
          ) : (
            <h1 className="music-pl-detail-name" title={uiText('auto.d3f4cb898fbe')} onClick={() => setRenaming(true)}>
              {artist.name}
            </h1>
          )}
          <span className="music-pl-detail-meta">
            {musicCount(tracks.length, 'song')}
            {plays > 0 ? ` · ${musicCount(plays, 'play')}` : ''}
            {totalSeconds > 0 ? ` · ${formatTime(totalSeconds)}` : ''}
          </span>
          {artist.bio && !editOpen && <p className="music-artist-bio">{artist.bio}</p>}
          <div className="music-pl-detail-actions">
            <button
              className="primary"
              title={playingHere && snap.isPlaying ? uiText('auto.781961bc81c2') : uiText('auto.ebb2ffded13a')}
              aria-label={playingHere && snap.isPlaying ? uiText('auto.781961bc81c2') : uiText('auto.ebb2ffded13a')}
              onClick={() => {
                if (playingHere) store.togglePlay()
                else if (tracks.length) store.playQueue(tracks, 0, null)
              }}
              disabled={tracks.length === 0}
            >
              {playingHere && snap.isPlaying ? <Pause /> : <Play />}
            </button>
            <button
              className={`ghost ${snap.shuffle ? 'active' : ''}`}
              title={snap.shuffle ? uiText('auto.785728cf2548') : uiText('auto.e59f975e2ba1')}
              aria-pressed={snap.shuffle}
              onClick={() => {
                if (tracks.length) store.playShuffledQueue(tracks, null)
              }}
              disabled={tracks.length === 0}
            >
              <Shuffle /> {uiText('auto.5b772b7bfd0a')}</button>
            <button className={`ghost ${editOpen ? 'active' : ''}`} onClick={() => setEditOpen((v) => !v)}>
              <Pencil /> {uiText('auto.5301648dcf6b')}</button>
          </div>
          {editOpen && (
            <div className="music-artist-edit">
              <textarea
                className="music-artist-bio-input"
                placeholder={uiText('auto.0faf9f45db98')}
                value={bioDraft}
                onChange={(e) => setBioDraft(e.target.value)}
                onBlur={() => {
                  if (bioDraft.trim() !== (artist.bio ?? '').trim()) void store.setArtistBio(artist.id, bioDraft)
                }}
              />
              {others.length > 0 && (
                <div className="music-artist-merge">
                  <label htmlFor="music-artist-merge-select">{uiText('auto.ce9aabe53e9e')}</label>
                  <SelectField
                    value={mergeId}
                    onChange={setMergeId}
                    ariaLabel={uiText('auto.007c8adbef9d')}
                    options={[
                      { value: '', label: uiText('auto.007c8adbef9d') },
                      ...others.map((a) => ({ value: a.id, label: a.name }))
                    ]}
                  />
                  <button
                    className="ghost"
                    disabled={!mergeId}
                    onClick={() => {
                      if (!mergeId) return
                      void store.mergeArtists(artist.id, mergeId)
                      setMergeId('')
                      setEditOpen(false)
                    }}
                  >
                    {uiText('auto.ea8f0d02371e')}</button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="music-page-section">
        <div className="music-page-section-head">
          <Music />
          <h2>{uiText('auto.e1404b4267e4')}</h2>
          <span className="count">{tracks.length}</span>
        </div>
        {tracks.length === 0 ? (
          <div className="music-page-empty">{uiText('auto.1a4a0042ba94')}</div>
        ) : (
          tracks.map((track, i) => (
            <SongRow
              key={track.id}
              track={track}
              onPlay={() => store.playQueue(tracks, i, null)}
              onMenu={openSongMenu}
            />
          ))
        )}
      </div>

      {pickingImage && (
        <CoverPicker
          current={artist.image ?? null}
          onPick={(fileName) => {
            setPickingImage(false)
            void store.setArtistImage(artist.id, fileName)
          }}
          onClose={() => setPickingImage(false)}
        />
      )}
    </div>
  )
}

/** The Spotify-style full Music page (`music.page`, main workspace). */
export const Page: FC<MainWorkspaceViewProps> = ({ navigation }) => {
  const { store, snap } = useMusic(false)
  const { openSongMenu, songEditor } = useSongMenu()
  const { openPlaylistMenu } = usePlaylistMenu()
  const [creating, setCreating] = React.useState(false)
  const [newName, setNewName] = React.useState('')
  const newRef = React.useRef<HTMLInputElement>(null)
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const { pageView, pageViewNonce } = snap
  const breadcrumbMode = React.useSyncExternalStore(
    React.useCallback(listener => api.settings.subscribe(listener), []),
    () => api.settings.get().breadcrumbMode === 'file' ? 'file' : 'playlist'
  )
  const [pathError, setPathError] = React.useState(false)

  React.useEffect(() => {
    if (!store) return
    navigation.setController({
      canGoBack: snap.canGoBack,
      canGoForward: snap.canGoForward,
      goBack: () => store.goPageBack(),
      goForward: () => store.goPageForward()
    })
    return () => navigation.setController(null)
  }, [navigation, snap.canGoBack, snap.canGoForward, store])

  React.useEffect(() => {
    if (creating) newRef.current?.focus()
  }, [creating])

  // Reveal a song the left panel navigated to: scroll its row into view and flash
  // it — in the all-songs list ('song'), or within the playlist/artist page the
  // song was routed to. Keyed on the nonce so re-clicking the same song re-reveals.
  React.useEffect(() => {
    const id =
      pageView.mode === 'song'
        ? pageView.id
        : pageView.mode === 'playlist' || pageView.mode === 'artist'
          ? pageView.reveal
          : undefined
    if (!id) return
    const raf = requestAnimationFrame(() => {
      const row = scrollRef.current?.querySelector<HTMLElement>(`[data-track-id="${CSS.escape(id)}"]`)
      if (!row) return
      row.scrollIntoView({ block: 'center', behavior: 'smooth' })
      row.classList.remove('reveal-flash')
      void row.offsetWidth // restart the animation if it's still mid-flash
      row.classList.add('reveal-flash')
    })
    return () => cancelAnimationFrame(raf)
  }, [pageView, pageViewNonce])

  const submitNew = async (): Promise<void> => {
    const name = newName.trim()
    setCreating(false)
    setNewName('')
    if (!name) return
    const id = await store?.createPlaylist(name)
    if (id) store?.showPlaylist(id)
  }

  const query = snap.pageSearch
  const setQuery = (value: string): void => store?.setPageSearch(value)
  const q = query.trim().toLowerCase()
  const searchResults = React.useMemo(() => q
    ? snap.tracks.filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          t.artist.toLowerCase().includes(q) ||
          baseName(t.file).toLowerCase().includes(q)
      )
    : null, [q, snap.tracks])

  const songId = pageView.mode === 'song' ? pageView.id : 'reveal' in pageView ? pageView.reveal : undefined
  const playbackInView = pageView.mode === 'home' || (pageView.mode === 'playlist' && pageView.id === snap.currentPlaylistId)
  const song = (playbackInView ? snap.currentTrack : null) ?? snap.tracks.find(item => item.id === songId)
  const playlistId = pageView.mode === 'playlist' ? pageView.id : null
  const playlist = snap.playlists.find(item => item.id === playlistId)
  const artist = pageView.mode === 'artist' ? snap.artists.find(item => item.id === pageView.id) : null
  if (!store) return null

  const filePath = song?.file ?? store.musicPath()
  const fileParts = filePath.split('/').filter(Boolean)
  const crumbs = pageView.mode === 'home' && !song ? [] : breadcrumbMode === 'file'
    ? fileParts.map((label, index) => ({ label, title: fileParts.slice(0, index + 1).join('/'), onClick: () => api.workspace.revealInFiles(fileParts.slice(0, index + 1).join('/')) }))
    : [
        ...(playlist ? [{ label: playlist.name, title: playlist.name, onClick: () => store.showPlaylist(playlist.id) }] : artist ? [{ label: artist.name, title: artist.name, onClick: () => store.showArtist(artist.id) }] : []),
        ...(song ? [{ label: song.title, title: song.title, onClick: () => store.revealSong(song.id) }] : []),
        ...(!playlist && !artist && !song ? [{ label: uiText('plugin.music.name'), title: uiText('plugin.music.name'), onClick: () => store.showHome() }] : [])
      ]
  const showPathMenu = (event: React.MouseEvent): void => {
    event.preventDefault()
    event.stopPropagation()
    void api.ui.openMenu((['playlist', 'file'] as const).map(mode => ({
      label: uiText(mode === 'playlist' ? 'music.header.playlistPath' : 'music.header.filePath'),
      type: 'checkbox' as const,
      checked: breadcrumbMode === mode,
      onSelect: async () => {
        try {
          const result = await api.settings.set('breadcrumbMode', mode)
          setPathError(!result.ok)
        } catch { setPathError(true) }
      }
    })), { x: event.clientX, y: event.clientY })
  }

  return (
    <div ref={scrollRef} className="music-page hidescrollbar">
      {songEditor}
      <div className="music-page-header">
        <nav className="music-breadcrumbs" aria-label={uiText('music.header.location')} onContextMenu={showPathMenu}>
          <div className="music-breadcrumb-items">
            <button className="music-breadcrumb-home" title={uiText('auto.315fed0ac88a')} aria-label={uiText('auto.315fed0ac88a')} onClick={() => { setQuery(''); store.showHome() }}>/</button>
            {crumbs.map((crumb, index) => <React.Fragment key={`${index}:${crumb.title}`}>
              {index > 0 && <span className="music-breadcrumb-separator" aria-hidden="true">/</span>}
              <button title={crumb.title} aria-current={index === crumbs.length - 1 ? 'page' : undefined} onClick={crumb.onClick}>{crumb.label}</button>
            </React.Fragment>)}
          </div>
        </nav>
        {pathError && <div role="alert" className="music-path-error">{uiText('music.properties.saveError')}</div>}
        <div className="music-page-top search-field-row">
          <button
            className="music-page-home"
            title={uiText('auto.315fed0ac88a')}
            aria-label={uiText('auto.315fed0ac88a')}
            onClick={() => {
              setQuery('')
              store.showHome()
            }}
          >
            <Home />
          </button>
          <div className="music-page-search search-field">
            <Search className="search-field-icon" />
            <input
              className="search-field-input"
              value={query}
              placeholder={uiText('auto.8d563eb9d8b9')}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setQuery('')
              }}
            />
            {query && (
              <button
                className="search-field-action"
                aria-label={uiText('auto.67300d0fed7c')}
                onClick={() => setQuery('')}
              >
                <X />
              </button>
            )}
          </div>

        </div>

      </div>

      {searchResults ? (
        <div className="music-page-body">
          <div className="music-page-section">
            <div className="music-page-section-head">
              <Search />
              <h2>{uiText('auto.418633bb7265')}{' '}{query.trim()}”</h2>
              <span className="count">{searchResults.length}</span>
            </div>
            {searchResults.length === 0 ? (
              <div className="music-page-empty">{uiText('auto.5131795c0c2d')}</div>
            ) : (
              searchResults.map((track, i) => (
                <SongRow
                  key={track.id}
                  track={track}
                  onPlay={() => store.playQueue(searchResults, i, null)}
                  onMenu={openSongMenu}
                />
              ))
            )}
          </div>
        </div>
      ) : pageView.mode === 'playlist' ? (
        <PlaylistDetail playlistId={pageView.id} onBack={() => store.showHome()} />
      ) : pageView.mode === 'artist' ? (
        <ArtistDetail artistId={pageView.id} onBack={() => store.showHome()} />
      ) : (
        <div className="music-page-body">
          <div className="music-page-section">
            <div className="music-page-section-head">
              <ListMusic />
              <h2>{uiText('auto.77b69f32c878')}</h2>
              <span className="count">{snap.playlists.length}</span>
            </div>
            <div className="music-pl-grid">
              {snap.playlists.map((pl) => (
                <PlaylistCard
                  key={pl.id}
                  pl={pl}
                  count={(snap.playlistTracks[pl.id] ?? []).length}
                  coverPath={snap.playlistCovers[pl.id] ?? null}
                  active={snap.currentPlaylistId === pl.id}
                  playing={snap.currentPlaylistId === pl.id && snap.isPlaying}
                  onOpen={() => store.showPlaylist(pl.id)}
                  onPlay={() => {
                    const list = snap.playlistTracks[pl.id] ?? []
                    if (list.length) store.playQueue(list, 0, pl.id)
                  }}
                  onToggle={() => store.togglePlay()}
                  onMenu={openPlaylistMenu}
                />
              ))}
              {creating ? (
                <div className="music-pl-card new">
                  <div className="music-pl-card-art">
                    <input
                      ref={newRef}
                      className="music-newpl-input"
                      value={newName}
                      placeholder={uiText('auto.544f7553c85a')}
                      onChange={(e) => setNewName(e.target.value)}
                      onBlur={() => void submitNew()}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void submitNew()
                        if (e.key === 'Escape') {
                          setCreating(false)
                          setNewName('')
                        }
                      }}
                    />
                  </div>
                </div>
              ) : (
                <button className="music-pl-card new" onClick={() => setCreating(true)}>
                  <div className="music-pl-card-art">
                    <Plus />
                    <span>{uiText('auto.a5474a872e6a')}</span>
                  </div>
                </button>
              )}
            </div>
          </div>

          {snap.recentlyPlayed.length > 0 && (
            <div className="music-page-section">
              <div className="music-page-section-head">
                <Clock />
                <h2>{uiText('auto.71592f121a00')}</h2>
                <span className="count">{snap.recentlyPlayed.length}</span>
              </div>
              <div className="music-track-cards">
                {snap.recentlyPlayed.slice(0, 12).map((track) => (
                  <TrackCard
                    key={track.id}
                    track={track}
                    onPlay={() => store.playTrack(track)}
                    onMenu={openSongMenu}
                  />
                ))}
              </div>
            </div>
          )}

          {snap.topPlayed.length > 0 && (
            <div className="music-page-section">
              <div className="music-page-section-head">
                <TrendingUp />
                <h2>{uiText('auto.c690c2d0f7eb')}</h2>
                <span className="count">{snap.topPlayed.length}</span>
              </div>
              {snap.topPlayed.map(({ track, plays }, i) => {
                const active = snap.currentTrack?.id === track.id
                return (
                <div
                  key={track.id}
                  className={`music-top-row ${active ? 'active' : ''}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => (active ? store.togglePlay() : store.playTrack(track))}
                  onContextMenu={(e) => openSongMenu(e, track)}
                >
                  <span className="music-top-rank">{i + 1}</span>
                  <span className="music-top-cover">
                    <Cover trackId={track.id} size={36} />
                    {active && <EqBadge playing={snap.isPlaying} />}
                  </span>
                  <div className="music-row-meta">
                    <span className="music-row-title">{track.title}</span>
                    <span className="music-row-artist">
                      <ArtistLinks track={track} fallback={baseName(track.file)} />
                    </span>
                  </div>
                  <span className="music-top-plays">
                    {musicCount(plays, 'play')}
                  </span>
                </div>
                )
              })}
            </div>
          )}

          <div className="music-page-section">
            <div className="music-page-section-head">
              <Music />
              <h2>{uiText('auto.e1404b4267e4')}</h2>
              <span className="count">{snap.tracks.length}</span>
            </div>
            {snap.loading && snap.tracks.length === 0 ? (
              <div className="music-page-empty">{uiText('auto.78df555a3a52')}</div>
            ) : snap.tracks.length === 0 ? (
              <div className="music-page-empty">
                {uiText('auto.831bef6ea1ed')}{' '}<code>{snap.musicPath}</code> {uiText('auto.ee711996ebe4')}</div>
            ) : (
              snap.tracks.map((track, i) => (
                <SongRow
                  key={track.id}
                  track={track}
                  onPlay={() => store.playQueue(snap.tracks, i, null)}
                  onMenu={openSongMenu}
                />
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
