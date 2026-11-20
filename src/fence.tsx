/**
 * ```music``` code block — embed a song, playlist, artist, podcast or episode card in any note.
 *
 *   ```music
 *   song: Orbiter
 *   ```
 *   ```music
 *   playlist: Cigarettes After Sex
 *   limit: 5
 *   ```
 *   ```music
 *   artist: Kavinsky
 *   ```
 *   ```music
 *   podcast: Night Shift Science
 *   limit: 3
 *   ```
 *   ```music
 *   episode: The Chemistry of Coffee
 *   ```
 *
 * A bare first line is looked up as a song, playlist, artist, podcast, then episode.
 * Cards are live (play/pause via the real engine) and click through to the
 * Music page. The card re-renders in place: playing or liking never rebuilds it.
 */
import codeBlockExamples from './codeBlockExamples.json'
import { React, api } from './runtime'
import type { FC, ReactNode } from 'react'
import { assetUrlForRelPath } from '@valley/plugin-sdk/fileTypes'
import { fenceInt, parseFenceParams } from '@valley/plugin-sdk/fenceParams'
import { useMusic, useMusicCover } from './hooks'
import { tracksForArtist } from './artists'
import { formatTime, resolveCoverPath } from './data'
import type { MusicSnapshot, MusicStore } from './store'
import type { Artist, Playlist, Track } from './types'
import { episodeShowId, resumePosition, type PodcastShow } from './podcasts'
import { ListMusic, Music, Pause, Play, Podcast, Shuffle, User } from './icons'
import { musicCount, uiText } from './localization'

const STYLE_ID = 'notes-music-fence-styles'

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
.music-fence { margin: 0.75em 0; border: 1px solid var(--border-light); border-radius: 10px; background: var(--container-color); overflow: hidden; }
.music-fence button { font: inherit; }
.music-fence :is(button, [role="button"], [role="link"]):focus:not(:focus-visible) { outline: none; }
.music-fence :is(button, [role="button"], [role="link"]):focus-visible { outline: 2px solid var(--accent-color); outline-offset: 1px; }
.music-fence-head { position: relative; display: flex; align-items: center; gap: 14px; padding: 12px 14px 12px 12px; }
.music-fence-art { position: relative; width: 64px; height: 64px; flex: none; border-radius: 6px; overflow: hidden; cursor: pointer;
  border: none; padding: 0; background: var(--surface-color); box-shadow: 0 1px 3px rgba(0,0,0,.18); }
.music-fence-art.round { border-radius: 50%; }
.music-fence-art img { width: 100%; height: 100%; object-fit: cover; display: block; }
.music-fence-img { position: relative; display: block; width: 100%; height: 100%; }
.music-fence-img > .music-fence-ph { position: absolute; inset: 0; }
.music-fence-img > img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block; opacity: 0; transition: opacity .18s ease; }
.music-fence-img > img.loaded { opacity: 1; }
.music-fence-mosaic { display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr; width: 100%; height: 100%; }
.music-fence-mosaic > * { min-width: 0; min-height: 0; }
.music-fence-fill, .music-fence-mosaic-cell { display: block; width: 100%; height: 100%; overflow: hidden; }
.music-fence-ph { width: 100%; height: 100%; display: grid; place-items: center; color: rgba(255,255,255,.82);
  background: linear-gradient(140deg, hsl(var(--h) 38% 46%), hsl(calc(var(--h) + 38) 42% 28%)); }
.music-fence-ph svg { width: 42%; height: 42%; }
.music-fence-mosaic .music-fence-ph svg { width: 46%; height: 46%; }
.music-fence-art-hover { position: absolute; inset: 0; display: grid; place-items: center; color: #fff; background: rgba(0,0,0,.38);
  opacity: 0; transition: opacity .14s ease; }
