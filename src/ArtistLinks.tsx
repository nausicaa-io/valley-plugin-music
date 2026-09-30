import { React } from './runtime'
import type { FC, ReactNode } from 'react'
import { useMusic } from './hooks'
import { trackArtists } from './artists'
import type { Track } from './types'
import { uiText } from './localization'

/**
 * A track's artist names rendered as clickable links that open the artist page.
 * Renders inline (no block wrapper) so callers keep their own element + class
 * (`.player-artist`, `.music-row-artist`, …). Each name is a `role="button"`
 * span — not a real `<button>` — so it nests safely inside the row/play controls
 * without invalid button-in-button markup; `stopPropagation` keeps a click from
 * also triggering the row's play/open handler. Falls back to plain text when the
 * song has no artist.
 */
export const ArtistLinks: FC<{ track: Track; fallback?: string }> = ({ track, fallback }) => {
  const { store } = useMusic()
  const names = trackArtists(track)
  if (names.length === 0) {
    return <span className="music-artist-names">{fallback ?? track.artist ?? ''}</span>
  }
  const open = (name: string): void => store?.showArtist(name)
  const nodes: ReactNode[] = []
  names.forEach((name, i) => {
    if (i > 0) nodes.push(<span key={`sep-${i}`} className="music-artist-sep">, </span>)
    nodes.push(
      <span
        key={`a-${i}`}
        className="music-artist-link"
        role="button"
        tabIndex={0}
        title={uiText('auto.8956e3c8cea9', { p0: name })}
        onClick={(e) => {
          e.stopPropagation()
          open(name)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            e.stopPropagation()
            open(name)
          }
        }}
      >
        {name}
      </span>
    )
  })
  return <span className="music-artist-names">{nodes}</span>
}
