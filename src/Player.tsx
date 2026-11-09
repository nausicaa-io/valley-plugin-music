import { VIDEO_EXTENSIONS, assetUrlForRelPath, fileExtension } from '@valley/plugin-sdk/fileTypes'
import { visibleTimer } from './visibleTimer'
import { api, React } from './runtime'
import type { FC } from 'react'
import { useMusic, useMusicCover } from './hooks'
import { useSongMenu } from './SongMenu'
import { ArtistLinks } from './ArtistLinks'
import { formatTime } from './data'
import type { Track } from './types'
import { uiText } from './localization'
import { playbackPosition } from './playback'
import { isEpisode, showFolder } from './podcasts'
import {
  ChevronDown,
  ChevronRight,
  Clock,
  GripVertical,
  Heart,
  ListMusic,
  Music,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Podcast,
  RotateCcw,
  RotateCw,
  Shuffle,
  SkipBack,
  SkipForward,
  X
} from './icons'

/**
 * The scrubber follows the pointer locally while seeks are coalesced: at most one
 * seek is in flight and only the latest position is sent next, so a fast drag never
 * queues a backlog of backend round trips. The local value is released once the
 * final seek has landed, so the thumb never snaps back to a stale position.
 */
function useScrubber(seek: (value: number) => Promise<unknown>): {
  value: number | null
  change: (value: number) => void
  grab: () => void
  release: () => void
} {
  const [value, setValue] = React.useState<number | null>(null)
  const dragging = React.useRef(false)
  const inFlight = React.useRef(false)
  const queued = React.useRef<number | null>(null)
  const seekRef = React.useRef(seek)
  seekRef.current = seek
  const flush = React.useCallback((): void => {
    if (inFlight.current) return
    const next = queued.current
    if (next === null) {
      if (!dragging.current) setValue(null)
      return
    }
    queued.current = null
    inFlight.current = true
    void seekRef.current(next).finally(() => {
      inFlight.current = false
      flush()
    })
  }, [])
  const change = React.useCallback((next: number): void => {
    setValue(next)
    queued.current = next
    flush()
  }, [flush])
  const grab = React.useCallback((): void => { dragging.current = true }, [])
  const release = React.useCallback((): void => {
    if (!dragging.current) return
    dragging.current = false
    flush()
  }, [flush])
  return { value, change, grab, release }
}

const CoverThumb: FC<{ trackId: string }> = ({ trackId }) => {
  const { store } = useMusic()
  const { url, ref } = useMusicCover(store, trackId)
  return (
    <span ref={ref} className={`player-queue-cover ${url ? '' : 'player-queue-cover-empty'}`} style={{ display: 'grid' }}>
      {url ? <img className="player-queue-cover" src={url} alt="" loading="lazy" /> : <Music />}
    </span>
  )
}

const PlayerQueueRow: FC<{
  track: Track
  index: number
  onPlay: () => void
  onRemove: () => void
  onMenu: (event: React.MouseEvent, track: Track) => void
  onReorder: (from: number, to: number) => void
  dragIndex: number | null
  setDragIndex: (i: number | null) => void
  overIndex: number | null
  setOverIndex: (i: number | null) => void
}> = ({ track, index, onPlay, onRemove, onMenu, onReorder, dragIndex, setDragIndex, overIndex, setOverIndex }) => (
  <div
    className={`player-queue-row ${dragIndex === index ? 'dragging' : ''} ${dragIndex !== null && dragIndex !== index && overIndex === index ? 'drop-before' : ''}`}
    draggable
    onDragStart={() => setDragIndex(index)}
    onDragOver={(e) => {
      e.preventDefault()
      setOverIndex(index)
    }}
    onDrop={(e) => {
      e.preventDefault()
      if (dragIndex !== null && dragIndex !== index) onReorder(dragIndex, index)
      setDragIndex(null)
      setOverIndex(null)
    }}
    onDragEnd={() => {
      setDragIndex(null)
      setOverIndex(null)
    }}
    onContextMenu={event => onMenu(event, track)}
    onDoubleClick={onPlay}
    role="button"
    tabIndex={0}
  >
    <span className="player-queue-handle" title={uiText('auto.e7541faf0a7e')}>
      <GripVertical />
    </span>
    <CoverThumb trackId={track.id} />
    <button className="player-queue-meta" onClick={onPlay} title={uiText('auto.cd13e54acbd1')}>
      <span className="player-queue-title">{track.title}</span>
      <span className="player-queue-artist">{track.artist}</span>
    </button>
    <button className="player-queue-remove" title={uiText('auto.e963907dac5c')} aria-label={uiText('auto.e963907dac5c')} onClick={onRemove}>
      <X />
    </button>
  </div>
)