.music-fence-art-hover svg { width: 22px; height: 22px; fill: currentColor; }
.music-fence-art:hover .music-fence-art-hover, .music-fence-art:focus-visible .music-fence-art-hover { opacity: 1; }
.music-fence-art-eq { position: absolute; left: 5px; bottom: 5px; display: flex; align-items: flex-end; gap: 2px; height: 18px; padding: 0 5px 4px;
  border-radius: 5px; background: rgba(0,0,0,.55); transition: opacity .14s ease; }
.music-fence-art-eq span { width: 3px; height: 10px; border-radius: 1.5px; background: #fff; }
.music-fence-art:hover .music-fence-art-eq { opacity: 0; }
.music-fence-meta { min-width: 0; flex: 1; cursor: pointer; display: flex; flex-direction: column; gap: 2px; }
.music-fence-kicker { font-size: 0.6875rem; font-weight: 650; letter-spacing: .06em; text-transform: uppercase; color: var(--text-tertiary); }
.music-fence-title { font-weight: 650; font-size: 1.0625em; color: var(--title-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.music-fence-meta:hover .music-fence-title { text-decoration: underline; text-underline-offset: 3px; text-decoration-thickness: 1px; }
.music-fence-card.active .music-fence-title { color: var(--accent-color); }
.music-fence-sub { font-size: var(--small-font-size); color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.music-fence-actions { display: flex; align-items: center; gap: 6px; flex: none; }
.music-fence-icon { width: 34px; height: 34px; display: grid; place-items: center; border: none; border-radius: 50%; background: none;
  color: var(--text-secondary); cursor: pointer; }
.music-fence-icon:hover { background: var(--hover-bg); color: var(--text-color); }
.music-fence-icon svg { width: 17px; height: 17px; }
.music-fence-play { width: 40px; height: 40px; display: grid; place-items: center; border: none; border-radius: 50%; padding: 0;
  background: var(--accent-color); color: #fff; cursor: pointer; transition: transform .12s ease, filter .12s ease; }
.music-fence-play:hover { filter: brightness(1.1); transform: scale(1.04); }
.music-fence-play:active { transform: scale(.96); }
.music-fence-play svg { width: 16px; height: 16px; fill: currentColor; stroke: none; }
.music-fence-play.is-play svg { margin-left: 2px; }
.music-fence-progress { position: absolute; left: 0; right: 0; bottom: 0; height: 3px; background: color-mix(in srgb, var(--accent-color) 16%, transparent); }
.music-fence-progress > span { display: block; height: 100%; background: var(--accent-color); border-radius: 0 2px 2px 0; }
.music-fence-rows { border-top: 1px solid var(--border-light); padding: 4px; }
.music-fence-row { display: flex; align-items: center; gap: 10px; padding: 5px 8px; border-radius: 6px; cursor: pointer; }
.music-fence-row:hover { background: var(--hover-bg); }
.music-fence-row.current { background: color-mix(in srgb, var(--accent-color) 10%, transparent); }
.music-fence-lead { position: relative; width: 22px; height: 22px; flex: none; display: grid; place-items: center; }
.music-fence-lead .n { font-size: var(--small-font-size); color: var(--text-tertiary); font-variant-numeric: tabular-nums; }
.music-fence-lead .p { display: none; color: var(--text-color); }
.music-fence-lead .p svg { width: 13px; height: 13px; fill: currentColor; stroke: none; }
.music-fence-row:hover .music-fence-lead .n, .music-fence-row:hover .music-fence-lead .music-fence-eq { display: none; }
.music-fence-row:hover .music-fence-lead .p { display: grid; }
.music-fence-thumb { width: 34px; height: 34px; flex: none; border-radius: 4px; overflow: hidden; background: var(--surface-color); }
.music-fence-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.music-fence-row-meta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.music-fence-row-meta .t { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--text-color); }
.music-fence-row-meta .s { font-size: var(--small-font-size); color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.music-fence-row.current .music-fence-row-meta .t { color: var(--accent-color); font-weight: 600; }
.music-fence-row-bar { height: 2px; margin-top: 3px; border-radius: 1px; background: var(--border-light); overflow: hidden; }
.music-fence-row-bar > span { display: block; height: 100%; background: var(--accent-color); }
.music-fence-row .d { color: var(--text-secondary); font-size: var(--small-font-size); flex: none; font-variant-numeric: tabular-nums; }
.music-fence-more { display: block; width: 100%; margin-top: 2px; padding: 6px 8px; border: none; border-radius: 6px; background: none; text-align: left;
  color: var(--text-secondary); font-size: var(--small-font-size); cursor: pointer; }
.music-fence-more:hover { background: var(--hover-bg); color: var(--text-color); }
.music-fence-eq { display: flex; align-items: flex-end; justify-content: center; gap: 2px; height: 12px; }
.music-fence-eq span { width: 3px; height: 12px; border-radius: 1.5px; background: var(--accent-color); transform-origin: bottom;
  animation: music-fence-eq .9s ease-in-out infinite alternate; }
.music-fence-art-eq span { transform-origin: bottom; animation: music-fence-eq .9s ease-in-out infinite alternate; }
.music-fence-eq span:nth-child(2), .music-fence-art-eq span:nth-child(2) { animation-delay: -.45s; animation-duration: .7s; }
.music-fence-eq span:nth-child(3), .music-fence-art-eq span:nth-child(3) { animation-delay: -.2s; animation-duration: 1.05s; }
.music-fence-eq.paused span, .music-fence-art-eq.paused span { animation: none; transform: scaleY(.4); }
@keyframes music-fence-eq { 0% { transform: scaleY(.25); } 50% { transform: scaleY(1); } 100% { transform: scaleY(.55); } }
@media (prefers-reduced-motion: reduce) { .music-fence-eq span, .music-fence-art-eq span { animation: none; transform: scaleY(.7); } }
.music-fence-empty { padding: 12px 14px; color: var(--text-secondary); font-size: var(--small-font-size); }
`
  document.head.appendChild(style)
}

const norm = (value: string): string => value.trim().toLowerCase()

const findIn = (tracks: readonly Track[], query: string): Track | null => {
  const wanted = norm(query)
  return (
    tracks.find((t) => t.id === query) ??
    tracks.find((t) => norm(t.title) === wanted) ??
    tracks.find((t) => norm(t.title).includes(wanted)) ??
    null
  )
}

const findPlaylist = (snap: MusicSnapshot, query: string, loose: boolean): Playlist | null =>
  snap.playlists.find((p) => p.id === query) ??
  snap.playlists.find((p) => norm(p.name) === norm(query)) ??
  (loose ? snap.playlists.find((p) => norm(p.name).includes(norm(query))) : undefined) ??
  null

const findArtist = (snap: MusicSnapshot, query: string): Artist | null =>
  snap.artists.find((a) => norm(a.name) === norm(query)) ??
  snap.artists.find((a) => (a.aliases ?? []).some((alias) => norm(alias) === norm(query))) ??
  null

const findShow = (snap: MusicSnapshot, query: string, loose: boolean): PodcastShow | null =>
  snap.shows.find((s) => s.id === norm(query)) ??
  (loose ? snap.shows.find((s) => s.id.includes(norm(query))) : undefined) ??
  null

const showOf = (snap: MusicSnapshot, episode: Track): PodcastShow | undefined => {
  const id = episodeShowId(episode)
  return snap.shows.find((show) => show.id === id)
}

const hue = (seed: string): number => {
  let h = 0
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) % 360
  return h
}

const openPage = (): void => api.workspace.openMainTab()

const totalTime = (tracks: readonly Track[]): string => {
  const seconds = tracks.reduce((sum, track) => sum + (track.duration || 0), 0)
  return seconds > 0 ? formatTime(seconds) : ''
}

/** Gradient tile with the kind's glyph: never a flat, empty box. */
const Placeholder: FC<{ seed: string; icon: ReactNode }> = ({ seed, icon }) => (
  <span className="music-fence-ph" style={{ ['--h' as string]: String(hue(seed)) }} aria-hidden>{icon}</span>
)

/** An image that falls back to `fallback` while it has no source or when the file is missing. */
const Img: FC<{ src: string | null | undefined; fallback: ReactNode }> = ({ src, fallback }) => {
  const [failed, setFailed] = React.useState<string | null>(null)
  const [loaded, setLoaded] = React.useState<string | null>(null)
  if (!src || failed === src) return <>{fallback}</>
  // The tile stays underneath until the image has decoded, so a cover never shows as an empty box.
  return (
    <span className="music-fence-img">
      {loaded !== src && fallback}
      <img src={src} alt="" draggable={false} className={loaded === src ? 'loaded' : ''} onLoad={() => setLoaded(src)} onError={() => setFailed(src)} />
    </span>
  )
}

/** A track's own artwork (lazy, from the file's tags), else `fallback`. */
const TrackArt: FC<{ store: MusicStore; track: Track; fallback: ReactNode; className?: string }> = ({ store, track, fallback, className = 'music-fence-fill' }) => {
  const { url, ref } = useMusicCover(store, track.id)
  return <span ref={ref} className={className}><Img src={url} fallback={fallback} /></span>
}

/** The card's artwork: its own image, else a 2×2 mosaic of its first covers, else one track's cover, else a placeholder. */
const Art: FC<{
  store: MusicStore
  src: string | null
  tracks: readonly Track[]
  seed: string
  icon: ReactNode
  round?: boolean
  active: boolean
  playing: boolean
  onPlay: () => void
}> = ({ store, src, tracks, seed, icon, round, active, playing, onPlay }) => {
  const fallback = <Placeholder seed={seed} icon={icon} />
  let body: ReactNode
  if (src) body = <Img src={src} fallback={fallback} />
  else if (tracks.length >= 4) {
    body = (
      <span className="music-fence-mosaic">
        {tracks.slice(0, 4).map((track) => (
          <TrackArt key={track.id} store={store} track={track} className="music-fence-mosaic-cell" fallback={<Placeholder seed={track.title} icon={icon} />} />
        ))}
      </span>
    )
  } else if (tracks[0]) body = <TrackArt store={store} track={tracks[0]} fallback={fallback} />
  else body = fallback
  const label = playing ? uiText('auto.781961bc81c2') : uiText('auto.5d12bd53552c')
  return (
    <button
      type="button"
      className={`music-fence-art ${round ? 'round' : ''}`}
      onClick={(e) => {
        e.stopPropagation()
        onPlay()
      }}
      aria-label={label}
      title={label}
    >
      {body}
      {active && <EqBars className="music-fence-art-eq" playing={playing} />}
      <span className="music-fence-art-hover">{playing ? <Pause /> : <Play />}</span>
    </button>
  )
}

const EqBars: FC<{ playing: boolean; className?: string }> = ({ playing, className = 'music-fence-eq' }) => (
  <span className={`${className} ${playing ? '' : 'paused'}`} aria-hidden>
    <span />
    <span />
    <span />
  </span>
)

const PlayButton: FC<{ playing: boolean; disabled?: boolean; onClick: () => void }> = ({ playing, disabled, onClick }) => {
  const label = playing ? uiText('auto.781961bc81c2') : uiText('auto.5d12bd53552c')
  return (
    <button type="button" className={`music-fence-play ${playing ? '' : 'is-play'}`} disabled={disabled} aria-label={label} title={label}
      onClick={(e) => { e.stopPropagation(); onClick() }}>
      {playing ? <Pause /> : <Play />}
    </button>
  )
}

/** Live position of the playing item; the only part of a card that follows the clock. */
const LiveProgress: FC<{ fallbackDuration: number }> = ({ fallbackDuration }) => {
  const { snap } = useMusic(true)
  const duration = snap.duration || fallbackDuration
  const fraction = duration > 0 ? Math.min(1, snap.currentTime / duration) : 0
  return <span className="music-fence-progress" aria-hidden><span style={{ width: `${fraction * 100}%` }} /></span>
}

const Head: FC<{
  kind: string
  title: string
  sub: string
  art: ReactNode
  openLabel: string
  onOpen: () => void
  actions: ReactNode
  progress?: ReactNode
}> = ({ kind, title, sub, art, openLabel, onOpen, actions, progress }) => (
  <div className="music-fence-head">
    {art}
    <div className="music-fence-meta" role="link" tabIndex={0} title={openLabel} onClick={onOpen} onKeyDown={(e) => { if (e.key === 'Enter') onOpen() }}>
      <span className="music-fence-kicker">{kind}</span>
      <span className="music-fence-title">{title}</span>
      {sub && <span className="music-fence-sub">{sub}</span>}
    </div>
    <div className="music-fence-actions">{actions}</div>
    {progress}
  </div>
)

const Card: FC<{ active: boolean; children: ReactNode }> = ({ active, children }) => (
  <div className={`music-fence-card ${active ? 'active' : ''}`}>{children}</div>
)

interface RowItem {
  track: Track
  sub: string
  detail: string
  fraction?: number
}

const Rows: FC<{
  store: MusicStore
  snap: MusicSnapshot
  items: RowItem[]
  limit: number
  icon: ReactNode
  fallbackSrc?: string | null
  /** One tint for every row without artwork (a show's episodes), else each row gets its own. */
  seed?: string
  onPlay: (index: number) => void
  onMore: () => void
}> = ({ store, snap, items, limit, icon, fallbackSrc, seed, onPlay, onMore }) => {
  const hidden = items.length - limit
  return (
    <div className="music-fence-rows">
      {items.slice(0, limit).map(({ track, sub, detail, fraction }, index) => {
        const current = snap.currentTrack?.id === track.id
        const playing = current && snap.isPlaying
        const tile = <Placeholder seed={seed ?? track.title} icon={icon} />
        const fallback = fallbackSrc ? <Img src={fallbackSrc} fallback={tile} /> : tile
        return (
          <div
            key={track.id}
            className={`music-fence-row ${current ? 'current' : ''}`}
            role="button"
            tabIndex={0}
            onClick={() => (current ? store.togglePlay() : onPlay(index))}
            onKeyDown={(e) => { if (e.key === 'Enter') { if (current) store.togglePlay(); else onPlay(index) } }}
            title={playing ? uiText('auto.781961bc81c2') : uiText('auto.bba105047e80', { p0: track.title })}
          >
            <span className="music-fence-lead">
              {current ? <EqBars playing={playing} /> : <span className="n">{index + 1}</span>}
              <span className="p">{playing ? <Pause /> : <Play />}</span>
            </span>
            <TrackArt store={store} track={track} className="music-fence-thumb" fallback={fallback} />
            <span className="music-fence-row-meta">
              <span className="t">{track.title}</span>
              {sub && <span className="s">{sub}</span>}
              {fraction !== undefined && fraction > 0 && <span className="music-fence-row-bar"><span style={{ width: `${fraction * 100}%` }} /></span>}
            </span>
            <span className="d">{detail}</span>
          </div>
        )
      })}
      {hidden > 0 && (
        <button type="button" className="music-fence-more" onClick={onMore}>{uiText('music.fence.more', { count: hidden })}</button>
      )}
    </div>
  )
}

const SongCard: FC<{ store: MusicStore; snap: MusicSnapshot; track: Track }> = ({ store, snap, track }) => {
  const active = snap.currentTrack?.id === track.id
  const playing = active && snap.isPlaying
  const toggle = (): void => (active ? store.togglePlay() : store.playTrack(track))
  const open = (): void => {
    store.revealSong(track.id)
    openPage()
  }
  return (
    <Card active={active}>
      <Head
        kind={uiText('music.fence.kind.song')}
        title={track.title}
        sub={[track.artist, track.album, track.duration ? formatTime(track.duration) : ''].filter(Boolean).join(' · ')}
        art={<Art store={store} src={null} tracks={[track]} seed={track.title} icon={<Music />} active={active} playing={playing} onPlay={toggle} />}
        openLabel={uiText('auto.2a2cb420f9c1')}
        onOpen={open}
        actions={<PlayButton playing={playing} onClick={toggle} />}
        progress={active ? <LiveProgress fallbackDuration={track.duration || 0} /> : null}
      />
    </Card>
  )
}

const EpisodeCard: FC<{ store: MusicStore; snap: MusicSnapshot; track: Track }> = ({ store, snap, track }) => {
  const show = showOf(snap, track)
  const active = snap.currentTrack?.id === track.id
  const playing = active && snap.isPlaying
  const progress = snap.episodeProgress[track.id]
  const duration = progress?.duration || track.duration || 0
  const position = resumePosition(progress)
  const episodes = show?.episodes ?? [track]
  const toggle = (): void => (active ? store.togglePlay() : store.playEpisodes(episodes, Math.max(0, episodes.indexOf(track))))
  const detail = position > 0 && duration > position ? uiText('music.podcast.timeLeft', { time: formatTime(duration - position) }) : duration ? formatTime(duration) : ''
  return (
    <Card active={active}>
      <Head
        kind={uiText('music.fence.kind.episode')}
        title={track.title}
        sub={[show?.name ?? track.album ?? track.artist, detail].filter(Boolean).join(' · ')}
        art={
          <Art store={store} src={null} tracks={[track]} seed={show?.name ?? track.title} icon={<Podcast />} active={active} playing={playing} onPlay={toggle} />
        }
        openLabel={uiText('music.fence.openShow')}
        onOpen={() => { if (show) store.showPodcastShow(show.id) }}
        actions={<PlayButton playing={playing} onClick={toggle} />}
        progress={active
          ? <LiveProgress fallbackDuration={duration} />
          : position > 0 && duration > 0
            ? <span className="music-fence-progress" aria-hidden><span style={{ width: `${Math.min(1, position / duration) * 100}%` }} /></span>
            : null}
      />
    </Card>
  )
}

const ListCard: FC<{
  store: MusicStore
  snap: MusicSnapshot
  kind: string
  title: string
  src: string | null
  round?: boolean
  icon: ReactNode
  tracks: Track[]
  playlistId: string | null
  limit: number
  openLabel: string
  onOpen: () => void
}> = ({ store, snap, kind, title, src, round, icon, tracks, playlistId, limit, openLabel, onOpen }) => {
  const ids = React.useMemo(() => new Set(tracks.map((t) => t.id)), [tracks])
  const active = snap.currentTrack != null && ids.has(snap.currentTrack.id) && (playlistId == null || snap.currentPlaylistId === playlistId)
  const playing = active && snap.isPlaying
  const play = (index: number): void => store.playTrack(tracks[index], { queue: tracks, index, playlistId })
  const toggle = (): void => (active ? store.togglePlay() : tracks.length ? play(0) : undefined)
  const time = totalTime(tracks)
  return (
    <Card active={active}>
      <Head
        kind={kind}
        title={title}
        sub={[musicCount(tracks.length, 'song'), time].filter(Boolean).join(' · ')}
        art={<Art store={store} src={src} tracks={tracks} seed={title} icon={icon} round={round} active={active} playing={playing} onPlay={toggle} />}
        openLabel={openLabel}
        onOpen={onOpen}
        actions={<>
          <button type="button" className="music-fence-icon" disabled={!tracks.length} title={uiText('music.fence.shufflePlay')} aria-label={uiText('music.fence.shufflePlay')}
            onClick={(e) => { e.stopPropagation(); store.playShuffledQueue(tracks, playlistId) }}>
            <Shuffle />
          </button>
          <PlayButton playing={playing} disabled={!tracks.length} onClick={toggle} />
        </>}
      />
      {tracks.length > 0 && (
        <Rows
          store={store}
          snap={snap}
          items={tracks.map((track) => ({
            track,
            sub: playlistId ? track.artist : track.album ?? '',
            detail: track.duration ? formatTime(track.duration) : ''
          }))}
          limit={limit}
          icon={<Music />}
          onPlay={play}
          onMore={onOpen}
        />
      )}
    </Card>
  )
}

const ShowCard: FC<{ store: MusicStore; snap: MusicSnapshot; show: PodcastShow; limit: number }> = ({ store, snap, show, limit }) => {
  const active = snap.currentTrack != null && show.episodes.some((e) => e.id === snap.currentTrack!.id)
  const playing = active && snap.isPlaying
  const play = (index: number): void => store.playEpisodes(show.episodes, index)
  // Play the show: resume its most recently listened episode, else the newest.
  const resume = (): void => {
    const recent = show.episodes
      .map((episode, index) => ({ index, progress: snap.episodeProgress[episode.id] }))
      .filter((entry) => resumePosition(entry.progress) > 0)
      .sort((a, b) => b.progress!.updatedAt.localeCompare(a.progress!.updatedAt))[0]
    play(recent?.index ?? 0)
  }
  const toggle = (): void => (active ? store.togglePlay() : show.episodes.length ? resume() : undefined)
  const open = (): void => store.showPodcastShow(show.id)
  const src = show.coverPath ? assetUrlForRelPath(show.coverPath) : null
  return (
    <Card active={active}>
      <Head
        kind={uiText('music.fence.kind.show')}
        title={show.name}
        sub={uiText(`music.count.episode.${show.episodes.length === 1 ? 'one' : 'other'}`, { count: show.episodes.length })}
        art={<Art store={store} src={src} tracks={show.episodes.slice(0, 1)} seed={show.name} icon={<Podcast />} active={active} playing={playing} onPlay={toggle} />}
        openLabel={uiText('music.fence.openShow')}
        onOpen={open}
        actions={<PlayButton playing={playing} disabled={!show.episodes.length} onClick={toggle} />}
      />
      {show.episodes.length > 0 && (
        <Rows
          store={store}
          snap={snap}
          items={show.episodes.map((track) => {
            const progress = snap.episodeProgress[track.id]
            const duration = progress?.duration || track.duration || 0
            const position = resumePosition(progress)
            return {
              track,
              sub: position > 0 && duration > position ? uiText('music.podcast.timeLeft', { time: formatTime(duration - position) }) : track.artist,
              detail: duration ? formatTime(duration) : '',
              fraction: position > 0 && duration > 0 ? Math.min(1, position / duration) : 0
            }
          })}
          limit={limit}
          icon={<Podcast />}
          fallbackSrc={src}
          seed={show.name}
          onPlay={play}
          onMore={open}
        />
      )}
    </Card>
  )
}

const Empty: FC<{ children: ReactNode; alert?: boolean }> = ({ children, alert }) => (
  <div className="music-fence-empty" role={alert ? 'alert' : undefined}>{children}</div>
)

export const MusicFence: FC<{ code: string }> = ({ code }) => {
  const { store, snap } = useMusic(false)
  const params = React.useMemo(() => parseFenceParams(code), [code])
  if (!store) return <Empty>{uiText('auto.e4a2a6c8fdc8')}</Empty>
  if (snap.libraryError) return <Empty alert>{snap.libraryError}</Empty>
  if (snap.loading && snap.tracks.length === 0 && snap.episodes.length === 0) return <Empty>{uiText('auto.78df555a3a52')}</Empty>

  const limit = fenceInt(params, 'limit', 100) ?? 10
  const v = params.values
  const songQuery = v.song ?? null
  const playlistQuery = v.playlist ?? null
  const artistQuery = v.artist ?? null
  const showQuery = v.podcast ?? v.show ?? null
  const episodeQuery = v.episode ?? null
  const bare = songQuery || playlistQuery || artistQuery || showQuery || episodeQuery ? null : params.bare
  const notFound = (prefix: string, name: string): ReactNode => <Empty>{prefix}{name}{uiText('auto.792c40464917')}</Empty>

  const songCard = (track: Track): ReactNode => <SongCard store={store} snap={snap} track={track} />
  const playlistCard = (playlist: Playlist): ReactNode => (
    <ListCard
      store={store}
      snap={snap}
      kind={uiText('music.fence.kind.playlist')}
      title={playlist.name}
      src={snap.playlistCovers[playlist.id] ? assetUrlForRelPath(snap.playlistCovers[playlist.id]!) : null}
      icon={<ListMusic />}
      tracks={snap.playlistTracks[playlist.id] ?? []}
      playlistId={playlist.id}
      limit={limit}
      openLabel={uiText('auto.e726a544ee3c')}
      onOpen={() => { store.showPlaylist(playlist.id); openPage() }}
    />
  )
  const artistCard = (artist: Artist, tracks: Track[]): ReactNode => (
    <ListCard
      store={store}
      snap={snap}
      kind={uiText('music.fence.kind.artist')}
      title={artist.name}
      src={artist.image ? assetUrlForRelPath(resolveCoverPath(store.getIndexEntries(), artist.image) ?? artist.image) : null}
      round
      icon={<User />}
      tracks={tracks}
      playlistId={null}
      limit={limit}
      openLabel={uiText('auto.03f27ae4c8a6')}
      onOpen={() => { store.showArtist(artist.name); openPage() }}
    />
  )
  const showCard = (show: PodcastShow): ReactNode => <ShowCard store={store} snap={snap} show={show} limit={limit} />
  const episodeCard = (track: Track): ReactNode => <EpisodeCard store={store} snap={snap} track={track} />

  if (songQuery) {
    const track = findIn(snap.tracks, songQuery)
    return track ? songCard(track) : notFound(uiText('auto.81962922da2b'), songQuery)
  }
  if (playlistQuery) {
    const playlist = findPlaylist(snap, playlistQuery, true)
    return playlist ? playlistCard(playlist) : notFound(uiText('auto.f692e5febde5'), playlistQuery)
  }
  if (artistQuery) {
    const artist = findArtist(snap, artistQuery)
    const tracks = artist ? tracksForArtist(snap.tracks, artist) : []
    return artist && tracks.length ? artistCard(artist, tracks) : <Empty>{uiText('auto.655a16e6ca9e')}{artistQuery}”.</Empty>
  }
  if (showQuery) {
    const show = findShow(snap, showQuery, true)
    return show ? showCard(show) : <Empty>{uiText('music.fence.showNotFound', { name: showQuery })}</Empty>
  }
  if (episodeQuery) {
    const episode = findIn(snap.episodes, episodeQuery)
    return episode ? episodeCard(episode) : <Empty>{uiText('music.fence.episodeNotFound', { name: episodeQuery })}</Empty>
  }
  if (bare) {
    const track = findIn(snap.tracks, bare)
    if (track) return songCard(track)
    const playlist = findPlaylist(snap, bare, false)
    if (playlist) return playlistCard(playlist)
    const artist = findArtist(snap, bare)
    const tracks = artist ? tracksForArtist(snap.tracks, artist) : []
    if (artist && tracks.length) return artistCard(artist, tracks)
    const show = findShow(snap, bare, false)
    if (show) return showCard(show)
    const episode = findIn(snap.episodes, bare)
    if (episode) return episodeCard(episode)
    return <Empty>{uiText('auto.655a16e6ca9e')}{bare}”.</Empty>
  }

  // Empty block: current / resume track.
  const resume = snap.currentTrack ?? snap.resumeTrack
  if (!resume) return <Empty>{uiText('auto.e46cd714af6b')}</Empty>
  return snap.episodes.some((e) => e.id === resume.id) ? episodeCard(resume) : songCard(resume)
}

/** Register the ```music``` fence; returns the unregister fn. */
export function registerMusicFence(): () => void {
  const off = api.markdown.registerCodeBlockRenderer('music', (code, el) => {
    ensureStyles()
    el.classList.add('music-fence')
    return api.ui.renderReact(el, <MusicFence code={code} />)
  }, { examples: codeBlockExamples.music })
  return () => {
    off()
    document.getElementById(STYLE_ID)?.remove()
  }
}
