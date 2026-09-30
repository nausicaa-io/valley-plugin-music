/** A single song in the plugin-owned tracks dataset. */
export interface Track {
  id: string
  title: string
  /**
   * The artist string as imported/tagged — stays the editable source of truth.
   * Auto-split on common delimiters (`, ; & feat. ft. x × vs.`) into individual
   * clickable names; see `trackArtists` in `artists.ts`.
   */
  artist: string
  /**
   * Optional explicit artist list. When present (and non-empty) it wins over
   * splitting `artist`, so a song with names that contain delimiters can still
   * be addressed precisely. Most songs leave this unset.
   */
  artists?: string[]
  album?: string
  details?: { feat?: string; songwriter?: string; author?: string; composer?: string; genre?: string; year?: string; lyrics?: string; cover?: string; edited?: boolean }
  /** Vault-relative path to the media file. */
  file: string
  /** Length in seconds (used before media metadata loads). */
  duration?: number
  favorite?: boolean
  /** ISO timestamp of when the scan first saw this file. */
  addedAt?: string
}

/**
 * An artist entity in the plugin-owned artists dataset. Identity is the
 * normalized `name`; the registry is upserted from every song's split artist
 * names so links/commands resolve names → a stable `id` and so per-artist extras
 * (`image`/`bio`) survive renames and library rescans. `aliases` lets a rename
 * keep the old name resolving, and a merge fold one artist's names into another.
 */
export interface Artist {
  id: string
  name: string
  /** Cover image file name, re-resolved against the vault index (like playlists). */
  image?: string
  bio?: string
  /** Other names that resolve to this artist (from renames / merges). */
  aliases?: string[]
}

/**
 * A playlist from the playlists dataset. Membership is reconstructed from
 * ordered `playlist_tracks` rows.
 */
export interface Playlist {
  id: string
  name: string
  /** Ordered song ids. */
  songIds: string[]
  /**
   * Cover image: the file name of a vault image (e.g. `summer.jpg`). Stored by
   * name, not path — re-resolved against the vault index on every load so the
   * cover survives the image being moved.
  */
  cover?: string
}

/** One committed play event. */
export interface HistoryEntry {
  songId: string
  playedAt: string
  playlistId?: string
}

/** One queue entry; its dataset position is the playback order. */
export interface QueueEntry {
  songId: string
}

export type RepeatMode = 'off' | 'all' | 'one'
