import { assetUrlForRelPath } from '@valley/plugin-sdk/fileTypes'
import { visibleTimer } from './visibleTimer'
import { api, React } from './runtime'
import type { FC } from 'react'
import { useMusic, useMusicCover } from './hooks'
import { useSongMenu } from './SongMenu'
import { ArtistLinks } from './ArtistLinks'
import { navigateOrOpenTab, onMiddleClick, openPageTargetInNewTab } from './pageNavigator'
import { formatTime, isVideoFile } from './data'
import type { Track } from './types'
import { uiText } from './localization'
import { playbackPosition } from './playback'
import { isEpisode, nextPodcastRate, resumePosition, showFolder, type PodcastShow } from './podcasts'
import type { MusicSnapshot } from './store'
import {
  Bookmark,
  BookmarkPlus,
  ChevronDown,
  ChevronRight,
  Clock,
  FileText,
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

const CLOCK_INTERVAL_MS = 250

function useVideoSurface(sessionId: string | null): React.ReactNode {
  return React.useMemo(() => sessionId
    ? <api.ui.MediaSurface sessionId={sessionId} fit="contain" controls={false} style={{ width: '100%', height: '100%', borderRadius: 2, background: 'transparent' }} />
    : null, [sessionId])
}

/** Where playback is right now, extrapolated from the last sample. */
function livePosition(snap: MusicSnapshot, total: number): number {
  return playbackPosition({ position: snap.currentTime, duration: total, rate: snap.playbackRate, playing: snap.isPlaying, buffering: snap.buffering, sampleAgeMs: snap.playbackSampleAge }, snap.playbackSampledAt)
}

/** How close (in pixels along the track) the pointer must come for a key moment to pull the scrubber onto it. */
const MOMENT_SNAP_PX = 10

/** The only part of the player that follows the clock, so the queue and history below it do not re-render with every tick. */
const PlayerScrub: FC<{ fallbackDuration: number; moments?: readonly { at: number; label: string }[] }> = ({ fallbackDuration, moments }) => {
  const { store, snap } = useMusic()
  const { isPlaying, buffering } = snap
  const total = snap.duration || fallbackDuration
  const rootRef = React.useRef<HTMLDivElement>(null)
  const [, updateClock] = React.useState(0)
  const [near, setNear] = React.useState<number | null>(null)
  React.useEffect(() => {
    if (!isPlaying || buffering) return
    return visibleTimer(rootRef.current?.ownerDocument ?? document, () => updateClock(value => value + 1), CLOCK_INTERVAL_MS)
  }, [isPlaying, buffering])
  const scrubber = useScrubber(value => store?.seek(value) ?? Promise.resolve())
  const shownTime = scrubber.value ?? livePosition(snap, total)
  const played = total > 0 ? (Math.min(shownTime, total) / total) * 100 : 0
  const visible = total > 0 ? (moments ?? []).filter(moment => moment.at <= total) : []
  /** The key moment within snapping distance of a track position, if any. */
  const magnet = (seconds: number): { at: number; label: string } | null => {
    const width = (rootRef.current?.clientWidth ?? 0) - 10
    if (!visible.length || width <= 0 || total <= 0) return null
    const reach = (MOMENT_SNAP_PX / width) * total
    let best: { at: number; label: string } | null = null
    for (const moment of visible) if (Math.abs(moment.at - seconds) <= reach && (!best || Math.abs(moment.at - seconds) < Math.abs(best.at - seconds))) best = moment
    return best
  }
  const positionAt = (clientX: number): number => {
    const rect = rootRef.current?.getBoundingClientRect()
    if (!rect || rect.width <= 10) return 0
    return Math.min(1, Math.max(0, (clientX - rect.left - 5) / (rect.width - 10))) * total
  }
  const hovered = visible.find(moment => moment.at === near)
  return (
    <div ref={rootRef} className="player-scrub" onPointerMove={(e) => setNear(magnet(positionAt(e.clientX))?.at ?? null)} onPointerLeave={() => setNear(null)}>
      {visible.length > 0 && (
        <div className="player-scrub-markers" aria-hidden>
          {visible.map(moment => (
            <span key={moment.at} className={`player-scrub-marker ${near === moment.at ? 'near' : ''}`} style={{ left: `${(moment.at / total) * 100}%` }} />
          ))}
          {hovered && (
            <span className="player-scrub-tip" style={{ left: `${(hovered.at / total) * 100}%` }}>
              {[formatTime(hovered.at), hovered.label].filter(Boolean).join(' · ')}
            </span>
          )}
        </div>
      )}
      <input
        type="range"
        min={0}
        max={total || 1}
        step="any"
        value={Math.min(shownTime, total || 0)}
        onPointerDown={scrubber.grab}
        onPointerUp={scrubber.release}
        onPointerCancel={scrubber.release}
        onLostPointerCapture={scrubber.release}
        onBlur={scrubber.release}
        onChange={(e) => { const value = Number(e.target.value); scrubber.change(magnet(value)?.at ?? value) }}
        style={{ '--played': `${played}%` } as React.CSSProperties}
      />
      <div className="player-times">
        <span>{formatTime(shownTime)}</span>
        <span>{formatTime(total)}</span>
      </div>
    </div>
  )
}

/** Clicking the artwork shrinks the player to a cover-and-title row; clicking the small cover (or, without artwork, the title row) brings it back. */
function compactHandlers(store: ReturnType<typeof useMusic>['store'], compact: boolean) {
  const label = uiText(compact ? 'music.player.expand' : 'music.player.compact')
  return {
    title: label,
    role: 'button' as const,
    tabIndex: 0,
    'aria-label': label,
    onClick: () => store?.setPlayerCompact(!compact),
    onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); store?.setPlayerCompact(!compact) } }
  }
}