export const Player: FC = () => {
  const { store, snap } = useMusic()
  const { openSongMenu, songEditor } = useSongMenu()
  const {
    currentTrack,
    resumeTrack,
    isPlaying,
    currentTime: sampledPosition,
    duration,
    buffering,
    favorites,
    playError,
    upNext,
    history,
    shuffle,
    repeatMode,
    rightQueueOpen: queueOpen,
    rightHistoryOpen: historyOpen,
    rightPanelScrollTop,
    rightViewNonce
  } = snap

  const track = currentTrack ?? resumeTrack
  const total = duration || track?.duration || 0
  const [, updateClock] = React.useState(0)
  React.useEffect(() => {
    if (!isPlaying || buffering) return
    return visibleTimer(listsRef.current?.ownerDocument ?? document, () => updateClock(value => value + 1), 100)
  }, [isPlaying, buffering])
  const currentTime = playbackPosition({ position: sampledPosition, duration: total, rate: snap.playbackRate, playing: isPlaying, buffering, sampleAgeMs: snap.playbackSampleAge }, snap.playbackSampledAt)
  const scrubber = useScrubber(value => store?.seek(value) ?? Promise.resolve())
  const shownTime = scrubber.value ?? currentTime
  const played = total > 0 ? (Math.min(shownTime, total) / total) * 100 : 0
  const [dragIndex, setDragIndex] = React.useState<number | null>(null)
  const [overIndex, setOverIndex] = React.useState<number | null>(null)
  const [videoMode, setVideoMode] = React.useState(false)
  const hasVideo = (VIDEO_EXTENSIONS as readonly string[]).includes(fileExtension(track?.file ?? ''))
  const listsRef = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    if (listsRef.current) listsRef.current.scrollTop = rightPanelScrollTop
  }, [rightViewNonce, rightPanelScrollTop])
  const episode = track ? isEpisode(track, snap.podcastPath) : false
  const show = episode && track ? snap.shows.find(item => item.id === showFolder(track.file, snap.podcastPath)) : undefined
  const { url: embeddedCover, ref: coverRef } = useMusicCover(store, track?.id)
  const coverUrl = embeddedCover ?? (show?.coverPath ? assetUrlForRelPath(show.coverPath) : null)
  const videoSurface = React.useMemo(() => snap.sessionId
    ? <api.ui.MediaSurface sessionId={snap.sessionId} fit="contain" controls={false} style={{ width: '100%', height: '100%', borderRadius: 2, background: 'transparent' }} />
    : null, [snap.sessionId])

  if (!store) return null

  return (
    <div className="player-view">
      {songEditor}
      <section className={`player-now ${track ? '' : 'empty'}`} onContextMenu={event => { if (track) openSongMenu(event, track) }}>
        <div className="player-media">
          <div className="music-player-mode-row">
            {hasVideo && <div className="music-video-mode" role="group" aria-label={uiText('music.player.mode')}>
              <button aria-pressed={!videoMode} onClick={() => setVideoMode(false)}>{uiText('music.player.audio')}</button>
              <button aria-pressed={videoMode} onClick={() => setVideoMode(true)}>{uiText('music.player.video')}</button>
            </div>}
          </div>
          <div ref={coverRef} className="player-art" data-plugin-widget-layout="fill">
            {hasVideo && videoMode && videoSurface ? videoSurface : <>
              {coverUrl ? (
                <img src={coverUrl} alt="" />
              ) : (
                <span className="player-art-empty">
                  {episode ? <Podcast /> : <Music />}
                </span>
              )}
            </>}
          </div>
        </div>

        {track ? (
          <>
            <div className="player-head">
              <div className="player-titles">
                <h2 className="player-title">{track.title}</h2>
                <p className="player-artist">
                  {episode
                    ? <span className="music-artist-link" role="button" tabIndex={0} onClick={() => show && store.showPodcastShow(show.id)}>{show?.name ?? track.artist}</span>
                    : <ArtistLinks track={track} />}
                </p>
              </div>
              <button
                className={`player-fav ${favorites.has(track.id) ? 'on' : ''}`}
                title={uiText('auto.9704b6631f6a')}
                aria-label={uiText('auto.9704b6631f6a')}
                onClick={() => void store.toggleFavorite(track.id)}
              >
                <Heart />
              </button>
            </div>

            <div className="player-scrub">
              <input
                type="range"
                min={0}
                max={total || 1}
                step={0.5}
                value={Math.min(shownTime, total || 0)}
                onPointerDown={scrubber.grab}
                onPointerUp={scrubber.release}
                onPointerCancel={scrubber.release}
                onLostPointerCapture={scrubber.release}
                onBlur={scrubber.release}
                onChange={(e) => scrubber.change(Number(e.target.value))}
                style={{ '--played': `${played}%` } as React.CSSProperties}
              />
              <div className="player-times">
                <span>{formatTime(shownTime)}</span>
                <span>{formatTime(total)}</span>
              </div>
            </div>
          </>
        ) : (
          <div className="player-titles">
            <h2 className="player-title">{uiText('auto.13ae374e9d0e')}</h2>
            <p className="player-artist">{uiText('auto.c71338bbabd2')}</p>
          </div>
        )}

        {playError && <div className="player-error">{playError}</div>}

        <div className="player-controls">
          {episode ? (
            <button className="player-skip-btn" title={uiText('music.podcast.back15')} aria-label={uiText('music.podcast.back15')} onClick={() => store.seek(Math.max(0, currentTime - 15))}>
              <RotateCcw /><span>15</span>
            </button>
          ) : (
            <button
              className={`player-mode-btn ${shuffle ? 'active' : ''}`}
              title={uiText('auto.5b772b7bfd0a')}
              aria-label={uiText('auto.5b772b7bfd0a')}
              onClick={() => store.toggleShuffle()}
            >
              <Shuffle />
            </button>
          )}
          <button title={uiText('auto.50f94286ba30')} aria-label={uiText('auto.50f94286ba30')} onClick={() => store.prev()}>
            <SkipBack />
          </button>
          <button
            className={`player-playbtn ${buffering ? 'loading' : ''}`}
            title={uiText('auto.ebb1e1e89181')}
            aria-label={uiText('auto.ebb1e1e89181')}
            onClick={() => store.togglePlay()}
          >
            {buffering ? <span className="player-spinner" /> : isPlaying ? <Pause /> : <Play />}
          </button>
          <button title={uiText('auto.bc981983e7f5')} aria-label={uiText('auto.bc981983e7f5')} onClick={() => store.next()}>
            <SkipForward />
          </button>
          {episode ? (
            <button className="player-skip-btn" title={uiText('music.podcast.forward30')} aria-label={uiText('music.podcast.forward30')} onClick={() => store.seek(total > 0 ? Math.min(total, currentTime + 30) : currentTime + 30)}>
              <RotateCw /><span>30</span>
            </button>
          ) : (
            <button
              className={`player-mode-btn ${repeatMode !== 'off' ? 'active' : ''}`}
              title={repeatMode === 'one' ? uiText('auto.c747f173d83e') : repeatMode === 'all' ? uiText('auto.e3b1839d5f1e') : uiText('auto.659eba121958')}
              aria-label={uiText('auto.659eba121958')}
              onClick={() => store.cycleRepeat()}
            >
              {repeatMode === 'one' ? <Repeat1 /> : <Repeat />}
            </button>
          )}
        </div>
      </section>

      <div
        className="player-lists"
        ref={listsRef}
        onScroll={(event) => store.setRightPanelScrollTop(event.currentTarget.scrollTop)}
      >
        <section className="player-queue" aria-label={uiText('auto.89373a2ec11a')}>
          <button className="player-queue-head" onClick={() => store.setRightQueueOpen(!queueOpen)}>
            <div className="player-queue-label">
              <ListMusic />
              <span>{uiText('auto.89373a2ec11a')}</span>
              <span className="player-queue-count">{upNext.length}</span>
            </div>
            <div className="player-queue-head-right">
              {queueOpen && upNext.length > 0 && (
                <span
                  className="player-queue-clear"
                  role="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    store.clearQueue()
                  }}
                >
                  {uiText('auto.719ea396ad92')}</span>
              )}
              {queueOpen ? <ChevronDown /> : <ChevronRight />}
            </div>
          </button>
          {queueOpen && (
            <div className="player-queue-list">
              {upNext.length === 0 ? (
                <div className="player-queue-empty">{uiText('auto.13f89e125ece')}</div>
              ) : (
                upNext.map((queuedTrack, i) => (
                  <PlayerQueueRow
                    key={`${queuedTrack.id}-${i}`}
                    track={queuedTrack}
                    index={i}
                    onPlay={() => store.playFromQueue(i)}
                    onRemove={() => store.removeFromQueue(i)}
                    onMenu={openSongMenu}
                    onReorder={(from, to) => store.reorderQueue(from, to)}
                    dragIndex={dragIndex}
                    setDragIndex={setDragIndex}
                    overIndex={overIndex}
                    setOverIndex={setOverIndex}
                  />
                ))
              )}
            </div>
          )}
        </section>

        <section className="player-history" aria-label={uiText('auto.90ccd6497400')}>
          <button className="player-queue-head" onClick={() => store.setRightHistoryOpen(!historyOpen)}>
            <div className="player-queue-label">
              <Clock />
              <span>{uiText('auto.90ccd6497400')}</span>
              <span className="player-queue-count">{history.length}</span>
            </div>
            {historyOpen ? <ChevronDown /> : <ChevronRight />}
          </button>
          {historyOpen && (
            <div className="player-queue-list">
              {history.length === 0 ? (
                <div className="player-queue-empty">{uiText('auto.22d261828d18')}</div>
              ) : (
                history.map((recentTrack) => (
                  <div
                    key={recentTrack.id}
                    className="player-history-row"
                    onContextMenu={event => openSongMenu(event, recentTrack)}
                    onDoubleClick={() => store.playQueue([recentTrack], 0, null)}
                    role="button"
                    tabIndex={0}
                  >
                    <CoverThumb trackId={recentTrack.id} />
                    <button
                      className="player-queue-meta"
                      onClick={() => store.playQueue([recentTrack], 0, null)}
                      title={uiText('auto.192840f3c39a')}
                    >
                      <span className="player-queue-title">{recentTrack.title}</span>
                      <span className="player-queue-artist">{recentTrack.artist}</span>
                    </button>
                  </div>
                ))
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
