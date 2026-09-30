/**
 * ```music``` code block — embed a song, playlist or artist card in any note.
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
 *
 * A bare first line is treated as `song:` first, then playlist, then artist.
 * Cards are live (play/pause via the real engine) and click through to the
 * Music page.
 */
import codeBlockExamples from './codeBlockExamples.json'
import { React, api } from './runtime'
import type { FC } from 'react'
import { assetUrlForRelPath } from '@valley/plugin-sdk/fileTypes'
import { fenceInt, parseFenceParams } from '@valley/plugin-sdk/fenceParams'
import { useMusic, useMusicCover } from './hooks'
import { tracksForArtist } from './artists'
import { formatTime, resolveCoverPath } from './data'
import type { MusicSnapshot, MusicStore } from './store'
import type { Track } from './types'
import { musicCount, uiText } from './localization'

const STYLE_ID = 'notes-music-fence-styles'

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
.music-fence { margin: 0.75em 0; border: 1px solid var(--border-light); border-radius: var(--radius); background: var(--container-color); overflow: hidden; }
.music-fence-head { display: flex; align-items: center; gap: 12px; padding: 12px; }
.music-fence-cover { position: relative; width: 56px; height: 56px; flex: none; border-radius: var(--radius-sm); background: var(--surface-color); overflow: hidden; cursor: pointer; border: none; padding: 0; }
.music-fence-cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
.music-fence-cover .music-fence-play { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size:20px; color: #fff; background: rgba(0,0,0,0.35); opacity: 0; transition: opacity 0.12s ease; }
.music-fence-cover:hover .music-fence-play { opacity: 1; }
.music-fence-title { min-width: 0; flex: 1; cursor: pointer; }
.music-fence-title .t { font-weight: 600; color: var(--title-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.music-fence-title .s { font-size: var(--small-font-size); color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.music-fence-rows { border-top: 1px solid var(--border-light); }
.music-fence-row { display: flex; align-items: center; gap: 8px; padding: 6px 12px; cursor: pointer; }
.music-fence-row:hover { background: var(--hover-bg); }
.music-fence-row .n { width: 1.5em; text-align: right; color: var(--text-secondary); font-size: var(--small-font-size); flex: none; }
.music-fence-row .t { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--text-color); }
.music-fence-row .d { color: var(--text-secondary); font-size: var(--small-font-size); flex: none; }
.music-fence-row.playing .t { color: var(--accent-color); }
.music-fence-empty { padding: 12px; color: var(--text-secondary); font-size: var(--small-font-size); }
`
  document.head.appendChild(style)
}

const norm = (value: string): string => value.trim().toLowerCase()

const findTrack = (snap: MusicSnapshot, query: string): Track | null => {
  const wanted = norm(query)
  return (
    snap.tracks.find((t) => t.id === query) ??
    snap.tracks.find((t) => norm(t.title) === wanted) ??
    snap.tracks.find((t) => norm(t.title).includes(wanted)) ??
    null
  )
}

const openPage = (): void => api.workspace.openMainTab()

const Cover: FC<{ src: string | null; store?: MusicStore; trackId?: string; onPlay: () => void; playing: boolean }> = ({ src, store, trackId, onPlay, playing }) => {
  const { url, ref } = useMusicCover(store ?? null, src ? undefined : trackId)
  const image = src ?? url
  return (
    <button
      ref={ref}
      className="music-fence-cover"
      onClick={(e) => {
        e.stopPropagation()
        onPlay()
      }}
      aria-label={playing ? uiText('auto.781961bc81c2') : uiText('auto.5d12bd53552c')}
      title={playing ? uiText('auto.781961bc81c2') : uiText('auto.5d12bd53552c')}
    >
      {image ? <img src={image} alt="" /> : null}
      <span className="music-fence-play">{playing ? '❚❚' : '▶'}</span>
    </button>
  )
}

const SongCard: FC<{ store: MusicStore; snap: MusicSnapshot; track: Track }> = ({ store, snap, track }) => {
  const playing = snap.isPlaying && snap.currentTrack?.id === track.id
  const toggle = (): void => {
    if (snap.currentTrack?.id === track.id) store.togglePlay()
    else store.playTrack(track)
  }
  return (
    <div className="music-fence-head">
      <Cover src={null} store={store} trackId={track.id} onPlay={toggle} playing={playing} />
      <div
        className="music-fence-title"
        onClick={() => {
          store.revealSong(track.id)
          openPage()
        }}
        title={uiText('auto.2a2cb420f9c1')}
      >
        <div className="t">{track.title}</div>
        <div className="s">
          {track.artist}
          {track.duration ? ` · ${formatTime(track.duration)}` : ''}
        </div>
      </div>
    </div>
  )
}

const TrackRows: FC<{ store: MusicStore; snap: MusicSnapshot; tracks: Track[]; queue: Track[]; playlistId?: string | null; limit: number }> = ({
  store,
  snap,
  tracks,
  queue,
  playlistId,
  limit
}) => (
  <div className="music-fence-rows">
    {tracks.slice(0, limit).map((track, index) => (
      <div
        key={track.id}
        className={`music-fence-row ${snap.currentTrack?.id === track.id ? 'playing' : ''}`}
        onClick={() => store.playTrack(track, { queue, index: queue.indexOf(track), playlistId: playlistId ?? null })}
        title={uiText('auto.bba105047e80', { p0: track.title })}
      >
        <span className="n">{index + 1}</span>
        <span className="t">{track.title}</span>
        <span className="d">{track.duration ? formatTime(track.duration) : ''}</span>
      </div>
    ))}
  </div>
)

const MusicFence: FC<{ code: string }> = ({ code }) => {
  const { store, snap } = useMusic()
  if (!store) return <div className="music-fence-empty">{uiText('auto.e4a2a6c8fdc8')}</div>
  if (snap.loading) return <div className="music-fence-empty">{uiText('auto.78df555a3a52')}</div>

  const params = parseFenceParams(code)
  const limit = fenceInt(params, 'limit', 100) ?? 10
  const songQuery = params.values.song ?? null
  const playlistQuery = params.values.playlist ?? null
  const artistQuery = params.values.artist ?? null
  const bare = params.bare

  // Explicit keys win; a bare line resolves song → playlist → artist.
  const track = songQuery ? findTrack(snap, songQuery) : bare && !playlistQuery && !artistQuery ? findTrack(snap, bare) : null
  if (songQuery || (bare && track)) {
    if (!track) return <div className="music-fence-empty">{uiText('auto.81962922da2b')}{' '}{songQuery ?? bare}{' '}{uiText('auto.792c40464917')}</div>
    return <SongCard store={store} snap={snap} track={track} />
  }

  const playlistWanted = playlistQuery ?? bare
  const playlist = playlistWanted
    ? snap.playlists.find((p) => p.id === playlistWanted) ??
      snap.playlists.find((p) => norm(p.name) === norm(playlistWanted)) ??
      (playlistQuery ? snap.playlists.find((p) => norm(p.name).includes(norm(playlistQuery))) : undefined)
    : undefined
  if (playlistQuery || (playlistWanted && playlist && !artistQuery)) {
    if (!playlist) return <div className="music-fence-empty">{uiText('auto.f692e5febde5')}{' '}{playlistWanted}{' '}{uiText('auto.792c40464917')}</div>
    const tracks = snap.playlistTracks[playlist.id] ?? []
    const coverPath = snap.playlistCovers[playlist.id]
    const playing = snap.isPlaying && snap.currentPlaylistId === playlist.id
    return (
      <>
        <div className="music-fence-head">
          <Cover
            src={coverPath ? assetUrlForRelPath(coverPath) : null}
            playing={playing}
            onPlay={() => {
              if (playing) store.togglePlay()
              else if (tracks.length) store.playTrack(tracks[0], { queue: tracks, index: 0, playlistId: playlist.id })
            }}
          />
          <div
            className="music-fence-title"
            onClick={() => {
              store.showPlaylist(playlist.id)
              openPage()
            }}
            title={uiText('auto.e726a544ee3c')}
          >
            <div className="t">{playlist.name}</div>
            <div className="s">
              {musicCount(tracks.length, 'song')}
            </div>
          </div>
        </div>
        {tracks.length > 0 && (
          <TrackRows store={store} snap={snap} tracks={tracks} queue={tracks} playlistId={playlist.id} limit={limit} />
        )}
      </>
    )
  }

  const artistWanted = artistQuery ?? bare
  if (artistWanted) {
    const artist =
      snap.artists.find((a) => norm(a.name) === norm(artistWanted)) ??
      snap.artists.find((a) => (a.aliases ?? []).some((alias) => norm(alias) === norm(artistWanted)))
    const tracks = artist ? tracksForArtist(snap.tracks, artist) : []
    if (!artist || tracks.length === 0)
      return <div className="music-fence-empty">{uiText('auto.655a16e6ca9e')}{' '}{artistWanted}”.</div>
    return (
      <>
        <div className="music-fence-head">
          <Cover
            src={artist.image ? assetUrlForRelPath(resolveCoverPath(store.getIndexEntries(), artist.image) ?? artist.image) : null}
            store={store}
            trackId={tracks[0].id}
            playing={snap.isPlaying && snap.currentTrack != null && tracks.some((t) => t.id === snap.currentTrack!.id)}
            onPlay={() => store.playTrack(tracks[0], { queue: tracks, index: 0 })}
          />
          <div
            className="music-fence-title"
            onClick={() => {
              store.showArtist(artist.name)
              openPage()
            }}
            title={uiText('auto.03f27ae4c8a6')}
          >
            <div className="t">{artist.name}</div>
            <div className="s">
              {musicCount(tracks.length, 'song')}
            </div>
          </div>
        </div>
        <TrackRows store={store} snap={snap} tracks={tracks} queue={tracks} limit={limit} />
      </>
    )
  }

  // Empty block: current / resume track.
  const resume = snap.currentTrack ?? snap.resumeTrack
  if (!resume) return <div className="music-fence-empty">{uiText('auto.e46cd714af6b')}</div>
  return <SongCard store={store} snap={snap} track={resume} />
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