/** Without artwork the compact head itself expands, except over its links. */
function expandFromHead(store: ReturnType<typeof useMusic>['store']) {
  return (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('a, button, [role="button"]')) return
    store?.setPlayerCompact(false)
  }
}

const PlayerPlayButton: FC = () => {
  const { store, snap } = useMusic()
  return (
    <button
      className={`player-playbtn ${snap.buffering ? 'loading' : ''}`}
      title={uiText('auto.ebb1e1e89181')}
      aria-label={uiText('auto.ebb1e1e89181')}
      onClick={() => store?.togglePlay()}
    >
      {snap.buffering ? <span className="player-spinner" /> : snap.isPlaying ? <Pause /> : <Play />}
    </button>
  )
}

const CoverThumb: FC<{ trackId: string; fallback?: string | null }> = ({ trackId, fallback }) => {
  const { store } = useMusic(false)
  const { url: embedded, ref } = useMusicCover(store, trackId)
  const url = embedded ?? fallback ?? null
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

const MusicPlayer: FC = () => {
  const { store, snap } = useMusic(false)
  const { openSongMenu, songEditor } = useSongMenu()
  const {
    currentTrack,
    resumeTrack,
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
  const fallbackDuration = track?.duration || 0
  const [dragIndex, setDragIndex] = React.useState<number | null>(null)
  const [overIndex, setOverIndex] = React.useState<number | null>(null)
  const [videoMode, setVideoMode] = React.useState(false)
  const hasVideo = isVideoFile(track?.file ?? '')
  const listsRef = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    if (listsRef.current) listsRef.current.scrollTop = rightPanelScrollTop
  }, [rightViewNonce, rightPanelScrollTop])
  const { url: coverUrl, ref: coverRef } = useMusicCover(store, track?.id, { eager: true })
  const videoSurface = useVideoSurface(snap.sessionId)

  if (!store) return null

  return (
    <div className="player-view">
      {songEditor}
      <section className={`player-now ${track ? '' : 'empty'} ${snap.playerCompact ? 'compact' : ''}`} onContextMenu={event => { if (track) openSongMenu(event, track) }}>
        {!snap.playerCompact && <div className="player-media">
          <div className="music-player-mode-row">
            {hasVideo && <div className="music-video-mode" role="group" aria-label={uiText('music.player.mode')}>
              <button aria-pressed={!videoMode} onClick={() => setVideoMode(false)}>{uiText('music.player.audio')}</button>
              <button aria-pressed={videoMode} onClick={() => setVideoMode(true)}>{uiText('music.player.video')}</button>
            </div>}
          </div>
          <div ref={coverRef} className="player-art" data-plugin-widget-layout="fill">
            {hasVideo && videoMode && videoSurface ? videoSurface : <>
              {coverUrl ? (
                <img className="player-art-cover" src={coverUrl} alt="" {...(track ? compactHandlers(store, false) : {})} />
              ) : (
                <span className="player-art-empty">
                  <Music />
                </span>
              )}
            </>}
          </div>
        </div>}

        {track ? (
          <>
            <div className="player-head" onClick={snap.playerCompact && !coverUrl ? expandFromHead(store) : undefined}>
              {snap.playerCompact && coverUrl && <img ref={coverRef} className="player-compact-cover" src={coverUrl} alt="" {...compactHandlers(store, true)} />}
              <div className="player-titles">
                <h2 className="player-title">{track.title}</h2>
                <p className="player-artist">
                  <ArtistLinks track={track} />
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

            <PlayerScrub fallbackDuration={fallbackDuration} />
          </>
        ) : (
          <div className="player-titles">
            <h2 className="player-title">{uiText('auto.13ae374e9d0e')}</h2>
            <p className="player-artist">{uiText('auto.c71338bbabd2')}</p>
          </div>
        )}

        {playError && <div className="player-error">{playError}</div>}

        <div className="player-controls">
          <button
            className={`player-mode-btn ${shuffle ? 'active' : ''}`}
            title={uiText('auto.5b772b7bfd0a')}
            aria-label={uiText('auto.5b772b7bfd0a')}
            onClick={() => store.toggleShuffle()}
          >
            <Shuffle />
          </button>
          <button title={uiText('auto.50f94286ba30')} aria-label={uiText('auto.50f94286ba30')} onClick={() => store.prev()}>
            <SkipBack />
          </button>
          <PlayerPlayButton />
          <button title={uiText('auto.bc981983e7f5')} aria-label={uiText('auto.bc981983e7f5')} onClick={() => store.next()}>
            <SkipForward />
          </button>
          <button
            className={`player-mode-btn ${repeatMode !== 'off' ? 'active' : ''}`}
            title={repeatMode === 'one' ? uiText('auto.c747f173d83e') : repeatMode === 'all' ? uiText('auto.e3b1839d5f1e') : uiText('auto.659eba121958')}
            aria-label={uiText('auto.659eba121958')}
            onClick={() => store.cycleRepeat()}
          >
            {repeatMode === 'one' ? <Repeat1 /> : <Repeat />}
          </button>
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

/** One key moment: its time seeks, its label edits in place, the cross removes it. */
const MomentRow: FC<{ at: number; label: string; onSeek: () => void; onRename: (label: string) => void; onRemove: () => void }> = ({ at, label, onSeek, onRename, onRemove }) => {
  const [draft, setDraft] = React.useState(label)
  React.useEffect(() => setDraft(label), [label])
  return (
    <div className="podcast-moment-row">
      <button className="podcast-moment-time" onClick={onSeek} title={uiText('music.podcast.jumpTo', { time: formatTime(at) })}>{formatTime(at)}</button>
      <input
        className="podcast-moment-label"
        value={draft}
        placeholder={uiText('music.podcast.momentPlaceholder')}
        aria-label={uiText('music.edit.momentLabel')}
        maxLength={120}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => { if (draft.trim() !== label) onRename(draft) }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') { setDraft(label); e.currentTarget.blur() }
        }}
      />
      <button className="player-queue-remove" title={uiText('music.podcast.removeMoment')} aria-label={uiText('music.podcast.removeMoment')} onClick={onRemove}>
        <X />
      </button>
    </div>
  )
}

