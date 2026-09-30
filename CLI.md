# Music — Terminal CLI

`valley music <command>` controls the music player in the running Valley app.
Requires Valley to be open (see the repo README for `npm link` setup and
multi-vault targeting with `--vault`). Run `valley music --help` for the live
list.

## Playback

| Command | What it does |
|---|---|
| `valley music play "<title>" [--exact]` | Fuzzy-match a track by title/artist and play it. `--exact` requires an exact (case-insensitive) title. Plays the best match; notes how many others matched. |
| `valley music playlist "<name>" [--shuffle] [--index N]` | Play a playlist by fuzzy name. `--shuffle` turns shuffle on first; `--index N` starts at the Nth track (0-based). |
| `valley music playlist-shuffle "<name>"` | Shuffle-play a playlist by fuzzy name. |
| `valley music playlist-next "<name>"` | Queue a playlist directly after the current track. |
| `valley music playlist-last "<name>"` | Queue a playlist at the end of Up Next. |
| `valley music create-playlist "<name>"` | Create a new playlist. |
| `valley music rename-playlist "<name>" --to "<new name>"` | Rename a playlist by fuzzy name. |
| `valley music delete-playlist "<name>"` | Delete a playlist with command-bus undo support. |
| `valley music clear-playlist "<name>"` | Remove all songs from a playlist with undo support. |
| `valley music add-to-playlist "<playlist>" --song "<title>"` | Add the best matching song to a playlist. |
| `valley music remove-from-playlist "<playlist>" --song "<title>"` | Remove the best matching song from a playlist. |
| `valley music pause` | Pause if playing. |
| `valley music resume` | Resume the current track if paused. |
| `valley music toggle` | Toggle play/pause. |
| `valley music stop` | Pause and clear the queue. |
| `valley music skip` | Next track. |
| `valley music back` | Previous track. |
| `valley music shuffle on\|off\|toggle` | Set shuffle mode (default `toggle`). |
| `valley music volume <0-100>` | Set the player volume. |

## Inspect

| Command | What it does |
|---|---|
| `valley music now` | Currently playing track, position, playlist, shuffle state. |
| `valley music queue` | Up-next tracks (max 10). |
| `valley music search "<query>"` | Search songs, artists, and playlists together. |
| `valley music songs [query]` | List songs, optionally filtered by title or artist. |
| `valley music artists [query]` | List artists and song counts, optionally filtered. |
| `valley music library [query]` | Alias-style song listing, optionally filtered. |
| `valley music playlists [query]` | List playlists with track counts and ids, optionally filtered. |

## Navigate (open a page, no playback)

| Command | What it does |
|---|---|
| `valley music open-page` | Open the Music page (main workspace tab). |
| `valley music open-playlist "<name>"` | Open a playlist's **page** by fuzzy name (distinct from `playlist`, which plays it). |
| `valley music open-artist "<name>"` | Open an artist's page. Errors if no song credits that name. |
| `valley music open-song-artist "<title>" [--exact]` | Open the artist page for the (first) artist of the best-matching song. |
| `valley music open-media "<vault path>"` | Reveal the song at that vault path and start playing it. Errors when the library has no entry for the path. |

The page you open is remembered, so reopening Music returns to the same
playlist/artist/song rather than the home view.

`open-media` explicitly opens a library track in Music. Opening an audio or video
file from Files, Search, or a wikilink uses its file viewer.

## Examples

```bash
valley music play "weyes blood"
valley music search "Marianne"
valley music artists
valley music open-artist "Marianne Beaulieu"
valley music open-playlist "Focus"
valley music playlist "Focus" --shuffle
valley music playlist-next "Focus"
valley music create-playlist "Roadtrip"
valley music add-to-playlist "Roadtrip" --song "Dreams"
valley music volume 60
valley music now
```

## Notes

- Matching is forgiving: titles and artists are matched as case-insensitive
  substrings, ranked title-prefix → title-substring → artist. Use `--exact` for
  an exact title.
- A song's `artist` string is auto-split on common delimiters (`, ; & feat. ft.
  x × vs.`), so `artists`, `search` and the artist pages treat collaborators as
  separate, individually-openable artists.
- All commands act on the same player as the in-app UI — changes show live in the
  footer mini-player and the Music page.
- The command palette exposes selected-playlist actions for the playlist last
  opened or right-clicked in the UI, falling back to the currently playing
  playlist.