const PlayerSection: FC<{ id: string; icon: React.ReactNode; title: string; count?: number; open: boolean; onToggle: () => void; action?: React.ReactNode; children: React.ReactNode }> = ({ id, icon, title, count, open, onToggle, action, children }) => (
  <section className={`player-queue podcast-section podcast-section-${id}`} aria-label={title}>
    <button className="player-queue-head" onClick={onToggle}>
      <div className="player-queue-label">
        {icon}
        <span>{title}</span>
        {count !== undefined && <span className="player-queue-count">{count}</span>}
      </div>
      <div className="player-queue-head-right">
        {open && action}
        {open ? <ChevronDown /> : <ChevronRight />}
      </div>
    </button>
    {open && children}
  </section>
)

function formatPublished(value: string | undefined): string {
  if (!value) return ''
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00`) : null
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : value
}

function formatRate(rate: number): string {
  return `${Number.isInteger(rate) ? rate.toFixed(0) : String(rate)}×`
}

/** Show notes typed straight into the sidebar; saved to the episode's description when the field loses focus. */
const ShowNotesField: FC<{ track: Track }> = ({ track }) => {
  const { store } = useMusic(false)
  const saved = track.details?.description ?? ''
  const [draft, setDraft] = React.useState(saved)
  const [error, setError] = React.useState('')
  React.useEffect(() => setDraft(saved), [saved, track.id])
  const save = (): void => {
    if (!store || draft === saved) return
    setError('')
    void store.updateTrack(track.id, { title: track.title, artist: track.artist, album: track.album ?? '', details: { ...track.details, description: draft } }, track)
      .catch(reason => setError(reason instanceof Error ? reason.message : uiText('music.properties.saveError')))
  }
  return <>
    <textarea
      className="podcast-notes-input"
      value={draft}
      placeholder={uiText('music.podcast.notesPlaceholder')}
      aria-label={uiText('music.podcast.notes')}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => { if (e.key === 'Escape') { setDraft(saved); e.currentTarget.blur() } }}
    />
    {error && <p className="podcast-notes-error" role="alert">{error}</p>}
  </>
}

/** The right sidebar while an episode is loaded: listen/watch, speed, ±seconds, key moments, notes, and the rest of the show. */
const PodcastPlayer: FC<{ track: Track }> = ({ track }) => {
  const { store, snap } = useMusic(false)
  const { openSongMenu, songEditor } = useSongMenu()
  const [videoMode, setVideoMode] = React.useState(false)
  const [open, setOpen] = React.useState({ moments: true, notes: true, more: true })
  const hasVideo = isVideoFile(track.file)
  const show: PodcastShow | undefined = snap.shows.find(item => item.id === showFolder(track.file, snap.podcastPath))
  const { url: embeddedCover, ref: coverRef } = useMusicCover(store, track.id, { eager: true })
  const coverUrl = embeddedCover ?? (show?.coverPath ? assetUrlForRelPath(show.coverPath) : null)
  const videoSurface = useVideoSurface(snap.sessionId)
  const moments = snap.episodeMoments[track.id] ?? []
  const details = track.details ?? {}
  const meta = [
    details.season ? uiText('music.podcast.seasonShort', { value: details.season }) : '',
    details.episode ? uiText('music.podcast.episodeShort', { value: details.episode }) : '',
    formatPublished(details.published)
  ].filter(Boolean).join(' · ')
  const fallbackDuration = track.duration || 0
  const listsRef = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    if (listsRef.current) listsRef.current.scrollTop = snap.rightPanelScrollTop
  }, [snap.rightViewNonce, snap.rightPanelScrollTop])
  if (!store) return null
  const position = (): number => {
    const live = store.getSnapshot()
    return livePosition(live, live.duration || fallbackDuration)
  }
  const markNow = (): void => store.addMoment(track.id, position())
  const more = show ? show.episodes.filter(episode => episode.id !== track.id).slice(0, 20) : []
  const openShow = (e: React.MouseEvent): void => { if (show) navigateOrOpenTab(e, store, { kind: 'show', id: show.id }, () => store.showPodcastShow(show.id)) }

  return (
    <div className="player-view podcast-player">
      {songEditor}
      <section className={`player-now ${snap.playerCompact ? 'compact' : ''}`} onContextMenu={event => openSongMenu(event, track)}>
        {!snap.playerCompact && <div className="player-media">
          <div className="music-player-mode-row">
            {hasVideo && <div className="music-video-mode" role="group" aria-label={uiText('music.player.mode')}>
              <button aria-pressed={!videoMode} onClick={() => setVideoMode(false)}>{uiText('music.podcast.listen')}</button>
              <button aria-pressed={videoMode} onClick={() => setVideoMode(true)}>{uiText('music.podcast.watch')}</button>
            </div>}
          </div>
          <div ref={coverRef} className="player-art" data-plugin-widget-layout="fill">
            {hasVideo && videoMode && videoSurface ? videoSurface : coverUrl ? <img className="player-art-cover" src={coverUrl} alt="" {...compactHandlers(store, false)} /> : <span className="player-art-empty"><Podcast /></span>}
          </div>
        </div>}

        <div className="player-head podcast-head" onClick={snap.playerCompact && !coverUrl ? expandFromHead(store) : undefined}>
          {snap.playerCompact && coverUrl && <img ref={coverRef} className="player-compact-cover" src={coverUrl} alt="" {...compactHandlers(store, true)} />}
          <div className="player-titles">
            <span className="podcast-kicker music-artist-link" role="button" tabIndex={0} onClick={openShow} onAuxClick={onMiddleClick(() => show && openPageTargetInNewTab(store, { kind: 'show', id: show.id }))}>{show?.name ?? track.album ?? uiText('music.podcast.kicker')}</span>
            <h2 className="player-title">{track.title}</h2>
            {(track.artist || meta) && <p className="player-artist">{[track.artist, meta].filter(Boolean).join(' · ')}</p>}
          </div>
        </div>

        <PlayerScrub fallbackDuration={fallbackDuration} moments={moments} />

        {snap.playError && <div className="player-error">{snap.playError}</div>}

        <div className="player-controls podcast-controls">
          <button className="podcast-rate-btn" title={uiText('music.podcast.speed')} aria-label={uiText('music.podcast.speedValue', { rate: formatRate(snap.podcastRate) })} onClick={() => store.setPodcastRate(nextPodcastRate(snap.podcastRate))}>
            {formatRate(snap.podcastRate)}
          </button>
          <button className="player-skip-btn" title={uiText('music.podcast.back15')} aria-label={uiText('music.podcast.back15')} onClick={() => store.seek(Math.max(0, position() - 15))}>
            <RotateCcw /><span>15</span>
          </button>
          <PlayerPlayButton />
          <button className="player-skip-btn" title={uiText('music.podcast.forward30')} aria-label={uiText('music.podcast.forward30')} onClick={() => { const live = store.getSnapshot(), end = live.duration || fallbackDuration, next = position() + 30; store.seek(end > 0 ? Math.min(end, next) : next) }}>
            <RotateCw /><span>30</span>
          </button>
          <button className="podcast-mark-btn" title={uiText('music.podcast.addMoment')} aria-label={uiText('music.podcast.addMoment')} onClick={markNow}>
            <BookmarkPlus />
          </button>
        </div>
      </section>

      <div className="player-lists" ref={listsRef} onScroll={(event) => store.setRightPanelScrollTop(event.currentTarget.scrollTop)}>
        <PlayerSection id="moments" icon={<Bookmark />} title={uiText('music.podcast.moments')} count={moments.length} open={open.moments} onToggle={() => setOpen(value => ({ ...value, moments: !value.moments }))}
          action={<span className="player-queue-clear" role="button" onClick={(e) => { e.stopPropagation(); markNow() }}>{uiText('music.podcast.markNow')}</span>}>
          <div className="player-queue-list">
            {moments.length === 0
              ? <div className="player-queue-empty">{uiText('music.podcast.momentsEmpty')}</div>
              : moments.map(moment => (
                <MomentRow key={moment.at} at={moment.at} label={moment.label}
                  onSeek={() => void store.seek(moment.at)}
                  onRename={(label) => store.renameMoment(track.id, moment.at, label)}
                  onRemove={() => store.removeMoment(track.id, moment.at)} />
              ))}
          </div>
        </PlayerSection>

        <PlayerSection id="notes" icon={<FileText />} title={uiText('music.podcast.notes')} open={open.notes} onToggle={() => setOpen(value => ({ ...value, notes: !value.notes }))}>
          <div className="podcast-notes">
            {details.guests && <p className="podcast-notes-meta"><span>{uiText('music.edit.guests')}</span> {details.guests}</p>}
            <ShowNotesField track={track} />
          </div>
        </PlayerSection>

        {more.length > 0 && (
          <PlayerSection id="more" icon={<ListMusic />} title={uiText('music.podcast.moreFrom', { show: show?.name ?? '' })} count={more.length} open={open.more} onToggle={() => setOpen(value => ({ ...value, more: !value.more }))}>
            <div className="player-queue-list">
              {more.map(episode => {
                const progress = snap.episodeProgress[episode.id]
                const resume = resumePosition(progress)
                const duration = progress?.duration || episode.duration || 0
                const fraction = duration > 0 && resume > 0 ? Math.min(1, resume / duration) : 0
                const play = (): void => { if (show) store.playEpisodes(show.episodes, show.episodes.indexOf(episode)) }
                return (
                  <div key={episode.id} className="player-history-row podcast-more-row" role="button" tabIndex={0} onDoubleClick={play} onContextMenu={event => openSongMenu(event, episode)}>
                    <CoverThumb trackId={episode.id} fallback={show?.coverPath ? assetUrlForRelPath(show.coverPath) : null} />
                    <button className="player-queue-meta" onClick={play} title={uiText('auto.5d12bd53552c')}>
                      <span className="player-queue-title">{episode.title}</span>
                      <span className="player-queue-artist">{resume > 0 && duration > resume ? uiText('music.podcast.timeLeft', { time: formatTime(duration - resume) }) : duration > 0 ? formatTime(duration) : ''}</span>
                      {fraction > 0 && <span className="podcast-progress" aria-hidden><span style={{ width: `${fraction * 100}%` }} /></span>}
                    </button>
                  </div>
                )
              })}
            </div>
          </PlayerSection>
        )}
      </div>
    </div>
  )
}

/** Right sidebar: the podcast player while an episode is loaded, otherwise the music player. */
export const Player: FC = () => {
  const { snap } = useMusic(false)
  const track = snap.currentTrack ?? snap.resumeTrack
  return track && isEpisode(track, snap.podcastPath) ? <PodcastPlayer track={track} /> : <MusicPlayer />
}
